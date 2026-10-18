/**
 * Part 9 — departments, batches (and the classes formed from department +
 * batch + shift) are isolated per college.
 *
 * Everything here runs the real routers/controllers/models over HTTP. Two
 * colleges are created that deliberately use IDENTICAL department names, batch
 * numbers, shifts, student ids, subject codes and rolls.
 */
import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { startApp, makeCollege, models } from "./helpers/e2eApp.js";

let app, call, A, B;

beforeEach(async () => {
  if (app) await app.close();
  app = await startApp();
  call = app.call;
  A = await makeCollege("Alpha Polytechnic");
  B = await makeCollege("Beta Polytechnic");
});
after(async () => { if (app) await app.close(); });

const post = (t, p, body) => call(t, "POST", p, { body });
const get = (t, p, query) => call(t, "GET", p, { query });

/** Give a college the full shared fixture: same names everywhere. */
const populate = async (C) => {
  assert.equal((await post(C.adminToken, "/api/departments", { name: "Computer Science" })).status, 201);
  assert.equal((await post(C.adminToken, "/api/shifts", { name: "Morning", order: 1 })).status, 201);
  assert.equal((await post(C.adminToken, "/api/shifts", { name: "Day", order: 2 })).status, 201);
  const sub = await post(C.teacherToken, "/api/subjects", { subjectName: "Networks", subjectCode: "CSE-101", batch: "2024", department: "Computer Science", shift: "Morning" });
  assert.equal(sub.status, 201, JSON.stringify(sub.body));
  for (const [id, roll] of [["S-001", "1"], ["S-002", "2"]]) {
    const s = await post(C.adminToken, "/api/students/admin", { studentId: id, roll, name: `Student ${id}`, department: "Computer Science", batch: "2024", shift: "Morning" });
    assert.equal(s.status, 201, JSON.stringify(s.body));
  }
  return sub.data.subject;
};

// ─── identical names are allowed in different colleges ───────────────────────

test("two colleges can both create the same department, shift, student ids, roll numbers and subject codes", async () => {
  await populate(A);
  await populate(B); // would 409 / E11000 under the old global indexes
  const a = await get(A.adminToken, "/api/departments");
  const b = await get(B.adminToken, "/api/departments");
  assert.deepEqual(a.data.departments, ["Computer Science"]);
  assert.deepEqual(b.data.departments, ["Computer Science"]);
  assert.notEqual(a.data.full[0]._id, b.data.full[0]._id);
});

test("inside one college the old rules are unchanged: duplicate department / shift (any case) → 409", async () => {
  await populate(A);
  assert.equal((await post(A.adminToken, "/api/departments", { name: "computer science" })).status, 409);
  assert.equal((await post(A.adminToken, "/api/shifts", { name: "MORNING" })).status, 409);
  const dupStudent = await post(A.adminToken, "/api/students/admin", { studentId: "S-001", roll: "99", name: "Dup", department: "Computer Science", batch: "2025", shift: "Day" });
  assert.equal(dupStudent.status, 409);
  const dupRoll = await post(A.adminToken, "/api/students/admin", { studentId: "S-777", roll: "1", name: "Dup", department: "Computer Science", batch: "2024", shift: "Morning" });
  assert.equal(dupRoll.status, 409);
  const dupSubject = await post(A.teacherToken, "/api/subjects", { subjectName: "Other", subjectCode: "cse-101", batch: "2024", department: "Computer Science", shift: "Morning" });
  assert.equal(dupSubject.status, 409);
});

// ─── reads / lists / search ───────────────────────────────────────────────────

