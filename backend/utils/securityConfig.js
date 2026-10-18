/**
 * Start-up checks for security-critical configuration.
 * Returns a list of problems; server.js refuses to boot in production if any
 * are fatal, and only warns in development.
 */
import { parseAllowedOrigins } from "./corsConfig.js";

const PLACEHOLDER_SECRETS = new Set([
  "change-me-to-a-long-random-string",
  "changeme",
  "secret",
  "your-secret-here",
]);

export const MIN_SECRET_LENGTH = 32;

const LOCAL_HOSTS = /^(localhost|127\.0\.0\.1|\[::1\])$/;

export const checkSecurityConfig = (env = process.env) => {
  const problems = [];
  const secret = env.JWT_SECRET || "";
  if (!secret) problems.push("JWT_SECRET is not set.");
  else {
    if (secret.length < MIN_SECRET_LENGTH) problems.push(`JWT_SECRET is shorter than ${MIN_SECRET_LENGTH} characters.`);
    if (PLACEHOLDER_SECRETS.has(secret.toLowerCase())) problems.push("JWT_SECRET is still the example placeholder.");
  }
  const production = env.NODE_ENV === "production";

  // CORS (Part 20). A wildcard + credentials would let any website act as a signed-in user.
  const { origins, invalid, configured } = parseAllowedOrigins(env.CLIENT_URL);
  if (invalid.length) problems.push(`CLIENT_URL contains invalid or forbidden origin(s): ${invalid.join(", ")} (use full URLs such as https://app.example.com; "*" is not allowed).`);
  if (production) {
    if (!configured) problems.push("CLIENT_URL is not set (the browser app's origin must be allow-listed in production).");
    else if (origins.length && origins.every((o) => LOCAL_HOSTS.test(new URL(o).hostname))) problems.push("CLIENT_URL only lists localhost; set the real browser origin.");
    if (origins.some((o) => o.startsWith("http://") && !LOCAL_HOSTS.test(new URL(o).hostname))) problems.push("CLIENT_URL uses plain http:// in production; use https://.");
    if (env.BACKUP_SIGNING_KEY !== undefined && String(env.BACKUP_SIGNING_KEY).length > 0 && String(env.BACKUP_SIGNING_KEY).length < 16) problems.push("BACKUP_SIGNING_KEY is shorter than 16 characters.");
  }
  return { ok: problems.length === 0, problems, production };
};

/** `STRICT_COLLEGE_MEMBERSHIP=true` → accounts with no college are refused (use after the migration). */
export const isStrictCollegeMembership = (env = process.env) => String(env.STRICT_COLLEGE_MEMBERSHIP).toLowerCase() === "true";
