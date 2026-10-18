/**
 * Part 16 — trash, restore and every destructive operation are college-aware
 * and safe on inconsistent data.
 *
 * Real routers, middleware, controllers and models over real HTTP (fake Mongo
 * driver, see ./helpers/mongooseFake.js), with TWO colleges that have identical
 * academic structure: same department / batch / shift names, same subject name
 * and code, same student ids, same dates and categories. Every "other college"
 * assertion uses a VALID id that exists, so a pass means ownership — not a typo
 * — stopped the request.
 *
 * Groups: trash listings · restore · permanent delete / empty · races ·
 * retention · nightly cleanup · inconsistent rows · subject deletion cascade ·
 * batch (student group) deletion · other deletion endpoints · pure helpers.
 */
import test, { beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { startApp, makeCollege, models } from "./helpers/e2eApp.js";
import { seedCollegeCategories } from "../services/categoryDefaults.js";
import { runTrashCleanup } from "../services/cronJobs.js";
import { TRASH_TTL_DAYS, TRASH_TTL_MS, trashCutoff, trashExpiryDate, isOwnedBy } from "../utils/trashRules.js";

const { Subject, Student, Attendance, ConsecutiveAbsenceAlert, Department, User } = models;

const DAY = 86400000;
const DEPT = "Computer Science and Technology";
const SUBJECT = { subjectName: "Networks", subjectCode: "CSE-101", batch: "2024", department: DEPT, shift: "Morning" };

let app, call, A, B, subA, subB;
const post = (t, p, body) => call(t, "POST", p, { body });
const get = (t, p, query) => call(t, "GET", p, { query });
const del = (t, p, body, query) => call(t, "DELETE", p, { body, query });

const mkStudent = (C, studentId, over = {}) => Student.create({
  studentId, roll: studentId.slice(2), name: `Student ${studentId}`, department: DEPT, batch: "2024", shift: "Morning",
  uploadedBy: C.admin._id, collegeId: C.collegeId, ...over,
});
const newSubject = async (C) => {
  const r = await post(C.teacherToken, "/api/subjects", SUBJECT);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.data.subject;
};
const roster = (statuses) => Object.entries(statuses).map(([studentId, status]) => ({ studentId, roll: studentId.slice(2), name: `Student ${studentId}`, status }));
/** Record a session (same date/category in both colleges unless overridden). */
const session = async (C = A, sub = subA, { date = "2025-01-10", classType = "Theory" } = {}) => {
  const r = await post(C.teacherToken, `/api/attendance/${sub._id}`, { date, classType, students: roster({ "S-1": "present", "S-2": "absent" }) });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.data.attendance;
};
/** Record a session, then move it to the trash through the real soft-delete route. */
const trashed = async (C = A, sub = subA, opts) => {
  const s = await session(C, sub, opts);
  const r = await del(C.teacherToken, `/api/attendance/${sub._id}/session/${s._id}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return s;
};
const ageTrash = (id, days) => Attendance.updateOne({ _id: id }, { $set: { deletedAt: new Date(Date.now() - days * DAY) } });
const row = (id) => Attendance.findById(id);

beforeEach(async () => {
  if (app) await app.close();
  app = await startApp();
  call = app.call;
  A = await makeCollege("Alpha Polytechnic", { seedDefaults: true });
  B = await makeCollege("Beta Polytechnic", { seedDefaults: true });
  await seedCollegeCategories(A.collegeId);
  await seedCollegeCategories(B.collegeId);
  for (const C of [A, B]) { await mkStudent(C, "S-1"); await mkStudent(C, "S-2"); }
  subA = await newSubject(A);
  subB = await newSubject(B);
});
after(async () => { if (app) await app.close(); });

// ═══ Trash listings ═════════════════════════════════════════════════════════

test("two colleges with identical structure each see only their own trash (subject list, admin list, stats)", async () => {
  const a = await trashed(A, subA);
  const b = await trashed(B, subB); // same subject name/code, same date, same category
  const la = (await get(A.teacherToken, `/api/trash/${subA._id}`)).data;
  assert.deepEqual(la.records.map((r) => r._id), [String(a._id)]);
  const lb = (await get(B.adminToken, `/api/trash/${subB._id}`)).data;
  assert.deepEqual(lb.records.map((r) => r._id), [String(b._id)]);
  const adminA = (await get(A.adminToken, "/api/admin/trash")).data;
  assert.deepEqual(adminA.records.map((r) => r._id), [String(a._id)]);
  assert.equal(adminA.pagination.total, 1);
  assert.equal((await get(A.adminToken, "/api/admin/trash/stats")).data.system.totalTrashedRecords, 1);
});

test("another college's admin gets 404 for a valid subject id, exactly like a missing one — no trash is revealed", async () => {
  await trashed(A, subA);
  const foreign = await get(B.adminToken, `/api/trash/${subA._id}`);
  const missing = await get(B.adminToken, `/api/trash/${"f".repeat(24)}`);
  assert.equal(foreign.status, 404);
  assert.equal(missing.status, 404);
  assert.deepEqual(foreign.body, missing.body);
});

test("admin trash filters cannot reach another college (teacherId / subjectId of a foreign college match nothing)", async () => {
  await trashed(A, subA);
  const byTeacher = (await get(B.adminToken, "/api/admin/trash", { teacherId: String(A.teacher._id) })).data;
  const bySubject = (await get(B.adminToken, "/api/admin/trash", { subjectId: String(subA._id) })).data;
  assert.equal(byTeacher.pagination.total, 0);
  assert.equal(bySubject.pagination.total, 0);
  const forged = (await get(B.adminToken, "/api/admin/trash", { collegeId: A.collegeId })).data;
  assert.equal(forged.pagination.total, 0, "a forged collegeId query parameter is ignored");
});

test("a trashed row stamped with one college but pointing at another college's subject does not leak names or appear elsewhere", async () => {
  // Corrupt data: Alpha's row references Beta's subject id.
  const s = await trashed(A, subA);
  await Attendance.updateOne({ _id: s._id }, { $set: { subjectId: subB._id } });
  const list = (await get(A.adminToken, "/api/admin/trash")).data.records;
  assert.equal(list.length, 1);
  assert.equal(list[0].subjectId, null, "Beta's subject is not populated into Alpha's response");
  assert.equal(list[0].orphaned, true);
  assert.ok(!JSON.stringify(list).includes(SUBJECT.subjectCode + "-B"), "no foreign details");
  // Beta cannot see it either (the row is Alpha's), via its own subject url.
  assert.equal((await get(B.adminToken, `/api/trash/${subB._id}`)).data.records.length, 0);
});

test("a teacher cannot list a colleague's subject trash (403, rule unchanged) — and an admin of the same college can", async () => {
  await trashed(A, subA);
  const t2 = await A.mkTeacher();
  assert.equal((await get(t2.token, `/api/trash/${subA._id}`)).status, 403);
  assert.equal((await get(A.adminToken, `/api/trash/${subA._id}`)).status, 200);
});

test("paging parameters of the admin trash list are clamped (NaN, negative, huge)", async () => {
  await trashed(A, subA);
  const r = (await get(A.adminToken, "/api/admin/trash", { page: "-4", limit: "999999" })).data;
  assert.equal(r.pagination.page, 1);
  assert.equal(r.pagination.limit, 100);
  const r2 = (await get(A.adminToken, "/api/admin/trash", { page: "abc", limit: "xyz" })).data;
  assert.deepEqual([r2.pagination.page, r2.pagination.limit], [1, 20]);
  assert.equal(r2.records.length, 1);
});

// ═══ Restore ════════════════════════════════════════════════════════════════

test("restore: another college cannot restore through its own or the owner's subject url; the owner can", async () => {
  const s = await trashed(A, subA);
  for (const url of [`/api/trash/${subA._id}/restore/${s._id}`, `/api/trash/${subB._id}/restore/${s._id}`]) {
    for (const token of [B.adminToken, B.teacherToken]) {
      assert.equal((await post(token, url)).status, 404, url);
    }
  }
  assert.equal((await row(s._id)).isDeleted, true, "still in the trash");
  assert.equal((await post(A.adminToken, `/api/trash/${subA._id}/restore/${s._id}`)).status, 200);
  const back = await row(s._id);
  assert.equal(back.isDeleted, false);
  assert.equal(back.deletedAt, null);
  assert.equal(back.restoreHistory.length, 1);
  assert.equal(String(back.restoreHistory[0].restoredBy), String(A.admin._id));
  assert.equal(back.collegeId, A.collegeId);
});

test("restoring in one college never un-trashes the identically-named session of the other", async () => {
  const a = await trashed(A, subA);
  const b = await trashed(B, subB);
  assert.equal((await post(A.teacherToken, `/api/trash/${subA._id}/restore/${a._id}`)).status, 200);
  assert.equal((await row(b._id)).isDeleted, true);
});

test("restore rules are unchanged: not-in-trash 400, bad id 400, duplicate 409, expired 410, colleague teacher 403", async () => {
  const s = await session();
  assert.equal((await post(A.teacherToken, `/api/trash/${subA._id}/restore/${s._id}`)).status, 400, "active record");
  assert.equal((await post(A.teacherToken, `/api/trash/${subA._id}/restore/not-an-id`)).status, 400);
  await del(A.teacherToken, `/api/attendance/${subA._id}/session/${s._id}`);
  const t2 = await A.mkTeacher();
  assert.equal((await post(t2.token, `/api/trash/${subA._id}/restore/${s._id}`)).status, 403);
  await session(); // same subject/date/category recorded again
  assert.equal((await post(A.teacherToken, `/api/trash/${subA._id}/restore/${s._id}`)).status, 409);
  assert.equal((await row(s._id)).isDeleted, true);

  const old = await trashed(A, subA, { date: "2025-02-01" });
  await ageTrash(old._id, TRASH_TTL_DAYS + 1);
  assert.equal((await post(A.teacherToken, `/api/trash/${subA._id}/restore/${old._id}`)).status, 410);
  assert.equal((await row(old._id)).isDeleted, true, "an expired record is not resurrected");
});

test("retention boundary: day 9 is restorable, day 11 is not; includeExpired=false hides expired rows", async () => {
  const fresh = await trashed(A, subA, { date: "2025-03-01" });
  const stale = await trashed(A, subA, { date: "2025-03-02" });
  await ageTrash(fresh._id, 9);
  await ageTrash(stale._id, 11);
  const all = (await get(A.teacherToken, `/api/trash/${subA._id}`)).data;
  assert.deepEqual([all.meta.restorableCount, all.meta.expiredCount, all.meta.trashTTLDays], [1, 1, 10]);
  const live = (await get(A.teacherToken, `/api/trash/${subA._id}`, { includeExpired: "false" })).data;
  assert.deepEqual(live.records.map((r) => r._id), [String(fresh._id)]);
  assert.equal((await post(A.teacherToken, `/api/trash/${subA._id}/restore/${fresh._id}`)).status, 200);
  assert.equal((await post(A.teacherToken, `/api/trash/${subA._id}/restore/${stale._id}`)).status, 410);
});

// ═══ Permanent delete / empty ═══════════════════════════════════════════════

test("permanent delete: another college cannot destroy a valid trashed id, through any subject url; nothing is lost", async () => {
  const s = await trashed(A, subA);
  for (const url of [`/api/trash/${subA._id}/permanent/${s._id}`, `/api/trash/${subB._id}/permanent/${s._id}`]) {
    for (const token of [B.adminToken, B.teacherToken]) {
      assert.equal((await del(token, url)).status, 404, url);
    }
  }
  assert.ok(await row(s._id), "the record still exists");
  assert.equal((await del(A.adminToken, `/api/trash/${subA._id}/permanent/${s._id}`)).status, 200);
  assert.equal(await row(s._id), null);
});

test("permanent delete only works on trashed rows (active session → 400), and a colleague teacher gets 403", async () => {
  const active = await session();
  assert.equal((await del(A.teacherToken, `/api/trash/${subA._id}/permanent/${active._id}`)).status, 400);
  assert.ok(await row(active._id));
  const s = await trashed(A, subA, { date: "2025-01-11" });
  const t2 = await A.mkTeacher();
  assert.equal((await del(t2.token, `/api/trash/${subA._id}/permanent/${s._id}`)).status, 403);
  assert.ok(await row(s._id));
});

test("empty trash: removes only this subject's trashed rows in this college (active rows, other subjects, other college untouched)", async () => {
  const a1 = await trashed(A, subA, { date: "2025-01-10" });
  await trashed(A, subA, { date: "2025-01-11" });
  const activeA = await session(A, subA, { date: "2025-01-12" });
  const b = await trashed(B, subB, { date: "2025-01-10" });
  // a second subject of the same college keeps its trash
  const r2 = await post(A.teacherToken, "/api/subjects", { ...SUBJECT, subjectCode: "CSE-202", subjectName: "Databases" });
  const other = r2.data.subject;
  const keep = await trashed(A, other);

  assert.equal((await del(B.adminToken, `/api/trash/${subA._id}/empty`)).status, 404);
  assert.ok(await row(a1._id), "B's attempt on A's subject deleted nothing");

  assert.equal((await del(A.teacherToken, `/api/trash/${subA._id}/empty`)).data.deletedCount, 2);
  assert.ok(await row(activeA._id));
  assert.ok(await row(keep._id));
  assert.ok(await row(b._id));
});

test("empty trash with onlyExpired keeps rows still inside the window, in this college only", async () => {
  const stale = await trashed(A, subA, { date: "2025-01-10" });
  const fresh = await trashed(A, subA, { date: "2025-01-11" });
  const staleB = await trashed(B, subB, { date: "2025-01-10" });
  await ageTrash(stale._id, 12);
  await ageTrash(staleB._id, 12);
  const r = await del(A.teacherToken, `/api/trash/${subA._id}/empty?onlyExpired=true`);
  assert.equal(r.data.deletedCount, 1);
  assert.ok(await row(fresh._id));
  assert.ok(await row(staleB._id), "Beta's expired row waits for its own cleanup");
});

test("forged collegeId in body or query is ignored by every trash endpoint", async () => {
  const s = await trashed(A, subA);
  const forge = { collegeId: A.collegeId, college: A.collegeId };
  assert.equal((await call(B.adminToken, "POST", `/api/trash/${subA._id}/restore/${s._id}`, { body: forge, query: forge })).status, 404);
  assert.equal((await call(B.adminToken, "DELETE", `/api/trash/${subA._id}/permanent/${s._id}`, { body: forge, query: forge })).status, 404);
  assert.equal((await call(B.adminToken, "DELETE", `/api/trash/${subA._id}/empty`, { body: forge, query: forge })).status, 404);
  assert.ok(await row(s._id));
});

test("every trash endpoint refuses unauthenticated callers and non-teacher/admin roles", async () => {
  const s = await trashed(A, subA);
  const calls = [
    ["GET", `/api/trash/${subA._id}`],
    ["POST", `/api/trash/${subA._id}/restore/${s._id}`],
    ["DELETE", `/api/trash/${subA._id}/permanent/${s._id}`],
    ["DELETE", `/api/trash/${subA._id}/empty`],
    ["GET", "/api/admin/trash"],
    ["GET", "/api/admin/trash/stats"],
  ];
  for (const [m, p] of calls) assert.equal((await call(null, m, p)).status, 401, `${m} ${p}`);
  // admin-only routes are closed to teachers
  assert.equal((await get(A.teacherToken, "/api/admin/trash")).status, 403);
  assert.equal((await get(A.teacherToken, "/api/admin/trash/stats")).status, 403);
  assert.ok(await row(s._id));
});

// ═══ Races: every destructive write re-checks its precondition ═══════════════

const withPatched = async (Model, method, wrapper, fn) => {
  const orig = Model[method];
  Model[method] = function patched(...args) { return wrapper(orig.bind(this), args); };
  try { return await fn(); } finally { Model[method] = orig; }
};

test("race: a record restored between the check and the permanent delete is NOT destroyed", async () => {
  const s = await trashed(A, subA);
  const res = await withPatched(Attendance, "deleteOne", async (orig, args) => {
    // Simulates a concurrent restore landing just before the delete executes.
    await Attendance.updateOne({ _id: s._id }, { $set: { isDeleted: false, deletedAt: null } });
    return orig(...args);
  }, () => del(A.teacherToken, `/api/trash/${subA._id}/permanent/${s._id}`));
  assert.equal(res.status, 409, JSON.stringify(res.body));
  const still = await row(s._id);
  assert.ok(still, "the now-active session survived");
  assert.equal(still.isDeleted, false);
});

test("race: a record purged between the check and the restore is NOT resurrected and the answer is 409", async () => {
  const s = await trashed(A, subA);
  const res = await withPatched(Attendance, "findOneAndUpdate", async (orig, args) => {
    await Attendance.deleteMany({ _id: s._id }); // a concurrent permanent delete / cleanup
    return orig(...args);
  }, () => post(A.teacherToken, `/api/trash/${subA._id}/restore/${s._id}`));
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.equal(await row(s._id), null);
});

test("race: a record that expires during the restore is refused (the window is re-checked inside the write)", async () => {
  const s = await trashed(A, subA);
  await ageTrash(s._id, 9.99);
  const res = await withPatched(Attendance, "findOneAndUpdate", async (orig, args) => {
    await ageTrash(s._id, TRASH_TTL_DAYS + 0.5); // crosses the 10-day line mid-request
    return orig(...args);
  }, () => post(A.teacherToken, `/api/trash/${subA._id}/restore/${s._id}`));
  assert.equal(res.status, 409);
  assert.equal((await row(s._id)).isDeleted, true);
});

test("race: a duplicate recorded while restoring turns the unique-index violation into 409, not 500", async () => {
  const s = await trashed(A, subA);
  const res = await withPatched(Attendance, "findOneAndUpdate", async (orig, args) => {
    await session(A, subA); // active duplicate appears after the conflict check
    return orig(...args);
  }, () => post(A.teacherToken, `/api/trash/${subA._id}/restore/${s._id}`));
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.equal((await row(s._id)).isDeleted, true);
});

// ═══ Nightly cleanup ════════════════════════════════════════════════════════

test("cleanup purges expired trash per college, keeps fresh trash and active sessions, and reports each college", async () => {
  for (const [C, sub] of [[A, subA], [B, subB]]) {
    const old = await trashed(C, sub, { date: "2025-01-10" });
    await ageTrash(old._id, 11);
    await trashed(C, sub, { date: "2025-01-11" }); // fresh trash
    await session(C, sub, { date: "2025-01-12" }); // active
  }
  const r = await runTrashCleanup();
  assert.equal(r.cleaned, 2);
  assert.equal(r.errors, 0);
  assert.deepEqual(r.colleges.map((c) => [c.collegeId, c.cleaned]).sort(), [[A.collegeId, 1], [B.collegeId, 1]].sort());
  for (const C of [A, B]) {
    assert.equal(await Attendance.countDocuments({ collegeId: C.collegeId, isDeleted: false }), 1);
    assert.equal(await Attendance.countDocuments({ collegeId: C.collegeId, isDeleted: true }), 1);
  }
});

test("cleanup boundary: exactly 10 days old is purged, one minute short is kept", async () => {
  const edge = await trashed(A, subA, { date: "2025-01-10" });
  const short = await trashed(A, subA, { date: "2025-01-11" });
  const now = Date.now();
  await Attendance.updateOne({ _id: edge._id }, { $set: { deletedAt: new Date(now - TRASH_TTL_MS) } });
  await Attendance.updateOne({ _id: short._id }, { $set: { deletedAt: new Date(now - TRASH_TTL_MS + 60000) } });
  const r = await runTrashCleanup({ now });
  assert.equal(r.cleaned, 1);
  assert.equal(await row(edge._id), null);
  assert.ok(await row(short._id));
});

test("cleanup: a failure in one college is reported and does not stop or undo another college's purge", async () => {
  for (const [C, sub] of [[A, subA], [B, subB]]) {
    const old = await trashed(C, sub);
    await ageTrash(old._id, 15);
  }
  const r = await withPatched(Attendance, "deleteMany", async (orig, args) => {
    if (args[0]?.collegeId === A.collegeId) throw new Error("simulated outage");
    return orig(...args);
  }, () => runTrashCleanup());
  assert.equal(r.errors, 1);
  assert.equal(r.cleaned, 1);
  assert.equal(await Attendance.countDocuments({ collegeId: B.collegeId }), 0, "Beta was purged");
  assert.equal(await Attendance.countDocuments({ collegeId: A.collegeId }), 1, "Alpha keeps its row for the next run");
  assert.match(r.colleges.find((c) => c.collegeId === A.collegeId).error, /simulated outage/);
});

test("cleanup never touches a record that is not in the trash, however old its deletedAt (partly restored row)", async () => {
  const s = await session();
  await Attendance.updateOne({ _id: s._id }, { $set: { isDeleted: false, deletedAt: new Date(Date.now() - 400 * DAY) } });
  const r = await runTrashCleanup();
  assert.equal(r.cleaned, 0);
  assert.ok(await row(s._id));
});

// ═══ Inconsistent / partially deleted rows ═══════════════════════════════════

test("a trashed row with no deletedAt is shown, restorable, never 'expired', and does not crash anything", async () => {
  const s = await trashed(A, subA);
  await Attendance.updateOne({ _id: s._id }, { $set: { deletedAt: null } });
  const list = (await get(A.teacherToken, `/api/trash/${subA._id}`)).data;
  assert.equal(list.records[0].unstamped, true);
  assert.equal(list.records[0].isExpired, false);
  assert.equal(list.meta.restorableCount, 1);
  assert.equal((await get(A.teacherToken, `/api/trash/${subA._id}`, { includeExpired: "false" })).data.records.length, 1);
  assert.equal((await get(A.adminToken, "/api/admin/trash")).status, 200);
  assert.equal((await get(A.adminToken, "/api/admin/trash/stats")).status, 200);
  assert.equal((await post(A.teacherToken, `/api/trash/${subA._id}/restore/${s._id}`)).status, 200);
  assert.equal((await row(s._id)).isDeleted, false);
});

test("cleanup stamps unstamped trash so it starts its normal 10-day window — nothing is deleted early or kept forever", async () => {
  const s = await trashed(A, subA);
  await Attendance.updateOne({ _id: s._id }, { $set: { deletedAt: null } });
  const t0 = Date.now();
  const first = await runTrashCleanup({ now: t0 });
  assert.equal(first.cleaned, 0);
  assert.equal(first.healed, 1);
  const stamped = await row(s._id);
  assert.ok(stamped.deletedAt, "now stamped");
  assert.equal(await runTrashCleanup({ now: t0 + 9 * DAY }).then((r) => r.cleaned), 0, "day 9: still restorable");
  assert.equal(await runTrashCleanup({ now: t0 + 11 * DAY }).then((r) => r.cleaned), 1, "day 11: purged");
});

test("a trashed row whose teacher was deleted: a teacher gets 403 (not 500); a same-college admin can restore and delete it", async () => {
  const s = await trashed(A, subA, { date: "2025-01-10" });
  const s2 = await trashed(A, subA, { date: "2025-01-11" });
  await Attendance.updateOne({ _id: s._id }, { $set: { teacher: null } });
  await Attendance.updateOne({ _id: s2._id }, { $set: { teacher: null } });
  const t2 = await A.mkTeacher();
  // subject owner (A.teacher) is still valid, so the row-level check is what refuses
  await Subject.updateOne({ _id: subA._id }, { $set: { teacher: t2.user._id } });
  assert.equal((await post(t2.token, `/api/trash/${subA._id}/restore/${s._id}`)).status, 403);
  assert.equal((await del(t2.token, `/api/trash/${subA._id}/permanent/${s._id}`)).status, 403);
  assert.equal((await post(A.adminToken, `/api/trash/${subA._id}/restore/${s._id}`)).status, 200);
  assert.equal((await del(A.adminToken, `/api/trash/${subA._id}/permanent/${s2._id}`)).status, 200);
});

test("a subject with no teacher: a teacher is refused (403) on trash routes, an admin of the college still works", async () => {
  await trashed(A, subA);
  await Subject.updateOne({ _id: subA._id }, { $set: { teacher: null } });
  assert.equal((await get(A.teacherToken, `/api/trash/${subA._id}`)).status, 403);
  assert.equal((await del(A.teacherToken, `/api/trash/${subA._id}/empty`)).status, 403);
  assert.equal((await get(A.adminToken, `/api/trash/${subA._id}`)).status, 200);
});

test("orphaned trash (its subject was deleted by a crashed cascade): flagged, not restorable, purged by retention — and only in its own college", async () => {
  const orphanSubject = await Subject.create({ ...SUBJECT, subjectCode: "GONE-1", teacher: A.teacher._id, collegeId: A.collegeId });
  const s = await Attendance.create({
    subjectId: orphanSubject._id, teacher: A.teacher._id, collegeId: A.collegeId, date: new Date("2025-01-10"), classType: "Theory",
    students: [{ studentId: "S-1", roll: "1", name: "S", status: "present" }], isDeleted: true, deletedAt: new Date(),
  });
  await Subject.deleteOne({ _id: orphanSubject._id }); // the subject is gone, the trashed session is left behind
  const list = (await get(A.adminToken, "/api/admin/trash")).data.records;
  assert.equal(list.length, 1);
  assert.equal(list[0].orphaned, true);
  assert.equal((await post(A.adminToken, `/api/trash/${orphanSubject._id}/restore/${s._id}`)).status, 404, "nothing to restore into");
  assert.equal((await post(B.adminToken, `/api/trash/${orphanSubject._id}/restore/${s._id}`)).status, 404);
  await ageTrash(s._id, 11);
  assert.equal((await runTrashCleanup()).cleaned, 1);
});

// ═══ Subject deletion cascade ═══════════════════════════════════════════════

test("deleting a subject removes its active AND trashed sessions and alerts in that college only", async () => {
  await session(A, subA, { date: "2025-01-10" });
  await trashed(A, subA, { date: "2025-01-11" });
  await session(B, subB, { date: "2025-01-10" });
  const bt = await trashed(B, subB, { date: "2025-01-11" });
  const mkAlert = (C, sub) => ConsecutiveAbsenceAlert.create({ collegeId: C.collegeId, studentId: "S-1", studentName: "S", studentRoll: "1", department: DEPT, batch: "2024", subjectId: sub._id, teacherId: C.teacher._id, consecutiveMissCount: 3 });
  await mkAlert(A, subA); await mkAlert(B, subB);

  // Foreign admin: valid id, same-name subject in its own college → 404, nothing deleted
  const denied = await del(B.adminToken, `/api/subjects/${subA._id}`, { acknowledged: true });
  assert.equal(denied.status, 404);
  assert.equal(await Attendance.countDocuments({ collegeId: A.collegeId }), 2);

  const ok = await del(A.adminToken, `/api/subjects/${subA._id}`, { acknowledged: true });
  assert.equal(ok.status, 200);
  assert.deepEqual([ok.data.deletedAttendanceSessions, ok.data.deletedAlerts], [2, 1]);
  assert.equal(await Subject.countDocuments({ collegeId: A.collegeId }), 0);
  assert.equal(await Attendance.countDocuments({ collegeId: A.collegeId }), 0);
  assert.equal(await Attendance.countDocuments({ collegeId: B.collegeId }), 2);
  assert.equal((await row(bt._id)).isDeleted, true, "Beta's trash is intact");
  assert.equal(await ConsecutiveAbsenceAlert.countDocuments({ collegeId: B.collegeId }), 1);
  assert.ok(await Subject.findById(subB._id));
});

test("cascade is by verified college ownership: a row of another college that merely references this subject id survives", async () => {
  await session(A, subA);
  const stray = await session(B, subB, { date: "2025-01-11" });
  await Attendance.updateOne({ _id: stray._id }, { $set: { subjectId: subA._id } }); // corrupt cross-reference, still Beta's row
  assert.equal((await del(A.adminToken, `/api/subjects/${subA._id}`, { acknowledged: true })).status, 200);
  assert.ok(await row(stray._id), "Alpha's cascade did not delete Beta's row");
});

test("subject deletion safeguards are intact: acknowledgement required, teachers only their own, colleague teacher 403", async () => {
  await trashed(A, subA);
  assert.equal((await del(A.adminToken, `/api/subjects/${subA._id}`, {})).status, 400);
  const t2 = await A.mkTeacher();
  assert.equal((await del(t2.token, `/api/subjects/${subA._id}`, { acknowledged: true })).status, 403);
  assert.equal(await Attendance.countDocuments({ collegeId: A.collegeId }), 1, "nothing was removed by the refused calls");
  assert.equal((await del(A.teacherToken, `/api/subjects/${subA._id}`, { acknowledged: true })).status, 200);
});

test("deleting a subject whose teacher record is gone: a teacher is refused cleanly, the college admin can still delete it", async () => {
  await Subject.updateOne({ _id: subA._id }, { $set: { teacher: null } });
  assert.equal((await del(A.teacherToken, `/api/subjects/${subA._id}`, { acknowledged: true })).status, 403);
  assert.equal((await del(A.adminToken, `/api/subjects/${subA._id}`, { acknowledged: true })).status, 200);
});

// ═══ Batch (student group) deletion ═════════════════════════════════════════

test("batch deletion deactivates only the caller's college's students; subjects, attendance and trash of both colleges stay", async () => {
  await session(A, subA);
  await trashed(B, subB);
  const group = { department: DEPT, batch: "2024", shift: "Morning" };
  const r = await del(A.adminToken, "/api/students/group", group);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.data.deactivated, 2);
  assert.equal(await Student.countDocuments({ collegeId: A.collegeId, isActive: true }), 0);
  assert.equal(await Student.countDocuments({ collegeId: B.collegeId, isActive: true }), 2, "Beta's identically-named group is untouched");
  assert.equal(await Subject.countDocuments({}), 2);
  assert.equal(await Attendance.countDocuments({}), 2, "attendance history is kept (existing behaviour)");
  assert.equal((await Attendance.findOne({ collegeId: B.collegeId })).isDeleted, true);
});

test("batch deletion: a forged collegeId in the body cannot aim it at another college; operator objects are refused", async () => {
  const group = { department: DEPT, batch: "2024", shift: "Morning" };
  const forged = await del(A.adminToken, "/api/students/group", { ...group, collegeId: B.collegeId });
  assert.equal(forged.data.deactivated, 2);
  assert.equal(await Student.countDocuments({ collegeId: B.collegeId, isActive: true }), 2);
  const op = await del(B.adminToken, "/api/students/group", { department: { $ne: "" }, batch: { $ne: "" }, shift: { $ne: "" } });
  assert.equal(op.status, 400);
  assert.equal(await Student.countDocuments({ collegeId: B.collegeId, isActive: true }), 2);
  assert.equal((await del(A.teacherToken, "/api/students/group", group)).status, 403, "admin only (rule unchanged)");
});

test("single-student removal: soft by default, hard on request, always inside the caller's college", async () => {
  const theirs = await Student.findOne({ collegeId: B.collegeId, studentId: "S-1" });
  const mine = await Student.findOne({ collegeId: A.collegeId, studentId: "S-1" });
  assert.equal((await del(A.adminToken, `/api/students/admin/${theirs._id}`)).status, 404);
  assert.equal((await del(A.adminToken, `/api/students/admin/${theirs._id}`, undefined, { hard: "true" })).status, 404);
  assert.equal((await Student.findById(theirs._id)).isActive, true);
  assert.equal((await del(A.adminToken, `/api/students/admin/${mine._id}`)).status, 200);
  assert.equal((await Student.findById(mine._id)).isActive, false, "soft delete keeps the document");
  assert.equal((await del(A.adminToken, `/api/students/admin/${mine._id}`, undefined, { hard: "true" })).status, 200);
  assert.equal(await Student.findById(mine._id), null);
  assert.ok(await Student.findById(theirs._id));
});

// ═══ Other destructive endpoints ════════════════════════════════════════════

test("teacher deletion: another college's teacher id is 404 on both delete routes; an admin id is protected", async () => {
  for (const path of [`/api/admin/teachers/${B.teacher._id}`, `/api/auth/users/${B.teacher._id}`]) {
    assert.equal((await del(A.adminToken, path)).status, 404, path);
  }
  assert.ok(await User.findById(B.teacher._id));
  const t2 = await A.mkTeacher();
  assert.equal((await del(A.adminToken, `/api/admin/teachers/${t2.user._id}`)).status, 200);
  assert.equal((await del(A.adminToken, `/api/admin/teachers/${B.admin._id}`)).status, 404);
  assert.ok(await User.findById(B.admin._id));
});

test("department / shift / category deletion: foreign ids are 404, and 'in use' is judged by THIS college only", async () => {
  const deptB = await Department.findOne({ collegeId: B.collegeId, name: DEPT });
  assert.equal((await del(A.adminToken, `/api/departments/${deptB._id}`)).status, 404);
  assert.ok(await Department.findById(deptB._id));
  // Alpha uses the department (students + subject): blocked. Beta's identically named one is also in use → blocked on its own account.
  const deptA = await Department.findOne({ collegeId: A.collegeId, name: DEPT });
  assert.equal((await del(A.adminToken, `/api/departments/${deptA._id}`)).status, 409);
  // Make Beta's copy unused; Alpha's usage must not block it, Beta's usage must not be hidden by Alpha being empty.
  await Student.updateMany({ collegeId: B.collegeId }, { $set: { isActive: false } });
  await Subject.deleteMany({ collegeId: B.collegeId });
  assert.equal((await del(B.adminToken, `/api/departments/${deptB._id}`)).status, 200);
  assert.ok(await Department.findById(deptA._id), "Alpha's department remains");
});

test("category deletion stays blocked by a TRASHED session of this college, and only this college's (restore must find its category)", async () => {
  await trashed(A, subA); // Theory session in Alpha's trash
  const { AttendanceCategory } = models;
  const catA = await AttendanceCategory.findOne({ collegeId: A.collegeId, name: /^theory$/i });
  const catB = await AttendanceCategory.findOne({ collegeId: B.collegeId, name: /^theory$/i });
  assert.equal((await del(B.adminToken, `/api/attendance-categories/${catA._id}`)).status, 404);
  assert.equal((await del(A.adminToken, `/api/attendance-categories/${catA._id}`)).status, 409);
  // Beta has no Theory session of its own: Alpha's trashed one does not block Beta's identically named category.
  assert.equal((await del(B.adminToken, `/api/attendance-categories/${catB._id}`)).status, 200);
  assert.ok(await AttendanceCategory.findById(catA._id), "Alpha's category is untouched");
});

// ═══ Pure helpers ═══════════════════════════════════════════════════════════

test("trashRules: 10-day retention constants and null-safe helpers", () => {
  assert.equal(TRASH_TTL_DAYS, 10);
  assert.equal(TRASH_TTL_MS, 10 * 86400000);
  const now = Date.UTC(2026, 0, 20);
  assert.equal(trashCutoff(now).getTime(), Date.UTC(2026, 0, 10));
  assert.equal(trashExpiryDate(new Date(Date.UTC(2026, 0, 1))).getTime(), Date.UTC(2026, 0, 11));
  assert.equal(trashExpiryDate(null), null);
  assert.equal(trashExpiryDate(undefined), null);
  assert.equal(trashExpiryDate("not a date"), null);
  assert.equal(isOwnedBy(null, "u1"), false);
  assert.equal(isOwnedBy(undefined, undefined), false);
  assert.equal(isOwnedBy("u1", "u1"), true);
  assert.equal(isOwnedBy({ _id: "u1" }, "u1"), true, "populated reference");
  assert.equal(isOwnedBy("u1", "u2"), false);
});