test("lists, batches, groups, student search and directory only show the caller's college", async () => {
  await populate(A);
  await populate(B);
  // Beta gets an extra batch + department that Alpha must never see.
  await post(B.adminToken, "/api/departments", { name: "Beta Only Dept" });
  await post(B.adminToken, "/api/students/admin", { studentId: "B-1", roll: "5", name: "Beta Extra", department: "Computer Science", batch: "2099", shift: "Day" });

  assert.deepEqual((await get(A.adminToken, "/api/students/batches")).data.batches, ["2024"]);
  assert.deepEqual((await get(B.adminToken, "/api/students/batches")).data.batches, ["2024", "2099"]);
  assert.deepEqual((await get(A.adminToken, "/api/departments")).data.departments, ["Computer Science"]);

  const groupsA = (await get(A.teacherToken, "/api/students/groups")).data.groups;
  assert.deepEqual(groupsA, [{ department: "Computer Science", batch: "2024", shift: "Morning", count: 2 }]);

  const listA = await get(A.adminToken, "/api/students/admin", { search: "Beta" });
  assert.equal(listA.data.pagination.total, 0);
  const dirA = await get(A.adminToken, "/api/students/directory");
  assert.equal(dirA.data.pagination.total, 2);
  const dirB = await get(B.adminToken, "/api/students/directory");
  assert.equal(dirB.data.pagination.total, 3);

  const byGroup = await get(A.teacherToken, "/api/students", { department: "Computer Science", batch: "2099" });
  assert.equal(byGroup.data.count, 0);
});

test("subject listing, meta and analytics are per college", async () => {
  await populate(A);
  await populate(B);
  const bSub = await post(B.teacherToken, "/api/subjects", { subjectName: "Databases", subjectCode: "CSE-202", batch: "2025", department: "Computer Science", shift: "Day" });
  assert.equal(bSub.status, 201);

  const subsA = await get(A.adminToken, "/api/subjects");
  assert.deepEqual(subsA.data.subjects.map((s) => s.subjectCode), ["CSE-101"]);
  const subsB = await get(B.adminToken, "/api/subjects");
  assert.equal(subsB.data.count, 2);

  const meta = await get(A.teacherToken, "/api/subjects/meta");
  assert.deepEqual(meta.data.departments, ["Computer Science"]);
  assert.deepEqual(meta.data.shifts, ["Morning", "Day"]);

  const an = await get(A.adminToken, "/api/admin/subjects");
  assert.equal(an.data.pagination.total, 1);
  assert.equal(an.data.subjects[0].totalStudents, 2); // not 2 + Beta's 2
  assert.deepEqual((await get(A.adminToken, "/api/admin/subjects/meta")).data.batches, ["2024"]);
});

// ─── counts / dashboards ──────────────────────────────────────────────────────

test("academic structure tree and summary count only the current college (same names in both)", async () => {
  await populate(A);
  await populate(B);
  await post(B.adminToken, "/api/students/admin", { studentId: "B-9", roll: "9", name: "Beta Nine", department: "Computer Science", batch: "2024", shift: "Morning" });

  const sumA = (await get(A.adminToken, "/api/admin/academic-structure/summary")).data;
  const sumB = (await get(B.adminToken, "/api/admin/academic-structure/summary")).data;
  assert.equal(sumA.totalStudents, 2);
  assert.equal(sumB.totalStudents, 3);
  assert.equal(sumA.totalSubjects, 1);
  assert.equal(sumA.totalTeachersAssigned, 1);
  assert.equal(sumA.totalDepartments, 1);
  assert.equal(sumA.totalBatches, 1);

  const treeA = (await get(A.adminToken, "/api/admin/academic-structure")).data.departments;
  assert.equal(treeA.length, 1);
  const leaf = treeA[0].batches[0].shifts[0];
  assert.deepEqual([leaf.shift, leaf.totalStudents, leaf.totalSubjects, leaf.totalTeachers], ["Morning", 2, 1, 1]);
  assert.deepEqual(leaf.teachers.map((t) => t.name), ["Alpha Polytechnic teacher"]);
});

test("teacher performance lists only the college's teachers, with only its own student counts", async () => {
  await populate(A);
  await populate(B);
  const rows = (await get(A.adminToken, "/api/admin/teacher-performance")).data;
  const list = rows.teachers || rows.rows || rows.items || Object.values(rows).find(Array.isArray);
  assert.ok(Array.isArray(list), JSON.stringify(rows).slice(0, 200));
  assert.equal(list.length, 1);
  assert.equal(list[0].totalStudentsManaged, 2);
  assert.equal(list[0].name, "Alpha Polytechnic teacher");
});

// ─── writes cannot cross colleges ─────────────────────────────────────────────

