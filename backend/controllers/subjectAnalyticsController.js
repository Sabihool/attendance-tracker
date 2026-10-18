/**
 * controllers/subjectAnalyticsController.js
 *
 * Admin — Subject Analytics ("All Subjects") dashboard.
 *
 * Lists every subject created by every teacher with computed stats:
 * total classes taken, total students, and overall attendance percentage.
 * Session-by-session detail (trend, present/absent per session, per-student
 * percentage list, PDF export) is intentionally NOT duplicated here — the
 * existing /api/attendance/:subjectId/dates, /percentage, and
 * /api/export/:subjectId/pdf endpoints already work for admins (they bypass
 * the ownership check in requireSubjectOwner), so the frontend subject-detail
 * view reuses those directly instead of a parallel admin-only copy.
 *
 * ── Design notes ──────────────────────────────────────────────────────────
 * - "Overall Attendance %" is the weighted average across all of a subject's
 *   sessions: (sum of presentCount) / (sum of totalStudents) × 100 — see the
 *   same rationale in teacherPerformanceController.js.
 * - "Subject Type" (Theory / Lab / Tutorial): attendance categories are now
 *   chosen per-session, not once at subject creation (a single subject can
 *   mix Theory and Lab sessions — see Subject model comments). So "the"
 *   subject type shown here is the category used most often across its
 *   sessions, falling back to the legacy `creditType` field for subjects
 *   with zero sessions yet, or "—" if neither is available.
 * - "Total Students" mirrors the Teacher Performance page: active students
 *   in the subject's own department+batch+shift group.
 */
import Subject from "../models/Subject.js";
import Attendance from "../models/Attendance.js";
import Student from "../models/Student.js";
import { scopedModel } from "../utils/tenantScope.js";
import { populateTeacher } from "../utils/subjectAssignment.js";
import { analyticsCache } from "../utils/analyticsCache.js";
import { findOwnedTeacher } from "../utils/analyticsScope.js";
import { sendSuccess, sendError } from "../utils/response.js";
import { pickOwn } from "../utils/safeKey.js";

// COLLEGE SCOPING (Parts 9 + 12): subjects, student counts and attendance are
// all read through scopedModel / scopedAggregate(…, tenant); attendance carries
// its own collegeId, so these totals can never include another college's sessions.

const groupKey = (department, batch, shift) => `${department}|||${batch}|||${shift}`;

async function buildSubjectAnalyticsData(tenant, { includeArchived = false } = {}) {
  const filter = includeArchived ? {} : { isArchived: false };
  const subjects = await scopedModel(Subject, tenant).find(filter).populate(populateTeacher(tenant, "name email")).lean();

  if (subjects.length === 0) return [];

  // ── Attendance sessions grouped by subject (exclude trashed) ───────────
  // ONE aggregation, grouped by (subject, session type), feeds both the
  // per-subject totals and the "most-used session type". (It used to be two
  // scans of the same sessions.) Totals are sums/max of the per-type groups, so
  // every number is identical to the old two-pass result. The tenant $match is
  // forced in front by scopedModel(...).aggregate, before the $group.
  const subjectIds = subjects.map((s) => s._id);
  const attendanceAgg = await scopedModel(Attendance, tenant).aggregate([
    { $match: { isDeleted: false, subjectId: { $in: subjectIds } } },
    {
      $group: {
        _id: { subjectId: "$subjectId", classType: "$classType" },
        sessions: { $sum: 1 },
        lastSessionDate: { $max: "$date" },
        totalPresent: { $sum: "$summary.presentCount" },
        totalRecords: { $sum: "$summary.totalStudents" },
      },
    },
  ]);

  const attendanceBySubject = new Map();
  const topTypeBySubject = new Map();
  for (const row of attendanceAgg) {
    const key = String(row._id.subjectId);
    const total = attendanceBySubject.get(key) || { totalSessions: 0, lastSessionDate: null, totalPresent: 0, totalRecords: 0 };
    total.totalSessions += row.sessions;
    total.totalPresent += row.totalPresent;
    total.totalRecords += row.totalRecords;
    if (row.lastSessionDate && (!total.lastSessionDate || row.lastSessionDate > total.lastSessionDate)) {
      total.lastSessionDate = row.lastSessionDate;
    }
    attendanceBySubject.set(key, total);

    const existing = topTypeBySubject.get(key);
    if (!existing || row.sessions > existing.count) {
      topTypeBySubject.set(key, { classType: row._id.classType, count: row.sessions });
    }
  }

  // ── Active student counts per department+batch+shift group (global) ───
  const studentAgg = await scopedModel(Student, tenant).aggregate([
    { $match: { isActive: true } },
    {
      $group: {
        _id: { department: "$department", batch: "$batch", shift: "$shift" },
        count: { $sum: 1 },
      },
    },
  ]);
  const studentCountByGroup = new Map(
    studentAgg.map((g) => [groupKey(g._id.department, g._id.batch, g._id.shift), g.count])
  );

  return subjects.map((s) => {
    const id = String(s._id);
    const att = attendanceBySubject.get(id);

    const totalClasses = att?.totalSessions || 0;
    const attendancePercentage =
      att && att.totalRecords > 0 ? Math.round((att.totalPresent / att.totalRecords) * 1000) / 10 : 0;

    const subjectType = topTypeBySubject.get(id)?.classType || s.creditType || "—";
    const totalStudents = studentCountByGroup.get(groupKey(s.department, s.batch, s.shift)) || 0;

    return {
      subjectId: s._id,
      subjectName: s.subjectName,
      subjectCode: s.subjectCode,
      teacherName: s.teacher?.name || "—",
      teacherId: s.teacher?._id,
      department: s.department,
      batch: s.batch,
      shift: s.shift,
      subjectType,
      totalClasses,
      totalStudents,
      attendancePercentage,
      lastSessionDate: att?.lastSessionDate || null,
      createdAt: s.createdAt,
      isArchived: s.isArchived,
    };
  });
}

