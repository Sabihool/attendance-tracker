/**
 * Part 12 migration: give existing attendance data an owning college.
 *
 *   Attendance               ← the college of its SUBJECT (stamped in Part 9)
 *   ConsecutiveAbsenceAlert  ← the college of its subject
 *   AttendanceCategory       ← every college that has none receives a copy of the
 *                              legacy (college-less) list, so it keeps the names
 *                              and credit values it always had; any category name
 *                              a college's own sessions/subjects already use is
 *                              added if missing (credit: the legacy value, else the
 *                              built-in default, else 1)
 *   Settings                 ← every college without its own document receives a
 *                              copy of the legacy singleton's streak limit
 *   Indexes                  ← the global unique index on category names and the
 *                              pre-Part-12 attendance/alert indexes are dropped; the
 *                              college-led ones are built from the schemas
 *
 * What it NEVER does: change, delete, re-date or re-weight an attendance record,
 * a student entry, a credit snapshot (classWeight), an alert's count or note, or
 * move anything between colleges. It only sets `collegeId` where it is missing
 * (null) — so existing attendance history, credit snapshots and streaks are
 * exactly as they were.
 *
 * Rows whose subject has no college (legacy college-less accounts, or orphaned
 * rows whose subject was deleted) stay college-less (collegeId null): they keep
 * working for college-less legacy accounts exactly as before and no real college
 * can see them. They are counted in `unassigned` so they can be reviewed.
 *
 * Run AFTER utils/academicBackfill.js (it stamps subjects, which this uses).
 * Idempotent: a second run changes nothing.
 */
import Attendance from "../models/Attendance.js";
import AttendanceCategory from "../models/AttendanceCategory.js";
import ConsecutiveAbsenceAlert from "../models/ConsecutiveAbsenceAlert.js";
import Settings from "../models/Settings.js";
import Subject from "../models/Subject.js";
import User from "../models/User.js";
import College from "../models/College.js";
import { isIndexNotFound, isNamespaceMissing } from "./academicIndexMigration.js";
import { scopedModel } from "./tenantScope.js";
import { sameName, cleanName } from "./academicNames.js";
import { DEFAULT_CREDIT_BY_TYPE, normalizeCategoryName } from "./creditUtils.js";

// collegeId is immutable for normal updates; `timestamps: false` keeps updatedAt
// exactly as it was — the migration must not look like an edit of the history.
const IMMUTABLE_OK = { overwriteImmutable: true, timestamps: false };
const CHUNK = 500;

/** Dropped BEFORE the new indexes are built: it would block per-college categories. */
export const LEGACY_INDEXES_DROP_FIRST = Object.freeze({
  attendancecategories: ["name_1"],
});
/** Dropped AFTER the college-led replacements exist, so uniqueness is never unprotected. */
export const LEGACY_INDEXES_DROP_AFTER = Object.freeze({
  attendances: [
    "subjectId_1_date_1_classType_1_isDeleted_1",
    "teacher_1_date_-1",
    "subjectId_1_date_-1",
    "isDeleted_1_students.studentId_1",
  ],
  consecutiveabsencealerts: [
    "studentId_1_subjectId_1_removed_1",
    "teacherId_1_removed_1_createdAt_-1",
    "studentId_1_createdAt_-1",
  ],
});

const existingIndexNames = async (Model) => {
  try {
    return (await Model.collection.indexes()).map((i) => i.name);
  } catch (e) {
    if (!isNamespaceMissing(e)) throw e; // brand-new database: nothing to drop
    return [];
  }
};

const dropIndexes = async (Model, names) => {
  const existing = await existingIndexNames(Model);
  const dropped = [];
  for (const name of names) {
    if (!existing.includes(name)) continue;
    try {
      await Model.collection.dropIndex(name);
      dropped.push(`${Model.collection.name}.${name}`);
    } catch (e) {
      if (!isIndexNotFound(e)) throw e;
    }
  }
  return dropped;
};

export const migrateAttendanceIndexes = async ({
  AttendanceModel = Attendance, CategoryModel = AttendanceCategory, AlertModel = ConsecutiveAbsenceAlert, SettingsModel = Settings,
} = {}) => {
  const byCollection = { attendances: AttendanceModel, attendancecategories: CategoryModel, consecutiveabsencealerts: AlertModel, settings: SettingsModel };
  const dropped = [];
  for (const [coll, names] of Object.entries(LEGACY_INDEXES_DROP_FIRST)) dropped.push(...(await dropIndexes(byCollection[coll], names)));
  for (const Model of Object.values(byCollection)) await Model.createIndexes();
  for (const [coll, names] of Object.entries(LEGACY_INDEXES_DROP_AFTER)) dropped.push(...(await dropIndexes(byCollection[coll], names)));
  return { dropped, built: Object.keys(byCollection) };
};

