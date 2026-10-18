/**
 * Part 12 — migration of pre-Part-12 attendance data, per-college seeding and
 * registration seeding. Existing attendance history, credit snapshots and
 * streaks must come out of the migration exactly as they went in (plus collegeId).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installFakeDb, mongoose } from "./helpers/mongooseFake.js";
import { models, makeCollege, startApp } from "./helpers/e2eApp.js";
import { migrateAttendanceOwnership, LEGACY_INDEXES_DROP_FIRST } from "../utils/attendanceBackfill.js";
import { seedCollegeCategories, seedAllCategories, DEFAULT_CATEGORIES } from "../services/categoryDefaults.js";
import { createRegisterCollege } from "../controllers/collegeController.js";
import { scopedModel } from "../utils/tenantScope.js";

const { Attendance, AttendanceCategory, ConsecutiveAbsenceAlert, Settings, Subject, College } = models;
const oid = () => new mongoose.Types.ObjectId().toHexString();
const strip = (d) => { const { collegeId: _c, ...rest } = d; return rest; }; // eslint-disable-line no-unused-vars

/** The database as Part 11 left it: global indexes, no collegeId on attendance/alerts/categories/settings. */
const legacyWorld = async () => {
  const fakes = installFakeDb();
  await fakes.AttendanceCategory.createIndex({ name: 1 }, { unique: true });
  await fakes.Attendance.createIndex({ subjectId: 1, date: 1, classType: 1, isDeleted: 1 }, { unique: true, partialFilterExpression: { isDeleted: false } });
  await fakes.ConsecutiveAbsenceAlert.createIndex({ studentId: 1, subjectId: 1, removed: 1 }, { unique: true, partialFilterExpression: { removed: false } });

  const A = await makeCollege("Legacy A");
  const B = await makeCollege("Legacy B");
  const subj = (code, teacher, collegeId) => fakes.Subject.insertOne({
    subjectName: "Networks", subjectCode: code, batch: "2024", department: "CST", shift: "Morning",
    teacher: teacher._id.toString(), collegeId, color: "brand", isArchived: false,
  }).then((r) => r.insertedId);
  const subA = await subj("A-1", A.teacher, A.collegeId);
  const subB = await subj("B-1", B.teacher, B.collegeId);
  const subNone = await subj("N-1", A.teacher, null); // college-less subject

  // legacy global categories (Lab customised to 4) and singleton settings (limit 5)
  for (const [name, credit] of [["Theory", 1], ["Lab", 4], ["Workshop", 2]]) await fakes.AttendanceCategory.insertOne({ name, credit, isDefault: name !== "Workshop" });
  await fakes.Settings.insertOne({ consecutiveAbsenceLimit: 5 });

  const att = (subjectId, teacher, day, classType, classWeight, statuses, extra = {}) => fakes.Attendance.insertOne({
    subjectId, teacher: teacher._id.toString(), date: new Date(`2025-01-${day}T00:00:00.000Z`), classType, classWeight,
    students: statuses.map(([studentId, status]) => ({ studentId, roll: "1", name: `N ${studentId}`, status })),
    summary: { totalStudents: statuses.length, presentCount: statuses.filter(([, s]) => s === "present").length, absentCount: statuses.filter(([, s]) => s === "absent").length },
    note: "", isDeleted: false, restoreHistory: [], ...extra,
  });
  await att(subA, A.teacher, "01", "Theory", 1, [["S-1", "present"], ["S-2", "absent"]]);
  await att(subA, A.teacher, "02", "Lab", 3, [["S-1", "absent"], ["S-2", "present"]]);
  await att(subA, A.teacher, "03", "Seminar", 2, [["S-1", "present"]], { isDeleted: true, deletedAt: new Date() }); // trashed, category not in legacy list
  await att(subB, B.teacher, "01", "Theory", 1, [["S-1", "absent"]]);
  await att(subNone, A.teacher, "04", "Theory", 1, [["S-9", "present"]]);
  await att(oid(), A.teacher, "05", "Theory", 1, [["S-9", "present"]]); // orphan: subject deleted
  await att(subB, A.teacher, "06", "Theory", 1, [["S-3", "present"]]); // teacher of another college (should be flagged, not changed)

  const alert = (subjectId, teacher) => fakes.ConsecutiveAbsenceAlert.insertOne({
    studentId: "S-1", studentName: "N", studentRoll: "1", department: "CST", batch: "2024", subjectId, teacherId: teacher._id.toString(),
    consecutiveMissCount: 4, note: "keep this note", removed: false,
  });
  await alert(subA, A.teacher);
  await alert(subB, B.teacher);
  return { fakes, A, B, subA, subB, subNone };
};

const snapshot = (fakes) => ({
  attendance: structuredClone(fakes.Attendance.docs),
  alerts: structuredClone(fakes.ConsecutiveAbsenceAlert.docs),
});

