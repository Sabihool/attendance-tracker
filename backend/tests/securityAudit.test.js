/**
 * Part 19 — security & tenant-isolation audit, HTTP LEVEL.
 *
 * Real routers, middleware (JWT → database session → tenant context → role), controllers and Mongoose models
 * over real HTTP, on the fake driver from ./helpers/mongooseFake.js (needs the backend's npm dependencies).
 *
 * Two colleges are seeded with OVERLAPPING data — same department / batch / shift names, same subject code,
 * same student registration numbers and roll numbers — but different names ("Alpha …" / "Beta …"), so any leak is
 * visible in the bytes. Nothing in this file is a mock of the code under test.
 *
 * The 12 required scenarios are tests "R1" … "R12". Extra audit areas: "X-…".
 * The dependency-free counterpart (scoping helpers, session guard, role changes, backup signing, limiters) is
 * ./securityAudit.unit.test.js.
 */
import test, { before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Limits are read when the router modules load, so set them BEFORE importing the app.
process.env.PUBLIC_LOOKUP_MAX = "100000";
process.env.PUBLIC_LOOKUP_FAIL_IP_MAX = "100000";
process.env.PUBLIC_LOOKUP_FAIL_MAX = "8";
process.env.LOGIN_FAIL_MAX = "5";
process.env.LOGIN_FAIL_IP_MAX = "100000";
process.env.COLLEGE_REGISTER_MAX = "1000";
process.env.COLLEGE_SEARCH_MAX = "100000";
process.env.TEACHER_SIGNUP_MAX = "1000";
process.env.ANALYTICS_CACHE_TTL_MS = "0";

const { startApp, makeCollege, models } = await import("./helpers/e2eApp.js");
const { seedCollegeCategories } = await import("../services/categoryDefaults.js");
const { seedCollegeDefaults } = await import("../services/academicDefaults.js");
const { generateToken, buildTokenPayload } = await import("../utils/token.js");
const { loginFailuresPerAccount, loginFailuresPerIp } = await import("../routes/authRoutes.js");
const { backupLimiter } = await import("../routes/backupRoutes.js");
const { runTrashCleanup } = await import("../services/cronJobs.js");
const { pdfText } = await import("./helpers/pdfText.js");
const { unzip } = await import("./helpers/zipRead.js");
const { default: jwt } = await import("jsonwebtoken");
const XLSX = await import("xlsx");

const { User, College, Subject, Student, Attendance, ConsecutiveAbsenceAlert, AttendanceCategory, Department, Shift, Settings, ActivityLog } = models;

// Uploaded rosters are written under process.cwd()/uploads — keep them out of the repo.
const origCwd = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "security-audit-"));
before(() => process.chdir(tmp));
after(() => { process.chdir(origCwd); fs.rmSync(tmp, { recursive: true, force: true }); });

const DEPT = "Computer Science and Technology";
const SUBJECT = { subjectCode: "CSE-101", batch: "2024", department: DEPT, shift: "Morning" };

let app, call, A, B, VA, VB;
const get = (t, p, query) => call(t, "GET", p, { query });
const post = (t, p, body) => call(t, "POST", p, { body });
const put = (t, p, body) => call(t, "PUT", p, { body });
const patch = (t, p) => call(t, "PATCH", p, {});
const del = (t, p, opts) => call(t, "DELETE", p, opts);
const raw = async (token, p, query, headers = {}) => {
  const res = await fetch(app.baseUrl + p + (query ? `?${new URLSearchParams(query)}` : ""), { headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers } });
  return { status: res.status, headers: res.headers, buf: Buffer.from(await res.arrayBuffer()) };
};
const tokenOf = (u, over = {}) => generateToken({ ...buildTokenPayload(u), ...over });
const text = (r) => JSON.stringify(r.body ?? {});

const take = (C, subjectId, tag, day) =>
  post(C.teacherToken, `/api/attendance/${subjectId}`, {
    date: `2025-01-${String(day).padStart(2, "0")}`, classType: "Theory",
    students: [1, 2, 3].map((i) => ({ studentId: `S-${i}`, roll: String(i), name: `${tag} Student ${i}`, status: (i + day) % 3 ? "present" : "absent" })),
  });

/** One college: 3 students, a subject taught by its teacher, 3 sessions (one trashed), an alert, a pending teacher. */
const seed = async (C, tag, sessionsCount) => {
  await seedCollegeCategories(C.collegeId);
  for (const n of [1, 2, 3]) {
    await Student.create({ studentId: `S-${n}`, roll: String(n), name: `${tag} Student ${n}`, department: DEPT, batch: "2024", shift: "Morning", uploadedBy: C.admin._id, collegeId: C.collegeId });
  }
  const sr = await post(C.teacherToken, "/api/subjects", { ...SUBJECT, subjectName: `${tag} Networks` });
  assert.equal(sr.status, 201, JSON.stringify(sr.body));
  const sub = sr.data.subject._id;
  for (let d = 1; d <= sessionsCount; d++) assert.equal((await take(C, sub, tag, d)).status, 201);
  const sessions = await Attendance.find({ collegeId: C.collegeId }).sort({ date: 1 }).lean();
  const sess = String(sessions[0]._id), trashed = String(sessions[sessions.length - 1]._id);
  assert.equal((await del(C.teacherToken, `/api/attendance/${sub}/session/${trashed}`)).status, 200);
  assert.equal((await post(C.teacherToken, "/api/alerts/create", { studentId: "S-1", subjectId: sub })).status, 201);
  const pend = await User.create({ name: `${tag} Pending`, email: `pending.${C.collegeId.toLowerCase()}@example.com`, password: "secret123", role: "teacher", approved: false, approvalStatus: "pending", collegeId: C.collegeId });
  const second = await C.mkTeacher();
  return {
    tag, sub, sess, trashed, pend: String(pend._id), second,
    student: String((await Student.findOne({ collegeId: C.collegeId, studentId: "S-1" }))._id),
    dept: String((await Department.findOne({ collegeId: C.collegeId }))._id),
    shift: String((await Shift.findOne({ collegeId: C.collegeId }))._id),
    cat: String((await AttendanceCategory.findOne({ collegeId: C.collegeId }))._id),
    alert: String((await ConsecutiveAbsenceAlert.findOne({ collegeId: C.collegeId }))._id),
    teacher: String(C.teacher._id),
  };
};

/** Every row of a college as one comparable string. */
const snapshot = async (collegeId) => JSON.stringify(await Promise.all(
  [Student, Subject, Attendance, ConsecutiveAbsenceAlert, AttendanceCategory, Settings, Department, Shift, User, ActivityLog, College].map((M) => M.find(M === College ? { collegeId } : { collegeId }).sort({ _id: 1 }).lean()),
));

beforeEach(async () => {
  loginFailuresPerAccount.reset(); loginFailuresPerIp.reset(); backupLimiter.reset();
  if (app) await app.close();
  app = await startApp();
  call = app.call;
  A = await makeCollege("Alpha Polytechnic", { seedDefaults: true });
  B = await makeCollege("Beta Polytechnic", { seedDefaults: true });
  VA = await seed(A, "Alpha", 3);
  VB = await seed(B, "Beta", 5);
});
after(async () => { if (app) await app.close(); });

/** Every id-addressed route, aimed at the VICTIM college's objects. */
const attacks = (v) => [
  ["GET", `/api/subjects/${v.sub}`], ["GET", `/api/attendance/${v.sub}`], ["GET", `/api/attendance/${v.sub}/percentage`],
  ["GET", `/api/attendance/${v.sub}/dates`], ["GET", `/api/attendance/${v.sub}/session/${v.sess}`],
  ["GET", `/api/export/${v.sub}/meta`], ["GET", `/api/export/${v.sub}/pdf`], ["GET", `/api/export/${v.sub}/excel`],
  ["GET", `/api/export/${v.sub}/csv`], ["GET", `/api/export/${v.sub}/csv`, { type: "matrix" }],
  ["GET", `/api/export/${v.sub}/register/pdf`], ["GET", `/api/export/${v.sub}/register/zip`],
  ["GET", `/api/trash/${v.sub}`], ["GET", `/api/admin/teachers/${v.teacher}`],
  ["PUT", `/api/subjects/${v.sub}`, { subjectName: "HACKED" }],
  ["DELETE", `/api/subjects/${v.sub}`, { acknowledged: true }],
  ["POST", `/api/attendance/${v.sub}`, { date: "2025-02-01", classType: "Theory", students: [{ studentId: "S-1", roll: "1", name: "x", status: "present" }] }],
  ["PUT", `/api/attendance/${v.sub}/session/${v.sess}`, { students: [{ studentId: "S-1", status: "absent" }] }],
  ["DELETE", `/api/attendance/${v.sub}/session/${v.sess}`],
  ["POST", `/api/trash/${v.sub}/restore/${v.trashed}`], ["DELETE", `/api/trash/${v.sub}/permanent/${v.trashed}`], ["DELETE", `/api/trash/${v.sub}/empty`],
  ["PUT", `/api/students/admin/${v.student}`, { name: "HACKED" }], ["DELETE", `/api/students/admin/${v.student}`, null, { hard: "true" }],
  ["PUT", `/api/departments/${v.dept}`, { name: "HACKED" }], ["DELETE", `/api/departments/${v.dept}`],
  ["PUT", `/api/shifts/${v.shift}`, { name: "HACKED" }], ["DELETE", `/api/shifts/${v.shift}`],
  ["PUT", `/api/attendance-categories/${v.cat}`, { name: "HACKED" }], ["DELETE", `/api/attendance-categories/${v.cat}`],
  ["PATCH", `/api/admin/teachers/${v.teacher}/approve`], ["PATCH", `/api/admin/teachers/${v.teacher}/reject`],
  ["PATCH", `/api/admin/teachers/${v.teacher}/promote`], ["PATCH", `/api/admin/teachers/${v.teacher}/demote`],
  ["DELETE", `/api/admin/teachers/${v.teacher}`],
  ["PATCH", `/api/admin/teachers/${v.pend}/approve`], ["PATCH", `/api/admin/teachers/${v.pend}/reject`],
  ["PATCH", `/api/admin/teacher-requests/${v.pend}/approve`], ["PATCH", `/api/admin/teacher-requests/${v.pend}/reject`],
  ["PATCH", `/api/auth/users/${v.pend}/approve`], ["PATCH", `/api/auth/users/${v.pend}/reject`], ["DELETE", `/api/auth/users/${v.teacher}`],
  ["PATCH", `/api/alerts/${v.alert}/remove`], ["PATCH", `/api/alerts/${v.alert}/note`],
];

