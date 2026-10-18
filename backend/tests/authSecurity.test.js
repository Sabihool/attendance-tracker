/**
 * Authentication & session resolution (Part 8 — security layer).
 * Real middleware (protect / requireApproved / authorize) against in-memory
 * models. Every request goes through the same order the routes use.
 */
import test from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-test-secret-test-secret-123";

import { protect, authorize } from "../middleware/authMiddleware.js";
import { createRequireApproved } from "../middleware/approvalGuards.js";
import { generateToken, buildTokenPayload } from "../utils/token.js";
import { createMemoryDb, seedCollege, seedAdmin } from "./helpers/memoryDb.js";
import { run } from "./helpers/httpHarness.js";
import { checkSecurityConfig } from "../utils/securityConfig.js";
import { errorHandler } from "../middleware/errorMiddleware.js";

const SECRET = process.env.JWT_SECRET;

const world = ({ strict = false } = {}) => {
  const db = createMemoryDb();
  const requireApproved = createRequireApproved({ User: db.User, College: db.College, strictCollegeMembership: strict });
  const A = seedCollege(db, { name: "Alpha" });
  const B = seedCollege(db, { name: "Beta" });
  const adminA = seedAdmin(db, A);
  const adminB = seedAdmin(db, B);
  const teacher = (college, over = {}) => db.User.seed({
    name: "Tea Cher", email: `t${Math.random().toString(36).slice(2)}@x.com`, password: "Secret123", role: "teacher",
    approved: true, approvalStatus: "approved", collegeId: college ? college.collegeId : null, ...over,
  });
  const tokenFor = (u, over = {}) => generateToken({ ...buildTokenPayload(u), ...over });
  const call = (token, ...tail) =>
    run([protect, requireApproved, ...tail], { headers: token === undefined ? {} : { authorization: `Bearer ${token}` }, params: {}, query: {}, body: {} });
  const ok = (_q, res) => res.status(200).json({ ok: true });
  return { db, A, B, adminA, adminB, teacher, tokenFor, call, ok, requireApproved };
};

const noLeak = (body) => {
  const text = JSON.stringify(body);
  assert.ok(!/COL-|@|[0-9a-f]{24}|stack|mongo|jwt|secret/i.test(text), `response leaks detail: ${text}`);
  assert.deepEqual(Object.keys(body).sort(), ["code", "message", "success"]);
  assert.equal(body.success, false);
};

// ── 1. Token verification ────────────────────────────────────────────────────
test("no token / malformed header → 401 UNAUTHENTICATED", async () => {
  const w = world();
  for (const headers of [{}, { authorization: "" }, { authorization: "Bearer " }, { authorization: "Basic abc" }, { authorization: "bearer lower" }]) {
    const { res } = await run([protect], { headers });
    assert.equal(res.code, 401, JSON.stringify(headers));
    assert.equal(res.body.code, "UNAUTHENTICATED");
    noLeak(res.body);
  }
  const { res } = await w.call(undefined, w.ok);
  assert.equal(res.code, 401);
});

test("tampered, wrongly-signed, wrong-algorithm and alg:none tokens → 401 (all indistinguishable)", async () => {
  const w = world();
  const payload = buildTokenPayload(w.adminA);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const forged = [
    jwt.sign(payload, "some-other-secret"),
    jwt.sign(payload, SECRET, { algorithm: "HS512" }),                 // algorithm confusion
    `${b64({ alg: "none", typ: "JWT" })}.${b64(payload)}.`,            // unsigned
    `${w.tokenFor(w.adminA).slice(0, -3)}abc`,                         // bad signature
    "not.a.jwt",
  ];
  for (const t of forged) {
    const { res } = await w.call(t, w.ok);
    assert.equal(res.code, 401);
    assert.equal(res.body.code, "SESSION_INVALID");
    noLeak(res.body);
  }
});

test("expired token → 401 TOKEN_EXPIRED", async () => {
  const w = world();
  const t = jwt.sign(buildTokenPayload(w.adminA), SECRET, { expiresIn: -10 });
  const { res } = await w.call(t, w.ok);
  assert.equal(res.code, 401);
  assert.equal(res.body.code, "TOKEN_EXPIRED");
});

