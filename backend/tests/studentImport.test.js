/**
 * Part 10 — student management and JSON imports are college-specific.
 *
 * Real routers/controllers/models over HTTP (multipart uploads included) on the
 * fake driver from helpers/mongooseFake.js. Two colleges are created that use
 * IDENTICAL department / batch / shift names, student ids and roll numbers.
 */
import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startApp, makeCollege, models, mongoose } from "./helpers/e2eApp.js";

// Uploaded files are written under process.cwd()/uploads — keep them out of the repo.
const origCwd = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "student-import-"));
before(() => process.chdir(tmp));
after(() => { process.chdir(origCwd); fs.rmSync(tmp, { recursive: true, force: true }); });

let app, call, upload, A, B;

beforeEach(async () => {
  fs.rmSync(path.join(tmp, "uploads"), { recursive: true, force: true }); // each test starts with an empty upload folder
  if (app) await app.close();
  app = await startApp();
  call = app.call;
  upload = app.upload;
  A = await makeCollege("Alpha Polytechnic");
  B = await makeCollege("Beta Polytechnic");
});
after(async () => { if (app) await app.close(); });

const post = (t, p, body) => call(t, "POST", p, { body });
const put = (t, p, body) => call(t, "PUT", p, { body });
const get = (t, p, query) => call(t, "GET", p, { query });
const del = (t, p, opts) => call(t, "DELETE", p, opts);

/** Every college gets the same structure: department "Computer Science", shifts Morning + Day. */
const structure = async (C, extraDepartments = []) => {
  for (const name of ["Computer Science", ...extraDepartments]) assert.equal((await post(C.adminToken, "/api/departments", { name })).status, 201);
  assert.equal((await post(C.adminToken, "/api/shifts", { name: "Morning", order: 1 })).status, 201);
  assert.equal((await post(C.adminToken, "/api/shifts", { name: "Day", order: 2 })).status, 201);
};

const file = (n = 3, prefix = "2024-") =>
  Array.from({ length: n }, (_, i) => ({ studentId: `${prefix}${String(i + 1).padStart(3, "0")}`, roll: String(i + 1), name: `Student ${i + 1}` }));

const FIELDS = { department: "Computer Science", batch: "2024", shift: "Morning" };
const send = (C, content, fields = {}, opts = {}) => upload(C.adminToken, "/api/students/upload", { fields: { ...FIELDS, ...fields }, content, ...opts });
const rows = (collegeId, filter = {}) => models.Student.find({ collegeId, ...filter }).lean();

// ═════════════════════════════════════════════════════════════════════════════
// The headline requirement: the same roll / registration numbers in two colleges
// ═════════════════════════════════════════════════════════════════════════════

test("identical student ids and roll numbers import into two different colleges", async () => {
  await structure(A);
  await structure(B);
  const content = file(3); // ids 2024-001..003, rolls 1..3 — the very same file for both

  const a = await send(A, content);
  const b = await send(B, content); // would be E11000 / 409 if ids or rolls were global
  assert.equal(a.status, 201, JSON.stringify(a.body));
  assert.equal(b.status, 201, JSON.stringify(b.body));
  assert.equal(a.data.inserted, 3);
  assert.equal(b.data.inserted, 3);

  const rowsA = await rows(A.collegeId);
  const rowsB = await rows(B.collegeId);
  assert.equal(rowsA.length, 3);
  assert.equal(rowsB.length, 3);
  assert.deepEqual(rowsA.map((r) => r.roll).sort(), ["1", "2", "3"]);
  assert.deepEqual(rowsB.map((r) => r.roll).sort(), ["1", "2", "3"]);
  // distinct documents, each stamped with its own college — nothing shared
  const ids = new Set([...rowsA, ...rowsB].map((r) => String(r._id)));
  assert.equal(ids.size, 6);
  assert.ok(rowsA.every((r) => r.collegeId === A.collegeId));
  assert.ok(rowsB.every((r) => r.collegeId === B.collegeId));

  // each admin sees exactly their own three
  const listA = await get(A.adminToken, "/api/students/admin");
  const listB = await get(B.adminToken, "/api/students/admin");
  assert.equal(listA.data.pagination.total, 3);
  assert.equal(listB.data.pagination.total, 3);
  assert.deepEqual(listA.data.students.map((s) => String(s._id)).sort(), rowsA.map((r) => String(r._id)).sort());
  // ...and a roll search is answered from the caller's college only
  const search = await get(A.adminToken, "/api/students/admin", { search: "2024-002" });
  assert.equal(search.data.pagination.total, 1);
  assert.equal(String(search.data.students[0]._id), String(rowsA.find((r) => r.studentId === "2024-002")._id));
});

