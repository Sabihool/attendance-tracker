/**
 * Part 11 — subjects and teacher–subject assignments are college-aware.
 *
 * Everything here runs the REAL routers, middleware, controllers and models over
 * HTTP (see helpers/e2eApp.js). Two colleges deliberately use identical
 * department, shift, batch, subject name and subject code, so any query that
 * forgets the college shows up as a wrong count or a leaked row.
 */
import test, { beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { startApp, makeCollege, models } from "./helpers/e2eApp.js";
import { resolveAssignableTeacher, listAssignableTeachers, populateTeacher } from "../utils/subjectAssignment.js";
import { generateToken, buildTokenPayload } from "../utils/token.js";

const { Subject, Attendance, ConsecutiveAbsenceAlert, AttendanceCategory, User, Student } = models;

let app, call, A, B;
const post = (t, p, body) => call(t, "POST", p, { body });
const put = (t, p, body) => call(t, "PUT", p, { body });
const get = (t, p, query) => call(t, "GET", p, { query });
const del = (t, p, body) => call(t, "DELETE", p, { body });

const SUBJECT = { subjectName: "Networks", subjectCode: "CSE-101", batch: "2024", department: "Computer Science", shift: "Morning" };

/** Identical academic structure in every college. */
const structure = async (C) => {
  assert.equal((await post(C.adminToken, "/api/departments", { name: "Computer Science" })).status, 201);
  assert.equal((await post(C.adminToken, "/api/shifts", { name: "Morning", order: 1 })).status, 201);
};

const newSubject = async (token, overrides = {}) => {
  const r = await post(token, "/api/subjects", { ...SUBJECT, ...overrides });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.data.subject;
};

const session = (studentId = "S-1") => ({
  date: "2025-01-15", classType: "Theory",
  students: [{ studentId, roll: "1", name: "Student One", status: "present" }],
});

const mkUser = (C, role, extra = {}) => User.create({
  name: `${role} extra`, email: `x${Math.random().toString(36).slice(2)}@example.com`, password: "secret123",
  role, approved: true, approvalStatus: "approved", collegeId: C.collegeId, ...extra,
});
const tokenOf = (u) => generateToken(buildTokenPayload(u));

beforeEach(async () => {
  if (app) await app.close();
  app = await startApp();
  call = app.call;
  A = await makeCollege("Alpha Polytechnic");
  B = await makeCollege("Beta Polytechnic");
  // Part 12: categories and rosters are per college.
  for (const C of [A, B]) {
    await AttendanceCategory.create({ name: "Theory", credit: 1, collegeId: C.collegeId });
    await Student.create({ studentId: "S-1", roll: "1", name: "Student One", department: "Computer Science", batch: "2024", shift: "Morning", uploadedBy: C.admin._id, collegeId: C.collegeId });
  }
  await structure(A);
  await structure(B);
});
after(async () => { if (app) await app.close(); });

// ─── identical subjects in two colleges ──────────────────────────────────────

test("two colleges can have the same subject name, code, batch, department and shift", async () => {
  const a = await newSubject(A.teacherToken);
  const b = await newSubject(B.teacherToken); // would 409 / E11000 if any rule were global
  assert.notEqual(a._id, b._id);
  assert.equal(await Subject.countDocuments({ subjectCode: "CSE-101" }), 2);
  assert.equal((await Subject.findById(a._id)).collegeId, A.collegeId);
  assert.equal((await Subject.findById(b._id)).collegeId, B.collegeId);
});

test("uniqueness inside a college is unchanged: one code per teacher (any case), but two teachers may share a code", async () => {
  await newSubject(A.teacherToken);
  const dup = await post(A.teacherToken, "/api/subjects", { ...SUBJECT, subjectName: "Other", subjectCode: "cse-101" });
  assert.equal(dup.status, 409);
  assert.match(dup.body.message, /already have a subject with code 'CSE-101'/);
  const t2 = await A.mkTeacher();
  await newSubject(t2.token); // different teacher, same college: allowed (as before)
  // same NAME twice for one teacher is fine — names are not unique
  await newSubject(A.teacherToken, { subjectCode: "CSE-102" });
  assert.equal(await Subject.countDocuments({ collegeId: A.collegeId, subjectName: "Networks" }), 3);
});

test("the schema has no unique index that could block another college (every unique index includes teacher)", () => {
  const unique = Subject.schema.indexes().filter(([, o]) => o?.unique);
  assert.ok(unique.length >= 1);
  for (const [keys] of unique) assert.ok("teacher" in keys, `unique index ${JSON.stringify(keys)} must include teacher`);
});

// ─── listing / search ────────────────────────────────────────────────────────

test("listing, filters and search only return the caller's college (admin and teacher)", async () => {
  await newSubject(A.teacherToken);
  await newSubject(A.teacherToken, { subjectName: "Databases", subjectCode: "CSE-202" });
  await newSubject(B.teacherToken);
  await newSubject(B.teacherToken, { subjectName: "Networks Lab", subjectCode: "CSE-303" });
  await newSubject(B.teacherToken, { subjectName: "Beta Secret", subjectCode: "BETA-9" });

  const adminA = await get(A.adminToken, "/api/subjects");
  assert.deepEqual(adminA.data.subjects.map((s) => s.subjectCode).sort(), ["CSE-101", "CSE-202"]);
  assert.equal((await get(B.adminToken, "/api/subjects")).data.count, 3);
  assert.equal((await get(A.teacherToken, "/api/subjects")).data.count, 2);

  const byName = await get(A.adminToken, "/api/subjects", { search: "networks" });
  assert.deepEqual(byName.data.subjects.map((s) => s.subjectCode), ["CSE-101"], "Beta's 'Networks Lab' must not appear");
  assert.equal((await get(A.adminToken, "/api/subjects", { search: "beta" })).data.count, 0);
  assert.equal((await get(A.teacherToken, "/api/subjects", { search: "cse-2" })).data.count, 1, "search by code");
  assert.equal((await get(A.adminToken, "/api/subjects", { search: "BETA-9" })).data.count, 0);
  assert.equal((await get(A.adminToken, "/api/subjects", { department: "Computer Science" })).data.count, 2);
});

test("search text is literal (regex characters cannot widen the search) and is length-limited", async () => {
  await newSubject(A.teacherToken);
  for (const q of [".*", "^", "(", "[a-z]+", "Net|Data", "\\"]) {
    const r = await get(A.adminToken, "/api/subjects", { search: q });
    assert.equal(r.status, 200, q);
    assert.equal(r.data.count, 0, `search ${JSON.stringify(q)} must not match everything`);
  }
  await newSubject(A.teacherToken, { subjectName: "C++ Programming", subjectCode: "CPP-1" });
  assert.equal((await get(A.adminToken, "/api/subjects", { search: "C++" })).data.count, 1);
  assert.equal((await get(A.adminToken, "/api/subjects", { search: "x".repeat(101) })).status, 400);
});

test("a teacher can never see colleagues' subjects by filter; admin teacherId filter is college-scoped and validated", async () => {
  const mine = await newSubject(A.teacherToken);
  const t2 = await A.mkTeacher();
  await newSubject(t2.token, { subjectCode: "CSE-777" });
  const bSubject = await newSubject(B.teacherToken);

  const asTeacher = await get(A.teacherToken, "/api/subjects", { teacherId: String(t2.user._id) });
  assert.deepEqual(asTeacher.data.subjects.map((s) => s._id), [mine._id], "teacherId is ignored for teachers");

  const own = await get(A.adminToken, "/api/subjects", { teacherId: String(t2.user._id) });
  assert.deepEqual(own.data.subjects.map((s) => s.subjectCode), ["CSE-777"]);

  const foreign = await get(A.adminToken, "/api/subjects", { teacherId: String(B.teacher._id) });
  assert.equal(foreign.status, 200);
  assert.equal(foreign.data.count, 0, "another college's teacher id yields nothing");
  assert.ok(!foreign.data.subjects.some((s) => s._id === bSubject._id));

  assert.equal((await get(A.adminToken, "/api/subjects", { teacherId: "not-an-id" })).status, 400);
  assert.equal((await get(A.adminToken, "/api/subjects", { "teacherId[$ne]": "x" })).status, 200, "operator-shaped value is not an id string and is ignored");
});

// ─── read / update / delete by id (cross-college id tampering) ───────────────

test("another college's subject id is 'not found' for read, update and delete — and looks exactly like a missing id", async () => {
  const bSub = await newSubject(B.teacherToken);
  const missing = "0123456789abcdef01234567";
  for (const token of [A.adminToken, A.teacherToken]) {
    const real = await get(token, `/api/subjects/${bSub._id}`);
    const none = await get(token, `/api/subjects/${missing}`);
    assert.equal(real.status, 404);
    assert.deepEqual(real.body, none.body, "no existence oracle on GET");

    const u = await put(token, `/api/subjects/${bSub._id}`, { subjectName: "Hijacked" });
    assert.equal(u.status, 404);
    assert.deepEqual(u.body, (await put(token, `/api/subjects/${missing}`, { subjectName: "Hijacked" })).body);

    const d = await del(token, `/api/subjects/${bSub._id}`, { acknowledged: true });
    assert.equal(d.status, 404);
    assert.deepEqual(d.body, (await del(token, `/api/subjects/${missing}`, { acknowledged: true })).body);
  }
  const still = await Subject.findById(bSub._id);
  assert.equal(still.subjectName, "Networks");
  assert.equal(still.isArchived, false);
});

test("inside a college a teacher still cannot read, edit or delete a colleague's subject (403); admin can", async () => {
  const mine = await newSubject(A.teacherToken);
  const t2 = await A.mkTeacher();
  assert.equal((await get(t2.token, `/api/subjects/${mine._id}`)).status, 403);
  assert.equal((await put(t2.token, `/api/subjects/${mine._id}`, { subjectName: "Nope" })).status, 403);
  assert.equal((await del(t2.token, `/api/subjects/${mine._id}`, { acknowledged: true })).status, 403);
  assert.equal((await put(A.adminToken, `/api/subjects/${mine._id}`, { subjectName: "Renamed By Admin" })).status, 200);
  assert.equal((await get(A.adminToken, `/api/subjects/${mine._id}`)).data.subject.subjectName, "Renamed By Admin");
});

test("a college id sent in the body or query is ignored: the subject is stamped with the session's college", async () => {
  const r = await post(B.teacherToken, "/api/subjects", { ...SUBJECT, collegeId: A.collegeId, college: A.collegeId, tenantId: A.collegeId });
  assert.equal(r.status, 201);
  assert.equal((await Subject.findById(r.data.subject._id)).collegeId, B.collegeId);
  assert.equal((await get(A.adminToken, "/api/subjects")).data.count, 0);
  // changing it afterwards is impossible too
  const u = await put(B.teacherToken, `/api/subjects/${r.data.subject._id}`, { collegeId: A.collegeId, subjectName: "Still Beta" });
  assert.equal(u.status, 200);
  assert.equal((await Subject.findById(r.data.subject._id)).collegeId, B.collegeId);
  // listing with a foreign college in the query does not switch college
  assert.equal((await get(A.adminToken, "/api/subjects", { collegeId: B.collegeId })).data.count, 0);
});

// ─── academic references (department / shift) ────────────────────────────────

test("a subject can only reference its own college's departments and shifts (create and update)", async () => {
  assert.equal((await post(B.adminToken, "/api/departments", { name: "Beta Only Dept" })).status, 201);
  assert.equal((await post(B.adminToken, "/api/shifts", { name: "Evening", order: 3 })).status, 201);

  const badDept = await post(A.teacherToken, "/api/subjects", { ...SUBJECT, department: "Beta Only Dept" });
  assert.equal(badDept.status, 400);
  assert.equal(badDept.body.message, "Invalid department.");
  const badShift = await post(A.teacherToken, "/api/subjects", { ...SUBJECT, shift: "Evening" });
  assert.equal(badShift.status, 400);
  assert.match(badShift.body.message, /Invalid shift/);
  assert.doesNotMatch(badShift.body.message, /Evening/, "the list of valid shifts must be Alpha's only");

  const a = await newSubject(A.teacherToken);
  assert.equal((await put(A.teacherToken, `/api/subjects/${a._id}`, { department: "Beta Only Dept" })).status, 400);
  assert.equal((await put(A.adminToken, `/api/subjects/${a._id}`, { shift: "Evening" })).status, 400);
  const after = await Subject.findById(a._id);
  assert.deepEqual([after.department, after.shift], ["Computer Science", "Morning"]);
  // and Beta can use them
  assert.equal((await post(B.teacherToken, "/api/subjects", { ...SUBJECT, department: "Beta Only Dept", shift: "Evening" })).status, 201);
});

test("department lookup ignores case and stores the college's own spelling; operator objects are rejected", async () => {
  const s = await newSubject(A.teacherToken, { department: "computer science", shift: "MORNING" });
  assert.equal(s.department, "Computer Science");
  assert.equal(s.shift, "Morning");
  assert.equal((await put(A.teacherToken, `/api/subjects/${s._id}`, { department: "COMPUTER SCIENCE" })).data.subject.department, "Computer Science");
  for (const bad of [{ $ne: "" }, ["Computer Science"], 7]) {
    assert.equal((await post(A.teacherToken, "/api/subjects", { ...SUBJECT, department: bad })).status, 400);
  }
  assert.equal((await post(A.teacherToken, "/api/subjects", { ...SUBJECT, department: "." })).status, 400, "regex characters are literal");
});

// ─── teacher assignment ──────────────────────────────────────────────────────

test("an admin can create a subject for an approved teacher of their own college", async () => {
  const t2 = await A.mkTeacher();
  const r = await post(A.adminToken, "/api/subjects", { ...SUBJECT, teacherId: String(t2.user._id) });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(String(r.data.subject.teacher._id), String(t2.user._id));
  assert.equal(r.data.subject.teacher.name, t2.user.name);
  // it is theirs: they see it, the admin's own list and the other teacher's list differ
  assert.equal((await get(t2.token, "/api/subjects")).data.count, 1);
  assert.equal((await get(A.teacherToken, "/api/subjects")).data.count, 0);
  assert.equal((await post(t2.token, `/api/attendance/${r.data.subject._id}`, session())).status, 201);
});

test("without teacherId the creator owns the subject, as before (teacher and admin)", async () => {
  const t = await newSubject(A.teacherToken);
  assert.equal(String(t.teacher._id), String(A.teacher._id));
  const a = await newSubject(A.adminToken, { subjectCode: "ADM-1" });
  assert.equal(String(a.teacher._id), String(A.admin._id));
  const same = await post(A.teacherToken, "/api/subjects", { ...SUBJECT, subjectCode: "CSE-5", teacherId: String(A.teacher._id) });
  assert.equal(same.status, 201, "naming yourself is fine");
  const blank = await post(A.teacherToken, "/api/subjects", { ...SUBJECT, subjectCode: "CSE-6", teacherId: "" });
  assert.equal(blank.status, 201);
});

test("assignment is refused for: a teacher of another college, a missing id, a bad id, an admin account, an unapproved or rejected teacher", async () => {
  const pending = await mkUser(A, "teacher", { approved: false, approvalStatus: "pending" });
  const rejected = await mkUser(A, "teacher", { approved: false, approvalStatus: "rejected" });
  const inconsistent = await mkUser(A, "teacher", { approved: true, approvalStatus: "rejected" });
  const missing = "0123456789abcdef01234567";

  const bTeacher = await post(A.adminToken, "/api/subjects", { ...SUBJECT, teacherId: String(B.teacher._id) });
  const none = await post(A.adminToken, "/api/subjects", { ...SUBJECT, teacherId: missing });
  assert.equal(bTeacher.status, 400);
  assert.equal(bTeacher.body.message, "Teacher not found in your college.");
  assert.deepEqual(bTeacher.body, none.body, "another college's teacher is indistinguishable from a missing one");

  const cases = [
    [String(B.admin._id), "Teacher not found in your college."],
    ["nope", "Invalid teacher."],
    [String(pending._id), "Only approved teachers can be assigned subjects."],
    [String(rejected._id), "Only approved teachers can be assigned subjects."],
    [String(inconsistent._id), "Only approved teachers can be assigned subjects."],
  ];
  for (const [teacherId, message] of cases) {
    const r = await post(A.adminToken, "/api/subjects", { ...SUBJECT, teacherId });
    assert.equal(r.status, 400, teacherId);
    assert.equal(r.body.message, message, teacherId);
  }
  const another = await mkUser(A, "admin"); // same college but not a teacher
  const adm = await post(A.adminToken, "/api/subjects", { ...SUBJECT, teacherId: String(another._id) });
  assert.equal(adm.status, 400);
  assert.equal(adm.body.message, "Subjects can only be assigned to teachers.");

  for (const bad of [{ $ne: "" }, ["x"], 5]) {
    assert.equal((await post(A.adminToken, "/api/subjects", { ...SUBJECT, teacherId: bad })).status, 400);
  }
  assert.equal(await Subject.countDocuments({}), 0, "no refused request created anything");
});

test("a teacher cannot assign subjects to anyone else — not a colleague, not another college's teacher", async () => {
  const t2 = await A.mkTeacher();
  for (const id of [t2.user._id, B.teacher._id]) {
    const r = await post(A.teacherToken, "/api/subjects", { ...SUBJECT, teacherId: String(id) });
    assert.equal(r.status, 403);
  }
  assert.equal(await Subject.countDocuments({}), 0);
});

test("assigning to a teacher who already has that code → 409, not a database error", async () => {
  const t2 = await A.mkTeacher();
  await newSubject(t2.token);
  const r = await post(A.adminToken, "/api/subjects", { ...SUBJECT, teacherId: String(t2.user._id) });
  assert.equal(r.status, 409);
  assert.match(r.body.message, /That teacher already has a subject with code 'CSE-101'/);
});

test("GET /subjects/teachers lists only approved teachers of the admin's own college and is admin-only", async () => {
  await mkUser(A, "teacher", { approved: false, approvalStatus: "pending", name: "Pending Pat" });
  await mkUser(A, "teacher", { approved: false, approvalStatus: "rejected", name: "Rejected Ron" });
  const t2 = await A.mkTeacher();
  const r = await get(A.adminToken, "/api/subjects/teachers");
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.teachers.map((t) => String(t._id)).sort(), [String(A.teacher._id), String(t2.user._id)].sort());
  assert.ok(r.data.teachers.every((t) => !("password" in t) && !("collegeId" in t)));
  assert.ok(!r.data.teachers.some((t) => /Beta/.test(t.name) || /Pending|Rejected/.test(t.name)));
  assert.equal((await get(B.adminToken, "/api/subjects/teachers")).data.count, 1);
  assert.equal((await get(A.teacherToken, "/api/subjects/teachers")).status, 403);
  assert.equal((await get(undefined, "/api/subjects/teachers")).status, 401);
});

