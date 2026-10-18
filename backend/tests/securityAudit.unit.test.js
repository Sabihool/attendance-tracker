/**
 * Part 19 — security audit, PURE-LOGIC layer.
 *
 * These tests need no database driver, no Express and no Mongoose (see ./helpers/miniDb.js), so they run
 * on a bare `node --test`. They prove the building blocks every route relies on:
 *   tenant scoping · privilege / tenant-field stripping · session resolution (pending / rejected / suspended /
 *   stale role) · role changes (promotion cannot be forged) · teacher approval across colleges · backup
 *   signing · rate limiters · cache isolation · public-lookup input validation · formula-injection guard.
 *
 * The HTTP-level counterpart (two seeded colleges, every route) is ./securityAudit.test.js.
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-test-secret-test-secret-123";
const origWarn = console.warn, origLog = console.log, origErr = console.error;
console.warn = () => {}; console.log = () => {}; console.error = () => {}; // security log lines
test.after(() => { console.warn = origWarn; console.log = origLog; console.error = origErr; });

import { makeModel, oid } from "./helpers/miniDb.js";
import { run, mkRes } from "./helpers/httpHarness.js";
import { scopeFilter, scopedModel, scopedAggregate, TenantScopeError, isClientTenantKey } from "../utils/tenantScope.js";
import { stripClientTenantFields, loadOwnedResource } from "../middleware/tenantGuards.js";
import { rejectPrivilegedFields } from "../middleware/privilegeGuards.js";
import { createRequireApproved } from "../middleware/approvalGuards.js";
import { createAuthSessionService } from "../services/authSessionService.js";
import { createAccountSecurityService } from "../services/accountSecurityService.js";
import { createTeacherApprovalService } from "../services/teacherApprovalService.js";
import { pickOwn, neutralizeFormula } from "../utils/safeKey.js";
import { securityHeaders } from "../middleware/securityHeaders.js";
import { buildBackupFile, verifyBackupFile } from "../utils/backupFormat.js";
import { createFailureLimiter, createRateLimiter } from "../middleware/rateLimit.js";
import { createTenantCache } from "../utils/analyticsCache.js";
import { validateLookupInput } from "../validators/publicLookupValidator.js";
import { isAccessApproved } from "../utils/approval.js";

const COL_A = "COL-2222222222", COL_B = "COL-2222222223";
const A = { collegeId: COL_A, userId: oid(), role: "admin" };
const B = { collegeId: COL_B, userId: oid(), role: "admin" };

// ───────────────────────────────────────────────── 1/5/9. tenant scoping

test("scopeFilter pins collegeId last and refuses a caller-supplied collegeId", () => {
  assert.deepEqual(scopeFilter(A, { name: "x" }), { name: "x", collegeId: COL_A });
  for (const k of ["collegeId", "COLLEGEID", "CollegeId"]) {
    assert.throws(() => scopeFilter(A, { [k]: COL_B }), TenantScopeError);
  }
  assert.throws(() => scopeFilter(null, {}), TenantScopeError);
  assert.throws(() => scopeFilter({ collegeId: "" }, {}), TenantScopeError);
  assert.throws(() => scopeFilter(A, [{ collegeId: COL_B }]), TenantScopeError);
});

test("scopedModel: every read is limited to the caller's college (same ids/rolls in two colleges)", async () => {
  const Student = makeModel("Student");
  Student.seed({ studentId: "S-1", roll: "1", name: "Alpha One", collegeId: COL_A });
  Student.seed({ studentId: "S-1", roll: "1", name: "Beta One", collegeId: COL_B });
  const a = scopedModel(Student, A), b = scopedModel(Student, B);
  assert.deepEqual((await a.find({ studentId: "S-1" })).map((s) => s.name), ["Alpha One"]);
  assert.deepEqual((await b.find({ studentId: "S-1" })).map((s) => s.name), ["Beta One"]);
  assert.equal(await a.countDocuments({}), 1);
  const betaDoc = Student.rows.find((r) => r.collegeId === COL_B);
  assert.equal(await a.findById(betaDoc._id), null, "A must not load B's student by id");
  assert.equal(await a.findOne({ _id: betaDoc._id }), null);
  assert.equal(await a.exists({ _id: betaDoc._id }), null);
  assert.ok(await b.findById(betaDoc._id));
});

test("scopedModel: operator / object ids and junk never match anything", async () => {
  const Student = makeModel("Student");
  Student.seed({ studentId: "S-1", collegeId: COL_A });
  const a = scopedModel(Student, A);
  assert.equal(await a.findById({ $ne: "" }), null);
  assert.equal(await a.findById("not-an-id"), null);
  assert.equal(await a.findById(undefined), null);
});

test("scopedModel: create stamps the tenant; a forged collegeId in the document is discarded", async () => {
  const Student = makeModel("Student");
  const doc = await scopedModel(Student, A).create({ studentId: "S-9", collegeId: COL_B });
  assert.equal(doc.collegeId, COL_A);
});

test("scopedModel: updates/deletes cannot cross colleges or move a document to another college", async () => {
  const Subject = makeModel("Subject");
  const own = Subject.seed({ name: "Own", collegeId: COL_A });
  const foreign = Subject.seed({ name: "Foreign", collegeId: COL_B });
  const a = scopedModel(Subject, A);
  await a.updateMany({ _id: foreign._id }, { $set: { name: "HACKED" } });
  assert.equal(Subject.rows.find((r) => r._id === foreign._id).name, "Foreign");
  await a.updateMany({}, { $set: { name: "mine" } });
  assert.equal(Subject.rows.find((r) => r._id === own._id).name, "mine");
  assert.equal(Subject.rows.find((r) => r._id === foreign._id).name, "Foreign");
  assert.throws(() => a.updateMany({}, { $set: { collegeId: COL_B } }), TenantScopeError);
  assert.throws(() => a.updateOne({}, { $set: { "collegeId.x": COL_B } }), TenantScopeError, "dotted path into collegeId");
  assert.throws(() => a.updateOne({}, { $rename: { name: "collegeId" } }), TenantScopeError, "$rename onto collegeId");
  assert.throws(() => a.updateMany({}, { $unset: { collegeId: "" } }), TenantScopeError);
  assert.throws(() => a.findOneAndUpdate({}, { $set: { collegeId: COL_B } }), TenantScopeError);
  assert.equal((await a.deleteMany({ _id: foreign._id })).deletedCount, 0);
  assert.equal(Subject.rows.length, 2);
  assert.equal((await a.deleteMany({})).deletedCount, 1);
  assert.equal(Subject.rows.length, 1);
  assert.equal(Subject.rows[0].collegeId, COL_B);
});

test("scopedModel refuses a model that has no collegeId field (it would be silently unscoped)", () => {
  assert.throws(() => scopedModel(makeModel("Legacy", { collegeScoped: false }), A), TenantScopeError);
});

test("scopedAggregate: tenant $match is forced first; cross-collection stages are refused", async () => {
  const M = makeModel("Attendance");
  M.seed({ collegeId: COL_A }); M.seed({ collegeId: COL_B });
  const out = await scopedAggregate(M, A, [{ $group: { _id: null, n: { $sum: 1 } } }]);
  assert.equal(out.length, 1, "only A's row reaches the $group");
  for (const stage of [{ $out: "x" }, { $merge: { into: "x" } }, { $unionWith: "users" }, { $graphLookup: { from: "users" } }]) {
    assert.throws(() => scopedAggregate(M, A, [stage]), TenantScopeError, JSON.stringify(stage));
  }
  assert.throws(() => scopedAggregate(M, A, [{ $lookup: { from: "users", localField: "teacher", foreignField: "_id", as: "t" } }]), TenantScopeError);
  assert.throws(() => scopedAggregate(M, A, [{ $lookup: { from: "users", let: {}, pipeline: [{ $match: { role: "teacher" } }], as: "t" } }]), TenantScopeError, "unpinned lookup");
  assert.throws(() => scopedAggregate(M, A, [{ $lookup: { from: "users", let: {}, pipeline: [{ $match: { collegeId: COL_B } }], as: "t" } }]), TenantScopeError, "lookup pinned to ANOTHER college");
  assert.doesNotThrow(() => scopedAggregate(M, A, [{ $lookup: { from: "users", let: {}, pipeline: [{ $match: { collegeId: COL_A } }], as: "t" } }]));
  assert.throws(() => scopedAggregate(M, A, [{ $facet: { x: [{ $unionWith: "users" }] } }]), TenantScopeError, "hidden inside $facet");
});

// ───────────────────────────────────────────────── 5. client-supplied collegeId

test("stripClientTenantFields removes collegeId/college/tenant from body and query (any case)", async () => {
  const req = { body: { name: "x", collegeId: COL_B, College: COL_B, tenant_id: COL_B }, query: { college: COL_B, q: "1" }, originalUrl: "/x" };
  const { passed } = await run([stripClientTenantFields()], req);
  assert.equal(passed, true);
  assert.deepEqual(req.body, { name: "x" });
  assert.deepEqual(req.query, { q: "1" });
  for (const k of ["collegeId", "college_id", "college", "tenantId", "tenant_id", "tenant", "COLLEGEID"]) assert.ok(isClientTenantKey(k), k);
});

test("stripClientTenantFields({mode:'reject'}) answers 400", async () => {
  const { res, passed } = await run([stripClientTenantFields({ mode: "reject" })], { body: { collegeId: COL_B }, query: {}, originalUrl: "/x" });
  assert.equal(passed, false);
  assert.equal(res.code, 400);
});

// ───────────────────────────────────────────────── 7. admin promotion cannot be forged

test("rejectPrivilegedFields: role / approval / college fields in body, query or nested objects → 400", async () => {
  const bad = [
    { body: { role: "admin" } }, { body: { ROLE: "admin" } }, { body: { isAdmin: true } }, { body: { approved: true } },
    { body: { approvalStatus: "approved" } }, { body: { authVersion: 99 } }, { body: { collegeId: COL_B } },
    { body: { user: { role: "admin" } } }, { body: {}, query: { role: "admin" } }, { body: { permissions: ["*"] } },
  ];
  for (const r of bad) {
    const { res, passed } = await run([rejectPrivilegedFields], { body: {}, query: {}, originalUrl: "/api/admin/teachers/1/promote", ...r });
    assert.equal(passed, false, JSON.stringify(r));
    assert.equal(res.code, 400);
  }
  const ok = await run([rejectPrivilegedFields], { body: {}, query: { page: "2" }, originalUrl: "/x" });
  assert.equal(ok.passed, true);
});

const mkRoleFixture = () => {
  const User = makeModel("User"), College = makeModel("College");
  const founder = User.seed({ name: "Founder A", email: "f@a", role: "admin", approved: true, approvalStatus: "approved", collegeId: COL_A, authVersion: 0 });
  const teacherA = User.seed({ name: "Teacher A", email: "t@a", role: "teacher", approved: true, approvalStatus: "approved", collegeId: COL_A, authVersion: 0 });
  const pendingA = User.seed({ name: "Pending A", email: "p@a", role: "teacher", approved: false, approvalStatus: "pending", collegeId: COL_A, authVersion: 0 });
  const adminB = User.seed({ name: "Admin B", email: "a@b", role: "admin", approved: true, approvalStatus: "approved", collegeId: COL_B, authVersion: 0 });
  const teacherB = User.seed({ name: "Teacher B", email: "t@b", role: "teacher", approved: true, approvalStatus: "approved", collegeId: COL_B, authVersion: 0 });
  College.seed({ collegeId: COL_A, createdBy: founder._id, status: "active" });
  College.seed({ collegeId: COL_B, createdBy: adminB._id, status: "active" });
  const svc = createAccountSecurityService({ User, College, log: () => {} });
  const actor = (u) => ({ role: u.role, userId: u._id, collegeId: u.collegeId });
  return { User, College, svc, actor, founder, teacherA, pendingA, adminB, teacherB };
};

test("promotion: a teacher cannot promote anyone, including themselves", async () => {
  const f = mkRoleFixture();
  assert.equal((await f.svc.changeRole(f.actor(f.teacherA), f.teacherA._id, "admin")).status, 403);
  assert.equal((await f.svc.changeRole(f.actor(f.teacherA), f.pendingA._id, "admin")).status, 403);
  assert.equal(f.User.rows.find((u) => u._id === f.teacherA._id).role, "teacher");
});

test("promotion: an admin cannot promote/demote an account of ANOTHER college (404, nothing changes)", async () => {
  const f = mkRoleFixture();
  const r = await f.svc.changeRole(f.actor(f.founder), f.teacherB._id, "admin");
  assert.equal(r.ok, false); assert.equal(r.status, 404);
  assert.equal(f.User.rows.find((u) => u._id === f.teacherB._id).role, "teacher");
  const d = await f.svc.changeRole(f.actor(f.founder), f.adminB._id, "teacher");
  assert.equal(d.status, 404);
  assert.equal(f.User.rows.find((u) => u._id === f.adminB._id).role, "admin");
});

test("promotion: unknown roles, self-change, pending accounts and invalid ids are refused", async () => {
  const f = mkRoleFixture();
  for (const role of ["superadmin", "root", "ADMIN", "", undefined, { $ne: "x" }]) {
    assert.equal((await f.svc.changeRole(f.actor(f.founder), f.teacherA._id, role)).ok, false, String(role));
  }
  assert.equal((await f.svc.changeRole(f.actor(f.founder), f.founder._id, "teacher")).code, "SELF_CHANGE");
  assert.equal((await f.svc.changeRole(f.actor(f.founder), f.pendingA._id, "admin")).code, "NOT_APPROVED");
  assert.equal((await f.svc.changeRole(f.actor(f.founder), "nope", "admin")).status, 404);
});

test("promotion by a same-college admin works, bumps authVersion (old tokens die), founder/last admin are protected", async () => {
  const f = mkRoleFixture();
  const r = await f.svc.changeRole(f.actor(f.founder), f.teacherA._id, "admin");
  assert.equal(r.ok, true);
  const promoted = f.User.rows.find((u) => u._id === f.teacherA._id);
  assert.equal(promoted.role, "admin"); assert.equal(promoted.authVersion, 1);
  // a second admin now exists → but the FOUNDER still cannot be demoted by them
  const demoteFounder = await f.svc.changeRole(f.actor(promoted), f.founder._id, "teacher");
  assert.equal(demoteFounder.code, "FOUNDER_PROTECTED");
  // …and the promoted admin can be demoted again by the founder
  assert.equal((await f.svc.changeRole(f.actor(f.founder), f.teacherA._id, "teacher")).ok, true);
});

// ───────────────────────────────────────────────── 6. pending / rejected / stale sessions

const mkSession = () => {
  const User = makeModel("User"), College = makeModel("College");
  College.seed({ collegeId: COL_A, name: "Alpha", status: "active" });
  College.seed({ collegeId: COL_B, name: "Beta", status: "suspended" });
  const mk = (o) => User.seed({ name: "u", email: `${oid()}@x`, role: "teacher", approved: true, approvalStatus: "approved", collegeId: COL_A, authVersion: 0, ...o });
  const service = createAuthSessionService({ User, College });
  const guard = createRequireApproved({ sessionService: service });
  const call = async (u, claims = {}) => {
    const req = { user: { id: u._id, av: u.authVersion ?? 0, ...claims } };
    return run([guard], req);
  };
  return { User, College, mk, service, call };
};

test("pending and rejected teachers cannot pass the session guard (any endpoint behind it)", async () => {
  const s = mkSession();
  const pending = await s.call(s.mk({ approved: false, approvalStatus: "pending" }));
  assert.equal(pending.passed, false); assert.equal(pending.res.code, 403); assert.equal(pending.res.body.code, "ACCOUNT_PENDING");
  const rejected = await s.call(s.mk({ approved: false, approvalStatus: "rejected" }));
  assert.equal(rejected.res.body.code, "ACCOUNT_REJECTED");
  const legacyPending = await s.call(s.mk({ approved: false, approvalStatus: undefined }));
  assert.equal(legacyPending.res.body.code, "ACCOUNT_PENDING");
  const inconsistent = await s.call(s.mk({ approved: true, approvalStatus: "rejected" }));
  assert.equal(inconsistent.passed, false, "approved:true + rejected must stay denied");
  const approved = await s.call(s.mk({}));
  assert.equal(approved.passed, true);
  assert.equal(isAccessApproved({ approved: true, approvalStatus: "pending" }), false);
});

test("forged token claims are ignored: role/collegeId/approved come from the database", async () => {
  const s = mkSession();
  const teacher = s.mk({ role: "teacher", collegeId: COL_A });
  const r = await s.call(teacher, { role: "admin", collegeId: COL_B, approved: true });
  assert.equal(r.passed, true);
  assert.equal(r.req.auth.role, "teacher");
  assert.equal(r.req.auth.collegeId, COL_A);
  assert.equal(r.req.user.role, "teacher");
});

test("revoked, deleted, wrong-version tokens and suspended colleges are refused", async () => {
  const s = mkSession();
  const u = s.mk({ authVersion: 2 });
  assert.equal((await s.call(u, { av: 1 })).res.code, 401, "stale session version");
  assert.equal((await s.call(u, { av: 2 })).passed, true);
  assert.equal((await s.call({ _id: oid(), authVersion: 0 })).res.code, 401, "deleted account");
  assert.equal((await s.call(s.mk({ collegeId: COL_B }))).res.body.code, "COLLEGE_SUSPENDED");
  assert.equal((await s.call(s.mk({ collegeId: "COL-NOPE000000" }))).res.body.code, "COLLEGE_UNAVAILABLE");
  assert.equal((await s.call(s.mk({}), { id: { $ne: null } })).res.code, 401, "operator object as user id");
  assert.equal((await run([createRequireApproved({ sessionService: s.service })], {})).res.code, 401, "guard without protect fails closed");
});

// ───────────────────────────────────────────────── 3/4. teacher approval across colleges

test("teacher requests: an admin can decide only requests of their own college", async () => {
  const f = mkRoleFixture();
  const svc = createTeacherApprovalService({ User: f.User, College: f.College, log: { error() {} } });
  const pendingB = f.User.seed({ name: "Pending B", email: "pb@b", role: "teacher", approved: false, approvalStatus: "pending", collegeId: COL_B });
  const scopeA = (await svc.resolveAdminScope(f.founder._id)).scope;
  assert.equal(scopeA.collegeId, COL_A);
  const cross = await svc.decide(scopeA, pendingB._id, "approve");
  assert.equal(cross.status, 404);
  assert.equal(f.User.rows.find((u) => u._id === pendingB._id).approved, false, "B's teacher is still pending");
  assert.equal((await svc.decide(scopeA, pendingB._id, "reject")).status, 404);
  assert.equal((await svc.deleteUser(scopeA, pendingB._id)).status, 404);
  assert.ok(f.User.rows.find((u) => u._id === pendingB._id), "B's teacher was not deleted");
  const listed = await svc.listRequests(scopeA, { status: "all" });
  assert.ok(listed.data.requests.every((r) => r.email.endsWith("@a")), "list never shows other colleges");
  const own = await svc.decide(scopeA, f.pendingA._id, "approve");
  assert.equal(own.ok, true);
  assert.equal((await svc.decide(scopeA, f.pendingA._id, "approve")).status, 409, "double decision");
  assert.equal((await svc.decide(scopeA, f.founder._id, "approve")).code, "SELF_DECISION");
});

test("a teacher cannot act as a college admin: resolveAdminScope refuses non-admins and unapproved admins", async () => {
  const f = mkRoleFixture();
  const svc = createTeacherApprovalService({ User: f.User, College: f.College });
  assert.equal((await svc.resolveAdminScope(f.teacherA._id)).ok, false);
  const fake = f.User.seed({ name: "Fake", email: "x@a", role: "admin", approved: false, approvalStatus: "pending", collegeId: COL_A });
  assert.equal((await svc.resolveAdminScope(fake._id)).ok, false);
  assert.equal((await svc.resolveAdminScope({ $ne: null })).ok, false);
});

// ───────────────────────────────────────────────── 9. cross-college object references (loadOwnedResource)

test("loadOwnedResource: an object of another college is 404 (indistinguishable from a missing id)", async () => {
  const Subject = makeModel("Subject");
  const sA = Subject.seed({ collegeId: COL_A, teacher: A.userId });
  const sB = Subject.seed({ collegeId: COL_B, teacher: B.userId });
  const guard = loadOwnedResource({ model: Subject, as: "subject", ownerField: "teacher" });
  const asA = (id, role = "admin", userId = A.userId) => run([guard], { tenant: { collegeId: COL_A, userId, role }, params: { id }, originalUrl: "/x" });
  assert.equal((await asA(sB._id)).res.code, 404);
  assert.equal((await asA(oid())).res.code, 404);
  assert.equal((await asA(sA._id)).passed, true);
  assert.equal((await asA(sA._id, "teacher", oid())).res.code, 403, "another teacher of the SAME college does not own it");
  assert.equal((await asA({ $ne: "" })).res.code, 404);
});

// ───────────────────────────────────────────────── 11. backup signing

test("backup files: signed, tamper-evident, bound to their college", () => {
  const data = { students: [{ _id: oid(), collegeId: COL_A, name: "Alpha One" }], subjects: [] };
  const file = buildBackupFile({ collegeId: COL_A, data });
  assert.equal(verifyBackupFile(file).ok, true);
  // content edited
  const t1 = JSON.parse(JSON.stringify(file)); t1.data.students[0].name = "Edited";
  assert.equal(verifyBackupFile(t1).code, "BACKUP_SIGNATURE_INVALID");
  // college id in the manifest retargeted to another college
  const t2 = JSON.parse(JSON.stringify(file)); t2.manifest.collegeId = COL_B;
  assert.equal(verifyBackupFile(t2).code, "BACKUP_SIGNATURE_INVALID");
  // a foreign row smuggled in with counts + hash recomputed still fails without the key
  const t3 = JSON.parse(JSON.stringify(file)); t3.data.students.push({ _id: oid(), collegeId: COL_B, name: "Beta One" }); t3.manifest.counts.students = 2;
  assert.equal(verifyBackupFile(t3).ok, false);
  // unknown collections / wrong shapes
  assert.equal(verifyBackupFile({ manifest: file.manifest, data: { users: [] } }).ok, false);
  assert.equal(verifyBackupFile({ manifest: file.manifest, data: [] }).ok, false);
  assert.equal(verifyBackupFile(null).ok, false);
  assert.equal(verifyBackupFile("x").ok, false);
  // signed with a different key (another deployment / attacker)
  const prev = process.env.BACKUP_SIGNING_KEY;
  process.env.BACKUP_SIGNING_KEY = "attacker-key-0123456789";
  const forged = buildBackupFile({ collegeId: COL_A, data });
  delete process.env.BACKUP_SIGNING_KEY; if (prev) process.env.BACKUP_SIGNING_KEY = prev;
  assert.equal(verifyBackupFile(forged).code, "BACKUP_SIGNATURE_INVALID");
});

// ───────────────────────────────────────────────── 8. public lookup input / brute-force brake

test("public lookup input: operator objects, arrays and bad college ids are rejected before any query", () => {
  const good = { collegeId: "COL-2222222222", department: "CSE", batch: "2024", shift: "Morning", roll: "12" };
  assert.equal(validateLookupInput(good).ok, true);
  for (const patch of [
    { roll: { $ne: "" } }, { roll: ["1", "2"] }, { department: { $regex: ".*" } }, { collegeId: { $ne: "" } },
    { collegeId: "COL-2222222222 OR 1" }, { collegeId: "col-2222222222" }, { shift: "" }, { batch: "x".repeat(51) }, { roll: "1\u0000" },
  ]) {
    assert.equal(validateLookupInput({ ...good, ...patch }).ok, false, JSON.stringify(patch));
  }
  assert.equal(validateLookupInput(null).ok, false);
  assert.equal(validateLookupInput([good]).ok, false);
});

test("failure limiter: only failures count, then everything from that key is blocked; other keys are unaffected", async () => {
  let t = 1_000;
  const lim = createFailureLimiter({ windowMs: 60_000, max: 3, now: () => t, keyGenerator: (r) => r.key });
  const hit = async (key, status) => {
    const res = { statusCode: status, handlers: [], set() {}, status(c) { this.statusCode = c; return this; }, json() { return this; }, on(e, f) { this.handlers.push(f); } };
    let passed = false;
    lim({ key }, res, () => { passed = true; });
    if (passed) res.handlers.forEach((f) => f());
    return { passed, code: res.statusCode };
  };
  for (let i = 0; i < 10; i++) assert.equal((await hit("ok-user", 200)).passed, true); // successes are free
  for (let i = 0; i < 3; i++) assert.equal((await hit("guesser", 404)).passed, true);
  assert.equal((await hit("guesser", 404)).passed, false, "blocked after max failures");
  assert.equal((await hit("guesser", 200)).passed, false, "even a correct request is blocked while the window is open");
  assert.equal((await hit("someone-else", 404)).passed, true, "other keys are unaffected");
  t += 61_000;
  assert.equal((await hit("guesser", 404)).passed, true, "window reset");
  lim.reset();
});

test("rate limiter blocks the (max+1)th request in a window", () => {
  let t = 0;
  const lim = createRateLimiter({ windowMs: 1000, max: 2, now: () => t, keyGenerator: () => "k" });
  const res = mkRes();
  let n = 0; const next = () => { n++; };
  lim({}, res, next); lim({}, res, next); lim({}, res, next);
  assert.equal(n, 2); assert.equal(res.code, 429);
});

// ───────────────────────────────────────────────── 9/11. analytics cache cannot cross colleges

test("analytics cache: the same dataset name is cached separately per college; invalidating A leaves B", async () => {
  const cache = createTenantCache({ ttlMs: 60_000 });
  const a = await cache.get({ collegeId: COL_A }, "subject-analytics", async () => ["A-data"]);
  const b = await cache.get({ collegeId: COL_B }, "subject-analytics", async () => ["B-data"]);
  assert.deepEqual(a, ["A-data"]); assert.deepEqual(b, ["B-data"]);
  assert.deepEqual(await cache.get({ collegeId: COL_A }, "subject-analytics", async () => ["WRONG"]), ["A-data"], "hit");
  cache.invalidate({ collegeId: COL_A });
  assert.deepEqual(await cache.get({ collegeId: COL_A }, "subject-analytics", async () => ["A-new"]), ["A-new"]);
  assert.deepEqual(await cache.get({ collegeId: COL_B }, "subject-analytics", async () => ["WRONG"]), ["B-data"], "B untouched");
  // a legacy (college-less) tenant is its own bucket, never a real college's
  assert.deepEqual(await cache.get({ collegeId: null }, "subject-analytics", async () => ["legacy"]), ["legacy"]);
  await assert.rejects(() => cache.get(undefined, "x", async () => 1), TenantScopeError);
});

test("legacy single-college data (collegeId null) stays visible to legacy accounts only", async () => {
  const Subject = makeModel("Subject");
  Subject.seed({ name: "Legacy subject" });                        // no collegeId field at all (pre-multi-college row)
  Subject.seed({ name: "Legacy subject 2", collegeId: null });
  Subject.seed({ name: "Alpha subject", collegeId: COL_A });
  const legacy = scopedModel(Subject, { collegeId: null });
  assert.deepEqual((await legacy.find({})).map((s) => s.name).sort(), ["Legacy subject", "Legacy subject 2"]);
  assert.deepEqual((await scopedModel(Subject, A).find({})).map((s) => s.name), ["Alpha subject"], "a real college never sees legacy rows");
});

// ───────────────────────────────────────────────── hardening helpers

test("pickOwn ignores prototype keys, non-strings and inherited properties", () => {
  const m = { newest: 1, name: 2 };
  assert.equal(pickOwn(m, "newest", "d"), 1);
  for (const k of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf", undefined, null, ["newest"], { a: 1 }]) {
    assert.equal(pickOwn(m, k, "d"), "d", String(k));
  }
});

test("neutralizeFormula prefixes =,+,-,@,tab,CR in text cells and leaves numbers/normal text alone", () => {
  for (const s of ["=1+1", "+cmd|' /C calc'!A0", "-2+3", "@SUM(1)", "\t=1", "\r=1"]) assert.equal(neutralizeFormula(s), `'${s}`);
  for (const s of ["Alice", "—", "2024-01-01", " =x", ""]) assert.equal(neutralizeFormula(s), s);
  assert.equal(neutralizeFormula(-5), -5);
  assert.equal(neutralizeFormula(null), null);
});

test("securityHeaders sets nosniff / frame / referrer headers, HSTS only over HTTPS", () => {
  const headers = {};
  const res = { setHeader: (k, v) => { headers[k] = v; } };
  securityHeaders({ secure: false }, res, () => {});
  assert.equal(headers["X-Content-Type-Options"], "nosniff");
  assert.equal(headers["X-Frame-Options"], "DENY");
  assert.equal(headers["Referrer-Policy"], "no-referrer");
  assert.equal(headers["Strict-Transport-Security"], undefined);
  securityHeaders({ secure: true }, res, () => {});
  assert.match(headers["Strict-Transport-Security"], /max-age=/);
});