test("another college's department / shift / student / subject ids answer 404 (read, update, delete)", async () => {
  await populate(B);
  const dept = (await get(B.adminToken, "/api/departments")).data.full[0];
  const shift = (await get(B.adminToken, "/api/shifts")).data.full[0];
  const student = (await get(B.adminToken, "/api/students/admin")).data.students[0];
  const subject = (await get(B.adminToken, "/api/subjects")).data.subjects[0];

  assert.equal((await call(A.adminToken, "PUT", `/api/departments/${dept._id}`, { body: { name: "Hijacked" } })).status, 404);
  assert.equal((await call(A.adminToken, "DELETE", `/api/departments/${dept._id}`)).status, 404);
  assert.equal((await call(A.adminToken, "PUT", `/api/shifts/${shift._id}`, { body: { name: "Hijacked" } })).status, 404);
  assert.equal((await call(A.adminToken, "DELETE", `/api/shifts/${shift._id}`)).status, 404);
  assert.equal((await call(A.adminToken, "PUT", `/api/students/admin/${student._id}`, { body: { name: "Hijacked" } })).status, 404);
  assert.equal((await call(A.adminToken, "DELETE", `/api/students/admin/${student._id}`, { query: { hard: "true" } })).status, 404);
  assert.equal((await call(A.adminToken, "GET", `/api/subjects/${subject._id}`)).status, 404);
  assert.equal((await call(A.adminToken, "PUT", `/api/subjects/${subject._id}`, { body: { subjectName: "Hijacked" } })).status, 404);
  assert.equal((await call(A.adminToken, "DELETE", `/api/subjects/${subject._id}`, { body: { acknowledged: true } })).status, 404);

  // …and nothing in Beta changed.
  assert.equal((await get(B.adminToken, "/api/departments")).data.departments[0], "Computer Science");
  assert.equal((await get(B.adminToken, "/api/students/admin")).data.students[0].name, student.name);
  assert.equal((await get(B.adminToken, "/api/subjects")).data.count, 1);
});

test("a client-supplied collegeId in the body or query is ignored: records always land in the caller's college", async () => {
  const r = await post(A.adminToken, "/api/departments", { name: "Sneaky", collegeId: B.collegeId, college: B.collegeId });
  assert.equal(r.status, 201);
  assert.equal(r.data.department.collegeId, A.collegeId);
  assert.equal((await get(B.adminToken, "/api/departments", { collegeId: A.collegeId })).data.departments.length, 0);
  const s = await post(A.adminToken, "/api/shifts", { name: "Sneaky", collegeId: B.collegeId });
  assert.equal(s.status, 201);
  assert.equal(await models.Shift.countDocuments({ collegeId: B.collegeId }), 0);
});

test("cross-college references are refused: a subject cannot use another college's department or shift", async () => {
  await post(B.adminToken, "/api/departments", { name: "Beta Only" });
  await post(B.adminToken, "/api/shifts", { name: "Night" });
  await populate(A);

  const badDept = await post(A.teacherToken, "/api/subjects", { subjectName: "X", subjectCode: "X-1", batch: "1", department: "Beta Only", shift: "Morning" });
  assert.equal(badDept.status, 400);
  const badShift = await post(A.teacherToken, "/api/subjects", { subjectName: "X", subjectCode: "X-2", batch: "1", department: "Computer Science", shift: "Night" });
  assert.equal(badShift.status, 400);
  const badStudentShift = await post(A.adminToken, "/api/students/admin", { studentId: "Z", roll: "1", name: "Zed", department: "Computer Science", batch: "1", shift: "Night" });
  assert.equal(badStudentShift.status, 400);

  const sub = (await get(A.teacherToken, "/api/subjects")).data.subjects[0];
  assert.equal((await call(A.teacherToken, "PUT", `/api/subjects/${sub._id}`, { body: { department: "Beta Only" } })).status, 400);
  assert.equal((await call(A.teacherToken, "PUT", `/api/subjects/${sub._id}`, { body: { shift: "Night" } })).status, 400);

  const up = await call(A.adminToken, "POST", "/api/students/upload", { body: { department: "Computer Science", batch: "1", shift: "Night" } });
  assert.ok([400].includes(up.status));
});