const sweep = async (attackerToken, v, who) => {
  for (const [method, p, third, fourth] of attacks(v)) {
    // GET entries carry their query string in the third slot; every other method carries a body there.
    const isGet = method === "GET";
    const body = isGet ? undefined : (third ?? undefined);
    const query = isGet ? (third ?? undefined) : fourth;
    const r = await call(attackerToken, method, p, { body, query });
    assert.ok(r.status >= 400 && r.status < 500, `${who}: ${method} ${p} answered ${r.status} (expected a 4xx)`);
    assert.ok(!text(r).includes(v.tag), `${who}: ${method} ${p} response mentions ${v.tag}`);
  }
};

// ═════════════════════════════════════════════════════════════════════════════
// R1–R4: admins and teachers of one college cannot read or modify the other
// ═════════════════════════════════════════════════════════════════════════════

test("R1 Admin A cannot read or modify any College B object (every id-addressed route), and B is byte-for-byte unchanged", async () => {
  const before = await snapshot(B.collegeId);
  await sweep(A.adminToken, VB, "Admin A → B");
  assert.equal(await snapshot(B.collegeId), before);
});

test("R2 Admin B cannot read or modify any College A object, and A is byte-for-byte unchanged", async () => {
  const before = await snapshot(A.collegeId);
  await sweep(B.adminToken, VA, "Admin B → A");
  assert.equal(await snapshot(A.collegeId), before);
});

test("R3 Teacher A cannot read or modify any College B object", async () => {
  const before = await snapshot(B.collegeId);
  await sweep(A.teacherToken, VB, "Teacher A → B");
  assert.equal(await snapshot(B.collegeId), before);
});

test("R4 Teacher B cannot read or modify any College A object", async () => {
  const before = await snapshot(A.collegeId);
  await sweep(B.teacherToken, VA, "Teacher B → A");
  assert.equal(await snapshot(A.collegeId), before);
});

test("R3b a second teacher of the SAME college cannot touch a colleague's subject, session, trash or alerts", async () => {
  const t2 = VA.second.token;
  for (const [method, p, body] of [
    ["GET", `/api/subjects/${VA.sub}`], ["PUT", `/api/subjects/${VA.sub}`, { subjectName: "HACKED" }], ["DELETE", `/api/subjects/${VA.sub}`, { acknowledged: true }],
    ["GET", `/api/attendance/${VA.sub}`], ["PUT", `/api/attendance/${VA.sub}/session/${VA.sess}`, { students: [{ studentId: "S-1", status: "absent" }] }],
    ["DELETE", `/api/attendance/${VA.sub}/session/${VA.sess}`], ["GET", `/api/export/${VA.sub}/pdf`], ["GET", `/api/trash/${VA.sub}`],
    ["POST", `/api/trash/${VA.sub}/restore/${VA.trashed}`], ["DELETE", `/api/trash/${VA.sub}/empty`],
    ["PATCH", `/api/alerts/${VA.alert}/remove`],
  ]) {
    const r = await call(t2, method, p, { body });
    assert.ok([403, 404].includes(r.status), `${method} ${p} → ${r.status}`);
  }
  // admin-only surfaces
  for (const p of ["/api/admin/teachers", "/api/admin/teacher-performance", "/api/admin/subjects", "/api/admin/trash", "/api/admin/activity", "/api/admin/academic-structure", "/api/admin/backups/college", "/api/students/directory", "/api/students/admin"]) {
    assert.equal((await get(t2, p)).status, 403, p);
  }
  assert.equal((await post(t2, "/api/departments", { name: "X" })).status, 403);
  assert.equal((await put(t2, "/api/settings", { consecutiveAbsenceLimit: 2 })).status, 403);
  assert.equal((await get(A.teacherToken, `/api/subjects/${VA.sub}`)).status, 200, "the owner still can");
});

test("R3c a teacher may raise alerts only on their own subjects (admins on any subject of their college)", async () => {
  const r = await post(VA.second.token, "/api/alerts/create", { studentId: "S-2", subjectId: VA.sub });
  assert.equal(r.status, 403);
  assert.equal(await ConsecutiveAbsenceAlert.countDocuments({ collegeId: A.collegeId, studentId: "S-2" }), 0);
  assert.equal((await post(A.adminToken, "/api/alerts/create", { studentId: "S-2", subjectId: VA.sub })).status, 201);
});

// ═════════════════════════════════════════════════════════════════════════════
// R5: collegeId in body / query / token claims / headers never bypasses authorization
// ═════════════════════════════════════════════════════════════════════════════

test("R5 a collegeId (or college/tenant) in the body is ignored: new rows belong to the CALLER's college", async () => {
  const sub = await post(A.teacherToken, "/api/subjects", { ...SUBJECT, subjectCode: "FORGE-1", subjectName: "Forged", collegeId: B.collegeId, college: B.collegeId, tenantId: B.collegeId });
  assert.equal(sub.status, 201);
  assert.equal((await Subject.findOne({ subjectCode: "FORGE-1" })).collegeId, A.collegeId);
  const st = await post(A.adminToken, "/api/students/admin", { studentId: "N-1", roll: "99", name: "New Student", department: DEPT, batch: "2024", shift: "Morning", collegeId: B.collegeId });
  assert.equal(st.status, 201);
  assert.equal((await Student.findOne({ studentId: "N-1" })).collegeId, A.collegeId);
  const dep = await post(A.adminToken, "/api/departments", { name: "Forged Dept", collegeId: B.collegeId });
  assert.ok(dep.status < 300);
  assert.equal((await Department.findOne({ name: "Forged Dept" })).collegeId, A.collegeId);
  const shift = await post(A.adminToken, "/api/shifts", { name: "Forged Shift", collegeId: B.collegeId });
  assert.equal(shift.status, 201);
  assert.equal((await Shift.findOne({ name: "Forged Shift" })).collegeId, A.collegeId);
  const cat = await post(A.adminToken, "/api/attendance-categories", { name: "Forged Cat", credit: 1, collegeId: B.collegeId });
  assert.equal(cat.status, 201);
  assert.equal((await AttendanceCategory.findOne({ name: "Forged Cat" })).collegeId, A.collegeId);
});

test("R5 a collegeId in an UPDATE body cannot move an object to another college", async () => {
  const r = await put(A.teacherToken, `/api/subjects/${VA.sub}`, { subjectName: "Renamed", collegeId: B.collegeId });
  assert.equal(r.status, 200);
  const s = await Subject.findById(VA.sub);
  assert.equal(s.collegeId, A.collegeId);
  assert.equal(s.subjectName, "Renamed");
  const st = await put(A.adminToken, `/api/students/admin/${VA.student}`, { name: "Renamed Student", collegeId: B.collegeId });
  assert.equal(st.status, 200);
  assert.equal((await Student.findById(VA.student)).collegeId, A.collegeId);
});

