// Shared paths and tool lookup for the supervisor and the CLI (macOS, Linux, Windows).
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, delimiter } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const IS_WIN = process.platform === "win32";
export const MERIDIAN_CLI = join(
  ROOT,
  "meridian",
  "node_modules",
  "@rynfar",
  "meridian",
  "dist",
  "cli.js",
);
export const LOCK_FILE = join(ROOT, "data", "gateway.pid");

/** Full path of a command on PATH, or null. Handles Windows extensions. */
export function which(cmd, pathVar = process.env.PATH ?? "") {
  const exts = IS_WIN
    ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")
    : [""];
  for (const dir of pathVar.split(delimiter).filter(Boolean))
    for (const ext of exts) {
      const p = join(dir, cmd + ext.toLowerCase());
      const P = join(dir, cmd + ext);
      if (existsSync(p)) return p;
      if (existsSync(P)) return P;
    }
  return null;
}

/** PATH for the backend: node's folder and the Claude CLI's folder first, then the usual places. */
export function backendPath() {
  const parts = [dirname(process.execPath)];
  const claude = which("claude");
  if (claude) parts.push(dirname(claude));
  if (!IS_WIN)
    parts.push(
      "/usr/local/bin",
      "/opt/homebrew/bin",
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin",
    );
  parts.push(...(process.env.PATH ?? "").split(delimiter));
  return [...new Set(parts.filter(Boolean))].join(delimiter);
}

export const readText = (f) =>
  existsSync(f) ? readFileSync(f, "utf8").trim() : "";

export function lockedPid() {
  const pid = Number(readText(LOCK_FILE));
  if (!pid) return null;
  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}
