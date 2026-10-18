/**
 * Real-database integration test. SKIPPED unless TEST_MONGO_URI is set, e.g.
 *   TEST_MONGO_URI="mongodb://localhost:27017/at_test" npm test
 * Use a throw-away database: it deletes everything it creates.
 * For transaction coverage point it at a replica set (Atlas or `mongod --replSet`).
 */
import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";

const URI = process.env.TEST_MONGO_URI;

test("registerCollege against real MongoDB", { skip: !URI && "TEST_MONGO_URI not set" }, async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
  await mongoose.connect(URI);
  const { default: College } = await import("../models/College.js");
  const { default: User } = await import("../models/User.js");
  const { registerCollege } = await import("../controllers/collegeController.js");
  await Promise.all([College.init(), User.init()]);

  const email = `it-${Date.now()}@example.com`;
  const mkRes = () => { const r = { code: 0, json: null, status(c) { this.code = c; return this; }, json(j) { this.json = j; return this; } }; return r; };
  const req = { body: { collegeName: `IT College ${Date.now()}`, country: "Bangladesh", district: "Feni",
    adminName: "Test Admin", adminEmail: email, password: "Secret123", confirmPassword: "Secret123" } };
  const res = mkRes();
  try {
    await registerCollege(req, res, (e) => { throw e; });
    assert.equal(res.code, 201);
    const stored = await User.findOne({ email }).select("+password");
    assert.notEqual(stored.password, "Secret123");
    assert.match(stored.password, /^\$2[aby]\$12\$/);
    assert.equal(stored.role, "admin");
    assert.equal(stored.collegeId, res.json.data.college.collegeId);

    const dup = mkRes();
    await registerCollege({ body: { ...req.body, collegeName: "Other" } }, dup, (e) => { throw e; });
    assert.equal(dup.code, 409);
  } finally {
    await User.deleteMany({ email });
    await College.deleteMany({ name: req.body.collegeName });
    await mongoose.disconnect();
  }
});