/** { collegeId → [subjectId…] } for subjects that belong to a college. */
const subjectsByCollege = async (SubjectModel) => {
  const subjects = await SubjectModel.find({ collegeId: { $ne: null } }).select("_id collegeId").lean();
  const map = new Map();
  for (const s of subjects) {
    if (typeof s.collegeId !== "string" || !s.collegeId) continue;
    if (!map.has(s.collegeId)) map.set(s.collegeId, []);
    map.get(s.collegeId).push(s._id);
  }
  return map;
};

/** Stamp college-less rows (field missing or null) with their subject's college. */
const stampFromSubjects = async (Model, byCollege) => {
  let n = 0;
  for (const [collegeId, ids] of byCollege) {
    for (let i = 0; i < ids.length; i += CHUNK) {
      const r = await Model.updateMany(
        { collegeId: null, subjectId: { $in: ids.slice(i, i + CHUNK) } },
        { $set: { collegeId } },
        IMMUTABLE_OK
      );
      n += r?.modifiedCount ?? 0;
    }
  }
  return n;
};

export const migrateAttendanceOwnership = async ({
  AttendanceModel = Attendance, CategoryModel = AttendanceCategory, AlertModel = ConsecutiveAbsenceAlert,
  SettingsModel = Settings, SubjectModel = Subject, UserModel = User, CollegeModel = College,
} = {}) => {
  const result = {
    indexesDropped: 0, attendance: 0, alerts: 0, categories: 0, settings: 0,
    unassigned: { attendance: 0, alerts: 0 }, teacherMismatches: 0, changed: 0,
  };

  // 1. Indexes first, so per-college categories / settings can coexist from here on.
  const idx = await migrateAttendanceIndexes({ AttendanceModel, CategoryModel, AlertModel, SettingsModel });
  result.indexesDropped = idx.dropped.length;

  // 2. Ownership of sessions and alerts = their subject's college.
  const byCollege = await subjectsByCollege(SubjectModel);
  result.attendance = await stampFromSubjects(AttendanceModel, byCollege);
  result.alerts = await stampFromSubjects(AlertModel, byCollege);

  // 3. Categories and settings per college.
  const colleges = await CollegeModel.find({}).select("collegeId").lean();
  const legacyCats = await scopedModel(CategoryModel, { collegeId: null }).find({}).sort({ name: 1 }).lean();
  const legacySettings = await scopedModel(SettingsModel, { collegeId: null }).findOne({}, { lean: true });

  for (const { collegeId } of colleges) {
    const tenant = { collegeId };
    const cats = scopedModel(CategoryModel, tenant);

    const have = (await cats.find({}).select("name").lean()).map((c) => c.name);
    const addCategory = async (name, credit, isDefault = false) => {
      const clean = cleanName(name);
      if (!clean || clean.length < 2 || have.some((h) => sameName(h, clean))) return;
      try {
        await cats.create({ name: clean, credit, isDefault });
        have.push(clean);
        result.categories++;
      } catch (e) {
        if (e?.code !== 11000) throw e; // lost a race to an identical name: fine
      }
    };

    // 3a. A college with no categories receives the legacy list unchanged.
    if (have.length === 0) for (const c of legacyCats) await addCategory(c.name, c.credit, !!c.isDefault);

    // 3b. Names this college's own sessions and subjects already use must exist.
    //     (Credits already recorded on sessions are snapshots and are never touched.)
    const used = [
      ...(await scopedModel(AttendanceModel, tenant).distinct("classType")),
      ...(await scopedModel(SubjectModel, tenant).distinct("creditType")),
    ];
    for (const name of used) {
      if (typeof name !== "string") continue;
      const legacy = legacyCats.find((c) => sameName(c.name, name));
      await addCategory(name, legacy?.credit ?? DEFAULT_CREDIT_BY_TYPE[normalizeCategoryName(name)] ?? 1);
    }

    // 3c. Streak limit: keep the value the college has been living with.
    if (legacySettings && !(await scopedModel(SettingsModel, tenant).exists({}))) {
      try {
        await scopedModel(SettingsModel, tenant).create({ consecutiveAbsenceLimit: legacySettings.consecutiveAbsenceLimit });
        result.settings++;
      } catch (e) {
        if (e?.code !== 11000) throw e;
      }
    }

    // 3d. Report-only: sessions whose teacher is not a user of the session's college.
    const userIds = (await scopedModel(UserModel, tenant).find({}).select("_id").lean()).map((u) => u._id);
    if (userIds.length) {
      result.teacherMismatches += await scopedModel(AttendanceModel, tenant).countDocuments({ teacher: { $nin: userIds } });
    }
  }

  result.unassigned.attendance = await AttendanceModel.countDocuments({ collegeId: null });
  result.unassigned.alerts = await AlertModel.countDocuments({ collegeId: null });
  result.changed = result.indexesDropped + result.attendance + result.alerts + result.categories + result.settings;
  return result;
};
