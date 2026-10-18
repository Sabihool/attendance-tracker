/**
 * Per-college default attendance categories (Part 12).
 *
 * Before Part 12 the app seeded ONE global list ("if the collection is empty").
 * Categories — and their credit values — now belong to a college, so each college
 * gets its own copy: at registration, and (idempotently) at start-up for colleges
 * that have none yet. Admins of that college can then edit, add or delete them
 * without affecting any other college.
 */
import AttendanceCategory from "../models/AttendanceCategory.js";
import College from "../models/College.js";
import User from "../models/User.js";
import { scopedModel } from "../utils/tenantScope.js";

// Theory = 1, Lab = 3, Tutorial = 2 — the existing default credit rules (unchanged).
export const DEFAULT_CATEGORIES = Object.freeze([
  Object.freeze({ name: "Theory", credit: 1 }),
  Object.freeze({ name: "Lab", credit: 3 }),
  Object.freeze({ name: "Tutorial", credit: 2 }),
]);

/**
 * Give one college its default categories, but only if it has none. Safe to call
 * repeatedly; never touches another college.
 * @returns {Promise<number>} how many were created
 */
export const seedCollegeCategories = async (collegeId, { CategoryModel = AttendanceCategory } = {}) => {
  const cats = scopedModel(CategoryModel, { collegeId });
  if ((await cats.countDocuments()) > 0) return 0;
  let made = 0;
  for (const c of DEFAULT_CATEGORIES) {
    try {
      await cats.create({ name: c.name, credit: c.credit, isDefault: true });
      made++;
    } catch (e) {
      if (e?.code !== 11000) throw e; // lost a race to an identical name: fine
    }
  }
  return made;
};

/**
 * Start-up: make sure every active college has categories (idempotent). The "no
 * college" scope (collegeId: null — legacy single-college data) is only seeded on
 * a fresh install with no colleges, or when college-less users exist, so a normal
 * multi-college database never grows orphan rows.
 */
export const seedAllCategories = async (
  { CategoryModel = AttendanceCategory, CollegeModel = College, UserModel = User } = {}
) => {
  try {
    const colleges = await CollegeModel.find({ status: "active" }).select("collegeId").lean();
    const scopes = colleges.map((c) => c.collegeId);
    const fresh = colleges.length === 0 && (await CategoryModel.estimatedDocumentCount()) === 0;
    if (fresh || (await UserModel.exists({ collegeId: null }))) scopes.push(null);

    let made = 0;
    for (const collegeId of scopes) made += await seedCollegeCategories(collegeId, { CategoryModel });
    if (made) console.log(`✅ Default attendance categories seeded (${made})`);
    return made;
  } catch (err) {
    console.error("❌ Failed to seed attendance categories:", err.message);
    return 0;
  }
};
