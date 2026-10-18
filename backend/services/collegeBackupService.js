/**
 * College-level backup & restore (Part 17).
 *
 * ARCHITECTURE NOTE. Before Part 17 the application had NO backup/restore code:
 * the only "backup" was the pre-deletion register ZIP (exportController), which
 * is already per-subject and college-scoped. Whole-database backups are an
 * infrastructure concern (MongoDB Atlas snapshots / mongodump of the shared
 * cluster) and are PLATFORM-WIDE: they contain every college. That is left
 * exactly as it was — nothing here reads, wraps or exposes it, and a college
 * admin can neither trigger nor restore one.
 *
 * What this module adds is a separate, explicitly COLLEGE-LEVEL feature:
 *
 *   createCollegeBackup(tenant)          export the caller's college as a signed JSON file
 *   validateForRestore(tenant, file)     is this file a backup of THIS college we made?
 *   restoreCollegeBackup(tenant, file, { dryRun })
 *                                        MERGE-ONLY restore: inserts records that are
 *                                        missing, never updates, overwrites or deletes
 *
 * Tenant rules (the same contract as the rest of the app):
 *  - the college is `tenant.collegeId` from the database session; the file's own
 *    claims are checked against it, never trusted as the target;
 *  - every read and write goes through scopedModel(Model, tenant);
 *  - a file whose college differs, whose signature fails, that holds a collection we
 *    do not export (e.g. users), or any record stamped with another college is
 *    refused as a whole — before anything is written;
 *  - references (teacher accounts, subjects) must already resolve INSIDE the same
 *    college, so a restore cannot attach data to another college's accounts;
 *  - results are counts and reason codes only. A record whose id or unique key is
 *    already taken by another college's row is reported as a generic "conflict",
 *    indistinguishable from any other duplicate-key failure — nothing about the
 *    other college is revealed.
 */
import Department from "../models/Department.js";
import Shift from "../models/Shift.js";
import AttendanceCategory from "../models/AttendanceCategory.js";
import Settings from "../models/Settings.js";
import Student from "../models/Student.js";
import Subject from "../models/Subject.js";
import Attendance from "../models/Attendance.js";
import ConsecutiveAbsenceAlert from "../models/ConsecutiveAbsenceAlert.js";
import User from "../models/User.js";
import { scopedModel, assertTenant, TenantScopeError } from "../utils/tenantScope.js";
import { isObjectIdString } from "../utils/approval.js";
import { BACKUP_COLLECTIONS, buildBackupFile, verifyBackupFile } from "../utils/backupFormat.js";

const MODELS = {
  departments: Department,
  shifts: Shift,
  attendanceCategories: AttendanceCategory,
  settings: Settings,
  students: Student,
  subjects: Subject,
  attendance: Attendance,
  alerts: ConsecutiveAbsenceAlert,
};

const fail = (status, code, message) => ({ ok: false, status, code, message });

const requireCollege = (tenant) => {
  assertTenant(tenant);
  if (!tenant.collegeId) return fail(403, "NO_COLLEGE", "Your account is not assigned to a college.");
  return null;
};

// ─── Create ───────────────────────────────────────────────────────────────────
export const createCollegeBackup = async (tenant, { models = MODELS, now = new Date() } = {}) => {
  const refused = requireCollege(tenant);
  if (refused) return refused;

  const data = {};
  for (const key of BACKUP_COLLECTIONS) {
    const rows = await scopedModel(models[key], tenant).find({}).lean();
    data[key] = rows.map(({ __v, ...doc }) => { // eslint-disable-line no-unused-vars
      // Belt and braces: the scoped read cannot return another college's row; if it ever did, stop.
      if ((doc.collegeId ?? null) !== tenant.collegeId) throw new TenantScopeError("Backup read returned a row of another college.");
      return doc;
    });
  }
  const file = buildBackupFile({ collegeId: tenant.collegeId, collegeName: tenant.college?.name ?? null, data, now });
  return { ok: true, status: 200, file };
};

