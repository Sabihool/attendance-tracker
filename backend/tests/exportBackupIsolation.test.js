/**
 * Part 17 — PDF reports, exports, backups and activity logs are college-aware.
 *
 * Real routers, middleware (JWT → database session → tenant context → role),
 * controllers and Mongoose models over real HTTP, on the fake driver from
 * ./helpers/mongooseFake.js, with TWO colleges that have identical structure,
 * identical subject codes and identical student ids/rolls but different names
 * ("Alpha …" / "Beta …") so any leak is visible in the bytes.
 *
 * Groups: PDF/export content · pagination (layout preserved) · cross-college
 * export access · activity log · college backups · restore · background jobs.
 */
import test, { beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import * as XLSX from "xlsx";
import { startApp, makeCollege, models } from "./helpers/e2eApp.js";
import { seedCollegeCategories } from "../services/categoryDefaults.js";
import { pdfText } from "./helpers/pdfText.js";
import { unzip } from "./helpers/zipRead.js";
import { recordActivity, ACTIVITY_ACTIONS } from "../services/activityLog.js";
import { runTrashCleanup } from "../services/cronJobs.js";
import { buildBackupFile, BACKUP_COLLECTIONS } from "../utils/backupFormat.js";
import { createCollegeBackup } from "../services/collegeBackupService.js";
import { generateToken, buildTokenPayload } from "../utils/token.js";
import { backupLimiter } from "../routes/backupRoutes.js";

const { Subject, Student, Attendance, ConsecutiveAbsenceAlert, AttendanceCategory, Settings, Department, Shift, User, ActivityLog } = models;

const SECRET_URI = "mongodb+srv://dbuser:pw-secret-xyz-987@cluster.example.net/";
process.env.MONGO_URI = SECRET_URI;

let app, call, A, B, subA, subB;
const post = (t, p, body) => call(t, "POST", p, { body });
const get = (t, p, query) => call(t, "GET", p, { query });
const patch = (t, p, body) => call(t, "PATCH", p, { body });
const del = (t, p, body) => call(t, "DELETE", p, { body });
const raw = async (token, path, query) => {
  const res = await fetch(app.baseUrl + path + (query ? `?${new URLSearchParams(query)}` : ""), { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  return { status: res.status, headers: res.headers, buf: Buffer.from(await res.arrayBuffer()) };
};

const DEPT = "Computer Science and Technology";
const SUBJECT = { subjectCode: "CSE-101", batch: "2024", department: DEPT, shift: "Morning" };
const mkStudent = (C, tag, n) => Student.create({
  studentId: `S-${n}`, roll: String(n), name: `${tag} Student ${n}`, department: DEPT, batch: "2024", shift: "Morning",
  uploadedBy: C.admin._id, collegeId: C.collegeId,
});
const newSubject = async (C, subjectName) => {
  const r = await post(C.teacherToken, "/api/subjects", { ...SUBJECT, subjectName });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.data.subject;
};
const take = (C, subjectId, tag, day, extra = {}) =>
  post(C.teacherToken, `/api/attendance/${subjectId}`, {
    date: `2025-01-${String(day).padStart(2, "0")}`, classType: "Theory",
    students: [1, 2, 3].map((i) => ({ studentId: `S-${i}`, roll: String(i), name: `${tag} Student ${i}`, status: (i + day) % 3 ? "present" : "absent" })),
    ...extra,
  });
const sessions = async (C, subjectId, tag, days) => {
  for (let d = 1; d <= days; d++) { const r = await take(C, subjectId, tag, d); assert.equal(r.status, 201, JSON.stringify(r.body)); }
};
const waitFor = async (fn, ms = 2000) => {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v || Date.now() > end) return v; await new Promise((r) => setTimeout(r, 15)); }
};
const logOf = async (token, query) => (await get(token, "/api/admin/activity", query));
/** Every row of a college, as one comparable string. */
const snapshot = async (collegeId, { logs = true } = {}) => JSON.stringify(await Promise.all(
  [Student, Subject, Attendance, ConsecutiveAbsenceAlert, AttendanceCategory, Settings, Department, Shift, User, ...(logs ? [ActivityLog] : [])].map((M) => M.find({ collegeId }).sort({ _id: 1 }).lean()),
));

const ROUTES = (id) => [
  ["pdf", `/api/export/${id}/pdf`], ["register", `/api/export/${id}/register/pdf`], ["zip", `/api/export/${id}/register/zip`],
  ["excel", `/api/export/${id}/excel`], ["csv-summary", `/api/export/${id}/csv`], ["csv-sessions", `/api/export/${id}/csv`, { type: "sessions" }],
  ["csv-matrix", `/api/export/${id}/csv`, { type: "matrix" }], ["meta", `/api/export/${id}/meta`],
];
/** All readable text of a downloaded export, whatever its format. */
const textOf = (kind, buf) => {
  if (kind === "pdf" || kind === "register") return pdfText(buf).text;
  if (kind === "zip") return Object.entries(unzip(buf)).map(([n, b]) => (n.endsWith(".pdf") ? pdfText(b).text : b.toString("utf8"))).join("\n");
  if (kind === "excel") { const wb = XLSX.read(buf); return wb.SheetNames.map((n) => XLSX.utils.sheet_to_csv(wb.Sheets[n])).join("\n"); }
  return buf.toString("utf8");
};

beforeEach(async () => {
  backupLimiter.reset();
  if (app) await app.close();
  app = await startApp();
  call = app.call;
  A = await makeCollege("Alpha Polytechnic", { seedDefaults: true });
  B = await makeCollege("Beta Polytechnic", { seedDefaults: true });
  await seedCollegeCategories(A.collegeId);
  await seedCollegeCategories(B.collegeId);
  for (const n of [1, 2, 3]) { await mkStudent(A, "Alpha", n); await mkStudent(B, "Beta", n); }
  subA = await newSubject(A, "Alpha Networks");
  subB = await newSubject(B, "Beta Networks");
});
after(async () => { if (app) await app.close(); });

// ═══ PDF / export content ════════════════════════════════════════════════════

test("every export of college A holds only A's data (PDF, register, ZIP, Excel, CSV ×3, meta) — and none of B's", async () => {
  await sessions(A, subA._id, "Alpha", 3);
  await sessions(B, subB._id, "Beta", 4);
  for (const [kind, path, q] of ROUTES(subA._id).filter((r) => r[0] !== "meta")) {
    const r = await raw(A.teacherToken, path, q);
    assert.equal(r.status, 200, kind);
    const text = textOf(kind, r.buf);
    if (kind !== "csv-sessions") assert.match(text, /Alpha Student 1/, `${kind}: A's students present`);
    assert.ok(!/Beta/.test(text), `${kind}: no trace of college B`);
    if (["pdf", "register", "zip", "excel"].includes(kind)) assert.match(text, /Alpha Polytechnic/, `${kind}: headed with A's own college name`);
    if (kind === "csv-sessions") assert.match(text, /^Date,Class Type,Weight,Total Students,Present,Absent,Rate/);
  }
  const meta = await get(A.adminToken, `/api/export/${subA._id}/meta`);
  assert.equal(meta.status, 200);
  assert.equal(meta.data.collegeName, "Alpha Polytechnic");
  assert.equal(meta.data.totalSessions, 3);
  assert.ok(!JSON.stringify(meta.body).includes("Beta"));
});

test("college B gets B's own report, with B's college, teacher and sessions", async () => {
  await sessions(A, subA._id, "Alpha", 3);
  await sessions(B, subB._id, "Beta", 4);
  const r = await raw(B.adminToken, `/api/export/${subB._id}/pdf`);
  const t = pdfText(r.buf);
  assert.match(t.text, /Beta Polytechnic/);
  assert.match(t.text, /Beta Polytechnic teacher/);
  assert.match(t.text, /Beta Student 3/);
  assert.ok(!/Alpha/.test(t.text));
});

test("a college admin's report names the SUBJECT's teacher, not the admin who downloaded it", async () => {
  await sessions(A, subA._id, "Alpha", 1);
  const t = pdfText((await raw(A.adminToken, `/api/export/${subA._id}/pdf`)).buf).text;
  assert.match(t, /Teacher: Alpha Polytechnic teacher/);
  assert.ok(!/Alpha Polytechnic admin/.test(t));
});

test("poisoned data: a session of college B that points at A's subject never appears in A's report", async () => {
  await sessions(A, subA._id, "Alpha", 2);
  await Attendance.create({
    subjectId: subA._id, teacher: B.teacher._id, collegeId: B.collegeId, date: new Date("2025-02-01"), classType: "Theory", classWeight: 1,
    students: [{ studentId: "S-9", roll: "9", name: "Beta Intruder", status: "present" }], summary: { totalStudents: 1, presentCount: 1, absentCount: 0 },
  });
  const t = pdfText((await raw(A.teacherToken, `/api/export/${subA._id}/pdf`)).buf).text;
  assert.ok(!/Beta Intruder/.test(t));
  assert.equal((await get(A.teacherToken, `/api/export/${subA._id}/meta`)).data.totalSessions, 2);
});

test("defence in depth: if a read ever returned another college's session, the export fails (500, no document) instead of printing it", async () => {
  await sessions(A, subA._id, "Alpha", 2);
  await sessions(B, subB._id, "Beta", 2);
  const orig = Attendance.find;
  Attendance.find = function (_filter, ...rest) { return orig.call(this, {}, ...rest); }; // simulate a scoping bug: no filter at all
  try {
    for (const path of [`/api/export/${subA._id}/pdf`, `/api/export/${subA._id}/csv`, `/api/export/${subA._id}/register/zip`]) {
      const r = await raw(A.teacherToken, path);
      assert.equal(r.status, 500, path);
      assert.ok(!/Beta/.test(r.buf.toString("latin1")), "nothing of college B was sent");
      assert.equal(r.headers.get("content-type").includes("json"), true, "an error body, not a document");
    }
  } finally { Attendance.find = orig; }
});

test("report heading: a college without a recorded name gets the neutral default — never the COLLEGE_NAME env branding of the legacy install", async () => {
  process.env.COLLEGE_NAME = "Legacy Env College";
  try {
    await sessions(A, subA._id, "Alpha", 1);
    await models.College.updateOne({ collegeId: A.collegeId }, { $unset: { name: 1 } });
    const meta = await get(A.adminToken, `/api/export/${subA._id}/meta`);
    assert.equal(meta.status, 200, JSON.stringify(meta.body));
    assert.equal(meta.data.collegeName, "Your College / Institution");
    assert.ok(!/Legacy Env College/.test(pdfText((await raw(A.teacherToken, `/api/export/${subA._id}/pdf`)).buf).text));
  } finally { delete process.env.COLLEGE_NAME; }
});

// ═══ Layout & pagination preserved ═══════════════════════════════════════════

test("layout: 25 dates → 3 attendance pages (10+10+5) + 1 analytics summary page, every student on every page", async () => {
  await sessions(A, subA._id, "Alpha", 25);
  for (const path of [`/api/export/${subA._id}/pdf`, `/api/export/${subA._id}/register/pdf`]) {
    const t = pdfText((await raw(A.teacherToken, path)).buf);
    assert.equal(t.pageCount, 4);
    assert.equal(t.pages.length, 4);
    t.pages.slice(0, 3).forEach((p, i) => {
      assert.match(p, new RegExp(`Attendance Page ${i + 1} of 3`));
      for (const n of [1, 2, 3]) assert.match(p, new RegExp(`Alpha Student ${n}`), `page ${i + 1} lists every student`);
      assert.ok(!/Attendance Analytics Summary|Credit Score/.test(p), "attendance pages carry no analytics");
      assert.match(p, new RegExp(`Page ${i + 1} of 4`));
    });
    assert.match(t.pages[0], /01 Jan/); assert.match(t.pages[0], /10 Jan/); assert.ok(!/11 Jan/.test(t.pages[0].split("Roll")[1] || ""));
    assert.match(t.pages[1], /11 Jan/); assert.match(t.pages[1], /20 Jan/);
    assert.match(t.pages[2], /21 Jan/); assert.match(t.pages[2], /25 Jan/);
    const last = t.pages[3];
    for (const label of ["Attendance Analytics Summary", "Total Classes", "Total Present", "Total Absent", "Attendance %", "Credit Score", "Status"]) assert.match(last, new RegExp(label));
    assert.match(last, /Page 4 of 4/);
    // Golden analytics (same numbers the pre-Part-17 report produced for this data): 25 classes, 17/16/17 present.
    assert.match(last, /Alpha Student 1[\s\S]*25[\s\S]*17[\s\S]*8[\s\S]*68%/);
  }
});

test("layout: 10 dates → 1 attendance page + summary; 11 dates → 2 + summary", async () => {
  await sessions(A, subA._id, "Alpha", 10);
  assert.equal(pdfText((await raw(A.teacherToken, `/api/export/${subA._id}/pdf`)).buf).pageCount, 2);
  await take(A, subA._id, "Alpha", 11);
  const t = pdfText((await raw(A.teacherToken, `/api/export/${subA._id}/pdf`)).buf);
  assert.equal(t.pageCount, 3);
  assert.match(t.pages[0], /Attendance Page 1 of 2/);
});

test("layout: the ZIP still holds <Subject>_Attendance/Attendance_Report.pdf + Attendance_Data.csv, identical layout", async () => {
  await sessions(A, subA._id, "Alpha", 12);
  const files = unzip((await raw(A.teacherToken, `/api/export/${subA._id}/register/zip`)).buf);
  assert.deepEqual(Object.keys(files).sort(), ["Alpha_Networks_Attendance/Attendance_Data.csv", "Alpha_Networks_Attendance/Attendance_Report.pdf"]);
  assert.equal(pdfText(files["Alpha_Networks_Attendance/Attendance_Report.pdf"]).pageCount, 3);
  assert.match(files["Alpha_Networks_Attendance/Attendance_Data.csv"].toString(), /^Roll No\.,Name,/);
});

// ═══ Cross-college access to exports ═════════════════════════════════════════

test("a manipulated subject id (college B's) is a 404 on every export route, for teacher and admin — same as an unknown id", async () => {
  await sessions(B, subB._id, "Beta", 2);
  const unknown = "0123456789abcdef01234567";
  for (const [kind, path, q] of ROUTES(subB._id)) {
    for (const token of [A.teacherToken, A.adminToken]) {
      const r = await raw(token, path, q);
      const control = await raw(token, path.replace(subB._id, unknown), q);
      assert.equal(r.status, 404, kind);
      assert.equal(r.buf.toString(), control.buf.toString(), `${kind}: foreign id answers exactly like a missing id`);
      assert.ok(!/Beta/.test(r.buf.toString()));
    }
  }
});

test("forged college in the query/URL is ignored: ?collegeId=B on A's own subject still returns A's data; on B's subject still 404", async () => {
  await sessions(A, subA._id, "Alpha", 1);
  await sessions(B, subB._id, "Beta", 1);
  const own = await raw(A.adminToken, `/api/export/${subA._id}/csv`, { collegeId: B.collegeId, tenant: B.collegeId });
  assert.equal(own.status, 200);
  assert.ok(/Alpha/.test(own.buf.toString()) && !/Beta/.test(own.buf.toString()));
  assert.equal((await raw(A.adminToken, `/api/export/${subB._id}/csv`, { collegeId: B.collegeId })).status, 404);
  assert.equal((await raw(A.adminToken, `/api/export/${subB._id}/pdf`, { college: B.collegeId })).status, 404);
});

test("malformed ids → 400, no token → 401, same-college teacher who does not own the subject → 403", async () => {
  assert.equal((await raw(A.teacherToken, "/api/export/not-an-id/pdf")).status, 400);
  assert.equal((await raw(A.teacherToken, "/api/export/..%2F..%2Fetc/pdf")).status, 400); // not an object id
  assert.equal((await raw(null, `/api/export/${subA._id}/pdf`)).status, 401);
  const other = await A.mkTeacher();
  for (const [, path, q] of ROUTES(subA._id)) assert.equal((await raw(other.token, path, q)).status, 403, path);
  assert.equal((await raw(A.adminToken, `/api/export/${subA._id}/pdf`)).status, 200, "the college's own admin may export any of its subjects");
});

test("export query hardening: operator objects / garbage dates are a 400 (never a filter); valid ranges still filter", async () => {
  await sessions(A, subA._id, "Alpha", 5);
  for (const q of ["startDate[$gt]=2020-01-01", "endDate[$ne]=x", "startDate=banana", "startDate=2025-13-45", "endDate=2025-01-01&endDate=2025-01-02"]) {
    const res = await fetch(`${app.baseUrl}/api/export/${subA._id}/meta?${q}`, { headers: { Authorization: `Bearer ${A.teacherToken}` } });
    assert.equal(res.status, 400, q);
  }
  const ok = await get(A.teacherToken, `/api/export/${subA._id}/meta`, { startDate: "2025-01-02", endDate: "2025-01-04" });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.totalSessions, 3);
});

