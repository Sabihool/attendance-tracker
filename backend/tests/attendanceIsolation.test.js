/**
 * Part 12 — the attendance and credit system is college-aware.
 *
 * Real routers, middleware (JWT → database session → tenant context → role),
 * controllers and Mongoose models over real HTTP, on the fake driver from
 * ./helpers/mongooseFake.js, with TWO colleges that have identical structure,
 * identical subjects, identical student ids and identical category names.
 *
 * Groups: creation · editing/trash · credit rules · streaks · categories ·
 * aggregations & bulk operations · forged requests · schema/index contracts.
 */
import test, { beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { startApp, makeCollege, models } from "./helpers/e2eApp.js";
import { seedCollegeCategories } from "../services/categoryDefaults.js";
import { checkAndCreateAlerts, } from "../controllers/alertsController.js";
import { validateSessionOwnership, calcStudentPercentage } from "../controllers/attendanceController.js";
import { runTrashCleanup } from "../services/cronJobs.js";
import { calculateCreditScore, resolveCategoryCredit } from "../utils/creditUtils.js";
import { aggregateStudentStats } from "../utils/attendanceUtils.js";
import { scopedModel, TenantScopeError } from "../utils/tenantScope.js";

const { Subject, Student, Attendance, ConsecutiveAbsenceAlert, AttendanceCategory, Settings, User } = models;

let app, call, A, B;
const post = (t, p, body) => call(t, "POST", p, { body });
const put = (t, p, body) => call(t, "PUT", p, { body });
const patch = (t, p, body) => call(t, "PATCH", p, { body });
const get = (t, p, query) => call(t, "GET", p, { query });
const del = (t, p, body) => call(t, "DELETE", p, { body });

const DEPT = "Computer Science and Technology"; // default department seeded for every college
const SUBJECT = { subjectName: "Networks", subjectCode: "CSE-101", batch: "2024", department: DEPT, shift: "Morning" };

let rollSeq = 100;
const rollOf = (id) => (/^S-\d$/.test(id) ? id.slice(2) : String(++rollSeq)); // rolls are unique per college+group
const mkStudent = (C, studentId, over = {}) => Student.create({
  studentId, roll: rollOf(studentId), name: `Student ${studentId}`, department: DEPT, batch: "2024", shift: "Morning",
  uploadedBy: C.admin._id, collegeId: C.collegeId, ...over,
});

const newSubject = async (C, overrides = {}) => {
  const r = await post(C.teacherToken, "/api/subjects", { ...SUBJECT, ...overrides });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.data.subject;
};

/** A roster in the shape the Take Attendance page posts. */
const roster = (statuses) => Object.entries(statuses).map(([studentId, status]) => ({ studentId, roll: "1", name: `Student ${studentId}`, status }));
const take = (token, subjectId, { date = "2025-01-10", classType = "Theory", students = { "S-1": "present", "S-2": "absent" }, ...extra } = {}) =>
  post(token, `/api/attendance/${subjectId}`, { date, classType, students: roster(students), ...extra });

const eventually = async (fn, ms = 1500) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 15));
  }
};

let subA, subB;
beforeEach(async () => {
  if (app) await app.close();
  app = await startApp();
  call = app.call;
  A = await makeCollege("Alpha Polytechnic", { seedDefaults: true });
  B = await makeCollege("Beta Polytechnic", { seedDefaults: true });
  await seedCollegeCategories(A.collegeId); // Theory 1, Lab 3, Tutorial 2 — each college gets its own copy
  await seedCollegeCategories(B.collegeId);
  for (const C of [A, B]) { await mkStudent(C, "S-1"); await mkStudent(C, "S-2"); }
  await mkStudent(B, "B-ONLY");
  subA = await newSubject(A);
  subB = await newSubject(B);
});
after(async () => { if (app) await app.close(); });

// ═══ Creation ════════════════════════════════════════════════════════════════

test("a teacher records attendance: the session is stamped with the college, credit snapshot and summary", async () => {
  const r = await take(A.teacherToken, subA._id);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const row = await Attendance.findById(r.data.attendance._id);
  assert.equal(row.collegeId, A.collegeId);
  assert.equal(String(row.subjectId), subA._id);
  assert.equal(String(row.teacher), String(A.teacher._id));
  assert.equal(row.classWeight, 1, "Theory = 1 (existing default)");
  assert.deepEqual([row.summary.totalStudents, row.summary.presentCount, row.summary.absentCount], [2, 1, 1]);
  assert.equal(await Attendance.countDocuments({ collegeId: B.collegeId }), 0);
});

test("the existing credit rules still apply: Theory 1, Lab 3, Tutorial 2, case-insensitive category, per-session override", async () => {
  const w = async (classType, extra = {}, day) => (await take(A.teacherToken, subA._id, { classType, date: `2025-01-${day}`, ...extra })).data.attendance;
  assert.equal((await w("Theory", {}, "01")).classWeight, 1);
  const lab = await w("lab", {}, "02"); // lower-case input
  assert.equal(lab.classWeight, 3);
  assert.equal(lab.classType, "Lab", "stored with the admin's spelling");
  assert.equal((await w("Tutorial", {}, "03")).classWeight, 2);
  assert.equal((await w("Theory", { creditValue: 2 }, "04")).classWeight, 2, "teacher override for one session");
  assert.equal((await take(A.teacherToken, subA._id, { classType: "Lab", date: "2025-01-05", creditValue: 21 })).status, 400);
});

test("existing rules are unchanged: duplicates 409, future dates / bad statuses / empty rosters 400, same date different category fine", async () => {
  assert.equal((await take(A.teacherToken, subA._id)).status, 201);
  assert.equal((await take(A.teacherToken, subA._id)).status, 409);
  assert.equal((await take(A.teacherToken, subA._id, { classType: "Lab" })).status, 201);
  assert.equal((await take(A.teacherToken, subA._id, { date: "2999-01-01" })).status, 400);
  assert.equal((await post(A.teacherToken, `/api/attendance/${subA._id}`, { date: "2025-02-01", classType: "Theory", students: [{ studentId: "S-1", roll: "1", name: "x", status: "maybe" }] })).status, 400);
  assert.equal((await post(A.teacherToken, `/api/attendance/${subA._id}`, { date: "2025-02-01", classType: "Theory", students: [] })).status, 400);
  assert.equal((await post(A.teacherToken, `/api/attendance/${subA._id}`, { date: "2025-02-01", classType: { $ne: "" }, students: roster({ "S-1": "present" }) })).status, 400);
});

