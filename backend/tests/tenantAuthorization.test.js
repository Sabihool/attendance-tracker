/**
 * Tenant (college) authorization: scoped-query helpers, ownership guards,
 * client-supplied college fields, and cross-college admin access.
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-test-secret-test-secret-123";

import { protect, authorize } from "../middleware/authMiddleware.js";
import { createRequireApproved } from "../middleware/approvalGuards.js";
import { tenantContext, requireAdmin, requireTeacher, stripClientTenantFields, loadOwnedResource } from "../middleware/tenantGuards.js";
import { createRequireSubjectOwner, createRequireAttendanceOwner } from "../middleware/teacherMiddleware.js";
import { scopeFilter, scopedModel, scopedAggregate, assertTenant, TenantScopeError, isClientTenantKey } from "../utils/tenantScope.js";
import { generateToken, buildTokenPayload } from "../utils/token.js";
import { createMemoryDb, createCollection, seedCollege, seedAdmin, newId } from "./helpers/memoryDb.js";
import { run } from "./helpers/httpHarness.js";

const world = () => {
  const db = createMemoryDb();
  const requireApproved = createRequireApproved({ User: db.User, College: db.College });
  const A = seedCollege(db, { name: "Alpha" });
  const B = seedCollege(db, { name: "Beta" });
  const adminA = seedAdmin(db, A);
  const adminB = seedAdmin(db, B);
  const mkTeacher = (college) => db.User.seed({ name: "T", email: `t${newId()}@x.com`, password: "p", role: "teacher", approved: true, approvalStatus: "approved", collegeId: college?.collegeId ?? null });
  const teacherA = mkTeacher(A), teacherA2 = mkTeacher(A), teacherB = mkTeacher(B);
  const Subject = createCollection({ name: "subjects" });
  const Attendance = createCollection({ name: "attendance" });
  const subjA = Subject.seed({ name: "Math A", teacher: teacherA._id, collegeId: A.collegeId });
  const subjB = Subject.seed({ name: "Math B", teacher: teacherB._id, collegeId: B.collegeId });
  const bearer = (u) => ({ authorization: `Bearer ${generateToken(buildTokenPayload(u))}` });
  const call = (user, chain, extra = {}) =>
    run([protect, requireApproved, ...chain], { headers: bearer(user), params: {}, query: {}, body: {}, ...extra });
  const done = (_q, res) => res.status(200).json({ ok: true });
  return { db, A, B, adminA, adminB, teacherA, teacherA2, teacherB, Subject, Attendance, subjA, subjB, call, done };
};

// ── scopeFilter ──────────────────────────────────────────────────────────────
test("scopeFilter always carries the tenant's collegeId and cannot be overridden", () => {
  const t = { collegeId: "COL-AAA" };
  assert.deepEqual(scopeFilter(t, { name: "x" }), { name: "x", collegeId: "COL-AAA" });
  assert.deepEqual(scopeFilter(t), { collegeId: "COL-AAA" });
  assert.throws(() => scopeFilter(t, { collegeId: "COL-BBB" }), TenantScopeError);
  assert.throws(() => scopeFilter(t, { CollegeID: { $ne: null } }), TenantScopeError);
  assert.throws(() => scopeFilter(t, null), TenantScopeError);
  assert.throws(() => scopeFilter(t, []), TenantScopeError);
});

test("an operator in extra conditions cannot remove the college condition", () => {
  const f = scopeFilter({ collegeId: "COL-AAA" }, { $or: [{ a: 1 }, { collegeId: "x" }].slice(0, 1) });
  assert.equal(f.collegeId, "COL-AAA");
});

test("tenant validation: missing/invalid tenants throw instead of querying unscoped", () => {
  for (const bad of [undefined, null, {}, { collegeId: undefined }, { collegeId: "" }, { collegeId: { $ne: 1 } }, { collegeId: 7 }]) {
    assert.throws(() => scopeFilter(bad), TenantScopeError, JSON.stringify(bad));
  }
  assert.doesNotThrow(() => assertTenant({ collegeId: null })); // unassigned legacy tenant is explicit
  assert.deepEqual(scopeFilter({ collegeId: null }), { collegeId: null });
});

// ── scopedModel ──────────────────────────────────────────────────────────────
test("scopedModel: reads only see the tenant's own documents", async () => {
  const w = world();
  const a = scopedModel(w.Subject, { collegeId: w.A.collegeId });
  assert.equal((await a.find({}, { lean: true })).length, 1);
  assert.equal((await a.findById(w.subjA._id, { lean: true })).name, "Math A");
  assert.equal(await a.findById(w.subjB._id), null, "other college's id looks like a missing one");
  assert.equal(await a.findOne({ name: "Math B" }), null);
  assert.equal(await a.countDocuments({}), 1);
  // attacker-supplied filter values cannot reach other colleges
  assert.equal(await a.findOne({ _id: w.subjB._id }), null);
});

test("scopedModel: bad ids and operator objects resolve to null", async () => {
  const w = world();
  const a = scopedModel(w.Subject, { collegeId: w.A.collegeId });
  for (const id of ["", "abc", { $ne: null }, undefined, null, ["x"]]) assert.equal(await a.findById(id), null);
});

test("scopedModel: create stamps the tenant's college and discards a client-sent one", async () => {
  const w = world();
  const a = scopedModel(w.Subject, { collegeId: w.A.collegeId });
  const doc = await a.create({ name: "New", collegeId: w.B.collegeId });
  assert.equal(doc.collegeId, w.A.collegeId);
  assert.equal(w.Subject.rows.find((r) => r.name === "New").collegeId, w.A.collegeId);
});

test("scopedModel: updates/deletes only touch the tenant's documents and can't move them", async () => {
  const w = world();
  const a = scopedModel(w.Subject, { collegeId: w.A.collegeId });
  assert.equal(await a.findOneAndUpdate({ _id: w.subjB._id }, { $set: { name: "hacked" } }, { new: true }), null);
  assert.equal(w.subjB.name, "Math B");
  assert.throws(() => a.findOneAndUpdate({ _id: w.subjA._id }, { $set: { collegeId: w.B.collegeId } }), TenantScopeError);
  assert.throws(() => a.updateOne({ _id: w.subjA._id }, { $unset: { collegeId: 1 } }), TenantScopeError);
  assert.throws(() => a.updateMany({}, { collegeId: "COL-X" }), TenantScopeError);
  assert.equal((await a.deleteOne({ _id: w.subjB._id })).deletedCount, 0);
  assert.equal((await a.deleteMany({})).deletedCount, 1); // only A's
  assert.equal(w.Subject.rows.length, 1);
  assert.equal(w.Subject.rows[0].collegeId, w.B.collegeId);
});

test("scopedModel refuses models that have no collegeId field (would silently create unscoped rows)", () => {
  const fake = { modelName: "Student", schema: { path: (p) => (p === "name" ? {} : undefined) } };
  assert.throws(() => scopedModel(fake, { collegeId: "COL-A" }), /no collegeId field/);
  assert.throws(() => scopedAggregate(fake, { collegeId: "COL-A" }, []), /no collegeId field/);
  const good = { modelName: "Subject", schema: { path: () => ({}) }, find: () => [] };
  assert.doesNotThrow(() => scopedModel(good, { collegeId: "COL-A" }));
});

test("scopedAggregate puts the tenant $match first and forbids $out/$merge", () => {
  let seen;
  const Model = { aggregate: (p) => { seen = p; return p; } };
  scopedAggregate(Model, { collegeId: "COL-A" }, [{ $group: { _id: "$x" } }]);
  assert.deepEqual(seen[0], { $match: { collegeId: "COL-A" } });
  assert.throws(() => scopedAggregate(Model, { collegeId: "COL-A" }, [{ $out: "x" }]), TenantScopeError);
  assert.throws(() => scopedAggregate(Model, { collegeId: "COL-A" }, [{ $merge: "x" }]), TenantScopeError);
  assert.throws(() => scopedAggregate(Model, { collegeId: "COL-A" }, "nope"), TenantScopeError);
});

// ── tenantContext & role guards ──────────────────────────────────────────────
test("tenantContext is built from the database session, never from the request", async () => {
  const w = world();
  const r = await w.call(w.adminB, [tenantContext, w.done], {
    query: { collegeId: w.A.collegeId }, body: { collegeId: w.A.collegeId }, params: { collegeId: w.A.collegeId },
  });
  assert.equal(r.res.code, 200);
  assert.equal(r.req.tenant.collegeId, w.B.collegeId);
  assert.equal(r.req.tenant.userId, w.adminB._id);
  assert.ok(Object.isFrozen(r.req.tenant));
  assert.equal((await run([tenantContext], {})).res.code, 401, "no session → 401");
});

test("requireAdmin / requireTeacher use the database role", async () => {
  const w = world();
  assert.equal((await w.call(w.adminA, [requireAdmin, w.done])).res.code, 200);
  const t = await w.call(w.teacherA, [requireAdmin, w.done]);
  assert.equal(t.res.code, 403);
  assert.equal(t.res.body.code, "FORBIDDEN");
  assert.equal((await w.call(w.teacherA, [requireTeacher, w.done])).res.code, 200);
  assert.equal((await w.call(w.adminA, [requireTeacher, w.done])).res.code, 403);
});

test("teachers cannot reach admin-only operations (also with a forged admin token)", async () => {
  const w = world();
  const forged = { authorization: `Bearer ${generateToken({ ...buildTokenPayload(w.teacherA), role: "admin" })}` };
  const r = await run([protect, createRequireApproved({ User: w.db.User, College: w.db.College }), authorize("admin"), w.done], { headers: forged });
  assert.equal(r.res.code, 403);
});

// ── client-supplied college fields ───────────────────────────────────────────
test("stripClientTenantFields removes collegeId variants from body and query (incl. operator objects)", async () => {
  const req = {
    body: { name: "x", collegeId: "COL-A", CollegeID: "COL-A", college_id: 1, tenant: "t" },
    query: { collegeId: { $ne: null }, page: "2", college: "x" },
  };
  const r = await run([stripClientTenantFields(), (_q, res) => res.status(200).json({})], req);
  assert.equal(r.res.code, 200);
  assert.deepEqual(req.body, { name: "x" });
  assert.deepEqual(req.query, { page: "2" });
  assert.ok(isClientTenantKey("TenantId") && !isClientTenantKey("collegeName"));
});

test("stripClientTenantFields({mode:'reject'}) answers 400 and calls nothing else", async () => {
  const r = await run([stripClientTenantFields({ mode: "reject" }), (_q, res) => res.status(200).json({})], { body: { collegeId: "x" }, query: {} });
  assert.equal(r.res.code, 400);
  assert.equal(r.res.body.code, "INVALID_REQUEST");
  const clean = await run([stripClientTenantFields({ mode: "reject" }), (_q, res) => res.status(200).json({})], { body: { a: 1 }, query: {} });
  assert.equal(clean.res.code, 200);
});

// ── loadOwnedResource ────────────────────────────────────────────────────────
const owned = (w) => loadOwnedResource({ model: w.Subject, as: "subject", ownerField: "teacher" });

test("loadOwnedResource: owner teacher and same-college admin may load; another teacher of the same college gets 403", async () => {
  const w = world();
  const params = { id: w.subjA._id };
  const t = await w.call(w.teacherA, [tenantContext, owned(w), w.done], { params });
  assert.equal(t.res.code, 200);
  assert.equal(t.req.resources.subject.name, "Math A");
  assert.equal((await w.call(w.adminA, [tenantContext, owned(w), w.done], { params })).res.code, 200);
  const other = await w.call(w.teacherA2, [tenantContext, owned(w), w.done], { params });
  assert.equal(other.res.code, 403);
});

test("loadOwnedResource: other colleges' resources are indistinguishable from missing ones (404), whoever asks", async () => {
  const w = world();
  const real = await w.call(w.adminA, [tenantContext, owned(w), w.done], { params: { id: w.subjB._id } });
  const missing = await w.call(w.adminA, [tenantContext, owned(w), w.done], { params: { id: newId() } });
  const bad = await w.call(w.adminA, [tenantContext, owned(w), w.done], { params: { id: "not-an-id" } });
  assert.equal(real.res.code, 404);
  assert.deepEqual(real.res.body, missing.res.body, "no existence oracle");
  assert.deepEqual(real.res.body, bad.res.body);
  assert.equal((await w.call(w.teacherA, [tenantContext, owned(w), w.done], { params: { id: w.subjB._id } })).res.code, 404);
});

test("loadOwnedResource ignores collegeId in query/body/params: college B's admin can't read A's subject by claiming to be A", async () => {
  const w = world();
  const r = await w.call(w.adminB, [stripClientTenantFields(), tenantContext, owned(w), w.done], {
    params: { id: w.subjA._id, collegeId: w.A.collegeId },
    query: { collegeId: w.A.collegeId }, body: { collegeId: w.A.collegeId },
  });
  assert.equal(r.res.code, 404);
  // …and even without the strip middleware
  const r2 = await w.call(w.adminB, [tenantContext, owned(w), w.done], { params: { id: w.subjA._id }, query: { collegeId: w.A.collegeId } });
  assert.equal(r2.res.code, 404);
});

test("loadOwnedResource requires tenantContext and a college-aware model", async () => {
  const w = world();
  const noTenant = await w.call(w.adminA, [owned(w), w.done], { params: { id: w.subjA._id } });
  assert.equal(noTenant.res.code, 401);
  const noField = { modelName: "Student", schema: { path: () => undefined }, findOne: () => null };
  await assert.rejects(
    run([tenantContext, loadOwnedResource({ model: noField, as: "s" }), w.done].map((f) => f), { auth: { userId: "u", role: "admin", collegeId: "COL-A" }, params: { id: newId() } }),
    /no collegeId field/
  );
  assert.throws(() => loadOwnedResource({ as: "x" }), /required/);
});

// ── Existing teacher-owned resources: admins limited to their own college ────
// Mirrors the real model closely enough for the guard: findOne with the scoped filter { _id, collegeId }.
const subjectFake = (w) => ({
  findOne: async (f) => w.Subject.rows.find((r) => r._id === f._id && (r.collegeId ?? null) === f.collegeId) ?? null,
});

test("requireSubjectOwner: an admin can manage subjects of their own college only", async () => {
  const w = world();
  const guard = createRequireSubjectOwner({ SubjectModel: subjectFake(w), UserModel: w.db.User });
  const same = await w.call(w.adminA, [guard, w.done], { params: { subjectId: w.subjA._id } });
  assert.equal(same.res.code, 200);
  const cross = await w.call(w.adminA, [guard, w.done], { params: { subjectId: w.subjB._id } });
  assert.equal(cross.res.code, 404);
  assert.equal(cross.res.body.message, "Subject not found.");
  // teachers: own subject only (unchanged)
  assert.equal((await w.call(w.teacherA, [guard, w.done], { params: { subjectId: w.subjA._id } })).res.code, 200);
  assert.equal((await w.call(w.teacherA2, [guard, w.done], { params: { subjectId: w.subjA._id } })).res.code, 403);
  // Part 11: another college's subject is "not found" for a teacher too (was 403, which confirmed the id exists).
  assert.equal((await w.call(w.teacherA, [guard, w.done], { params: { subjectId: w.subjB._id } })).res.code, 404);
});

test("requireSubjectOwner: fails closed without a resolved session, and for orphaned subjects", async () => {
  const w = world();
  const guard = createRequireSubjectOwner({ SubjectModel: subjectFake(w), UserModel: w.db.User });
  assert.equal((await run([guard], { user: { id: w.adminA._id, role: "admin" }, params: { subjectId: w.subjA._id } })).res.code, 401);
  const orphan = w.Subject.seed({ name: "Orphan", teacher: newId() });
  assert.equal((await w.call(w.adminA, [guard, w.done], { params: { subjectId: orphan._id } })).res.code, 404);
});

test("requireAttendanceOwner: same rule for attendance records", async () => {
  const w = world();
  // Part 12: attendance carries its own collegeId; the guard looks the record up INSIDE the caller's college.
  const recA = w.Attendance.seed({ teacher: w.teacherA._id, isDeleted: false, collegeId: w.A.collegeId });
  const recB = w.Attendance.seed({ teacher: w.teacherB._id, isDeleted: false, collegeId: w.B.collegeId });
  const guard = createRequireAttendanceOwner({
    AttendanceModel: { findOne: async ({ _id, isDeleted, collegeId }) => w.Attendance.rows.find((r) => r._id === _id && r.isDeleted === isDeleted && r.collegeId === collegeId) ?? null },
  });
  assert.equal((await w.call(w.adminA, [guard, w.done], { params: { id: recA._id } })).res.code, 200);
  assert.equal((await w.call(w.adminA, [guard, w.done], { params: { id: recB._id } })).res.code, 404);
  assert.equal((await w.call(w.adminB, [guard, w.done], { params: { id: recA._id } })).res.code, 404);
  assert.equal((await w.call(w.teacherA, [guard, w.done], { params: { id: recA._id } })).res.code, 200);
  assert.equal((await w.call(w.teacherA2, [guard, w.done], { params: { id: recA._id } })).res.code, 403);
});