test("the same roll can also be used in a different batch / shift of the same college, but not twice in one group", async () => {
  await structure(A);
  assert.equal((await send(A, file(2))).status, 201);
  assert.equal((await send(A, file(2, "2025-"), { batch: "2025" })).status, 201); // roll 1 again, other batch
  assert.equal((await send(A, file(2, "M-"), { shift: "Day" })).status, 201);     // roll 1 again, other shift
  const clash = await send(A, [{ studentId: "NEW-1", roll: "1", name: "Newcomer" }]);
  assert.equal(clash.status, 409);
  assert.equal(clash.body.details[0].code, "ROLL_IN_USE");
});

test("re-uploading the same file is idempotent (no duplicates, no errors)", async () => {
  await structure(A);
  assert.equal((await send(A, file(3))).data.inserted, 3);
  const again = await send(A, file(3));
  assert.equal(again.status, 201);
  assert.equal(again.data.inserted, 0);
  assert.equal(again.data.matched, 3);
  assert.equal((await rows(A.collegeId)).length, 3);
});

// ═════════════════════════════════════════════════════════════════════════════
// Academic structures must belong to the same college
// ═════════════════════════════════════════════════════════════════════════════

test("another college's department or shift is rejected, and its name is not leaked", async () => {
  await structure(A);
  await structure(B, ["Beta Only Dept"]);
  await post(B.adminToken, "/api/shifts", { name: "Evening", order: 3 });

  const dept = await send(A, file(2), { department: "Beta Only Dept" });
  assert.equal(dept.status, 400);
  assert.match(dept.body.message, /Invalid department "Beta Only Dept"\. Must be one of: Computer Science\./);
  assert.ok(!dept.body.message.includes("Evening"));

  const shift = await send(A, file(2), { shift: "Evening" });
  assert.equal(shift.status, 400);
  assert.match(shift.body.message, /Invalid shift "Evening"\. Must be one of: Morning, Day\./);

  assert.equal((await rows(A.collegeId)).length, 0);
  // the same request is fine in the college that owns them
  assert.equal((await send(B, file(2), { department: "Beta Only Dept", shift: "Evening" })).status, 201);
});

test("a college with no departments gets a clear message instead of a silent import", async () => {
  const r = await send(A, file(2));
  assert.equal(r.status, 400);
  assert.match(r.body.message, /no departments yet/);
});

test("department / shift are stored with the college's own spelling, so case variants never make a second group", async () => {
  await structure(A);
  const r = await send(A, file(2), { department: "computer SCIENCE", shift: "morning" });
  assert.equal(r.status, 201);
  assert.equal(r.data.department, "Computer Science");
  assert.equal(r.data.shift, "Morning");
  const again = await send(A, file(2)); // exact spelling
  assert.equal(again.data.inserted, 0);
  assert.equal((await rows(A.collegeId)).length, 2);
  const groups = (await get(A.teacherToken, "/api/students/groups")).data.groups;
  assert.deepEqual(groups, [{ department: "Computer Science", batch: "2024", shift: "Morning", count: 2 }]);
});

test("every imported student is stored with college, batch, department and shift", async () => {
  await structure(A);
  await send(A, file(1));
  const [s] = await rows(A.collegeId);
  assert.deepEqual(
    [s.collegeId, s.department, s.batch, s.shift, s.isActive],
    [A.collegeId, "Computer Science", "2024", "Morning", true]
  );
  assert.equal(String(s.uploadedBy), String(A.admin._id));
  assert.match(s.sourceFile, new RegExp(`^uploads/colleges/${A.collegeId.toLowerCase().replace(/[^a-z0-9_-]/g, "_")}/department/`));
});

test("a teacher can import too, and only into their own college; a client-supplied collegeId is ignored", async () => {
  await structure(A);
  await structure(B);
  const r = await upload(A.teacherToken, "/api/students/upload", { fields: { ...FIELDS, collegeId: B.collegeId, college: B.collegeId }, content: file(2) });
  assert.equal(r.status, 201);
  assert.equal((await rows(A.collegeId)).length, 2);
  assert.equal((await rows(B.collegeId)).length, 0);
});

