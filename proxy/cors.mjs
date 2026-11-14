// Browser access (CORS). Each project lists the web origins allowed to call the API with its key,
// e.g. "http://localhost:5173, https://app.example.com", or "*" for any origin.
export const originList = (s) =>
  String(s ?? "")
    .split(/[\s,]+/)
    .map((o) => o.trim().replace(/\/+$/, "").toLowerCase())
    .filter(Boolean);

export const originAllowed = (list, origin) =>
  !!origin && (list.includes("*") || list.includes(origin.toLowerCase()));

/** True when any enabled project allows this origin (used for preflight, which carries no key). */
export function anyProjectAllows(db, origin) {
  if (!origin) return false;
  return db
    .prepare("SELECT allowed_origins FROM projects WHERE enabled = 1 AND allowed_origins IS NOT NULL AND allowed_origins != ''")
    .all()
    .some((p) => originAllowed(originList(p.allowed_origins), origin));
}

export function setCors(req, res, origin) {
  res.setHeader("access-control-allow-origin", origin);
  res.setHeader("vary", "Origin");
  res.setHeader("access-control-expose-headers", "request-id, x-request-id, retry-after");
}

export function preflight(req, res, origin) {
  setCors(req, res, origin);
  res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
  res.setHeader(
    "access-control-allow-headers",
    req.headers["access-control-request-headers"] ||
      "authorization, x-api-key, content-type, anthropic-version, anthropic-beta, anthropic-dangerous-direct-browser-access",
  );
  res.setHeader("access-control-max-age", "600");
  res.writeHead(204);
  res.end();
}
