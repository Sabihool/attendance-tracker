/**
 * Part 14 — public "See Your Attendance" lookup.
 *
 * Real router + controller + models over real HTTP on the fake driver, with TWO
 * colleges whose department, batch, shift, ROLL NUMBER and registration number
 * are all IDENTICAL but whose students and attendance differ. The endpoint has
 * no login, so every assertion is about scoping and data minimisation.
 */
import test, { beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";

// Limits are read when the router module loads, so set them BEFORE importing it.
process.env.PUBLIC_LOOKUP_MAX = "100000";
process.env.PUBLIC_LOOKUP_FAIL_IP_MAX = "100000";
process.env.PUBLIC_LOOKUP_FAIL_MAX = "6"; // 6 failed guesses per IP+college, then 429

const { startApp, makeCollege, models } = await import("./helpers/e2eApp.js");
const { seedCollegeCategories } = await import("../services/categoryDefaults.js");
const { analyticsCache } = await import("../utils/analyticsCache.js");
const { validateLookupInput } = await import("../validators/publicLookupValidator.js");
const { createFailureLimiter } = await import("../middleware/rateLimit.js");
const { NOT_FOUND_MESSAGE, AMBIGUOUS_MESSAGE } = await import("../controllers/publicAttendanceController.js");

const { Subject, Student, Attendance, College, ConsecutiveAbsenceAlert } = models;
process.env.ANALYTICS_CACHE_TTL_MS = "0";

const DEPT = "Computer Science and Technology";
const SAME = { batch: "2024", department: DEPT, shift: "Morning" };
const ROLL = "17"; // the SAME roll number in both colleges

let app, call, A, B, studA, studB;
const post = (t, p, body) => call(t, "POST", p, { body });
const lookup = (body) => post(null, "/api/public/attendance/lookup", body);
const form = (C, over = {}) => ({ collegeId: C.collegeId, ...SAME, roll: ROLL, ...over });

const mkStudent = (C, over = {}) => Student.create({
  studentId: "REG-100", roll: ROLL, name: `Student of ${C.collegeId}`, ...SAME, email: "secret@student.example",
  uploadedBy: C.admin._id, collegeId: C.collegeId, ...over,
});
const newSubject = async (token, over = {}) => {
  const r = await post(token, "/api/subjects", { subjectName: "Networks", subjectCode: "CSE-101", ...SAME, ...over });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.data.subject;
};
const take = async (token, subject, { date, classType = "Theory", students }) => {
  const roster = Object.entries(students).map(([studentId, status]) => ({ studentId, roll: ROLL, name: "x", status }));
  const r = await post(token, `/api/attendance/${subject._id}`, { date, classType, students: roster });
  assert.equal(r.status, 201, JSON.stringify(r.body));
};

/**
 * Both colleges: ONE student, registration "REG-100", roll 17, same group — different people.
 *   College A: Networks Theory P, Networks Lab P, Networks Theory A  → 2/3 (67 %), credit Theory1 + Lab3 = 4
 *   College B: Networks Theory A, Networks Theory A                  → 0/2 (0 %)
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
  studA = await mkStudent(A, { name: "Anika Alpha" });
  studB = await mkStudent(B, { name: "Bashir Beta" });
  const subA = await newSubject(A.teacherToken);
  const subB = await newSubject(B.teacherToken);
  await take(A.teacherToken, subA, { date: "2025-01-01", classType: "Theory", students: { "REG-100": "present" } });
  await take(A.teacherToken, subA, { date: "2025-01-02", classType: "Lab", students: { "REG-100": "present" } });
  await take(A.teacherToken, subA, { date: "2025-01-03", classType: "Theory", students: { "REG-100": "absent" } });
  await take(B.teacherToken, subB, { date: "2025-01-01", classType: "Theory", students: { "REG-100": "absent" } });
  await take(B.teacherToken, subB, { date: "2025-01-02", classType: "Theory", students: { "REG-100": "absent" } });
});
after(async () => { if (app) await app.close(); });

// ═══ identical roll numbers across two colleges ═══

test("identical roll in two colleges: each lookup returns ONLY its own college's student and numbers", async () => {
  const a = await lookup(form(A));
  const b = await lookup(form(B));
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.equal(b.status, 200, JSON.stringify(b.body));

  assert.equal(a.data.student.name, "Anika Alpha");
  assert.equal(b.data.student.name, "Bashir Beta");
  assert.equal(a.data.college.name, "Alpha Polytechnic");
  assert.equal(b.data.college.name, "Beta Polytechnic");

  const sa = a.data.academicStats, sb = b.data.academicStats;
  assert.deepEqual([sa.totalClasses, sa.totalAttended, sa.totalMissed, sa.overallPercentage, sa.creditScore], [3, 2, 1, 67, 4]);
  assert.deepEqual([sb.totalClasses, sb.totalAttended, sb.totalMissed, sb.overallPercentage, sb.creditScore, sb.status], [2, 0, 2, 0, 0, "Critical"]);
});

test("no cross-college aggregation: same registration number, same subject code, separate subjects and totals", async () => {
  const a = await lookup(form(A));
  const b = await lookup(form(B));
  assert.equal(a.data.subjectStats.length, 1);
  assert.equal(b.data.subjectStats.length, 1);
  assert.deepEqual([a.data.subjectStats[0].totalClasses, a.data.subjectStats[0].attended], [3, 2]);
  assert.deepEqual([b.data.subjectStats[0].totalClasses, b.data.subjectStats[0].attended], [2, 0]);
  // totals are NOT 5 classes / 2 attended (A + B combined)
  assert.notEqual(a.data.academicStats.totalClasses, 5);
});

test("a roll that exists only in the OTHER college is a generic 404 (and vice versa)", async () => {
  await mkStudent(A, { studentId: "REG-200", roll: "99", name: "Only In Alpha" });
  const inA = await lookup(form(A, { roll: "99" }));
  assert.equal(inA.status, 200);
  assert.equal(inA.data.student.name, "Only In Alpha");
  const inB = await lookup(form(B, { roll: "99" }));
  assert.equal(inB.status, 404);
  assert.equal(inB.body.message, NOT_FOUND_MESSAGE);
  assert.equal(JSON.stringify(inB.body).includes("Only In Alpha"), false);
});

test("choosing the wrong college for a roll gives that college's student, never the other one's", async () => {
  // Alpha and Beta both have roll 17: picking Beta can only ever show Beta's record.
  const r = await lookup(form(B));
  assert.equal(r.data.student.name, "Bashir Beta");
  assert.equal(JSON.stringify(r.body).includes("Anika"), false);
});

test("academic scope must match: wrong department / batch / shift in the chosen college is the same 404", async () => {
  const bad = [{ department: "Civil" }, { batch: "2023" }, { shift: "Evening" }];
  for (const over of bad) {
    const r = await lookup(form(A, over));
    assert.equal(r.status, 404, JSON.stringify(over));
    assert.equal(r.body.message, NOT_FOUND_MESSAGE);
  }
});

test("matching is case/space-insensitive for department, batch and shift", async () => {
  const r = await lookup(form(A, { department: `  ${DEPT.toUpperCase()}  `, shift: " morning", batch: 2024 }));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.data.student.name, "Anika Alpha");
});

// ═══ manipulated ids ═══

test("a manipulated studentId / _id / role in the body is ignored — only roll + scope select the student", async () => {
  const r = await lookup({ ...form(A), studentId: "REG-100", _id: String(studB._id), id: String(studB._id), student: { _id: String(studB._id) }, role: "admin" });
  assert.equal(r.status, 200);
  assert.equal(r.data.student.name, "Anika Alpha"); // not Beta's student
  assert.equal(r.data.academicStats.totalClasses, 3);
});

test("a roll belonging to a different student cannot be reached by guessing another college's id for the same roll", async () => {
  // Forged collegeId (valid format, unknown) → generic 404; nothing leaks.
  const r = await lookup(form(A, { collegeId: "COL-ZZZZZZZZZZ" }));
  assert.equal(r.status, 404);
  assert.equal(r.body.message, NOT_FOUND_MESSAGE);
});

test("operator injection and malformed input are rejected with 400 before any query", async () => {
  const bodies = [
    form(A, { roll: { $ne: "" } }),
    form(A, { department: { $regex: ".*" } }),
    form(A, { batch: ["2024"] }),
    { ...form(A), collegeId: { $ne: null } },
    { ...form(A), collegeId: "not-a-college" },
    form(A, { roll: "" }),
    form(A, { shift: "x".repeat(200) }),
    form(A, { roll: "1\u0000" }),
  ];
  for (const b of bodies) {
    const r = await lookup(b);
    assert.equal(r.status, 400, JSON.stringify(b));
    assert.ok(r.body.errors && Object.keys(r.body.errors).length);
  }
  assert.equal((await lookup(null)).status, 400);
});

// ═══ data minimisation ═══

test("the response exposes only the whitelisted fields", async () => {
  const r = await lookup(form(A));
  assert.deepEqual(Object.keys(r.data).sort(), ["academicStats", "college", "student", "subjectStats"]);
  assert.deepEqual(Object.keys(r.data.student).sort(), ["batch", "department", "name", "roll", "shift"]);
  assert.deepEqual(Object.keys(r.data.college).sort(), ["country", "district", "name"]);
  assert.deepEqual(Object.keys(r.data.subjectStats[0]).sort(),
    ["attendancePercentage", "attended", "missed", "subjectCode", "subjectName", "totalClasses"].sort());
  const text = JSON.stringify(r.body);
  for (const secret of ["secret@student.example", "REG-100", String(studA._id), A.collegeId, "alertHistory", String(A.teacher._id), A.teacher.email, A.admin.email, "uploadedBy"]) {
    assert.equal(text.includes(secret), false, `leaked: ${secret}`);
  }
  assert.equal(r.body.success, true);
});

test("responses are never cacheable", async () => {
  const res = await fetch(`${app.baseUrl}/api/public/attendance/lookup`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(form(A)),
  });
  assert.equal(res.headers.get("cache-control"), "no-store");
});

test("no authentication is needed (and an admin token of ANOTHER college changes nothing)", async () => {
  const anon = await lookup(form(A));
  const withB = await post(B.adminToken, "/api/public/attendance/lookup", form(A));
  assert.equal(anon.status, 200);
  assert.equal(withB.data.student.name, "Anika Alpha");
});

// ═══ missing / ambiguous / inactive ═══

test("missing record: friendly 404", async () => {
  const r = await lookup(form(A, { roll: "424242" }));
  assert.equal(r.status, 404);
  assert.equal(r.body.success, false);
  assert.equal(r.body.message, NOT_FOUND_MESSAGE);
});

test("a deactivated student is not found", async () => {
  await Student.updateOne({ _id: studA._id }, { $set: { isActive: false } });
  const r = await lookup(form(A));
  assert.equal(r.status, 404);
});

test("a student with no attendance yet gets zeroed analytics, not an error", async () => {
  await mkStudent(A, { studentId: "REG-300", roll: "300", name: "No Classes Yet" });
  const r = await lookup(form(A, { roll: "300" }));
  assert.equal(r.status, 200);
  assert.deepEqual([r.data.academicStats.totalClasses, r.data.academicStats.overallPercentage, r.data.subjectStats.length], [0, 0, 0]);
});

test("ambiguous match (two groups differing only by letter case) → 409, nothing disclosed", async () => {
  await mkStudent(A, { studentId: "REG-777", roll: ROLL, department: DEPT.toLowerCase(), name: "Twin Record" });
  const r = await lookup(form(A));
  assert.equal(r.status, 409);
  assert.equal(r.body.message, AMBIGUOUS_MESSAGE);
  const text = JSON.stringify(r.body);
  assert.equal(text.includes("Twin Record") || text.includes("Anika"), false);
});

test("an inactive college cannot be looked up", async () => {
  await College.updateOne({ collegeId: A.collegeId }, { $set: { status: "suspended" } });
  const r = await lookup(form(A));
  assert.equal(r.status, 404);
});

// ═══ the admin analytics still behave the same after the refactor ═══

test("admin student analytics (shared computation) is unchanged and still college-scoped", async () => {
  const a = await call(A.adminToken, "GET", "/api/alerts/student/REG-100/analytics");
  const b = await call(B.adminToken, "GET", "/api/alerts/student/REG-100/analytics");
  assert.equal(a.status, 200);
  assert.deepEqual([a.data.academicStats.totalClasses, a.data.academicStats.creditScore, a.data.academicStats.status], [3, 4, "Good"]);
  assert.deepEqual([b.data.academicStats.totalClasses, b.data.academicStats.creditScore], [2, 0]);
  assert.ok(Array.isArray(a.data.alertHistory));
  assert.equal(a.data.student.name, "Anika Alpha");
});

// ═══ validator (pure) ═══

test("validateLookupInput trims, collapses whitespace and reports every bad field", () => {
  const ok = validateLookupInput({ collegeId: " COL-2222222222 ", department: "  CST   Dept ", batch: 2024, shift: "Morning", roll: " 17 " });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.values, { collegeId: "COL-2222222222", department: "CST Dept", batch: "2024", shift: "Morning", roll: "17" });
  const bad = validateLookupInput({});
  assert.equal(bad.ok, false);
  assert.deepEqual(Object.keys(bad.errors).sort(), ["batch", "collegeId", "department", "roll", "shift"]);
});

// ═══ rate limiting ═══

test("failure limiter (unit): only failures count, then 429 with Retry-After, then resets", async () => {
  let t = 0;
  const limiter = createFailureLimiter({ windowMs: 1000, max: 2, now: () => t });
  const server = express();
  server.get("/ok", limiter, (_q, r) => r.json({ ok: true }));
  server.get("/miss", limiter, (_q, r) => r.status(404).json({ ok: false }));
  const srv = await new Promise((r) => { const s = server.listen(0, "127.0.0.1", () => r(s)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    for (let i = 0; i < 5; i++) assert.equal((await fetch(`${base}/ok`)).status, 200); // successes are free
    assert.equal((await fetch(`${base}/miss`)).status, 404);
    assert.equal((await fetch(`${base}/miss`)).status, 404);
    const blocked = await fetch(`${base}/ok`);
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers.get("retry-after")) >= 1);
    t += 1500; // window passes
    assert.equal((await fetch(`${base}/ok`)).status, 200);
  } finally { await new Promise((r) => srv.close(r)); }
});

test("rate limit (e2e): repeated failed guesses against one college are throttled — and don't block another college", async () => {
  for (let i = 0; i < 6; i++) assert.equal((await lookup(form(A, { roll: `no-${i}` }))).status, 404);
  const blocked = await lookup(form(A));            // even a correct lookup is paused for this IP+college
  assert.equal(blocked.status, 429);
  const other = await lookup(form(B));              // a different college is a different key
  assert.equal(other.status, 200);
});
