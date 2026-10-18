import { sendError } from "../utils/response.js";

/**
 * Minimal in-memory fixed-window rate limiter (no extra dependency).
 *
 * Good enough for a single Node process. If the API is ever scaled to several
 * instances, swap this for a shared-store limiter (e.g. Redis-backed).
 * Behind a proxy (Render) Express must have `trust proxy` set so req.ip is the
 * real client address — server.js does this.
 */
export const createRateLimiter = ({
  windowMs = 60 * 60 * 1000,
  max = 5,
  message = "Too many requests. Please try again later.",
  keyGenerator = (req) => req.ip,
  now = () => Date.now(),
} = {}) => {
  const hits = new Map(); // key -> { count, resetAt }

  const sweep = setInterval(() => {
    const t = now();
    for (const [k, v] of hits) if (v.resetAt <= t) hits.delete(k);
  }, Math.min(windowMs, 60_000));
  sweep.unref?.();

  const middleware = (req, res, next) => {
    const key = keyGenerator(req) || "unknown";
    const t = now();
    let entry = hits.get(key);
    if (!entry || entry.resetAt <= t) {
      entry = { count: 0, resetAt: t + windowMs };
      hits.set(key, entry);
    }
    entry.count += 1;
    if (entry.count > max) {
      res.set("Retry-After", String(Math.max(1, Math.ceil((entry.resetAt - t) / 1000))));
      return sendError(res, message, 429);
    }
    next();
  };
  middleware.reset = () => hits.clear();
  return middleware;
};

/**
 * Failure-only limiter: only responses with status >= 400 (e.g. "no such
 * student") count toward the limit; successful requests are free. Once `max`
 * failures happened inside the window every further request gets 429 until it
 * resets. This is the brake on guessing roll numbers one by one without
 * punishing students who simply look themselves up.
 */
export const createFailureLimiter = ({
  windowMs = 10 * 60 * 1000,
  max = 15,
  message = "Too many unsuccessful lookups. Please wait a few minutes and try again.",
  keyGenerator = (req) => req.ip,
  now = () => Date.now(),
} = {}) => {
  const hits = new Map(); // key -> { count, resetAt }

  const sweep = setInterval(() => {
    const t = now();
    for (const [k, v] of hits) if (v.resetAt <= t) hits.delete(k);
  }, Math.min(windowMs, 60_000));
  sweep.unref?.();

  const middleware = (req, res, next) => {
    const key = keyGenerator(req) || "unknown";
    const t = now();
    const current = hits.get(key);
    if (current && current.resetAt > t && current.count >= max) {
      res.set("Retry-After", String(Math.max(1, Math.ceil((current.resetAt - t) / 1000))));
      return sendError(res, message, 429);
    }
    res.on("finish", () => {
      if (res.statusCode < 400 || res.statusCode === 429) return;
      const n = now();
      let entry = hits.get(key);
      if (!entry || entry.resetAt <= n) {
        entry = { count: 0, resetAt: n + windowMs };
        hits.set(key, entry);
      }
      entry.count += 1;
    });
    next();
  };
  middleware.reset = () => hits.clear();
  return middleware;
};