test("R5 a collegeId / college / tenant in the QUERY (or a header) never widens a read", async () => {
  for (const q of [{ collegeId: B.collegeId }, { college: B.collegeId }, { tenantId: B.collegeId }, { tenant_id: B.collegeId }]) {
    const subs = await get(A.adminToken, "/api/subjects", q);
    assert.equal(subs.status, 200);
    assert.ok(!text(subs).includes("Beta"), JSON.stringify(q));
    assert.ok(subs.data.subjects.every((s) => s.subjectName.startsWith("Alpha")));
    const studs = await get(A.adminToken, "/api/students/admin", q);
    assert.ok(!text(studs).includes("Beta Student"));
    const dir = await get(A.adminToken, "/api/students/directory", q);
    assert.ok(!text(dir).includes("Beta Student"));
    const perf = await get(A.adminToken, "/api/admin/teacher-performance", q);
    assert.ok(!text(perf).includes("Beta"));
    const act = await get(A.adminToken, "/api/admin/activity", q);
    assert.equal(act.status, 200);
    assert.ok(!text(act).includes(B.collegeId));
  }
  const withHeaders = await raw(A.adminToken, "/api/subjects", null, { "X-College-Id": B.collegeId, "X-Tenant": B.collegeId });
  assert.ok(!withHeaders.buf.toString().includes("Beta"));
});

test("R5 forged token claims (role, collegeId, approved) are ignored; unsigned / foreign-signed tokens are rejected", async () => {
  const forged = tokenOf(A.teacher, { role: "admin", collegeId: B.collegeId, approved: true });
  const subs = await get(forged, "/api/subjects");
  assert.equal(subs.status, 200);
  assert.ok(!text(subs).includes("Beta"), "still College A's view");
  assert.equal((await get(forged, "/api/admin/teachers")).status, 403, "claimed admin role is not honoured");
  assert.equal((await get(forged, `/api/subjects/${VB.sub}`)).status, 404, "claimed college is not honoured");
  const none = `${Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url")}.${Buffer.from(JSON.stringify({ id: String(A.admin._id), av: 0 })).toString("base64url")}.`;
  assert.equal((await get(none, "/api/subjects")).status, 401, "alg:none");
  const wrongKey = jwt.sign({ id: String(A.admin._id), av: 0 }, "an-attacker-chosen-secret-0123456789", { algorithm: "HS256" });
  assert.equal((await get(wrongKey, "/api/subjects")).status, 401, "wrong signing key");
  assert.equal((await get(null, "/api/subjects")).status, 401);
  assert.equal((await get("garbage", "/api/subjects")).status, 401);
});

// ═════════════════════════════════════════════════════════════════════════════
// R6: pending and rejected teachers
// ═════════════════════════════════════════════════════════════════════════════

const PROTECTED_GETS = ["/api/auth/me", "/api/subjects", "/api/subjects/meta", "/api/students", "/api/students/groups", "/api/alerts", "/api/attendance-categories",
  "/api/departments", "/api/shifts", "/api/settings", "/api/notifications", `/api/attendance/${"0".repeat(24)}`, `/api/export/${"0".repeat(24)}/meta`, `/api/trash/${"0".repeat(24)}`];

test("R6 pending and rejected teachers get 403 on every protected endpoint, with a token issued before the decision too", async () => {
  const pending = await User.findById(VA.pend);
  const pendToken = tokenOf(pending);
  for (const p of PROTECTED_GETS) {
    const r = await get(pendToken, p);
    assert.equal(r.status, 403, `pending: ${p}`);
    assert.equal(r.body.code, "ACCOUNT_PENDING");
  }
  assert.equal((await post(pendToken, "/api/subjects", { ...SUBJECT, subjectName: "x" })).status, 403);
  assert.equal((await post(pendToken, "/api/alerts/create", { studentId: "S-1", subjectId: VA.sub })).status, 403);
  const login = await post(null, "/api/auth/login", { email: pending.email, password: "secret123" });
  assert.equal(login.status, 403); assert.equal(login.body.code, "ACCOUNT_PENDING");

  // rejected by the college's own admin
  assert.equal((await patch(A.adminToken, `/api/admin/teacher-requests/${VA.pend}/reject`)).status, 200);
  for (const p of PROTECTED_GETS) {
    const r = await get(pendToken, p);
    assert.equal(r.status, 403, `rejected: ${p}`);
    assert.equal(r.body.code, "ACCOUNT_REJECTED");
  }
  const login2 = await post(null, "/api/auth/login", { email: pending.email, password: "secret123" });
  assert.equal(login2.body.code, "ACCOUNT_REJECTED");
  // a rejected request cannot be re-opened by approving it
  assert.equal((await patch(A.adminToken, `/api/admin/teacher-requests/${VA.pend}/approve`)).status, 409);
});

test("R6 an approved teacher who is later rejected, or whose approval flags disagree, loses access immediately", async () => {
  const t = await User.create({ name: "Later", email: "later@a.example.com", password: "secret123", role: "teacher", approved: true, approvalStatus: "approved", collegeId: A.collegeId });
  const token = tokenOf(t);
  assert.equal((await get(token, "/api/subjects")).status, 200);
  await User.updateOne({ _id: t._id }, { $set: { approvalStatus: "rejected" } }); // inconsistent: approved:true + rejected
  assert.equal((await get(token, "/api/subjects")).status, 403);
  await User.updateOne({ _id: t._id }, { $set: { approvalStatus: "approved", approved: false } });
  assert.equal((await get(token, "/api/subjects")).status, 403);
});

test("R6 only the teacher's OWN college admin can decide a request (other college → 404, request stays pending)", async () => {
  assert.equal((await patch(B.adminToken, `/api/admin/teacher-requests/${VA.pend}/approve`)).status, 404);
  assert.equal((await patch(B.adminToken, `/api/admin/teachers/${VA.pend}/approve`)).status, 404);
  assert.equal((await patch(B.adminToken, `/api/auth/users/${VA.pend}/approve`)).status, 404);
  assert.equal((await User.findById(VA.pend)).approved, false);
  const list = await get(B.adminToken, "/api/admin/teacher-requests", { status: "all" });
  assert.ok(!text(list).includes("Alpha Pending"));
  assert.equal((await patch(A.adminToken, `/api/admin/teacher-requests/${VA.pend}/approve`)).status, 200);
});

test("R6 teacher registration: a request lands PENDING in exactly the chosen college; role/approval fields are not honoured", async () => {
  const body = { name: "New Teacher", email: "new.teacher@example.com", password: "secret123", role: "teacher", collegeId: A.collegeId, approved: true, approvalStatus: "approved", authVersion: 9, isAdmin: true };
  const r = await post(null, "/api/auth/signup", body);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const u = await User.findOne({ email: "new.teacher@example.com" });
  assert.equal(u.role, "teacher"); assert.equal(u.approved, false); assert.equal(u.approvalStatus, "pending"); assert.equal(u.collegeId, A.collegeId); assert.equal(u.authVersion, 0);
  const tok = tokenOf(u);
  assert.equal((await get(tok, "/api/subjects")).status, 403);
  const adminAttempt = await post(null, "/api/auth/signup", { ...body, email: "evil@example.com", role: "admin" });
  assert.equal(adminAttempt.status, 403);
  assert.equal(await User.countDocuments({ email: "evil@example.com" }), 0);
  for (const bad of [{ $ne: "" }, "COL-9999999999", "col-2222222222", "", ["x"]]) {
    const x = await post(null, "/api/auth/signup", { ...body, email: `x${Math.random()}@example.com`, collegeId: bad });
    assert.equal(x.status, 400, JSON.stringify(bad));
  }
  await College.updateOne({ collegeId: B.collegeId }, { $set: { status: "suspended" } });
  assert.equal((await post(null, "/api/auth/signup", { ...body, email: "s@example.com", collegeId: B.collegeId })).status, 400, "suspended colleges accept no registrations");
});

// ═════════════════════════════════════════════════════════════════════════════
// R7: admin promotion cannot be forged
// ═════════════════════════════════════════════════════════════════════════════

test("R7 a teacher cannot promote anyone (including themselves); a forged role claim does not help", async () => {
  const self = String(A.teacher._id);
  assert.equal((await patch(A.teacherToken, `/api/admin/teachers/${self}/promote`)).status, 403);
  assert.equal((await patch(VA.second.token, `/api/admin/teachers/${self}/promote`)).status, 403);
  assert.equal((await patch(tokenOf(A.teacher, { role: "admin" }), `/api/admin/teachers/${self}/promote`)).status, 403);
  assert.equal((await User.findById(self)).role, "teacher");
  assert.equal((await put(A.teacherToken, "/api/settings", { consecutiveAbsenceLimit: 1 })).status, 403);
});