test("migration stamps sessions and alerts with their subject's college and changes nothing else", async () => {
  const { fakes, A, B, subA, subB } = await legacyWorld();
  const before = snapshot(fakes);
  const r = await migrateAttendanceOwnership();
  assert.equal(r.attendance, 5, "A: 3 (incl. trashed), B: 2 (one with a foreign teacher)");
  assert.equal(r.alerts, 2);
  assert.deepEqual(r.unassigned, { attendance: 2, alerts: 0 }, "college-less subject + orphan stay college-less");
  assert.equal(r.teacherMismatches, 1, "reported, not altered");

  const after = snapshot(fakes);
  assert.equal(after.attendance.length, before.attendance.length);
  for (const [i, b] of before.attendance.entries()) {
    const a = after.attendance[i];
    assert.deepEqual(strip(a), strip(b), `session ${i} must be identical apart from collegeId (history, weights, summary, notes, trash state)`);
  }
  for (const [i, b] of before.alerts.entries()) assert.deepEqual(strip(after.alerts[i]), strip(b), "alert counts and notes untouched");

  const col = (subjectId) => after.attendance.filter((d) => d.subjectId === subjectId).map((d) => d.collegeId);
  assert.deepEqual(new Set(col(subA)), new Set([A.collegeId]));
  assert.deepEqual(new Set(col(subB)), new Set([B.collegeId]));
  assert.equal(after.alerts.find((x) => x.subjectId === subA).collegeId, A.collegeId);
  assert.equal(after.alerts.find((x) => x.subjectId === subB).collegeId, B.collegeId);
  assert.equal(after.attendance.filter((d) => d.collegeId == null).length, 2);
});

test("every college receives the legacy categories with their configured credits; used names are added; credits on sessions untouched", async () => {
  const { A, B } = await legacyWorld();
  const r = await migrateAttendanceOwnership();
  for (const C of [A, B]) {
    const rows = await scopedModel(AttendanceCategory, { collegeId: C.collegeId }).find({}).sort({ name: 1 }).lean();
    const byName = Object.fromEntries(rows.map((c) => [c.name, c.credit]));
    assert.equal(byName.Lab, 4, "the customised Lab credit is preserved");
    assert.equal(byName.Theory, 1);
    assert.equal(byName.Workshop, 2);
    if (C === A) assert.equal(byName.Seminar, 1, "a name only A's (trashed) session uses is added, default credit 1");
    else assert.ok(!("Seminar" in byName));
  }
  assert.ok(r.categories >= 7);
  assert.equal(await AttendanceCategory.countDocuments({ collegeId: null }), 3, "legacy rows stay for college-less accounts");
  assert.deepEqual((await Attendance.find({ classType: "Lab" }))[0].classWeight, 3, "snapshot not re-weighted to the new 4");
});

test("every college keeps the streak limit it was living with (legacy singleton copied)", async () => {
  const { A, B } = await legacyWorld();
  const r = await migrateAttendanceOwnership();
  assert.equal(r.settings, 2);
  for (const C of [A, B]) assert.equal((await Settings.findOne({ collegeId: C.collegeId })).consecutiveAbsenceLimit, 5);
  assert.equal(await Settings.countDocuments({ collegeId: null }), 1);
});

test("the global unique category index is dropped and two colleges can then both use the same name", async () => {
  const { fakes, A, B } = await legacyWorld();
  assert.ok((await fakes.AttendanceCategory.indexes()).some((i) => i.name === "name_1"));
  // proves the drop is necessary: before migration a second college cannot have "Quiz"
  await fakes.AttendanceCategory.insertOne({ name: "Quiz", credit: 1 });
  await assert.rejects(() => fakes.AttendanceCategory.insertOne({ name: "Quiz", credit: 1, collegeId: A.collegeId }), (e) => e.code === 11000);
  const r = await migrateAttendanceOwnership();
  assert.equal(r.indexesDropped, 3, "the three legacy indexes that existed");
  const names = (await fakes.AttendanceCategory.indexes()).map((i) => i.name);
  for (const n of LEGACY_INDEXES_DROP_FIRST.attendancecategories) assert.ok(!names.includes(n));
  assert.ok(!names.includes("subjectId_1_date_1_classType_1_isDeleted_1"));
  assert.ok(!names.includes("studentId_1_subjectId_1_removed_1"));
  assert.ok(names.includes("collegeId_1_name_1"));
  // colleges A and B already got "Quiz" (it's a legacy category); each can now add the same new name
  await scopedModel(AttendanceCategory, { collegeId: A.collegeId }).create({ name: "Viva", credit: 1 });
  await scopedModel(AttendanceCategory, { collegeId: B.collegeId }).create({ name: "Viva", credit: 2 });
  await assert.rejects(() => scopedModel(AttendanceCategory, { collegeId: B.collegeId }).create({ name: "viva", credit: 2 }), (e) => e.code === 11000);
});

test("the migration is idempotent", async () => {
  await legacyWorld();
  const first = await migrateAttendanceOwnership();
  assert.ok(first.changed > 0);
  const second = await migrateAttendanceOwnership();
  assert.equal(second.changed, 0, JSON.stringify(second));
});

