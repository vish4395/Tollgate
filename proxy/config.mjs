import { readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_FILE = join(ROOT, "config.json");

/** Settings the dashboard may change, with their limits. */
export const EDITABLE = {
  maxConcurrent: { min: 1, max: 8 },
  maxQueue: { min: 0, max: 200 },
  requestTimeoutMs: { min: 10000, max: 600000 },
  retentionDays: { min: 1, max: 365 },
  badKeyLimit: { min: 3, max: 1000 },
  defaultModel: "string",
  publicHost: "string",
};

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
  const [salt, hex] = stored.split(":");
  return timingSafeEqual(
    scryptSync(String(pw), salt, 32),
    Buffer.from(hex, "hex"),
  );
}

export function saveConfig(c) {
  writeFileSync(CONFIG_FILE, JSON.stringify(c, null, 2) + "\n");
  chmodSync(CONFIG_FILE, 0o600);
}

export function loadConfig() {
  const defaults = {
    host: "0.0.0.0",
    port: 4100,
    httpPort: 4180,
    publicHost: lanIp() ?? "localhost",
    upstream: "http://127.0.0.1:4101",
    maxConcurrent: 2,
    maxQueue: 20,
    requestTimeoutMs: 180000,
    retentionDays: 30,
    badKeyLimit: 20,
    defaultModel: "claude-haiku-5-5",
    // Estimated API-equivalent prices, USD per million tokens, by model family.
    // A price set on a model in the Models tab wins over these.
    pricing: {
      haiku: { in: 1, out: 5 },
      sonnet: { in: 3, out: 15 },
      opus: { in: 5, out: 25 },
      fable: { in: 5, out: 25 },
    },
  };
  const existed = existsSync(CONFIG_FILE);
  const cfg = {
    ...defaults,
    ...(existed ? JSON.parse(readFileSync(CONFIG_FILE, "utf8")) : {}),
  };
  let changed = !existed;
  if (!cfg.internalKey) {
    const f = join(ROOT, ".internal-key");
    cfg.internalKey = existsSync(f)
      ? readFileSync(f, "utf8").trim()
      : randomBytes(24).toString("hex");
    changed = true;
  }
  if (!cfg.sessionSecret) {
    cfg.sessionSecret = randomBytes(32).toString("hex");
    changed = true;
  }
  if (!cfg.adminPasswordHash) {
    const pw = randomBytes(9).toString("base64url");
    cfg.adminPasswordHash = hashPassword(pw);
    const f = join(ROOT, "ADMIN_PASSWORD.txt");
    writeFileSync(f, `${pw}\n`);
    chmodSync(f, 0o600);
    console.log(`Admin password written to ${f}`);
    changed = true;
  }
  if (changed) saveConfig(cfg);
  return cfg;
}