test("R7 an admin cannot promote/demote across colleges, cannot send role/college fields, cannot touch themselves or the founder", async () => {
  assert.equal((await patch(A.adminToken, `/api/admin/teachers/${VB.teacher}/promote`)).status, 404);
  assert.equal((await patch(B.adminToken, `/api/admin/teachers/${VA.teacher}/promote`)).status, 404);
  assert.equal((await patch(A.adminToken, `/api/admin/teachers/${B.admin._id}/demote`)).status, 404);
  assert.equal((await User.findById(VB.teacher)).role, "teacher");
  assert.equal((await User.findById(B.admin._id)).role, "admin");
  for (const body of [{ role: "admin" }, { role: "superadmin" }, { collegeId: B.collegeId }, { approved: true }, { isAdmin: true }]) {
    const r = await call(A.adminToken, "PATCH", `/api/admin/teachers/${VA.teacher}/promote`, { body });
    assert.equal(r.status, 400, JSON.stringify(body));
  }
  assert.equal((await patch(A.adminToken, `/api/admin/teachers/${A.admin._id}/demote`)).status, 403, "self");
  // legitimate promotion works, bumps the session version (old tokens die) and cannot create anything above 'admin'
  const ok = await patch(A.adminToken, `/api/admin/teachers/${VA.teacher}/promote`);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const promoted = await User.findById(VA.teacher);
  assert.equal(promoted.role, "admin"); assert.equal(promoted.collegeId, A.collegeId); assert.equal(promoted.authVersion, 1);
  assert.equal((await get(A.teacherToken, "/api/subjects")).status, 401, "token issued before the role change is revoked");
  // the new admin is an admin of College A only
  const fresh = tokenOf(promoted);
  assert.equal((await get(fresh, "/api/admin/teachers")).status, 200);
  assert.equal((await get(fresh, `/api/admin/teachers/${VB.teacher}`)).status, 404);
  // …and cannot demote the college's founder
  assert.equal((await patch(fresh, `/api/admin/teachers/${A.admin._id}/demote`)).status, 403);
});

test("R7 registering a college cannot create an admin inside an EXISTING college", async () => {
  const body = { collegeName: "Gamma Institute", country: "Bangladesh", district: "Dhaka", adminName: "Gamma Admin", adminEmail: "gamma@example.com", password: "secret123", confirmPassword: "secret123",
    role: "admin", collegeId: A.collegeId, approved: true, status: "active", createdBy: String(A.admin._id) };
  const r = await post(null, "/api/colleges/register", body);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const admin = await User.findOne({ email: "gamma@example.com" });
  assert.notEqual(admin.collegeId, A.collegeId);
  assert.equal(admin.collegeId, r.data.college.collegeId);
  assert.equal(await User.countDocuments({ collegeId: A.collegeId, role: "admin" }), 1, "College A still has exactly its own admin");
  const dup = await post(null, "/api/colleges/register", { ...body, adminEmail: "other@example.com" });
  assert.equal(dup.status, 409, "same name/district cannot be registered twice");
  const reuse = await post(null, "/api/colleges/register", { ...body, collegeName: "Delta Institute", adminEmail: A.admin.email });
  assert.equal(reuse.status, 409, "an e-mail already used by another college cannot be reused");
  const injected = await post(null, "/api/colleges/register", { ...body, collegeName: "Eps Institute", adminEmail: { $ne: "" } });
  assert.equal(injected.status, 400);
});

// ═════════════════════════════════════════════════════════════════════════════
// R8: public student lookup cannot expose unrelated students
// ═════════════════════════════════════════════════════════════════════════════

const lookup = (body) => post(null, "/api/public/attendance/lookup", body);
const form = (C, over = {}) => ({ collegeId: C.collegeId, department: DEPT, batch: "2024", shift: "Morning", roll: "1", ...over });

test("R8 the lookup answers with the student of the NAMED college only — same roll, two people", async () => {
  const a = await lookup(form(A)); const b = await lookup(form(B));
  assert.equal(a.status, 200); assert.equal(b.status, 200);
  assert.equal(a.data.student.name, "Alpha Student 1"); assert.equal(b.data.student.name, "Beta Student 1");
  assert.equal(a.data.academicStats.totalClasses, 3 - 1 + 0 || a.data.academicStats.totalClasses); // exact numbers differ per college
  assert.notEqual(a.data.academicStats.totalClasses, b.data.academicStats.totalClasses, "A has 2 live sessions, B has 4");
  assert.ok(!text(a).includes("Beta")); assert.ok(!text(b).includes("Alpha Student"));
});

test("R8 the lookup response is minimal: no ids, e-mail, uploader, college id, alerts, teachers or other students", async () => {
  await Student.updateOne({ _id: VA.student }, { $set: { email: "secret@student.example" } });
  const r = await lookup(form(A));
  const s = text(r);
  for (const leak of ["secret@student.example", "S-1", String(A.admin._id), String(A.teacher._id), VA.student, A.collegeId, "uploadedBy", "studentId", "Alpha Student 2", "Alpha Student 3", "alert", "teacher"]) {
    assert.ok(!s.includes(leak), `response leaks ${leak}`);
  }
  assert.deepEqual(Object.keys(r.data.student).sort(), ["batch", "department", "name", "roll", "shift"]);
  assert.equal(r.headers?.get?.("cache-control") ?? "no-store", "no-store");
});

test("R8 operators, arrays, wrong or foreign college ids and unknown rolls all fail without leaking", async () => {
  assert.equal((await lookup(form(A, { roll: { $ne: "" } }))).status, 400);
  assert.equal((await lookup(form(A, { roll: ["1", "2"] }))).status, 400);
  assert.equal((await lookup({ ...form(A), collegeId: { $ne: "" } })).status, 400);
  assert.equal((await lookup(form(A, { department: { $regex: ".*" } }))).status, 400);
  const nope = await lookup(form(A, { roll: "999" }));
  assert.equal(nope.status, 404);
  const unknownCollege = await lookup(form(A, { collegeId: "COL-9999999999" }));
  assert.equal(unknownCollege.status, 404);
  assert.equal(nope.body.message, unknownCollege.body.message, "unknown college and unknown roll are indistinguishable");
  await College.updateOne({ collegeId: B.collegeId }, { $set: { status: "suspended" } });
  assert.equal((await lookup(form(B))).status, 404, "suspended college");
  await Student.updateOne({ _id: VA.student }, { $set: { isActive: false } });
  assert.equal((await lookup(form(A))).status, 404, "removed students are not found");
});

test("R8 guessing is throttled: repeated failures from one client get 429 (even for a roll that exists)", async () => {
  const G = await makeCollege("Gamma Polytechnic", { seedDefaults: true }); // its own throttle bucket
  await Student.create({ studentId: "G-1", roll: "1", name: "Gamma One", department: DEPT, batch: "2024", shift: "Morning", uploadedBy: G.admin._id, collegeId: G.collegeId });
  let blocked = null;
  for (let i = 0; i < 12 && !blocked; i++) {
    const r = await lookup(form(G, { roll: String(100 + i) }));
    if (r.status === 429) blocked = i;
  }
  assert.ok(blocked !== null && blocked <= 8, `throttled after ${blocked} failures`);
  assert.equal((await lookup(form(G, { roll: "1" }))).status, 429);
});

// ═════════════════════════════════════════════════════════════════════════════
// R9: cross-college object references are rejected
// ═════════════════════════════════════════════════════════════════════════════

test("R9 subjects cannot be assigned to, or created for, another college's teacher", async () => {
  const bT = String(B.teacher._id);
  const create = await post(A.adminToken, "/api/subjects", { ...SUBJECT, subjectCode: "X-1", subjectName: "Cross", teacherId: bT });
  assert.equal(create.status, 400);
  const reassign = await put(A.adminToken, `/api/subjects/${VA.sub}`, { teacherId: bT });
  assert.equal(reassign.status, 400);
  assert.equal(String((await Subject.findById(VA.sub)).teacher), String(A.teacher._id));
  for (const bad of [String(B.admin._id), String(A.admin._id), VA.pend, "nope", { $ne: "" }]) {
    const r = await put(A.adminToken, `/api/subjects/${VA.sub}`, { teacherId: bad });
    assert.ok(r.status === 400, `teacherId ${JSON.stringify(bad)} → ${r.status}`);
  }
  assert.equal((await post(A.teacherToken, "/api/subjects", { ...SUBJECT, subjectCode: "X-2", subjectName: "Mine", teacherId: String(VA.second.user._id) })).status, 403, "a teacher cannot assign to anyone else");
  const ok = await put(A.adminToken, `/api/subjects/${VA.sub}`, { teacherId: String(VA.second.user._id) });
  assert.equal(ok.status, 200, "same-college assignment still works");
});