test("uploads need a login", async () => {
  await structure(A);
  const r = await upload(null, "/api/students/upload", { fields: FIELDS, content: file(1) });
  assert.equal(r.status, 401);
});

// ═════════════════════════════════════════════════════════════════════════════
// Useful import errors
// ═════════════════════════════════════════════════════════════════════════════

test("validation reports every bad row with its index, field and a code — and saves nothing", async () => {
  await structure(A);
  const bad = [
    { studentId: "OK-1", roll: "1", name: "Fine Student" },
    { studentId: "", roll: "2", name: "No Id" },
    { studentId: "OK-3", name: "No Roll" },
    { studentId: "OK-1", roll: "4", name: "Same Id As Row 0" },
    { studentId: "OK-5", roll: "1", name: "Same Roll As Row 0" },
    { studentId: "OK-6", roll: "6", name: "X" },
    { studentId: "OK-7", roll: "7", name: "Fine", email: { not: "a string" } },
    "just a string",
    { studentId: ["array"], roll: "9", name: "Array Id" },
  ];
  const r = await send(A, bad);
  assert.equal(r.status, 422);
  assert.equal(r.body.success, false);
  assert.equal(r.body.totalErrors, r.body.details.length);
  const codes = r.body.details.map((d) => `${d.index}:${d.field}:${d.code}`);
  for (const expected of [
    "1:studentId:EMPTY_FIELD", "2:roll:MISSING_FIELD", "3:studentId:DUPLICATE_STUDENT_ID", "4:roll:DUPLICATE_ROLL",
    "5:name:TOO_SHORT", "6:email:WRONG_TYPE", "7:null:NOT_AN_OBJECT", "8:studentId:WRONG_TYPE",
  ]) assert.ok(codes.includes(expected), `missing ${expected} in ${codes.join(", ")}`);
  assert.ok(r.body.details.every((d) => d.row === d.index + 1));
  assert.match(r.body.errors[0], /^Student\[\d+\]: /);
  assert.ok(r.body.errors.some((e) => /already used by Student\[0\]/.test(e)));
  assert.equal((await rows(A.collegeId)).length, 0);
});

test("only the first 50 problems are listed, but the real total is reported", async () => {
  await structure(A);
  const r = await send(A, Array.from({ length: 80 }, () => ({ name: "Nobody" })));
  assert.equal(r.status, 422);
  assert.equal(r.body.totalErrors, 160); // studentId + roll missing on each of 80 rows
  assert.equal(r.body.details.length, 50);
  assert.match(r.body.errors.at(-1), /110 more problem\(s\) not listed \(160 in total\)/);
});

test("file-level problems: not JSON, wrong shape, empty, too many, no file, missing fields, wrong extension", async () => {
  await structure(A);
  const notJson = await send(A, "{ this is not json");
  assert.equal(notJson.status, 422);
  assert.match(notJson.body.message, /Could not parse JSON file/);

  assert.equal((await send(A, { students: "nope" })).body.details[0].code, "BAD_STRUCTURE");
  assert.equal((await send(A, [])).body.details[0].code, "EMPTY_LIST");
  assert.equal((await send(A, file(1001))).body.details[0].code, "TOO_MANY_STUDENTS");

  const noFile = await upload(A.adminToken, "/api/students/upload", { fields: FIELDS });
  assert.equal(noFile.status, 400);
  assert.match(noFile.body.message, /No file received/);

  const missing = await upload(A.adminToken, "/api/students/upload", { fields: { department: "Computer Science" }, content: file(1) });
  assert.equal(missing.status, 400);
  assert.match(missing.body.message, /batch, shift/);

  const wrongExt = await send(A, "x", {}, { filename: "students.csv", contentType: "text/csv" });
  assert.equal(wrongExt.status, 400);
  assert.equal((await rows(A.collegeId)).length, 0);
});

test("both accepted JSON shapes work, and a UTF-8 byte-order mark (Excel / Notepad) is tolerated", async () => {
  await structure(A);
  const wrapped = await send(A, { students: file(2) });
  assert.equal(wrapped.status, 201);
  const bom = await send(A, "\uFEFF" + JSON.stringify(file(3, "BOM-")), { batch: "2025" });
  assert.equal(bom.status, 201, JSON.stringify(bom.body));
  assert.equal(bom.data.inserted, 3);
});