test("issued tokens use HS256 and carry the session version", () => {
  const w = world();
  const t = w.tokenFor(w.adminA);
  assert.equal(jwt.decode(t, { complete: true }).header.alg, "HS256");
  assert.equal(jwt.decode(t).av, 0);
});

// ── 2. Fresh role / college / status from the database ───────────────────────
test("a valid session is rebuilt from the database (req.auth and req.user)", async () => {
  const w = world();
  const t = w.teacher(w.A);
  const { req, res } = await w.call(w.tokenFor(t), w.ok);
  assert.equal(res.code, 200);
  assert.equal(req.auth.userId, t._id);
  assert.equal(req.auth.role, "teacher");
  assert.equal(req.auth.collegeId, w.A.collegeId);
  assert.equal(req.auth.college.name, "Alpha");
  assert.equal(req.user.role, "teacher");
  assert.equal(req.user.collegeId, w.A.collegeId);
  assert.ok(Object.isFrozen(req.auth), "session object is immutable");
});

test("stale/forged ROLE claim: token says admin but the database says teacher → admin routes refuse", async () => {
  const w = world();
  const t = w.teacher(w.A);
  const { res, req } = await w.call(w.tokenFor(t, { role: "admin" }), authorize("admin"), w.ok);
  assert.equal(res.code, 403);
  assert.equal(res.body.code, "FORBIDDEN");
  noLeak(res.body);
  assert.equal(req.user.role, "teacher", "req.user was overwritten with the database role");
});

test("a demoted admin's old admin token stops working on admin routes immediately", async () => {
  const w = world();
  const token = w.tokenFor(w.adminA);
  assert.equal((await w.call(token, authorize("admin"), w.ok)).res.code, 200);
  w.db.User.rows.find((u) => u._id === w.adminA._id).role = "teacher"; // role changed in DB, no version bump
  assert.equal((await w.call(token, authorize("admin"), w.ok)).res.code, 403);
});

test("a promoted teacher's old token says teacher, but the database role wins (no stale downgrade either)", async () => {
  const w = world();
  const t = w.teacher(w.A);
  const token = w.tokenFor(t);
  w.db.User.rows.find((u) => u._id === t._id).role = "admin";
  const { res, req } = await w.call(token, authorize("admin"), w.ok);
  assert.equal(res.code, 200);
  assert.equal(req.auth.role, "admin");
});

test("stale/forged COLLEGE claim: the session college is the database college", async () => {
  const w = world();
  const { req } = await w.call(w.tokenFor(w.adminB, { collegeId: w.A.collegeId }), w.ok);
  assert.equal(req.auth.collegeId, w.B.collegeId);
  assert.equal(req.user.collegeId, w.B.collegeId);
});

test("deleted account → 401 SESSION_INVALID (same answer as a bad signature)", async () => {
  const w = world();
  const t = w.teacher(w.A);
  const token = w.tokenFor(t);
  w.db.User.rows.splice(w.db.User.rows.findIndex((u) => u._id === t._id), 1);
  const { res } = await w.call(token, w.ok);
  assert.equal(res.code, 401);
  assert.equal(res.body.code, "SESSION_INVALID");
  noLeak(res.body);
});

test("pending and rejected teachers are refused even with a token claiming approved:true", async () => {
  const w = world();
  const pending = w.teacher(w.A, { approved: false, approvalStatus: "pending" });
  const rejected = w.teacher(w.A, { approved: false, approvalStatus: "rejected" });
  const legacyPending = w.teacher(w.A, { approved: false, approvalStatus: undefined });
  for (const [u, code] of [[pending, "ACCOUNT_PENDING"], [rejected, "ACCOUNT_REJECTED"], [legacyPending, "ACCOUNT_PENDING"]]) {
    const { res } = await w.call(w.tokenFor(u, { approved: true, role: "admin" }), w.ok);
    assert.equal(res.code, 403);
    assert.equal(res.body.code, code);
    noLeak(res.body);
  }
});