test("download headers: no-store, nosniff, and a filename that cannot inject headers even if the subject code is hostile", async () => {
  await sessions(A, subA._id, "Alpha", 1);
  await Subject.updateOne({ _id: subA._id }, { $set: { subjectCode: 'X"\r\nSet-Cookie: pwn=1/../..' } }); // bypasses validators on purpose
  for (const [kind, path, q] of ROUTES(subA._id).filter((r) => r[0] !== "meta")) {
    const r = await raw(A.teacherToken, path, q);
    assert.equal(r.status, 200, kind);
    assert.equal(r.headers.get("cache-control"), "no-store");
    assert.equal(r.headers.get("x-content-type-options"), "nosniff");
    assert.match(r.headers.get("content-disposition"), /^attachment; filename="[A-Za-z0-9._-]+"$/, kind);
    assert.equal(r.headers.get("set-cookie"), null);
  }
});

test("concurrent exports of both colleges never mix (16 interleaved downloads)", async () => {
  await sessions(A, subA._id, "Alpha", 3);
  await sessions(B, subB._id, "Beta", 3);
  const jobs = Array.from({ length: 16 }, (_, i) => {
    const isA = i % 2 === 0;
    const kind = ["pdf", "zip", "excel", "register"][i % 4];
    const route = { pdf: "pdf", zip: "register/zip", excel: "excel", register: "register/pdf" }[kind];
    return raw((isA ? A : B).teacherToken, `/api/export/${(isA ? subA : subB)._id}/${route}`).then((r) => ({ isA, kind, status: r.status, text: textOf(kind, r.buf) }));
  });
  for (const j of await Promise.all(jobs)) {
    assert.equal(j.status, 200);
    assert.ok(j.isA ? !/Beta/.test(j.text) && /Alpha/.test(j.text) : !/Alpha/.test(j.text) && /Beta/.test(j.text), `${j.kind} ${j.isA ? "A" : "B"}`);
  }
});