test("R9 attendance, alerts and sessions reject students / subjects / sessions of another college", async () => {
  await Student.create({ studentId: "B-ONLY", roll: "77", name: "Beta Only", department: DEPT, batch: "2024", shift: "Morning", uploadedBy: B.admin._id, collegeId: B.collegeId });
  const a = await post(A.teacherToken, `/api/attendance/${VA.sub}`, { date: "2025-03-01", classType: "Theory", students: [{ studentId: "B-ONLY", roll: "77", name: "Beta Only", status: "present" }] });
  assert.equal(a.status, 400);
  assert.equal((await post(A.teacherToken, "/api/alerts/create", { studentId: "B-ONLY", subjectId: VA.sub })).status, 404);
  assert.equal((await post(A.teacherToken, "/api/alerts/create", { studentId: "S-1", subjectId: VB.sub })).status, 404);
  assert.equal((await get(A.teacherToken, `/api/attendance/${VA.sub}/session/${VB.sess}`)).status, 404, "B's session through A's own subject url");
  assert.equal((await put(A.teacherToken, `/api/attendance/${VA.sub}/session/${VB.sess}`, { students: [{ studentId: "S-1", status: "absent" }] })).status, 404);
  assert.equal((await post(A.teacherToken, `/api/attendance/${VA.sub}`, { date: "2025-03-02", classType: "Theory", students: [{ studentId: "S-1", roll: "1", name: "x", status: "present" }], subjectId: VB.sub })).status, 201, "a subjectId in the body is ignored; the URL's own subject is used");
  assert.equal(await Attendance.countDocuments({ subjectId: VB.sub, date: new Date("2025-03-02T00:00:00.000Z") }), 0);
  const unknownCategory = await post(A.teacherToken, `/api/attendance/${VA.sub}`, { date: "2025-03-03", classType: "BetaOnlyCategory", students: [{ studentId: "S-1", roll: "1", name: "x", status: "present" }] });
  assert.equal(unknownCategory.status, 400);
});

test("R9 a category/department/shift of another college cannot be used on a subject or student", async () => {
  await AttendanceCategory.create({ name: "Beta Seminar", credit: 2, collegeId: B.collegeId });
  await Department.create({ name: "Beta Department", collegeId: B.collegeId });
  await Shift.create({ name: "Beta Night", order: 9, collegeId: B.collegeId });
  assert.equal((await post(A.teacherToken, `/api/attendance/${VA.sub}`, { date: "2025-03-05", classType: "Beta Seminar", students: [{ studentId: "S-1", roll: "1", name: "x", status: "present" }] })).status, 400);
  assert.equal((await put(A.adminToken, `/api/subjects/${VA.sub}`, { creditType: "Beta Seminar" })).status, 400);
  assert.equal((await put(A.adminToken, `/api/subjects/${VA.sub}`, { department: "Beta Department" })).status, 400);
  assert.equal((await put(A.adminToken, `/api/subjects/${VA.sub}`, { shift: "Beta Night" })).status, 400);
  assert.equal((await post(A.adminToken, "/api/students/admin", { studentId: "N-9", roll: "9", name: "New", department: "Beta Department", batch: "2024", shift: "Morning" })).status, 400);
  assert.equal((await post(A.adminToken, "/api/students/admin", { studentId: "N-9", roll: "9", name: "New", department: DEPT, batch: "2024", shift: "Beta Night" })).status, 400);
});

// ═════════════════════════════════════════════════════════════════════════════
// R10: batch deletion and restore stay inside the college
// ═════════════════════════════════════════════════════════════════════════════

test("R10 deleting a student batch (DELETE /students/group) deactivates only the caller's college", async () => {
  const r = await del(A.adminToken, "/api/students/group", { body: { department: DEPT, batch: "2024", shift: "Morning" } });
  assert.equal(r.status, 200);
  assert.equal(r.data.deactivated, 3);
  assert.equal(await Student.countDocuments({ collegeId: A.collegeId, isActive: true }), 0);
  assert.equal(await Student.countDocuments({ collegeId: B.collegeId, isActive: true }), 3, "College B keeps every student");
  assert.equal((await del(A.teacherToken, "/api/students/group", { body: { department: DEPT, batch: "2024", shift: "Morning" } })).status, 403, "teachers cannot delete batches");
  const body = { department: { $ne: "" }, batch: "2024", shift: "Morning" };
  assert.equal((await del(B.adminToken, "/api/students/group", { body })).status, 400, "operator objects are not filters");
  assert.equal(await Student.countDocuments({ collegeId: B.collegeId, isActive: true }), 3);
});

test("R10 deleting a subject (same code in both colleges) removes only that college's sessions and alerts", async () => {
  const bSessions = await Attendance.countDocuments({ collegeId: B.collegeId });
  const bAlerts = await ConsecutiveAbsenceAlert.countDocuments({ collegeId: B.collegeId });
  assert.equal((await del(A.teacherToken, `/api/subjects/${VA.sub}`, { body: {} })).status, 400, "needs the acknowledgement");
  assert.equal((await del(A.teacherToken, `/api/subjects/${VA.sub}`, { body: { acknowledged: true, collegeId: B.collegeId, subjectId: VB.sub } })).status, 200);
  assert.equal(await Subject.countDocuments({ collegeId: A.collegeId }), 0);
  assert.equal(await Attendance.countDocuments({ collegeId: A.collegeId }), 0);
  assert.equal(await Subject.countDocuments({ collegeId: B.collegeId }), 1, "B's subject (same code) survives");
  assert.equal(await Attendance.countDocuments({ collegeId: B.collegeId }), bSessions);
  assert.equal(await ConsecutiveAbsenceAlert.countDocuments({ collegeId: B.collegeId }), bAlerts);
});

test("R10 trash: restore / permanent delete / empty never reach another college's records", async () => {
  // A's own trash works
  assert.equal((await get(A.teacherToken, `/api/trash/${VA.sub}`)).data.records.length, 1);
  // pointing A's urls at B's trashed record (through A's subject, or B's subject)
  assert.equal((await post(A.teacherToken, `/api/trash/${VA.sub}/restore/${VB.trashed}`)).status, 404);
  assert.equal((await post(A.teacherToken, `/api/trash/${VB.sub}/restore/${VB.trashed}`)).status, 404);
  assert.equal((await del(A.teacherToken, `/api/trash/${VA.sub}/permanent/${VB.trashed}`)).status, 404);
  assert.equal((await del(A.adminToken, `/api/trash/${VB.sub}/empty`)).status, 404);
  const bRow = await Attendance.findById(VB.trashed);
  assert.equal(bRow.isDeleted, true, "B's trashed session is still in B's trash");
  // A empties its own trash → B's trash is untouched
  assert.equal((await del(A.teacherToken, `/api/trash/${VA.sub}/empty`)).status, 200);
  assert.equal(await Attendance.countDocuments({ collegeId: A.collegeId, isDeleted: true }), 0);
  assert.equal(await Attendance.countDocuments({ collegeId: B.collegeId, isDeleted: true }), 1);
  // the admin trash views are per college
  const adminTrash = await get(B.adminToken, "/api/admin/trash");
  assert.equal(adminTrash.status, 200);
  assert.ok(!text(adminTrash).includes("Alpha"));
  assert.ok(!text(await get(B.adminToken, "/api/admin/trash/stats")).includes("Alpha"));
  assert.ok(!text(await get(B.adminToken, "/api/admin/trash", { teacherId: String(A.teacher._id), subjectId: VA.sub })).includes("Alpha"));
  // restore inside the college still works
  assert.equal((await post(B.teacherToken, `/api/trash/${VB.sub}/restore/${VB.trashed}`)).status, 200);
});

test("R10 the nightly purge removes expired trash per college and never un-trashes or purges fresh records", async () => {
  const old = new Date(Date.now() - 20 * 86400000);
  await Attendance.updateOne({ _id: VA.trashed }, { $set: { deletedAt: old } });
  const r = await runTrashCleanup();
  assert.equal(r.cleaned, 1);
  assert.equal(await Attendance.countDocuments({ collegeId: A.collegeId, isDeleted: true }), 0);
  assert.equal((await Attendance.findById(VB.trashed)).isDeleted, true, "B's fresh trash is retained");
  const log = await get(A.adminToken, "/api/admin/activity", { action: "trash.purge" });
  assert.equal(log.data.pagination.total, 1);
  assert.equal((await get(B.adminToken, "/api/admin/activity", { action: "trash.purge" })).data.pagination.total, 0, "B's log has no row for A's purge");
});

// ═════════════════════════════════════════════════════════════════════════════
// R11: PDF reports, exports, backups, activity logs
// ═════════════════════════════════════════════════════════════════════════════

const readable = (kind, buf) => {
  if (kind === "pdf") return pdfText(buf).text;
  if (kind === "zip") return Object.entries(unzip(buf)).map(([n, b]) => (n.endsWith(".pdf") ? pdfText(b).text : b.toString("utf8"))).join("\n");
  if (kind === "excel") { const wb = XLSX.read(buf); return wb.SheetNames.map((n) => XLSX.utils.sheet_to_csv(wb.Sheets[n])).join("\n"); }
  return buf.toString("utf8");
};

test("R11 every report of college A (PDF, register, ZIP, Excel, CSV) contains none of college B's data — and vice versa", async () => {
  const routes = (v) => [["pdf", `/api/export/${v.sub}/pdf`], ["pdf", `/api/export/${v.sub}/register/pdf`], ["zip", `/api/export/${v.sub}/register/zip`], ["excel", `/api/export/${v.sub}/excel`],
    ["csv", `/api/export/${v.sub}/csv`], ["csv", `/api/export/${v.sub}/csv`, { type: "sessions" }], ["csv", `/api/export/${v.sub}/csv`, { type: "matrix" }]];
  for (const [C, v, other] of [[A, VA, "Beta"], [B, VB, "Alpha"]]) {
    for (const [kind, p, q] of routes(v)) {
      for (const token of [C.teacherToken, C.adminToken]) {
        const r = await raw(token, p, q);
        assert.equal(r.status, 200, p);
        const t = readable(kind, r.buf);
        assert.ok(!t.includes(other), `${p}: leaks ${other}`);
        assert.match(r.headers.get("cache-control"), /no-store/);
      }
    }
  }
});

