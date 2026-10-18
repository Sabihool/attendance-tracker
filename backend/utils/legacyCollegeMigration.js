/**
 * Part 20 — migrate the ORIGINAL single-college installation into a real college.
 *
 * Before the multi-college upgrade every row belonged to one implicit institution and had no `collegeId`.
 * The earlier migrations (utils/academicBackfill.js, utils/attendanceBackfill.js) stamp a row from its OWNER's
 * college, so they cannot help while the owners themselves (the users) have no college. This module is the missing
 * first step: it creates (or attaches to) ONE college and stamps every college-less row with it.
 *
 *   Users, Students, Subjects, Attendance sessions, Alerts, Departments, Shifts, Attendance categories, Settings,
 *   Notifications, Activity-log rows   →  collegeId = <the original college>
 *
 * What it guarantees (and verifies — see `verification` in the result):
 *   • Nothing is deleted, renamed, re-dated or re-weighted. Updates use `timestamps: false`, so `updatedAt` is
 *     untouched; every migrated document hashes to exactly the same value as before, ignoring `collegeId`.
 *   • Relationships are untouched (ids are never rewritten). Before/after, the same orphan counts are reported
 *     (a subject whose teacher is missing, a session whose subject is missing, …) so pre-existing orphans are visible
 *     and no new ones can appear.
 *   • Idempotent and resumable: a second run finds nothing college-less and changes nothing.
 *   • `dryRun: true` (the default for the CLI) writes NOTHING, not even the college.
 *   • Name-unique lists (departments, shifts, categories, settings) are merged by name when the target college
 *     already has them; the duplicate college-less row is left in place and counted in `merged`.
 *
 * Operator accounts: every college-less user becomes a member of the college, including a college-less admin created
 * by `scripts/seedAdmin.js`. The oldest approved admin becomes the college's founder (protected from demotion)
 * unless `founderEmail` names someone else.
 */
import crypto from "node:crypto";
import { generateCollegeId, COLLEGE_ID_PATTERN } from "./collegeId.js";
import { buildDedupeKey } from "../validators/collegeValidator.js";

const IMMUTABLE_OK = { overwriteImmutable: true, timestamps: false };
const PAGE = 500;
const NO_COLLEGE = { collegeId: null }; // matches a missing field too
const str = (v) => (v === null || v === undefined ? "" : String(v));

/** Collections stamped in bulk (no per-college unique name to collide with). */
const BULK = ["Student", "Subject", "Attendance", "ConsecutiveAbsenceAlert", "Notification", "ActivityLog"];
/** Collections with a per-college unique name / singleton: merged one by one. */
const BY_NAME = { Department: "name", Shift: "name", AttendanceCategory: "name", Settings: null };
const ALL = ["User", ...BULK, ...Object.keys(BY_NAME)];

const fail = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });

/** Pages through a collection in _id order so a large database never has to fit in memory. */
async function* pages(Model, filter = {}, select = null) {
  let last = null;
  for (;;) {
    const f = last === null ? filter : { $and: [filter, { _id: { $gt: last } }] };
    let q = Model.find(f);
    if (select) q = q.select(select);
    const batch = await q.sort({ _id: 1 }).limit(PAGE).lean();
    if (!batch.length) return;
    yield batch;
    last = batch[batch.length - 1]._id;
    if (batch.length < PAGE) return;
  }
}