test("numbers for studentId / roll are accepted and stored as strings; optional email / section are kept", async () => {
  await structure(A);
  const r = await send(A, [{ studentId: 2024001, roll: 7, name: "Numeric Ids", email: "N@Example.com", section: "A" }]);
  assert.equal(r.status, 201);
  const [s] = await rows(A.collegeId);
  assert.deepEqual([s.studentId, s.roll, s.email, s.section], ["2024001", "7", "n@example.com", "A"]);
});

// ═════════════════════════════════════════════════════════════════════════════
// Duplicates inside one college: rejected before anything is written
// ═════════════════════════════════════════════════════════════════════════════

test("a student id already active in another group of the same college is rejected — the whole file, not half of it", async () => {
  await structure(A);
  assert.equal((await send(A, file(2))).status, 201); // 2024-001, 2024-002 in batch 2024
  const next = [
    { studentId: "2025-001", roll: "1", name: "Brand New" },
    { studentId: "2024-002", roll: "2", name: "Already Elsewhere" },
    { studentId: "2025-003", roll: "3", name: "Also New" },
  ];
  const r = await send(A, next, { batch: "2025" });
  assert.equal(r.status, 409);
  assert.equal(r.body.totalErrors, 1);
  assert.deepEqual([r.body.details[0].index, r.body.details[0].studentId, r.body.details[0].code], [1, "2024-002", "STUDENT_ID_IN_USE"]);
  assert.match(r.body.details[0].message, /already registered to an active student in Computer Science \/ batch 2024 \/ Morning/);
  assert.match(r.body.message, /No students were saved/);
  assert.equal((await rows(A.collegeId)).length, 2, "valid rows of a rejected file must not be saved");
});

test("a roll already used by a different student of the group is rejected with who holds it", async () => {
  await structure(A);
  await send(A, file(2));
  const r = await send(A, [{ studentId: "LATE-1", roll: "2", name: "Late Joiner" }, { studentId: "LATE-2", roll: "9", name: "Fine One" }]);
  assert.equal(r.status, 409);
  assert.equal(r.body.details[0].code, "ROLL_IN_USE");
  assert.match(r.body.details[0].message, /roll "2" is already used by active student "2024-002" \(Student 2\)/);
  assert.equal((await rows(A.collegeId)).length, 2);
});

test("swapping / shifting rolls inside one upload is refused with an explanation (it cannot be applied safely)", async () => {
  await structure(A);
  await send(A, file(2));
  const r = await send(A, [
    { studentId: "2024-001", roll: "2", name: "Student 1" },
    { studentId: "2024-002", roll: "1", name: "Student 2" },
  ]);
  assert.equal(r.status, 409);
  assert.ok(r.body.details.every((d) => d.code === "ROLL_REASSIGNMENT"));
  assert.deepEqual((await rows(A.collegeId)).map((s) => `${s.studentId}:${s.roll}`).sort(), ["2024-001:1", "2024-002:2"]);
});

test("changing a student's own roll through a re-upload works; students missing from the file are left alone", async () => {
  await structure(A);
  await send(A, file(3));
  const r = await send(A, [{ studentId: "2024-001", roll: "10", name: "Student One Renamed" }]);
  assert.equal(r.status, 201);
  const byId = Object.fromEntries((await rows(A.collegeId)).map((s) => [s.studentId, s]));
  assert.deepEqual([byId["2024-001"].roll, byId["2024-001"].name], ["10", "Student One Renamed"]);
  assert.ok(byId["2024-002"].isActive && byId["2024-003"].isActive);
});

test("a removed student's id can be reissued elsewhere, and then blocks bringing the old batch back", async () => {
  await structure(A);
  await send(A, file(2));
  assert.equal((await del(A.adminToken, "/api/students/group", { body: { department: "Computer Science", batch: "2024", shift: "Morning" } })).status, 200);

  const reissue = await send(A, file(2), { batch: "2025" }); // same ids, removed earlier → allowed
  assert.equal(reissue.status, 201, JSON.stringify(reissue.body));

  const comeBack = await send(A, file(2)); // batch 2024 again → ids now active in 2025
  assert.equal(comeBack.status, 409);
  assert.ok(comeBack.body.details.every((d) => d.code === "STUDENT_ID_IN_USE"));
});

// ═════════════════════════════════════════════════════════════════════════════
// Batch deletion
// ═════════════════════════════════════════════════════════════════════════════