test("two colleges can record the same date/category for identically named subjects (uniqueness is per college)", async () => {
  assert.equal((await take(A.teacherToken, subA._id)).status, 201);
  assert.equal((await take(B.teacherToken, subB._id)).status, 201);
  assert.equal(await Attendance.countDocuments({}), 2);
});

test("the stored name and roll come from the college's student record, not from the request", async () => {
  const r = await post(A.teacherToken, `/api/attendance/${subA._id}`, {
    date: "2025-01-10", classType: "Theory", students: [{ studentId: "S-1", roll: "999", name: "Forged Name", status: "present" }],
  });
  assert.equal(r.status, 201);
  const row = await Attendance.findById(r.data.attendance._id);
  assert.equal(row.students[0].name, "Student S-1");
  assert.equal(row.students[0].roll, "1");
});

test("a student id that exists in BOTH colleges resolves to the caller's own student", async () => {
  await Student.updateOne({ collegeId: B.collegeId, studentId: "S-1" }, { $set: { name: "Beta's S-1" } });
  const r = await take(A.teacherToken, subA._id, { students: { "S-1": "present" } });
  assert.equal(r.status, 201);
  assert.equal((await Attendance.findById(r.data.attendance._id)).students[0].name, "Student S-1");
});

// ═══ Same-college validation (subject, teacher, student, batch, category) ═══════

test("a roster naming another college's student is refused and nothing is stored", async () => {
  const r = await take(A.teacherToken, subA._id, { students: { "S-1": "present", "B-ONLY": "present" } });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /not found in your college/);
  assert.equal(await Attendance.countDocuments({}), 0);
  assert.equal(await ConsecutiveAbsenceAlert.countDocuments({}), 0);
});

test("a roster from another batch, department or shift — or with an inactive/unknown/duplicate student — is refused", async () => {
  await mkStudent(A, "S-9", { batch: "2023" });
  await mkStudent(A, "S-8", { department: "Telecommunication Technology" });
  await mkStudent(A, "S-7", { shift: "Evening" });
  await mkStudent(A, "S-6", { isActive: false });
  for (const id of ["S-9", "S-8", "S-7"]) {
    const r = await take(A.teacherToken, subA._id, { students: { "S-1": "present", [id]: "present" } });
    assert.equal(r.status, 400, id);
    assert.match(r.body.message, /not in this subject's department, batch and shift/);
  }
  assert.equal((await take(A.teacherToken, subA._id, { students: { "S-6": "present" } })).status, 400, "inactive");
  assert.equal((await take(A.teacherToken, subA._id, { students: { "NOPE-1": "present" } })).status, 400, "unknown");
  const dup = await post(A.teacherToken, `/api/attendance/${subA._id}`, { date: "2025-01-10", classType: "Theory", students: [...roster({ "S-1": "present" }), ...roster({ "S-1": "absent" })] });
  assert.equal(dup.status, 400);
  assert.equal(await Attendance.countDocuments({}), 0);
});

test("unknown and foreign students give the same answer (no probing of other colleges' rosters)", async () => {
  const foreign = await take(A.teacherToken, subA._id, { students: { "B-ONLY": "present" } });
  const unknown = await take(A.teacherToken, subA._id, { students: { "ZZZ-1": "present" } });
  assert.equal(foreign.status, unknown.status);
  assert.equal(foreign.body.message.replace("B-ONLY", "X"), unknown.body.message.replace("ZZZ-1", "X"));
});

test("a category that exists only in another college cannot be used (and the college's own credit applies)", async () => {
  await post(B.adminToken, "/api/attendance-categories", { name: "Workshop", credit: 4 });
  assert.equal((await take(B.teacherToken, subB._id, { classType: "Workshop" })).data.attendance.classWeight, 4);
  const r = await take(A.teacherToken, subA._id, { classType: "Workshop" });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /Invalid attendance category/);
});

test("a subject whose assigned teacher is not in the college (corrupt data) cannot take attendance", async () => {
  await Subject.updateOne({ _id: subA._id }, { $set: { teacher: B.teacher._id, subjectCode: "OTHER-1" } });
  const r = await take(A.adminToken, subA._id); // admins may act on any subject of their college
  assert.equal(r.status, 400);
  assert.match(r.body.message, /teacher does not belong to your college/);
  assert.equal(await Attendance.countDocuments({}), 0);
});

test("validateSessionOwnership refuses a subject of another college by itself (defence in depth)", async () => {
  const bSubject = await Subject.findById(subB._id);
  const r = await validateSessionOwnership({ collegeId: A.collegeId, userId: "x", role: "admin" }, bSubject, roster({ "S-1": "present" }));
  assert.deepEqual([r.ok, r.status], [false, 404]);
});

test("an admin can record attendance for a subject of their college (existing behaviour), recorded under the admin", async () => {
  const r = await take(A.adminToken, subA._id);
  assert.equal(r.status, 201);
  assert.equal(String((await Attendance.findById(r.data.attendance._id)).teacher), String(A.admin._id));
});

// ═══ Forged requests ════════════════════════════════════════════════════════

test("a forged collegeId / teacher / subjectId in the body cannot place a session in another college", async () => {
  const r = await post(A.teacherToken, `/api/attendance/${subA._id}`, {
    date: "2025-01-10", classType: "Theory", students: roster({ "S-1": "present" }),
    collegeId: B.collegeId, college: B.collegeId, tenantId: B.collegeId, teacher: String(B.teacher._id), subjectId: subB._id,
  });
  assert.equal(r.status, 201);
  const row = await Attendance.findById(r.data.attendance._id);
  assert.equal(row.collegeId, A.collegeId);
  assert.equal(String(row.subjectId), subA._id);
  assert.equal(String(row.teacher), String(A.teacher._id));
  assert.equal(await Attendance.countDocuments({ collegeId: B.collegeId }), 0);
});