// ═══ Activity log ════════════════════════════════════════════════════════════

test("activity: an export is logged in the downloader's college only, with actor and subject — and nothing else", async () => {
  await sessions(A, subA._id, "Alpha", 1);
  await sessions(B, subB._id, "Beta", 1);
  await raw(A.teacherToken, `/api/export/${subA._id}/pdf`);
  await raw(B.teacherToken, `/api/export/${subB._id}/csv`);
  const rowsA = await waitFor(async () => { const r = await logOf(A.adminToken, { action: "export" }); return r.data.activity.length === 1 && r; });
  assert.equal(rowsA.status, 200);
  const [row] = rowsA.data.activity;
  assert.equal(row.action, "export.pdf");
  assert.equal(row.actor.name, "Alpha Polytechnic teacher");
  assert.equal(row.actor.role, "teacher");
  assert.equal(row.targetId, subA._id);
  assert.deepEqual(row.meta, { format: "pdf" });
  const rowsB = await waitFor(async () => { const r = await logOf(B.adminToken, { action: "export" }); return r.data.activity.length === 1 && r; });
  assert.equal(rowsB.data.activity[0].action, "export.csv");
  assert.ok(!JSON.stringify(rowsA.body).includes(B.collegeId) && !JSON.stringify(rowsA.body).includes(String(B.teacher._id)));
  // stored rows carry the right college
  assert.equal(await ActivityLog.countDocuments({ collegeId: A.collegeId, action: /^export/ }), 1);
  assert.equal(await ActivityLog.countDocuments({ collegeId: null }), 0);
});

