/**
 * validateStudentJSON.js
 * Validates the structure and content of an uploaded student JSON file.
 *
 * Expected JSON format — either:
 *   A) An array:  [ { studentId, roll, name }, ... ]
 *   B) An object: { students: [ { studentId, roll, name }, ... ] }
 *
 * Returns:  { valid: true,  students: [...] }
 *        or { valid: false, errors: ["..."], details: [...], totalErrors: n }
 *
 * `errors`  — human readable lines (what the frontend has always shown).
 * `details` — the same problems as objects: { index, row, studentId?, field, code, message }.
 *             `index` is the position in the array (0-based, as in the message
 *             text "Student[3]"), `row` is index + 1 for people counting entries.
 * Every problem in the file is found (not just the first 20); only the first
 * MAX_LISTED_ERRORS are listed, and `totalErrors` always carries the real count.
 *
 * This validates the FILE only. Whether the students clash with students that
 * already exist in the college is checked against the database by
 * services/studentRules.js (planStudentImport).
 */

export const MAX_STUDENTS_PER_FILE = 1000;
export const MAX_LISTED_ERRORS = 50;

const REQUIRED_FIELDS = ["studentId", "roll", "name"];

// Same bounds the Student schema applies to a manually added student, plus
// sane caps on the two identifiers (they end up in unique indexes and URLs).
const LIMITS = { studentId: 64, roll: 64, name: 150, email: 254, section: 50 };
const MIN_NAME = 2;

const isScalar = (v) => typeof v === "string" || (typeof v === "number" && Number.isFinite(v));

/** Strip a UTF-8 byte-order mark (Excel/Notepad add one) so JSON.parse accepts the file. */
export const stripBom = (text) => (typeof text === "string" && text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);

/**
 * Validate a single student record.
 * Returns an array of { field, code, message } (empty = valid).
 */
const validateStudent = (student) => {
  const problems = [];
  const add = (field, code, message) => problems.push({ field, code, message });

  if (typeof student !== "object" || Array.isArray(student) || student === null) {
    add(null, "NOT_AN_OBJECT", "entry is not an object.");
    return problems;
  }

  for (const field of REQUIRED_FIELDS) {
    const val = student[field];
    if (val === undefined || val === null) {
      add(field, "MISSING_FIELD", `missing required field "${field}".`);
    } else if (!isScalar(val)) {
      add(field, "WRONG_TYPE", `field "${field}" must be a string or number. Got ${Array.isArray(val) ? "array" : typeof val}.`);
    } else {
      const text = String(val).trim();
      if (text === "") add(field, "EMPTY_FIELD", `field "${field}" must not be empty.`);
      else if (text.length > LIMITS[field]) add(field, "TOO_LONG", `"${field}" exceeds ${LIMITS[field]} characters.`);
      else if (field === "name" && text.length < MIN_NAME) add(field, "TOO_SHORT", `"name" must be at least ${MIN_NAME} characters.`);
    }
  }

  // Optional fields: ignored when absent/empty, but a wrong type is reported
  // instead of being silently turned into "[object Object]".
  if (student.email !== undefined && student.email !== null && student.email !== "") {
    if (typeof student.email !== "string") add("email", "WRONG_TYPE", `field "email" must be a string. Got ${typeof student.email}.`);
    else if (student.email.trim().length > LIMITS.email) add("email", "TOO_LONG", `"email" exceeds ${LIMITS.email} characters.`);
  }
  if (student.section !== undefined && student.section !== null && student.section !== "") {
    if (!isScalar(student.section)) add("section", "WRONG_TYPE", `field "section" must be a string or number. Got ${typeof student.section}.`);
    else if (String(student.section).trim().length > LIMITS.section) add("section", "TOO_LONG", `"section" exceeds ${LIMITS.section} characters.`);
  }

  return problems;
};

const fileLevelError = (message, code) => ({
  valid: false,
  errors: [message],
  details: [{ index: null, row: null, field: null, code, message }],
  totalErrors: 1,
});

/**
 * Main validator.
 * @param {any} parsed - The already-parsed JSON value.
 */
export const validateStudentJSON = (parsed) => {
  // ── Normalise to array ────────────────────────────────────────────────────
  let students;
  if (Array.isArray(parsed)) {
    students = parsed;
  } else if (parsed && typeof parsed === "object" && Array.isArray(parsed.students)) {
    students = parsed.students;
  } else {
    return fileLevelError('JSON must be an array of students, or an object with a "students" array.', "BAD_STRUCTURE");
  }

  if (students.length === 0) return fileLevelError("Student list must not be empty.", "EMPTY_LIST");

  if (students.length > MAX_STUDENTS_PER_FILE) {
    return fileLevelError(
      `Too many students: ${students.length}. Maximum allowed per file is 1 000.`,
      "TOO_MANY_STUDENTS"
    );
  }

  // ── Validate each record ──────────────────────────────────────────────────
  const all = []; // every problem found: { index, studentId?, field, code, message }
  const firstIdIndex = new Map();
  const firstRollIndex = new Map();

  for (let i = 0; i < students.length; i++) {
    const s = students[i];
    const label = s && typeof s === "object" && isScalar(s.studentId) && String(s.studentId).trim() ? String(s.studentId).trim() : undefined;
    for (const p of validateStudent(s)) all.push({ index: i, studentId: label, ...p });

    if (s && typeof s === "object" && isScalar(s.studentId) && String(s.studentId).trim()) {
      const id = String(s.studentId).trim().toLowerCase();
      if (firstIdIndex.has(id)) {
        all.push({
          index: i, studentId: label, field: "studentId", code: "DUPLICATE_STUDENT_ID",
          message: `duplicate studentId "${s.studentId}" (already used by Student[${firstIdIndex.get(id)}]).`,
        });
      } else firstIdIndex.set(id, i);
    }

    if (s && typeof s === "object" && isScalar(s.roll) && String(s.roll).trim()) {
      const roll = String(s.roll).trim().toLowerCase();
      if (firstRollIndex.has(roll)) {
        all.push({
          index: i, studentId: label, field: "roll", code: "DUPLICATE_ROLL",
          message: `duplicate roll "${s.roll}" (already used by Student[${firstRollIndex.get(roll)}]).`,
        });
      } else firstRollIndex.set(roll, i);
    }
  }

  if (all.length > 0) {
    const listed = all.slice(0, MAX_LISTED_ERRORS);
    const details = listed.map((p) => ({
      index: p.index, row: p.index + 1, ...(p.studentId ? { studentId: p.studentId } : {}),
      field: p.field, code: p.code, message: `Student[${p.index}]: ${p.message}`,
    }));
    const errors = details.map((d) => d.message);
    if (all.length > listed.length) {
      errors.push(`... ${all.length - listed.length} more problem(s) not listed (${all.length} in total).`);
    }
    return { valid: false, errors, details, totalErrors: all.length };
  }

  // ── Normalise student objects (ensure strings, trim whitespace) ───────────
  const cleaned = students.map((s) => ({
    studentId: String(s.studentId).trim(),
    roll: String(s.roll).trim(),
    name: String(s.name).trim(),
    // Pass through any extra fields the caller wants to keep
    ...(s.email ? { email: String(s.email).trim() } : {}),
    ...(s.section ? { section: String(s.section).trim() } : {}),
  }));

  return { valid: true, students: cleaned };
};
