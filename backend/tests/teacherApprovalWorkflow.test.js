/**
 * Part 8 — teacher registration → college-admin approval, end to end.
 *
 * Runs the REAL signup / login / guards / service / handlers against an
 * in-memory fake of the models (tests/helpers/memoryDb.js). Requests go through
 * the same middleware order the routes use: protect → requireApproved →
 * authorize('admin') → requireCollegeAdmin → handler.
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";

import { createSignup, createLogin } from "../controllers/authController.js";
import { protect, authorize } from "../middleware/authMiddleware.js";
import { createRequireApproved, createRequireCollegeAdmin } from "../middleware/approvalGuards.js";
import { createTeacherApprovalService, checkLoginEligibility } from "../services/teacherApprovalService.js";
import { createNotificationService } from "../services/notificationService.js";
import { createTeacherRequestHandlers } from "../controllers/teacherRequestController.js";
import { createNotificationHandlers } from "../controllers/notificationController.js";
import { generateToken, buildTokenPayload } from "../utils/token.js";
import { backfillApprovalStatus } from "../utils/approvalBackfill.js";
import { createMemoryDb, seedCollege, seedAdmin } from "./helpers/memoryDb.js";

// ── tiny express-ish harness ─────────────────────────────────────────────────
const mkRes = () => ({
  code: 200, body: null, headers: {},
  status(c) { this.code = c; return this; },
  json(b) { this.body = b; return this; },
  set(k, v) { this.headers[k] = v; return this; },
});

/** Run middleware/handler functions in order, like Express does. */
const run = async (chain, req) => {
  const res = mkRes();
  let error = null;
  for (const fn of chain) {
    let advanced = false;
    await new Promise((resolve) => {
      const next = (err) => { advanced = true; if (err) error = err; resolve(); };
      Promise.resolve(fn(req, res, next)).then(() => { if (res.body !== null) resolve(); else if (!advanced) resolve(); }, (e) => { error = e; resolve(); });
    });
    if (error) throw error;
    if (!advanced) break; // a middleware answered instead of calling next()
  }
  return res;
};

const world = () => {
  const db = createMemoryDb();
  const { User, College, Notification } = db;
  const notifier = createNotificationService({ Notification });
  const service = createTeacherApprovalService({ User, College, notifier, log: { error() {} } });
  const requireApproved = createRequireApproved({ User, College });
  const requireCollegeAdmin = createRequireCollegeAdmin({ service });
  const h = createTeacherRequestHandlers(service);
  const nh = createNotificationHandlers(notifier);

  const findActiveCollege = async (C, id) =>
    typeof id === "string" ? C.findOne({ collegeId: id, status: "active" }).select("collegeId name").lean() : null;
  const signupFn = createSignup({ User, College, findActiveCollege, onTeacherRegistered: (a) => service.notifyNewRequest(a) });
  const loginFn = createLogin({ User, College });

  const tokenFor = (u, claimApproved) =>
    generateToken({ ...buildTokenPayload({ ...u, _id: u._id }), ...(claimApproved === undefined ? {} : { approved: claimApproved }) });
  const bearer = (token) => ({ authorization: `Bearer ${token}` });

  const adminChain = (...tail) => [protect, requireApproved, authorize("admin"), requireCollegeAdmin, ...tail];
  const api = {
    signup: (body) => run([signupFn], { body }),
    login: (email, password) => run([loginFn], { body: { email, password } }),
    // admin endpoints, authenticated as `user` (token built from the DB row)
    as: (user, tokenOverride) => {
      const headers = bearer(tokenOverride ?? tokenFor(user));
      return {
        list: (query = {}) => run(adminChain(h.list), { headers, query }),
        summary: () => run(adminChain(h.summary), { headers, query: {} }),
        approve: (id) => run(adminChain(h.approve), { headers, params: { id } }),
        reject: (id) => run(adminChain(h.reject), { headers, params: { id } }),
        remove: (id) => run(adminChain(h.remove), { headers, params: { id } }),
        legacyList: (query = {}) => run(adminChain(h.legacyList), { headers, query }),
        notifications: () => run([protect, requireApproved, nh.list], { headers, query: {} }),
        markRead: (id) => run([protect, requireApproved, nh.markRead], { headers, params: { id } }),
        // any teacher-only feature behind requireApproved
        protectedFeature: () => run([protect, requireApproved, (_q, res) => res.status(200).json({ ok: true })], { headers }),
      };
    },
  };
  return { db, service, notifier, api, tokenFor, requireApproved, requireCollegeAdmin };
};

