/**
 * Input validation for the public attendance lookup. Pure (no database).
 *
 * Every field must be a plain string — arrays/objects such as { "$ne": "" } are
 * rejected, so no Mongo operator can reach a query. Text is trimmed and inner
 * whitespace collapsed; control characters are refused.
 */
import { COLLEGE_ID_PATTERN } from "../utils/collegeId.js";

export const LOOKUP_LIMITS = Object.freeze({ department: 100, batch: 50, shift: 50, roll: 64 });

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

const FIELD_LABELS = { department: "Department", batch: "Batch", shift: "Shift", roll: "Roll" };

/**
 * @param {unknown} body  req.body
 * @returns {{ ok: true, values: {collegeId,department,batch,shift,roll} } | { ok: false, errors: Record<string,string> }}
 */
export const validateLookupInput = (body) => {
  const errors = {};
  const src = body && typeof body === "object" && !Array.isArray(body) ? body : {};

  const collegeId = src.collegeId;
  if (typeof collegeId !== "string" || !COLLEGE_ID_PATTERN.test(collegeId.trim())) {
    errors.collegeId = "Please search for and select your college.";
  }

  const values = { collegeId: typeof collegeId === "string" ? collegeId.trim() : "" };
  for (const field of ["department", "batch", "shift", "roll"]) {
    const raw = src[field];
    const label = FIELD_LABELS[field];
    if (raw === undefined || raw === null || raw === "") { errors[field] = `${label} is required.`; continue; }
    // Numbers are tolerated for batch/roll (e.g. 2024, 17) — nothing else is.
    const text = typeof raw === "number" && Number.isFinite(raw) ? String(raw) : raw;
    if (typeof text !== "string") { errors[field] = `${label} must be text.`; continue; }
    const clean = text.replace(/\s+/g, " ").trim();
    if (!clean) { errors[field] = `${label} is required.`; continue; }
    if (clean.length > LOOKUP_LIMITS[field]) { errors[field] = `${label} is too long (max ${LOOKUP_LIMITS[field]} characters).`; continue; }
    if (CONTROL_CHARS.test(clean)) { errors[field] = `${label} contains invalid characters.`; continue; }
    values[field] = clean;
  }

  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, values };
};