// ─── re-assignment ───────────────────────────────────────────────────────────

test("re-assigning moves the subject, its attendance (active and trashed) and its alerts to the new teacher", async () => {
  const sub = await newSubject(A.teacherToken);
  assert.equal((await post(A.teacherToken, `/api/attendance/${sub._id}`, session())).status, 201);
  const trashed = await Attendance.create({
    collegeId: A.collegeId, subjectId: sub._id, teacher: A.teacher._id, date: new Date("2025-01-10"), classType: "Theory",
    students: [{ studentId: "S-1", roll: "1", name: "S", status: "absent" }], isDeleted: true, deletedAt: new Date(),
  });
  await ConsecutiveAbsenceAlert.create({
    collegeId: A.collegeId, studentId: "S-1", studentName: "S", studentRoll: "1", department: "Computer Science", batch: "2024",
    subjectId: sub._id, teacherId: A.teacher._id, consecutiveMissCount: 3,
  });
  const t2 = await A.mkTeacher();

  const r = await put(A.adminToken, `/api/subjects/${sub._id}`, { teacherId: String(t2.user._id) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(String(r.data.subject.teacher._id), String(t2.user._id));

  assert.equal(await Attendance.countDocuments({ subjectId: sub._id, teacher: t2.user._id }), 2);
  assert.equal(await Attendance.countDocuments({ subjectId: sub._id, teacher: A.teacher._id }), 0);
  assert.equal((await Attendance.findById(trashed._id)).teacher.toString(), String(t2.user._id));
  assert.equal(await ConsecutiveAbsenceAlert.countDocuments({ subjectId: sub._id, teacherId: t2.user._id }), 1);

  // new owner can work with the history; old owner is locked out
  const list = await get(t2.token, `/api/attendance/${sub._id}`);
  assert.equal(list.status, 200);
  assert.equal(list.data.attendance?.length ?? list.data.records?.length ?? list.data.count, 1);
  assert.equal((await get(A.teacherToken, `/api/attendance/${sub._id}`)).status, 403);
  assert.equal((await get(t2.token, "/api/subjects")).data.count, 1);
  assert.equal((await get(A.teacherToken, "/api/subjects")).data.count, 0);
  assert.equal((await get(t2.token, `/api/trash/${sub._id}`)).status, 200);
});

test("re-assigning to another college's teacher is refused and changes nothing", async () => {
  const sub = await newSubject(A.teacherToken);
  await post(A.teacherToken, `/api/attendance/${sub._id}`, session());
  const r = await put(A.adminToken, `/api/subjects/${sub._id}`, { teacherId: String(B.teacher._id), subjectName: "Should Not Apply" });
  assert.equal(r.status, 400);
  assert.equal(r.body.message, "Teacher not found in your college.");
  const s = await Subject.findById(sub._id);
  assert.equal(String(s.teacher), String(A.teacher._id));
  assert.equal(s.subjectName, "Networks", "the rest of the update was not applied either");
  assert.equal(await Attendance.countDocuments({ subjectId: sub._id, teacher: A.teacher._id }), 1);
});

test("only an admin can re-assign; naming the current owner is a harmless no-op", async () => {
  const sub = await newSubject(A.teacherToken);
  const t2 = await A.mkTeacher();
  const byTeacher = await put(A.teacherToken, `/api/subjects/${sub._id}`, { teacherId: String(t2.user._id) });
  assert.equal(byTeacher.status, 403);
  assert.equal(String((await Subject.findById(sub._id)).teacher), String(A.teacher._id));
  const same = await put(A.teacherToken, `/api/subjects/${sub._id}`, { teacherId: String(A.teacher._id), color: "green" });
  assert.equal(same.status, 200);
  assert.equal(same.data.subject.color, "green");
  // an unapproved teacher of the same college is not a valid target
  const pending = await mkUser(A, "teacher", { approved: false, approvalStatus: "pending" });
  assert.equal((await put(A.adminToken, `/api/subjects/${sub._id}`, { teacherId: String(pending._id) })).status, 400);
});

test("re-assigning into a teacher who has that code → 409 and nothing moves; renaming the code onto your own existing one → 409", async () => {
  const sub = await newSubject(A.teacherToken);
  await post(A.teacherToken, `/api/attendance/${sub._id}`, session());
  const t2 = await A.mkTeacher();
  await newSubject(t2.token);
  const r = await put(A.adminToken, `/api/subjects/${sub._id}`, { teacherId: String(t2.user._id) });
  assert.equal(r.status, 409);
  assert.equal(String((await Subject.findById(sub._id)).teacher), String(A.teacher._id));
  assert.equal(await Attendance.countDocuments({ subjectId: sub._id, teacher: A.teacher._id }), 1);

  const other = await newSubject(A.teacherToken, { subjectCode: "CSE-9" });
  const dup = await put(A.teacherToken, `/api/subjects/${other._id}`, { subjectCode: "cse-101" });
  assert.equal(dup.status, 409);
});

test("a failure while moving attendance rolls the whole re-assignment back", async () => {
  const sub = await newSubject(A.teacherToken);
  await post(A.teacherToken, `/api/attendance/${sub._id}`, session());
  const t2 = await A.mkTeacher();
  const original = Attendance.updateMany;
  Attendance.updateMany = () => { throw new Error("boom"); };
  try {
    const r = await put(A.adminToken, `/api/subjects/${sub._id}`, { teacherId: String(t2.user._id) });
    assert.equal(r.status, 500);
  } finally { Attendance.updateMany = original; }
  assert.equal(String((await Subject.findById(sub._id)).teacher), String(A.teacher._id), "subject kept its owner");
  assert.equal(await Attendance.countDocuments({ subjectId: sub._id, teacher: A.teacher._id }), 1);
});

// ─── tampered / legacy data ──────────────────────────────────────────────────

test("a subject whose teacher record sits in another college never leaks that person's name or email", async () => {
  const sub = await newSubject(A.teacherToken);
  // corrupt the row directly through the model (bypassing the scoped API), as bad legacy data would be
  await Subject.updateOne({ _id: sub._id }, { $set: { teacher: B.teacher._id } });
  assert.equal(String((await Subject.findById(sub._id)).teacher), String(B.teacher._id));

  const list = await get(A.adminToken, "/api/subjects");
  assert.equal(list.data.count, 1);
  assert.equal(list.data.subjects[0].teacher, null);
  const one = await get(A.adminToken, `/api/subjects/${sub._id}`);
  assert.equal(one.data.subject.teacher, null);
  assert.ok(!JSON.stringify(list.body).includes(B.teacher.email));
  const analytics = await get(A.adminToken, "/api/admin/subjects");
  assert.ok(!JSON.stringify(analytics.body).includes(B.teacher.email));
  assert.equal(analytics.data.subjects[0].teacherName, "—");
});

// ─── deletion ────────────────────────────────────────────────────────────────

test("deleting a subject removes ITS attendance and alerts only — the other college's identical subject is untouched", async () => {
  const a = await newSubject(A.teacherToken);
  const b = await newSubject(B.teacherToken);
  for (const [token, sub] of [[A.teacherToken, a], [B.teacherToken, b]]) {
    assert.equal((await post(token, `/api/attendance/${sub._id}`, session())).status, 201);
  }
  const trashedFor = (sub, teacher) => Attendance.create({
    collegeId: teacher.collegeId, subjectId: sub._id, teacher: teacher._id, date: new Date("2025-01-11"), classType: "Theory",
    students: [{ studentId: "S-1", roll: "1", name: "S", status: "absent" }], isDeleted: true, deletedAt: new Date(),
  });
  await trashedFor(a, A.teacher);
  await trashedFor(b, B.teacher);
  const alertFor = (sub, teacher) => ConsecutiveAbsenceAlert.create({
    collegeId: teacher.collegeId, studentId: "S-1", studentName: "S", studentRoll: "1", department: "Computer Science", batch: "2024",
    subjectId: sub._id, teacherId: teacher._id, consecutiveMissCount: 3,
  });
  await alertFor(a, A.teacher);
  await alertFor(b, B.teacher);

  const noAck = await del(A.teacherToken, `/api/subjects/${a._id}`, {});
  assert.equal(noAck.status, 400, "mandatory-backup acknowledgement is still enforced");
  assert.equal(await Subject.countDocuments({}), 2);

  const r = await del(A.teacherToken, `/api/subjects/${a._id}`, { acknowledged: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.data.deletedAttendanceSessions, 2, "active + trashed");
  assert.equal(r.data.deletedAlerts, 1);

  assert.equal(await Subject.countDocuments({ collegeId: A.collegeId }), 0);
  assert.equal(await Attendance.countDocuments({ subjectId: a._id }), 0);
  assert.equal(await ConsecutiveAbsenceAlert.countDocuments({ subjectId: a._id }), 0);

  assert.equal(await Subject.countDocuments({ collegeId: B.collegeId }), 1, "Beta's subject survives");
  assert.equal(await Attendance.countDocuments({ subjectId: b._id }), 2, "Beta's attendance (active + trashed) survives");
  assert.equal(await ConsecutiveAbsenceAlert.countDocuments({ subjectId: b._id }), 1);
  assert.equal((await get(B.teacherToken, `/api/subjects/${b._id}`)).status, 200);
});

test("an admin of college A cannot delete college B's subject even with acknowledged:true; its data survives", async () => {
  const b = await newSubject(B.teacherToken);
  await post(B.teacherToken, `/api/attendance/${b._id}`, session());
  const r = await del(A.adminToken, `/api/subjects/${b._id}`, { acknowledged: true });
  assert.equal(r.status, 404);
  assert.equal(await Subject.countDocuments({ collegeId: B.collegeId }), 1);
  assert.equal(await Attendance.countDocuments({ subjectId: b._id }), 1);
});

test("an admin deletes any subject of their own college (rule unchanged) and a failure part-way keeps everything", async () => {
  const a = await newSubject(A.teacherToken);
  await post(A.teacherToken, `/api/attendance/${a._id}`, session());
  const original = ConsecutiveAbsenceAlert.deleteMany;
  ConsecutiveAbsenceAlert.deleteMany = () => { throw new Error("boom"); };
  try {
    assert.equal((await del(A.adminToken, `/api/subjects/${a._id}`, { acknowledged: true })).status, 500);
  } finally { ConsecutiveAbsenceAlert.deleteMany = original; }
  assert.equal(await Subject.countDocuments({ collegeId: A.collegeId }), 1, "transaction rolled back");
  assert.equal(await Attendance.countDocuments({ subjectId: a._id }), 1, "attendance restored by the rollback");
  assert.equal((await del(A.adminToken, `/api/subjects/${a._id}`, { acknowledged: true })).status, 200);
  assert.equal(await Attendance.countDocuments({ subjectId: a._id }), 0);
});

// ─── attendance / export / trash / alerts: subject ids of other colleges ─────

test("attendance, export and trash routes treat another college's subject id as not found (teacher and admin)", async () => {
  const b = await newSubject(B.teacherToken);
  const sess = await post(B.teacherToken, `/api/attendance/${b._id}`, session());
  assert.equal(sess.status, 201);
  const sessionId = sess.data.attendance._id;

  const probes = [
    ["GET", `/api/attendance/${b._id}`], ["POST", `/api/attendance/${b._id}`, session("S-2")],
    ["GET", `/api/attendance/${b._id}/percentage`], ["GET", `/api/attendance/${b._id}/dates`],
    ["GET", `/api/attendance/${b._id}/session/${sessionId}`],
    ["DELETE", `/api/attendance/${b._id}/session/${sessionId}`],
    ["GET", `/api/export/${b._id}/meta`], ["GET", `/api/export/${b._id}/csv`], ["GET", `/api/export/${b._id}/pdf`],
    ["GET", `/api/trash/${b._id}`], ["DELETE", `/api/trash/${b._id}/empty`],
  ];
  for (const token of [A.teacherToken, A.adminToken]) {
    for (const [method, path, body] of probes) {
      const r = await call(token, method, path, { body });
      assert.equal(r.status, 404, `${method} ${path}`);
    }
  }
  assert.equal(await Attendance.countDocuments({ subjectId: b._id, isDeleted: false }), 1, "nothing was written or trashed");
});

test("a session id from another subject/college cannot be used through your own subject's URL", async () => {
  const a = await newSubject(A.teacherToken);
  const b = await newSubject(B.teacherToken);
  const bSession = (await post(B.teacherToken, `/api/attendance/${b._id}`, session())).data.attendance._id;
  for (const token of [A.teacherToken, A.adminToken]) {
    assert.equal((await get(token, `/api/attendance/${a._id}/session/${bSession}`)).status, 404);
    assert.equal((await put(token, `/api/attendance/${a._id}/session/${bSession}`, { note: "x" })).status, 404);
    assert.equal((await del(token, `/api/attendance/${a._id}/session/${bSession}`)).status, 404);
  }
  // a different subject of the SAME teacher, via the wrong subject id, is refused too
  const a2 = await newSubject(A.teacherToken, { subjectCode: "CSE-2" });
  const a2Session = (await post(A.teacherToken, `/api/attendance/${a2._id}`, session())).data.attendance._id;
  assert.equal((await get(A.teacherToken, `/api/attendance/${a._id}/session/${a2Session}`)).status, 404);
  assert.equal((await get(A.teacherToken, `/api/attendance/${a2._id}/session/${a2Session}`)).status, 200);
  assert.equal((await Attendance.findById(bSession)).isDeleted, false);
});

test("own-college attendance still works end to end, and an alert is created from the college-scoped subject", async () => {
  const a = await newSubject(A.teacherToken);
  for (const d of ["2025-01-13", "2025-01-14", "2025-01-15"]) {
    const r = await post(A.teacherToken, `/api/attendance/${a._id}`, {
      date: d, classType: "Theory", students: [{ studentId: "S-1", roll: "1", name: "Student One", status: "absent" }],
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
  }
  await new Promise((r) => setTimeout(r, 150)); // alert check is fire-and-forget
  const alerts = await ConsecutiveAbsenceAlert.find({ subjectId: a._id });
  assert.equal(alerts.length, 1);
  assert.equal(String(alerts[0].teacherId), String(A.teacher._id));
  assert.equal(alerts[0].department, "Computer Science");
  assert.equal((await get(A.adminToken, `/api/attendance/${a._id}/percentage`)).status, 200);
  const edit = await get(A.teacherToken, `/api/attendance/${a._id}/dates`);
  assert.equal(edit.status, 200);
});

test("export meta names the college of the requester and the subject's assigned teacher (not the downloading admin)", async () => {
  const t2 = await A.mkTeacher();
  const r = await post(A.adminToken, "/api/subjects", { ...SUBJECT, teacherId: String(t2.user._id) });
  const id = r.data.subject._id;
  await post(t2.token, `/api/attendance/${id}`, session());
  const bSub = await newSubject(B.teacherToken);
  const meta = await get(A.adminToken, `/api/export/${id}/meta`);
  assert.equal(meta.status, 200, JSON.stringify(meta.body));
  assert.equal(meta.data.collegeName, "Alpha Polytechnic");
  assert.equal(meta.data.teacher.email, t2.user.email);
  assert.equal(meta.data.subject._id, id);
  assert.equal(meta.data.totalSessions, 1);
  const bMeta = await get(B.teacherToken, `/api/export/${bSub._id}/meta`);
  assert.equal(bMeta.data.collegeName, "Beta Polytechnic");
});

test("alerts cannot be raised for another college's subject by id", async () => {
  const b = await newSubject(B.teacherToken);
  const r = await post(A.teacherToken, "/api/alerts/create", { studentId: "S-1", subjectId: b._id });
  assert.equal(r.status, 404);
  assert.equal(await ConsecutiveAbsenceAlert.countDocuments({}), 0);
});

// ─── helpers (unit level) ────────────────────────────────────────────────────

test("resolveAssignableTeacher / listAssignableTeachers / populateTeacher honour the tenant", async () => {
  const tenantA = { collegeId: A.collegeId };
  assert.equal((await resolveAssignableTeacher(tenantA, String(A.teacher._id))).ok, true);
  const foreign = await resolveAssignableTeacher(tenantA, String(B.teacher._id));
  assert.deepEqual([foreign.ok, foreign.status, foreign.code], [false, 400, "TEACHER_NOT_IN_COLLEGE"]);
  assert.equal((await resolveAssignableTeacher(tenantA, undefined)).code, "INVALID_TEACHER");
  assert.equal((await resolveAssignableTeacher(tenantA, { $ne: 1 })).code, "INVALID_TEACHER");
  assert.deepEqual((await listAssignableTeachers(tenantA)).map((t) => String(t._id)), [String(A.teacher._id)]);
  assert.deepEqual(populateTeacher(tenantA).match, { collegeId: A.collegeId });
  assert.ok(tokenOf(A.teacher));
});
