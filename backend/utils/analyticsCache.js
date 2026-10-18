/**
 * Short-lived, per-college cache for dashboard datasets.
 *
 * WHY: the admin pages fetch a list AND a summary built from the same full
 * dataset (teacher performance, academic structure), and every page view
 * re-runs several aggregations over a college's whole attendance history. A
 * few seconds of caching removes the duplicate work without changing any number
 * (the cached value is exactly what the aggregation returned).
 *
 * TENANT SAFETY — the one rule that matters:
 *   the cache key ALWAYS starts with the tenant's collegeId (`∅` for the legacy
 *   college-less tenant), and `get()` requires the tenant object. There is no way
 *   to read or write an entry without naming a college, so college A's dataset can
 *   never be served to college B, even for identical batch/department names.
 *   Keys are namespaced (`<college>\u0000<dataset>\u0000<variant>`), and a college
 *   id cannot contain NUL, so one college's key can never collide with another's.
 *
 * FRESHNESS: entries expire after `ttlMs` (default 15 s). A successful write request
 * (POST/PUT/PATCH/DELETE through any route that runs `tenantContext`) also drops
 * that college's entries at once (middleware/tenantGuards.js), so a college sees its
 * own changes on the next page view. Changes that bypass those routes (a script, the
 * nightly purge, another server process) show up when the entry expires — at most
 * `ttlMs` later. Set ANALYTICS_CACHE_TTL_MS=0 to turn the cache off. Under the Node
 * test runner it is off by default (set the variable explicitly to test it).
 *
 * Concurrent requests for the same key share one computation (no stampede).
 * Failed computations are never cached. The cache is per process (not shared
 * between server instances) and bounded (`maxEntries`, oldest evicted first).
 *
 * Callers receive the SAME object that was cached: treat it as read-only (copy
 * arrays before sorting).
 */
import { assertTenant } from "./tenantScope.js";

const DEFAULT_TTL_MS = 15_000;
const DEFAULT_MAX_ENTRIES = 500;

/** Effective TTL: an explicit ANALYTICS_CACHE_TTL_MS wins; otherwise off under `node --test`, 15 s elsewhere. */
export const resolveAnalyticsCacheTtl = (env = process.env) => {
  const raw = env.ANALYTICS_CACHE_TTL_MS;
  if (raw !== undefined && raw !== "") {
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : DEFAULT_TTL_MS;
  }
  if (env.NODE_ENV === "test" || env.NODE_TEST_CONTEXT) return 0;
  return DEFAULT_TTL_MS;
};

const keyOf = (tenant, dataset, variant) =>
  `${tenant.collegeId === null ? "∅" : tenant.collegeId}\u0000${dataset}\u0000${variant}`;

export const createTenantCache = ({ ttlMs, maxEntries = DEFAULT_MAX_ENTRIES, now = () => Date.now() } = {}) => {
  const entries = new Map(); // key -> { expires, promise }
  const stats = { hits: 0, misses: 0, shared: 0 };
  const ttl = () => (typeof ttlMs === "function" ? ttlMs() : ttlMs ?? resolveAnalyticsCacheTtl());

  const sweep = () => {
    const t = now();
    for (const [k, e] of entries) if (e.expires !== null && e.expires <= t) entries.delete(k);
    while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
  };

  return {
    stats,
    get size() { return entries.size; },

    /**
     * @param {{collegeId: string|null}} tenant  req.tenant — REQUIRED
     * @param {string} dataset                   e.g. "teacher-performance"
     * @param {() => Promise<any>} compute       runs the (already tenant-scoped) queries
     * @param {string} [variant]                 e.g. "archived=true"
     */
    async get(tenant, dataset, compute, variant = "") {
      assertTenant(tenant);
      const t = ttl();
      if (!(t > 0)) return compute(); // cache off: every call recomputes
      const key = keyOf(tenant, dataset, variant);
      const hit = entries.get(key);
      if (hit && (hit.expires === null || hit.expires > now())) {
        if (hit.expires === null) stats.shared += 1; else stats.hits += 1;
        return hit.promise;
      }
      stats.misses += 1;
      const entry = { expires: null, promise: null }; // null = still computing (shared by concurrent callers)
      entry.promise = Promise.resolve().then(compute).then(
        (value) => { entry.expires = now() + t; sweep(); return value; },
        (err) => { if (entries.get(key) === entry) entries.delete(key); throw err; }
      );
      entries.set(key, entry);
      return entry.promise;
    },

    /** Drop one college's entries (all of them, or one dataset). */
    invalidate(tenant, dataset) {
      assertTenant(tenant);
      const prefix = `${tenant.collegeId === null ? "∅" : tenant.collegeId}\u0000${dataset === undefined ? "" : `${dataset}\u0000`}`;
      for (const k of [...entries.keys()]) if (k.startsWith(prefix)) entries.delete(k);
    },

    clear() { entries.clear(); },
  };
};

/** Process-wide cache used by the dashboard controllers. */
export const analyticsCache = createTenantCache();
