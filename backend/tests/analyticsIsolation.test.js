/**
 * Part 13 — analytics and performance dashboards are college-specific.
 *
 * Real routers, middleware, controllers and Mongoose models over real HTTP on the
 * fake driver from ./helpers/mongooseFake.js, with TWO colleges whose department,
 * batch name, shift, subject code and student registration numbers are IDENTICAL
 * but whose data differs. Every dashboard number is asserted for each college and
 * must come out independent.
 *
 * Groups: identical batch names · cross-college mutation · ownership validation ·
 * forged requests · aggregation guard (scopedAggregate) · static pipeline audit ·
 * per-college cache · formulas/golden values · streak batching · index contracts.
 */
import test, { beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startApp, makeCollege, models } from "./helpers/e2eApp.js";
import { seedCollegeCategories } from "../services/categoryDefaults.js";
import { checkAndCreateAlerts, countTrailingAbsences } from "../controllers/alertsController.js";
import { scopedAggregate, scopedModel, TenantScopeError } from "../utils/tenantScope.js";
import { analyticsCache, createTenantCache, resolveAnalyticsCacheTtl } from "../utils/analyticsCache.js";
import { findOwnedStudent, findOwnedTeacher } from "../utils/analyticsScope.js";

const { Subject, Student, Attendance, ConsecutiveAbsenceAlert, User } = models;

process.env.ANALYTICS_CACHE_TTL_MS = "0"; // dashboards recompute on every request unless a test turns the cache on

const here = dirname(fileURLToPath(import.meta.url));
const backendDir = join(here, "..");

let app, call, A, B, A2, subA1, subA2, subB;
const post = (t, p, body) => call(t, "POST", p, { body });
const put = (t, p, body) => call(t, "PUT", p, { body });
const get = (t, p, query) => call(t, "GET", p, { query });

const DEPT = "Computer Science and Technology"; // seeded for every college
const SAME = { batch: "2024", department: DEPT, shift: "Morning" }; // identical in both colleges

let rollSeq = 0;
const mkStudent = (C, studentId, over = {}) => Student.create({
  studentId, roll: String(++rollSeq), name: `Student ${studentId}`, ...SAME,
  uploadedBy: C.admin._id, collegeId: C.collegeId, ...over,
});
const newSubject = async (token, over = {}) => {
  const r = await post(token, "/api/subjects", { subjectName: "Networks", subjectCode: "CSE-101", ...SAME, ...over });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.data.subject;
};
const roster = (statuses) => Object.entries(statuses).map(([studentId, status]) => ({ studentId, roll: "1", name: `Student ${studentId}`, status }));
const take = async (token, subject, { date, classType = "Theory", students }) => {
  const r = await post(token, `/api/attendance/${subject._id}`, { date, classType, students: roster(students) });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.data.attendance;
};

/** checkAndCreateAlerts runs after the response (fire-and-forget): wait for its effect. */
const eventually = async (fn, ms = 2000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 15));
  }
};
const settle = () => new Promise((r) => setTimeout(r, 120));

/**
 * College A: students S-1 S-2 S-3, teacher T1 (Networks CSE-101) + teacher T2 (Databases CSE-202).
 *   Networks  Theory 01-01  S-1 P  S-2 A  S-3 P     (2/3)
 *   Networks  Lab    01-02  S-1 P  S-2 P  S-3 A     (2/3)
 *   Databases Theory 01-03  S-1 A  S-2 A  S-3 A     (0/3)
 * College B: students S-1 S-2 (same ids and same batch name), teacher T (Networks CSE-101).
 *   Networks  Theory 01-01  S-1 A  S-2 A            (0/2)
 */
beforeEach(async () => {
  if (app) await app.close();
  app = await startApp();
  call = app.call;
  analyticsCache.clear();
  A = await makeCollege("Alpha Polytechnic", { seedDefaults: true });
  B = await makeCollege("Beta Polytechnic", { seedDefaults: true });
  await seedCollegeCategories(A.collegeId);
  await seedCollegeCategories(B.collegeId);
  for (const id of ["S-1", "S-2", "S-3"]) await mkStudent(A, id);
  for (const id of ["S-1", "S-2"]) await mkStudent(B, id);
  A2 = await A.mkTeacher();
  subA1 = await newSubject(A.teacherToken);
  subA2 = await newSubject(A2.token, { subjectName: "Databases", subjectCode: "CSE-202" });
  subB = await newSubject(B.teacherToken);
  await take(A.teacherToken, subA1, { date: "2025-01-01", classType: "Theory", students: { "S-1": "present", "S-2": "absent", "S-3": "present" } });
  await take(A.teacherToken, subA1, { date: "2025-01-02", classType: "Lab", students: { "S-1": "present", "S-2": "present", "S-3": "absent" } });
  await take(A2.token, subA2, { date: "2025-01-03", classType: "Theory", students: { "S-1": "absent", "S-2": "absent", "S-3": "absent" } });
  await take(B.teacherToken, subB, { date: "2025-01-01", classType: "Theory", students: { "S-1": "absent", "S-2": "absent" } });
});
after(async () => { if (app) await app.close(); });

// ═══ Identical batch names in different colleges → independent statistics ═══

test("student groups: the same department/batch/shift has its own head-count in each college", async () => {
  const a = (await get(A.adminToken, "/api/students/groups")).data.groups;
  const b = (await get(B.adminToken, "/api/students/groups")).data.groups;
  assert.deepEqual(a.map((g) => [g.department, g.batch, g.shift, g.count]), [[DEPT, "2024", "Morning", 3]]);
  assert.deepEqual(b.map((g) => [g.department, g.batch, g.shift, g.count]), [[DEPT, "2024", "Morning", 2]]);
});

test("batch lists contain only the college's own batches, even when another college has the same name", async () => {
  await mkStudent(B, "S-9", { batch: "2025" }); // only Beta has batch 2025
  assert.deepEqual((await get(A.adminToken, "/api/students/batches")).data.batches, ["2024"]);
  assert.deepEqual((await get(B.adminToken, "/api/students/batches")).data.batches, ["2024", "2025"]);
});

test("student directory: attendance %, classes, credit score and status differ per college for the same student id", async () => {
  const rowsOf = async (C) => Object.fromEntries((await get(C.adminToken, "/api/students/directory")).data.students.map((r) => [r.studentId, r]));
  const a = await rowsOf(A);
  const b = await rowsOf(B);
  // A / S-1: Networks Theory P, Lab P, Databases Theory A → 2 of 3 classes, 2 subjects attended in; credit = Theory 1 + Lab 3 = 4
  assert.deepEqual([a["S-1"].totalClasses, a["S-1"].totalAttended, a["S-1"].attendancePercentage, a["S-1"].creditScore, a["S-1"].totalSubjects], [3, 2, 67, 4, 2]);
  assert.deepEqual([b["S-1"].totalClasses, b["S-1"].totalAttended, b["S-1"].attendancePercentage, b["S-1"].creditScore, b["S-1"].status], [1, 0, 0, 0, "Critical"]);
  assert.equal(Object.keys(a).length, 3);
  assert.equal(Object.keys(b).length, 2);
  // filtering by the shared batch name stays inside the college
  assert.equal((await get(B.adminToken, "/api/students/directory", { batch: "2024" })).data.pagination.total, 2);
  assert.equal((await get(A.adminToken, "/api/students/directory", { batch: "2024" })).data.pagination.total, 3);
  // computed-field sorting (the all-students-in-memory path) is also per college
  const below = async (C, n) => (await get(C.adminToken, "/api/students/directory", { sortBy: "attendancePercentage", sortOrder: "asc", attendanceBelow: String(n) })).data.students.map((s) => s.studentId);
  assert.deepEqual((await below(A, 70)).sort(), ["S-1", "S-2", "S-3"]); // 67 / 33 / 33
  assert.deepEqual((await below(A, 50)).sort(), ["S-2", "S-3"]);
  assert.deepEqual((await below(B, 10)).sort(), ["S-1", "S-2"]); // both 0 % in B
});