// ─── Validate an uploaded file for THIS college ──────────────────────────────
export const validateForRestore = (tenant, file) => {
  const refused = requireCollege(tenant);
  if (refused) return refused;

  const v = verifyBackupFile(file);
  if (!v.ok) return fail(v.code === "BACKUP_UNAVAILABLE" ? 503 : 400, v.code, v.message);

  if (file.manifest.collegeId !== tenant.collegeId) {
    return fail(403, "BACKUP_WRONG_COLLEGE", "This backup belongs to a different college and cannot be restored here.");
  }
  // Every record must be this college's and carry a usable id.
  for (const key of BACKUP_COLLECTIONS) {
    for (const doc of file.data[key] || []) {
      if (!doc || typeof doc !== "object" || Array.isArray(doc)) return fail(400, "BACKUP_INVALID", "This is not a college backup file.");
      if ((doc.collegeId ?? null) !== tenant.collegeId) {
        return fail(403, "BACKUP_FOREIGN_RECORDS", "This backup contains records of another college and was rejected.");
      }
      if (!isObjectIdString(String(doc._id ?? ""))) return fail(400, "BACKUP_INVALID", "This is not a college backup file.");
    }
  }
  return { ok: true };
};

// ─── Restore (merge-only) ─────────────────────────────────────────────────────
const SKIP = ["existing", "missingReference", "conflict", "invalid"];
const blank = () => ({ toInsert: 0, inserted: 0, ...Object.fromEntries(SKIP.map((k) => [k, 0])) });

/**
 * @returns {{ok:true,status:200,dryRun:boolean,summary:Record<string,object>,totals:object}|{ok:false,...}}
 */
export const restoreCollegeBackup = async (tenant, file, { dryRun = true, models = MODELS, UserModel = User } = {}) => {
  const valid = validateForRestore(tenant, file);
  if (!valid.ok) return valid;

  const db = (key) => scopedModel(models[key], tenant);
  const teachers = new Map(); // memo: does this account exist in THIS college?
  const teacherInCollege = async (id) => {
    const k = String(id ?? "");
    if (!isObjectIdString(k)) return false;
    if (!teachers.has(k)) teachers.set(k, !!(await scopedModel(UserModel, tenant).exists({ _id: k })));
    return teachers.get(k);
  };
  const subjectIds = new Set(); // subjects present in the college now, or inserted/planned earlier in this run
  for (const s of await db("subjects").find({}).select("_id").lean()) subjectIds.add(String(s._id));

  const summary = {};
  for (const key of BACKUP_COLLECTIONS) {
    const stat = (summary[key] = blank());
    for (const doc of file.data[key]) {
      const id = String(doc._id);

      // Already there (in this college) → leave it exactly as it is.
      if (await db(key).exists({ _id: id })) { stat.existing += 1; continue; }

      // References must resolve inside this college.
      let referencesOk = true;
      if (key === "subjects") referencesOk = await teacherInCollege(doc.teacher);
      if (key === "attendance") referencesOk = subjectIds.has(String(doc.subjectId)) && (await teacherInCollege(doc.teacher));
      if (key === "alerts") referencesOk = subjectIds.has(String(doc.subjectId));
      if (!referencesOk) { stat.missingReference += 1; continue; }

      if (dryRun) { stat.toInsert += 1; if (key === "subjects") subjectIds.add(id); continue; }

      try {
        await db(key).create(doc); // collegeId is stamped by scopedModel; the file's value is discarded
        stat.inserted += 1;
        if (key === "subjects") subjectIds.add(id);
      } catch (err) {
        if (err?.code === 11000) stat.conflict += 1; // id or a unique business key is taken (here or elsewhere — same answer)
        else if (err?.name === "ValidationError" || err?.name === "CastError") stat.invalid += 1;
        else throw err;
      }
    }
    if (dryRun) stat.inserted = 0;
  }

  const totals = blank();
  for (const s of Object.values(summary)) for (const k of Object.keys(totals)) totals[k] += s[k];
  return { ok: true, status: 200, dryRun, summary, totals, createdAt: file.manifest.createdAt };
};
