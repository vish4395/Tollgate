#!/usr/bin/env node
// Gateway command line for macOS, Linux and Windows.
//   node proxy/cli.mjs install | uninstall | start | stop | restart | status | logs
//   node proxy/cli.mjs login | add-project <name> | set-password <password> | run
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readFileSync,
  chmodSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir, networkInterfaces } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import {
  ROOT,
  IS_WIN,
  MERIDIAN_CLI,
  backendPath,
  which,
  readText,
  lockedPid,
} from "./paths.mjs";

const NODE = process.execPath;
const GATEWAY = join(ROOT, "proxy", "gateway.mjs");
const LABEL = "com.local.claude-gateway";
const UNIT = "claude-gateway";
const TASK = "ClaudeGateway";
const PLATFORM =
  process.platform === "darwin" ? "mac" : IS_WIN ? "windows" : "linux";

const say = (m) => console.log(`\x1b[36m==>\x1b[0m ${m}`);
const warn = (m) => console.log(`\x1b[33m!\x1b[0m ${m}`);
const fail = (m) => {
  console.error(`\x1b[31mError:\x1b[0m ${m}`);
  process.exit(1);
};
const sh = (cmd, args, opts = {}) =>
  spawnSync(cmd, args, {
    encoding: "utf8",
    shell: IS_WIN && opts.shell,
    ...opts,
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function lanIp() {
  for (const list of Object.values(networkInterfaces()))
    for (const a of list ?? [])
      if (a.family === "IPv4" && !a.internal) return a.address;
  return "localhost";
}
function config() {
  try {
    return JSON.parse(readFileSync(join(ROOT, "config.json"), "utf8"));
  } catch {
    return {};
  }
}
const ports = () => ({
  port: config().port ?? 4100,
  httpPort: config().httpPort ?? 4180,
});
const tls = () =>
  existsSync(join(ROOT, "certs", "gateway.pem")) &&
  existsSync(join(ROOT, "certs", "gateway-key.pem"));

async function healthy() {
  const { port, httpPort } = ports();
  for (const p of tls() ? [httpPort] : [port]) {
    try {
      const r = await fetch(`http://127.0.0.1:${p}/health`, {
        signal: AbortSignal.timeout(2000),
      });
      if (r.status < 500 || r.status === 503) return await r.json();
    } catch {
      /* not up */
    }
  }
  return null;
}

// ---------- prerequisites ----------
function checkPrereqs() {
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 22)
    fail(`Node.js 22 or newer is required (found ${process.version}).`);
  if (!which("claude"))
    fail(
      "The Claude Code CLI was not found. Install it (npm install -g @anthropic-ai/claude-code), run `claude` once and sign in.",
    );
  if (!which("npm")) fail("npm was not found (it comes with Node.js).");
}

function installMeridian() {
  if (existsSync(MERIDIAN_CLI)) return;
  say("Installing Meridian (version pinned in meridian/package-lock.json)…");
  const r = sh(
    IS_WIN ? "npm.cmd" : "npm",
    ["ci", "--no-audit", "--no-fund", "--loglevel=error"],
    {
      cwd: join(ROOT, "meridian"),
      stdio: "inherit",
      shell: IS_WIN,
    },
  );
  if (r.status !== 0 || !existsSync(MERIDIAN_CLI))
    fail("Installing Meridian failed. See the output above.");
}

// ---------- service per platform ----------
const service = {
  mac: {
    file: join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`),
    install() {
      // Remove the two-service layout of older versions.
      for (const old of ["meridian", "proxy"]) {
        sh("launchctl", ["bootout", `gui/${process.getuid()}/${LABEL}.${old}`]);
        rmSync(
          join(homedir(), "Library", "LaunchAgents", `${LABEL}.${old}.plist`),
          { force: true },
        );
      }
      const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
      mkdirSync(join(homedir(), "Library", "LaunchAgents"), {
        recursive: true,
      });
      writeFileSync(
        this.file,
        `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array><string>${esc(NODE)}</string><string>${esc(GATEWAY)}</string></array>
  <key>WorkingDirectory</key><string>${esc(ROOT)}</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${esc(backendPath())}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${esc(join(ROOT, "logs", "service.log"))}</string>
  <key>StandardErrorPath</key><string>${esc(join(ROOT, "logs", "service.log"))}</string>
</dict></plist>
`,
      );
      sh("launchctl", ["bootout", `gui/${process.getuid()}/${LABEL}`]);
      const r = sh("launchctl", [
        "bootstrap",
        `gui/${process.getuid()}`,
        this.file,
      ]);
      if (r.status !== 0)
        fail(`launchctl could not load the service: ${r.stderr}`);
    },
    uninstall() {
      sh("launchctl", ["bootout", `gui/${process.getuid()}/${LABEL}`]);
      rmSync(this.file, { force: true });
    },
    installed() {
      return existsSync(this.file);
    },
    start() {
      if (!this.installed()) return false;
      const r = sh("launchctl", [
        "kickstart",
        `gui/${process.getuid()}/${LABEL}`,
      ]);
      if (r.status !== 0)
        sh("launchctl", ["bootstrap", `gui/${process.getuid()}`, this.file]);
      return true;
    },
    stop() {
      sh("launchctl", ["bootout", `gui/${process.getuid()}/${LABEL}`]);
    },
    restart() {
      sh("launchctl", ["kickstart", "-k", `gui/${process.getuid()}/${LABEL}`]);
    },
    describe() {
      const r = sh("launchctl", ["print", `gui/${process.getuid()}/${LABEL}`]);
      return r.status === 0
        ? (/state = (\w+)/.exec(r.stdout)?.[1] ?? "loaded")
        : "not loaded";
    },
  },

  linux: {
    file: join(
      process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
      "systemd",
      "user",
      `${UNIT}.service`,
    ),
    hasSystemd() {
      return sh("systemctl", ["--user", "show-environment"]).status === 0;
    },
    install() {
      if (!this.hasSystemd()) {
        warn(
          "systemd user services are not available here (for example WSL without systemd or a container).",
        );
        warn(
          `Start the gateway yourself with: node ${GATEWAY}   (or add that line to your login startup).`,
        );
        return;
      }
      const q = (s) => `"${s.replace(/"/g, '\\"')}"`;
      mkdirSync(join(this.file, ".."), { recursive: true });
      writeFileSync(
        this.file,
        `[Unit]
Description=Claude CLI API Gateway
After=network-online.target

[Service]
Type=simple
WorkingDirectory=${ROOT}
ExecStart=${q(NODE)} ${q(GATEWAY)}
Environment=${q("PATH=" + backendPath())}
Restart=always
RestartSec=5
KillMode=control-group

[Install]
WantedBy=default.target
`,
      );
      sh("systemctl", ["--user", "daemon-reload"]);
      const r = sh("systemctl", ["--user", "enable", "--now", UNIT]);
      if (r.status !== 0)
        fail(`systemctl could not start the service: ${r.stderr}`);
      warn(
        `To keep it running when you are logged out, run once: sudo loginctl enable-linger ${process.env.USER ?? "$USER"}`,
      );
    },
    uninstall() {
      if (this.hasSystemd())
        sh("systemctl", ["--user", "disable", "--now", UNIT]);
      rmSync(this.file, { force: true });
      if (this.hasSystemd()) sh("systemctl", ["--user", "daemon-reload"]);
    },
    installed() {
      return existsSync(this.file);
    },
    start() {
      if (!this.installed() || !this.hasSystemd()) return false;
      sh("systemctl", ["--user", "start", UNIT]);
      return true;
    },
    stop() {
      if (this.hasSystemd()) sh("systemctl", ["--user", "stop", UNIT]);
    },
    restart() {
      sh("systemctl", ["--user", "restart", UNIT]);
    },
    describe() {
      if (!this.hasSystemd()) return "no systemd";
      return (
        sh("systemctl", ["--user", "is-active", UNIT]).stdout.trim() ||
        "unknown"
      );
    },
  },

  windows: {
    vbs: join(ROOT, "data", "start-hidden.vbs"),
    install() {
      mkdirSync(join(ROOT, "data"), { recursive: true });
      // A tiny launcher so the gateway runs without a console window.
      const v = (s) => s.replace(/"/g, '""');
      writeFileSync(
        this.vbs,
        `Set sh = CreateObject("WScript.Shell")\r\nsh.CurrentDirectory = "${v(ROOT)}"\r\nsh.Run """${v(NODE)}"" ""${v(GATEWAY)}""", 0, False\r\n`,
      );
      const r = sh("schtasks", [
        "/Create",
        "/TN",
        TASK,
        "/TR",
        `wscript.exe "${this.vbs}"`,
        "/SC",
        "ONLOGON",
        "/RL",
        "LIMITED",
        "/F",
      ]);
      if (r.status !== 0)
        fail(
          `Task Scheduler could not register the gateway: ${r.stderr || r.stdout}`,
        );
      this.start();
    },
    uninstall() {
      this.stop();
      sh("schtasks", ["/Delete", "/TN", TASK, "/F"]);
      rmSync(this.vbs, { force: true });
    },
    installed() {
      return sh("schtasks", ["/Query", "/TN", TASK]).status === 0;
    },
    start() {
      if (lockedPid()) return true;
      if (!this.installed()) return false;
      sh("schtasks", ["/Run", "/TN", TASK]);
      return true;
    },
    stop() {
      const pid = lockedPid();
      if (pid) sh("taskkill", ["/PID", String(pid), "/T", "/F"]);
      rmSync(join(ROOT, "data", "gateway.pid"), { force: true });
    },
    restart() {
      this.stop();
      setTimeout(() => this.start(), 1500);
    },
    describe() {
      return lockedPid()
        ? "running"
        : this.installed()
          ? "installed, not running"
          : "not installed";
    },
  },
}[PLATFORM];