test("activity: refused or failed requests are not logged as actions", async () => {
  await raw(A.teacherToken, `/api/export/${subB._id}/pdf`); // 404
  const other = await A.mkTeacher();
  await raw(other.token, `/api/export/${subA._id}/pdf`); // 403
  await raw(A.teacherToken, `/api/export/${subA._id}/meta`, { startDate: "x" }); // meta isn't logged; also 400
  await raw(A.teacherToken, `/api/export/${subA._id}/pdf`, { startDate: "x" }); // 400
  await new Promise((r) => setTimeout(r, 100));
  assert.equal((await logOf(A.adminToken)).data.activity.length, 0);
  assert.equal((await logOf(B.adminToken)).data.activity.length, 0);
});

test("activity: teacher actions (save/edit/trash) and admin actions (approve a teacher) are logged per college", async () => {
  const saved = await take(A, subA._id, "Alpha", 1);
  const sid = saved.data.attendance._id;
  await call(A.teacherToken, "PUT", `/api/attendance/${subA._id}/session/${sid}`, { body: { note: "hello" } });
  await del(A.teacherToken, `/api/attendance/${subA._id}/session/${sid}`);
  const pending = await User.create({ name: "Pending Pat", email: "pat@alpha.example.com", password: "secret123", role: "teacher", approved: false, approvalStatus: "pending", collegeId: A.collegeId });
  assert.equal((await patch(A.adminToken, `/api/admin/teachers/${pending._id}/approve`)).status, 200);
  const rows = await waitFor(async () => { const r = await logOf(A.adminToken); return r.data.activity.length >= 4 && r; });
  const actions = rows.data.activity.map((r) => `${r.actor.role}:${r.action}`).sort();
  assert.deepEqual(actions, ["admin:teacher.approve", "teacher:attendance.save", "teacher:attendance.trash", "teacher:attendance.update"]);
  assert.equal((await logOf(B.adminToken)).data.activity.length, 0);
  // B's admin cannot approve/affect A's user, and that attempt leaves no row in either college
  const p2 = await User.create({ name: "Pending Quinn", email: "q@alpha.example.com", password: "secret123", role: "teacher", approved: false, approvalStatus: "pending", collegeId: A.collegeId });
  assert.equal((await patch(B.adminToken, `/api/admin/teachers/${p2._id}/approve`)).status, 404);
  await new Promise((r) => setTimeout(r, 80));
  assert.equal((await logOf(B.adminToken)).data.activity.length, 0);
});

