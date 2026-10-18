/**
 * Per-college default departments and shifts.
 *
 * Before Part 9 the app seeded ONE global list ("if the collection is empty")
 * at start-up. Departments and shifts now belong to a college, so each college
 * gets its own copy: at registration, and (idempotently) at start-up for
 * colleges that have none yet.
 */
import Department from "../models/Department.js";
import Shift from "../models/Shift.js";
import College from "../models/College.js";
import User from "../models/User.js";
import { scopedModel } from "../utils/tenantScope.js";

export const DEFAULT_DEPARTMENTS = ["Computer Science and Technology", "Telecommunication Technology"];
export const DEFAULT_SHIFTS = ["Morning", "Day", "Evening"];

/**
 * Give one college its default departments / shifts, but only for the kinds it
 * has none of. Safe to call repeatedly. Never touches another college.
 * @returns {Promise<{departments:number, shifts:number}>} how many were created
 */
export const seedCollegeDefaults = async (collegeId, { DepartmentModel = Department, ShiftModel = Shift } = {}) => {
  const tenant = { collegeId };
  const depts = scopedModel(DepartmentModel, tenant);
  const shifts = scopedModel(ShiftModel, tenant);
  const out = { departments: 0, shifts: 0 };

  if ((await depts.countDocuments()) === 0) {
    for (const name of DEFAULT_DEPARTMENTS) {
      try { await depts.create({ name }); out.departments++; } catch (e) { if (e?.code !== 11000) throw e; }
    }
  }
  if ((await shifts.countDocuments()) === 0) {
    for (let i = 0; i < DEFAULT_SHIFTS.length; i++) {
      try { await shifts.create({ name: DEFAULT_SHIFTS[i], order: i }); out.shifts++; } catch (e) { if (e?.code !== 11000) throw e; }
    }
  }
  return out;
};

/**
 * Start-up: make sure every active college has departments/shifts (idempotent).
 * The "no college" scope (collegeId: null — legacy single-college data) is only
 * seeded on a fresh install with no colleges, or when college-less users exist,
 * so a normal multi-college database never grows orphan rows.
 */
export const seedAcademicDefaults = async (
  { DepartmentModel = Department, ShiftModel = Shift, CollegeModel = College, UserModel = User } = {}
) => {
  try {
    const colleges = await CollegeModel.find({ status: "active" }).select("collegeId").lean();
    const scopes = colleges.map((c) => c.collegeId);
    const fresh = colleges.length === 0 && (await DepartmentModel.estimatedDocumentCount()) === 0;
    if (fresh || (await UserModel.exists({ collegeId: null }))) scopes.push(null);

    let made = 0;
    for (const collegeId of scopes) {
      const r = await seedCollegeDefaults(collegeId, { DepartmentModel, ShiftModel });
      made += r.departments + r.shifts;
    }
    if (made) console.log(`✅ Default departments/shifts seeded (${made})`);
    return made;
  } catch (err) {
    console.error("❌ Failed to seed departments/shifts:", err.message);
    return 0;
  }
};
