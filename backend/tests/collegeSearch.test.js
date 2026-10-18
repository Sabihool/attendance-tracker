import test from "node:test";
import assert from "node:assert/strict";
import College from "../models/College.js";
import {
  foldText, tokenize, buildSearchTokens, parseSearchParams, buildSearchFilter,
  rankColleges, toSearchResult, escapeRegex, SEARCH_LIMITS,
} from "../utils/collegeSearch.js";
import { backfillCollegeSearchFields } from "../utils/collegeBackfill.js";

test("foldText lowercases, strips accents and punctuation", () => {
  assert.equal(foldText("  Café  St. Mary’s-College "), "cafe st mary s college");
  assert.equal(foldText(null), "");
  assert.deepEqual(tokenize("Feni   Computer"), ["feni", "computer"]);
});

test("buildSearchTokens covers name + district + country, deduplicated", () => {
  const t = buildSearchTokens({ name: "Feni Computer Institute", district: "Feni", country: "Bangladesh" });
  assert.deepEqual(t.sort(), ["bangladesh", "computer", "feni", "institute"]);
});

test("parseSearchParams: blank / short queries are valid but empty (never list everything)", () => {
  for (const q of [undefined, "", "   ", "a", " a "]) {
    const r = parseSearchParams({ q });
    assert.equal(r.ok, true); assert.equal(r.empty, true); assert.deepEqual(r.tokens, []);
  }
  assert.equal(parseSearchParams({ q: "-- ." }).empty, true); // no letters/digits at all
});

test("parseSearchParams: tokens, ordering, limits", () => {
  const r = parseSearchParams({ q: "  Feni   COMPUTER  a " });
  assert.equal(r.empty, false);
  assert.deepEqual(r.tokens, ["computer", "feni"]); // 1-char word dropped, longest first
  assert.equal(r.phrase, "feni computer a");
  assert.equal(r.limit, SEARCH_LIMITS.defaultLimit);
  assert.equal(parseSearchParams({ q: "fe", limit: "5" }).limit, 5);
  assert.equal(parseSearchParams({ q: "fe", limit: "999" }).limit, SEARCH_LIMITS.maxLimit);
  assert.equal(parseSearchParams({ q: "fe", limit: "0" }).limit, 1);
  assert.equal(parseSearchParams({ q: "w1 w2 w3 w4 w5 w6 w7 w8".replace(/w/g, "ab") }).tokens.length, SEARCH_LIMITS.maxTokens);
});

test("parseSearchParams rejects malformed input", () => {
  assert.equal(parseSearchParams({ q: ["a", "b"] }).ok, false);
  assert.equal(parseSearchParams({ q: { $ne: "" } }).ok, false);
  assert.equal(parseSearchParams({ q: "x".repeat(SEARCH_LIMITS.maxQueryLength + 1) }).ok, false);
  assert.equal(parseSearchParams({ q: "fe", limit: "abc" }).ok, false);
  assert.equal(parseSearchParams({ q: "fe", limit: "-3" }).ok, false);
  assert.equal(parseSearchParams({ q: "fe", limit: ["1"] }).ok, false);
  assert.equal(parseSearchParams({ q: "fe\u0000x" }).ok, false);
  assert.equal(parseSearchParams(undefined).empty, true);
});

test("regex metacharacters can never inject a pattern", () => {
  const { tokens } = parseSearchParams({ q: ".* (a+)+$ [x]" });
  const f = buildSearchFilter(tokens);
  for (const c of f.$and) assert.match(c.searchTokens.$regex, /^\^[\p{L}\p{N}]+$/u);
  assert.equal(escapeRegex("a.b*c"), "a\\.b\\*c");
});

test("filter is anchored, active-only, one clause per word", () => {
  const f = buildSearchFilter(["computer", "feni"]);
  assert.equal(f.status, "active");
  assert.deepEqual(f.$and, [
    { searchTokens: { $regex: "^computer" } },
    { searchTokens: { $regex: "^feni" } },
  ]);
});

test("rankColleges: name-prefix first, then word-prefix, then district/country matches", () => {
  const rows = [
    { name: "Zeta College", district: "Feni", country: "Bangladesh" },
    { name: "Dhaka Feni Institute", district: "Dhaka", country: "Bangladesh" },
    { name: "Feni Computer Institute", district: "Feni", country: "Bangladesh" },
    { name: "Alpha College", district: "Feni", country: "Bangladesh" },
  ];
  const out = rankColleges(rows, ["feni"], 10, "feni").map((r) => r.name);
  assert.deepEqual(out, ["Feni Computer Institute", "Dhaka Feni Institute", "Alpha College", "Zeta College"]);
  assert.equal(rankColleges(rows, ["feni"], 2, "feni").length, 2);
});

test("toSearchResult exposes exactly four public fields", () => {
  const out = toSearchResult({
    collegeId: "COL-7K2M9XQ4TB", name: "A", district: "B", country: "C",
    createdBy: "u1", dedupeKey: "x", status: "active", adminEmail: "a@b.c", searchTokens: ["a"],
  });
  assert.deepEqual(Object.keys(out).sort(), ["collegeId", "country", "district", "name"]);
});

// ── Model (no database needed) ───────────────────────────────────────────────
test("College model: pre-validate fills search fields; indexes + select:false declared", async () => {
  const c = new College({ collegeId: "COL-AAAAAAAAAA", name: "Feni Computer Institute", country: "Bangladesh", district: "Feni", dedupeKey: "k" });
  await c.validate();
  assert.deepEqual([...c.searchTokens].sort(), ["bangladesh", "computer", "feni", "institute"]);
  assert.equal(c.nameKey, "feni computer institute");

  const hasIdx = College.schema.indexes().some(([f]) => f.status === 1 && f.searchTokens === 1);
  assert.ok(hasIdx, "compound {status, searchTokens} index missing");
  assert.equal(College.schema.path("searchTokens").options.select, false);
  assert.equal(College.schema.path("nameKey").options.select, false);
  assert.ok(!("searchTokens" in c.toPublicJSON()));
});

test("College model: legacy documents (no tokens) still validate", async () => {
  const c = College.hydrate({ collegeId: "COL-BBBBBBBBBB", name: "Old College", country: "Bangladesh", district: "Dhaka", dedupeKey: "k2", status: "active" });
  await c.validate();
});

test("College search filter casts cleanly through Mongoose", () => {
  const q = College.find(buildSearchFilter(["feni"]));
  q.cast(College); // throws on an invalid filter
  assert.ok(true);
});

test("backfill updates only colleges missing tokens and is idempotent", async () => {
  const docs = [{ _id: 1, name: "Old College", district: "Dhaka", country: "Bangladesh" }];
  const writes = [];
  const Fake = {
    find: () => ({ select: () => ({ lean: async () => docs.splice(0) }) }),
    bulkWrite: async (ops) => { writes.push(...ops); },
  };
  assert.equal(await backfillCollegeSearchFields(Fake), 1);
  assert.deepEqual(writes[0].updateOne.update.$set.searchTokens.sort(), ["bangladesh", "college", "dhaka", "old"]);
  assert.equal(await backfillCollegeSearchFields(Fake), 0);
});