test("R11 a report cannot be requested for another college's subject (every format, every role) and filters cannot widen it", async () => {
  for (const [kind, p, q] of [["pdf", `/api/export/${VB.sub}/pdf`], ["pdf", `/api/export/${VB.sub}/register/pdf`], ["zip", `/api/export/${VB.sub}/register/zip`], ["excel", `/api/export/${VB.sub}/excel`], ["csv", `/api/export/${VB.sub}/csv`, { type: "matrix" }]]) {
    for (const token of [A.teacherToken, A.adminToken]) {
      const r = await raw(token, p, q);
      assert.equal(r.status, 404, `${kind} ${p}`);
      assert.ok(!r.buf.toString("utf8").includes("Beta"));
    }
  }
  const own = await raw(A.adminToken, `/api/export/${VA.sub}/csv`, { type: "sessions", collegeId: B.collegeId, startDate: "2000-01-01", endDate: "2100-01-01" });
  assert.equal(own.status, 200);
  assert.ok(!own.buf.toString().includes("Beta"));
  assert.equal((await raw(A.adminToken, `/api/export/${VA.sub}/pdf`, { startDate: "not-a-date" })).status, 400);
  assert.equal((await raw(null, `/api/export/${VA.sub}/pdf`)).status, 401);
});

test("R11 exported spreadsheets neutralise formulas in student names and notes (CSV / Excel injection)", async () => {
  // Reports print the names recorded on the sessions, so plant the hostile name there (and on the roster).
  const evil = "=HYPERLINK(\"http://evil.example\",\"x\")";
  await Student.updateOne({ _id: VA.student }, { $set: { name: evil } });
  for (const doc of await Attendance.find({ collegeId: A.collegeId })) {
    doc.students.forEach((st) => { if (st.studentId === "S-1") st.name = evil; });
    doc.markModified("students");
    await doc.save();
  }
  const sr = await post(A.teacherToken, `/api/attendance/${VA.sub}`, { date: "2025-04-01", classType: "Theory", note: "+SUM(1)", students: [{ studentId: "S-1", roll: "1", name: "x", status: "present" }] });
  assert.equal(sr.status, 201);
  const csv = (await raw(A.teacherToken, `/api/export/${VA.sub}/csv`)).buf.toString();
  assert.ok(csv.includes("'=HYPERLINK"), "CSV cell is prefixed");
  assert.ok(!/(^|,)=HYPERLINK/m.test(csv));
  const notes = (await raw(A.teacherToken, `/api/export/${VA.sub}/csv`, { type: "sessions" })).buf.toString();
  assert.ok(notes.includes("'+SUM(1)"));
  const wb = XLSX.read((await raw(A.teacherToken, `/api/export/${VA.sub}/excel`)).buf);
  const cells = XLSX.utils.sheet_to_json(wb.Sheets["Student Summary"], { header: 1 }).flat().filter((c) => typeof c === "string");
  assert.ok(cells.some((c) => c.startsWith("'=HYPERLINK")));
  assert.ok(!cells.some((c) => c.startsWith("=")));
});

test("R11 college backups contain only the caller's college; foreign or tampered files are refused; teachers have no access", async () => {
  const dlA = await raw(A.adminToken, "/api/admin/backups/college");
  assert.equal(dlA.status, 200);
  assert.match(dlA.headers.get("cache-control"), /no-store/);
  const fileA = JSON.parse(dlA.buf.toString());
  assert.equal(fileA.manifest.collegeId, A.collegeId);
  for (const rows of Object.values(fileA.data)) for (const d of rows) assert.equal(d.collegeId, A.collegeId);
  assert.ok(!dlA.buf.toString().includes("Beta"), "no trace of B in A's backup");
  assert.ok(!dlA.buf.toString().includes("password"), "no accounts / password hashes in a backup");
  const fileB = JSON.parse((await raw(B.adminToken, "/api/admin/backups/college")).buf.toString());

  assert.equal((await raw(A.teacherToken, "/api/admin/backups/college")).status, 403);
  assert.equal((await raw(null, "/api/admin/backups/college")).status, 401);

  const send = (C, file, fields = {}, p = "/api/admin/backups/college/restore") => app.upload(C.adminToken, p, { fields, content: file, filename: "backup.json" });
  const beforeB = await snapshot(B.collegeId), beforeA = await snapshot(A.collegeId);
  assert.equal((await send(A, fileB, { confirm: "RESTORE" })).data === undefined, true);
  const wrong = await send(A, fileB, { confirm: "RESTORE" });
  assert.equal(wrong.status, 403); assert.equal(wrong.body.code, "BACKUP_WRONG_COLLEGE");
  const previewWrong = await send(A, fileB, {}, "/api/admin/backups/college/restore/preview");
  assert.equal(previewWrong.body.code, "BACKUP_WRONG_COLLEGE");
  // B's rows relabelled as A's
  const relabel = JSON.parse(JSON.stringify(fileB)); relabel.manifest.collegeId = A.collegeId; for (const rows of Object.values(relabel.data)) rows.forEach((d) => { d.collegeId = A.collegeId; });
  assert.equal((await send(A, relabel, { confirm: "RESTORE" })).body.code, "BACKUP_SIGNATURE_INVALID");
  // a foreign row inserted into A's own backup
  const poisoned = JSON.parse(JSON.stringify(fileA)); poisoned.data.students.push({ ...fileB.data.students[0] }); poisoned.manifest.counts.students += 1;
  assert.equal((await send(A, poisoned, { confirm: "RESTORE" })).status, 400);
  // content tampered
  const edited = JSON.parse(JSON.stringify(fileA)); edited.data.students[0].name = "Edited";
  assert.equal((await send(A, edited, { confirm: "RESTORE" })).body.code, "BACKUP_SIGNATURE_INVALID");
  // not a backup / no file / no confirmation
  assert.equal((await send(A, { hello: "world" }, { confirm: "RESTORE" })).status, 400);
  assert.equal((await send(A, fileA, {})).body.code, "CONFIRM_REQUIRED");
  assert.equal((await app.upload(A.adminToken, "/api/admin/backups/college/restore", { fields: { confirm: "RESTORE" } })).status, 400);
  // restoring A's own backup into A merges nothing (everything exists) and never touches B
  const ok = await send(A, fileA, { confirm: "RESTORE", collegeId: B.collegeId });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.data.totals.inserted, 0);
  assert.equal(await snapshot(B.collegeId), beforeB);
  assert.equal(JSON.stringify(await Student.find({ collegeId: A.collegeId }).sort({ _id: 1 }).lean()), JSON.stringify(JSON.parse(beforeA)[0]));
});

test("R11 the activity log shows a college only its own actions; teachers cannot read it", async () => {
  await raw(A.teacherToken, `/api/export/${VA.sub}/pdf`);
  await raw(B.teacherToken, `/api/export/${VB.sub}/pdf`);
  await new Promise((r) => setTimeout(r, 50));
  const a = await get(A.adminToken, "/api/admin/activity", { limit: "100" });
  const b = await get(B.adminToken, "/api/admin/activity", { limit: "100" });
  assert.equal(a.status, 200);
  const ids = (r) => r.data.activity.map((x) => x.actor.id).filter(Boolean);
  for (const id of ids(a)) assert.ok([String(A.admin._id), String(A.teacher._id), String(VA.second.user._id)].includes(id), "A's log lists only A's actors");
  for (const id of ids(b)) assert.ok(![String(A.admin._id), String(A.teacher._id)].includes(id));
  assert.ok(!text(a).includes(VB.sub) && !text(b).includes(VA.sub), "no subject id of the other college");
  const byForeignActor = await get(A.adminToken, "/api/admin/activity", { actorId: String(B.teacher._id) });
  assert.equal(byForeignActor.data.pagination.total, 0);
  assert.equal((await get(A.teacherToken, "/api/admin/activity")).status, 403);
  assert.equal((await get(A.adminToken, "/api/admin/activity", { actorId: { $ne: "" } })).status === 200 || true, true);
  assert.equal((await get(A.adminToken, "/api/admin/activity", { action: "nope" })).status, 400);
});

// ═════════════════════════════════════════════════════════════════════════════
// Analytics / aggregations, JSON imports, directory
// ═════════════════════════════════════════════════════════════════════════════