test("renaming a department / shift in one college renames only that college's students and subjects", async () => {
  await populate(A);
  await populate(B);
  const dept = (await get(A.adminToken, "/api/departments")).data.full[0];
  const shift = (await get(A.adminToken, "/api/shifts")).data.full.find((s) => s.name === "Morning");

  assert.equal((await call(A.adminToken, "PUT", `/api/departments/${dept._id}`, { body: { name: "Computing" } })).status, 200);
  assert.equal((await call(A.adminToken, "PUT", `/api/shifts/${shift._id}`, { body: { name: "Early" } })).status, 200);

  const a = (await get(A.adminToken, "/api/students/admin")).data.students;
  assert.ok(a.every((s) => s.department === "Computing" && s.shift === "Early"));
  assert.equal((await get(A.adminToken, "/api/subjects")).data.subjects[0].department, "Computing");

  const b = (await get(B.adminToken, "/api/students/admin")).data.students;
  assert.ok(b.every((s) => s.department === "Computer Science" && s.shift === "Morning"), "Beta renamed by Alpha's edit");
  assert.equal((await get(B.adminToken, "/api/subjects")).data.subjects[0].department, "Computer Science");
  assert.equal((await get(B.adminToken, "/api/departments")).data.departments[0], "Computer Science");
});

// ─── deletion ──────────────────────────────────────────────────────────────────

test("batch (group) deletion deactivates only the selected college's students", async () => {
  await populate(A);
  await populate(B);
  const del = await call(A.adminToken, "DELETE", "/api/students/group", { body: { department: "Computer Science", batch: "2024", shift: "morning" } });
  assert.equal(del.status, 200);
  assert.equal(del.data.deactivated, 2);

  assert.equal((await get(A.adminToken, "/api/students/directory")).data.pagination.total, 0);
  assert.equal((await get(B.adminToken, "/api/students/directory")).data.pagination.total, 2);
  assert.equal(await models.Student.countDocuments({ collegeId: B.collegeId, isActive: true }), 2);
  assert.equal(await models.Student.countDocuments({ collegeId: A.collegeId, isActive: false }), 2);
});

test("batch deletion is admin-only and needs all three fields", async () => {
  await populate(A);
  assert.equal((await call(A.teacherToken, "DELETE", "/api/students/group", { body: { department: "Computer Science", batch: "2024", shift: "Morning" } })).status, 403);
  assert.equal((await call(A.adminToken, "DELETE", "/api/students/group", { body: { department: "Computer Science", batch: "2024" } })).status, 400);
  assert.equal((await call(A.adminToken, "DELETE", "/api/students/group", { body: { department: { $ne: "" }, batch: "2024", shift: "Morning" } })).status, 400);
  assert.equal(await models.Student.countDocuments({ collegeId: A.collegeId, isActive: true }), 2);
});

test("deletion safeguards survive: a department/shift used by a teacher's subject or active students cannot be deleted — only counting its own college", async () => {
  await populate(A);
  await populate(B);
  const dept = (await get(A.adminToken, "/api/departments")).data.full[0];
  const shiftMorning = (await get(A.adminToken, "/api/shifts")).data.full.find((s) => s.name === "Morning");
  const shiftDay = (await get(A.adminToken, "/api/shifts")).data.full.find((s) => s.name === "Day");

  const d1 = await call(A.adminToken, "DELETE", `/api/departments/${dept._id}`);
  assert.equal(d1.status, 409);
  assert.match(d1.body.message, /2 student\(s\) and 1 subject\(s\)/); // Alpha's own, not 4 / 2

  assert.equal((await call(A.adminToken, "DELETE", `/api/shifts/${shiftMorning._id}`)).status, 409);
  // "Day" is unused in Alpha (Beta uses nothing there either) → deletable; Beta's "Day" survives.
  assert.equal((await call(A.adminToken, "DELETE", `/api/shifts/${shiftDay._id}`)).status, 200);
  assert.ok((await get(B.adminToken, "/api/shifts")).data.shifts.includes("Day"));

  // Only the subject (teacher-assigned) blocks: deactivate the students, still blocked.
  await call(A.adminToken, "DELETE", "/api/students/group", { body: { department: "Computer Science", batch: "2024", shift: "Morning" } });
  const d2 = await call(A.adminToken, "DELETE", `/api/departments/${dept._id}`);
  assert.equal(d2.status, 409);
  assert.match(d2.body.message, /0 student\(s\) and 1 subject\(s\)/);

  // Remove the subject → now deletable in Alpha; Beta untouched.
  const sub = (await get(A.adminToken, "/api/subjects")).data.subjects[0];
  assert.equal((await call(A.adminToken, "DELETE", `/api/subjects/${sub._id}`, { body: { acknowledged: true } })).status, 200);
  assert.equal((await call(A.adminToken, "DELETE", `/api/departments/${dept._id}`)).status, 200);
  assert.deepEqual((await get(B.adminToken, "/api/departments")).data.departments, ["Computer Science"]);
});

