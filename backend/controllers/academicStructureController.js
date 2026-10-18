/**
 * controllers/academicStructureController.js
 *
 * Admin — Academic Structure ("master overview of the institution's
 * academic hierarchy").
 *
 * ── Concept ──────────────────────────────────────────────────────────────
 * There is NO separate "Class" model in this system. A "class" is simply
 * the combination of Department + Batch + Shift — the same grouping that
 * Student and Subject documents already carry as plain string fields (see
 * models/Student.js and models/Subject.js). This controller reconstructs
 * that hierarchy on the fly:
 *
 *   Department
 *     └── Batch
 *           └── Shift  →  { totalStudents, assignedSubjects, assignedTeachers, lastUpdated }
 *
 * ── Design notes ───────────────────────────────────────────────────────────
 * - Departments come from the admin-managed Department collection (so a
 *   freshly-created department with no data yet still shows up in the
 *   hierarchy, with an empty batch list). Batches and Shifts are derived
 *   entirely from actual Student/Subject records — there is no "batch"
 *   collection (batches only exist once real data references them, per the
 *   existing Batch System Fix in studentController.js).
 * - Two `$group` aggregations (one over Student, one over Subject) collect
 *   per-department+batch+shift stats in two DB round trips total, rather
 *   than one query per group — this is the same pattern already used in
 *   teacherPerformanceController.js and subjectAnalyticsController.js, and
 *   is what keeps this efficient as the number of students/subjects grows.
 * - "Assigned Teachers" is the number of *distinct* teachers with at least
 *   one (non-archived) subject in that exact department+batch+shift group.
 * - "Last Updated" is the most recent `updatedAt` across every Student or
 *   Subject document in that group (or in its children, for Batch/Department
 *   rollups) — i.e. the last time anything about that group actually changed.
 * - COLLEGE SCOPING (Part 9): every collection read below goes through
 *   scopedModel(…, tenant) (aggregations get the tenant `$match` as their first
 *   stage), so the hierarchy, its counts and the summary only ever describe the
 *   authenticated admin's own college. Two colleges with identical department
 *   names, batch numbers and shifts get two completely separate trees.
 * - Department name matching against Student/Subject records is done
 *   case-insensitively (trimmed + lowercased key) purely for grouping under
 *   the correct canonical department node — it does not mutate any data.
 */
import Department from "../models/Department.js";
import Shift from "../models/Shift.js";
import Student from "../models/Student.js";
import Subject from "../models/Subject.js";
import User from "../models/User.js";
import { sendSuccess } from "../utils/response.js";
import { scopedModel } from "../utils/tenantScope.js";
import { analyticsCache } from "../utils/analyticsCache.js";

const normKey = (s) => String(s || "").trim().toLowerCase();

