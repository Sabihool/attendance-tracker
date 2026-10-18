/**
 * Real-database test of the Part 8 workflow. SKIPPED unless TEST_MONGO_URI is
 * set (throw-away database — it deletes what it creates):
 *   TEST_MONGO_URI="mongodb://localhost:27017/at_test" npm test
 * It exercises what the in-memory tests cannot prove: the real unique email
 * index, and that the single conditional update really is atomic in MongoDB.
 */
import test from "node:test";
import assert from "node:assert/strict";

const URI = process.env.TEST_MONGO_URI;

test("teacher approval against real MongoDB (races + isolation)", { skip: !URI && "TEST_MONGO_URI not set" }, async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
  const mongoose = (await import("mongoose")).default;
  await mongoose.connect(URI);
  const { default: User } = await import("../models/User.js");
  const { default: College } = await import("../models/College.js");
  const { default: Notification } = await import("../models/Notification.js");
  const { createSignup } = await import("../controllers/authController.js");
  const { createNotificationService } = await import("../services/notificationService.js");
  const { createTeacherApprovalService } = await import("../services/teacherApprovalService.js");
  const { findActiveCollegeById } = await import("../controllers/collegeController.js");
  const { generateCollegeId } = await import("../utils/collegeId.js");
  await Promise.all([User.init(), College.init(), Notification.init()]);

  const tag = `p8-${Date.now()}`;
  const mkRes = () => ({ code: 0, body: null, status(c) { this.code = c; return this; }, json(j) { this.body = j; return this; } });
  const ids = { colleges: [], users: [] };
  const notifier = createNotificationService({ Notification });
  const service = createTeacherApprovalService({ User, College, notifier });
  const signup = createSignup({ User, College, findActiveCollege: findActiveCollegeById, onTeacherRegistered: (a) => service.notifyNewRequest(a) });

  try {
    const mkCollege = async (name) => {
      const c = await College.create({ collegeId: generateCollegeId(), name: `${tag} ${name}`, country: "Bangladesh", district: "Feni", dedupeKey: `${tag}|${name}` });
      ids.colleges.push(c._id); return c;
    };
    const A = await mkCollege("A"), B = await mkCollege("B");
    const mkAdmin = async (c, n) => { const u = await User.create({ name: `Admin ${n}`, email: `${tag}-admin${n}@example.com`, password: "Secret123", role: "admin", approved: true, approvalStatus: "approved", collegeId: c.collegeId }); ids.users.push(u._id); return u; };
    const a1 = await mkAdmin(A, 1), a2 = await mkAdmin(A, 2), b1 = await mkAdmin(B, 3);
    const scope = async (u) => (await service.resolveAdminScope(String(u._id))).scope;

    // duplicate signups race → the unique index lets exactly one through
    const body = { name: "Race Teacher", email: `${tag}-t@example.com`, password: "Secret123", role: "teacher", collegeId: A.collegeId };
    const rs = await Promise.all(Array.from({ length: 6 }, async () => { const r = mkRes(); await signup({ body }, r, (e) => { throw e; }); return r; }));
    assert.equal(rs.filter((r) => r.code === 201).length, 1);
    assert.equal(rs.filter((r) => r.code === 409).length, 5);
    const teacher = await User.findOne({ email: body.email }).lean();
    ids.users.push(teacher._id);
    assert.equal(teacher.approved, false);
    assert.equal(teacher.approvalStatus, "pending");

    // other college's admin cannot touch it
    assert.equal((await service.decide(await scope(b1), String(teacher._id), "approve")).status, 404);

    // concurrent approve/reject by two admins → exactly one wins
    const [x, y] = await Promise.all([
      service.decide(await scope(a1), String(teacher._id), "approve"),
      service.decide(await scope(a2), String(teacher._id), "reject"),
    ]);
    assert.deepEqual([x.status, y.status].sort(), [200, 409]);
    const final = await User.findById(teacher._id).lean();
    assert.equal(final.approved, final.approvalStatus === "approved");

    // suspended college → admins locked out
    await College.updateOne({ _id: A._id }, { $set: { status: "suspended" } });
    assert.equal((await service.resolveAdminScope(String(a1._id))).status, 403);
  } finally {
    await Notification.deleteMany({ userId: { $in: ids.users } });
    await User.deleteMany({ _id: { $in: ids.users } });
    await College.deleteMany({ _id: { $in: ids.colleges } });
    await mongoose.disconnect();
  }
});