test("another college's students/subjects do not block deleting a department that is unused in this college", async () => {
  await populate(B); // Beta uses "Computer Science" heavily
  assert.equal((await post(A.adminToken, "/api/departments", { name: "Computer Science" })).status, 201);
  const dept = (await get(A.adminToken, "/api/departments")).data.full[0];
  assert.equal((await call(A.adminToken, "DELETE", `/api/departments/${dept._id}`)).status, 200);
  assert.equal((await get(B.adminToken, "/api/students/directory")).data.pagination.total, 2);
});

// ─── restore / trash ───────────────────────────────────────────────────────────

test("restore: a deactivated student can be restored by id only inside their own college", async () => {
  await populate(A);
  await populate(B);
  const bStudent = (await get(B.adminToken, "/api/students/admin")).data.students[0];
  await call(B.adminToken, "DELETE", `/api/students/admin/${bStudent._id}`); // soft delete
  const inactive = (await get(B.adminToken, "/api/students/admin", { includeInactive: "true" })).data.students.find((s) => s._id === bStudent._id);
  assert.equal(inactive.isActive, false);

  assert.equal((await call(A.adminToken, "PUT", `/api/students/admin/${bStudent._id}`, { body: { isActive: true } })).status, 404);
  assert.equal((await call(B.adminToken, "PUT", `/api/students/admin/${bStudent._id}`, { body: { isActive: true } })).status, 200);
});

test("attendance trash endpoints (admin) are limited to the college's own subjects", async () => {
  const subA = await populate(A);
  const subB = await populate(B);
  const mkRecord = (subject, teacher, deleted) => models.Attendance.create({
    collegeId: teacher.collegeId, subjectId: subject._id, teacher: teacher._id, date: new Date("2025-01-01"), classType: "Theory",
    students: [{ studentId: "S-001", roll: "1", name: "S", status: "present" }], isDeleted: deleted, deletedAt: deleted ? new Date() : null,
  });
  await mkRecord(subA, A.teacher, true);
  const bRec = await mkRecord(subB, B.teacher, true);
  await mkRecord(subB, B.teacher, false);

  const stats = (await get(A.adminToken, "/api/admin/trash/stats")).data.system;
  assert.deepEqual([stats.totalTrashedRecords, stats.totalActiveRecords], [1, 0]);
  const all = (await get(A.adminToken, "/api/admin/trash")).data;
  assert.equal(all.pagination.total, 1);
  assert.equal((await get(A.adminToken, "/api/admin/trash", { subjectId: subB._id })).data.pagination.total, 0);

  assert.equal((await get(A.adminToken, `/api/trash/${subB._id}`)).status, 404);
  assert.equal((await post(A.adminToken, `/api/trash/${subB._id}/restore/${bRec._id}`)).status, 404);
  assert.equal((await call(A.adminToken, "DELETE", `/api/trash/${subB._id}/permanent/${bRec._id}`)).status, 404);
  assert.equal((await call(A.adminToken, "DELETE", `/api/trash/${subB._id}/empty`)).status, 404);
  assert.equal(await models.Attendance.countDocuments({ subjectId: subB._id, isDeleted: true }), 1);
});