test("academic structure (department/batch statistics): counts, teachers and summary are independent", async () => {
  const group = async (C) => {
    const dept = (await get(C.adminToken, "/api/admin/academic-structure")).data.departments.find((d) => d.department === DEPT);
    assert.equal(dept.batches.length, 1);
    return { dept, shift: dept.batches[0].shifts[0] };
  };
  const a = await group(A);
  const b = await group(B);
  assert.deepEqual([a.shift.totalStudents, a.shift.totalSubjects, a.shift.totalTeachers], [3, 2, 2]);
  assert.deepEqual([b.shift.totalStudents, b.shift.totalSubjects, b.shift.totalTeachers], [2, 1, 1]);
  assert.deepEqual([a.dept.totalStudents, b.dept.totalStudents], [3, 2]);
  const sa = (await get(A.adminToken, "/api/admin/academic-structure/summary")).data;
  const sb = (await get(B.adminToken, "/api/admin/academic-structure/summary")).data;
  assert.deepEqual([sa.totalStudents, sa.totalSubjects, sa.totalTeachersAssigned], [3, 2, 2]);
  assert.deepEqual([sb.totalStudents, sb.totalSubjects, sb.totalTeachersAssigned], [2, 1, 1]);
  const names = JSON.stringify(a.dept.batches);
  assert.ok(!names.includes(B.teacher.name) && !names.includes(B.teacher.email));
});

test("subject analytics: classes, students, weighted attendance % and type are per college", async () => {
  const rows = async (C) => (await get(C.adminToken, "/api/admin/subjects", { sortBy: "name", sortOrder: "asc" })).data.subjects;
  const a = await rows(A);
  const b = await rows(B);
  assert.deepEqual(a.map((r) => [r.subjectCode, r.totalClasses, r.totalStudents, r.attendancePercentage]), [
    ["CSE-202", 1, 3, 0],    // Databases
    ["CSE-101", 2, 3, 66.7], // Networks: (2+2) present of (3+3)
  ]);
  assert.deepEqual(b.map((r) => [r.subjectCode, r.totalClasses, r.totalStudents, r.attendancePercentage]), [["CSE-101", 1, 2, 0]]);
  assert.equal(b[0].teacherName, B.teacher.name);
  assert.ok(!JSON.stringify(a).includes(B.teacher.name));
});

test("teacher performance: sessions, subjects, students managed and average % per college (and the summary)", async () => {
  const list = async (C) => (await get(C.adminToken, "/api/admin/teacher-performance", { sortBy: "name", sortOrder: "asc" })).data.teachers;
  const a = await list(A);
  const b = await list(B);
  const t1 = a.find((t) => String(t.teacherId) === String(A.teacher._id));
  const t2 = a.find((t) => String(t.teacherId) === String(A2.user._id));
  assert.deepEqual([t1.totalSubjects, t1.totalAttendanceSessions, t1.totalStudentsManaged, t1.avgAttendancePercentage], [1, 2, 3, 66.7]);
  assert.deepEqual([t2.totalSubjects, t2.totalAttendanceSessions, t2.totalStudentsManaged, t2.avgAttendancePercentage], [1, 1, 3, 0]);
  assert.equal(b.length, 1);
  assert.deepEqual([b[0].totalSubjects, b[0].totalAttendanceSessions, b[0].totalStudentsManaged, b[0].avgAttendancePercentage], [1, 1, 2, 0]);
  const sa = (await get(A.adminToken, "/api/admin/teacher-performance/summary")).data;
  const sb = (await get(B.adminToken, "/api/admin/teacher-performance/summary")).data;
  assert.equal(sa.totalTeachers, 2); // T1 and T2 (the admin account is not a teacher)
  assert.equal(sb.totalTeachers, 1);
  assert.equal(String(sa.mostActiveTeacher.teacherId), String(A.teacher._id));
  assert.equal(String(sb.mostActiveTeacher.teacherId), String(B.teacher._id));
  assert.deepEqual((await get(B.adminToken, "/api/admin/teacher-performance/departments")).data.departments, []);
});

test("per-student analytics (credit summary): same student id, separate subjects, percentages, credits and alert history", async () => {
  const an = async (C) => (await get(C.adminToken, "/api/alerts/student/S-1/analytics")).data;
  const a = await an(A);
  const b = await an(B);
  assert.deepEqual(
    [a.academicStats.totalSubjects, a.academicStats.totalClasses, a.academicStats.totalAttended, a.academicStats.overallPercentage, a.academicStats.creditScore],
    [2, 3, 2, 67, 4]
  );
  assert.deepEqual(a.academicStats.creditScoreBreakdown.map((c) => [c.category, c.attendedClasses, c.pointsEarned]).sort(), [["Lab", 1, 3], ["Theory", 1, 1]]);
  assert.deepEqual(
    [b.academicStats.totalSubjects, b.academicStats.totalClasses, b.academicStats.totalAttended, b.academicStats.overallPercentage, b.academicStats.creditScore, b.academicStats.status],
    [1, 1, 0, 0, 0, "Critical"]
  );
  assert.deepEqual(b.subjectStats.map((s) => s.subjectId), [subB._id]);
  assert.ok(!JSON.stringify(a).includes(B.teacher.email) && !JSON.stringify(b).includes(A.teacher.email));
});

test("credit rules are per college: a different Lab credit changes only that college's credit summary", async () => {
  const cat = (await get(B.adminToken, "/api/attendance-categories")).data.full.find((c) => c.name === "Lab");
  assert.equal((await put(B.adminToken, `/api/attendance-categories/${cat._id}`, { credit: 7 })).status, 200);
  await take(B.teacherToken, subB, { date: "2025-01-02", classType: "Lab", students: { "S-1": "present", "S-2": "absent" } });
  assert.equal((await get(B.adminToken, "/api/alerts/student/S-1/analytics")).data.academicStats.creditScore, 7);
  assert.equal((await get(A.adminToken, "/api/alerts/student/S-1/analytics")).data.academicStats.creditScore, 4, "College A still grades Lab as 3");
  const dir = (await get(B.adminToken, "/api/students/directory")).data.students.find((s) => s.studentId === "S-1");
  assert.equal(dir.creditScore, 7);
});

