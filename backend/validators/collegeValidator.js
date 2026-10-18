/**
 * Validation + normalisation for college registration.
 * The frontend (frontend/src/utils/collegeValidation.js) mirrors these rules
 * for instant feedback; THIS file is the source of truth.
 */

export const LIMITS = {
  collegeName: { min: 2, max: 120 },
  country:     { min: 2, max: 80 },
  district:    { min: 2, max: 80 },
  adminName:   { min: 2, max: 100 },
  email:       { max: 254 },
  password:    { min: 8, maxBytes: 72 }, // bcrypt only uses the first 72 bytes
};

// Unicode letters/digits/marks plus a few punctuation marks common in names
const NAME_CHARS = /^[\p{L}\p{M}\p{N}][\p{L}\p{M}\p{N} .,'’&()\/-]*$/u;
const PLACE_CHARS = /^[\p{L}\p{M}][\p{L}\p{M} .,'’()-]*$/u;
const PERSON_CHARS = /^[\p{L}\p{M}][\p{L}\p{M} .,'’-]*$/u;
const HAS_LETTER = /\p{L}/u;
const EMAIL = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;

/** Trim and collapse internal whitespace. Non-strings become "". */
export const cleanText = (v) =>
  typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "";

/** Lower-cased, accent-folded key used for duplicate detection. */
export const normalizeKeyPart = (v) =>
  cleanText(v).normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();

export const buildDedupeKey = ({ name, country, district }) =>
  [name, country, district].map(normalizeKeyPart).join("|");

const lengthError = (label, value, { min, max }) => {
  if (value.length < min) return `${label} must be at least ${min} characters.`;
  if (value.length > max) return `${label} cannot exceed ${max} characters.`;
  return null;
};

/**
 * @param {object} body  raw req.body
 * @returns {{ ok: boolean, errors: Record<string,string>, values: object }}
 *   `values` only ever contains the whitelisted, cleaned fields — anything
 *   else the client sent (role, collegeId, approved, …) is dropped here.
 */
export const validateCollegeRegistration = (body) => {
  const src = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  const errors = {};

  // Reject non-string values outright (blocks `{ "$gt": "" }`-style payloads)
  const raw = (k) => src[k];
  for (const k of ["collegeName", "country", "district", "adminName", "adminEmail", "password", "confirmPassword"]) {
    if (raw(k) !== undefined && typeof raw(k) !== "string") {
      errors[k] = "Invalid value.";
    }
  }

  const values = {
    collegeName: cleanText(raw("collegeName")),
    country:     cleanText(raw("country")),
    district:    cleanText(raw("district")),
    adminName:   cleanText(raw("adminName")),
    adminEmail:  cleanText(raw("adminEmail")).toLowerCase(),
  };
  const password = typeof raw("password") === "string" ? raw("password") : "";
  const confirmPassword = typeof raw("confirmPassword") === "string" ? raw("confirmPassword") : "";

  // College name
  if (!errors.collegeName) {
    if (!values.collegeName) errors.collegeName = "College name is required.";
    else if (lengthError("College name", values.collegeName, LIMITS.collegeName))
      errors.collegeName = lengthError("College name", values.collegeName, LIMITS.collegeName);
    else if (!HAS_LETTER.test(values.collegeName) || !NAME_CHARS.test(values.collegeName))
      errors.collegeName = "College name contains invalid characters.";
  }

  // Country
  if (!errors.country) {
    if (!values.country) errors.country = "Country is required.";
    else if (lengthError("Country", values.country, LIMITS.country))
      errors.country = lengthError("Country", values.country, LIMITS.country);
    else if (!PLACE_CHARS.test(values.country))
      errors.country = "Country may only contain letters, spaces and . , ' ( ) -";
  }

  // District
  if (!errors.district) {
    if (!values.district) errors.district = "District is required.";
    else if (lengthError("District", values.district, LIMITS.district))
      errors.district = lengthError("District", values.district, LIMITS.district);
    else if (!PLACE_CHARS.test(values.district))
      errors.district = "District may only contain letters, spaces and . , ' ( ) -";
  }

  // Admin name
  if (!errors.adminName) {
    if (!values.adminName) errors.adminName = "Admin name is required.";
    else if (lengthError("Admin name", values.adminName, LIMITS.adminName))
      errors.adminName = lengthError("Admin name", values.adminName, LIMITS.adminName);
    else if (!PERSON_CHARS.test(values.adminName))
      errors.adminName = "Admin name may only contain letters, spaces and . ' -";
  }

  // Admin email
  if (!errors.adminEmail) {
    if (!values.adminEmail) errors.adminEmail = "Admin email is required.";
    else if (values.adminEmail.length > LIMITS.email.max || !EMAIL.test(values.adminEmail))
      errors.adminEmail = "Please enter a valid email address.";
  }

  // Password
  if (!errors.password) {
    if (!password) errors.password = "Password is required.";
    else if (password.length < LIMITS.password.min)
      errors.password = `Password must be at least ${LIMITS.password.min} characters.`;
    else if (Buffer.byteLength(password, "utf8") > LIMITS.password.maxBytes)
      errors.password = `Password is too long (maximum ${LIMITS.password.maxBytes} bytes).`;
    else if (!/\p{L}/u.test(password) || !/\d/.test(password))
      errors.password = "Password must contain at least one letter and one number.";
    else if (/^\s|\s$/.test(password))
      errors.password = "Password cannot start or end with a space.";
  }

  // Confirm password
  if (!errors.confirmPassword) {
    if (!confirmPassword) errors.confirmPassword = "Please confirm your password.";
    else if (!errors.password && password !== confirmPassword)
      errors.confirmPassword = "Passwords do not match.";
  }

  return { ok: Object.keys(errors).length === 0, errors, values: { ...values, password } };
};
