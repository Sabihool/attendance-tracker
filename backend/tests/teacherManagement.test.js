/**
 * Part 15 — college teacher management and admin promotion/demotion.
 * REAL routers/middleware/services/models over HTTP (helpers/e2eApp.js).
 * Two colleges; every forbidden case also asserts that NOTHING changed.
 */
import test, { beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startApp, makeCollege, models } from "./helpers/e2eApp.js";
import { generateToken, buildTokenPayload } from "../utils/token.js";
import jwt from "jsonwebtoken";
import Notification from "../models/Notification.js";

const { User, College } = models;

let app, call, A, B;
const T = "/api/admin/teachers";
const patch = (t, p, body) => call(t, "PATCH", p, { body });
const get = (t, p, query) => call(t, "GET", p, { query });
const del = (t, p, body) => call(t, "DELETE", p, { body });
const tokenOf = (u) => generateToken(buildTokenPayload(u));
const fresh = (u) => User.findById(u._id).lean();
const login = async (u) => (await call(null, "POST", "/api/auth/login", { body: { email: u.email, password: "secret123" } }));

const mkUser = (C, role, extra = {}) => User.create({
  name: `${role} ${Math.random().toString(36).slice(2, 6)}`, email: `u${Math.random().toString(36).slice(2)}@example.com`, password: "secret123",
  role, approved: true, approvalStatus: "approved", collegeId: C.collegeId, ...extra,
});
const mkPending = (C) => mkUser(C, "teacher", { approved: false, approvalStatus: "pending" });

beforeEach(async () => {
  if (app) await app.close();
  app = await startApp();
  call = app.call;
  A = await makeCollege("Alpha");
  B = await makeCollege("Beta");
  // A.admin is the college's founding administrator.
  await College.updateOne({ collegeId: A.collegeId }, { $set: { createdBy: A.admin._id } });
  await College.updateOne({ collegeId: B.collegeId }, { $set: { createdBy: B.admin._id } });
});
after(async () => { if (app) await app.close(); });

// ── viewing ──────────────────────────────────────────────────────────────────
test("list: an admin sees only their own college's members, with status, capabilities and counts", async () => {
  const pend = await mkPending(A);
  await mkPending(B);
  const r = await get(A.adminToken, T);
  assert.equal(r.status, 200);
  const emails = r.data.members.map((m) => m.email);
  assert.ok(emails.includes(pend.email) && emails.includes(A.teacher.email));
  assert.ok(!emails.some((e) => e.includes(B.collegeId.toLowerCase())), "no foreign member");
  assert.equal(r.data.counts.pending, 1);
  const p = r.data.members.find((m) => m.email === pend.email);
  assert.equal(p.status, "pending");
  assert.deepEqual([p.capabilities.canApprove, p.capabilities.canReject, p.capabilities.canPromote], [true, true, false]);
  // admins are only listed when asked for
  assert.ok(!r.data.members.some((m) => m.role === "admin"));
  const admins = await get(A.adminToken, T, { type: "admin" });
  assert.deepEqual(admins.data.members.map((m) => [m.id, m.isFounder, m.isSelf]), [[String(A.admin._id), true, true]]);
  assert.equal(admins.data.members[0].capabilities.canDemote, false);
});

test("list: filters, search is literal text, junk input is a 400", async () => {
  const x = await mkUser(A, "teacher", { name: "Zed Ünique" });
  assert.equal((await get(A.adminToken, T, { q: "zed" })).data.members.length, 1);
  assert.equal((await get(A.adminToken, T, { q: ".*" })).data.members.length, 0, "regex characters do not widen the search");
  assert.equal((await get(A.adminToken, T, { status: "approved" })).data.members.length, 2);
  assert.equal((await get(A.adminToken, T, { status: "weird" })).status, 400);
  assert.equal((await get(A.adminToken, T, { type: "superadmin" })).status, 400);
  assert.equal((await get(A.adminToken, T, { role: "admin" })).status, 400, "the refused key `role` is not a filter");
  assert.equal((await call(A.adminToken, "GET", `${T}?q[$ne]=x`)).status, 400);
  void x;
});