test("activity: nothing from request bodies, tokens or notes is stored", async () => {
  await take(A, subA._id, "Alpha", 1, { note: "TOP-SECRET-NOTE-42" });
  await waitFor(async () => (await logOf(A.adminToken)).data.activity.length >= 1);
  const stored = JSON.stringify(await ActivityLog.find({}).lean());
  for (const s of ["TOP-SECRET-NOTE-42", "secret123", A.teacherToken, "Alpha Student", SECRET_URI, "@example.com"]) assert.ok(!stored.includes(s), `log must not contain ${s}`);
});

test("activity: teachers and anonymous callers cannot read the log; the endpoint takes no college from the client", async () => {
  assert.equal((await logOf(A.teacherToken)).status, 403);
  assert.equal((await logOf(null)).status, 401);
  await recordActivity({ collegeId: A.collegeId, userId: String(A.admin._id), role: "admin" }, { action: "backup.create" });
  const r = await logOf(A.adminToken, { collegeId: B.collegeId });
  assert.equal(r.status, 200);
  assert.equal(r.data.activity.length, 1, "?collegeId=B is stripped; the caller's own college is read");
  assert.equal((await logOf(B.adminToken, { collegeId: A.collegeId })).data.activity.length, 0);
});

test("activity filters: group/exact action, role, actor, dates, paging — all validated; another college's actor matches nothing", async () => {
  const t = (C) => ({ collegeId: C.collegeId, userId: String(C.admin._id), role: "admin" });
  for (let i = 0; i < 5; i++) await recordActivity(t(A), { action: "export.pdf", targetId: subA._id });
  await recordActivity(t(A), { action: "backup.create" });
  await recordActivity(t(B), { action: "export.pdf" });
  const q = async (query) => (await logOf(A.adminToken, query));
  assert.equal((await q({ action: "export" })).data.pagination.total, 5);
  assert.equal((await q({ action: "export.pdf" })).data.pagination.total, 5);
  assert.equal((await q({ action: "backup" })).data.pagination.total, 1);
  assert.equal((await q({ role: "admin" })).data.pagination.total, 6);
  assert.equal((await q({ role: "teacher" })).data.pagination.total, 0);
  assert.equal((await q({ actorId: String(A.admin._id) })).data.pagination.total, 6);
  assert.equal((await q({ actorId: String(B.admin._id) })).data.pagination.total, 0, "a foreign actor id reveals nothing");
  const page = await q({ limit: "2", page: "3" });
  assert.equal(page.data.activity.length, 2); assert.equal(page.data.pagination.totalPages, 3);
  assert.equal((await q({ limit: "100000" })).data.pagination.limit, 100);
  assert.equal((await q({ from: "2999-01-01" })).data.pagination.total, 0);
  assert.equal((await q({ from: "2000-01-01", to: "2999-12-31" })).data.pagination.total, 6);
  for (const bad of [{ actorId: "nope" }, { role: "root" }, { action: ".*" }, { action: "nope" }, { from: "yesterday" }, { to: "2025-99-99" }]) {
    assert.equal((await q(bad)).status, 400, JSON.stringify(bad));
  }
  const res = await fetch(`${app.baseUrl}/api/admin/activity?action[$ne]=x`, { headers: { Authorization: `Bearer ${A.adminToken}` } });
  assert.equal(res.status, 400);
});

test("recordActivity: the tenant decides the college (a forged collegeId in the entry is ignored); unknown actions and junk meta are refused", async () => {
  const tenant = { collegeId: A.collegeId, userId: String(A.admin._id), role: "admin" };
  const row = await recordActivity(tenant, { action: "backup.create", collegeId: B.collegeId, meta: { ok: 1, nested: { x: 1 }, long: "y".repeat(500), "bad key": 1 } });
  assert.equal(row.collegeId, A.collegeId);
  assert.deepEqual(row.meta, { ok: 1, long: "y".repeat(80) });
  const silent = { error: () => {} };
  assert.equal(await recordActivity(tenant, { action: "made.up" }, { sink: silent }), null);
  assert.equal(await recordActivity(null, { action: "backup.create" }, { sink: silent }), null);
  assert.equal(await ActivityLog.countDocuments({ collegeId: B.collegeId }), 0);
  assert.ok(ACTIVITY_ACTIONS.includes("trash.purge"));
});

// ═══ College backups ═════════════════════════════════════════════════════════

