/**
 * CORS allow-list from CLIENT_URL.
 *
 *   CLIENT_URL=https://attendance.example.com
 *   CLIENT_URL=https://attendance.example.com,https://www.attendance.example.com   (comma separated)
 *
 * - Exact origin match (scheme + host + port); a trailing slash or path in the setting is ignored.
 * - "*" is refused: the API uses credentials, and a wildcard would let any website call it as the signed-in user.
 * - Requests with no Origin header (curl, server-to-server, health checks) are allowed through: CORS only protects
 *   browsers, and every protected route still needs a valid token.
 * - Not on the list → no CORS headers are sent, so the browser blocks the response (the request is not "rejected"
 *   with an error, which keeps health checks and mobile clients working).
 */
export const DEFAULT_DEV_ORIGIN = "http://localhost:5173";

export const parseAllowedOrigins = (raw = process.env.CLIENT_URL) => {
  const list = String(raw ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const origins = [];
  const invalid = [];
  for (const item of list) {
    if (item === "*") { invalid.push(item); continue; }
    try {
      const u = new URL(item);
      if (!/^https?:$/.test(u.protocol)) throw new Error("scheme");
      origins.push(u.origin);
    } catch { invalid.push(item); }
  }
  return { origins: origins.length || invalid.length ? origins : [DEFAULT_DEV_ORIGIN], invalid, configured: list.length > 0 };
};

export const buildCorsOptions = (raw = process.env.CLIENT_URL) => {
  const { origins } = parseAllowedOrigins(raw);
  const allowed = new Set(origins);
  return {
    origin: (origin, cb) => cb(null, !origin || allowed.has(origin)),
    credentials: true,
    maxAge: 600,
  };
};