test("detail: shows status and activity; another college's teacher is a 404", async () => {
  const dept = await call(A.adminToken, "POST", "/api/departments", { body: { name: "Computer Science" } });
  assert.equal(dept.status, 201);
  assert.equal((await call(A.adminToken, "POST", "/api/shifts", { body: { name: "Morning", order: 1 } })).status, 201);
  const s = await call(A.teacherToken, "POST", "/api/subjects", { body: { subjectName: "Networks", subjectCode: "CSE-101", batch: "2024", department: "Computer Science", shift: "Morning" } });
  assert.equal(s.status, 201, JSON.stringify(s.body));
  const d = await get(A.adminToken, `${T}/${A.teacher._id}`);
  assert.equal(d.status, 200);
  assert.equal(d.data.member.activity.totalSubjects, 1);
  assert.equal(d.data.subjects[0].subjectCode, "CSE-101");
  const bTeacher = await mkUser(B, "teacher");
  assert.equal((await get(A.adminToken, `${T}/${bTeacher._id}`)).status, 404);
  assert.equal((await get(A.adminToken, `${T}/not-an-id`)).status, 404);
});

test("the teacher-performance page still works and is unchanged for the same data", async () => {
  const r = await get(A.adminToken, "/api/admin/teacher-performance");
  assert.equal(r.status, 200);
  assert.equal(r.data.teachers.length, 1);
  assert.equal(r.data.teachers[0].email, A.teacher.email);
});

// ── approve / reject / delete ────────────────────────────────────────────────
test("approve and reject work inside the college; deciding twice is a 409; cross-college is a 404", async () => {
  const p1 = await mkPending(A), p2 = await mkPending(A), pb = await mkPending(B);
  assert.equal((await patch(A.adminToken, `${T}/${p1._id}/approve`)).status, 200);
  assert.equal((await fresh(p1)).approved, true);
  assert.equal((await patch(A.adminToken, `${T}/${p1._id}/approve`)).status, 409);
  assert.equal((await patch(A.adminToken, `${T}/${p2._id}/reject`)).status, 200);
  assert.equal((await fresh(p2)).approvalStatus, "rejected");
  assert.equal((await patch(A.adminToken, `${T}/${pb._id}/approve`)).status, 404);
  assert.equal((await fresh(pb)).approved, false);
});

test("delete: a teacher of the college can be deleted; admins, self and foreign users cannot", async () => {
  const t = await mkUser(A, "teacher"), tb = await mkUser(B, "teacher");
  const second = await mkUser(A, "admin");
  assert.equal((await del(A.adminToken, `${T}/${tb._id}`)).status, 404);
  assert.ok(await fresh(tb));
  const r = await del(A.adminToken, `${T}/${second._id}`);
  assert.equal(r.status, 409); assert.equal(r.body.code, "ADMIN_NOT_DELETABLE");
  assert.ok(await fresh(second));
  assert.equal((await del(A.adminToken, `${T}/${A.admin._id}`)).status, 400);
  assert.ok(await fresh(A.admin));
  assert.equal((await del(A.adminToken, `${T}/${t._id}`)).status, 200);
  assert.equal(await fresh(t), null);
  assert.equal((await get(tokenOf(t), "/api/auth/me")).status, 401, "a deleted account's token stops working at once");
  // legacy route shares the same rule
  assert.equal((await del(A.adminToken, `/api/auth/users/${second._id}`)).status, 409);
});

// ── permitted promotion / demotion ───────────────────────────────────────────
test("promote: approved teacher becomes admin; old token dies, new sign-in has admin power at once", async () => {
  const t = A.teacher, old = A.teacherToken;
  assert.equal((await get(old, "/api/admin/teacher-performance")).status, 403);
  const r = await patch(A.adminToken, `${T}/${t._id}/promote`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await fresh(t)).role, "admin");
  assert.equal((await fresh(t)).authVersion, 1);
  assert.equal((await get(old, "/api/admin/teacher-performance")).status, 401, "pre-promotion token is revoked");
  const l = await login(t);
  assert.equal(l.status, 200);
  assert.equal(l.data.user.role, "admin");
  assert.equal((await get(l.data.token, "/api/admin/teacher-performance")).status, 200);
  assert.equal((await get(l.data.token, T)).status, 200, "the new admin can use the management API");
  assert.ok((await Notification.find({ userId: t._id }).lean()).some((n) => n.type === "role_promoted"));
});