test("batch deletion stays a soft delete, touches only this college, keeps attendance, and a re-upload brings the batch back", async () => {
  await structure(A);
  await structure(B);
  await send(A, file(3));
  await send(B, file(3));
  const sub = await post(A.teacherToken, "/api/subjects", { subjectName: "Networks", subjectCode: "CSE-101", batch: "2024", department: "Computer Science", shift: "Morning" });
  assert.equal(sub.status, 201, JSON.stringify(sub.body));
  await models.Attendance.create({
    collegeId: A.collegeId, subjectId: sub.data.subject._id, teacher: A.teacher._id, date: new Date("2026-01-05"), classType: "Theory",
    students: [{ studentId: "2024-001", roll: "1", name: "Student 1", status: "present" }],
  }).catch((e) => assert.fail(`attendance fixture: ${e.message}`));

  const del1 = await del(A.adminToken, "/api/students/group", { body: { department: "Computer Science", batch: "2024", shift: "Morning" } });
  assert.equal(del1.data.deactivated, 3);
  assert.equal((await rows(A.collegeId, { isActive: true })).length, 0);
  assert.equal((await rows(A.collegeId)).length, 3, "soft delete: documents remain");
  assert.equal((await rows(B.collegeId, { isActive: true })).length, 3, "other college untouched");
  assert.equal(await models.Attendance.countDocuments({}), 1, "attendance history is not removed");

  const back = await send(A, file(3));
  assert.equal(back.status, 201);
  assert.equal(back.data.reactivated, 3);
  assert.equal(back.data.inserted, 0);
  assert.equal((await rows(A.collegeId)).length, 3, "reactivated, not duplicated");
  assert.equal((await rows(A.collegeId, { isActive: true })).length, 3);
});

// ═════════════════════════════════════════════════════════════════════════════
// Manual create / edit / delete (the Manage Students form)
// ═════════════════════════════════════════════════════════════════════════════

const manual = (over = {}) => ({ studentId: "M-1", roll: "1", name: "Manual Student", department: "Computer Science", batch: "2024", shift: "Morning", ...over });

test("manual create: same id and roll in two colleges are fine; duplicates inside one college give a specific 409", async () => {
  await structure(A);
  await structure(B);
  assert.equal((await post(A.adminToken, "/api/students/admin", manual())).status, 201);
  assert.equal((await post(B.adminToken, "/api/students/admin", manual())).status, 201);

  const dupId = await post(A.adminToken, "/api/students/admin", manual({ roll: "5", batch: "2030" }));
  assert.equal(dupId.status, 409);
  assert.match(dupId.body.message, /Registration Number "M-1" is already registered to another active student in this college/);

  const dupRoll = await post(A.adminToken, "/api/students/admin", manual({ studentId: "M-2" }));
  assert.equal(dupRoll.status, 409);
  assert.match(dupRoll.body.message, /Roll Number "1" is already used by another active student in Computer Science \/ batch 2024 \/ Morning/);
});

test("manual create: a removed student's registration number in the SAME group explains how to restore it (other groups can reuse it)", async () => {
  await structure(A);
  const first = (await post(A.adminToken, "/api/students/admin", manual())).data.student;
  await del(A.adminToken, `/api/students/admin/${first._id}`);
  const same = await post(A.adminToken, "/api/students/admin", manual({ roll: "8" }));
  assert.equal(same.status, 409);
  assert.match(same.body.message, /removed student with Registration Number "M-1" already exists in Computer Science \/ batch 2024 \/ Morning\. Restore that student/);
  assert.equal((await post(A.adminToken, "/api/students/admin", manual({ batch: "2031" }))).status, 201);
  assert.equal((await put(A.adminToken, `/api/students/admin/${first._id}`, { isActive: true })).status, 409, "restoring now clashes with the reissued number");
});

test("manual create: the department must be one of the caller's college; its own spelling is stored", async () => {
  await structure(A);
  await structure(B, ["Beta Only Dept"]);
  const foreign = await post(A.adminToken, "/api/students/admin", manual({ department: "Beta Only Dept" }));
  assert.equal(foreign.status, 400);
  assert.match(foreign.body.message, /Invalid department "Beta Only Dept"/);

  const ok = await post(A.adminToken, "/api/students/admin", manual({ department: "computer science", shift: "MORNING" }));
  assert.equal(ok.status, 201);
  assert.deepEqual([ok.data.student.department, ok.data.student.shift], ["Computer Science", "Morning"]);
});

