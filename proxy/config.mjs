import { readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { validZone } from "./time.mjs";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const VERSION = "2.0.0";
// Tests point these elsewhere.
const CONFIG_FILE = process.env.GATEWAY_CONFIG ?? join(ROOT, "config.json");
const DATA_DIR = process.env.GATEWAY_HOME ?? ROOT;

/** Settings the dashboard may change, with their rules. */
export const EDITABLE = {
  maxConcurrent: { type: "int", min: 1, max: 8 },
  maxQueue: { type: "int", min: 0, max: 200 },
  queueTimeoutMs: { type: "int", min: 1000, max: 600000 },
  requestTimeoutMs: { type: "int", min: 10000, max: 600000 },
  maxBodyMb: { type: "int", min: 1, max: 50 },
  retentionDays: { type: "int", min: 1, max: 365 },
  badKeyLimit: { type: "int", min: 3, max: 1000 },
  defaultModel: { type: "string" },
  publicHost: { type: "string" },
  publicUrl: { type: "string", empty: true },
  timeZone: { type: "zone" },
  trustedProxy: { type: "enum", values: ["none", "cloudflare", "forwarded"] },
  enforceMaxTokens: { type: "bool" },
  metricsEnabled: { type: "bool" },
};

/** Checks a patch against EDITABLE. Returns { values } or { error }; never changes anything. */
export function validateSettings(patch) {
  const values = {};
  for (const [k, rule] of Object.entries(EDITABLE)) {
    if (!(k in patch)) continue;
    const raw = patch[k];
    if (rule.type === "int") {
      const v = Math.floor(Number(raw));
      if (!Number.isFinite(v) || v < rule.min || v > rule.max)
        return { error: `${k} must be between ${rule.min} and ${rule.max}.` };
      values[k] = v;
    } else if (rule.type === "bool") values[k] = raw === true || raw === "true" || raw === 1;
    else if (rule.type === "enum") {
      if (!rule.values.includes(raw))
        return { error: `${k} must be one of: ${rule.values.join(", ")}.` };
      values[k] = raw;
    } else if (rule.type === "zone") {
      if (!validZone(String(raw)))
        return { error: `Unknown time zone: ${raw}. Use a name like Asia/Kolkata or Europe/London.` };
      values[k] = String(raw);
    } else {
      const v = String(raw ?? "").trim().slice(0, 200);
      if (!v && !rule.empty) return { error: `${k} can't be empty.` };
      values[k] = v;
    }
  }
  return { values };
}

export function lanIp() {
  for (const list of Object.values(os.networkInterfaces()))
    for (const a of list ?? [])
      if (a.family === "IPv4" && !a.internal) return a.address;
  return null;
}

export function hashPassword(pw) {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(pw, salt, 32).toString("hex")}`;
}
export function checkPassword(pw, stored) {
  const [salt, hex] = String(stored).split(":");
  if (!salt || !hex) return false;
  return timingSafeEqual(scryptSync(String(pw), salt, 32), Buffer.from(hex, "hex"));
}

export function saveConfig(c) {
  writeFileSync(CONFIG_FILE, JSON.stringify(c, null, 2) + "\n");
  try {
    chmodSync(CONFIG_FILE, 0o600);
  } catch {
    /* Windows */
  }
}

/** Alert rules and their default thresholds. `enabled: false` turns one off. */
export const ALERT_DEFAULTS = {
  account_near_limit: { enabled: true, fiveHourPct: 80, weeklyPct: 90 },
  account_limited: { enabled: true },
  account_signed_out: { enabled: true },
  account_renewal: { enabled: true, days: 7 },
  no_account: { enabled: true },
  backend_down: { enabled: true, minutes: 2, restarts: 3 },
  error_spike: { enabled: true, pct: 20, minRequests: 10, minutes: 5 },
  slow_responses: { enabled: false, seconds: 60, minutes: 10 },
  queue_full: { enabled: true },
  project_cap: { enabled: true, pct: 80 },
  security: { enabled: true },
};

export const NOTIFY_DEFAULTS = {
  webhook: { enabled: false, url: "", minSeverity: "warning" },
  telegram: { enabled: false, token: "", chatId: "", minSeverity: "warning" },
  email: {
    enabled: false,
    host: "",
    port: 587,
    security: "starttls",
    user: "",
    pass: "",
    from: "",
    to: "",
    minSeverity: "critical",
  },
};

export function defaults() {
  return {
    host: "0.0.0.0",
    port: 4100,
    httpPort: 4180,
    publicHost: lanIp() ?? "localhost",
    publicUrl: "",
    upstream: "http://127.0.0.1:4101",
    maxConcurrent: 2,
    maxQueue: 20,
    queueTimeoutMs: 60000,
    requestTimeoutMs: 180000,
    maxBodyMb: 10,
    retentionDays: 30,
    badKeyLimit: 20,
    defaultModel: "claude-haiku-5-5",
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    trustedProxy: "none",
    enforceMaxTokens: true,
    metricsEnabled: false,
    sessionEpoch: 1,
    // Estimated API-equivalent prices, USD per million tokens, by model family.
    // A price set on a model in the Models tab wins over these.
    pricing: {
      haiku: { in: 1, out: 5 },
      sonnet: { in: 3, out: 15 },
      opus: { in: 5, out: 25 },
      fable: { in: 5, out: 25 },
    },
    alerts: { repeatMinutes: 240, quietFrom: "", quietTo: "", rules: {} },
    notify: {},
  };
}

/** Fills in rules and channels added by later versions without touching saved values. */
export function withDefaults(cfg) {
  const d = defaults();
  const out = { ...d, ...cfg };
  out.pricing = { ...d.pricing, ...(cfg.pricing ?? {}) };
  out.alerts = { ...d.alerts, ...(cfg.alerts ?? {}) };
  out.alerts.rules = Object.fromEntries(
    Object.entries(ALERT_DEFAULTS).map(([k, v]) => [k, { ...v, ...(cfg.alerts?.rules?.[k] ?? {}) }]),
  );
  out.notify = Object.fromEntries(
    Object.entries(NOTIFY_DEFAULTS).map(([k, v]) => [k, { ...v, ...(cfg.notify?.[k] ?? {}) }]),
  );
  return out;
}

export function loadConfig() {
  const existed = existsSync(CONFIG_FILE);
  const cfg = withDefaults(existed ? JSON.parse(readFileSync(CONFIG_FILE, "utf8")) : {});
  let changed = !existed;
  // The key file is the single source: the supervisor hands the same file to the backend.
  const keyFile = join(DATA_DIR, ".internal-key");
  const fromFile = existsSync(keyFile) ? readFileSync(keyFile, "utf8").trim() : "";
  if (fromFile) {
    if (cfg.internalKey !== fromFile) {
      cfg.internalKey = fromFile;
      changed = true;
    }
  } else {
    cfg.internalKey ||= randomBytes(24).toString("hex");
    writeFileSync(keyFile, cfg.internalKey, { mode: 0o600 });
    changed = true;
  }
  if (!cfg.sessionSecret) {
    cfg.sessionSecret = randomBytes(32).toString("hex");
    changed = true;
  }
  if (!cfg.adminPasswordHash) {
    const pw = randomBytes(9).toString("base64url");
    cfg.adminPasswordHash = hashPassword(pw);
    const f = join(DATA_DIR, "ADMIN_PASSWORD.txt");
    writeFileSync(f, `${pw}\n`, { mode: 0o600 });
    console.log(`Admin password written to ${f}`);
    changed = true;
  }
  if (changed) saveConfig(cfg);
  return cfg;
}
