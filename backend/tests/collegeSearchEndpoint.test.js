import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createSearchColleges } from "../controllers/collegeController.js";
import { createRateLimiter } from "../middleware/rateLimit.js";
import { createSignup } from "../controllers/authController.js";
import { buildSearchTokens, buildNameKey } from "../utils/collegeSearch.js";

// ── Fake College collection that evaluates the REAL filter shape ─────────────
const seed = [
  { collegeId: "COL-AAAAAAAAAA", name: "Feni Computer Institute", district: "Feni", country: "Bangladesh", status: "active", adminEmail: "secret@x.com", createdBy: "u1", dedupeKey: "d1" },
  { collegeId: "COL-BBBBBBBBBB", name: "Dhaka City College", district: "Dhaka", country: "Bangladesh", status: "active", dedupeKey: "d2" },
  { collegeId: "COL-CCCCCCCCCC", name: "Feni Girls College", district: "Feni", country: "Bangladesh", status: "suspended", dedupeKey: "d3" },
  { collegeId: "COL-DDDDDDDDDD", name: "Mumbai Computer College", district: "Mumbai", country: "India", status: "active", dedupeKey: "d4" },
].map((c) => ({ ...c, searchTokens: buildSearchTokens(c), nameKey: buildNameKey(c.name) }));

const matches = (doc, filter) =>
  Object.entries(filter).every(([k, v]) => {
    if (k === "$and") return v.every((f) => matches(doc, f));
    if (v && typeof v === "object" && "$regex" in v) {
      const re = new RegExp(v.$regex);
      return [].concat(doc[k] ?? []).some((x) => re.test(x));
    }
    return doc[k] === v;
  });

const makeCollege = (rows = seed) => {
  const calls = [];
  return {
    calls,
    find(filter) {
      const call = { filter }; calls.push(call);
      let docs = rows.filter((r) => matches(r, filter));
      const q = {
        select(s) { call.select = s; return q; },
        sort(s) { call.sort = s; docs = [...docs].sort((a, b) => a.nameKey.localeCompare(b.nameKey)); return q; },
        limit(n) { call.limit = n; docs = docs.slice(0, n); return q; },
        maxTimeMS(n) { call.maxTimeMS = n; return q; },
        lean: async () => {
          if (College.fail) throw new Error("db down");
          // honour the select whitelist like Mongo would
          const fields = call.select.split(/\s+/).filter((f) => !f.startsWith("-"));
          return docs.map((d) => Object.fromEntries(fields.map((f) => [f, d[f]])));
        },
      };
      return q;
    },
  };
};
let College;