test("streak reports: the same batch and student id raise (or not) an alert by each college's own threshold", async () => {
  assert.equal((await put(B.adminToken, "/api/settings", { consecutiveAbsenceLimit: 1 })).status, 200);
  // B's S-1 / S-2 were absent in the session taken in setup (before the limit was lowered): record one more absence there.
  await take(B.teacherToken, subB, { date: "2025-01-05", classType: "Theory", students: { "S-1": "absent", "S-2": "absent" } });
  await eventually(async () => (await ConsecutiveAbsenceAlert.countDocuments({ collegeId: B.collegeId })) === 2);
  await settle();
  const alertsB = (await get(B.teacherToken, "/api/alerts")).data.alerts;
  assert.deepEqual(alertsB.map((x) => [x.studentId, x.batch, x.consecutiveMissCount]).sort(), [["S-1", "2024", 2], ["S-2", "2024", 2]]);
  // College A keeps the default limit 3: S-1 / S-2 / S-3 were absent in at most two consecutive Networks classes
  assert.deepEqual((await get(A.teacherToken, "/api/alerts")).data.alerts, []);
  assert.deepEqual((await get(A2.token, "/api/alerts")).data.alerts, []);
  assert.equal(await ConsecutiveAbsenceAlert.countDocuments({ collegeId: A.collegeId }), 0);
  // each college's student analytics shows only its own alert history
  assert.equal((await get(B.adminToken, "/api/alerts/student/S-1/analytics")).data.alertHistory.length, 1);
  assert.equal((await get(A.adminToken, "/api/alerts/student/S-1/analytics")).data.alertHistory.length, 0);
});

test("trash statistics on the dashboard are per college", async () => {
  const s = await take(B.teacherToken, subB, { date: "2025-01-09", classType: "Theory", students: { "S-1": "present", "S-2": "present" } });
  assert.equal((await call(B.teacherToken, "DELETE", `/api/attendance/${subB._id}/session/${s._id}`)).status, 200);
  const sa = (await get(A.adminToken, "/api/admin/trash/stats")).data.system;
  const sb = (await get(B.adminToken, "/api/admin/trash/stats")).data.system;
  assert.deepEqual([sa.totalActiveRecords, sa.totalTrashedRecords], [3, 0]);
  assert.deepEqual([sb.totalActiveRecords, sb.totalTrashedRecords], [1, 1]);
});

// ═══ Changing one college never moves another college's numbers ═════════════

test("recording, editing, trashing and deleting in college B leaves every college A statistic unchanged", async () => {
  const snapshot = async () => JSON.stringify([
    (await get(A.adminToken, "/api/students/directory", { sortBy: "studentId" })).data.students,
    (await get(A.adminToken, "/api/admin/subjects", { sortBy: "name", sortOrder: "asc" })).data.subjects,
    (await get(A.adminToken, "/api/admin/teacher-performance", { sortBy: "name", sortOrder: "asc" })).data.teachers.map(({ daysSinceLastAttendance, ...t }) => t),
    (await get(A.adminToken, "/api/admin/academic-structure")).data.departments,
    (await get(A.adminToken, "/api/alerts/student/S-1/analytics")).data.academicStats,
    (await get(A.adminToken, "/api/students/groups")).data.groups,
  ]);
  const before = await snapshot();
  const s1 = await take(B.teacherToken, subB, { date: "2025-02-01", classType: "Lab", students: { "S-1": "present", "S-2": "present" } });
  await put(B.teacherToken, `/api/attendance/${subB._id}/session/${s1._id}`, { students: [{ studentId: "S-2", status: "absent" }] });
  await mkStudent(B, "S-3");
  await mkStudent(B, "S-4", { batch: "2030" });
  await call(B.teacherToken, "DELETE", `/api/attendance/${subB._id}/session/${s1._id}`);
  await call(B.adminToken, "DELETE", "/api/students/group", { body: { department: DEPT, batch: "2030", shift: "Morning" } });
  assert.equal(await snapshot(), before);
});

// ═══ Ownership validation before specific analytics ═════════════════════════

test("student analytics: another college's student, an unknown id and an odd id are the same 404; no numbers are produced", async () => {
  await mkStudent(B, "B-ONLY");
  const foreign = await get(A.adminToken, "/api/alerts/student/B-ONLY/analytics");
  const unknown = await get(A.adminToken, "/api/alerts/student/NOPE/analytics");
  const odd = await get(A.adminToken, `/api/alerts/student/${"x".repeat(200)}/analytics`);
  for (const r of [foreign, unknown, odd]) assert.equal(r.status, 404);
  assert.deepEqual(foreign.body, unknown.body);
  assert.equal(foreign.data, undefined);
  assert.equal((await get(B.adminToken, "/api/alerts/student/B-ONLY/analytics")).status, 200);
});

test("student analytics are admin-only: a teacher (even of the same college) is refused, anonymous is 401", async () => {
  assert.equal((await get(A.teacherToken, "/api/alerts/student/S-1/analytics")).status, 403);
  assert.equal((await get(B.teacherToken, "/api/alerts/student/S-1/analytics")).status, 403);
  assert.equal((await get(null, "/api/alerts/student/S-1/analytics")).status, 401);
});

test("findOwnedStudent / findOwnedTeacher: scoped, defensive, and fail closed", async () => {
  const tA = { collegeId: A.collegeId };
  assert.equal((await findOwnedStudent(tA, "S-1")).collegeId, A.collegeId);
  assert.equal(await findOwnedStudent({ collegeId: B.collegeId }, "S-3"), null, "S-3 exists only in A");
  for (const bad of [undefined, null, "", "   ", 5, { $ne: "" }, ["S-1"], "z".repeat(65)]) assert.equal(await findOwnedStudent(tA, bad), null, JSON.stringify(bad));
  assert.equal(String((await findOwnedTeacher(tA, String(A.teacher._id)))._id), String(A.teacher._id));
  assert.equal(await findOwnedTeacher(tA, String(B.teacher._id)), null, "foreign teacher");
  assert.equal(await findOwnedTeacher(tA, String(A.admin._id)), null, "an admin is not a teacher");
  for (const bad of [undefined, "nope", 7, { $ne: null }, [String(A.teacher._id)]]) assert.equal(await findOwnedTeacher(tA, bad), null);
  await assert.rejects(() => findOwnedStudent(undefined, "S-1"), TenantScopeError, "no tenant → fail closed");
  await assert.rejects(() => findOwnedTeacher({}, String(A.teacher._id)), TenantScopeError);
});

test("a removed student's number reused by an active one: analytics resolve the active student", async () => {
  await Student.updateOne({ collegeId: A.collegeId, studentId: "S-3" }, { $set: { isActive: false } });
  await mkStudent(A, "S-3", { name: "Reissued", batch: "2025" }); // same number, now in another batch
  assert.equal((await findOwnedStudent({ collegeId: A.collegeId }, "S-3")).name, "Reissued");
  await Student.updateOne({ collegeId: A.collegeId, studentId: "S-3", batch: "2025" }, { $set: { isActive: false } });
  assert.equal((await findOwnedStudent({ collegeId: A.collegeId }, "S-3")).isActive, false, "falls back to the removed record when no active one exists");
});