test("a college admin cannot edit or delete another college's student by guessing / manipulating the id", async () => {
  await structure(A);
  await structure(B);
  const mine = (await post(A.adminToken, "/api/students/admin", manual())).data.student;
  const theirs = (await post(B.adminToken, "/api/students/admin", manual({ name: "Beta Student" }))).data.student;
  const before = await models.Student.findById(theirs._id).lean();

  assert.equal((await put(A.adminToken, `/api/students/admin/${theirs._id}`, { name: "Hacked", roll: "99" })).status, 404);
  assert.equal((await put(A.adminToken, `/api/students/admin/${theirs._id}`, { isActive: false, collegeId: A.collegeId })).status, 404);
  assert.equal((await del(A.adminToken, `/api/students/admin/${theirs._id}`)).status, 404);
  assert.equal((await del(A.adminToken, `/api/students/admin/${theirs._id}`, { query: { hard: "true" } })).status, 404);
  assert.equal((await put(A.adminToken, "/api/students/admin/not-an-id", { name: "Nope" })).status, 404);
  assert.deepEqual(await models.Student.findById(theirs._id).lean(), before, "the other college's student is byte-for-byte unchanged");

  // an unknown-but-valid id is indistinguishable from the other college's
  assert.equal((await del(A.adminToken, `/api/students/admin/${new mongoose.Types.ObjectId()}`)).status, 404);

  // the owner can, of course
  assert.equal((await put(B.adminToken, `/api/students/admin/${theirs._id}`, { name: "Beta Renamed" })).status, 200);
  // a teacher is not an admin at all
  assert.equal((await put(A.teacherToken, `/api/students/admin/${mine._id}`, { name: "T" })).status, 403);
  assert.equal((await del(A.teacherToken, `/api/students/admin/${mine._id}`)).status, 403);
});

test("a body collegeId on edit / create cannot move a student between colleges", async () => {
  await structure(A);
  await structure(B);
  const created = await post(A.adminToken, "/api/students/admin", { ...manual(), collegeId: B.collegeId });
  assert.equal(created.status, 201);
  assert.equal((await models.Student.findById(created.data.student._id).lean()).collegeId, A.collegeId);
  const edited = await put(A.adminToken, `/api/students/admin/${created.data.student._id}`, { name: "Still Alpha", collegeId: B.collegeId });
  assert.equal(edited.status, 200);
  assert.equal((await models.Student.findById(created.data.student._id).lean()).collegeId, A.collegeId);
});

test("edit: moving to another department needs a department of the same college; resending the current one is fine", async () => {
  await structure(A, ["Civil"]);
  await structure(B, ["Beta Only Dept"]);
  const s = (await post(A.adminToken, "/api/students/admin", manual())).data.student;
  assert.equal((await put(A.adminToken, `/api/students/admin/${s._id}`, { department: "Beta Only Dept" })).status, 400);
  assert.equal((await put(A.adminToken, `/api/students/admin/${s._id}`, { department: "Computer Science", name: "Same Dept" })).status, 200);
  const moved = await put(A.adminToken, `/api/students/admin/${s._id}`, { department: "civil" });
  assert.equal(moved.status, 200);
  assert.equal(moved.data.student.department, "Civil");
});

test("edit: duplicates are blocked inside the college only, including when moving group or bringing a removed student back", async () => {
  await structure(A);
  await structure(B);
  const s1 = (await post(A.adminToken, "/api/students/admin", manual({ studentId: "E-1", roll: "1" }))).data.student;
  const s2 = (await post(A.adminToken, "/api/students/admin", manual({ studentId: "E-2", roll: "2" }))).data.student;
  await post(B.adminToken, "/api/students/admin", manual({ studentId: "E-9", roll: "9" }));

  assert.equal((await put(A.adminToken, `/api/students/admin/${s2._id}`, { studentId: "E-1" })).status, 409);
  assert.equal((await put(A.adminToken, `/api/students/admin/${s2._id}`, { roll: "1" })).status, 409);
  assert.equal((await put(A.adminToken, `/api/students/admin/${s2._id}`, { studentId: "E-9", roll: "9" })).status, 200, "ids held only by ANOTHER college are free");
  assert.equal((await put(A.adminToken, `/api/students/admin/${s2._id}`, { roll: "1", shift: "Day" })).status, 200, "same roll, other shift");
  assert.equal((await put(A.adminToken, `/api/students/admin/${s2._id}`, { shift: "Morning" })).status, 409, "moving back into the group where roll 1 is taken");

  // remove s1, reissue its registration number, then try to bring it back
  assert.equal((await del(A.adminToken, `/api/students/admin/${s1._id}`)).status, 200);
  assert.equal((await post(A.adminToken, "/api/students/admin", manual({ studentId: "E-1", roll: "7", name: "Reissued", batch: "2030" }))).status, 201);
  assert.equal((await put(A.adminToken, `/api/students/admin/${s1._id}`, { isActive: true })).status, 409);
  // ...but fixing a typo on the REMOVED student is not blocked by the reissue
  assert.equal((await put(A.adminToken, `/api/students/admin/${s1._id}`, { name: "Fixed Name" })).status, 200);
});

