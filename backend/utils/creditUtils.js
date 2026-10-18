import AttendanceCategory from "../models/AttendanceCategory.js";
import { scopedModel } from "./tenantScope.js";

// COLLEGE SCOPING (Part 12): categories (and their credit values) belong to a
// college. Every function that reads them takes the caller's `tenant` first
// (req.tenant) and goes through scopedModel, so a college can never see, match
// or be graded by another college's categories. The pure calculation helpers
// below (normalizeCategoryName, resolveCategoryCredit, calculateCreditScore,
// resolveCreditValue) are unchanged: the credit rules themselves are not
// tenant-specific, only the configuration they are fed.
const categories = (tenant) => scopedModel(AttendanceCategory, tenant);

// ─── Case-insensitive category lookup (inside the tenant's college) ───────────
export const findCategoryByName = async (tenant, name) => {
  if (!name) return null;
  return categories(tenant).findOne({
    name: { $regex: `^${escapeRegex(String(name).trim())}$`, $options: "i" },
  });
};

// ─── Escape a string for safe use inside a RegExp ─────────────────────────────
const escapeRegex = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ─── Normalize a category / class-type name for grouping & lookups ────────────
// This is the SINGLE source of truth for turning "Lab", "lab", "LAB ",
// " Theory", "TUTORIAL", etc. into one consistent key ("lab", "theory",
// "tutorial"). Every place that groups attendance records by category
// (credit score calculation, credit maps, dropdown de-duplication, etc.)
// MUST run names through this function before using them as a Map/object
// key — otherwise casing differences will silently create duplicate groups.
export const normalizeCategoryName = (name) =>
  String(name ?? "").trim().toLowerCase();

// ─── Hardcoded fallback credit values ──────────────────────────────────────────
// Only used when a category can't be resolved from the admin-managed
// AttendanceCategory collection at all (e.g. legacy/orphaned records). Per the
// spec: Theory = 1, Lab = 3, Tutorial = 2 (configurable). Any category found
// in the database always takes precedence over these.
export const DEFAULT_CREDIT_BY_TYPE = {
  theory: 1,
  lab: 3,
  tutorial: 2,
};

// ─── Build a { normalizedCategoryName: credit } map for fast lookups ─────────
// Used wherever we previously imported the hardcoded CLASS_WEIGHTS constant.
// Falls back gracefully: callers should still use `?? 1` when reading from
// this map in case a record references a category that has since been
// renamed or removed.
export const getCategoryCreditMap = async (tenant) => {
  const { creditMap } = await getCategoryMaps(tenant);
  return creditMap;
};

// ─── Build both a credit map AND a display-name map, keyed by normalized name ─
// The display-name map lets callers render the admin's actual configured
// category name (e.g. "Lab") instead of guessing a capitalization, while
// still grouping strictly by the normalized key under the hood.
export const getCategoryMaps = async (tenant) => {
  const rows = await categories(tenant).find({}, { lean: true });
  const creditMap = {};
  const nameMap = {};
  for (const c of rows) {
    const normalized = normalizeCategoryName(c.name);
    if (!normalized) continue;
    creditMap[normalized] = c.credit;
    nameMap[normalized] = c.name;
  }
  return { creditMap, nameMap };
};

// ─── Resolve the credit value for a normalized category name ─────────────────
// Priority: admin-configured value (creditMap) > known default for the type
// (Theory/Lab/Tutorial) > 1 as an absolute last resort.
export const resolveCategoryCredit = (normalizedName, creditMap = {}) => {
  if (
    creditMap[normalizedName] !== undefined &&
    creditMap[normalizedName] !== null
  ) {
    return creditMap[normalizedName];
  }
  if (DEFAULT_CREDIT_BY_TYPE[normalizedName] !== undefined) {
    return DEFAULT_CREDIT_BY_TYPE[normalizedName];
  }
  return 1;
};

const titleCase = (str) =>
  str.length ? str.charAt(0).toUpperCase() + str.slice(1) : str;

// ─── Single source of truth for the "Credit Score" calculation ───────────────
// Used by admin analytics, student profile, and any statistics page so the
// number shown is always computed the exact same way, everywhere.
//
// Rules (per spec):
//   1. Only attended ("present") records count — absences are ignored.
//   2. Category names are normalized (trim + lowercase) before grouping, so
//      "Lab" / "lab" / "LAB" always collapse into a single group.
//   3. Credit value per group comes from the admin-configured
//      AttendanceCategory (via creditMap), falling back to the known
//      defaults (Theory=1, Lab=3, Tutorial=2) and finally to 1.
//   4. creditScore is always exactly the sum of the grouped breakdown's
//      pointsEarned — there is no separate/independent total to drift out
//      of sync.
//
// @param {Array} records - Attendance records (each with `students[]` and
//   `classType`) for a single student, e.g. from `Attendance.find(...)`.
// @param {String} studentId - The student's studentId to check attendance
//   status against inside each record's `students[]` array.
// @param {Object} [maps] - `{ creditMap, nameMap }` from getCategoryMaps().
// @returns {{ creditScore: number, breakdown: Array }}
export const calculateCreditScore = (records = [], studentId, maps = {}) => {
  const { creditMap = {}, nameMap = {} } = maps;

  if (!studentId) {
    console.warn("[creditUtils] calculateCreditScore called without a studentId");
    return { creditScore: 0, breakdown: [] };
  }

  // Step 1 + 2: collect attended classes only, normalizing the category name.
  const groups = new Map(); // normalizedName -> { attendedClasses }

  for (const record of records) {
    const studentEntry = record?.students?.find((s) => s.studentId === studentId);
    if (!studentEntry || studentEntry.status !== "present") continue; // ignore absent/missed

    const normalized = normalizeCategoryName(record?.classType);
    if (!normalized) {
      console.warn("[creditUtils] Skipping attendance record with no classType", record?._id);
      continue;
    }

    if (!groups.has(normalized)) {
      groups.set(normalized, { attendedClasses: 0 });
    }
    groups.get(normalized).attendedClasses += 1;
  }

  // Step 3 + 4: resolve credit value per group and compute points.
  const breakdown = Array.from(groups.entries())
    .map(([normalized, g]) => {
      const creditValue = resolveCategoryCredit(normalized, creditMap);
      const category = nameMap[normalized] || titleCase(normalized);
      return {
        category,
        creditValue,
        attendedClasses: g.attendedClasses,
        pointsEarned: g.attendedClasses * creditValue,
      };
    })
    .sort((a, b) => b.pointsEarned - a.pointsEarned);

  const creditScore = breakdown.reduce((sum, c) => sum + c.pointsEarned, 0);

  return { creditScore: Math.round(creditScore * 100) / 100, breakdown };
};

// ─── Get all category names (for validation error messages, dropdowns, etc.) ──
export const getCategoryNames = async (tenant) => {
  const rows = await categories(tenant).find({}).sort({ name: 1 }).lean();
  return rows.map((c) => c.name);
};

// ─── Resolve the credit value to use for a new attendance session ────────────
// If the teacher supplied an explicit override, honor it (still validated as
// a non-negative number by the caller). Otherwise fall back to the category's
// configured credit value, or 1 if the category can't be found.
export const resolveCreditValue = (category, override) => {
  if (override !== undefined && override !== null && override !== "") {
    const n = Number(override);
    return Number.isNaN(n) ? category?.credit ?? 1 : n;
  }
  return category?.credit ?? 1;
};