const seedFull = async () => {
  await sessions(A, subA._id, "Alpha", 3);
  await sessions(B, subB._id, "Beta", 3);
  await ConsecutiveAbsenceAlert.create({ studentId: "S-1", studentName: "Alpha Student 1", roll: "1", subjectId: subA._id, subjectName: "Alpha Networks", teacherId: A.teacher._id, collegeId: A.collegeId, department: DEPT, batch: "2024", shift: "Morning", consecutiveAbsences: 3 }).catch(() => null);
};
const download = async (C) => { const r = await raw(C.adminToken, "/api/admin/backups/college"); return { ...r, file: r.status === 200 ? JSON.parse(r.buf.toString()) : null }; };
const upload = (token, path, file, fields = {}) => app.upload(token, path, { fields, content: typeof file === "string" ? file : JSON.stringify(file), filename: "backup.json" });
const RESTORE = "/api/admin/backups/college/restore";
const PREVIEW = "/api/admin/backups/college/restore/preview";

test("backup: an admin gets a signed backup of THEIR college only — no accounts, no secrets, nothing of college B", async () => {
  await seedFull();
  const r = await download(A);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("cache-control"), "no-store");
  assert.match(r.headers.get("content-disposition"), /^attachment; filename="college-backup-COL-[A-Z0-9]+-\d{8}T\d{4}\.json"$/);
  const { manifest, data } = r.file;
  assert.equal(manifest.collegeId, A.collegeId);
  assert.equal(manifest.collegeName, "Alpha Polytechnic");
  assert.deepEqual(Object.keys(data), BACKUP_COLLECTIONS);
  assert.equal(data.students.length, 3); assert.equal(data.subjects.length, 1); assert.equal(data.attendance.length, 3);
  assert.deepEqual(manifest.counts, Object.fromEntries(BACKUP_COLLECTIONS.map((k) => [k, data[k].length])));
  for (const k of BACKUP_COLLECTIONS) for (const d of data[k]) assert.equal(d.collegeId, A.collegeId, k);
  const text = r.buf.toString();
  for (const s of ["Beta", B.collegeId, String(B.teacher._id), "\"users\"", "password", "$2a$", "$2b$", "pw-secret-xyz", "mongodb", process.env.JWT_SECRET, "authVersion", "@example.com"]) {
    assert.ok(!text.includes(s), `backup must not contain ${s}`);
  }
});

test("backup: college B's backup is B's; teachers and anonymous callers are refused; college/ids in the URL change nothing", async () => {
  await seedFull();
  const b = await download(B);
  assert.equal(b.file.manifest.collegeId, B.collegeId);
  assert.ok(!b.buf.toString().includes("Alpha"));
  assert.equal((await raw(A.teacherToken, "/api/admin/backups/college")).status, 403);
  assert.equal((await raw(null, "/api/admin/backups/college")).status, 401);
  const forged = await raw(A.adminToken, "/api/admin/backups/college", { collegeId: B.collegeId });
  assert.equal(JSON.parse(forged.buf.toString()).manifest.collegeId, A.collegeId);
  // there is no per-backup id/URL, and no platform-wide route
  for (const p of [`/api/admin/backups/${B.collegeId}`, "/api/admin/backups/platform", "/api/admin/backups/all", "/api/admin/backups"]) assert.equal((await raw(A.adminToken, p)).status, 404, p);
});

test("backup: creating one is logged (counts only) in that college's activity log", async () => {
  await seedFull();
  await download(A);
  const rows = await waitFor(async () => { const r = await logOf(A.adminToken, { action: "backup.create" }); return r.data.activity.length === 1 && r; });
  assert.equal(rows.data.activity[0].meta.students, 3);
  assert.equal((await logOf(B.adminToken, { action: "backup" })).data.activity.length, 0);
});

test("backup: createCollegeBackup refuses an account with no college (legacy) and never reads rows without one", async () => {
  const r = await createCollegeBackup({ collegeId: null, userId: String(A.admin._id), role: "admin" });
  assert.equal(r.ok, false); assert.equal(r.status, 403);
  const legacy = await User.create({ name: "Legacy Admin", email: "legacy@example.com", password: "secret123", role: "admin", approved: true, approvalStatus: "approved", collegeId: null });
  const tok = generateToken(buildTokenPayload(legacy));
  assert.ok([401, 403].includes((await raw(tok, "/api/admin/backups/college")).status));
});

// ── Restore ───────────────────────────────────────────────────────────────────

test("restore: a backup of ANOTHER college is refused (403) and nothing changes anywhere", async () => {
  await seedFull();
  const fromB = (await download(B)).file;
  const before = [await snapshot(A.collegeId, { logs: false }), await snapshot(B.collegeId)];
  for (const path of [PREVIEW, RESTORE]) {
    const r = await upload(A.adminToken, path, fromB, { confirm: "RESTORE" });
    assert.equal(r.status, 403, path);
    assert.equal(r.body.code, "BACKUP_WRONG_COLLEGE");
    assert.ok(!JSON.stringify(r.body).includes("Beta"));
  }
  await new Promise((r) => setTimeout(r, 60));
  const rowsA = (await logOf(A.adminToken, { action: "backup.restore_refused" })).data.activity;
  assert.equal(rowsA.length, 2); assert.equal(rowsA[0].status, "failed");
  // only the two refusal rows were added (to A's log); no data moved in either college
  assert.equal(await snapshot(B.collegeId), before[1]);
  assert.equal(await snapshot(A.collegeId, { logs: false }), before[0]);
});