test("subject analytics drill-down by teacher validates ownership first", async () => {
  const mine = await get(A.adminToken, "/api/admin/subjects", { teacherId: String(A2.user._id) });
  assert.equal(mine.status, 200);
  assert.deepEqual(mine.data.subjects.map((s) => s.subjectCode), ["CSE-202"]);

  const missing = "0".repeat(23) + "f";
  const results = await Promise.all([
    get(A.adminToken, "/api/admin/subjects", { teacherId: String(B.teacher._id) }), // another college
    get(A.adminToken, "/api/admin/subjects", { teacherId: missing }),                // unknown
    get(A.adminToken, "/api/admin/subjects", { teacherId: "not-an-id" }),            // malformed
    get(A.adminToken, "/api/admin/subjects", { teacherId: String(A.admin._id) }),    // an admin, not a teacher
    call(A.adminToken, "GET", "/api/admin/subjects?teacherId=" + A.teacher._id + "&teacherId=" + A2.user._id), // array
  ]);
  for (const r of results) assert.equal(r.status, 404, JSON.stringify(r.body));
  assert.deepEqual(results[0].body, results[1].body, "foreign id ≡ unknown id");
});

test("subject-level analytics: another college's subject ≡ missing subject; another teacher's subject is 403 for a teacher", async () => {
  const missing = "0".repeat(23) + "e";
  for (const path of ["percentage", "dates", ""]) {
    const foreign = await get(A.adminToken, `/api/attendance/${subB._id}/${path}`.replace(/\/$/, ""));
    const none = await get(A.adminToken, `/api/attendance/${missing}/${path}`.replace(/\/$/, ""));
    assert.equal(foreign.status, 404, path);
    assert.deepEqual(foreign.body, none.body, path);
    assert.equal((await get(B.teacherToken, `/api/attendance/${subA1._id}/${path}`.replace(/\/$/, ""))).status, 404, path);
  }
  // same college, someone else's subject
  assert.equal((await get(A2.token, `/api/attendance/${subA1._id}/percentage`)).status, 403);
  assert.equal((await get(A.teacherToken, `/api/attendance/${subA1._id}/percentage`)).status, 200);
  assert.equal((await get(A.adminToken, `/api/attendance/${subA2._id}/percentage`)).status, 200, "admins may read any subject of their own college");
  assert.equal((await get(A.adminToken, `/api/export/${subB._id}/meta`)).status, 404);
});

test("a student-id filter on subject percentage cannot reach a student of another college", async () => {
  await mkStudent(B, "B-ONLY");
  const r = await get(A.teacherToken, `/api/attendance/${subA1._id}/percentage`, { studentId: "B-ONLY" });
  assert.equal(r.status, 404);
});

test("teacher-only and admin-only dashboards keep their role rules", async () => {
  for (const path of ["/api/admin/teacher-performance", "/api/admin/teacher-performance/summary", "/api/admin/subjects", "/api/admin/subjects/meta", "/api/admin/academic-structure", "/api/admin/academic-structure/summary", "/api/admin/trash/stats", "/api/students/directory"]) {
    assert.equal((await get(A.teacherToken, path)).status, 403, path);
    assert.equal((await get(null, path)).status, 401, path);
  }
});

// ═══ Forged college values never change a dashboard ═════════════════════════

test("a collegeId / college / tenant value in the query string is ignored by every dashboard", async () => {
  const paths = [
    "/api/admin/teacher-performance", "/api/admin/teacher-performance/summary", "/api/admin/subjects", "/api/admin/subjects/meta",
    "/api/admin/academic-structure", "/api/admin/academic-structure/summary", "/api/admin/trash/stats",
    "/api/students/directory", "/api/students/groups", "/api/students/batches", "/api/alerts/student/S-1/analytics",
  ];
  const scrub = (b) => JSON.stringify(b?.data, (k, v) => (k === "generatedAt" || k === "cutoffDate" || k === "info" || k === "daysSinceLastAttendance" ? undefined : v));
  for (const path of paths) {
    const plain = await get(A.adminToken, path);
    assert.equal(plain.status, 200, path);
    for (const key of ["collegeId", "college", "tenantId", "college_id"]) {
      const forged = await get(A.adminToken, path, { [key]: B.collegeId });
      assert.equal(forged.status, 200, `${path} ?${key}`);
      assert.equal(scrub(forged.body), scrub(plain.body), `${path} ?${key}`);
    }
  }
});

// ═══ scopedAggregate: tenant $match first; no stage may join another college ═

const fakeModel = () => {
  const m = { schema: { path: (p) => p === "collegeId" }, modelName: "Fake", pipelines: [] };
  m.aggregate = (p) => { m.pipelines.push(p); return Promise.resolve([]); };
  return m;
};
const T = { collegeId: "COL-1" };

test("the tenant $match is the FIRST stage, before any $group / $sum / $max, and a caller's own match cannot replace it", () => {
  const M = fakeModel();
  scopedAggregate(M, T, [
    { $match: { collegeId: "COL-2", isDeleted: false } }, // hostile: another college
    { $group: { _id: "$subjectId", n: { $sum: 1 }, last: { $max: "$date" } } },
  ]);
  const [first, second, third] = M.pipelines[0];
  assert.deepEqual(first, { $match: { collegeId: "COL-1" } });
  assert.deepEqual(second, { $match: { collegeId: "COL-2", isDeleted: false } }, "intersects with the tenant match, so it can only narrow");
  assert.ok(third.$group);
  assert.equal(M.pipelines[0].findIndex((s) => s.$group), 2, "grouping happens after the tenant filter");
});

test("scopedModel(...).aggregate goes through the same guard; a college-less tenant is pinned to collegeId null", () => {
  const M = fakeModel();
  scopedModel(M, T).aggregate([{ $group: { _id: null, n: { $sum: 1 } } }]);
  assert.deepEqual(M.pipelines[0][0], { $match: { collegeId: "COL-1" } });
  scopedAggregate(M, { collegeId: null }, [{ $count: "n" }]);
  assert.deepEqual(M.pipelines[1][0], { $match: { collegeId: null } });
});

test("stages that can read another college's rows are refused", () => {
  const M = fakeModel();
  const bad = {
    "$out": [{ $out: "x" }],
    "$merge": [{ $merge: { into: "x" } }],
    "$unionWith": [{ $unionWith: { coll: "students" } }],
    "$graphLookup": [{ $graphLookup: { from: "users", startWith: "$a", connectFromField: "a", connectToField: "b", as: "x" } }],
    "$lookup localField/foreignField": [{ $lookup: { from: "users", localField: "teacher", foreignField: "_id", as: "t" } }],
    "$lookup pipeline without a college match": [{ $lookup: { from: "users", let: { id: "$teacher" }, pipeline: [{ $match: { $expr: { $eq: ["$_id", "$$id"] } } }], as: "t" } }],
    "$lookup pinned to ANOTHER college": [{ $lookup: { from: "users", let: { id: "$teacher" }, pipeline: [{ $match: { collegeId: "COL-2" } }], as: "t" } }],
    "$lookup match is not first": [{ $lookup: { from: "users", let: { id: "$teacher" }, pipeline: [{ $project: { name: 1 } }, { $match: { collegeId: "COL-1" } }], as: "t" } }],
    "$lookup pinned only inside $or": [{ $lookup: { from: "users", let: {}, pipeline: [{ $match: { $or: [{ collegeId: "COL-1" }, {}] } }], as: "t" } }],
    "$lookup pinned with an operator": [{ $lookup: { from: "users", let: {}, pipeline: [{ $match: { collegeId: { $ne: "COL-2" } } }], as: "t" } }],
    "unsafe $lookup inside $facet": [{ $facet: { x: [{ $lookup: { from: "users", localField: "a", foreignField: "b", as: "t" } }] } }],
    "non-object stage": [null],
  };
  for (const [name, pipeline] of Object.entries(bad)) {
    assert.throws(() => scopedAggregate(M, T, pipeline), TenantScopeError, name);
  }
  assert.equal(M.pipelines.length, 0, "nothing was sent to the database");
  assert.throws(() => scopedAggregate(M, T, "nope"), TenantScopeError);
  assert.throws(() => scopedAggregate(M, undefined, []), TenantScopeError, "no tenant → fail closed");
});

