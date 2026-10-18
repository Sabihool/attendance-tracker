# Part 12 — Attendance and credit system (college-aware)

Every part of attendance and credit now belongs to a college: sessions, categories and their credit values, streak alerts and the streak threshold. **No academic rule and no formula changed** (see "Rules that did not change"). **A migration is required** — `npm run migrate:attendance` (also run automatically at server start-up).

## What changed
| Area | Before | Now |
|---|---|---|
| `Attendance` | no `collegeId`; college = its subject's (or its teacher's, for the admin guard) | own `collegeId` (immutable, server-set). All indexes lead with it. Every read/update/delete goes through `scopedModel(Attendance, req.tenant)`; aggregations through `scopedModel(...).aggregate` / `scopedAggregate` (tenant `$match` forced first) |
| `AttendanceCategory` | **global** (unique `name`), rename/delete ran across **all** colleges | per college: `collegeId` + unique `{collegeId, name}` (case-insensitive collation). Rename propagation and the "in use" check only touch the caller's college. `GET /attendance-categories` is now authenticated (it was the last public route) |
| `ConsecutiveAbsenceAlert` | no `collegeId` | own `collegeId`; unique `{collegeId, studentId, subjectId, removed:false}`. Alerts are created, listed, noted and removed inside the caller's college |
| `Settings` (streak threshold) | one global document: one college's admin changed it for everyone | one document per college (`collegeId`, unique). `GET/PUT /settings` act on the caller's college |
| `credit` helpers | read global categories | `findCategoryByName(tenant, name)`, `getCategoryMaps(tenant)`, `getCategoryCreditMap(tenant)`, `getCategoryNames(tenant)` — tenant is the first argument; calling without one throws (fail closed) |
| Routes | attendance/export had no `tenantContext` | attendance, export, trash, alerts, categories, settings all run `tenantContext` + `stripClientTenantFields()` (a client `collegeId`/`tenant…` in body or query is dropped) |
| `requireAttendanceOwner` | looked up by id, then for admins inferred the college from the **teacher's user record** | looks up inside the caller's college by the record's own `collegeId`; the old teacher-based fallback is deleted. Another college's session id → 404, identical to a missing id |

## Same-college validation when a session is recorded (`validateSessionOwnership`)
`POST /api/attendance/:subjectId` now proves, before anything is written:
| Thing | Rule | Failure |
|---|---|---|
| subject | loaded inside the caller's college by `requireSubjectOwner`, re-checked in the controller | 404 |
| teacher | the subject's assigned teacher must be a user of the same college | 400 `This subject's teacher does not belong to your college.` |
| category | resolved among the **caller's college's** categories (another college's `Workshop` does not exist here) | 400 `Invalid attendance category` |
| students | every `studentId` must be an **active** student of the college | 400 `students[i]: student "X" was not found in your college.` (unknown and foreign ids give the same answer) |
| batch | each student must be in the subject's own department + batch + shift (case-insensitive) | 400 `…not in this subject's department, batch and shift.` |
| roster | no duplicate ids | 400 |
The stored `name`/`roll` now come from the student record, not the request, and the session is stamped with the college. `collegeId`, `teacher`, `subjectId` in the body are ignored (the first is stripped; the others were never read from the body).