test("demote: a non-founder admin loses power immediately; they can still sign in as a teacher", async () => {
  const second = await mkUser(A, "admin");
  const tok = tokenOf(second);
  assert.equal((await get(tok, T)).status, 200);
  assert.equal((await patch(A.adminToken, `${T}/${second._id}/demote`)).status, 200);
  assert.equal((await fresh(second)).role, "teacher");
  assert.equal((await get(tok, T)).status, 401);
  const l = await login(second);
  assert.equal(l.data.user.role, "teacher");
  assert.equal((await get(l.data.token, T)).status, 403);
  assert.equal((await get(l.data.token, "/api/subjects")).status, 200, "teacher features keep working");
});

test("a promoted admin can in turn manage teachers — but never the founder", async () => {
  const second = await mkUser(A, "admin");
  const tok = tokenOf(second);
  const t = await mkUser(A, "teacher");
  assert.equal((await patch(tok, `${T}/${t._id}/promote`)).status, 200);
  const r = await patch(tok, `${T}/${A.admin._id}/demote`);
  assert.equal(r.status, 403); assert.equal(r.body.code, "FOUNDER_PROTECTED");
  assert.equal((await fresh(A.admin)).role, "admin");
  assert.equal((await del(tok, `${T}/${A.admin._id}`)).status, 409, "the founder cannot be deleted either");
  assert.ok(await fresh(A.admin));
});

// ── forbidden promotion / demotion ───────────────────────────────────────────
test("a teacher cannot promote themselves or anyone (403), and nothing changes", async () => {
  const other = await mkUser(A, "teacher");
  for (const id of [A.teacher._id, other._id]) {
    assert.equal((await patch(A.teacherToken, `${T}/${id}/promote`)).status, 403);
    assert.equal((await patch(A.teacherToken, `${T}/${id}/demote`)).status, 403);
  }
  assert.equal((await get(A.teacherToken, T)).status, 403);
  assert.equal((await fresh(A.teacher)).role, "teacher");
  assert.equal((await fresh(other)).role, "teacher");
});

test("a teacher with a token CLAIMING admin (stale or forged claim) still has no power: the role comes from the database", async () => {
  const claim = jwt.sign({ ...buildTokenPayload(A.teacher), role: "admin" }, process.env.JWT_SECRET, { algorithm: "HS256" });
  assert.equal((await patch(claim, `${T}/${A.teacher._id}/promote`)).status, 403);
  assert.equal((await fresh(A.teacher)).role, "teacher");
  const none = jwt.sign({ ...buildTokenPayload(A.admin), role: "admin" }, "wrong-secret", { algorithm: "HS256" });
  assert.equal((await patch(none, `${T}/${A.teacher._id}/promote`)).status, 401);
  assert.equal((await patch(null, `${T}/${A.teacher._id}/promote`)).status, 401);
});

test("an admin cannot promote or demote a user of another college (404), by id or by smuggled collegeId", async () => {
  const tb = await mkUser(B, "teacher");
  assert.equal((await patch(A.adminToken, `${T}/${tb._id}/promote`)).status, 404);
  assert.equal((await patch(A.adminToken, `${T}/${B.admin._id}/demote`)).status, 404);
  assert.equal((await patch(A.adminToken, `${T}/${tb._id}/promote`, { collegeId: B.collegeId })).status, 400);
  assert.equal((await patch(A.adminToken, `${T}/${tb._id}/promote?collegeId=${B.collegeId}`)).status, 400);
  assert.equal((await fresh(tb)).role, "teacher");
  assert.equal((await fresh(B.admin)).role, "admin");
  assert.equal((await fresh(tb)).collegeId, B.collegeId);
});

test("manipulated request bodies are refused: role, collegeId, approved, authVersion, nested and mixed-case keys", async () => {
  const t = await mkUser(A, "teacher");
  const bodies = [{ role: "admin" }, { Role: "superadmin" }, { collegeId: "COL-X" }, { approved: true }, { authVersion: 99 },
    { user: { role: "admin" } }, { isAdmin: true }, { approvalStatus: "approved" }, { createdBy: String(t._id) }];
  for (const b of bodies) {
    for (const action of ["promote", "demote", "approve", "reject"]) {
      const r = await patch(A.adminToken, `${T}/${t._id}/${action}`, b);
      assert.equal(r.status, 400, `${action} ${JSON.stringify(b)}`);
    }
    assert.equal((await del(A.adminToken, `${T}/${t._id}`, b)).status, 400);
  }
  const after = await fresh(t);
  assert.deepEqual([after.role, after.collegeId, after.authVersion ?? 0], ["teacher", A.collegeId, 0]);
  assert.ok(after, "still exists");
});