test("restore: edited, hand-built, platform-wide, truncated or non-backup files are refused before anything is written", async () => {
  await seedFull();
  const mine = (await download(A)).file;
  const snap = await snapshot(A.collegeId, { logs: false });
  const edit = (fn) => { const c = structuredClone(mine); fn(c); return c; };
  const cases = {
    "edited record": edit((c) => { c.data.students[0].name = "Hacked"; }),
    "re-labelled college": edit((c) => { c.manifest.collegeId = B.collegeId; }),
    "dropped record": edit((c) => { c.data.attendance.pop(); }),
    "bad signature": edit((c) => { c.manifest.signature = "0".repeat(64); }),
    "no signature": edit((c) => { delete c.manifest.signature; }),
    "extra collection (users)": edit((c) => { c.data.users = [{ _id: "a".repeat(24), name: "Evil", role: "admin" }]; }),
    "platform dump (array)": [{ collegeId: A.collegeId }, { collegeId: B.collegeId }],
    "platform dump (by college)": { colleges: { [A.collegeId]: mine.data, [B.collegeId]: {} } },
    "wrong format": edit((c) => { c.manifest.format = "mongodump"; }),
    "string": "just text",
    "null": "null",
  };
  for (const [name, file] of Object.entries(cases)) {
    backupLimiter.reset(); // 22 requests in this test exceed the production per-college hourly budget
    for (const path of [PREVIEW, RESTORE]) {
      const r = await upload(A.adminToken, path, file, { confirm: "RESTORE" });
      assert.ok([400, 403].includes(r.status), `${name} → ${r.status}`);
      assert.equal(r.body.success, false, name);
    }
  }
  assert.equal((await upload(A.adminToken, PREVIEW, "{not json")).status, 400);
  assert.equal((await app.upload(A.adminToken, PREVIEW, {})).status, 400, "no file attached");
  assert.equal(await snapshot(A.collegeId, { logs: false }), snap, "no write happened");
});

test("restore: a validly SIGNED file that smuggles another college's records is rejected whole (403)", async () => {
  await seedFull();
  const mine = (await download(A)).file;
  const foreignStudent = (await Student.findOne({ collegeId: B.collegeId }).lean());
  const data = structuredClone(mine.data);
  data.students.push(JSON.parse(JSON.stringify(foreignStudent))); // stamped collegeId = B
  const file = buildBackupFile({ collegeId: A.collegeId, data });
  const before = await snapshot(B.collegeId);
  const r = await upload(A.adminToken, RESTORE, file, { confirm: "RESTORE" });
  assert.equal(r.status, 403); assert.equal(r.body.code, "BACKUP_FOREIGN_RECORDS");
  assert.equal(await snapshot(B.collegeId), before);
  // a signed file with a collection we never export is refused too
  const withUsers = buildBackupFile({ collegeId: A.collegeId, data: { ...structuredClone(mine.data), users: [] } });
  assert.equal((await upload(A.adminToken, RESTORE, withUsers, { confirm: "RESTORE" })).status, 400);
});

test("restore: preview writes nothing; apply needs confirm=RESTORE; it re-adds what is missing and never overwrites what exists", async () => {
  await seedFull();
  const file = (await download(A)).file;
  // damage college A: delete the subject + its sessions, and rename an existing student afterwards
  await Attendance.deleteMany({ collegeId: A.collegeId });
  await Subject.deleteMany({ collegeId: A.collegeId });
  await Student.updateOne({ collegeId: A.collegeId, studentId: "S-1" }, { $set: { name: "Renamed After Backup" } });
  const beforeB = await snapshot(B.collegeId);

  const pv = await upload(A.adminToken, PREVIEW, file);
  assert.equal(pv.status, 200, JSON.stringify(pv.body));
  assert.equal(pv.data.dryRun, true);
  assert.equal(pv.data.collections.subjects.toInsert, 1);
  assert.equal(pv.data.collections.attendance.toInsert, 3);
  assert.equal(pv.data.collections.students.existing, 3);
  assert.equal(pv.data.totals.inserted, 0);
  assert.equal(await Subject.countDocuments({ collegeId: A.collegeId }), 0, "preview wrote nothing");

  assert.equal((await upload(A.adminToken, RESTORE, file)).body.code, "CONFIRM_REQUIRED");
  assert.equal((await upload(A.adminToken, RESTORE, file, { confirm: "yes" })).status, 400);
  assert.equal(await Subject.countDocuments({ collegeId: A.collegeId }), 0);

  const done = await upload(A.adminToken, RESTORE, file, { confirm: "RESTORE" });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.data.mode, "merge-only");
  assert.equal(done.data.collections.subjects.inserted, 1);
  assert.equal(done.data.collections.attendance.inserted, 3);
  assert.equal(await Attendance.countDocuments({ collegeId: A.collegeId }), 3);
  const restored = await Subject.findOne({ collegeId: A.collegeId }).lean();
  assert.equal(String(restored._id), subA._id, "same id as before");
  assert.equal((await Student.findOne({ collegeId: A.collegeId, studentId: "S-1" })).name, "Renamed After Backup", "existing record untouched");
  // the restored data works: the report is back
  assert.equal((await get(A.teacherToken, `/api/export/${subA._id}/meta`)).data.totalSessions, 3);
  // idempotent
  const again = await upload(A.adminToken, RESTORE, file, { confirm: "RESTORE" });
  assert.equal(again.data.totals.inserted, 0);
  assert.equal(again.data.collections.attendance.existing, 3);
  assert.equal(await snapshot(B.collegeId), beforeB, "college B byte-identical");
  assert.equal(await Attendance.countDocuments({ collegeId: A.collegeId }), 3);
  const log = (await logOf(A.adminToken, { action: "backup" })).data.activity.map((r) => r.action);
  assert.ok(log.includes("backup.restore_preview") && log.includes("backup.restore") && log.includes("backup.create"));
});

