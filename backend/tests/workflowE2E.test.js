/**
 * Part 20 — the two headline workflows, end to end over real HTTP (real routers, middleware, controllers, models; fake
 * Mongo driver): college creation, then teacher sign-up → pending → approval / rejection, with a second college present
 * the whole time to prove the admins cannot see or decide each other's requests.
 */
import test, { before, after } from "node:test";
import assert from "node:assert/strict";

process.env.COLLEGE_REGISTER_MAX = "1000"; process.env.COLLEGE_SEARCH_MAX = "100000";
process.env.TEACHER_SIGNUP_MAX = "1000"; process.env.LOGIN_FAIL_MAX = "1000"; process.env.LOGIN_FAIL_IP_MAX = "100000";
process.env.ANALYTICS_CACHE_TTL_MS = "0";

const { startApp, models } = await import("./helpers/e2eApp.js");
const { loginFailuresPerAccount, loginFailuresPerIp } = await import("../routes/authRoutes.js");
const { Student, User, College, Notification: _n } = models; // eslint-disable-line no-unused-vars

let app, call;
before(async () => { app = await startApp(); call = app.call; loginFailuresPerAccount.reset(); loginFailuresPerIp.reset(); });
after(async () => { await app.close(); });

const register = (name, district, email) => call(null, "POST", "/api/colleges/register", {
  body: { collegeName: name, country: "Bangladesh", district, adminName: `${name} Admin`, adminEmail: email, password: "Secret123", confirmPassword: "Secret123" },
});
const login = (email, password = "Secret123") => call(null, "POST", "/api/auth/login", { body: { email, password } });
const signup = (name, email, collegeId) => call(null, "POST", "/api/auth/signup", { body: { name, email, password: "teacher123", role: "teacher", collegeId } });

const S = {}; // shared story state

test("1. a new college registers: it gets its own id, admin, defaults; duplicates and forged fields are refused", async () => {
  const g = await register("Gamma Institute", "Dhaka", "gamma.admin@example.com");
  assert.equal(g.status, 201, JSON.stringify(g.body));
  S.gamma = g.data.college.collegeId;
  assert.match(S.gamma, /^COL-[2-9A-HJKMNP-TV-Z]{10}$/);
  const d = await register("Delta Institute", "Feni", "delta.admin@example.com");
  assert.equal(d.status, 201); S.delta = d.data.college.collegeId;
  assert.notEqual(S.gamma, S.delta);

  assert.equal((await register("Gamma Institute", "Dhaka", "other@example.com")).status, 409, "same college twice");
  assert.equal((await register("Epsilon", "Dhaka", "gamma.admin@example.com")).status, 409, "e-mail already used");

  S.gAdmin = (await login("gamma.admin@example.com")).data.token;
  S.dAdmin = (await login("delta.admin@example.com")).data.token;
  assert.ok(S.gAdmin && S.dAdmin);
  // each college has its own seeded structure
  for (const t of [S.gAdmin, S.dAdmin]) {
    assert.ok((await call(t, "GET", "/api/departments")).data.departments.length > 0);
    assert.ok((await call(t, "GET", "/api/attendance-categories")).status === 200);
  }
  assert.equal(await College.countDocuments({}), 2);
});

test("2. the college is found by the public search (and nothing sensitive is exposed)", async () => {
  const r = await call(null, "GET", "/api/colleges/search", { query: { q: "Gamma" } });
  assert.equal(r.status, 200);
  const hit = JSON.stringify(r.body);
  assert.ok(hit.includes(S.gamma)); assert.ok(!hit.includes(S.delta));
  assert.ok(!/dedupeKey|searchTokens|createdBy|gamma\.admin/.test(hit));
});

test("3. a teacher signs up for Gamma: request is PENDING, cannot sign in, and the college admin is notified", async () => {
  const s = await signup("Tina Teacher", "tina@example.com", S.gamma);
  assert.equal(s.status, 201, JSON.stringify(s.body));
  assert.ok(!s.data?.token, "no session before approval");
  const l = await login("tina@example.com", "teacher123");
  assert.equal(l.status, 403); assert.ok(l.body.code, "machine-readable reason"); assert.ok(!l.data?.token);
  const u = await User.findOne({ email: "tina@example.com" }).lean();
  assert.equal(u.collegeId, S.gamma); assert.equal(u.role, "teacher"); assert.notEqual(u.approved, true);
  // forged fields are ignored
  const forged = await call(null, "POST", "/api/auth/signup", { body: { name: "Mallory", email: "mal@example.com", password: "teacher123", role: "teacher", collegeId: S.gamma, approved: true, approvalStatus: "approved" } });
  assert.equal(forged.status, 201);
  assert.notEqual((await User.findOne({ email: "mal@example.com" }).lean()).approved, true);
  assert.equal((await call(null, "POST", "/api/auth/signup", { body: { name: "Root", email: "root@example.com", password: "teacher123", role: "admin", collegeId: S.gamma } })).status, 403, "public signup can never create an admin");
  assert.equal((await signup("Ghost", "ghost@example.com", "COL-2222222222")).status >= 400, true, "unknown college refused");

  const note = await call(S.gAdmin, "GET", "/api/notifications");
  assert.equal(note.status, 200);
  assert.ok(JSON.stringify(note.body).includes("teacher_request_new"), "Gamma's admin was notified");
  assert.ok(!JSON.stringify((await call(S.dAdmin, "GET", "/api/notifications")).body).includes("teacher_request_new"), "Delta's admin was not");
});

