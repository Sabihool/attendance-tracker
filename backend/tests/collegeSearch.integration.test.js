/**
 * Real-database test for the college search. SKIPPED unless TEST_MONGO_URI is set:
 *   TEST_MONGO_URI="mongodb://localhost:27017/at_test" npm test
 * Use a throw-away database. It creates colleges tagged "ZZTEST" and deletes them.
 * Also asserts the query plan uses the {status, searchTokens} index (no COLLSCAN).
 */
import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";

const URI = process.env.TEST_MONGO_URI;

test("college search against real MongoDB (index used, suspended hidden)", { skip: !URI && "TEST_MONGO_URI not set" }, async () => {
  await mongoose.connect(URI);
  const { default: College } = await import("../models/College.js");
  const { createSearchColleges } = await import("../controllers/collegeController.js");
  const { buildSearchFilter } = await import("../utils/collegeSearch.js");
  const { generateCollegeId } = await import("../utils/collegeId.js");
  await College.init();

  const mk = (name, district, status = "active") => ({
    collegeId: generateCollegeId(), name, district, country: "Bangladesh", status,
    dedupeKey: `${name}|${district}|zztest`.toLowerCase(),
  });
  try {
    await College.create([
      mk("ZZTEST Feni Computer Institute", "Feni"),
      mk("ZZTEST Dhaka College", "Dhaka"),
      mk("ZZTEST Feni Suspended College", "Feni", "suspended"),
    ]);

    const run = async (q) => {
      const res = { code: 200, body: null, set() {}, status(c) { this.code = c; return this; }, json(j) { this.body = j; return this; } };
      await createSearchColleges({ College })({ query: { q } }, res, (e) => { throw e; });
      return res.body.data.colleges.map((c) => c.name);
    };
    assert.deepEqual(await run("zztest feni"), ["ZZTEST Feni Computer Institute"]);
    assert.deepEqual(await run("ZZTEST dha"), ["ZZTEST Dhaka College"]);

    const plan = await College.find(buildSearchFilter(["zztest"])).explain("queryPlanner");
    assert.ok(!JSON.stringify(plan).includes("COLLSCAN"), "search must not collection-scan");
  } finally {
    await College.deleteMany({ dedupeKey: /zztest$/ });
    await mongoose.disconnect();
  }
});