const start = async (mw = []) => {
  College = makeCollege();
  const app = express();
  app.get("/search", ...mw, createSearchColleges({ College }));
  app.use((err, _req, res, _next) => res.status(500).json({ success: false, message: "Something went wrong" }));
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}/search`;
  return { get: (qs = "") => fetch(base + qs), close: () => server.close() };
};

test("search returns only collegeId/name/district/country", async () => {
  const s = await start();
  const res = await s.get("?q=feni");
  const json = await res.json(); s.close();
  assert.equal(res.status, 200);
  assert.equal(json.data.colleges.length, 1);
  assert.deepEqual(json.data.colleges[0], {
    collegeId: "COL-AAAAAAAAAA", name: "Feni Computer Institute", district: "Feni", country: "Bangladesh",
  });
  const raw = JSON.stringify(json);
  for (const leak of ["secret@x.com", "createdBy", "dedupeKey", "searchTokens", "status", "_id"]) {
    assert.ok(!raw.includes(leak), `leaked ${leak}`);
  }
});

test("suspended colleges are excluded", async () => {
  const s = await start();
  const json = await (await s.get("?q=girls")).json(); s.close();
  assert.deepEqual(json.data.colleges, []);
});

test("matches by district and country, case/accent-insensitive, multi-word", async () => {
  const s = await start();
  const byDistrict = await (await s.get("?q=DHAKA")).json();
  const byCountry = await (await s.get("?q=india")).json();
  const multi = await (await s.get("?q=comp%20fen")).json();
  const none = await (await s.get("?q=zzzz")).json();
  s.close();
  assert.deepEqual(byDistrict.data.colleges.map((c) => c.name), ["Dhaka City College"]);
  assert.deepEqual(byCountry.data.colleges.map((c) => c.name), ["Mumbai Computer College"]);
  assert.deepEqual(multi.data.colleges.map((c) => c.name), ["Feni Computer Institute"]);
  assert.deepEqual(none.data.colleges, []);
});

test("empty / one-character queries return 200 + empty list WITHOUT touching the database", async () => {
  const s = await start();
  for (const qs of ["", "?q=", "?q=%20%20", "?q=f"]) {
    const res = await s.get(qs); const json = await res.json();
    assert.equal(res.status, 200); assert.deepEqual(json.data.colleges, []);
  }
  assert.equal(College.calls.length, 0);
  s.close();
});

test("invalid input is rejected with 400 and never queried", async () => {
  const s = await start();
  for (const qs of ["?q[]=a&q[]=b", "?q[$ne]=x", `?q=${"x".repeat(81)}`, "?q=fe&limit=abc", "?q=fe&limit=-1"]) {
    const res = await s.get(qs);
    assert.equal(res.status, 400, qs);
    assert.equal((await res.json()).success, false);
  }
  assert.equal(College.calls.length, 0);
  s.close();
});

test("query is bounded: limit capped, candidate pool, timeout, explicit field whitelist", async () => {
  const s = await start();
  await (await s.get("?q=college&limit=500")).json();
  s.close();
  const call = College.calls[0];
  assert.equal(call.limit, 50);
  assert.equal(call.maxTimeMS, 3000);
  assert.equal(call.select, "collegeId name district country -_id");
  assert.equal(call.filter.status, "active");
});

test("limit param trims the result list", async () => {
  const s = await start();
  const json = await (await s.get("?q=college&limit=1")).json(); s.close();
  assert.equal(json.data.colleges.length, 1);
});

test("database failure -> generic 500 (no internals leaked)", async () => {
  const s = await start();
  College.fail = true;
  const res = await s.get("?q=feni"); const json = await res.json(); s.close();
  assert.equal(res.status, 500);
  assert.ok(!JSON.stringify(json).includes("db down"));
});

test("rate limiter returns 429 with Retry-After", async () => {
  const s = await start([createRateLimiter({ windowMs: 60000, max: 2 })]);
  await s.get("?q=feni"); await s.get("?q=feni");
  const res = await s.get("?q=feni"); s.close();
  assert.equal(res.status, 429);
  assert.ok(res.headers.get("retry-after"));
});

// ── Teacher signup requires a real, active college ───────────────────────────
const signupHarness = async () => {
  const created = [];
  const FakeUser = {
    findOne: async () => null,
    create: async (doc) => { created.push(doc); return { ...doc, toPublicJSON() { return { name: doc.name, collegeId: doc.collegeId }; } }; },
  };
  const FakeCollege = makeCollege();
  const findActiveCollege = async (C, id) =>
    (typeof id === "string" && /^COL-[2-9A-HJKMNP-TV-Z]{10}$/.test(id)
      ? seed.find((c) => c.collegeId === id && c.status === "active") : null);
  const app = express();
  app.use(express.json());
  app.post("/signup", createSignup({ User: FakeUser, College: FakeCollege, findActiveCollege }));
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const post = (b) => fetch(`http://127.0.0.1:${server.address().port}/signup`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
  return { post, created, close: () => server.close() };
};
const teacher = (o = {}) => ({ name: "T One", email: "t@example.com", password: "Secret123", role: "teacher", ...o });

test("signup: stores the selected college's ID", async () => {
  const h = await signupHarness();
  const res = await h.post(teacher({ collegeId: "COL-AAAAAAAAAA" })); h.close();
  assert.equal(res.status, 201);
  assert.equal(h.created[0].collegeId, "COL-AAAAAAAAAA");
  assert.equal(h.created[0].approved, false);
});

test("signup: missing, typed-name, unknown, suspended and injected colleges are all refused", async () => {
  const h = await signupHarness();
  const cases = [
    {},                                                   // nothing selected
    { collegeId: "" },
    { collegeId: "Feni Computer Institute" },             // arbitrary typed text
    { collegeId: "COL-ZZZZZZZZZZ" },                      // well-formed but unknown
    { collegeId: "COL-CCCCCCCCCC" },                      // suspended
    { collegeId: { $ne: "" } },                           // operator injection
    { collegeId: ["COL-AAAAAAAAAA"] },
  ];
  for (const c of cases) {
    const res = await h.post(teacher(c));
    const json = await res.json();
    assert.equal(res.status, 400, JSON.stringify(c));
    assert.ok(json.errors.collegeId);
  }
  assert.equal(h.created.length, 0);
  h.close();
});

test("signup: admin role is still refused", async () => {
  const h = await signupHarness();
  const res = await h.post(teacher({ role: "admin", collegeId: "COL-AAAAAAAAAA" })); h.close();
  assert.equal(res.status, 403);
});
