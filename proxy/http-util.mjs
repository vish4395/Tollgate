export const send = (res, status, body, headers = {}) => {
  const isText = typeof body === "string";
  res.writeHead(status, {
    "content-type": isText ? "text/plain; charset=utf-8" : "application/json",
    "x-content-type-options": "nosniff",
    ...headers,
  });
  res.end(isText ? body : JSON.stringify(body));
};

export const apiError = (res, status, type, message, headers = {}) =>
  send(res, status, { type: "error", error: { type, message } }, headers);

/** An error with an HTTP status, for input problems the caller should hear about. */
export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Reads the whole body. Rejects with HttpError 413 when too large and 408 when the client stalls. */
export function readBody(req, limit = 10_000_000, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    const finish = (fn, v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      fn(v);
    };
    const timer = setTimeout(() => {
      finish(reject, new HttpError(408, "The request body took too long to arrive."));
      req.destroy();
    }, timeoutMs);
    if (Number(req.headers["content-length"]) > limit) {
      finish(reject, new HttpError(413, "Request body too large."));
      req.resume();
      return;
    }
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        finish(reject, new HttpError(413, "Request body too large."));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => finish(resolve, Buffer.concat(chunks)));
    req.on("error", (e) => finish(reject, e));
  });
}

export async function readJson(req, limit = 100_000) {
  const raw = (await readBody(req, limit, 10_000)).toString("utf8");
  if (!raw) return {};
  let o;
  try {
    o = JSON.parse(raw);
  } catch {
    throw new HttpError(400, "The request body is not valid JSON.");
  }
  if (!o || typeof o !== "object" || Array.isArray(o))
    throw new HttpError(400, "The request body must be a JSON object.");
  return o;
}

const LOOPBACK = new Set(["127.0.0.1", "::1"]);
const socketIp = (req) => (req.socket.remoteAddress ?? "").replace(/^::ffff:/, "");
const firstIp = (v) => String(v ?? "").split(",")[0].trim().slice(0, 64);

/**
 * The caller's address. A proxy header is believed only when the setting names that kind of
 * proxy AND the connection comes from this machine (where the tunnel client runs).
 *   none        the socket address
 *   cloudflare  cf-connecting-ip (set by Cloudflare's edge; a client cannot override it)
 *   forwarded   x-forwarded-for, first entry (ngrok, nginx, Caddy)
 */
export function clientIp(req, mode = "none") {
  const sock = socketIp(req);
  if (!LOOPBACK.has(sock)) return sock;
  if (mode === "cloudflare" && req.headers["cf-connecting-ip"])
    return firstIp(req.headers["cf-connecting-ip"]);
  if (mode === "forwarded" && req.headers["x-forwarded-for"])
    return firstIp(req.headers["x-forwarded-for"]);
  return sock;
}

/** True when the visitor used https, directly or through a trusted proxy. */
export function isHttps(req, mode = "none") {
  if (req.socket.encrypted) return true;
  if (mode === "none" || !LOOPBACK.has(socketIp(req))) return false;
  return (
    firstIp(req.headers["x-forwarded-proto"]) === "https" ||
    String(req.headers["cf-visitor"] ?? "").includes('"https"')
  );
}
