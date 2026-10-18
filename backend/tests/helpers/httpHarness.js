/** Minimal Express-like harness for running middleware chains in tests. */
export const mkRes = () => ({
  code: 200, body: null, headers: {},
  status(c) { this.code = c; return this; },
  json(b) { this.body = b; return this; },
  set(k, v) { this.headers[k] = v; return this; },
});

/** Run middleware/handlers in order, like Express: stops when one answers instead of calling next(). */
export const run = async (chain, req) => {
  const res = mkRes();
  let error = null;
  for (const fn of chain) {
    let advanced = false;
    await new Promise((resolve) => {
      const next = (err) => { advanced = true; if (err) error = err; resolve(); };
      Promise.resolve(fn(req, res, next)).then(() => { if (res.body !== null) resolve(); else if (!advanced) resolve(); }, (e) => { error = e; resolve(); });
    });
    if (error) throw error;
    if (!advanced) break;
  }
  return { res, req, passed: res.body === null };
};