test("a 'role' in the URL is not a way in: only promote/demote exist, no generic role endpoint", async () => {
  const t = await mkUser(A, "teacher");
  for (const [m, p] of [["PATCH", `${T}/${t._id}/role`], ["PUT", `${T}/${t._id}`], ["PATCH", `${T}/${t._id}`], ["POST", T], ["PATCH", `/api/auth/users/${t._id}`], ["PUT", `/api/auth/me`]]) {
    const r = await call(A.adminToken, m, p, { body: { role: "admin" } });
    assert.ok([404, 400].includes(r.status), `${m} ${p} → ${r.status}`);
  }
  assert.equal((await fresh(t)).role, "teacher");
});

test("self change is refused for admins in both directions", async () => {
  const second = await mkUser(A, "admin");
  const tok = tokenOf(second);
  const r = await patch(tok, `${T}/${second._id}/demote`);
  assert.equal(r.status, 403); assert.equal(r.body.code, "SELF_CHANGE");
  assert.equal((await fresh(second)).role, "admin");
  const f = await patch(A.adminToken, `${T}/${A.admin._id}/demote`);
  assert.equal(f.body.code, "SELF_CHANGE");
});

test("only approved accounts can be promoted; pending, rejected and already-admin are refused", async () => {
  const p = await mkPending(A);
  const rej = await mkUser(A, "teacher", { approved: false, approvalStatus: "rejected" });
  assert.equal((await patch(A.adminToken, `${T}/${p._id}/promote`)).body.code, "NOT_APPROVED");
  assert.equal((await patch(A.adminToken, `${T}/${rej._id}/promote`)).body.code, "NOT_APPROVED");
  assert.equal((await fresh(p)).role, "teacher");
  const second = await mkUser(A, "admin");
  const again = await patch(A.adminToken, `${T}/${second._id}/promote`);
  assert.equal(again.status, 200); assert.equal((await fresh(second)).authVersion ?? 0, 0, "no-op: nothing bumped");
  // a teacher cannot be 'demoted'
  assert.equal((await patch(A.adminToken, `${T}/${A.teacher._id}/demote`)).status, 200);
  assert.equal((await fresh(A.teacher)).authVersion ?? 0, 0);
});

// ── founder / multiple admins / last admin ───────────────────────────────────
test("last admin: a college can never be left without one (stale demoted admin, legacy college without founder)", async () => {
  // No founder recorded (legacy college): the last-admin rule alone must protect the sole admin.
  await College.updateOne({ collegeId: A.collegeId }, { $set: { createdBy: null } });
  const second = await mkUser(A, "admin");
  assert.equal((await patch(A.adminToken, `${T}/${second._id}/demote`)).status, 200);
  // second is now a teacher; A.admin is the only admin. Nobody else can demote them, and they cannot self-demote.
  assert.equal((await patch(A.adminToken, `${T}/${A.admin._id}/demote`)).body.code, "SELF_CHANGE");
  const third = await mkUser(A, "admin");
  const thirdTok = tokenOf(third);
  assert.equal((await patch(thirdTok, `${T}/${A.admin._id}/demote`)).status, 200, "two admins: allowed");
  // Now third is the only admin left; A.admin (demoted) cannot act and third cannot demote themself.
  assert.equal((await patch(A.adminToken, `${T}/${third._id}/demote`)).status, 401);
  assert.equal(await User.countDocuments({ collegeId: A.collegeId, role: "admin" }), 1);
});

test("two admins demoting each other at the same moment never leave the college empty", async () => {
  await College.updateOne({ collegeId: A.collegeId }, { $set: { createdBy: null } });
  const second = await mkUser(A, "admin");
  const [r1, r2] = await Promise.all([
    patch(A.adminToken, `${T}/${second._id}/demote`),
    patch(tokenOf(second), `${T}/${A.admin._id}/demote`),
  ]);
  assert.ok(await User.countDocuments({ collegeId: A.collegeId, role: "admin" }) >= 1, `${r1.status}/${r2.status}`);
});