/** Order-independent-of-key-order JSON, so the same document always hashes the same. */
const canon = (v) => {
  if (v === null || typeof v !== "object") return JSON.stringify(v === undefined ? null : v);
  if (v instanceof Date) return JSON.stringify(v.toISOString());
  if (typeof v.toHexString === "function") return JSON.stringify(v.toHexString());
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(",")}}`;
};
const withoutCollege = (d) => { const { collegeId: _c, ...rest } = d; return rest; }; // eslint-disable-line no-unused-vars

/** { ids, hash } of the college-less rows of one model, ignoring `collegeId`. */
const fingerprintBefore = async (Model) => {
  const h = crypto.createHash("sha256");
  const ids = [];
  for await (const batch of pages(Model, NO_COLLEGE)) {
    for (const d of batch) { ids.push(d._id); h.update(canon(withoutCollege(d))); h.update("\n"); }
  }
  return { count: ids.length, ids, hash: h.digest("hex") };
};

/** Same hash over the SAME ids, read back after the stamp. */
const fingerprintAfter = async (Model, ids, collegeId) => {
  const h = crypto.createHash("sha256");
  let seen = 0, wrongCollege = 0;
  for (let i = 0; i < ids.length; i += PAGE) {
    const docs = await Model.find({ _id: { $in: ids.slice(i, i + PAGE) } }).sort({ _id: 1 }).lean();
    for (const d of docs) {
      seen++;
      if (d.collegeId !== collegeId) wrongCollege++;
      h.update(canon(withoutCollege(d))); h.update("\n");
    }
  }
  return { count: seen, hash: h.digest("hex"), wrongCollege };
};

/** Orphan counts inside ONE tenant (`null` = the college-less pool). Used before and after to prove nothing broke. */
export const relationshipReport = async (M, collegeId) => {
  const f = { collegeId };
  const users = new Set(), subjects = new Set();
  for await (const b of pages(M.User, f, "_id")) b.forEach((u) => users.add(str(u._id)));
  const subjectTeacher = new Map();
  for await (const b of pages(M.Subject, f, "_id teacher")) b.forEach((s) => { subjects.add(str(s._id)); subjectTeacher.set(str(s._id), str(s.teacher)); });
  const r = { users: users.size, subjects: subjects.size, subjectsWithoutTeacher: 0, sessionsWithoutSubject: 0, sessionsWithForeignTeacher: 0, alertsWithoutSubject: 0, studentsWithoutUploader: 0 };
  for (const s of subjectTeacher.values()) if (!users.has(s)) r.subjectsWithoutTeacher++;
  for await (const b of pages(M.Attendance, f, "_id subjectId teacher")) {
    for (const a of b) { if (!subjects.has(str(a.subjectId))) r.sessionsWithoutSubject++; if (!users.has(str(a.teacher))) r.sessionsWithForeignTeacher++; }
  }
  for await (const b of pages(M.ConsecutiveAbsenceAlert, f, "_id subjectId")) b.forEach((a) => { if (!subjects.has(str(a.subjectId))) r.alertsWithoutSubject++; });
  for await (const b of pages(M.Student, f, "_id uploadedBy")) b.forEach((s) => { if (!users.has(str(s.uploadedBy))) r.studentsWithoutUploader++; });
  return r;
};

const counts = async (M, filter) => {
  const out = {};
  for (const name of ALL) out[name] = await M[name].countDocuments(filter);
  return out;
};
const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);

/**
 * @param {object} opts
 * @param {object} opts.models         { User, Student, Subject, Attendance, ConsecutiveAbsenceAlert, Notification, ActivityLog,
 *                                       Department, Shift, AttendanceCategory, Settings, College }
 * @param {boolean} [opts.dryRun=true] report only
 * @param {string}  [opts.collegeId]   attach to this EXISTING college (resume / merge into a freshly registered one)
 * @param {{name,country,district}} [opts.college]  details for the NEW college (required when creating)
 * @param {string}  [opts.founderEmail] who becomes the protected founder (default: oldest approved admin)
 */
export const migrateLegacyToCollege = async ({ models: M, dryRun = true, collegeId = null, college = null, founderEmail = null, log = () => {} }) => {
  const legacy = await counts(M, NO_COLLEGE);
  const result = {
    dryRun, college: null, createdCollege: false, legacyBefore: legacy, stamped: {}, merged: {}, remaining: {},
    founder: null, warnings: [], verification: null, changed: 0,
  };
  if (sum(legacy) === 0) { result.warnings.push("Nothing to migrate: no college-less rows exist."); return result; }

  // ── 1. Which college? ─────────────────────────────────────────────────────
  let target = null;
  if (collegeId) {
    if (!COLLEGE_ID_PATTERN.test(String(collegeId))) throw fail("BAD_COLLEGE_ID", "collegeId is not a valid college id (COL-XXXXXXXXXX).");
    target = await M.College.findOne({ collegeId }).select("collegeId name status createdBy").lean();
    if (!target) throw fail("COLLEGE_NOT_FOUND", `No college with id ${collegeId}.`);
    if (target.status !== "active") throw fail("COLLEGE_SUSPENDED", "The target college is suspended.");
  } else {
    const { name, country, district } = college || {};
    for (const [k, v] of Object.entries({ name, country, district })) {
      if (typeof v !== "string" || v.trim().length < 2) throw fail("COLLEGE_DETAILS", `The new college needs a ${k} (name, country and district are all required).`);
    }
    const dedupeKey = buildDedupeKey({ name: name.trim(), country: country.trim(), district: district.trim() });
    if (await M.College.exists({ dedupeKey })) {
      throw fail("COLLEGE_EXISTS", "A college with this name/country/district already exists. To attach the legacy data to it (e.g. to resume an interrupted run) pass its collegeId explicitly.");
    }
    result.college = { collegeId: "(will be generated)", name: name.trim(), country: country.trim(), district: district.trim() };
    target = { collegeId: null, new: { name: name.trim(), country: country.trim(), district: district.trim(), dedupeKey } };
  }

  // ── 2. Pre-flight (read-only) ─────────────────────────────────────────────
  const legacyUsers = await M.User.find(NO_COLLEGE).select("_id name email role approved approvalStatus createdAt").sort({ createdAt: 1, _id: 1 }).lean();
  const isApprovedAdmin = (u) => u.role === "admin" && u.approved === true && !["pending", "rejected"].includes(u.approvalStatus);
  let founder = null;
  if (founderEmail) {
    founder = legacyUsers.find((u) => String(u.email).toLowerCase() === String(founderEmail).toLowerCase());
    if (!founder || !isApprovedAdmin(founder)) throw fail("BAD_FOUNDER", "founderEmail must be an approved admin among the college-less users.");
  } else {
    founder = legacyUsers.find(isApprovedAdmin) || null;
  }
  if (!founder && !(target.createdBy)) result.warnings.push("No approved college-less admin was found: the college will have NO administrator until you promote one (or register one) — sign-in to manage it will be impossible.");
  result.founder = founder ? { id: str(founder._id), email: founder.email } : (target.createdBy ? { id: str(target.createdBy), email: "(already set)" } : null);

  if (target.collegeId) {
    // Attaching to an existing college: a legacy student whose studentId is already active there would break the unique index.
    const taken = [];
    for await (const batch of pages(M.Student, NO_COLLEGE, "_id studentId")) {
      const ids = batch.map((s) => s.studentId).filter(Boolean);
      const hit = await M.Student.find({ collegeId: target.collegeId, isActive: true, studentId: { $in: ids } }).select("studentId").lean();
      taken.push(...hit.map((h) => h.studentId));
    }
    if (taken.length) throw fail("STUDENT_ID_CONFLICT", `${taken.length} legacy student id(s) already exist in the target college (e.g. ${taken.slice(0, 5).join(", ")}). Nothing was changed.`, { conflicts: taken });
    result.college = { collegeId: target.collegeId, name: target.name };
  }

  const relBefore = await relationshipReport(M, null);
  if (dryRun) {
    result.relationshipsBefore = relBefore;
    result.warnings.push("Dry run: nothing was written.");
    return result;
  }

  // ── 3. Fingerprint, create the college, stamp ─────────────────────────────
  const prints = {};
  for (const name of [...ALL]) prints[name] = await fingerprintBefore(M[name]);

  let collegeIdFinal = target.collegeId;
  if (!collegeIdFinal) {
    for (let attempt = 1; attempt <= 5 && !collegeIdFinal; attempt++) {
      const id = generateCollegeId();
      try {
        await M.College.create({ collegeId: id, name: target.new.name, country: target.new.country, district: target.new.district, dedupeKey: target.new.dedupeKey, status: "active" });
        collegeIdFinal = id; result.createdCollege = true;
      } catch (e) { if (e?.code !== 11000 || attempt === 5) throw e; }
    }
    result.college = { collegeId: collegeIdFinal, name: target.new.name };
  }
  log(`college ${collegeIdFinal}`);

  // Users first (their ownership is what the other migrations key on).
  result.stamped.User = (await M.User.updateMany(NO_COLLEGE, { $set: { collegeId: collegeIdFinal } }, IMMUTABLE_OK))?.modifiedCount ?? 0;
  for (const name of BULK) {
    result.stamped[name] = (await M[name].updateMany(NO_COLLEGE, { $set: { collegeId: collegeIdFinal } }, IMMUTABLE_OK))?.modifiedCount ?? 0;
    log(`${name}: ${result.stamped[name]}`);
  }
  for (const [name, field] of Object.entries(BY_NAME)) {
    let done = 0, merged = 0;
    for await (const batch of pages(M[name], NO_COLLEGE)) {
      for (const d of batch) {
        const clash = await M[name].exists(field ? { collegeId: collegeIdFinal, [field]: d[field] } : { collegeId: collegeIdFinal });
        if (clash) { merged++; continue; }
        try {
          done += (await M[name].updateOne({ _id: d._id, ...NO_COLLEGE }, { $set: { collegeId: collegeIdFinal } }, IMMUTABLE_OK))?.modifiedCount ?? 0;
        } catch (e) { if (e?.code === 11000) merged++; else throw e; }
      }
    }
    result.stamped[name] = done;
    if (merged) result.merged[name] = merged;
  }

  if (founder && !target.createdBy) {
    await M.College.updateOne({ collegeId: collegeIdFinal, createdBy: null }, { $set: { createdBy: founder._id } });
  }

  // ── 4. Verify ─────────────────────────────────────────────────────────────
  result.remaining = await counts(M, NO_COLLEGE);
  const perModel = {};
  let identical = true;
  for (const name of ALL) {
    const before = prints[name];
    const stampedIds = before.ids; // ids that were college-less before
    const after = await fingerprintAfter(M[name], stampedIds, collegeIdFinal);
    const mergedAway = result.merged[name] ?? 0; // left college-less on purpose
    const expectedCollege = before.count - mergedAway;
    const ok = mergedAway
      ? after.count === before.count && after.wrongCollege === mergedAway // merged rows keep collegeId null; hash check below is skipped for them
      : after.count === before.count && after.wrongCollege === 0 && after.hash === before.hash;
    if (!ok) identical = false;
    perModel[name] = { before: before.count, afterInCollege: expectedCollege, contentIdentical: mergedAway ? "n/a (merged by name)" : after.hash === before.hash, ok };
  }
  const relAfter = await relationshipReport(M, collegeIdFinal);
  // Orphans may only stay the same or shrink — compare the orphan counters, not totals (the target may have had rows already).
  const orphanKeys = ["subjectsWithoutTeacher", "sessionsWithoutSubject", "sessionsWithForeignTeacher", "alertsWithoutSubject", "studentsWithoutUploader"];
  const relationshipsPreserved = orphanKeys.every((k) => relAfter[k] <= relBefore[k]);
  result.verification = { identical, perModel, relationshipsBefore: relBefore, relationshipsAfter: relAfter, relationshipsPreserved };
  if (!identical || !relationshipsPreserved) result.warnings.push("VERIFICATION FAILED — restore the backup and investigate before going live.");
  if (sum(result.remaining)) result.warnings.push(`Rows still without a college: ${JSON.stringify(Object.fromEntries(Object.entries(result.remaining).filter(([, n]) => n)))} (see "merged").`);
  result.changed = sum(result.stamped);
  return result;
};