test("4. only Gamma's admin sees and can decide Gamma's requests; Delta's admin gets 404 and nothing changes", async () => {
  const list = await call(S.gAdmin, "GET", "/api/admin/teacher-requests", { query: { status: "pending" } });
  assert.equal(list.status, 200);
  assert.ok(JSON.stringify(list.body).includes("tina@example.com"));
  assert.ok(!JSON.stringify((await call(S.dAdmin, "GET", "/api/admin/teacher-requests", { query: { status: "all" } })).body).includes("tina@example.com"));
  S.tina = (await User.findOne({ email: "tina@example.com" }).lean())._id.toString();
  assert.equal((await call(S.dAdmin, "PATCH", `/api/admin/teacher-requests/${S.tina}/approve`)).status, 404);
  assert.equal((await call(S.dAdmin, "PATCH", `/api/admin/teacher-requests/${S.tina}/reject`)).status, 404);
  assert.equal((await login("tina@example.com", "teacher123")).status, 403, "still pending");
  assert.equal((await call(S.gAdmin, "GET", "/api/admin/teacher-requests/summary")).status, 200);
});

test("5. approval: the teacher signs in, works in Gamma, and cannot reach Delta", async () => {
  const ok = await call(S.gAdmin, "PATCH", `/api/admin/teacher-requests/${S.tina}/approve`);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const l = await login("tina@example.com", "teacher123");
  assert.equal(l.status, 200); S.tTok = l.data.token;
  assert.equal(l.data.user.collegeId ?? l.data.user.college?.collegeId, S.gamma);
  assert.ok(JSON.stringify((await call(S.tTok, "GET", "/api/notifications")).body).includes("teacher_request_approved"), "teacher is told");

  await Student.create({ studentId: "G-1", roll: "1", name: "Gamma Student", department: "Computer Science and Technology", batch: "2024", shift: "Morning", uploadedBy: S.tina, collegeId: S.gamma });
  const sub = await call(S.tTok, "POST", "/api/subjects", { body: { subjectName: "Networks", subjectCode: "CSE-101", batch: "2024", department: "Computer Science and Technology", shift: "Morning" } });
  assert.equal(sub.status, 201, JSON.stringify(sub.body));
  S.sub = sub.data.subject._id;
  const att = await call(S.tTok, "POST", `/api/attendance/${S.sub}`, { body: { date: "2025-01-05", classType: "Theory", students: [{ studentId: "G-1", roll: "1", name: "Gamma Student", status: "present" }] } });
  assert.equal(att.status, 201, JSON.stringify(att.body));
  assert.equal((await call(S.dAdmin, "GET", `/api/subjects/${S.sub}`)).status, 404, "Delta cannot see Gamma's subject");
  assert.equal((await call(S.dAdmin, "GET", `/api/attendance/${S.sub}`)).status, 404);
  assert.equal((await call(S.tTok, "GET", "/api/admin/teacher-requests")).status, 403, "a teacher is not an admin");
});

test("6. rejection: the teacher cannot sign in, and an approved teacher who is later rejected loses access at once", async () => {
  assert.equal((await signup("Rita Rejected", "rita@example.com", S.gamma)).status, 201);
  const rita = (await User.findOne({ email: "rita@example.com" }).lean())._id.toString();
  const rej = await call(S.gAdmin, "PATCH", `/api/admin/teacher-requests/${rita}/reject`);
  assert.equal(rej.status, 200, JSON.stringify(rej.body));
  const l = await login("rita@example.com", "teacher123");
  assert.equal(l.status, 403); assert.ok(!l.data?.token);

  // Tina is rejected after approval: her existing token stops working immediately
  assert.equal((await call(S.tTok, "GET", "/api/subjects")).status, 200);
  assert.equal((await call(S.gAdmin, "PATCH", `/api/admin/teacher-requests/${S.tina}/reject`)).status, 409, "the request queue only decides PENDING requests");
  // There is no "un-approve" endpoint: an admin removes an approved teacher (DELETE), which revokes the token at once.
  const revoke = await call(S.gAdmin, "DELETE", `/api/admin/teachers/${S.tina}`);
  assert.equal(revoke.status, 200, JSON.stringify(revoke.body));
  assert.ok([401, 403].includes((await call(S.tTok, "GET", "/api/subjects")).status));
  assert.notEqual((await login("tina@example.com", "teacher123")).status, 200);
});