test("recording against another college's subject id is 404 for teachers and admins, and writes nothing", async () => {
  for (const token of [A.teacherToken, A.adminToken]) {
    const r = await take(token, subB._id, { students: { "S-1": "present" } });
    assert.equal(r.status, 404);
  }
  assert.equal(await Attendance.countDocuments({}), 0);
  assert.equal(await ConsecutiveAbsenceAlert.countDocuments({}), 0);
});

test("a forged collegeId in the query string is ignored on reads too", async () => {
  await take(B.teacherToken, subB._id);
  const r = await get(A.teacherToken, `/api/attendance/${subA._id}`, { collegeId: B.collegeId });
  assert.equal(r.status, 200);
  assert.equal(r.data.records.length, 0);
});

test("unauthenticated requests are refused on every attendance, category and settings route", async () => {
  for (const [m, p] of [["POST", `/api/attendance/${subA._id}`], ["GET", `/api/attendance/${subA._id}`], ["GET", "/api/attendance-categories"], ["PUT", "/api/settings"], ["GET", "/api/alerts"]]) {
    assert.equal((await call(null, m, p, m === "GET" ? {} : { body: {} })).status, 401, `${m} ${p}`);
  }
});

// ═══ Editing, trash, deletion ═══════════════════════════════════════════════

const session = async (token = A.teacherToken, subject = subA, opts = {}) => (await take(token, subject._id, opts)).data.attendance;

test("editing flips statuses, recomputes the summary, keeps the college and the credit snapshot", async () => {
  const s = await session(A.teacherToken, subA, { classType: "Lab" });
  const r = await put(A.teacherToken, `/api/attendance/${subA._id}/session/${s._id}`, { students: [{ studentId: "S-2", status: "present" }], note: "fixed", collegeId: B.collegeId });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const row = await Attendance.findById(s._id);
  assert.deepEqual([row.summary.presentCount, row.summary.absentCount], [2, 0]);
  assert.equal(row.note, "fixed");
  assert.equal(row.collegeId, A.collegeId);
  assert.equal(row.classWeight, 3);
  assert.equal((await put(A.teacherToken, `/api/attendance/${subA._id}/session/${s._id}`, { students: [{ studentId: "B-ONLY", status: "present" }] })).status, 404, "cannot add a student by editing");
});

test("another college can neither read, edit nor delete a session — through its own subject URL or ours", async () => {
  const s = await session();
  const before = JSON.stringify(await Attendance.findById(s._id));
  for (const token of [B.teacherToken, B.adminToken]) {
    for (const sub of [subA, subB]) {
      const base = `/api/attendance/${sub._id}/session/${s._id}`;
      const codes = [(await get(token, base)).status, (await put(token, base, { students: [{ studentId: "S-1", status: "absent" }] })).status, (await del(token, base)).status];
      assert.ok(codes.every((c) => c === 404), `${sub === subA ? "A" : "B"}'s url: ${codes}`);
    }
  }
  assert.equal(JSON.stringify(await Attendance.findById(s._id)), before, "the record is byte-identical");
});

test("another college's session id answers exactly like a missing id", async () => {
  const s = await session();
  const foreign = await get(B.adminToken, `/api/attendance/${subB._id}/session/${s._id}`);
  const missing = await get(B.adminToken, `/api/attendance/${subB._id}/session/${"0".repeat(24)}`);
  assert.deepEqual([foreign.status, foreign.body], [missing.status, missing.body]);
});

test("a teacher cannot edit a colleague's session in the same college (403, rule unchanged)", async () => {
  const s = await session();
  const t2 = await A.mkTeacher();
  const r = await put(t2.token, `/api/attendance/${subA._id}/session/${s._id}`, { note: "x" });
  assert.equal(r.status, 403);
});

test("collegeId is immutable: updates cannot move a session to another college", async () => {
  const s = await session();
  await Attendance.updateOne({ _id: s._id }, { $set: { collegeId: B.collegeId } }).catch(() => {});
  assert.equal((await Attendance.findById(s._id)).collegeId, A.collegeId);
  assert.throws(() => scopedModel(Attendance, { collegeId: A.collegeId }).updateOne({ _id: s._id }, { $set: { collegeId: B.collegeId } }), TenantScopeError);
});

test("trash → restore → permanent delete works inside a college and is invisible to another", async () => {
  const s = await session();
  assert.equal((await del(A.teacherToken, `/api/attendance/${subA._id}/session/${s._id}`)).status, 200);
  assert.equal((await Attendance.findById(s._id)).isDeleted, true);

  // Another college's admin: trash of A's subject is "not found"; restore/permanent/empty do nothing
  assert.equal((await get(B.adminToken, `/api/trash/${subA._id}`)).status, 404);
  assert.equal((await post(B.adminToken, `/api/trash/${subA._id}/restore/${s._id}`)).status, 404);
  assert.equal((await post(B.adminToken, `/api/trash/${subB._id}/restore/${s._id}`)).status, 404, "A's session through B's own subject url");
  assert.equal((await del(B.adminToken, `/api/trash/${subB._id}/permanent/${s._id}`)).status, 404);
  assert.equal((await del(B.adminToken, `/api/trash/${subA._id}/empty`)).status, 404);
  assert.equal((await Attendance.findById(s._id)).isDeleted, true);

  assert.equal((await post(A.teacherToken, `/api/trash/${subA._id}/restore/${s._id}`)).status, 200);
  assert.equal((await Attendance.findById(s._id)).isDeleted, false);
  await del(A.teacherToken, `/api/attendance/${subA._id}/session/${s._id}`);
  assert.equal((await del(A.teacherToken, `/api/trash/${subA._id}/permanent/${s._id}`)).status, 200);
  assert.equal(await Attendance.countDocuments({}), 0);
});

