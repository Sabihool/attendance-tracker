/**
 * controllers/teacherPerformanceController.js
 *
 * Admin — Teacher Performance Dashboard.
 *
 * Lets the admin see how actively every teacher is using the system:
 * subjects created, attendance sessions taken, students managed, average
 * attendance percentage across their subjects, last activity date, and
 * account status — plus headline stats (most/least active, most subjects,
 * teachers who have gone quiet).
 *
 * ── Design notes ──────────────────────────────────────────────────────────
 * - The heavy joins (subjects-by-teacher, attendance-by-teacher, and
 *   students-per-department/batch/shift-group) are each done with a single
 *   MongoDB aggregation, so this scales with the number of *distinct*
 *   groups/teachers rather than doing a query per teacher.
 * - "Total Students Managed" counts active students in every distinct
 *   department+batch+shift group the teacher has at least one subject in
 *   (there's no direct Subject → Student link in this schema, so group
 *   membership is the closest available signal).
 * - "Average Attendance %" is a weighted average across all of a teacher's
 *   sessions: (sum of presentCount) / (sum of totalStudents) × 100. This
 *   naturally weights larger classes/sessions more, rather than averaging
 *   per-subject percentages which would treat a 3-student subject the same
 *   as a 300-student one.
 * - "Account Status" maps to the existing User.approved flag — there's no
 *   separate enable/disable field in this system, and an unapproved teacher
 *   cannot use the system at all, so Active/Inactive == approved/not.
 */
import User from "../models/User.js";
import Subject from "../models/Subject.js";
import Attendance from "../models/Attendance.js";
import Student from "../models/Student.js";
import { sendSuccess } from "../utils/response.js";
import { pickOwn } from "../utils/safeKey.js";
import { scopedModel } from "../utils/tenantScope.js";
import { analyticsCache } from "../utils/analyticsCache.js";

// COLLEGE SCOPING (Parts 9 + 12): teachers, subjects, attendance sessions and
// student counts are all read through scopedModel(…, tenant), so this page lists only the admin's own
// college's teachers and counts only its own students/subjects — even when
// another college has the same department/batch/shift names.

const INACTIVE_THRESHOLD_DAYS = 14;
const groupKey = (department, batch, shift) => `${department}|||${batch}|||${shift}`;

// ─────────────────────────────────────────────────────────────────────────────
// Core: build the full performance dataset for every teacher (unfiltered).
// Shared by both the list endpoint and the summary endpoint.
// ─────────────────────────────────────────────────────────────────────────────
async function buildTeacherPerformanceData(tenant) {
  const teachers = await scopedModel(User, tenant).find({ role: "teacher" })
    .select("name email department phone approved createdAt")
    .lean();

  if (teachers.length === 0) return [];

  // ── Subjects grouped by teacher ─────────────────────────────────────────
  const subjectAgg = await scopedModel(Subject, tenant).aggregate([
    {
      $group: {
        _id: "$teacher",
        totalSubjects: { $sum: 1 },
        lastSubjectCreated: { $max: "$createdAt" },
        groups: { $addToSet: { department: "$department", batch: "$batch", shift: "$shift" } },
      },
    },
  ]);
  const subjectByTeacher = new Map(subjectAgg.map((s) => [String(s._id), s]));

  // ── Attendance sessions grouped by teacher (exclude trashed) ───────────
  const attendanceAgg = await scopedModel(Attendance, tenant).aggregate([
    { $match: { isDeleted: false, teacher: { $in: teachers.map((t) => t._id) } } },
    {
      $group: {
        _id: "$teacher",
        totalSessions: { $sum: 1 },
        lastAttendanceDate: { $max: "$date" },
        totalPresent: { $sum: "$summary.presentCount" },
        totalRecords: { $sum: "$summary.totalStudents" },
      },
    },
  ]);
  const attendanceByTeacher = new Map(attendanceAgg.map((a) => [String(a._id), a]));

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

  // ── Compose per-teacher performance rows ────────────────────────────────
  return teachers.map((t) => {
    const id = String(t._id);
    const subj = subjectByTeacher.get(id);
    const att = attendanceByTeacher.get(id);

    const totalSubjects = subj?.totalSubjects || 0;
    const totalSessions = att?.totalSessions || 0;
    const lastAttendanceDate = att?.lastAttendanceDate || null;

    const totalStudentsManaged = subj
      ? subj.groups.reduce(
          (sum, g) => sum + (studentCountByGroup.get(groupKey(g.department, g.batch, g.shift)) || 0),
          0
        )
      : 0;

    const avgAttendancePercentage =
      att && att.totalRecords > 0 ? Math.round((att.totalPresent / att.totalRecords) * 1000) / 10 : 0;

    const daysSinceLastAttendance =
      lastAttendanceDate != null
        ? Math.floor((Date.now() - new Date(lastAttendanceDate).getTime()) / 86400000)
        : null;

    return {
      teacherId: t._id,
      name: t.name,
      email: t.email,
      department: t.department || "—",
      totalSubjects,
      totalAttendanceSessions: totalSessions,
      totalStudentsManaged,
      avgAttendancePercentage,
      lastAttendanceDate,
      daysSinceLastAttendance,
      accountStatus: t.approved ? "Active" : "Inactive",
      joinedAt: t.createdAt,
    };
  });
}

const cachedPerformanceData = (tenant) =>
  analyticsCache.get(tenant, "teacher-performance", () => buildTeacherPerformanceData(tenant));

