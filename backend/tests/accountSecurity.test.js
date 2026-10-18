/** Privileged account operations: role changes, college membership changes, session revocation. */
import test from "node:test";
import assert from "node:assert/strict";

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-test-secret-test-secret-123";

import { protect } from "../middleware/authMiddleware.js";
import { createRequireApproved } from "../middleware/approvalGuards.js";
import { createAccountSecurityService } from "../services/accountSecurityService.js";
import { createAuthSessionService } from "../services/authSessionService.js";
import { generateToken, buildTokenPayload } from "../utils/token.js";
import { createMemoryDb, seedCollege, seedAdmin, newId } from "./helpers/memoryDb.js";
import { run } from "./helpers/httpHarness.js";
import { logSecurityEvent } from "../utils/securityLog.js";

const world = () => {
  const db = createMemoryDb();
  const events = [];
  const svc = createAccountSecurityService({ User: db.User, College: db.College, log: (e, d) => events.push({ e, ...d }) });
  const A = seedCollege(db), B = seedCollege(db);
  const adminA1 = seedAdmin(db, A), adminA2 = seedAdmin(db, A), adminB = seedAdmin(db, B);
  const mk = (college, over = {}) => db.User.seed({ name: "T", email: `t${newId()}@x.com`, password: "p", role: "teacher", approved: true, approvalStatus: "approved", collegeId: college?.collegeId ?? null, ...over });
  const sessionOf = async (u) => (await createAuthSessionService({ User: db.User, College: db.College }).resolveSession({ id: u._id, av: u.authVersion ?? 0 })).session;
  const guard = createRequireApproved({ User: db.User, College: db.College });
  const hit = async (u, token) => (await run([protect, guard, (_q, res) => res.status(200).json({})], { headers: { authorization: `Bearer ${token ?? generateToken(buildTokenPayload(u))}` } })).res.code;
  return { db, svc, events, A, B, adminA1, adminA2, adminB, mk, sessionOf, hit };
};
const row = (w, u) => w.db.User.rows.find((r) => r._id === u._id);

test("changeRole: an admin promotes an approved teacher of their own college; old tokens die, role is live immediately", async () => {
  const w = world();
  const t = w.mk(w.A);
  const oldToken = generateToken(buildTokenPayload(t));
  const r = await w.svc.changeRole(await w.sessionOf(w.adminA1), t._id, "admin");
  assert.equal(r.ok, true);
  assert.equal(row(w, t).role, "admin");
  assert.equal(row(w, t).authVersion, 1);
  assert.equal(await w.hit(t, oldToken), 401, "pre-change token is revoked");
  assert.equal(await w.hit(row(w, t)), 200, "a new sign-in works");
  assert.equal(w.events.at(-1).e, "role_changed");
});

test("changeRole: cannot cross colleges (404), cannot touch self, needs an admin actor and a valid role", async () => {
  const w = world();
  const tB = w.mk(w.B), tA = w.mk(w.A);
  const actor = await w.sessionOf(w.adminA1);
  const cross = await w.svc.changeRole(actor, tB._id, "admin");
  assert.equal(cross.status, 404);
  assert.equal(row(w, tB).role, "teacher");
  assert.equal((await w.svc.changeRole(actor, w.adminA1._id, "teacher")).code, "SELF_CHANGE");
  assert.equal((await w.svc.changeRole(actor, tA._id, "superadmin")).code, "BAD_ROLE");
  assert.equal((await w.svc.changeRole(actor, tA._id, { $ne: 1 })).code, "BAD_ROLE");
  assert.equal((await w.svc.changeRole(actor, "nope", "admin")).status, 404);
  const teacherActor = await w.sessionOf(tA);
  assert.equal((await w.svc.changeRole(teacherActor, w.adminA2._id, "teacher")).status, 403);
  assert.equal(row(w, w.adminA2).role, "admin");
  assert.equal(row(w, tA).authVersion ?? 0, 0, "refused requests change nothing");
});

test("changeRole: pending or rejected accounts cannot be given a role", async () => {
  const w = world();
  const p = w.mk(w.A, { approved: false, approvalStatus: "pending" });
  const r = await w.svc.changeRole(await w.sessionOf(w.adminA1), p._id, "admin");
  assert.equal(r.code, "NOT_APPROVED");
  assert.equal(row(w, p).role, "teacher");
});

