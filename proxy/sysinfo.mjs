// Process memory for the gateway and its backend (macOS, Linux, Windows).
import { execFile } from "node:child_process";

function run(cmd, args) {
  return new Promise((resolve) =>
    execFile(
      cmd,
      args,
      { maxBuffer: 8e6, timeout: 15000 },
      (err, out, errOut) =>
        resolve({
          ok: !err,
          out: String(out),
          err: String(errOut || err?.message || ""),
        }),
    ),
  );
}

/** Every process with its parent and memory (KB), on macOS, Linux and Windows. */
async function processList() {
  if (process.platform === "win32") {
    const r = await run("powershell", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)`t$($_.ParentProcessId)`t$([math]::Round($_.WorkingSetSize/1024))`t$($_.Name) $($_.CommandLine)" }',
    ]);
    return r.out
      .split(/\r?\n/)
      .map((l) => l.split("\t"))
      .filter((p) => p.length >= 4)
      .map(([pid, ppid, rss, ...cmd]) => ({
        pid: +pid,
        ppid: +ppid,
        rss: +rss,
        cmd: cmd.join(" "),
      }));
  }
  const r = await run("ps", ["-axo", "pid=,ppid=,rss=,command="]);
  return r.out
    .split("\n")
    .map((l) => /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(l))
    .filter(Boolean)
    .map((m) => ({ pid: +m[1], ppid: +m[2], rss: +m[3], cmd: m[4] }));
}

export async function memory(backendPid) {
  const procs = await processList();
  const root =
    procs.find((p) => p.pid === backendPid) ??
    procs.find((p) =>
      /meridian[\\/]node_modules[\\/](\.bin[\\/]meridian|@rynfar[\\/]meridian[\\/]dist[\\/]cli)/.test(
        p.cmd,
      ),
    );
  let kb = 0;
  let cli = 0;
  if (root) {
    const ids = new Set([root.pid]);
    for (let grew = true; grew;) {
      grew = false;
      for (const p of procs)
        if (!ids.has(p.pid) && ids.has(p.ppid)) {
          ids.add(p.pid);
          grew = true;
        }
    }
    for (const p of procs)
      if (ids.has(p.pid)) {
        kb += p.rss;
        if (p.pid !== root.pid && /claude/.test(p.cmd)) cli++;
      }
  }
  return {
    proxyMb: Math.round(process.memoryUsage().rss / 1048576),
    meridianMb: Math.round(kb / 1024),
    meridianPid: root?.pid ?? null,
    cliProcesses: cli,
  };
}


// Listing processes spawns a command, so share one result for 20 seconds.
let cached = { at: 0, pid: null, value: null, pending: null };
export function memoryCached(backendPid) {
  if (cached.value && cached.pid === backendPid && Date.now() - cached.at < 20_000) return Promise.resolve(cached.value);
  if (cached.pending) return cached.pending;
  cached.pending = memory(backendPid)
    .then((value) => {
      cached = { at: Date.now(), pid: backendPid, value, pending: null };
      return value;
    })
    .catch((e) => {
      cached.pending = null;
      throw e;
    });
  return cached.pending;
}
