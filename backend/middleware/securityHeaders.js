/**
 * Baseline response headers for an API that returns personal data.
 * (No extra dependency: these are the few headers that matter for a JSON API.)
 *
 *   X-Content-Type-Options: nosniff   a browser must not guess a type for a response
 *   X-Frame-Options: DENY             the API is never meant to be framed
 *   Referrer-Policy: no-referrer
 *   Cross-Origin-Resource-Policy      same-site: other sites may not embed API responses
 *   Strict-Transport-Security         only when the request arrived over HTTPS (behind the proxy)
 *
 * Cache-Control is NOT set here: public college search sets its own, personal exports use no-store.
 */
export const securityHeaders = (req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cross-Origin-Resource-Policy", "same-site");
  if (req.secure) res.setHeader("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
  next();
};