test("inconsistent records (approved:true + rejected) are denied; so is an unapproved ADMIN", async () => {
  const w = world();
  const odd = w.teacher(w.A, { approved: true, approvalStatus: "rejected" });
  assert.equal((await w.call(w.tokenFor(odd), w.ok)).res.body.code, "ACCOUNT_REJECTED");
  const badAdmin = seedAdmin(w.db, w.A, { approved: false, approvalStatus: "pending" });
  assert.equal((await w.call(w.tokenFor(badAdmin), authorize("admin"), w.ok)).res.code, 403);
});

test("a teacher approved later gets in on the next request; one rejected later is out on the next request", async () => {
  const w = world();
  const t = w.teacher(w.A, { approved: false, approvalStatus: "pending" });
  const token = w.tokenFor(t);
  assert.equal((await w.call(token, w.ok)).res.code, 403);
  Object.assign(w.db.User.rows.find((u) => u._id === t._id), { approved: true, approvalStatus: "approved" });
  assert.equal((await w.call(token, w.ok)).res.code, 200);
  Object.assign(w.db.User.rows.find((u) => u._id === t._id), { approved: false, approvalStatus: "rejected" });
  assert.equal((await w.call(token, w.ok)).res.code, 403);
});

// ── 3. College status & membership ───────────────────────────────────────────
test("suspended / deleted college blocks its admins and teachers; reactivation restores them", async () => {
  const w = world();
  const t = w.teacher(w.A);
  const tt = w.tokenFor(t), at = w.tokenFor(w.adminA);
  w.A.status = "suspended";
  for (const token of [tt, at]) {
    const { res } = await w.call(token, w.ok);
    assert.equal(res.code, 403);
    assert.equal(res.body.code, "COLLEGE_SUSPENDED");
    noLeak(res.body);
  }
  // other colleges are unaffected
  assert.equal((await w.call(w.tokenFor(w.adminB), w.ok)).res.code, 200);
  w.A.status = "active";
  assert.equal((await w.call(tt, w.ok)).res.code, 200);

  w.db.College.rows.splice(w.db.College.rows.findIndex((c) => c.collegeId === w.A.collegeId), 1);
  const gone = await w.call(tt, w.ok);
  assert.equal(gone.res.code, 403);
  assert.equal(gone.res.body.code, "COLLEGE_UNAVAILABLE");
});

test("accounts with no college: allowed by default (legacy install), refused with STRICT_COLLEGE_MEMBERSHIP", async () => {
  const lenient = world();
  const legacy = lenient.teacher(null);
  const r = await lenient.call(lenient.tokenFor(legacy), lenient.ok);
  assert.equal(r.res.code, 200);
  assert.equal(r.req.auth.collegeId, null);

  const strict = world({ strict: true });
  const s = await strict.call(strict.tokenFor(strict.teacher(null)), strict.ok);
  assert.equal(s.res.code, 403);
  assert.equal(s.res.body.code, "NO_COLLEGE");
});

// ── 4. Revocation via session version ────────────────────────────────────────
test("bumping authVersion invalidates every older token; a fresh token works", async () => {
  const w = world();
  const t = w.teacher(w.A);
  const old = w.tokenFor(t);
  assert.equal((await w.call(old, w.ok)).res.code, 200);
  w.db.User.rows.find((u) => u._id === t._id).authVersion = 1;
  const r = await w.call(old, w.ok);
  assert.equal(r.res.code, 401);
  assert.equal(r.res.body.code, "SESSION_INVALID");
  assert.equal((await w.call(w.tokenFor(w.db.User.rows.find((u) => u._id === t._id)), w.ok)).res.code, 200);
});

test("tokens issued before this feature (no av claim) keep working until the version is bumped", async () => {
  const w = world();
  const t = w.teacher(w.A);
  const { av, ...legacyClaims } = buildTokenPayload(t); // eslint-disable-line no-unused-vars
  const legacy = generateToken(legacyClaims);
  assert.equal((await w.call(legacy, w.ok)).res.code, 200);
  w.db.User.rows.find((u) => u._id === t._id).authVersion = 1;
  assert.equal((await w.call(legacy, w.ok)).res.code, 401);
});