// ---------- commands ----------
async function waitHealthy(seconds = 60) {
  let last = null;
  for (let i = 0; i < seconds; i++) {
    last = (await healthy()) ?? last;
    if (last?.status === "ok") return last;
    await sleep(1000);
  }
  return last;
}

async function printInfo() {
  const { port } = ports();
  const scheme = tls() ? "https" : "http";
  console.log(
    `  Dashboard:  ${scheme}://localhost:${port}   (on your network: ${scheme}://${lanIp()}:${port})`,
  );
  const pw = readText(join(ROOT, "ADMIN_PASSWORD.txt"));
  if (pw)
    console.log(
      `  Password:   ${pw}   (also in ADMIN_PASSWORD.txt; change it in Settings)`,
    );
}

const commands = {
  async install() {
    checkPrereqs();
    installMeridian();
    const key = join(ROOT, ".internal-key");
    if (!readText(key)) writeFileSync(key, randomBytes(24).toString("hex"));
    try {
      chmodSync(key, 0o600);
    } catch {
      /* Windows */
    }
    say(`Registering the login service (${PLATFORM})…`);
    service.install();
    say("Waiting for the gateway to answer…");
    const h = await waitHealthy();
    if (!h) {
      warn(
        "The gateway did not answer yet. Check logs/gateway.log, logs/proxy.log and logs/meridian.log.",
      );
      return;
    }
    say(`Running. Backend: ${h.backend}.`);
    await printInfo();
    console.log(
      "  Next:       open the dashboard → Projects → create a key for each app.",
    );
  },
  async uninstall() {
    service.uninstall();
    say(
      "Stopped and removed from login. Keys, history and logs stay in this folder.",
    );
  },
  async start() {
    if (!service.start()) {
      say(
        "No login service installed: starting in the background for this session only.",
      );
      const child = spawn(NODE, [GATEWAY], {
        cwd: ROOT,
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      child.unref();
    }
    const h = await waitHealthy(30);
    h
      ? (say("Running."), await printInfo())
      : warn("Not answering yet. See logs/gateway.log.");
  },
  async stop() {
    service.stop();
    const pid = lockedPid();
    if (pid && !IS_WIN) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        /* gone */
      }
    }
    say("Stopped.");
  },
  async restart() {
    service.restart();
    const h = await waitHealthy(30);
    h ? say("Restarted.") : warn("Not answering yet. See logs/gateway.log.");
  },
  async status() {
    const h = await healthy();
    console.log(`  Platform:   ${PLATFORM}`);
    console.log(`  Service:    ${service.describe()}`);
    console.log(
      `  Supervisor: ${lockedPid() ? `running (pid ${lockedPid()})` : "not running"}`,
    );
    console.log(
      `  Gateway:    ${h ? `answering (backend ${h.backend})` : "not answering"}`,
    );
    console.log(`  Claude CLI: ${which("claude") ?? "not found"}`);
    console.log(
      `  Sign-in:    ${readText(join(ROOT, ".oauth-token")) ? "gateway's own token" : "shared with your Claude CLI"}`,
    );
    if (h) await printInfo();
  },
  async logs() {
    for (const f of ["gateway", "proxy", "meridian"]) {
      const p = join(ROOT, "logs", `${f}.log`);
      if (!existsSync(p)) continue;
      console.log(`\n----- logs/${f}.log (last 20 lines) -----`);
      console.log(readFileSync(p, "utf8").split(/\r?\n/).slice(-21).join("\n"));
    }
  },
  async run() {
    await import(GATEWAY);
  },
  async login() {
    say(
      "A browser window opens: sign in and approve. Then copy the token it prints (starts with sk-ant-oat).",
    );
    const home = join(ROOT, "claude-home");
    mkdirSync(home, { recursive: true });
    sh(which("claude") ?? "claude", ["setup-token"], {
      stdio: "inherit",
      shell: IS_WIN,
      env: { ...process.env, CLAUDE_CONFIG_DIR: home },
    });
    const token = (
      await askHidden("Paste the token (hidden), then Enter: ")
    ).replace(/\s+/g, "");
    if (!token.startsWith("sk-ant-"))
      fail("That does not look like a token. Nothing changed.");
    const f = join(ROOT, ".oauth-token");
    writeFileSync(f, token + "\n");
    try {
      chmodSync(f, 0o600);
    } catch {
      /* Windows */
    }
    say("Saved. Restarting so the backend uses its own sign-in…");
    await commands.restart();
  },
  async "add-project"() {
    passToServer();
  },
  async "set-password"() {
    passToServer();
  },
};

function passToServer() {
  const r = sh(
    NODE,
    [
      "--disable-warning=ExperimentalWarning",
      join(ROOT, "proxy", "server.mjs"),
      ...process.argv.slice(2),
    ],
    {
      stdio: "inherit",
    },
  );
  process.exit(r.status ?? 1);
}

function askHidden(question) {
  return new Promise((resolve) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });
    rl._writeToOutput = (s) => rl.output.write(s.includes(question) ? s : "");
    rl.question(question, (a) => {
      rl.close();
      process.stdout.write("\n");
      resolve(a);
    });
  });
}

const cmd = process.argv[2];
if (!commands[cmd]) {
  console.log(`Usage: node proxy/cli.mjs <command>

  install            install Meridian, register the login service and start
  uninstall          stop and remove the login service (data kept)
  start | stop | restart | status | logs
  login              give the gateway its own Claude sign-in (claude setup-token)
  add-project <name> create a project key
  set-password <pw>  reset the dashboard password
  run                run in the foreground (no service)`);
  process.exit(cmd ? 1 : 0);
}
await commands[cmd]();