test("student analytics + alert creation resolve the student inside the caller's college (same student id in both)", async () => {
  const subA = await populate(A);
  await populate(B);
  const bRec = (subject, teacher) => models.Attendance.create({
    collegeId: teacher.collegeId, subjectId: subject._id, teacher: teacher._id, date: new Date("2025-01-02"), classType: "Theory",
    students: [{ studentId: "S-001", roll: "1", name: "S", status: "absent" }],
  });
  const subB = (await get(B.adminToken, "/api/subjects")).data.subjects[0];
  await bRec(subB, B.teacher);
  await models.Attendance.create({ collegeId: A.collegeId, subjectId: subA._id, teacher: A.teacher._id, date: new Date("2025-01-03"), classType: "Theory", students: [{ studentId: "S-001", roll: "1", name: "S", status: "present" }] });

  const an = await get(A.adminToken, "/api/alerts/student/S-001/analytics");
  assert.equal(an.status, 200);
  assert.equal(an.data.academicStats.totalClasses, 1);   // Alpha's one class, not Beta's absence too
  assert.equal(an.data.academicStats.totalAttended, 1);

  const cross = await post(A.teacherToken, "/api/alerts/create", { studentId: "S-001", subjectId: subB._id });
  assert.equal(cross.status, 404); // Beta's subject
});

// ─── authentication ────────────────────────────────────────────────────────────

test("department, shift and subject-meta lists are no longer public", async () => {
  for (const p of ["/api/departments", "/api/shifts", "/api/subjects/meta"]) {
    assert.equal((await call(null, "GET", p)).status, 401, p);
  }
});

test("teachers can read their college's lists but not change them", async () => {
  await populate(A);
  assert.equal((await get(A.teacherToken, "/api/departments")).status, 200);
  assert.equal((await post(A.teacherToken, "/api/departments", { name: "Nope" })).status, 403);
  assert.equal((await post(A.teacherToken, "/api/shifts", { name: "Nope" })).status, 403);
});

test("department names with regex characters work and cannot match other names", async () => {
  assert.equal((await post(A.adminToken, "/api/departments", { name: "Arts (Hons)" })).status, 201);
  assert.equal((await post(A.adminToken, "/api/departments", { name: "C++" })).status, 201);
  assert.equal((await post(A.adminToken, "/api/departments", { name: "Arts (hons)" })).status, 409);
  assert.equal((await post(A.adminToken, "/api/departments", { name: "Art" })).status, 201); // not swallowed by "Arts (Hons)"
  assert.equal((await post(A.adminToken, "/api/departments", { name: { $ne: "" } })).status, 400);
});

// ─── additional regressions (each pinned by a mutation check) ───────────────────

test("a shift used only by ANOTHER college does not block deleting this college's same-named shift", async () => {
  await populate(B); // Beta: students + subject on "Morning"
  assert.equal((await post(A.adminToken, "/api/shifts", { name: "Morning" })).status, 201);
  const shift = (await get(A.adminToken, "/api/shifts")).data.full[0];
  assert.equal((await call(A.adminToken, "DELETE", `/api/shifts/${shift._id}`)).status, 200);
  assert.ok((await get(B.adminToken, "/api/shifts")).data.shifts.includes("Morning"));
});

test("student directory statistics never include another college's attendance for the same student id", async () => {
  const subA = await populate(A);
  await populate(B);
  const subB = (await get(B.adminToken, "/api/subjects")).data.subjects[0];
  const rec = (subject, teacher, day, status) => models.Attendance.create({
    collegeId: teacher.collegeId, subjectId: subject._id, teacher: teacher._id, date: new Date(`2025-02-0${day}`), classType: "Theory",
    students: [{ studentId: "S-001", roll: "1", name: "S", status }],
  });
  await rec(subA, A.teacher, 1, "present");
  await rec(subB, B.teacher, 1, "absent");
  await rec(subB, B.teacher, 2, "absent");

  const row = (await get(A.adminToken, "/api/students/directory", { search: "S-001" })).data.students[0];
  assert.deepEqual([row.totalClasses, row.totalAttended, row.attendancePercentage], [1, 1, 100]);
  const rowB = (await get(B.adminToken, "/api/students/directory", { search: "S-001" })).data.students[0];
  assert.deepEqual([rowB.totalClasses, rowB.totalAttended], [2, 0]);
});

