export const send = (res, status, body, headers = {}) => {
  const isText = typeof body === "string";
  res.writeHead(status, {
    "content-type": isText ? "text/plain; charset=utf-8" : "application/json",
    ...headers,
  });
  res.end(isText ? body : JSON.stringify(body));
};

export const apiError = (res, status, type, message) =>
  send(res, status, { type: "error", error: { type, message } });

export function readBody(req, limit = 20_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("Request body too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export async function readJson(req, limit = 100_000) {
  const raw = (await readBody(req, limit)).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

/** Real client address; behind a Cloudflare tunnel the edge sets cf-connecting-ip. */
export const clientIp = (req) => {
  const sock = (req.socket.remoteAddress ?? "").replace(/^::ffff:/, "");
  const cf = req.headers["cf-connecting-ip"];
  return sock === "127.0.0.1" && cf ? String(cf) : sock;
};