test("a $lookup whose sub-pipeline starts with a match pinned to the tenant is allowed (the trash-stats shape)", () => {
  const M = fakeModel();
  assert.doesNotThrow(() => scopedAggregate(M, T, [
    { $group: { _id: "$teacher", count: { $sum: 1 } } },
    { $lookup: { from: "users", let: { teacherId: "$_id" }, pipeline: [{ $match: { $expr: { $eq: ["$_id", "$$teacherId"] }, collegeId: "COL-1" } }, { $project: { name: 1 } }], as: "teacherInfo" } },
  ]));
  assert.doesNotThrow(() => scopedAggregate(M, { collegeId: null }, [{ $lookup: { from: "users", let: {}, pipeline: [{ $match: { collegeId: null } }], as: "t" } }]));
  assert.doesNotThrow(() => scopedAggregate(M, T, [{ $lookup: { from: "users", let: {}, pipeline: [{ $match: { $and: [{ collegeId: "COL-1" }, { role: "teacher" }] } }], as: "t" } }]));
});

test("a pipeline the guard accepts really cannot see another college's documents (fake DB, $lookup included)", async () => {
  const tA = { collegeId: A.collegeId };
  const rows = await scopedAggregate(Attendance, tA, [
    { $group: { _id: "$teacher", sessions: { $sum: 1 } } },
    { $lookup: { from: "users", let: { id: "$_id" }, pipeline: [{ $match: { $expr: { $eq: ["$_id", "$$id"] }, collegeId: A.collegeId } }, { $project: { name: 1 } }], as: "u" } },
  ]);
  assert.equal(rows.reduce((n, r) => n + r.sessions, 0), 3, "A has 3 sessions; B's session is not counted");
  assert.ok(!JSON.stringify(rows).includes(B.teacher.name));
});

// ═══ Static audit: every aggregation in the app goes through the scoped helpers ═

const sourceFiles = (dir) => readdirSync(join(backendDir, dir)).filter((f) => f.endsWith(".js")).map((f) => [`${dir}/${f}`, readFileSync(join(backendDir, dir, f), "utf8")]);

test("audit: no controller, service, middleware or util calls .aggregate() on a bare model", () => {
  const exempt = new Set(["utils/tenantScope.js"]); // the helper itself
  const offenders = [];
  for (const [file, src] of ["controllers", "services", "middleware", "utils", "routes"].flatMap(sourceFiles)) {
    if (exempt.has(file)) continue;
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, ""); // ignore comments
    for (const m of code.matchAll(/([A-Za-z_$][\w$]*(?:\([^()]*\))?)\s*\.\s*aggregate\s*\(/g)) {
      const receiver = m[1];
      const scoped = /^(scopedModel\(.*\)|students\(req\)|attendanceOf\(req\))$/.test(receiver);
      const bareModel = /^[A-Z][A-Za-z]*$/.test(receiver);
      if (bareModel || !scoped) offenders.push(`${file}: ${receiver}.aggregate(`);
    }
    if (/\.collection\s*\.\s*(aggregate|find|countDocuments)\b/.test(code)) offenders.push(`${file}: raw .collection access`);
    if (/\$unionWith|\$graphLookup/.test(code)) offenders.push(`${file}: $unionWith/$graphLookup`);
    // a $lookup outside the helper must be the let/pipeline form
    for (const m of code.matchAll(/\$lookup\s*:\s*\{([\s\S]*?)\n\s*\},?\s*\n/g)) {
      if (!/pipeline\s*:/.test(m[1])) offenders.push(`${file}: $lookup without a pipeline`);
    }
  }
  assert.deepEqual(offenders, []);
});