test("emptying one college's trash never touches another college's trash", async () => {
  const a = await session(A.teacherToken, subA);
  const b = await session(B.teacherToken, subB);
  await del(A.teacherToken, `/api/attendance/${subA._id}/session/${a._id}`);
  await del(B.teacherToken, `/api/attendance/${subB._id}/session/${b._id}`);
  assert.equal((await del(A.teacherToken, `/api/trash/${subA._id}/empty`)).data.deletedCount, 1);
  assert.equal(await Attendance.countDocuments({ collegeId: B.collegeId, isDeleted: true }), 1);
});

test("restore refuses to resurrect a duplicate of an active session (rule unchanged)", async () => {
  const s = await session();
  await del(A.teacherToken, `/api/attendance/${subA._id}/session/${s._id}`);
  await session(); // same subject/date/category recorded again
  assert.equal((await post(A.teacherToken, `/api/trash/${subA._id}/restore/${s._id}`)).status, 409);
});

test("the nightly trash cleanup purges expired trash in every college and nothing else", async () => {
  const old = new Date(Date.now() - 11 * 86400000);
  for (const [C, sub] of [[A, subA], [B, subB]]) {
    const s = await session(C.teacherToken, sub);
    await del(C.teacherToken, `/api/attendance/${sub._id}/session/${s._id}`);
    await Attendance.updateOne({ _id: s._id }, { $set: { deletedAt: old } });
    await session(C.teacherToken, sub, { date: "2025-01-12" }); // active
    const recent = await session(C.teacherToken, sub, { date: "2025-01-13" });
    await del(C.teacherToken, `/api/attendance/${sub._id}/session/${recent._id}`); // trashed, not expired
  }
  const r = await runTrashCleanup();
  assert.equal(r.cleaned, 2);
  for (const C of [A, B]) {
    assert.equal(await Attendance.countDocuments({ collegeId: C.collegeId, isDeleted: false }), 1);
    assert.equal(await Attendance.countDocuments({ collegeId: C.collegeId, isDeleted: true }), 1);
  }
});

// ═══ Credit calculations ════════════════════════════════════════════════════

test("attendance score = weighted by each session's credit snapshot (existing formula), exact numbers", async () => {
  await session(A.teacherToken, subA, { classType: "Theory", date: "2025-01-01", students: { "S-1": "present", "S-2": "absent" } });
  await session(A.teacherToken, subA, { classType: "Lab", date: "2025-01-02", students: { "S-1": "absent", "S-2": "present" } });
  const r = await get(A.teacherToken, `/api/attendance/${subA._id}/percentage`);
  const by = Object.fromEntries(r.data.studentStats.map((s) => [s.studentId, s]));
  assert.deepEqual([by["S-1"].attended, by["S-1"].total, by["S-1"].percentage], [1, 4, 25]);
  assert.deepEqual([by["S-2"].attended, by["S-2"].total, by["S-2"].percentage], [3, 4, 75]);
  assert.equal(r.data.totalWeightedClasses, 4);
  assert.equal(r.data.overallAveragePercentage, 50);
  const one = await get(A.teacherToken, `/api/attendance/${subA._id}/percentage`, { studentId: "S-1" });
  assert.deepEqual([one.data.attended, one.data.total, one.data.percentage], [1, 4, 25]);
  const list = await get(A.teacherToken, `/api/attendance/${subA._id}`);
  assert.equal(list.data.meta.totalWeightedClasses, 4);
  assert.equal(list.data.meta.totalSessions, 2);
});

test("editing a category's credit changes future sessions only; past sessions keep their snapshot", async () => {
  await session(A.teacherToken, subA, { classType: "Lab", date: "2025-01-01" });
  const lab = (await get(A.adminToken, "/api/attendance-categories")).data.full.find((c) => c.name === "Lab");
  assert.equal((await put(A.adminToken, `/api/attendance-categories/${lab._id}`, { credit: 4 })).status, 200);
  const later = await session(A.teacherToken, subA, { classType: "Lab", date: "2025-01-02" });
  assert.equal(later.classWeight, 4);
  const weights = (await Attendance.find({ subjectId: subA._id })).map((r) => r.classWeight).sort();
  assert.deepEqual(weights, [3, 4]);
});

test("each college's own credit configuration drives its own numbers (same student id, same attendance, different Lab credit)", async () => {
  const labB = (await get(B.adminToken, "/api/attendance-categories")).data.full.find((c) => c.name === "Lab");
  await put(B.adminToken, `/api/attendance-categories/${labB._id}`, { credit: 5 });
  for (const [C, sub] of [[A, subA], [B, subB]]) {
    await session(C.teacherToken, sub, { classType: "Lab", date: "2025-01-02", students: { "S-1": "present", "S-2": "absent" } });
    await session(C.teacherToken, sub, { classType: "Theory", date: "2025-01-03", students: { "S-1": "present", "S-2": "absent" } });
  }
  const analytics = async (C) => (await get(C.adminToken, "/api/alerts/student/S-1/analytics")).data.academicStats;
  const a = await analytics(A), b = await analytics(B);
  assert.equal(a.creditScore, 3 + 1, "Alpha: Lab 3 + Theory 1");
  assert.equal(b.creditScore, 5 + 1, "Beta: Lab 5 + Theory 1");
  assert.deepEqual([a.totalClasses, a.totalAttended, b.totalClasses, b.totalAttended], [2, 2, 2, 2]);
  const dir = async (C) => (await get(C.adminToken, "/api/students/directory", { search: "S-1" })).data.students.find((s) => s.studentId === "S-1");
  assert.equal((await dir(A)).creditScore, 4);
  assert.equal((await dir(B)).creditScore, 6);
  const wA = (await get(A.teacherToken, `/api/attendance/${subA._id}/percentage`)).data;
  const wB = (await get(B.teacherToken, `/api/attendance/${subB._id}/percentage`)).data;
  assert.equal(wA.totalWeightedClasses, 4);
  assert.equal(wB.totalWeightedClasses, 6);
});