test("no super administrator: roles are only admin|teacher, and promoted admins stay inside their college", async () => {
  const t = await mkUser(A, "teacher");
  assert.equal((await patch(A.adminToken, `${T}/${t._id}/promote`)).status, 200);
  const l = await login(t);
  const tok = l.data.token;
  assert.equal(User.schema.path("role").enumValues.join(), "admin,teacher");
  // the new admin is still confined to college A
  const bT = await mkUser(B, "teacher");
  assert.equal((await patch(tok, `${T}/${bT._id}/promote`)).status, 404);
  assert.ok(!(await get(tok, T, { type: "all" })).data.members.some((m) => m.email === bT.email));
  assert.equal((await fresh(t)).collegeId, A.collegeId);
  // no endpoint can mint a role outside the enum
  const ghost = await mkUser(A, "teacher");
  assert.equal((await patch(A.adminToken, `${T}/${ghost._id}/superadmin`)).status, 404);
});

test("admins of a suspended college, and admins without a college, cannot manage anyone", async () => {
  const t = await mkUser(A, "teacher");
  await College.updateOne({ collegeId: A.collegeId }, { $set: { status: "suspended" } });
  assert.equal((await patch(A.adminToken, `${T}/${t._id}/promote`)).status, 403);
  await College.updateOne({ collegeId: A.collegeId }, { $set: { status: "active" } });
  const orphanAdmin = await User.create({ name: "Legacy Admin", email: "legacy@example.com", password: "secret123", role: "admin", approved: true, approvalStatus: "approved", collegeId: null });
  const orphanTeacher = await User.create({ name: "Legacy Teacher", email: "legacyt@example.com", password: "secret123", role: "teacher", approved: true, approvalStatus: "approved", collegeId: null });
  const r = await patch(tokenOf(orphanAdmin), `${T}/${orphanTeacher._id}/promote`);
  assert.equal(r.status, 403);
  assert.equal((await fresh(orphanTeacher)).role, "teacher");
  assert.equal((await fresh(t)).role, "teacher");
});

// ── structural guard ─────────────────────────────────────────────────────────
test("structure: every management route is behind the full admin chain, and only the sanctioned files write role/collegeId/authVersion", async () => {
  const { default: router } = await import("../routes/teacherManagementRoutes.js");
  const { protect, requireApproved, authorize } = await import("../middleware/authMiddleware.js");
  const { requireCollegeAdmin } = await import("../services/approvalWiring.js");
  const { rejectPrivilegedFields } = await import("../middleware/privilegeGuards.js");
  void authorize;
  const uses = router.stack.filter((l) => !l.route).map((l) => l.handle);
  assert.equal(uses[0], protect); assert.equal(uses[1], requireApproved);
  assert.ok(uses.includes(requireCollegeAdmin) && uses.includes(rejectPrivilegedFields));
  const routes = router.stack.filter((l) => l.route).map((l) => `${Object.keys(l.route.methods)[0]} ${l.route.path}`).sort();
  assert.deepEqual(routes, ["delete /:id", "get /", "get /:id", "get /summary", "patch /:id/approve", "patch /:id/demote", "patch /:id/promote", "patch /:id/reject"]);

  // No other source file may write the privileged fields.
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
  const ALLOWED = new Set(["services/accountSecurityService.js", "services/teacherApprovalService.js", "utils/approvalBackfill.js",
    "utils/academicBackfill.js", "utils/attendanceBackfill.js", "utils/legacyCollegeMigration.js", "controllers/collegeController.js", "controllers/authController.js"]);
  const offenders = [];
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).forEach((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!["node_modules", "tests", "scripts"].includes(e.name)) walk(p); return; }
    if (!e.name.endsWith(".js")) return;
    const rel = path.relative(root, p).replaceAll("\\", "/");
    const src = fs.readFileSync(p, "utf8");
    const writes = /\$set\s*:\s*\{[^}]*\b(role|collegeId|authVersion|approved|approvalStatus)\b/.test(src)
      || /\$inc\s*:\s*\{[^}]*authVersion/.test(src)
      || /\b(user|u|doc|target|me|account)\.(role|collegeId|authVersion)\s*=[^=]/.test(src);
    if (writes && !ALLOWED.has(rel)) offenders.push(rel);
  });
  walk(root);
  assert.deepEqual(offenders, [], "unreviewed code writes role/collegeId/authVersion/approval");
});