## Rules that did not change
Teachers pick subject/date/category; categories and credits are admin-managed (defaults Theory 1, Lab 3, Tutorial 2); `classWeight` is a snapshot taken at save time (editing a category's credit never rewrites history; per-session `creditValue` override still works, 0–20); attendance %, weighted totals, credit score (`calculateCreditScore`), streak counting and the alert rules (create at the threshold, keep count in sync, kept until removed) are the same code. The UI is untouched. A golden-value test pins the formulas.

One **verified bug fixed**: `ConsecutiveAbsenceAlert.consecutiveMissCount` had `min: 3`, while Settings lets an admin choose a threshold of 1–100. With a threshold of 1 or 2 the alert failed validation and the error was swallowed, so **no alert was ever raised**. `min` is now 1.

## Migration (`utils/attendanceBackfill.js`, `npm run migrate:attendance`)
Run after `migrate:academic` (the script does both; both idempotent). It:
1. drops the global `name_1` category index, builds the college-led indexes, then drops the superseded attendance/alert indexes;
2. stamps `Attendance` and alerts with **their subject's** `collegeId` (`timestamps:false`, so `updatedAt` is not touched);
3. gives every college a copy of the legacy category list with its configured credits (plus any category name its own sessions/subjects already use, credit = legacy value → built-in default → 1) and a copy of the legacy streak limit;
4. reports (does not change) rows it cannot assign and sessions whose teacher is not in the session's college.
It never edits, deletes, re-dates or re-weights a record, a roster entry, a `classWeight` snapshot, an alert count or note. Tested: every session is byte-identical apart from `collegeId`; second run changes nothing; API numbers before = after. Rows whose subject has no college (legacy college-less accounts, orphans) keep `collegeId: null` and are invisible to real colleges.
**During start-up** the migration runs before the first seed but requests can arrive while it does; attendance not yet stamped is invisible until it finishes. For large databases run the script ahead of the deploy.

## Seeding
`services/categoryDefaults.js`: `seedCollegeCategories(collegeId)` (only if the college has none), `seedAllCategories()` at start-up, and college registration seeds the new college (best effort, like departments/shifts).

## Bulk operations / aggregations reviewed
Scoped: category rename (`Subject` + `Attendance` `updateMany`), subject re-assignment and deletion (attendance + alerts), empty-trash, restore/permanent delete, admin trash list/stats (the `$lookup` of teacher names is restricted to the same college), student directory stats, student analytics, subject analytics + meta, teacher performance, exports. **Nightly trash purge (`runTrashCleanup`):** a scheduler job with no caller; since Part 16 it runs college by college through `scopedModel` and only removes sessions already in the trash for more than 10 days (see `PART16_DELETION_INTEGRITY.md`).

## Behaviour changes to be aware of
- Posting a roster with a student who is not an active student of the subject's department/batch/shift in that college is now **400** (before, any strings were accepted). The Take Attendance page already posts only those students.
- A duplicate student in one roster is 400 (it used to be double-counted).
- `GET /attendance-categories` needs a login; `GET/PUT /settings` and categories are per college.
- Teacher-name mismatches in trash stats show no name instead of leaking another college's.
- Deleting a category is no longer blocked by another college's use of the same name; renaming no longer rewrites other colleges' data.
- Category names are regex-escaped in rename/delete checks (a category called `C++` used to break them), and `classType` filters on attendance/export are escaped too.

## Tests
- Backend `npm test`: **326 tests (323 pass, 3 skipped, 0 fail)**, two consecutive full runs. New: `tests/attendanceIsolation.test.js` (57) and `tests/attendanceMigration.test.js` (9). Updated fixtures in `subjectIsolation`, `academicIsolation`, `studentImport`, `tenantAuthorization`, `routeAudit` (they now set `collegeId`, create rosters/categories per college; the audit has no open routes left and requires `tenantContext` on the attendance routers). `e2eApp.js` mounts the category and settings routers.
- Covered: creation (stamping, credits Theory/Lab/Tutorial, override, case-insensitive category, duplicates, future date, validation); same-college proof for subject/teacher/student/batch/category (foreign, inactive, unknown, other batch/dept/shift, duplicates, corrupt teacher); forged `collegeId`/teacher/subject in body and query; edit/trash/restore/permanent delete/empty, byte-identical records after cross-college attempts, foreign id ≡ missing id; the nightly purge across colleges; exact attendance %/credit numbers, snapshot kept after a credit change, two colleges with different Lab credit, analytics/directory never mixing the same student id; streaks (create at 3, update at 4, reset, per-college threshold, no cross-college counting, one alert per college, notes/removal isolation, manual alerts, tenant mismatch); categories (per-college lists, names unique per college, cross-college edit/delete 404, scoped rename and delete, regex names); aggregations (subject analytics/meta, teacher performance, trash stats); index/schema contracts; migration (history intact, categories/settings copied, indexes, idempotence, API parity) and seeding.
- Mutation checks: making each of these unscoped fails tests — student lookup in session creation (38), category rename propagation, credit maps. Making the attendance list query, the streak read and the owner guard unscoped does **not** fail a test, because the `subjectId` filter / subject-URL check already confines them (they are defence in depth, not the only barrier). The settings and trash-model mutations were started but the run timed out, so they are **unverified**.
- One of four full runs reported `tests/attendanceMigration.test.js` as failed at file level; it did not reproduce in 2 further full runs and 6 parallel runs of that file, and I did not find the cause.

## NOT verified
- No real MongoDB: the migration, index drops/builds (collation index, partial unique index), the `$lookup` with `let/pipeline` and transactions ran only on the mingo-backed fake driver. The 3 `TEST_MONGO_URI` tests remain skipped. Try `npm run migrate:attendance` on a copy of production data first.
- Frontend: no frontend code changed; I did not re-run its tests or build, and did not exercise pages in a browser.

## Part 13 handoff
1. **Run the migration on a copy of real data** and read its report: `unassigned` (college-less subjects/orphans) and `teacherMismatches` need a human decision. Then consider dropping the `collegeId: null` bucket.
2. **Authorship vs ownership** (open since Part 11): `Attendance.teacher` and `Alert.teacherId` are still overwritten on subject re-assignment, and an admin who records a session becomes its `teacher`. Add an immutable `takenBy` if audit or Teacher Performance needs "who took this".
3. **Alert permissions are unchanged**: only the owning user (`teacherId`) lists/notes/removes an alert; admins see alert history read-only on Student Analytics. If "admins manage streak notes" should mean any alert of their college, add an admin branch in `alertsController` (the college scoping is already in place). Also any teacher can still create a manual alert for any subject/student of their college (not limited to their own subjects).
4. **N+1 in the streak check**: `checkAndCreateAlerts` re-reads the subject's sessions once per student. Fine for classes of tens, worth batching for large rosters.
5. **Alert count can't drop below the threshold**: when a streak falls under the limit the alert stays with its old count unless an absence edit lowers it to ≥ the limit (existing behaviour; only the `min` was fixed). Decide whether such alerts should auto-resolve.
6. Remaining unscoped/global bits: the trash purge (intentional), `express.static('uploads')`, Part 8 items (suspend UI, e-mail notifications, shipped `.env` secrets, per-process rate limiter), batch is still free text on a subject.
7. Conventions to keep: tenant comes only from `req.tenant`; new college-owned models need `collegeId` (immutable) and college-led indexes, and go through `scopedModel` / `scopedAggregate`; add the router to the `scoped` list in `tests/routeAudit.test.js`; add legacy index names to the migration's drop lists.