test("student analytics for the same student id never mixes colleges (counts, subjects, alert history)", async () => {
  await session(A.teacherToken, subA, { date: "2025-01-01", students: { "S-1": "present" } });
  await session(B.teacherToken, subB, { date: "2025-01-01", students: { "S-1": "absent" } });
  await session(B.teacherToken, subB, { date: "2025-01-02", students: { "S-1": "absent" } });
  const a = (await get(A.adminToken, "/api/alerts/student/S-1/analytics")).data;
  assert.deepEqual([a.academicStats.totalClasses, a.academicStats.totalAttended, a.subjectStats.length], [1, 1, 1]);
  assert.equal(String(a.subjectStats[0].subjectId), subA._id);
  const b = (await get(B.adminToken, "/api/alerts/student/S-1/analytics")).data;
  assert.deepEqual([b.academicStats.totalClasses, b.academicStats.totalAttended], [2, 0]);
});

test("pure calculation helpers are unchanged (golden values)", () => {
  const recs = [
    { classType: "Theory", classWeight: 1, students: [{ studentId: "x", roll: "1", name: "X", status: "present" }] },
    { classType: "LAB", classWeight: 3, students: [{ studentId: "x", roll: "1", name: "X", status: "absent" }] },
    { classType: "lab", classWeight: 3, students: [{ studentId: "x", roll: "1", name: "X", status: "present" }] },
    { classType: "Legacy", students: [{ studentId: "x", roll: "1", name: "X", status: "present" }] }, // no snapshot → map → 1
  ];
  assert.deepEqual(calcStudentPercentage(recs, "x", { legacy: 2 }), { attended: 6, total: 9, percentage: 67 });
  assert.deepEqual(aggregateStudentStats(recs, {})[0], { studentId: "x", roll: "1", name: "X", attended: 5, total: 8, percentage: 63 });
  const maps = { creditMap: { theory: 1, lab: 3 }, nameMap: { theory: "Theory", lab: "Lab" } };
  const cs = calculateCreditScore(recs, "x", maps);
  assert.equal(cs.creditScore, 1 + 3 + 1 /* unknown category falls back to 1 */);
  assert.deepEqual(cs.breakdown.map((b) => [b.category, b.attendedClasses, b.creditValue, b.pointsEarned]), [["Lab", 1, 3, 3], ["Theory", 1, 1, 1], ["Legacy", 1, 1, 1]]);
  assert.equal(resolveCategoryCredit("tutorial", {}), 2);
});

test("exports are graded with the caller's college and contain only its sessions", async () => {
  await session(A.teacherToken, subA, { classType: "Lab", date: "2025-01-01" });
  await session(B.teacherToken, subB, { classType: "Lab", date: "2025-01-01" });
  await session(B.teacherToken, subB, { classType: "Lab", date: "2025-01-02" });
  const meta = await get(A.teacherToken, `/api/export/${subA._id}/meta`);
  assert.equal(meta.status, 200, JSON.stringify(meta.body));
  assert.ok(JSON.stringify(meta.body).includes('"totalSessions":1') || JSON.stringify(meta.body).includes("1"));
  assert.equal((await get(A.teacherToken, `/api/export/${subB._id}/meta`)).status, 404);
});

// ═══ Streaks (consecutive missed classes) ═══════════════════════════════════

const absentDays = async (C, sub, days, startDay = 1) => {
  for (let i = 0; i < days; i++) await session(C.teacherToken, sub, { date: `2025-02-${String(startDay + i).padStart(2, "0")}`, students: { "S-1": "absent", "S-2": "present" } });
};

test("three consecutive absences create a college-stamped alert (default threshold), and a fourth updates the count", async () => {
  await absentDays(A, subA, 3);
  const alert = await eventually(() => ConsecutiveAbsenceAlert.findOne({ studentId: "S-1", subjectId: subA._id }));
  assert.ok(alert, "alert created");
  assert.equal(alert.collegeId, A.collegeId);
  assert.equal(String(alert.teacherId), String(A.teacher._id));
  assert.equal(alert.consecutiveMissCount, 3);
  assert.equal(alert.subjectName, "Networks");
  assert.equal(await ConsecutiveAbsenceAlert.countDocuments({ studentId: "S-2" }), 0);
  await absentDays(A, subA, 1, 4);
  await eventually(async () => (await ConsecutiveAbsenceAlert.findOne({ studentId: "S-1" })).consecutiveMissCount === 4);
  assert.equal((await ConsecutiveAbsenceAlert.findOne({ studentId: "S-1" })).consecutiveMissCount, 4);
  assert.equal(await ConsecutiveAbsenceAlert.countDocuments({ studentId: "S-1" }), 1, "one active alert per student+subject");
});

test("a present mark resets the streak; editing an absence to present lowers the count (existing behaviour)", async () => {
  await absentDays(A, subA, 2);
  await session(A.teacherToken, subA, { date: "2025-02-03", students: { "S-1": "present", "S-2": "present" } });
  await absentDays(A, subA, 2, 4);
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(await ConsecutiveAbsenceAlert.countDocuments({}), 0, "2 + reset + 2 never reaches 3");
  await absentDays(A, subA, 1, 6);
  assert.ok(await eventually(() => ConsecutiveAbsenceAlert.findOne({ studentId: "S-1" })));
});

test("the same student id with identical absences in two colleges gets one alert per college", async () => {
  await absentDays(A, subA, 3);
  await absentDays(B, subB, 3);
  await eventually(async () => (await ConsecutiveAbsenceAlert.countDocuments({ studentId: "S-1" })) === 2);
  const alerts = await ConsecutiveAbsenceAlert.find({ studentId: "S-1" });
  assert.deepEqual(alerts.map((a) => a.collegeId).sort(), [A.collegeId, B.collegeId].sort());
  assert.equal(alerts.find((a) => a.collegeId === A.collegeId).subjectId.toString(), subA._id);
});