test("audit: the dashboards' aggregations are the scoped kind and the unscoped scheduler job is the only global read", () => {
  const dashboards = ["controllers/teacherPerformanceController.js", "controllers/subjectAnalyticsController.js", "controllers/academicStructureController.js", "controllers/studentController.js", "controllers/trashController.js"];
  for (const f of dashboards) {
    const src = readFileSync(join(backendDir, f), "utf8");
    assert.match(src, /scopedModel|scopedAggregate/, f);
  }
  const cron = readFileSync(join(backendDir, "services/cronJobs.js"), "utf8");
  // Part 16: the nightly purge no longer bulk-deletes across colleges. Its only
  // global read is the list of colleges that have trash; every write goes
  // through scopedModel for one college at a time.
  assert.match(cron, /Attendance\.distinct\("collegeId"/, "the scheduler's only global read is the list of colleges with trash");
  assert.match(cron, /scopedModel\(Attendance/, "the purge itself is college-scoped");
  assert.doesNotMatch(cron, /Attendance\.(deleteMany|deleteOne|updateMany|updateOne|findOneAndDelete)/, "no unscoped attendance write in the scheduler");
});

// ═══ Per-college cache ══════════════════════════════════════════════════════

test("cache: entries are keyed by college — the same dataset name never crosses colleges, including the college-less tenant", async () => {
  let t = 1000;
  const cache = createTenantCache({ ttlMs: 5000, now: () => t });
  const compute = (v) => async () => v;
  assert.equal(await cache.get({ collegeId: "COL-A" }, "perf", compute("A-data")), "A-data");
  assert.equal(await cache.get({ collegeId: "COL-B" }, "perf", compute("B-data")), "B-data");
  assert.equal(await cache.get({ collegeId: null }, "perf", compute("legacy")), "legacy");
  assert.equal(await cache.get({ collegeId: "COL-A" }, "perf", compute("WRONG")), "A-data", "A is served its own entry");
  assert.equal(await cache.get({ collegeId: "COL-B" }, "perf", compute("WRONG")), "B-data");
  assert.equal(await cache.get({ collegeId: null }, "perf", compute("WRONG")), "legacy");
  assert.equal(await cache.get({ collegeId: "COL-A" }, "perf", compute("A-variant"), "archived=true"), "A-variant", "variants are separate entries");
  assert.equal(await cache.get({ collegeId: "COL-A" }, "other-dataset", compute("A-other")), "A-other");
  // a college id that looks like another college's key prefix cannot collide with it
  assert.equal(await cache.get({ collegeId: "COL-A\u0000perf" }, "", compute("evil")), "evil");
  assert.equal(await cache.get({ collegeId: "COL-A" }, "perf", compute("WRONG")), "A-data");
  assert.deepEqual([cache.stats.hits, cache.stats.misses], [4, 6]);
});

test("cache: requires a tenant (fails closed) and a college id", async () => {
  const cache = createTenantCache({ ttlMs: 1000 });
  for (const bad of [undefined, null, {}, { collegeId: "" }, { collegeId: 5 }, "COL-A"]) {
    await assert.rejects(() => cache.get(bad, "x", async () => 1), TenantScopeError, JSON.stringify(bad));
  }
  assert.throws(() => cache.invalidate(undefined), TenantScopeError);
});

test("cache: expiry, no caching of failures, concurrent callers share one computation, TTL 0 disables", async () => {
  let t = 0;
  const cache = createTenantCache({ ttlMs: 100, now: () => t });
  let runs = 0;
  const job = async () => { runs += 1; await new Promise((r) => setTimeout(r, 5)); return runs; };
  const tenant = { collegeId: "COL-A" };
  const [x, y, z] = await Promise.all([cache.get(tenant, "d", job), cache.get(tenant, "d", job), cache.get(tenant, "d", job)]);
  assert.deepEqual([x, y, z, runs], [1, 1, 1, 1]);
  assert.equal(cache.stats.shared, 2);
  t = 99; assert.equal(await cache.get(tenant, "d", job), 1);
  t = 100; assert.equal(await cache.get(tenant, "d", job), 2, "expired");
  let fails = 0;
  const bad = async () => { fails += 1; throw new Error("db down"); };
  await assert.rejects(() => cache.get(tenant, "bad", bad), /db down/);
  await assert.rejects(() => cache.get(tenant, "bad", bad), /db down/);
  assert.equal(fails, 2, "a failure is not cached");
  const off = createTenantCache({ ttlMs: 0 });
  let n = 0;
  await off.get(tenant, "d", async () => ++n); await off.get(tenant, "d", async () => ++n);
  assert.equal(n, 2);
});

test("cache: invalidate drops only that college (all datasets, or one); the cache is bounded", async () => {
  const cache = createTenantCache({ ttlMs: 10_000, maxEntries: 3 });
  const a = { collegeId: "COL-A" }, b = { collegeId: "COL-B" }, ab = { collegeId: "COL-AB" };
  await cache.get(a, "x", async () => "a-x"); await cache.get(a, "y", async () => "a-y"); await cache.get(b, "x", async () => "b-x");
  cache.invalidate(a, "x");
  assert.equal(await cache.get(a, "x", async () => "a-x2"), "a-x2");
  assert.equal(await cache.get(a, "y", async () => "NEW"), "a-y");
  assert.equal(await cache.get(b, "x", async () => "NEW"), "b-x", "college B untouched");
  cache.invalidate(a);
  assert.equal(await cache.get(a, "y", async () => "a-y2"), "a-y2");
  assert.equal(await cache.get(b, "x", async () => "NEW"), "b-x");
  // "COL-A" must not invalidate "COL-AB"
  const cache2 = createTenantCache({ ttlMs: 10_000 });
  await cache2.get(ab, "x", async () => "ab"); cache2.invalidate(a);
  assert.equal(await cache2.get(ab, "x", async () => "NEW"), "ab");
  // bound: 3 entries max
  const small = createTenantCache({ ttlMs: 10_000, maxEntries: 3 });
  for (let i = 0; i < 10; i++) await small.get({ collegeId: `C${i}` }, "d", async () => i);
  assert.ok(small.size <= 3);
});

test("cache TTL: explicit setting wins; off under the test runner; 15 s otherwise", () => {
  assert.equal(resolveAnalyticsCacheTtl({ ANALYTICS_CACHE_TTL_MS: "250" }), 250);
  assert.equal(resolveAnalyticsCacheTtl({ ANALYTICS_CACHE_TTL_MS: "0", NODE_ENV: "production" }), 0);
  assert.equal(resolveAnalyticsCacheTtl({ ANALYTICS_CACHE_TTL_MS: "junk" }), 15000);
  assert.equal(resolveAnalyticsCacheTtl({ ANALYTICS_CACHE_TTL_MS: "-5" }), 15000);
  assert.equal(resolveAnalyticsCacheTtl({ NODE_ENV: "test" }), 0);
  assert.equal(resolveAnalyticsCacheTtl({ NODE_TEST_CONTEXT: "child-v8" }), 0);
  assert.equal(resolveAnalyticsCacheTtl({}), 15000);
  assert.equal(resolveAnalyticsCacheTtl({ NODE_ENV: "production" }), 15000);
});

test("cache in the dashboards (enabled): reads are cached per college, never across colleges, and sorting never corrupts the cached rows", async () => {
  const prev = process.env.ANALYTICS_CACHE_TTL_MS;
  process.env.ANALYTICS_CACHE_TTL_MS = "60000";
  analyticsCache.clear();
  try {
    const perf = async (C, q) => (await get(C.adminToken, "/api/admin/teacher-performance", q)).data.teachers;
    const totalSessions = (rows) => rows.reduce((n, t) => n + t.totalAttendanceSessions, 0);
    assert.equal(totalSessions(await perf(A)), 3);
    assert.equal(totalSessions(await perf(B)), 1, "B gets its own dataset, not A's cached one");
    // a change that bypasses the API (so nothing invalidates) is not seen while the entry lives
    await Attendance.updateOne({ collegeId: B.collegeId }, { $set: { isDeleted: true } });
    assert.equal(totalSessions(await perf(B)), 1, "served from B's cache");
    assert.equal(totalSessions(await perf(A)), 3);
    // the summary shares the same cached dataset
    assert.equal((await get(B.adminToken, "/api/admin/teacher-performance/summary")).data.mostActiveTeacher.totalAttendanceSessions, 1);
    // sorting different ways does not corrupt the cached rows
    const byName = await perf(A, { sortBy: "name", sortOrder: "asc" });
    const bySessions = await perf(A, { sortBy: "sessions", sortOrder: "desc" });
    const byNameDesc = await perf(A, { sortBy: "name", sortOrder: "desc" });
    assert.deepEqual(byName.map((t) => t.name), [...byName.map((t) => t.name)].sort((x, y) => x.localeCompare(y)));
    assert.equal(String(bySessions[0].teacherId), String(A.teacher._id));
    assert.equal(totalSessions(byName), totalSessions(bySessions));
    assert.equal(byNameDesc.length, byName.length);
    // subject analytics and the academic structure are cached the same way, per college
    const subs = async (C) => (await get(C.adminToken, "/api/admin/subjects")).data.subjects.reduce((n, s) => n + s.totalClasses, 0);
    const students = async (C) => (await get(C.adminToken, "/api/admin/academic-structure/summary")).data.totalStudents;
    assert.deepEqual([await subs(A), await subs(B)], [3, 0], "B's only session was trashed out-of-band before B's subject cache was filled");
    assert.deepEqual([await students(A), await students(B)], [3, 2]);
    await Student.updateOne({ collegeId: A.collegeId, studentId: "S-3" }, { $set: { isActive: false } });
    assert.deepEqual([await students(A), await students(B)], [3, 2], "cached");
    // once the entries are gone, fresh numbers appear
    analyticsCache.clear();
    assert.equal(totalSessions(await perf(B)), 0);
    assert.equal(await students(A), 2);
  } finally {
    if (prev === undefined) delete process.env.ANALYTICS_CACHE_TTL_MS; else process.env.ANALYTICS_CACHE_TTL_MS = prev;
    analyticsCache.clear();
  }
});

test("cache invalidation: a successful write by a college refreshes ITS dashboards at once and leaves other colleges' cache alone; a failed write changes nothing", async () => {
  const prev = process.env.ANALYTICS_CACHE_TTL_MS;
  process.env.ANALYTICS_CACHE_TTL_MS = "60000";
  analyticsCache.clear();
  try {
    const sessions = async (C) => (await get(C.adminToken, "/api/admin/teacher-performance")).data.teachers.reduce((n, t) => n + t.totalAttendanceSessions, 0);
    assert.deepEqual([await sessions(A), await sessions(B)], [3, 1]);
    // out-of-band change in B: invisible while B's entry lives
    await Attendance.updateOne({ collegeId: B.collegeId }, { $set: { isDeleted: true } });
    // A takes attendance through the API → A's entry is dropped, B's is not
    await take(A.teacherToken, subA1, { date: "2025-01-04", classType: "Theory", students: { "S-1": "present" } });
    assert.equal(await sessions(A), 4, "A sees its own write immediately");
    assert.equal(await sessions(B), 1, "B's cached dataset was not touched by A's write");
    // a failed write (duplicate session → 409) does not invalidate
    await Attendance.updateOne({ collegeId: A.collegeId, date: new Date("2025-01-04T00:00:00.000Z") }, { $set: { isDeleted: true } });
    const dup = await post(A.teacherToken, `/api/attendance/${subA1._id}`, { date: "2025-01-01", classType: "Theory", students: roster({ "S-1": "present" }) });
    assert.equal(dup.status, 409);
    assert.equal(await sessions(A), 4, "still cached after a refused write");
    // B writes through the API → B refreshes and now reflects the out-of-band change too
    assert.equal((await put(B.adminToken, "/api/settings", { consecutiveAbsenceLimit: 2 })).status, 200);
    assert.equal(await sessions(B), 0);
    // a GET never invalidates
    await get(A.adminToken, "/api/admin/academic-structure");
    assert.equal(await sessions(A), 4);
  } finally {
    if (prev === undefined) delete process.env.ANALYTICS_CACHE_TTL_MS; else process.env.ANALYTICS_CACHE_TTL_MS = prev;
    analyticsCache.clear();
  }
});

test("ANALYTICS_CACHE_TTL_MS=0 turns the dashboard cache off: a new session shows up immediately", async () => {
  process.env.ANALYTICS_CACHE_TTL_MS = "0";
  const sessions = async () => (await get(A.adminToken, "/api/admin/teacher-performance")).data.teachers.reduce((n, t) => n + t.totalAttendanceSessions, 0);
  assert.equal(await sessions(), 3);
  await take(A.teacherToken, subA1, { date: "2025-01-04", classType: "Theory", students: { "S-1": "present" } });
  assert.equal(await sessions(), 4);
});

// ═══ Formulas are unchanged (golden values) ═════════════════════════════════

test("subject analytics golden values: one merged aggregation gives the same totals, last date and most-used type as before", async () => {
  // Networks (A): add two more Theory sessions, one trashed → 3 Theory + 1 Lab live sessions
  await take(A.teacherToken, subA1, { date: "2025-01-06", classType: "Theory", students: { "S-1": "present", "S-2": "present", "S-3": "present" } });
  const gone = await take(A.teacherToken, subA1, { date: "2025-01-07", classType: "Theory", students: { "S-1": "absent", "S-2": "absent", "S-3": "absent" } });
  await take(A.teacherToken, subA1, { date: "2025-01-08", classType: "Theory", students: { "S-1": "present", "S-2": "absent", "S-3": "absent" } });
  assert.equal((await call(A.teacherToken, "DELETE", `/api/attendance/${subA1._id}/session/${gone._id}`)).status, 200);
  const row = (await get(A.adminToken, "/api/admin/subjects", { search: "CSE-101" })).data.subjects[0];
  // live sessions: 01-01 (2/3), 01-02 (2/3), 01-06 (3/3), 01-08 (1/3) → 8 of 12
  assert.deepEqual([row.totalClasses, row.attendancePercentage, row.subjectType], [4, 66.7, "Theory"]);
  assert.equal(new Date(row.lastSessionDate).toISOString().slice(0, 10), "2025-01-08", "the trashed 01-07 session does not count; 01-08 is the latest live one");
  // subjects with no sessions keep the legacy fallbacks
  const empty = await newSubject(A.teacherToken, { subjectName: "Empty", subjectCode: "CSE-300" });
  await Subject.updateOne({ _id: empty._id }, { $set: { creditType: "Lab" } }); // legacy field, not settable through the API
  const e = (await get(A.adminToken, "/api/admin/subjects", { search: "CSE-300" })).data.subjects[0];
  assert.deepEqual([e.totalClasses, e.attendancePercentage, e.lastSessionDate, e.subjectType, e.subjectId], [0, 0, null, "Lab", empty._id]);
});

test("pagination, filters and search work on the college's rows only", async () => {
  const page = (await get(A.adminToken, "/api/admin/subjects", { limit: "1", page: "2", sortBy: "name", sortOrder: "asc" })).data;
  assert.deepEqual([page.pagination.total, page.pagination.totalPages, page.subjects.length], [2, 2, 1]);
  assert.equal((await get(B.adminToken, "/api/admin/subjects", { batch: "2024" })).data.pagination.total, 1);
  assert.equal((await get(B.adminToken, "/api/admin/subjects", { search: "CSE-202" })).data.pagination.total, 0, "A's subject code does not exist for B");
  assert.equal((await get(B.adminToken, "/api/admin/teacher-performance", { search: A2.user.name })).data.pagination.total, 0);
});

// ═══ Streak check: one read of the subject's sessions per roster ═══════════

test("countTrailingAbsences: trailing run, reset on present, sessions without the student skipped", () => {
  const s = (...st) => ({ students: st.map(([studentId, status]) => ({ studentId, status })) });
  assert.equal(countTrailingAbsences([], "S-1"), 0);
  assert.equal(countTrailingAbsences([s(["S-1", "absent"]), s(["S-1", "absent"]), s(["S-1", "absent"])], "S-1"), 3);
  assert.equal(countTrailingAbsences([s(["S-1", "absent"]), s(["S-1", "absent"]), s(["S-1", "present"]), s(["S-1", "absent"])], "S-1"), 1);
  assert.equal(countTrailingAbsences([s(["S-1", "absent"]), s(["S-9", "present"]), s(["S-1", "absent"])], "S-1"), 2, "a session the student is not in neither counts nor resets");
  assert.equal(countTrailingAbsences([s(["S-1", "absent"]), s(["S-1", "absent"])], "S-2"), 0);
});

test("checkAndCreateAlerts reads the subject's sessions once for the whole roster and creates the same alerts as before", async () => {
  // College A (limit 3): Networks after these saves → S-1: P P A A A (3) ; S-2: A P A A A (3) ; S-3: P A A A A (4)
  await take(A.teacherToken, subA1, { date: "2025-01-04", classType: "Theory", students: { "S-1": "absent", "S-2": "absent", "S-3": "absent" } });
  await take(A.teacherToken, subA1, { date: "2025-01-05", classType: "Theory", students: { "S-1": "absent", "S-2": "absent", "S-3": "absent" } });
  await take(A.teacherToken, subA1, { date: "2025-01-06", classType: "Theory", students: { "S-1": "absent", "S-2": "absent", "S-3": "absent" } });
  // the automatic checks after each save run in the background: let them finish, then start from a clean slate
  await eventually(async () => (await ConsecutiveAbsenceAlert.countDocuments({ collegeId: A.collegeId })) === 3);
  await settle();
  await ConsecutiveAbsenceAlert.deleteMany({});
  const subjectDoc = await Subject.findById(subA1._id);
  let reads = 0;
  const origFind = Attendance.find;
  Attendance.find = function (...args) { reads += 1; return origFind.apply(this, args); };
  try {
    await checkAndCreateAlerts(subjectDoc, roster({ "S-1": "absent", "S-2": "absent", "S-3": "absent" }), String(A.teacher._id), { collegeId: A.collegeId });
  } finally {
    Attendance.find = origFind;
  }
  assert.equal(reads, 1, "one read of the subject's sessions, not one per student");
  const alerts = await ConsecutiveAbsenceAlert.find({ collegeId: A.collegeId });
  assert.deepEqual(alerts.map((x) => [x.studentId, x.consecutiveMissCount]).sort(), [["S-1", 3], ["S-2", 3], ["S-3", 4]]);
  assert.equal(await ConsecutiveAbsenceAlert.countDocuments({ collegeId: B.collegeId }), 0);
});

test("a tenant that disagrees with the subject's college writes no alert and reads no sessions", async () => {
  const subjectDoc = await Subject.findById(subA1._id);
  let reads = 0;
  const origFind = Attendance.find;
  Attendance.find = function (...args) { reads += 1; return origFind.apply(this, args); };
  try {
    await checkAndCreateAlerts(subjectDoc, roster({ "S-1": "absent" }), String(A.teacher._id), { collegeId: B.collegeId, userId: "x" });
  } finally {
    Attendance.find = origFind;
  }
  assert.equal(reads, 0);
  assert.equal(await ConsecutiveAbsenceAlert.countDocuments({}), 0);
});

// ═══ Index contracts ════════════════════════════════════════════════════════

const idx = (Model) => Model.schema.indexes().map(([key, opts]) => ({ keys: Object.keys(key), key, ...opts }));
/** Is there an index whose first keys are exactly `fields` in any order (an equality-match prefix)? */
const hasPrefixIndex = (Model, fields) => idx(Model).some((i) => i.keys.length >= fields.length && new Set(i.keys.slice(0, fields.length)).size === fields.length && fields.every((f) => i.keys.slice(0, fields.length).includes(f)));

test("every dashboard query shape has a college-led index to use", () => {
  const shapes = [
    [Attendance, ["collegeId", "isDeleted", "subjectId"], "subject analytics: sessions per subject"],
    [Attendance, ["collegeId", "isDeleted", "teacher"], "teacher performance: sessions per teacher"],
    [Attendance, ["collegeId", "isDeleted", "students.studentId"], "student directory / analytics"],
    [Attendance, ["collegeId", "isDeleted", "deletedAt"], "trash statistics"],
    [Attendance, ["collegeId", "subjectId", "date"], "subject sessions by date"],
    [Student, ["collegeId", "isActive", "department", "batch", "shift"], "groups, structure, head-counts"],
    [Student, ["collegeId", "studentId"], "student lookup"],
    [Subject, ["collegeId", "isArchived", "createdAt"], "subject listing"],
    [Subject, ["collegeId", "department", "batch", "shift"], "subjects of a group"],
    [Subject, ["collegeId", "teacher"], "subjects per teacher"],
    [User, ["collegeId", "role", "approved", "createdAt"], "teacher lists"],
    [ConsecutiveAbsenceAlert, ["collegeId", "teacherId", "removed", "createdAt"], "streak reports per teacher"],
    [ConsecutiveAbsenceAlert, ["collegeId", "studentId", "createdAt"], "alert history per student"],
  ];
  for (const [Model, fields, label] of shapes) assert.ok(hasPrefixIndex(Model, fields), `${Model.modelName}: ${label} (${fields})`);
});

test("the dashboard-covering attendance indexes lead with collegeId and carry every field their $group reads", () => {
  const bySubject = idx(Attendance).find((i) => i.name === "analytics_by_subject");
  const byTeacher = idx(Attendance).find((i) => i.name === "analytics_by_teacher");
  assert.ok(bySubject && byTeacher);
  assert.deepEqual(bySubject.keys, ["collegeId", "isDeleted", "subjectId", "classType", "date", "summary.presentCount", "summary.totalStudents"]);
  assert.deepEqual(byTeacher.keys, ["collegeId", "isDeleted", "teacher", "date", "summary.presentCount", "summary.totalStudents"]);
  // the fields the Subject Analytics / Teacher Performance $group stages read
  for (const f of ["subjectId", "classType", "date", "summary.presentCount", "summary.totalStudents"]) assert.ok(bySubject.keys.includes(f), f);
  for (const f of ["teacher", "date", "summary.presentCount", "summary.totalStudents"]) assert.ok(byTeacher.keys.includes(f), f);
  assert.ok(!bySubject.unique && !byTeacher.unique);
});

test("college-led index rule for every college-owned model: any compound index starts with collegeId, except the documented legacy/system ones", () => {
  const allowed = new Set([
    "Attendance:isDeleted,deletedAt",       // nightly purge, spans colleges on purpose
    "Subject:subjectCode,teacher",          // unique per teacher; a teacher belongs to one college (Part 11)
    "Subject:teacher,createdAt",            // pre-Part-9 teacher listing; the college-led { collegeId, teacher } serves scoped queries
    "Student:uploadedBy",                   // single-field
    "Notification:userId,createdAt",        // per user, not per college
    "College:status,searchTokens",          // the colleges themselves
  ]);
  const offenders = [];
  for (const Model of [Attendance, Student, Subject, User, ConsecutiveAbsenceAlert, models.AttendanceCategory, models.Settings, models.Department, models.Shift]) {
    for (const i of idx(Model)) {
      if (i.keys[0] === "collegeId") continue;
      if (i.keys.length === 1) continue; // single-field reference indexes
      if (allowed.has(`${Model.modelName}:${i.keys.join(",")}`)) continue;
      offenders.push(`${Model.modelName}: ${i.keys}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test("the index set builds on the fake driver and the unique per-college rules still hold with the new indexes", async () => {
  // startApp() ran buildSchemaIndexes(), which includes the two analytics indexes; a duplicate session is still refused
  const r = await post(A.teacherToken, `/api/attendance/${subA1._id}`, { date: "2025-01-01", classType: "Theory", students: roster({ "S-1": "present" }) });
  assert.equal(r.status, 409);
  assert.equal((await post(B.teacherToken, `/api/attendance/${subB._id}`, { date: "2025-01-10", classType: "Theory", students: roster({ "S-1": "present" }) })).status, 201);
});

test("sanity: the two colleges really do share identical structure but not rows", async () => {
  assert.deepEqual(
    [await Student.countDocuments({ collegeId: A.collegeId, batch: "2024" }), await Student.countDocuments({ collegeId: B.collegeId, batch: "2024" })],
    [3, 2]
  );
  const u = await User.countDocuments({ role: "teacher", collegeId: A.collegeId });
  assert.equal(u, 2);
});
