import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createRegisterCollege } from "../controllers/collegeController.js";
import { createRateLimiter } from "../middleware/rateLimit.js";
import { generateCollegeId, COLLEGE_ID_PATTERN } from "../utils/collegeId.js";
import User from "../models/User.js";

// ── Fake persistence (in-memory) ─────────────────────────────────────────────
const makeDeps = ({ failUserCreate = false, txSupported = true } = {}) => {
  const db = { colleges: [], users: [], deleted: [] };
  let seq = 0;
  const College = {
    exists: async (q) => (db.colleges.some((c) => c.dedupeKey === q.dedupeKey) ? { _id: 1 } : null),
    create: async ([doc]) => {
      if (db.colleges.some((c) => c.dedupeKey === doc.dedupeKey || c.collegeId === doc.collegeId)) {
        const e = new Error("E11000"); e.code = 11000; e.keyPattern = { dedupeKey: 1 }; throw e;
      }
      const c = { _id: ++seq, ...doc, save: async () => {},
        toPublicJSON() { return { collegeId: this.collegeId, name: this.name, country: this.country, district: this.district, status: this.status }; } };
      db.colleges.push(c); return [c];
    },
    deleteOne: async ({ _id }) => { db.colleges = db.colleges.filter((c) => c._id !== _id); db.deleted.push(_id); },
  };
  const U = {
    exists: async (q) => (db.users.some((u) => u.email === q.email) ? { _id: 1 } : null),
    create: async ([doc]) => {
      if (failUserCreate) throw new Error("boom");
      if (db.users.some((u) => u.email === doc.email)) {
        const e = new Error("E11000"); e.code = 11000; e.keyPattern = { email: 1 }; throw e;
      }
      const u = { _id: ++seq, ...doc,
        toPublicJSON() { const { password, ...rest } = this; delete rest.toPublicJSON; return { _id: rest._id, name: rest.name, email: rest.email, role: rest.role, approved: rest.approved, collegeId: rest.collegeId }; } };
      db.users.push(u); return [u];
    },
  };
  // Mimic txUtils: transaction rolls back college on failure when supported
  const runInTransaction = async (work) => {
    if (!txSupported) return work(null);
    const snapshot = [...db.colleges];
    try { return await work({}); } catch (e) { db.colleges = snapshot; throw e; }
  };
  return { db, deps: { College, User: U, runInTransaction,
    generateToken: () => "jwt-token", buildTokenPayload: (u) => ({ id: u._id }), generateCollegeId } };
};

const start = async (deps, ...mw) => {
  const app = express();
  app.use(express.json());
  app.post("/register", ...mw, createRegisterCollege(deps));
  app.use((err, _req, res, _next) => res.status(500).json({ success: false, message: err.message }));
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const url = `http://127.0.0.1:${server.address().port}/register`;
  const post = (body) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { post, close: () => server.close() };
};

const body = (o = {}) => ({
  collegeName: "Feni Computer Institute", country: "Bangladesh", district: "Feni",
  adminName: "Sabihool Alam", adminEmail: "admin@example.com",
  password: "Secret123", confirmPassword: "Secret123", ...o,
});

test("creates college + admin; server fixes role and collegeId", async () => {
  const { db, deps } = makeDeps();
  const s = await start(deps);
  const res = await s.post(body({ role: "teacher", collegeId: "COL-EVIL", approved: false }));
  const json = await res.json();
  s.close();
  assert.equal(res.status, 201);
  assert.equal(db.users[0].role, "admin");
  assert.equal(db.users[0].approved, true);
  assert.notEqual(db.users[0].collegeId, "COL-EVIL");
  assert.match(db.users[0].collegeId, COLLEGE_ID_PATTERN);
  assert.equal(db.users[0].collegeId, db.colleges[0].collegeId);
  assert.equal(json.data.token, "jwt-token");
  assert.equal(json.data.college.collegeId, db.colleges[0].collegeId);
});