// ─── GET /api/admin/subjects ───────────────────────────────────────────────────
export const getAllSubjectsAnalytics = async (req, res, next) => {
  try {
    const {
      search = "",
      department = "",
      batch = "",
      subjectType = "",
      sortBy = "recent", // attendance | classes | recent | name | students
      sortOrder = "desc",
      page = 1,
      limit = 12,
      archived = "false",
    } = req.query;

    const includeArchived = archived === "all" || archived === "true";
    // The dataset is cached per college for a few seconds (utils/analyticsCache.js);
    // copy it before sorting so the cached array is never mutated.
    let rows = [...(await analyticsCache.get(
      req.tenant,
      "subject-analytics",
      () => buildSubjectAnalyticsData(req.tenant, { includeArchived }),
      `archived=${includeArchived}`
    ))];

    if (archived === "true") rows = rows.filter((r) => r.isArchived);

    // Optional drill-down: one teacher's subjects. The teacher must belong to the
    // caller's college — a foreign, unknown or malformed id is the same 404.
    if (req.query.teacherId !== undefined) {
      const teacher = await findOwnedTeacher(req.tenant, req.query.teacherId);
      if (!teacher) return sendError(res, "Teacher not found.", 404);
      rows = rows.filter((r) => String(r.teacherId) === String(teacher._id));
    }

    if (department) rows = rows.filter((r) => r.department.toLowerCase() === String(department).toLowerCase());
    if (batch) rows = rows.filter((r) => String(r.batch).toLowerCase() === String(batch).toLowerCase());
    if (subjectType) rows = rows.filter((r) => r.subjectType.toLowerCase() === String(subjectType).toLowerCase());
    if (search) {
      const q = String(search).trim().toLowerCase();
      rows = rows.filter(
        (r) =>
          r.subjectName.toLowerCase().includes(q) ||
          r.subjectCode.toLowerCase().includes(q) ||
          r.teacherName.toLowerCase().includes(q)
      );
    }

    const dir = sortOrder === "asc" ? 1 : -1;
    const sorters = {
      attendance: (a, b) => (a.attendancePercentage - b.attendancePercentage) * dir,
      classes: (a, b) => (a.totalClasses - b.totalClasses) * dir,
      students: (a, b) => (a.totalStudents - b.totalStudents) * dir,
      recent: (a, b) => (new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()) * dir,
      name: (a, b) => a.subjectName.localeCompare(b.subjectName) * dir,
    };
    rows.sort(pickOwn(sorters, sortBy, sorters.recent));

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.max(1, Math.min(100, parseInt(limit, 10) || 12));
    const total = rows.length;
    const totalPages = Math.max(1, Math.ceil(total / limitNum));
    const start = (pageNum - 1) * limitNum;
    const paginated = rows.slice(start, start + limitNum);

    return sendSuccess(res, {
      subjects: paginated,
      pagination: { page: pageNum, limit: limitNum, total, totalPages },
    });
  } catch (error) {
    next(error);
  }
};

// ─── GET /api/admin/subjects/meta ──────────────────────────────────────────────
// Distinct batches and subject types actually in use — for filter dropdowns.
// (Departments already come from the existing /api/departments endpoint.)
export const getSubjectAnalyticsMeta = async (req, res, next) => {
  try {
    const ownSubjects = scopedModel(Subject, req.tenant);
    const [batches, subjectTypes] = await Promise.all([
      ownSubjects.distinct("batch", { isArchived: false }),
      scopedModel(Attendance, req.tenant).distinct("classType", { isDeleted: false }),
    ]);
    batches.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    return sendSuccess(res, { batches, subjectTypes: subjectTypes.filter(Boolean).sort() });
  } catch (error) {
    next(error);
  }
};