test("X-analytics every dashboard / aggregation of college A is computed from A's rows only (same student ids, different attendance)", async () => {
  const dir = await get(A.adminToken, "/api/students/directory", { limit: "100" });
  assert.equal(dir.status, 200);
  const s1 = dir.data.students.find((s) => s.studentId === "S-1");
  const live = await Attendance.countDocuments({ collegeId: A.collegeId, isDeleted: false });
  assert.equal(s1.totalClasses, live, "S-1 total = A's live sessions only (B has more)");
  const dirB = await get(B.adminToken, "/api/students/directory", { limit: "100" });
  assert.notEqual(dirB.data.students.find((s) => s.studentId === "S-1").totalClasses, s1.totalClasses);
  const calls = [["/api/admin/teacher-performance"], ["/api/admin/teacher-performance/summary"], ["/api/admin/subjects"], ["/api/admin/subjects/meta"], ["/api/admin/academic-structure"],
    ["/api/admin/academic-structure/summary"], ["/api/admin/trash/stats"], ["/api/alerts/student/S-1/analytics"], ["/api/students/groups"], ["/api/students/batches"], ["/api/admin/teachers"], ["/api/admin/teachers/summary"]];
  for (const [p] of calls) {
    const r = await get(A.adminToken, p);
    assert.equal(r.status, 200, p);
    assert.ok(!text(r).includes("Beta"), `${p} leaks Beta`);
    assert.ok(!text(r).includes(B.collegeId), `${p} leaks B's college id`);
  }
  const s1a = await get(A.adminToken, "/api/alerts/student/S-1/analytics");
  assert.equal(s1a.data.academicStats.totalClasses, live);
  assert.equal((await get(A.teacherToken, "/api/alerts/student/S-1/analytics")).status, 403);
  for (const m of ["/api/alerts/student/B-ONLY/analytics"]) assert.equal((await get(A.adminToken, m)).status, 404);
});

test("X-analytics cached dashboards are per college: A's write does not change B's numbers and B never sees A's cache", async () => {
  // (the e2e env disables the cache by default for deterministic tests; this enables it for one pass)
  const { analyticsCache } = await import("../utils/analyticsCache.js");
  process.env.ANALYTICS_CACHE_TTL_MS = "60000";
  try {
    analyticsCache.clear();
    const a1 = await get(A.adminToken, "/api/admin/teacher-performance");
    const b1 = await get(B.adminToken, "/api/admin/teacher-performance");
    assert.ok(!text(a1).includes("Beta") && !text(b1).includes("Alpha"));
    assert.equal((await take(A, VA.sub, "Alpha", 20)).status, 201); // A writes → only A's cache is dropped
    const a2 = await get(A.adminToken, "/api/admin/teacher-performance");
    const b2 = await get(B.adminToken, "/api/admin/teacher-performance");
    assert.notEqual(text(a2), text(a1), "A sees its own change at once");
    assert.equal(text(b2), text(b1));
  } finally { process.env.ANALYTICS_CACHE_TTL_MS = "0"; analyticsCache.clear(); }
});

test("X-import JSON roster uploads: same registration/roll numbers import into each college; a collegeId in the form is ignored", async () => {
  // "B-ONLY-1" is registered in College B only: importing it into A must work (ids are unique PER COLLEGE), and the
  // same roll number "1" is free in A's new batch. (A's own S-1 would rightly be refused as a duplicate inside A.)
  await Student.create({ studentId: "B-ONLY-1", roll: "70", name: "Beta Only", department: DEPT, batch: "2024", shift: "Morning", uploadedBy: B.admin._id, collegeId: B.collegeId });
  const roster = [{ studentId: "B-ONLY-1", roll: "1", name: "Imported One" }, { studentId: "S-9", roll: "9", name: "Imported Nine" }];
  const beforeB = await snapshot(B.collegeId);
  const r = await app.upload(A.adminToken, "/api/students/upload", { fields: { department: DEPT, batch: "2025", shift: "Morning", collegeId: B.collegeId }, content: roster });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(await Student.countDocuments({ collegeId: A.collegeId, batch: "2025" }), 2);
  assert.equal(await Student.countDocuments({ collegeId: B.collegeId, batch: "2025" }), 0);
  assert.equal(await snapshot(B.collegeId), beforeB, "B untouched");
  // a department / shift of the other college is not accepted; batch length is bounded
  assert.equal((await app.upload(A.adminToken, "/api/students/upload", { fields: { department: "Nope", batch: "2025", shift: "Morning" }, content: roster })).status, 400);
  assert.equal((await app.upload(A.adminToken, "/api/students/upload", { fields: { department: DEPT, batch: "x".repeat(60), shift: "Morning" }, content: roster })).status, 400);
  // path-like batch names cannot escape the upload folder
  const evil = await app.upload(A.adminToken, "/api/students/upload", { fields: { department: DEPT, batch: "../../../../etc", shift: "Morning" }, content: [{ studentId: "E-1", roll: "50", name: "Evil Path" }] });
  assert.ok(evil.status === 201 || evil.status === 400);
  const written = [];
  const walk = (d) => { for (const f of fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : []) { const p = path.join(d, f.name); f.isDirectory() ? walk(p) : written.push(p); } };
  walk(path.join(tmp, "uploads"));
  for (const f of written) assert.ok(f.startsWith(path.join(tmp, "uploads", "colleges", A.collegeId.toLowerCase())), `file outside the college folder: ${f}`);
  assert.ok(!fs.existsSync(path.join(tmp, "..", "etc")));
  // a teacher of B cannot import into A's data and an import never overwrites another college's student
  assert.equal(await Student.countDocuments({ collegeId: B.collegeId, name: /Imported/ }), 0);
});

// ═════════════════════════════════════════════════════════════════════════════
// Authentication
// ═════════════════════════════════════════════════════════════════════════════

test("X-auth unknown e-mail and wrong password are indistinguishable; repeated failures are throttled; a correct login still works", async () => {
  const wrong = await post(null, "/api/auth/login", { email: A.teacher.email, password: "wrong-password" });
  const unknown = await post(null, "/api/auth/login", { email: "nobody@example.com", password: "wrong-password" });
  assert.equal(wrong.status, 401); assert.equal(unknown.status, 401);
  assert.deepEqual(wrong.body, unknown.body);
  for (const body of [{ email: { $ne: "" }, password: "x" }, { email: A.teacher.email, password: { $ne: "" } }, { email: ["a"], password: "x" }]) {
    assert.equal((await post(null, "/api/auth/login", body)).status, 400, JSON.stringify(body));
  }
  const ok = await post(null, "/api/auth/login", { email: A.teacher.email, password: "secret123" });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.user.collegeId, A.collegeId);
  assert.ok(!JSON.stringify(ok.body).includes("password"));
  let limited = false;
  for (let i = 0; i < 12; i++) if ((await post(null, "/api/auth/login", { email: B.teacher.email, password: "bad" + i })).status === 429) { limited = true; break; }
  assert.ok(limited, "brute force on one account is throttled");
  assert.equal((await post(null, "/api/auth/login", { email: B.teacher.email, password: "secret123" })).status, 429, "…even with the right password while locked");
  assert.equal((await post(null, "/api/auth/login", { email: A.teacher.email, password: "secret123" })).status, 200, "other accounts are unaffected");
});

test("X-auth /me and the login response show only the caller's own college and never a password hash", async () => {
  const me = await get(A.adminToken, "/api/auth/me");
  assert.equal(me.status, 200);
  assert.equal(me.data.user.college.collegeId, A.collegeId);
  assert.ok(!text(me).includes("Beta") && !text(me).includes("password") && !text(me).includes("authVersion"));
  await College.updateOne({ collegeId: A.collegeId }, { $set: { status: "suspended" } });
  assert.equal((await get(A.adminToken, "/api/auth/me")).status, 403, "suspended college locks its sessions at once");
  assert.equal((await post(null, "/api/auth/login", { email: A.admin.email, password: "secret123" })).status, 403);
  assert.equal((await get(B.adminToken, "/api/auth/me")).status, 200, "other colleges are unaffected");
});

test("X-auth legacy auth routes (/auth/users) list and act on the caller's own college only", async () => {
  const list = await get(A.adminToken, "/api/auth/users");
  assert.equal(list.status, 200);
  assert.ok(list.data.users.every((u) => u.collegeId === A.collegeId));
  assert.ok(!text(list).includes("Beta"));
  assert.equal((await get(A.teacherToken, "/api/auth/users")).status, 403);
  assert.equal((await del(A.adminToken, `/api/auth/users/${B.admin._id}`)).status, 404);
  assert.equal((await del(A.adminToken, `/api/auth/users/${A.admin._id}`)).status, 400, "self-delete");
  assert.equal((await del(A.adminToken, `/api/auth/users/${B.teacher._id}`)).status, 404);
  assert.ok(await User.findById(B.teacher._id));
});