test("response never contains password or dedupeKey", async () => {
  const { deps } = makeDeps();
  const s = await start(deps);
  const text = await (await s.post(body())).text();
  s.close();
  assert.ok(!text.includes("Secret123"));
  assert.ok(!text.includes("dedupeKey"));
  assert.ok(!/"password"/.test(text));
});

test("400 with field errors on invalid input; nothing is stored", async () => {
  const { db, deps } = makeDeps();
  const s = await start(deps);
  const res = await s.post(body({ adminEmail: "bad", confirmPassword: "x" }));
  const json = await res.json();
  s.close();
  assert.equal(res.status, 400);
  assert.ok(json.errors.adminEmail && json.errors.confirmPassword);
  assert.equal(db.colleges.length + db.users.length, 0);
});

test("409 for duplicate email", async () => {
  const { deps } = makeDeps();
  const s = await start(deps);
  await s.post(body());
  const res = await s.post(body({ collegeName: "Another College", adminEmail: "ADMIN@example.com" }));
  s.close();
  assert.equal(res.status, 409);
  assert.ok((await res.json()).errors.adminEmail);
});

test("409 for the same college (case/spacing-insensitive)", async () => {
  const { db, deps } = makeDeps();
  const s = await start(deps);
  await s.post(body());
  const res = await s.post(body({ collegeName: "  feni  COMPUTER institute ", adminEmail: "other@example.com" }));
  s.close();
  assert.equal(res.status, 409);
  assert.equal(db.colleges.length, 1);
});

test("same name in a different district is allowed", async () => {
  const { db, deps } = makeDeps();
  const s = await start(deps);
  await s.post(body());
  const res = await s.post(body({ district: "Chattogram", adminEmail: "b@example.com" }));
  s.close();
  assert.equal(res.status, 201);
  assert.equal(db.colleges.length, 2);
});

test("rolls back the college when admin creation fails (no transaction support)", async () => {
  const { db, deps } = makeDeps({ failUserCreate: true, txSupported: false });
  const s = await start(deps);
  const res = await s.post(body());
  s.close();
  assert.equal(res.status, 500);
  assert.equal(db.colleges.length, 0, "orphan college left behind");
});

test("rolls back the college when admin creation fails (transaction)", async () => {
  const { db, deps } = makeDeps({ failUserCreate: true });
  const s = await start(deps);
  const res = await s.post(body());
  s.close();
  assert.equal(res.status, 500);
  assert.equal(db.colleges.length, 0);
});

test("rate limiter returns 429 after the limit", async () => {
  const { deps } = makeDeps();
  const limiter = createRateLimiter({ max: 2, windowMs: 60_000 });
  const s = await start(deps, limiter);
  const codes = [];
  for (let i = 0; i < 4; i++) codes.push((await s.post(body({ adminEmail: `u${i}@example.com`, collegeName: `College ${"abcd"[i]}` }))).status);
  s.close();
  assert.deepEqual(codes, [201, 201, 429, 429]);
});

test("collegeId generator format and uniqueness", () => {
  const ids = new Set(Array.from({ length: 2000 }, generateCollegeId));
  assert.equal(ids.size, 2000);
  for (const id of ids) assert.match(id, COLLEGE_ID_PATTERN);
});

test("User public JSON never exposes the password hash", () => {
  const u = new User({ name: "A B", email: "a@b.co", password: "hash", role: "admin", collegeId: "COL-X" });
  const pub = u.toPublicJSON();
  assert.ok(!("password" in pub));
  assert.equal(pub.collegeId, "COL-X");
  assert.equal(User.schema.path("password").options.select, false);
});

test("public /auth/signup refuses to create an admin", async () => {
  const { signup } = await import("../controllers/authController.js");
  const res = { code: 0, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  await signup({ body: { name: "Eve", email: "eve@example.com", password: "Secret123", role: "admin" } }, res, (e) => { throw e; });
  assert.equal(res.code, 403);
});