test("restore: references must resolve inside the college — a missing teacher account skips the subject; no account is ever created", async () => {
  await seedFull();
  const file = (await download(A)).file;
  await Attendance.deleteMany({ collegeId: A.collegeId });
  await Subject.deleteMany({ collegeId: A.collegeId });
  await User.deleteOne({ _id: A.teacher._id });
  const users = await User.countDocuments({});
  const r = await upload(A.adminToken, RESTORE, file, { confirm: "RESTORE" });
  assert.equal(r.status, 200);
  assert.equal(r.data.collections.subjects.missingReference, 1);
  assert.equal(r.data.collections.subjects.inserted, 0);
  assert.equal(r.data.collections.attendance.missingReference, 3, "sessions of a subject that was not restored are skipped too");
  assert.equal(await User.countDocuments({}), users);
  assert.equal(await Subject.countDocuments({ collegeId: A.collegeId }), 0);
});

test("restore: an id already used by ANOTHER college is a generic conflict — nothing is overwritten and nothing about B is revealed", async () => {
  await seedFull();
  const mine = (await download(A)).file;
  const bStudent = await Student.findOne({ collegeId: B.collegeId, studentId: "S-2" }).lean();
  const data = structuredClone(mine.data);
  data.students = [{ ...data.students[0], _id: String(bStudent._id), studentId: "S-77", roll: "77", name: "Alpha Clash" }];
  const file = buildBackupFile({ collegeId: A.collegeId, data });
  const beforeB = await snapshot(B.collegeId);
  const r = await upload(A.adminToken, RESTORE, file, { confirm: "RESTORE" });
  assert.equal(r.status, 200);
  assert.equal(r.data.collections.students.conflict, 1);
  assert.equal(r.data.collections.students.inserted, 0);
  assert.equal(await snapshot(B.collegeId), beforeB);
  const text = JSON.stringify(r.body);
  assert.ok(!text.includes("Beta") && !text.includes(B.collegeId) && !text.includes(String(bStudent._id)));
});

test("restore: teachers and anonymous callers are refused", async () => {
  const file = (await download(A)).file;
  assert.equal((await upload(A.teacherToken, RESTORE, file, { confirm: "RESTORE" })).status, 403);
  assert.equal((await upload(A.teacherToken, PREVIEW, file)).status, 403);
  assert.equal((await upload(null, RESTORE, file, { confirm: "RESTORE" })).status, 401);
});

test("restore: a forged collegeId field in the form is ignored — the session's college is the only target", async () => {
  await seedFull();
  const fromB = (await download(B)).file;
  const r = await upload(A.adminToken, RESTORE, fromB, { confirm: "RESTORE", collegeId: B.collegeId });
  assert.equal(r.status, 403);
  const mine = (await download(A)).file;
  const ok = await upload(B.adminToken, PREVIEW, mine, { collegeId: A.collegeId });
  assert.equal(ok.status, 403, "B's admin cannot use A's file either");
});

// ═══ Background jobs ═════════════════════════════════════════════════════════

test("background: the nightly trash purge runs per college and writes its activity row only into the college it purged", async () => {
  await sessions(A, subA._id, "Alpha", 2);
  await sessions(B, subB._id, "Beta", 2);
  const sa = (await Attendance.findOne({ collegeId: A.collegeId }))._id;
  assert.equal((await del(A.teacherToken, `/api/attendance/${subA._id}/session/${sa}`)).status, 200);
  const sb = (await Attendance.findOne({ collegeId: B.collegeId }))._id;
  assert.equal((await del(B.teacherToken, `/api/attendance/${subB._id}/session/${sb}`)).status, 200);
  const result = await runTrashCleanup({ now: Date.now() + 11 * 86400000 });
  assert.equal(result.cleaned, 2);
  const a = await ActivityLog.find({ collegeId: A.collegeId, action: "trash.purge" }).lean();
  const b = await ActivityLog.find({ collegeId: B.collegeId, action: "trash.purge" }).lean();
  assert.equal(a.length, 1); assert.equal(b.length, 1);
  assert.deepEqual([a[0].meta, a[0].actorRole, a[0].actorId], [{ purged: 1 }, "system", null]);
  assert.equal(await ActivityLog.countDocuments({ action: "trash.purge" }), 2);
  const seen = (await logOf(A.adminToken, { role: "system" })).data.activity;
  assert.equal(seen.length, 1); assert.equal(seen[0].actor.name, null);
});

test("background: nothing in the export/backup path keeps state between requests (no stored export files, no ids to guess)", async () => {
  // exports and backups are generated per request from req.tenant; there is no download id, token or file name to enumerate
  const src = await import("node:fs").then((fs) => fs.readFileSync(new URL("../controllers/exportController.js", import.meta.url), "utf8"));
  assert.ok(!/writeFile|createWriteStream|tmpdir|mkdtemp|\bfs\b/.test(src), "exportController never touches the filesystem");
  const back = await import("node:fs").then((fs) => fs.readFileSync(new URL("../controllers/backupController.js", import.meta.url), "utf8") + fs.readFileSync(new URL("../services/collegeBackupService.js", import.meta.url), "utf8"));
  assert.ok(!/writeFile|createWriteStream|tmpdir|mkdtemp|\bfs\b/.test(back), "backups are not stored on the server");
});
