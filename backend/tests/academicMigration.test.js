/**
 * Part 9 — schema/index definitions, the one-off migration of pre-Part-9 data,
 * per-college default seeding, and the scoped-model helpers it relies on.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installFakeDb, buildSchemaIndexes, mongoose } from "./helpers/mongooseFake.js";
import { models, makeCollege } from "./helpers/e2eApp.js";
import { migrateAcademicOwnership } from "../utils/academicBackfill.js";
import { LEGACY_INDEXES } from "../utils/academicIndexMigration.js";
import { seedCollegeDefaults, seedAcademicDefaults, DEFAULT_SHIFTS, DEFAULT_DEPARTMENTS } from "../services/academicDefaults.js";
import { createRegisterCollege } from "../controllers/collegeController.js";
import { scopedModel, TenantScopeError } from "../utils/tenantScope.js";

const { Department, Shift, Student, Subject, User } = models;
const oid = () => new mongoose.Types.ObjectId().toHexString();
const idxOf = (Model) => Model.schema.indexes().map(([k, o]) => ({ key: k, ...o }));
const uniqueKeys = (Model) => idxOf(Model).filter((i) => i.unique).map((i) => Object.keys(i.key));

// ─── index definitions ────────────────────────────────────────────────────────

test("every uniqueness rule on academic collections is per college (collegeId leads the key)", () => {
  for (const Model of [Department, Shift, Student]) {
    for (const keys of uniqueKeys(Model)) assert.equal(keys[0], "collegeId", `${Model.modelName}: unique index ${keys} is not college-scoped`);
  }
  // Subject's (subjectCode, teacher) is college-safe because a teacher belongs to one college.
  assert.ok(uniqueKeys(Subject).some((k) => k.join() === "subjectCode,teacher"));
  // No single-field unique left on name / studentId.
  assert.ok(!Department.schema.path("name").options.unique);
  assert.ok(!Shift.schema.path("name").options.unique);
});

test("student indexes: registration no. unique per college among ACTIVE students; roll unique per college+group", () => {
  const ix = idxOf(Student);
  const reg = ix.find((i) => Object.keys(i.key).join() === "collegeId,studentId" && i.unique);
  assert.deepEqual(reg.partialFilterExpression, { isActive: true });
  const roll = ix.find((i) => Object.keys(i.key).join() === "collegeId,roll,department,batch,shift");
  assert.ok(roll.unique && roll.partialFilterExpression.isActive === true);
  assert.ok(ix.some((i) => Object.keys(i.key).join() === "collegeId,isActive,department,batch,shift"));
});

test("department/shift name uniqueness is case-insensitive via collation", () => {
  for (const Model of [Department, Shift]) {
    const i = idxOf(Model).find((x) => x.unique);
    assert.deepEqual(i.collation, { locale: "en", strength: 2 });
  }
});

test("collegeId is immutable on every academic model", () => {
  for (const Model of [Department, Shift, Student, Subject]) assert.equal(Model.schema.path("collegeId").options.immutable, true, Model.modelName);
});

// ─── migration of legacy data ──────────────────────────────────────────────────

const legacyWorld = async () => {
  const fakes = installFakeDb();
  // The database as Part 8 left it: GLOBAL unique indexes only.
  await fakes.Department.createIndex({ name: 1 }, { unique: true });
  await fakes.Shift.createIndex({ name: 1 }, { unique: true });
  await fakes.Student.createIndex({ studentId: 1 }, { unique: true, partialFilterExpression: { isActive: true } });
  await fakes.Student.createIndex({ studentId: 1, department: 1, batch: 1, shift: 1 }, { unique: true });
  await fakes.Student.createIndex({ roll: 1, department: 1, batch: 1, shift: 1 }, { unique: true, partialFilterExpression: { isActive: true } });
  await fakes.Student.createIndex({ department: 1, batch: 1, shift: 1 });
  await fakes.Subject.createIndex({ department: 1, batch: 1 });

  const A = await makeCollege("Legacy A");
  const B = await makeCollege("Legacy B");
  const none = await User.create({ name: "No College", email: "nc@example.com", password: "secret123", role: "teacher", approved: true, approvalStatus: "approved" });

  for (const name of ["Computer Science", "Civil"]) await fakes.Department.insertOne({ name });
  for (const [i, name] of ["Morning", "Day"].entries()) await fakes.Shift.insertOne({ name, order: i });
  const legacyStudent = (studentId, roll, by) => fakes.Student.insertOne({ studentId, roll, name: `S ${studentId}`, department: "Computer Science", batch: "2024", shift: "Morning", uploadedBy: by._id.toString(), isActive: true });
  await legacyStudent("1", "1", A.admin);
  await legacyStudent("2", "2", B.admin);
  await legacyStudent("3", "3", none);
  const legacySubject = (code, teacher) => fakes.Subject.insertOne({ subjectName: "Subj", subjectCode: code, batch: "2024", department: "Computer Science", shift: "Morning", teacher: teacher._id.toString(), color: "brand", isArchived: false });
  await legacySubject("A-1", A.teacher);
  await legacySubject("B-1", B.teacher);
  await legacySubject("N-1", none);
  return { fakes, A, B, none };
};

test("BEFORE migration the legacy global indexes really do block a second college (the bug being fixed)", async () => {
  const { fakes, B } = await legacyWorld();
  await assert.rejects(scopedModel(Department, { collegeId: B.collegeId }).create({ name: "Computer Science" }), (e) => e.code === 11000);
  assert.ok(fakes.Department.idx.has("name_1"));
});

test("migration drops the legacy indexes, builds the per-college ones, stamps owners, copies lists — and is idempotent", async () => {
  const { fakes, A, B } = await legacyWorld();
  const r = await migrateAcademicOwnership();
  assert.equal(r.indexesDropped, 1 + 1 + 4 + 1);
  assert.equal(r.subjects, 2); assert.equal(r.students, 2);

  const names = (f) => [...f.idx.keys()];
  assert.ok(!names(fakes.Department).includes("name_1") && names(fakes.Department).includes("collegeId_1_name_1"));
  for (const [coll, list] of Object.entries(LEGACY_INDEXES)) {
    const f = fakes[{ departments: "Department", shifts: "Shift", students: "Student", subjects: "Subject" }[coll]];
    for (const n of list) assert.ok(!f.idx.has(n), `${coll}.${n} still present`);
  }

  // Ownership
  assert.equal(await Subject.countDocuments({ collegeId: A.collegeId }), 1);
  assert.equal(await Subject.countDocuments({ collegeId: B.collegeId }), 1);
  assert.equal(await Subject.countDocuments({ collegeId: null }), 1); // the college-less teacher's
  assert.equal(await Student.countDocuments({ collegeId: A.collegeId }), 1);
  assert.equal(await Student.countDocuments({ collegeId: null }), 1);

  // Each college got the old global lists; the college-less scope kept its own.
  for (const C of [A, B]) {
    const d = await scopedModel(Department, C).find({}).lean();
    assert.deepEqual(d.map((x) => x.name).sort(), ["Civil", "Computer Science"]);
    assert.deepEqual((await scopedModel(Shift, C).find({}).sort({ order: 1 }).lean()).map((x) => x.name), ["Morning", "Day"]);
  }
  assert.equal(await Department.countDocuments({ collegeId: null }), 2);

  // Existing relationships preserved: every subject's department/shift exists in its college.
  assert.ok(await scopedModel(Department, A).findOne({ name: "Computer Science" }));

  // Now the same names are legal in both colleges, but still unique inside one.
  await scopedModel(Student, A).create({ studentId: "1", roll: "9", name: "Dup id other college? no: same college", department: "X", batch: "1", shift: "Morning", uploadedBy: A.admin._id }).then(
    () => assert.fail("same studentId in same college must be rejected"), (e) => assert.equal(e.code, 11000));
  await scopedModel(Student, B).create({ studentId: "1", roll: "1", name: "Same id, other college", department: "Computer Science", batch: "2024", shift: "Morning", uploadedBy: B.admin._id });

  const again = await migrateAcademicOwnership();
  assert.equal(again.changed, 0, JSON.stringify(again));
});

test("migration adds department/shift names that a college's subjects already use but its lists lack", async () => {
  const fakes = installFakeDb();
  const A = await makeCollege("Has Data");
  await scopedModel(Department, A).create({ name: "Computer Science" });
  await fakes.Subject.insertOne({ subjectName: "S", subjectCode: "Q-1", batch: "1", department: "Physics", shift: "Night", teacher: A.teacher._id.toString(), collegeId: A.collegeId });
  await migrateAcademicOwnership();
  assert.ok(await scopedModel(Department, A).findOne({ name: "Physics" }));
  assert.ok(await scopedModel(Shift, A).findOne({ name: "Night" }));
  assert.ok(await scopedModel(Department, A).findOne({ name: "Computer Science" }));
});

// ─── seeding ────────────────────────────────────────────────────────────────────

test("seedCollegeDefaults gives each college its own defaults, once", async () => {
  installFakeDb(); await buildSchemaIndexes();
  const r1 = await seedCollegeDefaults("COL-AAAAAAAAAA");
  assert.deepEqual(r1, { departments: DEFAULT_DEPARTMENTS.length, shifts: DEFAULT_SHIFTS.length });
  assert.deepEqual(await seedCollegeDefaults("COL-AAAAAAAAAA"), { departments: 0, shifts: 0 });
  await seedCollegeDefaults("COL-BBBBBBBBBB");
  assert.equal(await Department.countDocuments({ collegeId: "COL-AAAAAAAAAA" }), DEFAULT_DEPARTMENTS.length);
  assert.equal(await Department.countDocuments({ collegeId: "COL-BBBBBBBBBB" }), DEFAULT_DEPARTMENTS.length);
  assert.equal(await Shift.countDocuments(), DEFAULT_SHIFTS.length * 2);
});

test("start-up seeding fills colleges that have none, leaves customised ones alone, and creates no orphan rows in a multi-college DB", async () => {
  installFakeDb(); await buildSchemaIndexes();
  const A = await makeCollege("Seed A"); const B = await makeCollege("Seed B");
  await scopedModel(Department, A).create({ name: "Custom" });
  await seedAcademicDefaults();
  assert.deepEqual((await scopedModel(Department, A).find({}).lean()).map((d) => d.name), ["Custom"]);
  assert.equal(await scopedModel(Department, B).countDocuments(), DEFAULT_DEPARTMENTS.length);
  assert.equal(await scopedModel(Shift, A).countDocuments(), DEFAULT_SHIFTS.length);
  assert.equal(await Department.countDocuments({ collegeId: null }), 0);
});

test("college registration seeds the new college's defaults, and a seeding failure never undoes registration", async () => {
  const mkDeps = (seed) => {
    const created = [];
    return {
      created,
      deps: {
        College: { exists: async () => false, create: async ([c]) => { const d = { ...c, save: async () => {}, toPublicJSON() { return { collegeId: c.collegeId }; } }; created.push(d); return [d]; } },
        User: { exists: async () => false, create: async ([u]) => [{ ...u, _id: "u1", toPublicJSON() { return { name: u.name }; } }] },
        runInTransaction: async (fn) => fn(null), generateToken: () => "tok", buildTokenPayload: () => ({}),
        generateCollegeId: () => "COL-ZZZZZZZZZZ", seedCollegeDefaults: seed,
      },
    };
  };
  const body = { collegeName: "New College", country: "Bangladesh", district: "Feni", adminName: "Ad Min", adminEmail: "ad@min.com", password: "Passw0rd!x", confirmPassword: "Passw0rd!x" };
  const run = async (deps) => { const res = { code: 0, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } }; await createRegisterCollege(deps)({ body }, res, (e) => { throw e; }); return res; };

  const seeded = [];
  const ok = await run(mkDeps(async (id) => { seeded.push(id); }).deps);
  assert.equal(ok.code, 201, JSON.stringify(ok.body)); assert.deepEqual(seeded, ["COL-ZZZZZZZZZZ"]);

  const origErr = console.error; console.error = () => {};
  try { const failing = await run(mkDeps(async () => { throw new Error("boom"); }).deps); assert.equal(failing.code, 201); } finally { console.error = origErr; }
});

// ─── scoped-model helpers added for Part 9 ──────────────────────────────────────

test("scopedModel.distinct is limited to the tenant", async () => {
  installFakeDb(); await buildSchemaIndexes();
  await scopedModel(Shift, { collegeId: "COL-A" }).create({ name: "Morning" });
  await scopedModel(Shift, { collegeId: "COL-B" }).create({ name: "Night" });
  assert.deepEqual(await scopedModel(Shift, { collegeId: "COL-A" }).distinct("name"), ["Morning"]);
});

test("scopedModel.bulkWrite scopes every op, refuses inserts and collegeId updates", async () => {
  installFakeDb(); await buildSchemaIndexes();
  const A = scopedModel(Student, { collegeId: "COL-A" });
  const B = scopedModel(Student, { collegeId: "COL-B" });
  const up = (id, name) => ({ updateOne: { filter: { studentId: id, department: "D", batch: "1", shift: "M" }, update: { $set: { roll: "1", name, uploadedBy: oid() } }, upsert: true } });
  await A.bulkWrite([up("1", "a1")]); await B.bulkWrite([up("1", "b1")]);
  await A.bulkWrite([up("1", "a1-renamed")]);
  assert.equal(await Student.countDocuments(), 2);
  assert.equal((await B.findOne({ studentId: "1" })).name, "b1");
  assert.equal((await A.findOne({ studentId: "1" })).collegeId, "COL-A");
  assert.throws(() => A.bulkWrite([{ insertOne: { document: { studentId: "x" } } }]), TenantScopeError);
  assert.throws(() => A.bulkWrite([{ updateOne: { filter: {}, update: { $set: { collegeId: "COL-B" } } } }]), TenantScopeError);
});

test("collegeId cannot be changed through document.save() either (immutable)", async () => {
  installFakeDb(); await buildSchemaIndexes();
  const d = await scopedModel(Department, { collegeId: "COL-A" }).create({ name: "Immutable" });
  d.collegeId = "COL-B"; await d.save();
  assert.equal((await Department.findById(d._id).lean()).collegeId, "COL-A");
});
