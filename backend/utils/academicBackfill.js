/**
 * Part 9 migration: give existing academic data an owning college.
 *
 *   Subject  ← the college of its teacher
 *   Student  ← the college of the user who uploaded/created it
 *   Department / Shift ← every college that has none receives a copy of the
 *                        legacy (college-less) list, so it keeps the names its
 *                        subjects already use; names referenced by a college's
 *                        subjects/students are added if missing.
 *
 * Rows whose owner has no college stay college-less (collegeId null) and keep
 * working for college-less legacy accounts exactly as before; no real college
 * can see them. Nothing is deleted, renamed or moved between colleges.
 *
 * Idempotent: a second run changes nothing.
 */
import Department from "../models/Department.js";
import Shift from "../models/Shift.js";
import Student from "../models/Student.js";
import Subject from "../models/Subject.js";
import User from "../models/User.js";
import College from "../models/College.js";
import { migrateAcademicIndexes } from "./academicIndexMigration.js";
import { scopedModel } from "./tenantScope.js";
import { sameName, cleanName } from "./academicNames.js";

const IMMUTABLE_OK = { overwriteImmutable: true }; // collegeId is immutable for normal updates

/** { collegeId → [userId…] } for users that belong to a college. */
const usersByCollege = async (UserModel) => {
  const users = await UserModel.find({ collegeId: { $ne: null } }).select("_id collegeId").lean();
  const map = new Map();
  for (const u of users) {
    if (typeof u.collegeId !== "string" || !u.collegeId) continue;
    if (!map.has(u.collegeId)) map.set(u.collegeId, []);
    map.get(u.collegeId).push(u._id);
  }
  return map;
};

/** Stamp college-less rows (field missing or null) with their owner's college. */
const stampOwnedRows = async (Model, ownerField, byCollege) => {
  let n = 0;
  for (const [collegeId, ids] of byCollege) {
    const r = await Model.updateMany(
      { collegeId: null, [ownerField]: { $in: ids } },
      { $set: { collegeId } },
      IMMUTABLE_OK
    );
    n += r?.modifiedCount ?? 0;
  }
  return n;
};

/** Add to `tenant`'s list any `names` not already present (case-insensitive). */
const addMissingNames = async (Model, tenant, names, extra = () => ({})) => {
  const scoped = scopedModel(Model, tenant);
  const have = (await scoped.find({}).select("name").lean()).map((d) => d.name);
  let added = 0;
  for (const raw of names) {
    const name = cleanName(raw);
    if (!name || name.length < 2 || have.some((h) => sameName(h, name))) continue;
    try {
      await scoped.create({ name, ...extra(name) });
      have.push(name);
      added++;
    } catch (e) {
      if (e?.code !== 11000) throw e; // lost a race to an identical name: fine
    }
  }
  return added;
};

export const migrateAcademicOwnership = async ({
  DepartmentModel = Department, ShiftModel = Shift, StudentModel = Student,
  SubjectModel = Subject, UserModel = User, CollegeModel = College,
} = {}) => {
  const result = { indexesDropped: 0, subjects: 0, students: 0, departments: 0, shifts: 0, changed: 0 };

  // 1. Indexes first, so per-college rows can coexist from here on.
  const idx = await migrateAcademicIndexes({
    departments: DepartmentModel, shifts: ShiftModel, students: StudentModel, subjects: SubjectModel,
  });
  result.indexesDropped = idx.dropped.length;

  // 2. Ownership of subjects and students.
  const byCollege = await usersByCollege(UserModel);
  result.subjects = await stampOwnedRows(SubjectModel, "teacher", byCollege);
  result.students = await stampOwnedRows(StudentModel, "uploadedBy", byCollege);

  // 3. Departments and shifts per college.
  const colleges = await CollegeModel.find({}).select("collegeId").lean();
  const legacyDepts = await scopedModel(DepartmentModel, { collegeId: null }).find({}).sort({ name: 1 }).lean();
  const legacyShifts = await scopedModel(ShiftModel, { collegeId: null }).find({}).sort({ order: 1, name: 1 }).lean();

  for (const { collegeId } of colleges) {
    const tenant = { collegeId };
    const depts = scopedModel(DepartmentModel, tenant);
    const shifts = scopedModel(ShiftModel, tenant);

    if (legacyDepts.length && (await depts.countDocuments()) === 0) {
      result.departments += await addMissingNames(DepartmentModel, tenant, legacyDepts.map((d) => d.name));
    }
    if (legacyShifts.length && (await shifts.countDocuments()) === 0) {
      const order = new Map(legacyShifts.map((s) => [s.name, s.order ?? 0]));
      result.shifts += await addMissingNames(ShiftModel, tenant, legacyShifts.map((s) => s.name), (n) => ({ order: order.get(n) ?? 0 }));
    }

    // Names the college's own subjects already use must exist in its lists.
    // (Subjects were validated against these lists when created.)
    const subjects = scopedModel(SubjectModel, tenant);
    const [subjDepts, subjShifts, studShifts] = await Promise.all([
      subjects.distinct("department"),
      subjects.distinct("shift"),
      scopedModel(StudentModel, tenant).distinct("shift"),
    ]);
    result.departments += await addMissingNames(DepartmentModel, tenant, subjDepts);
    result.shifts += await addMissingNames(ShiftModel, tenant, [...subjShifts, ...studShifts]);
  }

  result.changed = result.indexesDropped + result.subjects + result.students + result.departments + result.shifts;
  return result;
};