const T = (collegeId, over = {}) => ({
  name: "Tina Teacher", email: "tina@example.com", password: "Secret123", role: "teacher", collegeId,
  department: "Computer Science & Technology", ...over,
});

const setup = () => {
  const w = world();
  const A = seedCollege(w.db, { name: "Alpha College" });
  const B = seedCollege(w.db, { name: "Beta College" });
  const adminA1 = seedAdmin(w.db, A);
  const adminA2 = seedAdmin(w.db, A);
  const adminB = seedAdmin(w.db, B);
  return { ...w, A, B, adminA1, adminA2, adminB };
};
const pendingFor = async (s, email, college = s.A) => {
  const r = await s.api.signup(T(college.collegeId, { email }));
  assert.equal(r.code, 201, JSON.stringify(r.body));
  return s.db.User.rows.find((u) => u.email === email);
};

// ─────────────────────────────────────────────────────────────────────────────
// 1. REGISTRATION
// ─────────────────────────────────────────────────────────────────────────────
test("registration: creates a PENDING teacher tied to the selected college, with no token", async () => {
  const s = setup();
  const r = await s.api.signup(T(s.A.collegeId));
  assert.equal(r.code, 201);
  assert.equal(r.body.data.token, undefined, "no token may be issued");
  assert.equal(r.body.data.status, "pending");
  assert.deepEqual(r.body.data.college, { collegeId: s.A.collegeId, name: "Alpha College" });
  assert.equal(JSON.stringify(r.body).includes("Secret123"), false, "password never echoed");

  const row = s.db.User.rows.find((u) => u.email === "tina@example.com");
  assert.equal(row.role, "teacher");
  assert.equal(row.approved, false);
  assert.equal(row.approvalStatus, "pending");
  assert.equal(row.collegeId, s.A.collegeId);
});

test("registration: a teacher cannot approve themselves by tampering with the body", async () => {
  const s = setup();
  const r = await s.api.signup(T(s.A.collegeId, {
    approved: true, approvalStatus: "approved", approvalReviewedBy: "x", isAdmin: true,
  }));
  assert.equal(r.code, 201);
  const row = s.db.User.rows.find((u) => u.email === "tina@example.com");
  assert.equal(row.approved, false);
  assert.equal(row.approvalStatus, "pending");
  assert.equal(row.approvalReviewedBy, undefined);
  assert.equal(row.role, "teacher");
});

test("registration: role admin, operator objects and wrong types are refused", async () => {
  const s = setup();
  assert.equal((await s.api.signup(T(s.A.collegeId, { role: "admin" }))).code, 403);
  assert.equal((await s.api.signup(T(s.A.collegeId, { email: { $ne: "" } }))).code, 400);
  assert.equal((await s.api.signup(T(s.A.collegeId, { password: ["x"] }))).code, 400);
  assert.equal((await s.api.signup(T(s.A.collegeId, { name: { a: 1 } }))).code, 400);
  assert.equal((await s.api.signup(T({ $ne: "" }))).code, 400);
  assert.equal(s.db.User.rows.filter((u) => u.role === "teacher").length, 0);
});

test("registration: unknown, deleted and suspended colleges are refused and nothing is created", async () => {
  const s = setup();
  const C = seedCollege(s.db, { name: "Gamma", status: "suspended" });
  for (const id of ["COL-NOPE000000", C.collegeId, "", undefined]) {
    const r = await s.api.signup(T(id));
    assert.equal(r.code, 400, String(id));
    assert.ok(r.body.errors.collegeId);
  }
  assert.equal(s.db.User.rows.filter((u) => u.role === "teacher").length, 0);
});

test("registration: duplicate email → 409 (case-insensitive), including a rejected/approved account", async () => {
  const s = setup();
  await pendingFor(s, "dup@example.com");
  assert.equal((await s.api.signup(T(s.A.collegeId, { email: "dup@example.com" }))).code, 409);
  assert.equal((await s.api.signup(T(s.A.collegeId, { email: " DUP@Example.com " }))).code, 409);
  assert.equal((await s.api.signup(T(s.B.collegeId, { email: "dup@example.com" }))).code, 409, "same email at another college is also a duplicate");
  assert.equal(s.db.User.rows.filter((u) => u.role === "teacher").length, 1);
});