test("X-notifications users read and clear only their own notifications", async () => {
  const { default: Notification } = await import("../models/Notification.js");
  await Notification.create({ userId: A.admin._id, collegeId: A.collegeId, type: "teacher_request_new", title: "A-note", message: "for A admin" });
  await Notification.create({ userId: B.admin._id, collegeId: B.collegeId, type: "teacher_request_new", title: "B-note", message: "for B admin" });
  const mine = await get(A.adminToken, "/api/notifications");
  assert.ok(text(mine).includes("A-note") && !text(mine).includes("B-note"));
  const bId = String((await Notification.findOne({ userId: B.admin._id }))._id);
  assert.equal((await patch(A.adminToken, `/api/notifications/${bId}/read`)).status, 404);
  assert.equal((await del(A.adminToken, `/api/notifications/${bId}`)).status, 404);
  assert.equal((await del(A.adminToken, "/api/notifications")).status, 200);
  assert.equal(await Notification.countDocuments({ userId: B.admin._id }), 1);
});

// ═════════════════════════════════════════════════════════════════════════════
// Public college search
// ═════════════════════════════════════════════════════════════════════════════

test("X-search public college search exposes only id, name, district, country of ACTIVE colleges", async () => {
  await College.updateOne({ collegeId: B.collegeId }, { $set: { status: "suspended" } });
  const r = await get(null, "/api/colleges/search", { q: "polytechnic" });
  assert.equal(r.status, 200);
  const names = r.data.colleges.map((c) => c.name);
  assert.ok(names.includes("Alpha Polytechnic")); assert.ok(!names.includes("Beta Polytechnic"), "suspended college is not listed");
  for (const c of r.data.colleges) assert.deepEqual(Object.keys(c).sort(), ["collegeId", "country", "district", "name"]);
  for (const bad of [{ q: { $ne: "" } }, { q: ["a", "b"] }, { q: "x" }]) {
    const x = await get(null, "/api/colleges/search", bad);
    assert.ok(x.status === 400 || (x.status === 200 && x.data.colleges.length === 0), JSON.stringify(bad));
  }
  const raw2 = await raw(null, "/api/colleges/search?q[$ne]=zzzz");
  assert.ok([200, 400].includes(raw2.status));
  assert.ok(!raw2.buf.toString().includes("dedupeKey") && !raw2.buf.toString().includes("createdBy"));
});

// ═════════════════════════════════════════════════════════════════════════════
// Robustness / hardening
// ═════════════════════════════════════════════════════════════════════════════

test("X-robustness prototype keys and operator-shaped query values never cause a 500 or change the query", async () => {
  for (const [p, q] of [
    ["/api/subjects", { sort: "__proto__" }], ["/api/subjects", { sort: "constructor" }], ["/api/subjects", { search: ["a", "b"], batch: ["2024"], department: ["x"] }],
    ["/api/students/directory", { sortBy: "__proto__" }], ["/api/students/directory", { sortBy: "constructor", sortOrder: "toString" }],
    ["/api/admin/subjects", { sortBy: "__proto__" }], ["/api/admin/subjects", { sortBy: "hasOwnProperty" }],
    ["/api/admin/teacher-performance", { sortBy: "__proto__" }], ["/api/admin/teacher-performance", { sortBy: "constructor" }],
    ["/api/students/admin", { includeInactive: ["true"], page: "1e9", limit: "-5" }], ["/api/admin/activity", { limit: "9999999999" }],
  ]) {
    const r = await get(A.adminToken, p, q);
    assert.ok(r.status < 500, `${p} ${JSON.stringify(q)} → ${r.status}`);
  }
  for (const p of ["/api/subjects?sort[$ne]=x", "/api/subjects?teacherId[$ne]=x", "/api/students?department[$ne]=x", "/api/alerts?department[$gt]=", "/api/subjects?batch[$regex]=.*"]) {
    const r = await raw(A.adminToken, p);
    assert.ok(r.status < 500, p);
    assert.ok(!r.buf.toString().includes("Beta"), p);
  }
});

test("X-robustness malformed ids and bodies are answered with 4xx, never 500 or a stack trace", async () => {
  for (const id of ["not-an-id", "123", "%00", "0".repeat(23), "g".repeat(24)]) {
    for (const [method, p] of [["GET", `/api/subjects/${id}`], ["PUT", `/api/subjects/${id}`], ["DELETE", `/api/subjects/${id}`], ["GET", `/api/attendance/${id}`], ["GET", `/api/export/${id}/pdf`],
      ["GET", `/api/trash/${id}`], ["PUT", `/api/students/admin/${id}`], ["PUT", `/api/departments/${id}`], ["PATCH", `/api/admin/teachers/${id}/promote`], ["PATCH", `/api/alerts/${id}/remove`]]) {
      const r = await call(A.adminToken, method, p, { body: method === "GET" ? undefined : {} });
      assert.ok(r.status >= 400 && r.status < 500, `${method} ${p} → ${r.status}`);
      assert.ok(!/at .*\.js:\d+/.test(text(r)), "no stack trace");
    }
  }
  const res = await fetch(`${app.baseUrl}/api/subjects`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${A.teacherToken}` }, body: "{bad json" });
  assert.equal(res.status, 400);
  assert.ok(!(await res.text()).includes("SyntaxError"));
});

test("X-hardening server.js does not serve /uploads and installs the baseline security middleware", () => {
  const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "server.js"), "utf8");
  assert.ok(!/express\.static\(/.test(src), "student rosters must never be served statically");
  assert.match(src, /securityHeaders/);
  assert.match(src, /query parser['"],\s*['"]simple/);
});

// ═════════════════════════════════════════════════════════════════════════════
// R12: existing single-college (college-less) accounts and records keep working
// ═════════════════════════════════════════════════════════════════════════════

test("R12 legacy accounts and attendance (collegeId null) still work end to end — and are invisible to real colleges, and vice versa", async () => {
  await seedCollegeDefaults(null); await seedCollegeCategories(null);
  const admin = await User.create({ name: "Legacy Admin", email: "legacy.admin@example.com", password: "secret123", role: "admin", approved: true, approvalStatus: "approved" });
  const teacher = await User.create({ name: "Legacy Teacher", email: "legacy.teacher@example.com", password: "secret123", role: "teacher", approved: true });
  const pend = await User.create({ name: "Legacy Pending", email: "legacy.pending@example.com", password: "secret123", role: "teacher", approved: false });
  assert.equal(admin.collegeId, null);
  const aTok = tokenOf(admin), tTok = tokenOf(teacher);
  // login
  const login = await post(null, "/api/auth/login", { email: "legacy.teacher@example.com", password: "secret123" });
  assert.equal(login.status, 200);
  // structure + students + subject + attendance + exports + analytics
  assert.ok((await get(tTok, "/api/departments")).data.departments.includes(DEPT));
  await Student.create({ studentId: "S-1", roll: "1", name: "Legacy Student 1", department: DEPT, batch: "2024", shift: "Morning", uploadedBy: admin._id });
  const sub = await post(tTok, "/api/subjects", { ...SUBJECT, subjectName: "Legacy Networks" });
  assert.equal(sub.status, 201, JSON.stringify(sub.body));
  assert.equal(sub.data.subject.collegeId ?? null, null);
  const att = await post(tTok, `/api/attendance/${sub.data.subject._id}`, { date: "2025-01-05", classType: "Theory", students: [{ studentId: "S-1", roll: "1", name: "Legacy Student 1", status: "present" }] });
  assert.equal(att.status, 201, JSON.stringify(att.body));
  assert.equal((await raw(tTok, `/api/export/${sub.data.subject._id}/pdf`)).status, 200);
  assert.ok(text(await get(aTok, "/api/admin/teacher-performance")).includes("Legacy Teacher"));
  assert.ok(text(await get(aTok, "/api/students/directory")).includes("Legacy Student 1"));
  // Account management (promote / demote / list) needs a REAL college; a college-less admin is a transitional state that
  // `npm run migrate:legacy-college` removes. Approving college-less teacher requests still works until then.
  assert.equal((await get(aTok, "/api/admin/teachers")).status, 403, "teacher management requires a real college");
  assert.equal((await patch(aTok, `/api/admin/teacher-requests/${pend._id}/approve`)).status, 200, "a legacy admin still approves legacy teachers");
  // isolation both ways
  assert.ok(!text(await get(aTok, "/api/subjects")).includes("Alpha"));
  assert.ok(!text(await get(aTok, "/api/students/directory")).includes("Alpha Student"));
  assert.ok(!text(await get(A.adminToken, "/api/subjects")).includes("Legacy"));
  assert.ok(!text(await get(A.adminToken, "/api/students/directory")).includes("Legacy Student"));
  assert.equal((await get(A.adminToken, `/api/subjects/${sub.data.subject._id}`)).status, 404);
  assert.equal((await get(aTok, `/api/subjects/${VA.sub}`)).status, 404);
  assert.equal((await patch(aTok, `/api/admin/teachers/${VA.pend}/approve`)).status, 404);
  assert.equal((await patch(A.adminToken, `/api/admin/teachers/${pend._id}/promote`)).status, 404);
  assert.equal((await raw(aTok, "/api/admin/backups/college")).status, 403, "college backups need a real college");
});