test("delete: soft by default (hidden from lists, kept in the database), hard on request, both scoped", async () => {
  await structure(A);
  const s = (await post(A.adminToken, "/api/students/admin", manual())).data.student;
  assert.equal((await del(A.adminToken, `/api/students/admin/${s._id}`)).status, 200);
  assert.equal((await get(A.adminToken, "/api/students/admin")).data.pagination.total, 0);
  assert.equal((await get(A.adminToken, "/api/students/admin", { includeInactive: "true" })).data.pagination.total, 1);
  assert.equal((await del(A.adminToken, `/api/students/admin/${s._id}`, { query: { hard: "true" } })).status, 200);
  assert.equal(await models.Student.countDocuments({}), 0);
});

test("reading: list, search, group lookups and the directory never show the other college's identical students", async () => {
  await structure(A);
  await structure(B);
  await send(A, file(3));
  await send(B, file(3));
  await post(B.adminToken, "/api/students/admin", manual({ studentId: "B-ONLY", roll: "50", name: "Zed Beta" }));

  assert.equal((await get(A.adminToken, "/api/students/admin", { search: "Zed" })).data.pagination.total, 0);
  assert.equal((await get(B.adminToken, "/api/students/admin", { search: "Zed" })).data.pagination.total, 1);
  assert.equal((await get(A.teacherToken, "/api/students", { department: "Computer Science", batch: "2024", shift: "Morning" })).data.count, 3);
  assert.equal((await get(B.teacherToken, "/api/students", { department: "Computer Science", batch: "2024", shift: "Morning" })).data.count, 4);
  assert.equal((await get(A.adminToken, "/api/students/directory", { search: "2024-001" })).data.pagination.total, 1);
  assert.deepEqual((await get(A.adminToken, "/api/students/batches")).data.batches, ["2024"]);
  // operator injection through the query string is not a filter
  const inj = await call(A.adminToken, "GET", "/api/students/admin?search[$ne]=x&department[$ne]=x");
  assert.equal(inj.status, 200);
  assert.equal(inj.data.pagination.total, 3);
});

// ═════════════════════════════════════════════════════════════════════════════
// Transactions and partial failure
// ═════════════════════════════════════════════════════════════════════════════

/** Make the Student collection apply the first `applied` operations of a bulkWrite and then fail with a duplicate-key error. */
const failBulkWriteAfter = (fakes, applied) => {
  const original = fakes.Student.bulkWrite.bind(fakes.Student);
  fakes.Student.bulkWrite = async (ops, options) => {
    if (ops.length > applied) {
      await original(ops.slice(0, applied), options);
      const err = Object.assign(new Error("E11000 duplicate key error (simulated concurrent insert)"), { name: "MongoBulkWriteError", code: 11000 });
      err.writeErrors = [{ code: 11000, index: applied, err: { index: applied, code: 11000 } }];
      throw err;
    }
    return original(ops, options);
  };
  return () => { fakes.Student.bulkWrite = original; };
};

test("a write that fails half-way rolls the WHOLE file back and leaves no file on disk", async () => {
  await structure(A);
  const restore = failBulkWriteAfter(app.fakes, 2);
  const r = await send(A, file(5));
  restore();
  assert.equal(r.status, 409);
  assert.match(r.body.message, /clashed with data saved at the same time\. No students were saved\./);
  assert.equal((await rows(A.collegeId)).length, 0, "nothing from the failed import may remain");
  const dir = path.join(tmp, "uploads");
  const leftovers = fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).filter((f) => String(f).endsWith(".json")) : [];
  assert.deepEqual(leftovers, [], "the uploaded file of a failed import is discarded");

  // and the very same upload succeeds once the clash is gone
  assert.equal((await send(A, file(5))).status, 201);
  assert.equal((await rows(A.collegeId)).length, 5);
});