test("registration RACE: simultaneous identical signups → exactly one request is created", async () => {
  const s = setup();
  const results = await Promise.all(Array.from({ length: 8 }, () => s.api.signup(T(s.A.collegeId, { email: "race@example.com" }))));
  assert.equal(results.filter((r) => r.code === 201).length, 1);
  assert.equal(results.filter((r) => r.code === 409).length, 7);
  assert.equal(s.db.User.rows.filter((u) => u.email === "race@example.com").length, 1);
  // …and the admins were told about it exactly once
  const note = s.db.Notification.rows.filter((n) => n.type === "teacher_request_new" && String(n.userId) === String(s.adminA1._id));
  assert.equal(note.length, 1);
});

test("registration: only admins of the SELECTED college are notified", async () => {
  const s = setup();
  await pendingFor(s, "n@example.com");
  const rows = s.db.Notification.rows;
  const to = (u) => rows.filter((n) => String(n.userId) === String(u._id));
  assert.equal(to(s.adminA1).length, 1);
  assert.equal(to(s.adminA2).length, 1);
  assert.equal(to(s.adminB).length, 0);
  assert.match(to(s.adminA1)[0].message, /n@example\.com/);
  assert.match(to(s.adminA1)[0].message, /Alpha College/);
});

test("registration: a failing notification system never blocks the signup", async () => {
  const s = setup();
  const boom = { createMany: async () => { throw new Error("notif db down"); } };
  const service = createTeacherApprovalService({ User: s.db.User, College: s.db.College, notifier: boom, log: { error() {} } });
  const signup = createSignup({
    User: s.db.User, College: s.db.College,
    findActiveCollege: async (C, id) => C.findOne({ collegeId: id, status: "active" }).select("collegeId name").lean(),
    onTeacherRegistered: (a) => service.notifyNewRequest(a),
  });
  const res = await run([signup], { body: T(s.A.collegeId) });
  assert.equal(res.code, 201);
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. LOGIN + PROTECTED FEATURES WHILE PENDING / REJECTED
// ─────────────────────────────────────────────────────────────────────────────
test("login: pending teacher is refused with the original message plus a code; wrong password still 401", async () => {
  const s = setup();
  await pendingFor(s, "p@example.com");
  const r = await s.api.login("p@example.com", "Secret123");
  assert.equal(r.code, 403);
  assert.equal(r.body.code, "ACCOUNT_PENDING");
  assert.equal(r.body.message, "Your account is pending admin approval. Please try again later.");
  assert.equal(r.body.data, undefined);
  // a stranger guessing the password learns nothing about the account state
  const bad = await s.api.login("p@example.com", "nope");
  assert.equal(bad.code, 401);
  assert.equal(bad.body.code, undefined);
});

test("protected features: a token claiming approved:true is useless while the database says pending/rejected", async () => {
  const s = setup();
  const t = await pendingFor(s, "forge@example.com");
  const forged = s.tokenFor(t, true);                  // validly signed, but lies about approval
  assert.equal((await s.api.as(t, forged).protectedFeature()).code, 403);

  await s.api.as(s.adminA1).reject(String(t._id));
  const r = await s.api.as(t, forged).protectedFeature();
  assert.equal(r.code, 403);
  assert.equal(r.body.code, "ACCOUNT_REJECTED");
});

test("protected features: a deleted teacher's token stops working", async () => {
  const s = setup();
  const t = await pendingFor(s, "gone@example.com");
  await s.api.as(s.adminA1).approve(String(t._id));
  const token = s.tokenFor(s.db.User.rows.find((u) => u.email === "gone@example.com"));
  assert.equal((await s.api.as(t, token).protectedFeature()).code, 200);
  await s.api.as(s.adminA1).remove(String(t._id));
  assert.equal((await s.api.as(t, token).protectedFeature()).code, 401);
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. ADMIN VIEW + COLLEGE ISOLATION
// ─────────────────────────────────────────────────────────────────────────────
test("admin list: shows name, email, registration time and requested college — to that college's admins only", async () => {
  const s = setup();
  await pendingFor(s, "a1@example.com", s.A);
  await pendingFor(s, "b1@example.com", s.B);

  for (const admin of [s.adminA1, s.adminA2]) {
    const r = await s.api.as(admin).list({ status: "pending" });
    assert.equal(r.code, 200);
    const reqs = r.body.data.requests;
    assert.equal(reqs.length, 1);
    assert.equal(reqs[0].email, "a1@example.com");
    assert.equal(reqs[0].name, "Tina Teacher");
    assert.ok(reqs[0].registeredAt instanceof Date || !Number.isNaN(Date.parse(reqs[0].registeredAt)));
    assert.equal(reqs[0].college.name, "Alpha College");
    assert.equal(reqs[0].status, "pending");
    assert.deepEqual(r.body.data.counts, { pending: 1, approved: 0, rejected: 0 });
    assert.equal(JSON.stringify(r.body).includes("b1@example.com"), false);
    assert.equal(JSON.stringify(r.body).includes("Beta College"), false);
    assert.equal(JSON.stringify(r.body).includes("password"), false);
  }
  const rb = await s.api.as(s.adminB).list();
  assert.deepEqual(rb.body.data.requests.map((x) => x.email), ["b1@example.com"]);
});

test("isolation: College B's admin cannot approve, reject or delete College A's teacher (404, state unchanged)", async () => {
  const s = setup();
  const t = await pendingFor(s, "a@example.com", s.A);
  const id = String(t._id);
  const b = s.api.as(s.adminB);

  for (const call of [() => b.approve(id), () => b.reject(id), () => b.remove(id)]) {
    const r = await call();
    assert.equal(r.code, 404);
    assert.equal(r.body.currentStatus, undefined, "must not leak that the user exists");
  }
  const row = s.db.User.rows.find((u) => u.email === "a@example.com");
  assert.ok(row, "not deleted");
  assert.equal(row.approved, false);
  assert.equal(row.approvalStatus, "pending");
  assert.equal((await b.legacyList({ role: "teacher" })).body.data.users.length, 0);
});

test("isolation: tampering with the request body/query cannot widen scope", async () => {
  const s = setup();
  const t = await pendingFor(s, "a@example.com", s.A);
  const r = await run(
    [protect, s.requireApproved, authorize("admin"), s.requireCollegeAdmin, createTeacherRequestHandlers(s.service).approve],
    { headers: { authorization: `Bearer ${s.tokenFor(s.adminB)}` }, params: { id: String(t._id) },
      body: { collegeId: s.A.collegeId }, query: { collegeId: s.A.collegeId } }
  );
  assert.equal(r.code, 404);
  // JWT claiming College A for a College B admin: the DB wins
  const lying = s.tokenFor({ ...s.adminB, collegeId: s.A.collegeId });
  const r2 = await s.api.as(s.adminB, lying).approve(String(t._id));
  assert.equal(r2.code, 404);
  assert.equal(s.db.User.rows.find((u) => u.email === "a@example.com").approved, false);
});

test("isolation: a teacher cannot call admin endpoints (403) — including on their own account", async () => {
  const s = setup();
  const t = await pendingFor(s, "self@example.com");
  await s.api.as(s.adminA1).approve(String(t._id));
  const approvedT = s.db.User.rows.find((u) => u.email === "self@example.com");
  const tch = s.api.as(approvedT);
  assert.equal((await tch.list()).code, 403);
  assert.equal((await tch.approve(String(approvedT._id))).code, 403);
  assert.equal((await tch.reject(String(approvedT._id))).code, 403);
  assert.equal((await tch.remove(String(approvedT._id))).code, 403);

  // a still-pending teacher cannot even reach the admin chain
  const t2 = await pendingFor(s, "self2@example.com");
  const forged = s.tokenFor(t2, true);
  const r = await s.api.as(t2, forged).approve(String(t2._id));
  assert.equal(r.code, 403);
  assert.equal(s.db.User.rows.find((u) => u.email === "self2@example.com").approved, false);
});

test("isolation: an admin cannot decide on their own or another admin's account", async () => {
  const s = setup();
  assert.equal((await s.api.as(s.adminA1).approve(String(s.adminA1._id))).code, 403);
  assert.equal((await s.api.as(s.adminA1).reject(String(s.adminA2._id))).code, 404); // not a teacher request
  assert.equal(s.db.User.rows.find((u) => u._id === s.adminA2._id).approvalStatus, "approved");
});

test("admin session is re-checked in the database: deleted or demoted admins lose access", async () => {
  const s = setup();
  const t = await pendingFor(s, "t@example.com");
  const token = s.tokenFor(s.adminA2);
  s.db.User.rows.splice(s.db.User.rows.findIndex((u) => u._id === s.adminA2._id), 1);
  // Security part: a deleted account is "unknown" (401), no longer a 403.
  assert.equal((await s.api.as(s.adminA2, token).list()).code, 401);

  // an approved TEACHER whose token says admin
  await s.api.as(s.adminA1).approve(String(t._id));
  const teacherRow = s.db.User.rows.find((u) => u.email === "t@example.com");
  const fake = generateToken({ ...buildTokenPayload(teacherRow), role: "admin" });
  assert.equal((await s.api.as(teacherRow, fake).list()).code, 403);
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. APPROVE / REJECT
// ─────────────────────────────────────────────────────────────────────────────
test("approve: the college admin approves → teacher can log in, use protected features and is notified", async () => {
  const s = setup();
  const t = await pendingFor(s, "ok@example.com");
  const r = await s.api.as(s.adminA1).approve(String(t._id));
  assert.equal(r.code, 200);
  assert.equal(r.body.data.user.status, "approved");

  const row = s.db.User.rows.find((u) => u.email === "ok@example.com");
  assert.equal(row.approved, true);
  assert.equal(row.approvalStatus, "approved");
  assert.equal(String(row.approvalReviewedBy), String(s.adminA1._id));
  assert.ok(row.approvalReviewedAt instanceof Date);

  const login = await s.api.login("ok@example.com", "Secret123");
  assert.equal(login.code, 200);
  assert.ok(login.body.data.token);
  assert.equal(login.body.data.user.approvalStatus, "approved");
  assert.equal((await s.api.as(row, login.body.data.token).protectedFeature()).code, 200);

  // teacher sees a welcome notification; the other admin of A is informed; B's admin hears nothing
  const mine = (await s.api.as(row, login.body.data.token).notifications()).body.data.notifications;
  assert.ok(mine.some((n) => n.type === "teacher_request_approved"));
  const a2 = s.db.Notification.rows.filter((n) => String(n.userId) === String(s.adminA2._id) && n.type === "teacher_request_decided");
  assert.equal(a2.length, 1);
  assert.match(a2[0].message, /approved/);
  assert.equal(s.db.Notification.rows.filter((n) => String(n.userId) === String(s.adminB._id)).length, 0);
});

test("reject: rejected teacher never gets access (login, token, features) and cannot re-apply with the same email", async () => {
  const s = setup();
  const t = await pendingFor(s, "no@example.com");
  const r = await s.api.as(s.adminA1).reject(String(t._id));
  assert.equal(r.code, 200);
  assert.equal(r.body.data.user.status, "rejected");

  const row = s.db.User.rows.find((u) => u.email === "no@example.com");
  assert.equal(row.approved, false);
  assert.equal(row.approvalStatus, "rejected");

  const login = await s.api.login("no@example.com", "Secret123");
  assert.equal(login.code, 403);
  assert.equal(login.body.code, "ACCOUNT_REJECTED");
  assert.equal(login.body.data, undefined);
  assert.equal((await s.api.as(row).protectedFeature()).code, 403);
  assert.equal((await s.api.signup(T(s.A.collegeId, { email: "no@example.com" }))).code, 409);

  // listed under "rejected", gone from "pending"
  const rejected = (await s.api.as(s.adminA1).list({ status: "rejected" })).body.data;
  assert.deepEqual(rejected.requests.map((x) => x.email), ["no@example.com"]);
  assert.equal((await s.api.as(s.adminA1).list({ status: "pending" })).body.data.requests.length, 0);
  // the rejected teacher is NOT sent a notification they could never read; other admins are told
  assert.equal(s.db.Notification.rows.filter((n) => String(n.userId) === String(row._id)).length, 0);
});

test("a decision is final: approving a rejected request (or deciding twice) → 409 with the current status", async () => {
  const s = setup();
  const t = await pendingFor(s, "twice@example.com");
  await s.api.as(s.adminA1).reject(String(t._id));
  const r = await s.api.as(s.adminA2).approve(String(t._id));
  assert.equal(r.code, 409);
  assert.equal(r.body.code, "ALREADY_DECIDED");
  assert.equal(r.body.currentStatus, "rejected");
  assert.equal(s.db.User.rows.find((u) => u.email === "twice@example.com").approved, false);

  const t2 = await pendingFor(s, "twice2@example.com");
  assert.equal((await s.api.as(s.adminA1).approve(String(t2._id))).code, 200);
  const again = await s.api.as(s.adminA2).approve(String(t2._id));
  assert.equal(again.code, 409);
  assert.equal(again.body.currentStatus, "approved");
});

test("recovery path: deleting a rejected account lets the person apply again", async () => {
  const s = setup();
  const t = await pendingFor(s, "again@example.com");
  await s.api.as(s.adminA1).reject(String(t._id));
  assert.equal((await s.api.as(s.adminA1).remove(String(t._id))).code, 200);
  assert.equal((await s.api.signup(T(s.A.collegeId, { email: "again@example.com" }))).code, 201);
});

test("decision RACE: two admins approve/reject at the same moment → exactly one wins", async () => {
  const s = setup();
  const t = await pendingFor(s, "r@example.com");
  const [x, y] = await Promise.all([s.api.as(s.adminA1).approve(String(t._id)), s.api.as(s.adminA2).reject(String(t._id))]);
  assert.deepEqual([x.code, y.code].sort(), [200, 409]);
  const row = s.db.User.rows.find((u) => u.email === "r@example.com");
  const winner = x.code === 200 ? "approved" : "rejected";
  assert.equal(row.approvalStatus, winner);
  assert.equal(row.approved, winner === "approved");
  const loser = x.code === 200 ? y : x;
  assert.equal(loser.body.currentStatus, winner);
});

test("decision RACE: ten simultaneous approvals → one success, one welcome notification", async () => {
  const s = setup();
  const t = await pendingFor(s, "ten@example.com");
  const rs = await Promise.all(Array.from({ length: 10 }, (_, i) => s.api.as(i % 2 ? s.adminA1 : s.adminA2).approve(String(t._id))));
  assert.equal(rs.filter((r) => r.code === 200).length, 1);
  assert.equal(rs.filter((r) => r.code === 409).length, 9);
  const welcomes = s.db.Notification.rows.filter((n) => n.type === "teacher_request_approved");
  assert.equal(welcomes.length, 1);
});

test("a failing notification system does not undo or block a decision", async () => {
  const s = setup();
  const t = await pendingFor(s, "nb@example.com");
  const boom = { createMany: async () => { throw new Error("down"); } };
  const service = createTeacherApprovalService({ User: s.db.User, College: s.db.College, notifier: boom, log: { error() {} } });
  const scope = (await service.resolveAdminScope(String(s.adminA1._id))).scope;
  const r = await service.decide(scope, String(t._id), "approve");
  assert.equal(r.ok, true);
  assert.equal(s.db.User.rows.find((u) => u.email === "nb@example.com").approved, true);
});

test("bad ids and bad filters are handled safely", async () => {
  const s = setup();
  const a = s.api.as(s.adminA1);
  for (const id of ["abc", "", "123", "x".repeat(24), "../etc"]) {
    assert.equal((await a.approve(id)).code, 404, id);
    assert.equal((await a.remove(id)).code, 404, id);
  }
  assert.equal((await a.approve("0".repeat(24))).code, 404);
  assert.equal((await a.list({ status: "bogus" })).code, 400);
  assert.equal((await a.list({ status: { $ne: "x" } })).code, 400);
  assert.equal((await a.list({ status: "pending", page: "-5", limit: "99999" })).body.data.limit, 100);
});

test("pending list is oldest-first and paginates", async () => {
  const s = setup();
  for (let i = 0; i < 5; i++) {
    const t = await pendingFor(s, `p${i}@example.com`);
    t.createdAt = new Date(2026, 0, 1, 0, i);       // p0 oldest
  }
  const r1 = await s.api.as(s.adminA1).list({ status: "pending", limit: 2, page: 1 });
  assert.deepEqual(r1.body.data.requests.map((x) => x.email), ["p0@example.com", "p1@example.com"]);
  const r3 = await s.api.as(s.adminA1).list({ status: "pending", limit: 2, page: 3 });
  assert.deepEqual(r3.body.data.requests.map((x) => x.email), ["p4@example.com"]);
  assert.equal(r1.body.data.counts.pending, 5);
});

test("summary returns counts for the admin's own college only", async () => {
  const s = setup();
  await pendingFor(s, "s1@example.com", s.A);
  await pendingFor(s, "s2@example.com", s.B);
  const r = await s.api.as(s.adminA1).summary();
  assert.deepEqual(r.body.data.counts, { pending: 1, approved: 0, rejected: 0 });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. SUSPENDED / DELETED / UNAVAILABLE COLLEGES
// ─────────────────────────────────────────────────────────────────────────────
test("suspended college: its admins cannot manage requests; pending teachers get a clear login message; reactivation restores everything", async () => {
  const s = setup();
  const t = await pendingFor(s, "susp@example.com");
  s.A.status = "suspended";

  const list = await s.api.as(s.adminA1).list();
  assert.equal(list.code, 403);
  assert.equal(list.body.code, "COLLEGE_SUSPENDED");
  assert.equal((await s.api.as(s.adminA1).approve(String(t._id))).code, 403);
  assert.equal(s.db.User.rows.find((u) => u.email === "susp@example.com").approved, false);

  const login = await s.api.login("susp@example.com", "Secret123");
  assert.equal(login.code, 403);
  assert.equal(login.body.code, "COLLEGE_UNAVAILABLE");

  // new teachers can't apply to it either
  assert.equal((await s.api.signup(T(s.A.collegeId, { email: "new@example.com" }))).code, 400);

  s.A.status = "active";
  assert.equal((await s.api.as(s.adminA1).approve(String(t._id))).code, 200);
  assert.equal((await s.api.login("susp@example.com", "Secret123")).code, 200);
});

test("deleted college: admins and pending teachers are handled without errors", async () => {
  const s = setup();
  const t = await pendingFor(s, "del@example.com");
  s.db.College.rows.splice(s.db.College.rows.indexOf(s.A), 1);
  const r = await s.api.as(s.adminA1).approve(String(t._id));
  assert.equal(r.code, 403);
  assert.equal(r.body.code, "COLLEGE_UNAVAILABLE");
  const login = await s.api.login("del@example.com", "Secret123");
  assert.equal(login.code, 403);
  assert.equal(login.body.code, "COLLEGE_UNAVAILABLE");
  assert.equal(s.db.User.rows.find((u) => u.email === "del@example.com").approved, false);
});

test("CHANGED in the security part: a suspended college locks out its approved teachers too (login and existing tokens)", async () => {
  const s = setup();
  const t = await pendingFor(s, "keep@example.com");
  await s.api.as(s.adminA1).approve(String(t._id));
  const row = s.db.User.rows.find((u) => u.email === "keep@example.com");
  const token = s.tokenFor(row);
  assert.equal((await s.api.as(row, token).protectedFeature()).code, 200);

  s.A.status = "suspended";
  const login = await s.api.login("keep@example.com", "Secret123");
  assert.equal(login.code, 403);
  assert.equal(login.body.code, "COLLEGE_UNAVAILABLE");
  const live = await s.api.as(row, token).protectedFeature();
  assert.equal(live.code, 403);
  assert.equal(live.body.code, "COLLEGE_SUSPENDED");

  s.A.status = "active"; // reactivation restores access immediately
  assert.equal((await s.api.as(row, token).protectedFeature()).code, 200);
  assert.equal((await s.api.login("keep@example.com", "Secret123")).code, 200);
});

test("login eligibility treats a database error while checking the college as 'unavailable' (fails closed)", async () => {
  const College = { findOne: () => { throw new Error("db down"); } };
  const r = await checkLoginEligibility({ user: { role: "teacher", approved: false, collegeId: "COL-X" }, College });
  assert.equal(r.ok, false);
  assert.equal(r.code, "COLLEGE_UNAVAILABLE");
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. EXISTING USERS KEEP WORKING
// ─────────────────────────────────────────────────────────────────────────────
test("existing users: pre-Part-8 admins and approved teachers (no approvalStatus, maybe no college) log in as before", async () => {
  const s = setup();
  const legacyTeacher = s.db.User.seed({ name: "Old Teacher", email: "old@example.com", password: "Secret123", role: "teacher", approved: true, collegeId: null });
  const legacyAdmin = s.db.User.seed({ name: "Old Admin", email: "oldadmin@example.com", password: "Secret123", role: "admin", approved: true });
  const inCollege = s.db.User.seed({ name: "Mid Teacher", email: "mid@example.com", password: "Secret123", role: "teacher", approved: true, collegeId: s.A.collegeId });

  for (const u of [legacyTeacher, legacyAdmin, inCollege]) {
    const r = await s.api.login(u.email, "Secret123");
    assert.equal(r.code, 200, u.email);
    assert.ok(r.body.data.token);
    assert.equal(r.body.data.user.approvalStatus, u.role === "admin" || u.approved ? "approved" : "pending");
  }
  assert.equal((await s.api.as(legacyTeacher).protectedFeature()).code, 200);
  assert.equal((await s.api.as(inCollege).protectedFeature()).code, 200);
  assert.equal((await s.api.as(legacyAdmin).protectedFeature()).code, 200);
});

test("existing users: legacy unapproved teacher (no approvalStatus) is 'pending' and is visible ONLY to a same-scope admin", async () => {
  const s = setup();
  const legacyAdmin = s.db.User.seed({ name: "Old Admin", email: "oldadmin@example.com", password: "Secret123", role: "admin", approved: true });
  const legacyPending = s.db.User.seed({ name: "Old Pending", email: "oldp@example.com", password: "Secret123", role: "teacher", approved: false });

  assert.equal((await s.api.login("oldp@example.com", "Secret123")).body.code, "ACCOUNT_PENDING");
  // College admins never see unassigned legacy teachers…
  assert.equal((await s.api.as(s.adminA1).list()).body.data.requests.length, 0);
  assert.equal((await s.api.as(s.adminA1).approve(String(legacyPending._id))).code, 404);
  // …and a college-less legacy admin never sees college teachers.
  await pendingFor(s, "col@example.com", s.A);
  const la = await s.api.as(legacyAdmin).list();
  assert.deepEqual(la.body.data.requests.map((x) => x.email), ["oldp@example.com"]);
  assert.equal(la.body.data.requests[0].college, null);
  assert.equal((await s.api.as(legacyAdmin).approve(String(legacyPending._id))).code, 200);
});

test("backfill: sets approvalStatus on old rows, is idempotent, and never changes access", async () => {
  const s = setup();
  s.db.User.seed({ name: "a", email: "o1@x.com", password: "x", role: "teacher", approved: true });
  s.db.User.seed({ name: "b", email: "o2@x.com", password: "x", role: "teacher", approved: false });
  const n1 = await backfillApprovalStatus(s.db.User);
  assert.ok(n1 >= 2);
  assert.equal(s.db.User.rows.find((u) => u.email === "o1@x.com").approvalStatus, "approved");
  assert.equal(s.db.User.rows.find((u) => u.email === "o2@x.com").approvalStatus, "pending");
  assert.equal(await backfillApprovalStatus(s.db.User), 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. NOTIFICATIONS ARE PRIVATE
// ─────────────────────────────────────────────────────────────────────────────
test("notifications: each user sees only their own and cannot mark someone else's as read", async () => {
  const s = setup();
  await pendingFor(s, "nn@example.com");
  const a1 = (await s.api.as(s.adminA1).notifications()).body.data;
  assert.equal(a1.notifications.length, 1);
  assert.equal(a1.unread, 1);
  assert.equal((await s.api.as(s.adminB).notifications()).body.data.notifications.length, 0);

  const id = a1.notifications[0].id;
  assert.equal((await s.api.as(s.adminB).markRead(id)).code, 404);
  assert.equal(s.db.Notification.rows[0].read, false);
  assert.equal((await s.api.as(s.adminA1).markRead(id)).code, 200);
  assert.equal(s.db.Notification.rows.find((n) => String(n._id) === id).read, true);
  assert.equal((await s.api.as(s.adminA1).markRead("not-an-id")).code, 404);
});