test("bulk JSON upload: same department/batch/shift and same student ids in two colleges stay separate", async () => {
  const os = await import("node:os"); const fs = await import("node:fs"); const path = await import("node:path");
  const prev = process.cwd();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "uploads-"));
  process.chdir(tmp);
  try {
    await populate(A); await populate(B);
    const upload = async (C, students) => {
      const fd = new FormData();
      fd.append("department", "Computer Science"); fd.append("batch", "2030"); fd.append("shift", "morning");
      fd.append("file", new Blob([JSON.stringify(students)], { type: "application/json" }), "s.json");
      const port = app.baseUrl;
      const res = await fetch(`${port}/api/students/upload`, { method: "POST", headers: { Authorization: `Bearer ${C.adminToken}` }, body: fd });
      return { status: res.status, body: await res.json() };
    };
    const a = await upload(A, [{ studentId: "U-1", roll: "1", name: "Alpha One" }, { studentId: "U-2", roll: "2", name: "Alpha Two" }]);
    const b = await upload(B, [{ studentId: "U-1", roll: "1", name: "Beta One" }]);
    assert.equal(a.status, 201, JSON.stringify(a.body)); assert.equal(b.status, 201, JSON.stringify(b.body));
    assert.equal(a.body.data.inserted, 2); assert.equal(b.body.data.inserted, 1);
    assert.ok(a.body.data.uploadedFile.includes(A.collegeId.toLowerCase())); // per-college folder
    assert.ok(!b.body.data.uploadedFile.includes(A.collegeId.toLowerCase()));

    // Re-uploading in Alpha updates Alpha's U-1 only.
    await upload(A, [{ studentId: "U-1", roll: "1", name: "Alpha Renamed" }]);
    const names = async (C) => (await get(C.adminToken, "/api/students", { department: "Computer Science", batch: "2030" })).data.students.map((s) => s.name).sort();
    assert.deepEqual(await names(A), ["Alpha Renamed", "Alpha Two"]);
    assert.deepEqual(await names(B), ["Beta One"]);
  } finally { process.chdir(prev); fs.rmSync(tmp, { recursive: true, force: true }); }
});

test("legacy college-less accounts keep working in their own (null) scope and never see a college's data", async () => {
  const { User } = models;
  const legacy = await User.create({ name: "Legacy Admin", email: "legacy@example.com", password: "secret123", role: "admin", approved: true, approvalStatus: "approved" });
  const { generateToken, buildTokenPayload } = await import("../utils/token.js");
  const tok = generateToken(buildTokenPayload(legacy));
  await populate(A);
  assert.deepEqual((await get(tok, "/api/departments")).data.departments, []);
  assert.equal((await post(tok, "/api/departments", { name: "Computer Science" })).status, 201);
  assert.equal((await get(tok, "/api/students/directory")).data.pagination.total, 0);
  assert.deepEqual((await get(A.adminToken, "/api/departments")).data.departments, ["Computer Science"]);
  assert.equal(await models.Department.countDocuments({ collegeId: null }), 1);
});

test("a suspended college's admin cannot use the lists", async () => {
  await models.College.updateOne({ collegeId: A.collegeId }, { $set: { status: "suspended" } });
  assert.equal((await get(A.adminToken, "/api/departments")).status, 403);
  assert.equal((await get(B.adminToken, "/api/departments")).status, 200);
});

test("alert creation: a student id that exists only in another college is 'not found'", async () => {
  const subA = await populate(A);
  await populate(B);
  await post(B.adminToken, "/api/students/admin", { studentId: "BETA-ONLY", roll: "8", name: "Beta Only", department: "Computer Science", batch: "2024", shift: "Morning" });
  assert.equal((await post(A.teacherToken, "/api/alerts/create", { studentId: "BETA-ONLY", subjectId: subA._id })).status, 404);
  assert.equal((await post(A.teacherToken, "/api/alerts/create", { studentId: "S-001", subjectId: subA._id })).status, 201);
});

// Regression (audit): POST /api/departments answered 200 because sendSuccess was called with 201 as the message.
test("audit: creating a department returns HTTP 201 with a proper message", async () => {
  const r = await post(A.adminToken, "/api/departments", { name: "Audit Dept 201" });
  assert.equal(r.status, 201);
  assert.equal(r.body.message, "Department created successfully.");
  assert.equal(r.body.data.department.name, "Audit Dept 201");
});