// ─── GET /api/admin/teacher-performance ───────────────────────────────────────
// Paginated, searchable, filterable, sortable list of teacher performance rows.
export const getTeacherPerformance = async (req, res, next) => {
  try {
    const {
      search = "",
      department = "",
      sortBy = "sessions", // sessions | subjects | recent | students | attendance | name
      sortOrder = "desc",
      page = 1,
      limit = 12,
    } = req.query;

    // List and summary share one cached dataset per college (a few seconds);
    // copy it before sorting so the cached array is never mutated.
    let rows = [...(await cachedPerformanceData(req.tenant))];

    if (department) {
      rows = rows.filter((r) => r.department.toLowerCase() === String(department).toLowerCase());
    }
    if (search) {
      const q = String(search).trim().toLowerCase();
      rows = rows.filter((r) => r.name.toLowerCase().includes(q) || r.email.toLowerCase().includes(q));
    }

    const dir = sortOrder === "asc" ? 1 : -1;
    const sorters = {
      sessions: (a, b) => (a.totalAttendanceSessions - b.totalAttendanceSessions) * dir,
      subjects: (a, b) => (a.totalSubjects - b.totalSubjects) * dir,
      students: (a, b) => (a.totalStudentsManaged - b.totalStudentsManaged) * dir,
      attendance: (a, b) => (a.avgAttendancePercentage - b.avgAttendancePercentage) * dir,
      recent: (a, b) => {
        const at = a.lastAttendanceDate ? new Date(a.lastAttendanceDate).getTime() : -Infinity;
        const bt = b.lastAttendanceDate ? new Date(b.lastAttendanceDate).getTime() : -Infinity;
        return (at - bt) * dir;
      },
      name: (a, b) => a.name.localeCompare(b.name) * dir,
    };
    rows.sort(pickOwn(sorters, sortBy, sorters.sessions));

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.max(1, Math.min(100, parseInt(limit, 10) || 12));
    const total = rows.length;
    const totalPages = Math.max(1, Math.ceil(total / limitNum));
    const start = (pageNum - 1) * limitNum;
    const paginated = rows.slice(start, start + limitNum);

    return sendSuccess(res, {
      teachers: paginated,
      pagination: { page: pageNum, limit: limitNum, total, totalPages },
    });
  } catch (error) {
    next(error);
  }
};

// ─── GET /api/admin/teacher-performance/departments ───────────────────────────
// Distinct list of departments that have at least one teacher — for the filter dropdown.
export const getTeacherDepartments = async (req, res, next) => {
  try {
    const departments = await scopedModel(User, req.tenant).distinct("department", { role: "teacher", department: { $nin: ["", null] } });
    return sendSuccess(res, { departments: departments.sort() });
  } catch (error) {
    next(error);
  }
};

// ─── GET /api/admin/teacher-performance/summary ───────────────────────────────
// Headline stats for the top of the dashboard.
export const getTeacherPerformanceSummary = async (req, res, next) => {
  try {
    const rows = await cachedPerformanceData(req.tenant);

    if (rows.length === 0) {
      return sendSuccess(res, {
        totalTeachers: 0,
        mostActiveTeacher: null,
        leastActiveTeacher: null,
        mostSessionsTeacher: null,
        mostSubjectsTeacher: null,
        inactiveTeachers: [],
      });
    }

    const withSubjects = rows.filter((r) => r.totalSubjects > 0);

    // "Most active" = highest session count, tie-broken by most recent activity.
    const byActivity = [...rows].sort((a, b) => {
      if (b.totalAttendanceSessions !== a.totalAttendanceSessions) {
        return b.totalAttendanceSessions - a.totalAttendanceSessions;
      }
      const at = a.lastAttendanceDate ? new Date(a.lastAttendanceDate).getTime() : 0;
      const bt = b.lastAttendanceDate ? new Date(b.lastAttendanceDate).getTime() : 0;
      return bt - at;
    });
    const mostActiveTeacher = byActivity[0]?.totalAttendanceSessions > 0 ? byActivity[0] : null;

    // "Least active" — among teachers who've actually created a subject (so a
    // brand-new teacher with nothing set up yet doesn't just win by default).
    const leastActiveTeacher =
      withSubjects.length > 0
        ? [...withSubjects].sort((a, b) => a.totalAttendanceSessions - b.totalAttendanceSessions)[0]
        : null;

    const mostSessionsTeacher = byActivity[0]?.totalAttendanceSessions > 0 ? byActivity[0] : null;

    const mostSubjectsTeacher =
      withSubjects.length > 0 ? [...withSubjects].sort((a, b) => b.totalSubjects - a.totalSubjects)[0] : null;

    const inactiveTeachers = rows
      .filter(
        (r) =>
          r.totalSubjects > 0 &&
          (r.daysSinceLastAttendance === null || r.daysSinceLastAttendance > INACTIVE_THRESHOLD_DAYS)
      )
      .sort((a, b) => (b.daysSinceLastAttendance ?? 9999) - (a.daysSinceLastAttendance ?? 9999))
      .map((r) => ({
        teacherId: r.teacherId,
        name: r.name,
        lastAttendanceDate: r.lastAttendanceDate,
        daysSinceLastAttendance: r.daysSinceLastAttendance,
      }));

    return sendSuccess(res, {
      totalTeachers: rows.length,
      mostActiveTeacher,
      leastActiveTeacher,
      mostSessionsTeacher,
      mostSubjectsTeacher,
      inactiveTeachers,
      inactiveThresholdDays: INACTIVE_THRESHOLD_DAYS,
    });
  } catch (error) {
    next(error);
  }
};
