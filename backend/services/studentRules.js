/**
 * Student business rules shared by the manual add/edit forms and the JSON
 * import. Everything here is college-scoped through scopedModel(Student,
 * tenant): the caller's college comes from the session, never from the request.
 *
 * Uniqueness rules (all PER COLLEGE — two colleges may reuse any value):
 *   1. Registration number (studentId): at most ONE ACTIVE student per college.
 *   2. Roll number: at most one ACTIVE student per college + department +
 *      batch + shift. Roll numbers are NOT unique across a college or globally.
 * The unique indexes on the Student model enforce the same two rules in the
 * database; the checks here exist to give a precise message BEFORE writing.
 */
import Student from "../models/Student.js";
import { scopedModel } from "../utils/tenantScope.js";
import { exactNameMatch, sameName } from "../utils/academicNames.js";
import { MAX_LISTED_ERRORS } from "../validators/studentValidator.js";

export const groupLabel = (g) => `${g.department} / batch ${g.batch} / ${g.shift}`;

/** Filter for "the students of this department + batch + shift" (names matched ignoring case, batch exactly). */
export const groupFilter = ({ department, batch, shift }) => ({
  department: exactNameMatch(department),
  batch,
  shift: exactNameMatch(shift),
});

const inGroup = (s, g) => sameName(s.department, g.department) && s.batch === g.batch && sameName(s.shift, g.shift);

/**
 * Is `studentId` / `roll` already taken (by an ACTIVE student of this college)?
 * `excludeId` skips the student being edited. Returns null, or
 * { field: "studentId" | "roll", message, existing }.
 */
export const findStudentConflict = async (tenant, { studentId, roll, department, batch, shift, excludeId = null }) => {
  const S = scopedModel(Student, tenant);
  const notSelf = excludeId ? { _id: { $ne: excludeId } } : {};

  const byId = await S.findOne({ ...notSelf, isActive: true, studentId }, { lean: true });
  if (byId) {
    return {
      field: "studentId",
      existing: byId,
      message: `Registration Number "${studentId}" is already registered to another active student in this college.`,
    };
  }
  const byRoll = await S.findOne({ ...notSelf, isActive: true, roll, ...groupFilter({ department, batch, shift }) }, { lean: true });
  if (byRoll) {
    return {
      field: "roll",
      existing: byRoll,
      message: `Roll Number "${roll}" is already used by another active student in ${groupLabel({ department, batch, shift })}.`,
    };
  }
  return null;
};

/**
 * Work out, WITHOUT writing anything, what importing `rows` into one
 * department + batch + shift of the college would do — or why it cannot.
 *
 * `department` and `shift` must already be the college's canonical names
 * (resolved by the caller from the college's own Department / Shift lists).
 * `session` is the active transaction session, or null.
 *
 * Returns { errors, totalErrors, ops, counts }:
 *   errors — [] when the import can go ahead, otherwise row-level details
 *            { index, row, studentId, field, code, message } (first 50 listed)
 *   ops    — bulkWrite operations (empty when there are errors)
 *   counts — { insert, update, reactivate }
 *
 * Import semantics are unchanged: students are matched by studentId inside the
 * group and upserted; students missing from the file are left alone.
 */
export const planStudentImport = async ({ tenant, department, batch, shift, rows, uploadedBy, sourceFile, session = null }) => {
  const S = scopedModel(Student, tenant);
  const group = { department, batch, shift };
  const withSession = (q) => q.session(session ?? null);

  const [sameId, groupActive] = await Promise.all([
    withSession(S.find({ studentId: { $in: rows.map((r) => r.studentId) } }, { lean: true })),
    withSession(S.find({ isActive: true, ...groupFilter(group) }, { lean: true })),
  ]);

  const byStudentId = new Map();
  for (const s of sameId) {
    if (!byStudentId.has(s.studentId)) byStudentId.set(s.studentId, []);
    byStudentId.get(s.studentId).push(s);
  }
  const activeByRoll = new Map(groupActive.map((s) => [s.roll, s]));
  const fileRollById = new Map(rows.map((r) => [r.studentId, r.roll]));

  const found = [];
  const ops = [];
  const counts = { insert: 0, update: 0, reactivate: 0 };
  const problem = (i, r, field, code, message) =>
    found.push({ index: i, row: i + 1, studentId: r.studentId, field, code, message: `Student[${i}]: ${message}` });

  rows.forEach((r, i) => {
    const candidates = byStudentId.get(r.studentId) || [];

    // Registration number already belongs to an ACTIVE student in another group of this college.
    const elsewhere = candidates.find((c) => c.isActive && !inGroup(c, group));
    if (elsewhere) {
      problem(i, r, "studentId", "STUDENT_ID_IN_USE",
        `studentId "${r.studentId}" is already registered to an active student in ${groupLabel(elsewhere)}.`);
      return;
    }

    // Roll number already used by a DIFFERENT active student of this group.
    const holder = activeByRoll.get(r.roll);
    if (holder && holder.studentId !== r.studentId) {
      if (fileRollById.has(holder.studentId)) {
        problem(i, r, "roll", "ROLL_REASSIGNMENT",
          `roll "${r.roll}" currently belongs to studentId "${holder.studentId}", who is also in this file with a different roll. ` +
          `Rolls cannot be swapped or shifted in one upload — change them one at a time.`);
      } else {
        problem(i, r, "roll", "ROLL_IN_USE",
          `roll "${r.roll}" is already used by active student "${holder.studentId}" (${holder.name}) in ${groupLabel(group)}.`);
      }
      return;
    }

    const extra = {
      ...(r.email ? { email: r.email } : {}),
      ...(r.section ? { section: r.section } : {}),
    };
    const target = candidates.filter((c) => inGroup(c, group)).sort((a, b) => Number(b.isActive) - Number(a.isActive) || new Date(b.updatedAt) - new Date(a.updatedAt))[0];

    if (target) {
      // Existing student of this group (possibly removed earlier): update by id, keep stored names.
      counts.update++;
      if (!target.isActive) counts.reactivate++;
      ops.push({
        updateOne: {
          filter: { _id: target._id },
          update: { $set: { roll: r.roll, name: r.name, uploadedBy, sourceFile, isActive: true, ...extra } },
        },
      });
    } else {
      counts.insert++;
      ops.push({
        updateOne: {
          filter: { studentId: r.studentId, department, batch, shift },
          update: { $set: { roll: r.roll, name: r.name, department, batch, shift, uploadedBy, sourceFile, isActive: true, ...extra } },
          upsert: true,
        },
      });
    }
  });

  return {
    errors: found.slice(0, MAX_LISTED_ERRORS),
    totalErrors: found.length,
    ops: found.length ? [] : ops,
    counts,
  };
};