test("an unexpected database error is a 500 that says whether anything was saved", async () => {
  await structure(A);
  const original = app.fakes.Student.bulkWrite.bind(app.fakes.Student);
  app.fakes.Student.bulkWrite = async (ops) => { await original(ops.slice(0, 1)); throw new Error("connection reset"); };
  const r = await send(A, file(3));
  app.fakes.Student.bulkWrite = original;
  assert.equal(r.status, 500);
  assert.match(r.body.message, /Database error while saving students\. No students were saved\./);
  assert.equal((await rows(A.collegeId)).length, 0);
});

test("without MongoDB transaction support the import still rejects known conflicts first, and is honest + repeatable after a partial failure", async () => {
  await structure(A);
  // A standalone mongod: withTransaction is refused, runInTransaction falls back to running the steps directly.
  const original = mongoose.startSession;
  mongoose.startSession = async () => ({
    withTransaction: async () => { throw Object.assign(new Error("Transaction numbers are only allowed on a replica set member or mongos"), { code: 20 }); },
    endSession: async () => {},
  });
  try {
    // known conflicts: rejected before the first write even without a transaction
    await send(A, file(2));
    const conflict = await send(A, [{ studentId: "N-1", roll: "5", name: "New One" }, { studentId: "2024-002", roll: "2", name: "Renamed" }, { studentId: "N-3", roll: "1", name: "Roll Taken" }], { batch: "2030" });
    assert.equal(conflict.status, 409);
    assert.equal((await rows(A.collegeId)).length, 2);

    // a REAL duplicate-key failure half-way (someone registers P-003 elsewhere in the college after the
    // check ran): the other rows are saved — there is no transaction — and the message says so.
    const original = app.fakes.Student.bulkWrite.bind(app.fakes.Student);
    app.fakes.Student.bulkWrite = async (ops, options) => {
      await app.fakes.Student.insertOne({
        _id: new mongoose.Types.ObjectId().toHexString(), collegeId: A.collegeId, studentId: "P-003", roll: "77", name: "Concurrent",
        department: "Computer Science", batch: "2040", shift: "Day", isActive: true, uploadedBy: String(A.admin._id),
      });
      return original(ops, options);
    };
    const partial = await send(A, file(5, "P-"), { batch: "2031" });
    app.fakes.Student.bulkWrite = original;
    assert.equal(partial.status, 409);
    assert.match(partial.body.message, /Some students may already have been saved; uploading the same file again is safe/);
    assert.equal((await rows(A.collegeId, { batch: "2031" })).length, 4); // everything except the clashing P-003

    // P-003 is now genuinely registered elsewhere, so the retry names it precisely and changes nothing
    const retry = await send(A, file(5, "P-"), { batch: "2031" });
    assert.equal(retry.status, 409);
    assert.deepEqual(retry.body.details.map((d) => [d.studentId, d.code]), [["P-003", "STUDENT_ID_IN_USE"]]);
    // without the clashing row the same file completes, with no duplicates
    const noClash = await send(A, file(5, "P-").filter((r) => r.studentId !== "P-003"), { batch: "2031" });
    assert.equal(noClash.status, 201);
    assert.equal(noClash.data.inserted, 0);
    assert.equal((await rows(A.collegeId, { batch: "2031" })).length, 4);
  } finally {
    mongoose.startSession = original;
  }
});

test("the database itself still refuses duplicates if the pre-check is ever bypassed (per-college unique indexes)", async () => {
  await structure(A);
  await structure(B);
  const base = { name: "Direct Insert", department: "Computer Science", batch: "2024", shift: "Morning", uploadedBy: A.admin._id };
  await models.Student.create({ ...base, collegeId: A.collegeId, studentId: "D-1", roll: "1" });
  await models.Student.create({ ...base, collegeId: B.collegeId, studentId: "D-1", roll: "1" }); // other college: allowed
  await assert.rejects(models.Student.create({ ...base, collegeId: A.collegeId, studentId: "D-1", roll: "2" }), (e) => e.code === 11000);
  await assert.rejects(models.Student.create({ ...base, collegeId: A.collegeId, studentId: "D-2", roll: "1" }), (e) => e.code === 11000);
  await models.Student.create({ ...base, collegeId: A.collegeId, studentId: "D-3", roll: "1", isActive: false }); // removed students hold nothing
});