test("changeRole: a college always keeps one active administrator", async () => {
  const w = world();
  const actor1 = await w.sessionOf(w.adminA1);
  // 2 admins → demoting one is fine
  assert.equal((await w.svc.changeRole(actor1, w.adminA2._id, "teacher")).ok, true);
  assert.equal(row(w, w.adminA2).role, "teacher");

  // adminA2 and adminA3 are admins whose accounts can no longer act (A3 un-approved after its session was captured)
  const a3 = seedAdmin(w.db, w.A);
  const staleActor = await w.sessionOf(a3);
  Object.assign(row(w, a3), { approved: false, approvalStatus: "rejected" });
  // The only ACTIVE admin left is adminA1 → a (stale) admin session cannot demote them
  const r = await w.svc.changeRole(staleActor, w.adminA1._id, "teacher");
  assert.equal(r.code, "LAST_ADMIN");
  assert.equal(row(w, w.adminA1).role, "admin");
});

test("changeRole: two admins demoting each other at once never leave the college without an admin", async () => {
  const w = world();
  const s1 = await w.sessionOf(w.adminA1), s2 = await w.sessionOf(w.adminA2);
  const [r1, r2] = await Promise.all([
    w.svc.changeRole(s1, w.adminA2._id, "teacher"),
    w.svc.changeRole(s2, w.adminA1._id, "teacher"),
  ]);
  const admins = w.db.User.rows.filter((u) => u.collegeId === w.A.collegeId && u.role === "admin").length;
  assert.ok(admins >= 1, `college left with ${admins} admins (${r1.code ?? "ok"}, ${r2.code ?? "ok"})`);
});

test("changeCollegeMembership: operator-only move requires a reason, an active destination and keeps the last admin", async () => {
  const w = world();
  const t = w.mk(w.A);
  const base = { userId: t._id, toCollegeId: w.B.collegeId, operator: "ops@example.com" };
  assert.equal((await w.svc.changeCollegeMembership({ ...base, reason: "" })).code, "REASON_REQUIRED");
  assert.equal((await w.svc.changeCollegeMembership({ ...base, reason: "ok reason", operator: "" })).code, "OPERATOR_REQUIRED");
  assert.equal((await w.svc.changeCollegeMembership({ ...base, reason: "ok reason", toCollegeId: "COL-NOPE" })).code, "COLLEGE_NOT_FOUND");
  w.B.status = "suspended";
  assert.equal((await w.svc.changeCollegeMembership({ ...base, reason: "ok reason" })).code, "COLLEGE_NOT_FOUND");
  w.B.status = "active";

  const oldToken = generateToken(buildTokenPayload(t));
  const ok = await w.svc.changeCollegeMembership({ ...base, reason: "transfer requested by registrar" });
  assert.equal(ok.ok, true);
  assert.equal(row(w, t).collegeId, w.B.collegeId);
  assert.equal(await w.hit(t, oldToken), 401);
  assert.deepEqual(Object.keys(w.events.at(-1)).sort(), ["e", "from", "operator", "reason", "target", "to"]);

  // A's admins: adminA1 + adminA2. Move one away OK, the last one refused.
  assert.equal((await w.svc.changeCollegeMembership({ userId: w.adminA2._id, toCollegeId: w.B.collegeId, reason: "moving admin", operator: "ops" })).ok, true);
  assert.equal((await w.svc.changeCollegeMembership({ userId: w.adminA1._id, toCollegeId: w.B.collegeId, reason: "moving admin", operator: "ops" })).code, "LAST_ADMIN");
});

test("revokeSessions: signs the user out everywhere, repeatedly", async () => {
  const w = world();
  const t = w.mk(w.A);
  const t0 = generateToken(buildTokenPayload(t));
  assert.equal(await w.hit(t, t0), 200);
  await w.svc.revokeSessions(t._id, { by: "admin" });
  assert.equal(await w.hit(t, t0), 401);
  const t1 = generateToken(buildTokenPayload(row(w, t)));
  assert.equal(await w.hit(t, t1), 200);
  await w.svc.revokeSessions(t._id);
  assert.equal(await w.hit(t, t1), 401);
  assert.equal((await w.svc.revokeSessions("bad")).status, 404);
});

test("security log lines are single-line JSON with truncated values and no crash on a broken sink", () => {
  const lines = [];
  logSecurityEvent("x", { a: "y".repeat(500), list: ["z".repeat(300)] }, { warn: (l) => lines.push(l) });
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.type, "security_event");
  assert.ok(parsed.a.length <= 120 && parsed.list[0].length <= 120);
  assert.doesNotThrow(() => logSecurityEvent("x", {}, { warn: () => { throw new Error("sink down"); } }));
});
