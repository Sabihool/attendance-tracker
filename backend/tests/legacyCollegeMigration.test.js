/**
 * Part 20 — migration of the ORIGINAL single-college installation into a real college.
 *
 * The "database as it was before the multi-college upgrade": every row without a collegeId, global lists,
 * a legacy admin + teachers, attendance history with credit snapshots, an alert with a note, trashed sessions and a
 * few pre-existing orphans. After the migration the original college must own all of it, byte for byte (apart from
 * collegeId), and keep working through the real API.
 */
import test, { beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { installFakeDb, buildSchemaIndexes, mongoose } from "./helpers/mongooseFake.js";
import { models, startApp, makeCollege } from "./helpers/e2eApp.js";
import Notification from "../models/Notification.js";
import { migrateLegacyToCollege } from "../utils/legacyCollegeMigration.js";
import { migrateAcademicOwnership } from "../utils/academicBackfill.js";
import { migrateAttendanceOwnership } from "../utils/attendanceBackfill.js";
import { generateToken, buildTokenPayload } from "../utils/token.js";

const M = { ...models, Notification };
const DETAILS = { name: "Feni Computer Institute", country: "Bangladesh", district: "Feni" };
const oid = () => new mongoose.Types.ObjectId().toHexString();
const day = (d) => new Date(`2025-01-${String(d).padStart(2, "0")}T00:00:00.000Z`);

let fakes;
let app;
beforeEach(async () => {
  if (app) { await app.close(); app = null; }
  fakes = installFakeDb();
  await buildSchemaIndexes();
});
after(async () => { if (app) await app.close(); });

/** The pre-upgrade database. Returns the ids the assertions need. */
const legacyWorld = async () => {
  const { User, Student } = M;
  // NB: User.create hashes the password; no collegeId → null, exactly like an old account.
  const founder = await User.create({ name: "Old Admin", email: "admin@feni.example", password: "secret123", role: "admin", approved: true, approvalStatus: "approved" });
  const admin2 = await User.create({ name: "Second Admin", email: "admin2@feni.example", password: "secret123", role: "admin", approved: true, approvalStatus: "approved" });
  const teacher = await User.create({ name: "Old Teacher", email: "teacher@feni.example", password: "secret123", role: "teacher", approved: true, approvalStatus: "approved" });
  const pending = await User.create({ name: "Waiting Teacher", email: "wait@feni.example", password: "secret123", role: "teacher", approved: false, approvalStatus: "pending" });

  for (const [n, name] of [[1, "Rahim"], [2, "Karim"], [3, "Salma"]]) {
    await Student.create({ studentId: `S-${n}`, roll: String(n), name, department: "Computer Science and Technology", batch: "2024", shift: "Morning", uploadedBy: teacher._id });
  }
  const dept = (name) => fakes.Department.insertOne({ name });
  await dept("Computer Science and Technology"); await dept("Civil");
  await fakes.Shift.insertOne({ name: "Morning", order: 1 }); await fakes.Shift.insertOne({ name: "Day", order: 2 });
  for (const [name, credit, isDefault] of [["Theory", 1, true], ["Lab", 4, true], ["Workshop", 2, false]]) await fakes.AttendanceCategory.insertOne({ name, credit, isDefault });
  await fakes.Settings.insertOne({ consecutiveAbsenceLimit: 5 });

  const subject = (code, t) => fakes.Subject.insertOne({ subjectName: "Networks", subjectCode: code, batch: "2024", department: "Computer Science and Technology", shift: "Morning", teacher: t._id.toString(), color: "brand", isArchived: false }).then((r) => r.insertedId);
  const subA = await subject("CSE-101", teacher);
  const subB = await subject("CSE-102", admin2);
  const session = (subjectId, t, d, classType, classWeight, extra = {}) => fakes.Attendance.insertOne({
    subjectId, teacher: String(t._id), date: day(d), classType, classWeight,
    students: [["S-1", "present"], ["S-2", "absent"], ["S-3", "present"]].map(([studentId, status]) => ({ studentId, roll: studentId.slice(2), name: `N ${studentId}`, status })),
    summary: { totalStudents: 3, presentCount: 2, absentCount: 1 }, note: "kept", isDeleted: false, restoreHistory: [], ...extra,
  });
  await session(subA, teacher, 1, "Theory", 1);
  await session(subA, teacher, 2, "Lab", 4);
  await session(subA, teacher, 3, "Theory", 1, { isDeleted: true, deletedAt: day(20) });  // in the trash
  await session(subB, admin2, 4, "Theory", 1);
  await session(oid(), teacher, 5, "Theory", 1);                                          // PRE-EXISTING orphan (subject long gone)
  await fakes.ConsecutiveAbsenceAlert.insertOne({ studentId: "S-2", studentName: "Karim", studentRoll: "2", department: "CST", batch: "2024", subjectId: subA, teacherId: String(teacher._id), consecutiveMissCount: 4, note: "call the guardian", removed: false });
  await fakes.Notification.insertOne({ userId: String(founder._id), type: "teacher_request_new", title: "New", message: "m", read: false, collegeId: null });
  await fakes.ActivityLog.insertOne({ actorId: String(founder._id), action: "subject.create", collegeId: null, createdAt: day(6) });
  return { founder, admin2, teacher, pending, subA, subB };
};

const rows = (name) => structuredClone(fakes[name].docs);
const stripCollege = (d) => { const { collegeId: _c, ...r } = d; return r; }; // eslint-disable-line no-unused-vars
const ALL = ["User", "Student", "Subject", "Attendance", "ConsecutiveAbsenceAlert", "Notification", "ActivityLog", "Department", "Shift", "AttendanceCategory", "Settings"];

test("dry run reports what it would do and writes NOTHING (not even the college)", async () => {
  await legacyWorld();
  const before = Object.fromEntries(ALL.map((n) => [n, rows(n)]));
  const r = await migrateLegacyToCollege({ models: M, dryRun: true, college: DETAILS });
  assert.equal(r.dryRun, true);
  assert.equal(r.legacyBefore.User, 4); assert.equal(r.legacyBefore.Student, 3); assert.equal(r.legacyBefore.Subject, 2);
  assert.equal(r.legacyBefore.Attendance, 5); assert.equal(r.legacyBefore.ConsecutiveAbsenceAlert, 1);
  assert.equal(r.legacyBefore.Department, 2); assert.equal(r.legacyBefore.AttendanceCategory, 3); assert.equal(r.legacyBefore.Settings, 1);
  assert.equal(r.founder.email, "admin@feni.example", "oldest approved admin");
  assert.equal(r.relationshipsBefore.sessionsWithoutSubject, 1, "the pre-existing orphan is visible");
  assert.equal(await M.College.countDocuments({}), 0);
  for (const n of ALL) assert.deepEqual(rows(n), before[n], `${n} untouched`);
});

test("apply: every row moves to ONE new college, content is identical apart from collegeId, relationships are preserved", async () => {
  const w = await legacyWorld();
  const before = Object.fromEntries(ALL.map((n) => [n, rows(n)]));
  const r = await migrateLegacyToCollege({ models: M, dryRun: false, college: DETAILS });

  assert.equal(r.createdCollege, true);
  const cid = r.college.collegeId;
  assert.match(cid, /^COL-[2-9A-HJKMNP-TV-Z]{10}$/);
  const college = await M.College.findOne({ collegeId: cid }).lean();
  assert.equal(college.name, DETAILS.name); assert.equal(college.status, "active");
  assert.equal(String(college.createdBy), String(w.founder._id), "oldest approved admin is the protected founder");

  assert.deepEqual(r.stamped, { User: 4, Student: 3, Subject: 2, Attendance: 5, ConsecutiveAbsenceAlert: 1, Notification: 1, ActivityLog: 1, Department: 2, Shift: 2, AttendanceCategory: 3, Settings: 1 });
  assert.ok(Object.values(r.remaining).every((n) => n === 0), "nothing is left college-less");
  assert.equal(r.verification.identical, true);
  assert.equal(r.verification.relationshipsPreserved, true);
  assert.deepEqual(r.warnings, []);

  for (const n of ALL) {
    const after = rows(n);
    assert.equal(after.length, before[n].length, `${n}: no row added or removed`);
    before[n].forEach((b, i) => {
      assert.equal(after[i].collegeId, cid, `${n}[${i}] owned by the college`);
      assert.deepEqual(stripCollege(after[i]), stripCollege(b), `${n}[${i}] unchanged apart from collegeId (incl. updatedAt)`);
    });
  }
  // the things users care about, spelled out
  const lab = rows("Attendance").find((a) => a.classType === "Lab");
  assert.equal(lab.classWeight, 4, "credit snapshot kept");
  assert.equal(rows("Attendance").filter((a) => a.isDeleted).length, 1, "the trashed session is still in the trash");
  assert.equal(rows("ConsecutiveAbsenceAlert")[0].note, "call the guardian");
  assert.equal(rows("Settings")[0].consecutiveAbsenceLimit, 5);
  assert.equal(rows("Subject").every((s) => [String(w.teacher._id), String(w.admin2._id)].includes(String(s.teacher))), true, "subject → teacher links unchanged");
  assert.equal(r.verification.relationshipsAfter.sessionsWithoutSubject, 1, "the old orphan is still exactly one orphan — nothing new broke");
});

test("a second run is a no-op, and the start-up migrations change nothing further", async () => {
  await legacyWorld();
  await migrateLegacyToCollege({ models: M, dryRun: false, college: DETAILS });
  const snap = Object.fromEntries(ALL.map((n) => [n, rows(n)]));
  const again = await migrateLegacyToCollege({ models: M, dryRun: false, college: DETAILS });
  assert.equal(again.changed, 0);
  assert.match(again.warnings[0], /Nothing to migrate/);

  const a = await migrateAcademicOwnership(); const b = await migrateAttendanceOwnership();
  assert.equal(a.subjects + a.students + a.departments + a.shifts, 0, "academic follow-up: nothing to add");
  assert.equal(b.attendance + b.alerts + b.categories + b.settings, 0, "attendance follow-up: nothing to add");
  assert.deepEqual(b.unassigned, { attendance: 0, alerts: 0 });
  for (const n of ALL) assert.deepEqual(rows(n), snap[n], `${n} unchanged by the follow-ups`);
});

test("rows of OTHER colleges are never touched", async () => {
  const other = await makeCollege("Other Polytechnic", { seedDefaults: true });
  await legacyWorld();
  const snap = Object.fromEntries(ALL.map((n) => [n, rows(n).filter((d) => d.collegeId === other.collegeId)]));
  const collegeRow = rows("College").find((c) => c.collegeId === other.collegeId);
  await migrateLegacyToCollege({ models: M, dryRun: false, college: DETAILS });
  for (const n of ALL) assert.deepEqual(rows(n).filter((d) => d.collegeId === other.collegeId), snap[n], `${n} of the other college unchanged`);
  assert.deepEqual(rows("College").find((c) => c.collegeId === other.collegeId), collegeRow);
  assert.ok(await M.User.findById(other.admin._id));
});

test("refuses unsafe or incomplete input and changes nothing", async () => {
  await legacyWorld();
  const snap = Object.fromEntries(ALL.map((n) => [n, rows(n)]));
  await assert.rejects(migrateLegacyToCollege({ models: M, dryRun: false, college: { name: "X Y" } }), { code: "COLLEGE_DETAILS" });
  await assert.rejects(migrateLegacyToCollege({ models: M, dryRun: false, college: DETAILS, founderEmail: "wait@feni.example" }), { code: "BAD_FOUNDER" }, "a pending teacher cannot be the founder");
  await assert.rejects(migrateLegacyToCollege({ models: M, dryRun: false, collegeId: "nope" }), { code: "BAD_COLLEGE_ID" });
  await assert.rejects(migrateLegacyToCollege({ models: M, dryRun: false, collegeId: "COL-2222222222" }), { code: "COLLEGE_NOT_FOUND" });
  for (const n of ALL) assert.deepEqual(rows(n), snap[n], `${n} untouched after refusals`);
  // an already-registered college is never silently reused
  await migrateLegacyToCollege({ models: M, dryRun: false, college: DETAILS });
  await fakes.User.insertOne({ name: "Late", email: "late@feni.example", password: "x", role: "teacher", approved: true, collegeId: null });
  await assert.rejects(migrateLegacyToCollege({ models: M, dryRun: false, college: DETAILS }), { code: "COLLEGE_EXISTS" });
});

test("attach to an existing college: duplicate names are merged, a clashing student id aborts BEFORE anything is written", async () => {
  const target = await makeCollege("Fresh Registration", { seedDefaults: true }); // has default departments/shifts
  await legacyWorld();
  const r = await migrateLegacyToCollege({ models: M, dryRun: false, collegeId: target.collegeId });
  assert.equal(r.createdCollege, false);
  assert.equal(r.verification.relationshipsPreserved, true);
  assert.ok(r.merged.Department >= 1 || r.merged.Shift >= 1, "same-named lists are merged, not duplicated");
  const names = (await M.Department.find({ collegeId: target.collegeId }).lean()).map((d) => d.name);
  assert.equal(new Set(names.map((n) => n.toLowerCase())).size, names.length, "no duplicate department names");
  assert.equal(String((await M.College.findOne({ collegeId: target.collegeId }).lean()).createdBy), String(target.admin._id), "an existing founder is never replaced");

  // conflict case
  fakes = installFakeDb(); await buildSchemaIndexes();
  const t2 = await makeCollege("Has Student S-1", { seedDefaults: true });
  await M.Student.create({ studentId: "S-1", roll: "9", name: "Existing", department: "Computer Science and Technology", batch: "2023", shift: "Morning", uploadedBy: t2.admin._id, collegeId: t2.collegeId });
  await legacyWorld();
  const snap = Object.fromEntries(ALL.map((n) => [n, rows(n)]));
  await assert.rejects(migrateLegacyToCollege({ models: M, dryRun: false, collegeId: t2.collegeId }), { code: "STUDENT_ID_CONFLICT" });
  for (const n of ALL) assert.deepEqual(rows(n), snap[n], `${n} untouched after the conflict`);
});

test("end to end: after the migration the original teacher signs in, sees their subject and its history, exports a PDF; another college sees none of it", async () => {
  app = await startApp();          // startApp() resets the database, so build the world AFTER it
  fakes = app.fakes;
  const w = await legacyWorld();
  await migrateLegacyToCollege({ models: M, dryRun: false, college: DETAILS });
  const other = await makeCollege("Other Polytechnic", { seedDefaults: true });

  const login = await app.call(null, "POST", "/api/auth/login", { body: { email: "teacher@feni.example", password: "secret123" } });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  const tok = login.data.token ?? login.body.token;
  const subjects = await app.call(tok, "GET", "/api/subjects");
  assert.equal(subjects.status, 200);
  assert.ok(JSON.stringify(subjects.body).includes("CSE-101"));
  const att = await app.call(tok, "GET", `/api/attendance/${w.subA}`);
  assert.equal(att.status, 200);
  assert.ok(JSON.stringify(att.body).includes("S-2"));
  const pdf = await fetch(`${app.baseUrl}/api/export/${w.subA}/pdf`, { headers: { Authorization: `Bearer ${tok}` } });
  assert.equal(pdf.status, 200);
  assert.equal((await pdf.arrayBuffer()).byteLength > 500, true);

  // the founder is a real college admin now: can list teachers, approve the pending one, back up the college
  const adminTok = generateToken(buildTokenPayload(await M.User.findById(w.founder._id)));
  assert.equal((await app.call(adminTok, "GET", "/api/admin/teachers")).status, 200);
  const approve = await app.call(adminTok, "PATCH", `/api/admin/teacher-requests/${w.pending._id}/approve`);
  assert.equal(approve.status, 200, JSON.stringify(approve.body));
  assert.equal((await fetch(`${app.baseUrl}/api/admin/backups/college`, { headers: { Authorization: `Bearer ${adminTok}` } })).status, 200);
  const dirTxt = JSON.stringify((await app.call(adminTok, "GET", "/api/students/directory")).body);
  assert.ok(dirTxt.includes("Rahim"));

  // isolation: the other college sees nothing of the original one, and vice versa
  assert.ok(!JSON.stringify((await app.call(other.adminToken, "GET", "/api/subjects")).body).includes("CSE-101"));
  assert.ok(!JSON.stringify((await app.call(other.adminToken, "GET", "/api/students/directory")).body).includes("Rahim"));
  assert.equal((await app.call(other.adminToken, "GET", `/api/subjects/${w.subA}`)).status, 404);
  assert.equal((await app.call(other.adminToken, "GET", `/api/attendance/${w.subA}`)).status, 404);
  assert.ok(!JSON.stringify((await app.call(tok, "GET", "/api/subjects")).body).includes("Other Polytechnic"));
});

test("the verification is real: a migration that alters content (or breaks a link) is reported as FAILED", async () => {
  await legacyWorld();
  const realUpdateMany = M.Student.updateMany.bind(M.Student);
  M.Student.updateMany = (filter, update, opts) => realUpdateMany(filter, { $set: { ...update.$set, name: "TAMPERED" } }, opts);
  try {
    const r = await migrateLegacyToCollege({ models: M, dryRun: false, college: DETAILS });
    assert.equal(r.verification.identical, false);
    assert.equal(r.verification.perModel.Student.ok, false);
    assert.equal(r.verification.perModel.Subject.ok, true, "only the tampered collection fails");
    assert.ok(r.warnings.some((w) => /VERIFICATION FAILED/.test(w)));
  } finally { M.Student.updateMany = realUpdateMany; }
});