// ─────────────────────────────────────────────────────────────────────────────
// Core: build the full Department → Batch → Shift hierarchy (unfiltered).
// Shared by both the tree endpoint and the summary endpoint.
// ─────────────────────────────────────────────────────────────────────────────
async function buildAcademicStructureData(tenant) {
  const [deptDocs, shiftDocs, studentAgg, subjectAgg] = await Promise.all([
    scopedModel(Department, tenant).find({}).lean(),
    scopedModel(Shift, tenant).find({}).lean(),
    scopedModel(Student, tenant).aggregate([
      { $match: { isActive: true } },
      {
        $group: {
          _id: { department: "$department", batch: "$batch", shift: "$shift" },
          totalStudents: { $sum: 1 },
          lastUpdated: { $max: "$updatedAt" },
        },
      },
    ]),
    scopedModel(Subject, tenant).aggregate([
      { $match: { isArchived: false } },
      {
        $group: {
          _id: { department: "$department", batch: "$batch", shift: "$shift" },
          totalSubjects: { $sum: 1 },
          teacherIds: { $addToSet: "$teacher" },
          lastUpdated: { $max: "$updatedAt" },
        },
      },
    ]),
  ]);

  // ── Canonical department list (admin-managed) ──────────────────────────
  const deptCanonical = new Map(); // normKey(name) -> { id, name }
  for (const d of deptDocs) deptCanonical.set(normKey(d.name), { id: d._id, name: d.name });

  // ── Shift display order (admin-managed) ─────────────────────────────────
  const shiftOrder = new Map(shiftDocs.map((s) => [s.name, s.order ?? 0]));

  // ── Resolve teacher names in one query (no N+1) ─────────────────────────
  const teacherIdSet = new Set();
  for (const row of subjectAgg) {
    for (const id of row.teacherIds) teacherIdSet.add(String(id));
  }
  const teacherDocs = teacherIdSet.size
    // Teachers of this college's subjects; the college filter is belt and braces.
    ? await scopedModel(User, tenant).find({ _id: { $in: [...teacherIdSet] } }).select("name email").lean()
    : [];
  const teacherById = new Map(teacherDocs.map((t) => [String(t._id), t]));

  // ── Merge student + subject stats into one map keyed by dept|batch|shift ─
  const groups = new Map();
  const getGroup = (deptRaw, batch, shift) => {
    const deptKey = normKey(deptRaw);
    const key = `${deptKey}|||${batch}|||${shift}`;
    if (!groups.has(key)) {
      groups.set(key, {
        deptKey,
        deptRaw,
        batch,
        shift,
        totalStudents: 0,
        totalSubjects: 0,
        teacherIds: new Set(),
        lastUpdated: null,
      });
    }
    return groups.get(key);
  };
  const bumpLastUpdated = (g, date) => {
    if (date && (!g.lastUpdated || date > g.lastUpdated)) g.lastUpdated = date;
  };

  for (const row of studentAgg) {
    const g = getGroup(row._id.department, row._id.batch, row._id.shift);
    g.totalStudents = row.totalStudents;
    bumpLastUpdated(g, row.lastUpdated);
  }
  for (const row of subjectAgg) {
    const g = getGroup(row._id.department, row._id.batch, row._id.shift);
    g.totalSubjects = row.totalSubjects;
    for (const id of row.teacherIds) g.teacherIds.add(String(id));
    bumpLastUpdated(g, row.lastUpdated);
  }

  // ── Build Department → Batch → Shift tree ───────────────────────────────
  const deptTree = new Map(); // deptKey -> { name, id, batches: Map<batch, Map<shift, group>> }

  // Seed every canonical department so ones with no data yet still appear.
  for (const [key, info] of deptCanonical) {
    deptTree.set(key, { name: info.name, id: info.id, batches: new Map() });
  }
  // Fold in any group whose department string doesn't (yet) match a
  // canonical Department doc — shown under its own name rather than dropped.
  for (const g of groups.values()) {
    if (!deptTree.has(g.deptKey)) {
      deptTree.set(g.deptKey, { name: g.deptRaw, id: null, batches: new Map() });
    }
    const deptNode = deptTree.get(g.deptKey);
    if (!deptNode.batches.has(g.batch)) deptNode.batches.set(g.batch, new Map());
    deptNode.batches.get(g.batch).set(g.shift, g);
  }

  const departments = [];
  for (const deptNode of deptTree.values()) {
    const batches = [];
    for (const [batchName, shiftMap] of deptNode.batches) {
      const shifts = [...shiftMap.values()]
        .map((g) => ({
          shift: g.shift,
          totalStudents: g.totalStudents,
          totalSubjects: g.totalSubjects,
          totalTeachers: g.teacherIds.size,
          teachers: [...g.teacherIds]
            .map((id) => teacherById.get(id))
            .filter(Boolean)
            .map((t) => ({ id: t._id, name: t.name })),
          lastUpdated: g.lastUpdated,
        }))
        .sort(
          (a, b) =>
            (shiftOrder.get(a.shift) ?? 0) - (shiftOrder.get(b.shift) ?? 0) ||
            a.shift.localeCompare(b.shift)
        );

      const batchTeacherSet = new Set();
      let batchLastUpdated = null;
      for (const s of shifts) {
        for (const t of s.teachers) batchTeacherSet.add(String(t.id));
        if (s.lastUpdated && (!batchLastUpdated || s.lastUpdated > batchLastUpdated)) {
          batchLastUpdated = s.lastUpdated;
        }
      }

      batches.push({
        batch: batchName,
        totalStudents: shifts.reduce((sum, s) => sum + s.totalStudents, 0),
        totalSubjects: shifts.reduce((sum, s) => sum + s.totalSubjects, 0),
        totalTeachers: batchTeacherSet.size,
        totalShifts: shifts.length,
        lastUpdated: batchLastUpdated,
        shifts,
      });
    }
    batches.sort((a, b) => a.batch.localeCompare(b.batch, undefined, { numeric: true }));

    const deptTeacherSet = new Set();
    let deptLastUpdated = null;
    for (const b of batches) {
      for (const s of b.shifts) {
        for (const t of s.teachers) deptTeacherSet.add(String(t.id));
      }
      if (b.lastUpdated && (!deptLastUpdated || b.lastUpdated > deptLastUpdated)) {
        deptLastUpdated = b.lastUpdated;
      }
    }

    departments.push({
      departmentId: deptNode.id,
      department: deptNode.name,
      totalBatches: batches.length,
      totalShiftGroups: batches.reduce((sum, b) => sum + b.totalShifts, 0),
      totalStudents: batches.reduce((sum, b) => sum + b.totalStudents, 0),
      totalSubjects: batches.reduce((sum, b) => sum + b.totalSubjects, 0),
      totalTeachers: deptTeacherSet.size,
      lastUpdated: deptLastUpdated,
      batches,
    });
  }
  departments.sort((a, b) => a.department.localeCompare(b.department));

  return departments;
}

