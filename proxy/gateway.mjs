// Supervisor: runs Meridian (the Claude backend) and the gateway server as child processes,
// restarts either if it stops, and writes their logs. This is what the login service starts.
// Works the same on macOS, Linux and Windows.
import { spawn } from "node:child_process";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  writeFileSync,
  rmSync,
  readFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  ROOT,
  IS_WIN,
  MERIDIAN_CLI,
  LOCK_FILE,
  backendPath,
  readText,
  lockedPid,
} from "./paths.mjs";

for (const d of ["logs", "data"]) mkdirSync(join(ROOT, d), { recursive: true });
const WORK_DIR = join(homedir(), ".claude-gateway-work");
mkdirSync(WORK_DIR, { recursive: true });

// One supervisor per folder.
const other = lockedPid();
if (other && other !== process.pid) {
  console.error(`The gateway is already running (pid ${other}).`);
  process.exit(0);
}
writeFileSync(LOCK_FILE, String(process.pid));

function logFile(name) {
  const f = join(ROOT, "logs", `${name}.log`);
  try {
    if (statSync(f).size > 10 * 1024 * 1024) renameSync(f, f + ".1");
  } catch {
    /* no file yet */
  }
  return createWriteStream(f, { flags: "a" });
}
const sup = logFile("gateway");
const note = (msg) => sup.write(`${new Date().toISOString()} ${msg}\n`);

if (!existsSync(MERIDIAN_CLI)) {
  note("Meridian is not installed. Run: node proxy/cli.mjs install");
  console.error("Meridian is not installed. Run: node proxy/cli.mjs install");
  process.exit(1);
}

// ---------- environment for the backend ----------
const keyFile = join(ROOT, ".internal-key");
if (!readText(keyFile))
  writeFileSync(keyFile, randomBytes(24).toString("hex"), { mode: 0o600 });

function backendEnv() {
  const env = {
    ...process.env,
    PATH: backendPath(),
    MERIDIAN_HOST: "127.0.0.1",
    MERIDIAN_PORT: "4101",
    MERIDIAN_API_KEY: readText(keyFile),
    MERIDIAN_PASSTHROUGH: "1",
    MERIDIAN_MAX_CONCURRENT: "2",
    MERIDIAN_NO_UPDATE_CHECK: "1",
    // Outside any git repo, so the model never sees this folder's files or git status.
    MERIDIAN_WORKDIR: WORK_DIR,
    MERIDIAN_TELEMETRY_PERSIST: "1",
    MERIDIAN_TELEMETRY_DB: join(ROOT, "data", "meridian-telemetry.db"),
    MERIDIAN_TELEMETRY_RETENTION_DAYS: "7",
  };
  // Optional separate Claude sign-in (node proxy/cli.mjs login): own token and own config folder.
  const token = readText(join(ROOT, ".oauth-token"));
  if (token) {
    const home = join(ROOT, "claude-home");
    mkdirSync(home, { recursive: true });
    const settings = join(home, "settings.json");
    if (!existsSync(settings))
      writeFileSync(
        settings,
        '{ "cleanupPeriodDays": 7, "autoUpdates": false }\n',
      );
    env.CLAUDE_CONFIG_DIR = home;
    env.CLAUDE_CODE_OAUTH_TOKEN = token;
  }
  return env;
}

// ---------- child supervision ----------
let stopping = false;
function supervise(name, args, opts = {}) {
  const out = logFile(name);
  const state = {
    child: null,
    restarts: 0,
    startedAt: 0,
    onStart: opts.onStart,
  };
  const start = () => {
    if (stopping) return;
    state.startedAt = Date.now();
    const child = spawn(process.execPath, args, {
      cwd: ROOT,
      env: opts.env ? opts.env() : process.env,
      stdio: ["ignore", "pipe", "pipe", ...(opts.ipc ? ["ipc"] : [])],
      windowsHide: true,
    });
    state.child = child;
    child.stdout.pipe(out, { end: false });
    child.stderr.pipe(out, { end: false });
    note(`${name} started (pid ${child.pid})`);
    opts.onMessage && child.on("message", opts.onMessage);
    state.onStart?.(child);
    child.on("exit", (code, signal) => {
      state.child = null;
      note(`${name} stopped (code ${code}, signal ${signal})`);
      if (stopping) return;
      if (Date.now() - state.startedAt > 60_000) state.restarts = 0;
      const wait = Math.min(30_000, 1000 * 2 ** state.restarts++);
      setTimeout(start, wait);
    });
  };
  start();
  return {
    get pid() {
      return state.child?.pid ?? null;
    },
    restart() {
      state.restarts = 0;
      if (state.child) state.child.kill();
      else start();
    },
    stop() {
      state.child?.kill();
    },
  };
}

let proxyChild = null;
const backend = supervise("meridian", [MERIDIAN_CLI], {
  env: backendEnv,
  onStart: (child) => {
    if (proxyChild?.connected) proxyChild.send({ type: "backend-pid", pid: child.pid });
  },
});
const server = supervise(
  "proxy",
  ["--disable-warning=ExperimentalWarning", "--max-old-space-size=96", join(ROOT, "proxy", "server.mjs")],
  {
    ipc: true,
    onStart: (child) => {
      proxyChild = child;
      if (backend?.pid) child.send({ type: "backend-pid", pid: backend.pid });
    },
    onMessage: (m) => {
      if (m?.type === "restart-backend") {
        note("restart of backend requested from the dashboard");
        backend.restart();
      }
    },
  },
);

function shutdown() {
  if (stopping) return;
  stopping = true;
  note("supervisor stopping");
  backend.stop();
  server.stop();
  try {
    if (readFileSync(LOCK_FILE, "utf8").trim() === String(process.pid))
      rmSync(LOCK_FILE);
  } catch {
    /* already gone */
  }
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
if (IS_WIN) process.on("SIGBREAK", shutdown);
process.on("uncaughtException", (e) =>
  note(`supervisor error: ${e.stack ?? e}`),
);
note(
  `supervisor started (pid ${process.pid}, ${process.platform}, node ${process.version})`,
);
