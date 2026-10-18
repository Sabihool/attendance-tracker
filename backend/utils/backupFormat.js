/**
 * College backup file format + signing (Part 17).
 *
 * A backup file is ONE college's data, as JSON:
 *
 *   {
 *     manifest: { format, version, collegeId, collegeName, createdAt, counts, dataSha256, signature },
 *     data:     { departments: [...], shifts: [...], attendanceCategories: [...], settings: [...],
 *                 students: [...], subjects: [...], attendance: [...], alerts: [...] }
 *   }
 *
 * Deliberately NOT in a backup: user accounts (names, e-mails, password hashes,
 * session versions), the College record itself, tokens, environment values and
 * database connection details. Restoring therefore can never create, change or
 * escalate an account.
 *
 * SIGNING. `signature` is an HMAC-SHA256 over the format, version, college id,
 * creation time, per-collection counts and the SHA-256 of the data. The key is
 * BACKUP_SIGNING_KEY, or (default) derived from JWT_SECRET. A restore accepts only
 * files this deployment produced for THAT college: hand-built or edited files,
 * files from another college and platform-wide dumps all fail verification. Side
 * effect (documented): rotating the key makes older backup files unrestorable.
 */
import crypto from "node:crypto";

export const BACKUP_FORMAT = "attendance-tracker/college-backup";
export const BACKUP_VERSION = 1;

/** key in the file → what it holds. Order = restore order (parents before children). */
export const BACKUP_COLLECTIONS = Object.freeze([
  "departments", "shifts", "attendanceCategories", "settings", "students", "subjects", "attendance", "alerts",
]);

const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

const signingKey = () => {
  const explicit = process.env.BACKUP_SIGNING_KEY;
  if (explicit && explicit.length >= 16) return explicit;
  const base = process.env.JWT_SECRET;
  if (!base) throw new Error("No signing key available (set JWT_SECRET or BACKUP_SIGNING_KEY).");
  return crypto.createHmac("sha256", base).update("attendance-tracker/backup/v1").digest("hex");
};

const signedText = (m) =>
  [m.format, m.version, m.collegeId, m.createdAt, JSON.stringify(m.counts), m.dataSha256].join("\n");

export const hashData = (data) => sha256(JSON.stringify(data));

const countsOf = (data) => Object.fromEntries(BACKUP_COLLECTIONS.map((k) => [k, Array.isArray(data[k]) ? data[k].length : 0]));

/** Wrap already-collected `data` in a signed manifest. */
export const buildBackupFile = ({ collegeId, collegeName = null, data: raw, now = new Date() }) => {
  const data = JSON.parse(JSON.stringify(raw)); // exactly what a file round-trip yields (ObjectId/Date → strings)
  const manifest = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    collegeId,
    collegeName,
    createdAt: now.toISOString(),
    counts: countsOf(data),
    dataSha256: hashData(data),
  };
  manifest.signature = crypto.createHmac("sha256", signingKey()).update(signedText(manifest)).digest("hex");
  return { manifest, data };
};

const safeEqualHex = (a, b) => {
  const x = Buffer.from(String(a), "utf8"), y = Buffer.from(String(b), "utf8");
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

/**
 * Structural + integrity check of an uploaded backup. Does NOT look at who is
 * restoring it (see collegeBackupService.validateForRestore for that).
 * → { ok: true } | { ok: false, code, message }
 */
export const verifyBackupFile = (file) => {
  const bad = (code, message) => ({ ok: false, code, message });
  if (!file || typeof file !== "object" || Array.isArray(file)) return bad("BACKUP_INVALID", "This is not a college backup file.");
  const { manifest, data } = file;
  if (!manifest || typeof manifest !== "object" || !data || typeof data !== "object" || Array.isArray(data)) return bad("BACKUP_INVALID", "This is not a college backup file.");
  if (manifest.format !== BACKUP_FORMAT) return bad("BACKUP_INVALID", "This is not a college backup file.");
  if (manifest.version !== BACKUP_VERSION) return bad("BACKUP_VERSION", "Unsupported backup version.");
  if (typeof manifest.collegeId !== "string" || !manifest.collegeId || typeof manifest.createdAt !== "string" || typeof manifest.signature !== "string") {
    return bad("BACKUP_INVALID", "This is not a college backup file.");
  }
  // Only the known collections, only arrays: no "users", no extras smuggled in.
  for (const [k, v] of Object.entries(data)) {
    if (!BACKUP_COLLECTIONS.includes(k) || !Array.isArray(v)) return bad("BACKUP_INVALID", "This is not a college backup file.");
  }
  let expected;
  try {
    expected = crypto.createHmac("sha256", signingKey()).update(signedText({ ...manifest, counts: manifest.counts })).digest("hex");
  } catch {
    return bad("BACKUP_UNAVAILABLE", "Backups are not available (server signing key missing).");
  }
  if (!safeEqualHex(manifest.signature, expected) || manifest.dataSha256 !== hashData(data)) {
    return bad("BACKUP_SIGNATURE_INVALID", "This backup file was not created by this system, or it has been modified.");
  }
  const counts = countsOf(data);
  if (JSON.stringify(counts) !== JSON.stringify(manifest.counts)) return bad("BACKUP_SIGNATURE_INVALID", "This backup file was not created by this system, or it has been modified.");
  return { ok: true };
};