test("a token whose av claim is non-numeric or negative is refused", async () => {
  const w = world();
  const t = w.teacher(w.A);
  w.db.User.rows.find((u) => u._id === t._id).authVersion = 3;
  for (const av of ["3", -1, null, {}, 2]) {
    assert.equal((await w.call(w.tokenFor(t, { av }), w.ok)).res.code, 401, String(JSON.stringify(av)));
  }
  assert.equal((await w.call(w.tokenFor(t, { av: 3 }), w.ok)).res.code, 200);
});

// ── 5. authorize() fails closed ──────────────────────────────────────────────
test("authorize never falls back to token claims: without a resolved session it denies everyone", async () => {
  const w = world();
  const { res } = await run([protect, authorize("admin")], { headers: { authorization: `Bearer ${w.tokenFor(w.adminA)}` } });
  assert.equal(res.code, 403);
  const direct = await run([authorize("admin")], { user: { role: "admin" } });
  assert.equal(direct.res.code, 403);
});

test("requireApproved without protect first → 401 (chain mistakes fail closed)", async () => {
  const w = world();
  const { res } = await run([w.requireApproved, w.ok], { headers: {} });
  assert.equal(res.code, 401);
});

test("garbage ids in a signed token never reach the database", async () => {
  const w = world();
  for (const id of ["", "123", "zzzzzzzzzzzzzzzzzzzzzzzz", { $ne: "x" }, null, 42]) {
    const { res } = await w.call(jwt.sign({ id, av: 0 }, SECRET), w.ok);
    assert.equal(res.code, 401, JSON.stringify(id));
  }
});

// ── 6. Error responses ───────────────────────────────────────────────────────
test("every auth failure has the same shape and never echoes role/ids/internals", async () => {
  const w = world();
  const t = w.teacher(w.A);
  const cases = [
    (await w.call(undefined, w.ok)).res,
    (await w.call("junk", w.ok)).res,
    (await w.call(w.tokenFor(t), authorize("admin"), w.ok)).res,
    (await w.call(w.tokenFor(w.teacher(w.A, { approved: false, approvalStatus: "pending" })), w.ok)).res,
  ];
  for (const r of cases) { assert.ok([401, 403].includes(r.code)); noLeak(r.body); }
  assert.ok(!cases[2].body.message.includes("teacher"), "403 must not echo the caller's role");
});

test("error handler hides internals of 5xx errors but keeps 4xx messages", () => {
  const send = (err) => {
    const res = { code: 0, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
    const orig = console.error; console.error = () => {};
    try { errorHandler(err, {}, res, () => {}); } finally { console.error = orig; }
    return res;
  };
  const boom = send(new Error("connect ECONNREFUSED mongodb://user:pw@host/db"));
  assert.equal(boom.code, 500);
  assert.ok(!JSON.stringify(boom.body).includes("mongodb"));
  assert.equal(boom.body.code, "SERVER_ERROR");
  const bad = send(Object.assign(new Error("bad json"), { type: "entity.parse.failed", status: 400 }));
  assert.equal(bad.code, 400);
  assert.equal(bad.body.message, "Malformed request body.");
  const validation = send(Object.assign(new Error("x"), { status: 409 }));
  assert.equal(validation.code, 409);
});

// ── 7. Startup configuration ─────────────────────────────────────────────────
test("security config check flags missing, short and placeholder JWT secrets", () => {
  assert.equal(checkSecurityConfig({}).ok, false);
  assert.equal(checkSecurityConfig({ JWT_SECRET: "short" }).ok, false);
  assert.equal(checkSecurityConfig({ JWT_SECRET: "change-me-to-a-long-random-string" }).ok, false);
  assert.equal(checkSecurityConfig({ JWT_SECRET: "x".repeat(40) }).ok, true);
  assert.equal(checkSecurityConfig({ JWT_SECRET: "x".repeat(40), NODE_ENV: "production" }).production, true);
});