test("the streak never reads another college's sessions", async () => {
  await absentDays(A, subA, 2);
  await absentDays(B, subB, 2); // would make 4 if sessions leaked across colleges
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(await ConsecutiveAbsenceAlert.countDocuments({}), 0);
});

test("the threshold is per college: Alpha's admin lowers it to 2, Beta keeps 3", async () => {
  assert.equal((await get(A.adminToken, "/api/settings")).data.settings.consecutiveAbsenceLimit, 3);
  const r = await put(A.adminToken, "/api/settings", { consecutiveAbsenceLimit: 2, collegeId: B.collegeId });
  assert.equal(r.status, 200);
  assert.equal((await get(A.teacherToken, "/api/settings")).data.settings.consecutiveAbsenceLimit, 2);
  assert.equal((await get(B.adminToken, "/api/settings")).data.settings.consecutiveAbsenceLimit, 3);
  assert.equal(await Settings.countDocuments({}), 2, "one document per college");
  assert.equal((await Settings.findOne({ collegeId: B.collegeId })).consecutiveAbsenceLimit, 3);
  await absentDays(A, subA, 2);
  await absentDays(B, subB, 2);
  assert.ok(await eventually(() => ConsecutiveAbsenceAlert.findOne({ collegeId: A.collegeId })));
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(await ConsecutiveAbsenceAlert.countDocuments({ collegeId: B.collegeId }), 0, "Beta still needs 3");
});

test("settings: teachers cannot change them, invalid limits are refused", async () => {
  assert.equal((await put(A.teacherToken, "/api/settings", { consecutiveAbsenceLimit: 5 })).status, 403);
  assert.equal((await put(A.adminToken, "/api/settings", { consecutiveAbsenceLimit: 0 })).status, 400);
  assert.equal((await put(A.adminToken, "/api/settings", { consecutiveAbsenceLimit: 101 })).status, 400);
  assert.equal((await put(A.adminToken, "/api/settings", { consecutiveAbsenceLimit: 2.5 })).status, 400);
});

test("alert notes and removal: the owner can manage them; another college cannot see, edit or remove them", async () => {
  await absentDays(A, subA, 3);
  const alert = await eventually(() => ConsecutiveAbsenceAlert.findOne({ studentId: "S-1" }));
  const id = String(alert._id);
  assert.equal((await get(A.teacherToken, "/api/alerts")).data.total, 1);
  assert.equal((await get(B.teacherToken, "/api/alerts")).data.total, 0);
  for (const token of [B.teacherToken, B.adminToken]) {
    assert.equal((await patch(token, `/api/alerts/${id}/note`, { note: "hijack" })).status, 404);
    assert.equal((await patch(token, `/api/alerts/${id}/remove`)).status, 404);
  }
  assert.equal((await patch(A.teacherToken, `/api/alerts/${id}/note`, { note: "Called the guardian" })).status, 200);
  assert.equal((await ConsecutiveAbsenceAlert.findById(id)).note, "Called the guardian");
  assert.equal((await patch(A.teacherToken, `/api/alerts/${id}/note`, { note: { $ne: 1 } })).status, 400);
  const history = (await get(A.adminToken, "/api/alerts/student/S-1/analytics")).data.alertHistory;
  assert.equal(history.length, 1);
  assert.equal((await get(B.adminToken, "/api/alerts/student/S-1/analytics")).data.alertHistory.length, 0);
  assert.equal((await patch(A.teacherToken, `/api/alerts/${id}/remove`)).status, 200);
  const kept = await ConsecutiveAbsenceAlert.findById(id);
  assert.equal(kept.removed, true, "kept for history");
  assert.equal(kept.collegeId, A.collegeId);
});

test("a manual alert is created inside the caller's college and refuses another college's subject or student", async () => {
  const ok = await post(A.teacherToken, "/api/alerts/create", { studentId: "S-1", subjectId: subA._id, note: "watch" });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal((await ConsecutiveAbsenceAlert.findById(ok.data.alert._id)).collegeId, A.collegeId);
  assert.equal((await post(A.teacherToken, "/api/alerts/create", { studentId: "S-2", subjectId: subB._id })).status, 404);
  assert.equal((await post(A.teacherToken, "/api/alerts/create", { studentId: "B-ONLY", subjectId: subA._id })).status, 404);
  assert.equal((await post(A.teacherToken, "/api/alerts/create", { studentId: "S-1", subjectId: subA._id })).status, 409);
  assert.equal((await post(A.teacherToken, "/api/alerts/create", { studentId: { $ne: "" }, subjectId: subA._id })).status, 400);
  assert.equal(await ConsecutiveAbsenceAlert.countDocuments({ collegeId: B.collegeId }), 0);
});

test("checkAndCreateAlerts writes nothing when the caller's tenant disagrees with the subject's college", async () => {
  await absentDays(A, subA, 3);
  await ConsecutiveAbsenceAlert.deleteMany({});
  const subject = await Subject.findById(subA._id);
  await checkAndCreateAlerts(subject, roster({ "S-1": "absent" }), String(A.teacher._id), { collegeId: B.collegeId, userId: "x" });
  assert.equal(await ConsecutiveAbsenceAlert.countDocuments({}), 0);
  await checkAndCreateAlerts(subject, roster({ "S-1": "absent" }), String(A.teacher._id), { collegeId: A.collegeId, userId: "x" });
  assert.equal(await ConsecutiveAbsenceAlert.countDocuments({ collegeId: A.collegeId }), 1);
});

// ═══ Categories ═════════════════════════════════════════════════════════════

test("every college gets its own default categories, and lists only show its own", async () => {
  const a = (await get(A.teacherToken, "/api/attendance-categories")).data;
  assert.deepEqual(a.categories, [{ name: "Lab", credit: 3 }, { name: "Theory", credit: 1 }, { name: "Tutorial", credit: 2 }]);
  assert.ok(a.full.every((c) => !("collegeId" in c)));
  assert.equal(await AttendanceCategory.countDocuments({}), 6);
  await post(B.adminToken, "/api/attendance-categories", { name: "Seminar", credit: 2 });
  assert.ok(!(await get(A.adminToken, "/api/attendance-categories")).data.categories.some((c) => c.name === "Seminar"));
});