test("after migration the API shows the same history, percentages and credit numbers as before", async () => {
  const { fakes, A, subA } = await legacyWorld();
  await migrateAttendanceOwnership();
  // bring up the HTTP app on THIS database (startApp would reset it, so build the app by hand)
  const { buildApp } = await import("./helpers/e2eApp.js");
  const server = await new Promise((r) => { const s = buildApp().listen(0, "127.0.0.1", () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const origErr = console.error; console.error = () => {};
  try {
    const hit = async (token, path) => (await fetch(base + path, { headers: { Authorization: `Bearer ${token}` } })).json();
    const list = await hit(A.teacherToken, `/api/attendance/${subA}`);
    assert.equal(list.data.records.length, 2, "active sessions only (the trashed one stays in trash)");
    assert.equal(list.data.meta.totalWeightedClasses, 4);
    const pct = await hit(A.teacherToken, `/api/attendance/${subA}/percentage`);
    const by = Object.fromEntries(pct.data.studentStats.map((s) => [s.studentId, s]));
    assert.deepEqual([by["S-1"].attended, by["S-1"].total, by["S-1"].percentage], [1, 4, 25]);
    assert.deepEqual([by["S-2"].attended, by["S-2"].total, by["S-2"].percentage], [3, 4, 75]);
    const trash = await hit(A.teacherToken, `/api/trash/${subA}`);
    assert.equal(trash.data.records.length, 1);
    const cats = await hit(A.adminToken, "/api/attendance-categories");
    assert.ok(cats.data.categories.some((c) => c.name === "Lab" && c.credit === 4));
    assert.equal((await hit(A.adminToken, "/api/settings")).data.settings.consecutiveAbsenceLimit, 5);
    void fakes;
  } finally { console.error = origErr; await new Promise((r) => server.close(r)); }
});

test("seedCollegeCategories gives each college its own copy, once; seedAllCategories covers every active college", async () => {
  installFakeDb();
  assert.equal(await seedCollegeCategories("COL-AAAAAAAAAA"), DEFAULT_CATEGORIES.length);
  assert.equal(await seedCollegeCategories("COL-AAAAAAAAAA"), 0);
  await seedCollegeCategories("COL-BBBBBBBBBB");
  const a = await scopedModel(AttendanceCategory, { collegeId: "COL-AAAAAAAAAA" }).find({}).sort({ name: 1 }).lean();
  assert.deepEqual(a.map((c) => [c.name, c.credit, c.isDefault]), [["Lab", 3, true], ["Theory", 1, true], ["Tutorial", 2, true]]);
  assert.equal(await AttendanceCategory.countDocuments({}), 6);

  installFakeDb();
  await makeCollege("One"); await makeCollege("Two");
  await College.create({ collegeId: "COL-SUSPENDED1", name: "Sus", country: "Bangladesh", district: "Feni", dedupeKey: "sus|bd|feni", status: "suspended" });
  await seedAllCategories();
  await seedAllCategories(); // idempotent
  assert.equal(await AttendanceCategory.countDocuments({}), 6, "two active colleges only");
  assert.equal(await AttendanceCategory.countDocuments({ collegeId: null }), 0, "no orphan rows on a multi-college database");
});

test("college registration seeds the new college's categories; a seeding failure never undoes registration", async () => {
  const mk = (seedCats) => ({
    College: { exists: async () => false, create: async ([c]) => [{ ...c, save: async () => {}, toPublicJSON() { return { collegeId: c.collegeId }; } }] },
    User: { exists: async () => false, create: async ([u]) => [{ ...u, _id: "u1", toPublicJSON() { return { name: u.name }; } }] },
    runInTransaction: async (fn) => fn(null), generateToken: () => "tok", buildTokenPayload: () => ({}),
    generateCollegeId: () => "COL-ZZZZZZZZZZ", seedCollegeDefaults: async () => ({}), seedCollegeCategories: seedCats,
  });
  const body = { collegeName: "New College", country: "Bangladesh", district: "Feni", adminName: "Ad Min", adminEmail: "ad@min.com", password: "Passw0rd!x", confirmPassword: "Passw0rd!x" };
  const run = async (deps) => { const res = { code: 0, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } }; await createRegisterCollege(deps)({ body }, res, (e) => { throw e; }); return res; };
  const seen = [];
  assert.equal((await run(mk(async (id) => { seen.push(id); }))).code, 201);
  assert.deepEqual(seen, ["COL-ZZZZZZZZZZ"]);
  const origErr = console.error; console.error = () => {};
  try { assert.equal((await run(mk(async () => { throw new Error("db down"); }))).code, 201); } finally { console.error = origErr; }
});

test("a fresh install (no colleges, no users) still gets the default categories for the legacy scope", async () => {
  await startApp().then((a) => a.close());
  installFakeDb();
  await seedAllCategories();
  assert.equal(await AttendanceCategory.countDocuments({ collegeId: null }), 3);
  void Subject; void ConsecutiveAbsenceAlert; void Attendance;
});