// Tree and summary are built from the same dataset; cache it per college for a
// few seconds (callers copy before changing anything).
const cachedStructure = (tenant) =>
  analyticsCache.get(tenant, "academic-structure", () => buildAcademicStructureData(tenant));

// ─── GET /api/admin/academic-structure ─────────────────────────────────────────
// Paginated (over top-level departments), searchable Department → Batch →
// Shift hierarchy. Search matches a department, batch, or shift name; if a
// department name itself matches, its full subtree is returned, otherwise
// only the matching batches/shifts (and their ancestor department) are kept.
export const getAcademicStructure = async (req, res, next) => {
  try {
    const { search = "", department = "", page = 1, limit = 10 } = req.query;

    let departments = [...(await cachedStructure(req.tenant))];

    if (department) {
      const dq = String(department).trim().toLowerCase();
      departments = departments.filter((d) => d.department.toLowerCase() === dq);
    }

    if (search) {
      const q = String(search).trim().toLowerCase();
      departments = departments
        .map((d) => {
          if (d.department.toLowerCase().includes(q)) return d; // whole subtree matches

          const filteredBatches = d.batches
            .map((b) => {
              const batchMatches =
                b.batch.toLowerCase().includes(q) || `batch ${b.batch}`.toLowerCase().includes(q);
              if (batchMatches) return b; // whole batch matches, keep all its shifts

              const filteredShifts = b.shifts.filter((s) => s.shift.toLowerCase().includes(q));
              if (filteredShifts.length === 0) return null;
              return { ...b, shifts: filteredShifts };
            })
            .filter(Boolean);

          if (filteredBatches.length === 0) return null;
          return { ...d, batches: filteredBatches };
        })
        .filter(Boolean);
    }

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.max(1, Math.min(50, parseInt(limit, 10) || 10));
    const total = departments.length;
    const totalPages = Math.max(1, Math.ceil(total / limitNum));
    const start = (pageNum - 1) * limitNum;
    const paginated = departments.slice(start, start + limitNum);

    return sendSuccess(res, {
      departments: paginated,
      pagination: { page: pageNum, limit: limitNum, total, totalPages },
    });
  } catch (error) {
    next(error);
  }
};

// ─── GET /api/admin/academic-structure/summary ─────────────────────────────────
// Headline stats for the top of the page — computed from the same
// unfiltered dataset, independent of the search/pagination applied above.
export const getAcademicStructureSummary = async (req, res, next) => {
  try {
    const departments = await cachedStructure(req.tenant);

    let totalBatches = 0;
    let totalShiftGroups = 0;
    let totalStudents = 0;
    let totalSubjects = 0;
    let departmentsWithoutData = 0;
    let lastUpdated = null;
    const teacherSet = new Set();

    for (const d of departments) {
      totalBatches += d.totalBatches;
      totalShiftGroups += d.totalShiftGroups;
      totalStudents += d.totalStudents;
      totalSubjects += d.totalSubjects;
      if (d.totalBatches === 0) departmentsWithoutData += 1;
      if (d.lastUpdated && (!lastUpdated || d.lastUpdated > lastUpdated)) lastUpdated = d.lastUpdated;
      for (const b of d.batches) {
        for (const s of b.shifts) {
          for (const t of s.teachers) teacherSet.add(String(t.id));
        }
      }
    }

    return sendSuccess(res, {
      totalDepartments: departments.length,
      totalBatches,
      totalShiftGroups,
      totalStudents,
      totalSubjects,
      totalTeachersAssigned: teacherSet.size,
      departmentsWithoutData,
      lastUpdated,
    });
  } catch (error) {
    next(error);
  }
};