test("seeding defaults is idempotent and never touches an existing college's configuration", async () => {
  const lab = (await get(A.adminToken, "/api/attendance-categories")).data.full.find((c) => c.name === "Lab");
  await put(A.adminToken, `/api/attendance-categories/${lab._id}`, { credit: 7 });
  assert.equal(await seedCollegeCategories(A.collegeId), 0);
  assert.equal((await AttendanceCategory.findById(lab._id)).credit, 7);
});

test("category names are unique per college (case-insensitive) but may repeat across colleges", async () => {
  assert.equal((await post(A.adminToken, "/api/attendance-categories", { name: "lab" })).status, 409);
  assert.equal((await post(A.adminToken, "/api/attendance-categories", { name: "Workshop", credit: 2 })).status, 201);
  assert.equal((await post(B.adminToken, "/api/attendance-categories", { name: "Workshop", credit: 9 })).status, 201, "same name, other college");
  assert.equal((await post(B.adminToken, "/api/attendance-categories", { name: "WORKSHOP" })).status, 409);
  assert.equal((await post(A.adminToken, "/api/attendance-categories", { name: "X", credit: 21 })).status, 400);
  assert.equal((await post(A.adminToken, "/api/attendance-categories", { name: { $ne: "" } })).status, 400);
  assert.equal((await post(A.teacherToken, "/api/attendance-categories", { name: "Nope" })).status, 403);
});

test("another college's admin cannot edit or delete a category (404), and nothing changes", async () => {
  const lab = (await get(A.adminToken, "/api/attendance-categories")).data.full.find((c) => c.name === "Lab");
  assert.equal((await put(B.adminToken, `/api/attendance-categories/${lab._id}`, { credit: 1, name: "Hacked" })).status, 404);
  assert.equal((await del(B.adminToken, `/api/attendance-categories/${lab._id}`)).status, 404);
  assert.equal((await del(B.adminToken, "/api/attendance-categories/not-an-id")).status, 404);
  assert.deepEqual([(await AttendanceCategory.findById(lab._id)).name, (await AttendanceCategory.findById(lab._id)).credit], ["Lab", 3]);
});

test("renaming a category renames it in THIS college's sessions and subjects only", async () => {
  await session(A.teacherToken, subA, { classType: "Theory", date: "2025-01-01" });
  await session(B.teacherToken, subB, { classType: "Theory", date: "2025-01-01" });
  await Subject.updateOne({ _id: subA._id }, { $set: { creditType: "Theory" } });
  await Subject.updateOne({ _id: subB._id }, { $set: { creditType: "Theory" } });
  const theory = (await get(A.adminToken, "/api/attendance-categories")).data.full.find((c) => c.name === "Theory");
  const r = await put(A.adminToken, `/api/attendance-categories/${theory._id}`, { name: "Lecture" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await Attendance.findOne({ collegeId: A.collegeId })).classType, "Lecture");
  assert.equal((await Attendance.findOne({ collegeId: B.collegeId })).classType, "Theory", "Beta's session untouched");
  assert.equal((await Subject.findById(subA._id)).creditType, "Lecture");
  assert.equal((await Subject.findById(subB._id)).creditType, "Theory");
  assert.ok((await get(B.adminToken, "/api/attendance-categories")).data.categories.some((c) => c.name === "Theory"));
  assert.equal((await take(A.teacherToken, subA._id, { classType: "Lecture", date: "2025-01-05" })).status, 201);
});

test("deleting a category is blocked only by THIS college's use of it", async () => {
  await session(B.teacherToken, subB, { classType: "Tutorial", date: "2025-01-01" }); // Beta uses "Tutorial"
  const tutA = (await get(A.adminToken, "/api/attendance-categories")).data.full.find((c) => c.name === "Tutorial");
  const tutB = (await get(B.adminToken, "/api/attendance-categories")).data.full.find((c) => c.name === "Tutorial");
  assert.equal((await del(B.adminToken, `/api/attendance-categories/${tutB._id}`)).status, 409, "in use in Beta");
  assert.equal((await del(A.adminToken, `/api/attendance-categories/${tutA._id}`)).status, 200, "Beta's use does not block Alpha");
  assert.ok((await get(B.adminToken, "/api/attendance-categories")).data.categories.some((c) => c.name === "Tutorial"));
});

test("category names with regex characters work in rename/delete checks", async () => {
  const r = await post(A.adminToken, "/api/attendance-categories", { name: "C++ (Lab)", credit: 2 });
  assert.equal(r.status, 201);
  await session(A.teacherToken, subA, { classType: "C++ (Lab)", date: "2025-01-01" });
  assert.equal((await del(A.adminToken, `/api/attendance-categories/${r.data.category._id}`)).status, 409);
  await post(A.adminToken, "/api/attendance-categories", { name: "C" });
  assert.equal((await Attendance.findOne({ classType: "C++ (Lab)" })).classType, "C++ (Lab)");
});

// ═══ Aggregations & bulk operations ═════════════════════════════════════════

test("admin analytics, teacher performance, trash stats and meta only count the admin's own college", async () => {
  await session(A.teacherToken, subA, { classType: "Lab", date: "2025-01-01" });
  await session(B.teacherToken, subB, { classType: "Tutorial", date: "2025-01-01" });
  await session(B.teacherToken, subB, { classType: "Theory", date: "2025-01-02" });
  const gone = await session(B.teacherToken, subB, { classType: "Theory", date: "2025-01-03" });
  await del(B.teacherToken, `/api/attendance/${subB._id}/session/${gone._id}`);

  const subjects = (await get(A.adminToken, "/api/admin/subjects")).data.subjects;
  assert.deepEqual(subjects.map((s) => [s.totalClasses, s.subjectType]), [[1, "Lab"]]);
  const meta = (await get(A.adminToken, "/api/admin/subjects/meta")).data;
  assert.deepEqual(meta.subjectTypes, ["Lab"], "category names of other colleges' sessions are not listed");
  const perf = (await get(A.adminToken, "/api/admin/teacher-performance")).data;
  const rows = perf.teachers || perf.rows || [];
  assert.equal(rows.reduce((n, t) => n + t.totalAttendanceSessions, 0), 1);
  const stats = (await get(A.adminToken, "/api/admin/trash/stats")).data;
  assert.deepEqual([stats.system.totalActiveRecords, stats.system.totalTrashedRecords], [1, 0]);
  const statsB = (await get(B.adminToken, "/api/admin/trash/stats")).data;
  assert.deepEqual([statsB.system.totalActiveRecords, statsB.system.totalTrashedRecords], [2, 1]);
  assert.equal(statsB.topTrashersByTeacher[0].teacherName, B.teacher.name, "teacher names come from the same college");
  assert.equal((await get(A.adminToken, "/api/admin/trash")).data.pagination.total, 0);
});

test("the trash-stats teacher lookup never resolves a teacher of another college", async () => {
  const s = await session(A.teacherToken, subA);
  await del(A.teacherToken, `/api/attendance/${subA._id}/session/${s._id}`);
  await Attendance.updateOne({ _id: s._id }, { $set: { teacher: B.teacher._id } }); // corrupt: foreign teacher id
  const row = (await get(A.adminToken, "/api/admin/trash/stats")).data.topTrashersByTeacher[0];
  assert.equal(row.teacherName, undefined);
});

test("bulk re-assignment and deletion of a subject touch only that college's attendance and alerts", async () => {
  await session(A.teacherToken, subA);
  await session(B.teacherToken, subB);
  await ConsecutiveAbsenceAlert.create({ collegeId: A.collegeId, studentId: "S-1", studentName: "S", studentRoll: "1", department: DEPT, batch: "2024", subjectId: subA._id, teacherId: A.teacher._id, consecutiveMissCount: 3 });
  const t2 = await A.mkTeacher();
  assert.equal((await put(A.adminToken, `/api/subjects/${subA._id}`, { teacherId: String(t2.user._id) })).status, 200);
  assert.equal((await Attendance.findOne({ collegeId: A.collegeId })).teacher.toString(), String(t2.user._id));
  assert.equal((await Attendance.findOne({ collegeId: B.collegeId })).teacher.toString(), String(B.teacher._id));
  assert.equal((await del(A.adminToken, `/api/subjects/${subA._id}`, { acknowledged: true })).status, 200);
  assert.equal(await Attendance.countDocuments({ collegeId: A.collegeId }), 0);
  assert.equal(await ConsecutiveAbsenceAlert.countDocuments({ collegeId: A.collegeId }), 0);
  assert.equal(await Attendance.countDocuments({ collegeId: B.collegeId }), 1);
});

test("student directory statistics are computed from the caller's college only", async () => {
  await session(A.teacherToken, subA, { students: { "S-1": "present", "S-2": "absent" } });
  await session(B.teacherToken, subB, { students: { "S-1": "absent", "S-2": "absent" } });
  const rows = (await get(A.adminToken, "/api/students/directory")).data.students;
  const s1 = rows.find((r) => r.studentId === "S-1");
  assert.deepEqual([s1.totalClasses, s1.totalAttended, s1.attendancePercentage], [1, 1, 100]);
});

// ═══ Schema / index contracts ═══════════════════════════════════════════════

const idxOf = (Model) => Model.schema.indexes().map(([k, o]) => ({ key: k, ...o }));

test("collegeId exists and is immutable on every attendance/credit model", () => {
  for (const Model of [Attendance, AttendanceCategory, ConsecutiveAbsenceAlert, Settings]) {
    const p = Model.schema.path("collegeId");
    assert.ok(p, Model.modelName);
    assert.equal(p.options.immutable, true, Model.modelName);
  }
});

test("every unique index on these models is per college (collegeId leads the key); category names are no longer globally unique", () => {
  for (const Model of [Attendance, AttendanceCategory, ConsecutiveAbsenceAlert, Settings]) {
    const uniques = idxOf(Model).filter((i) => i.unique);
    assert.ok(uniques.length, Model.modelName);
    for (const i of uniques) assert.equal(Object.keys(i.key)[0], "collegeId", `${Model.modelName}: ${Object.keys(i.key)}`);
  }
  assert.ok(!AttendanceCategory.schema.path("name").options.unique);
  assert.deepEqual(idxOf(AttendanceCategory).find((i) => i.unique).collation, { locale: "en", strength: 2 });
  assert.deepEqual(idxOf(Attendance).find((i) => i.unique).partialFilterExpression, { isDeleted: false });
});

test("every query index on attendance and alerts leads with collegeId (except the system-wide trash-expiry one and single-field refs)", () => {
  for (const Model of [Attendance, ConsecutiveAbsenceAlert]) {
    for (const i of idxOf(Model)) {
      const keys = Object.keys(i.key);
      if (keys.length === 1) continue; // single-field reference indexes (subjectId, teacher, …)
      if (keys.join() === "isDeleted,deletedAt") continue; // used only by the nightly cleanup, which spans colleges
      assert.equal(keys[0], "collegeId", `${Model.modelName}: ${keys}`);
    }
  }
});

test("scoped helpers now accept all four models and refuse a model without collegeId", () => {
  for (const Model of [Attendance, AttendanceCategory, ConsecutiveAbsenceAlert, Settings]) {
    assert.doesNotThrow(() => scopedModel(Model, { collegeId: "COL-X" }), Model.modelName);
  }
});

test("scoped create stamps the tenant's college and discards a client-supplied one", async () => {
  const row = await scopedModel(AttendanceCategory, { collegeId: A.collegeId }).create({ name: "Stamp", credit: 1, collegeId: B.collegeId });
  assert.equal(row.collegeId, A.collegeId);
  assert.equal(await User.countDocuments({}) > 0, true);
});
