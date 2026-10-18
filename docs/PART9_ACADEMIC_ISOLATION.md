# Part 9 — Departments, Batches and Shifts isolation

A "class" is still `department + batch + shift` (no Class model). Those three now live inside a college.

## Ownership model
| Collection | Change |
|---|---|
| `Department`, `Shift` | new immutable `collegeId`; name unique **per college**, case-insensitive (collation index `{collegeId, name}`) |
| `Student` | new immutable `collegeId`; all three unique rules are per college (`{collegeId,studentId,dept,batch,shift}`, partial `{collegeId,studentId}`, partial `{collegeId,roll,dept,batch,shift}`) |
| `Subject` | new immutable `collegeId` (stamped from the creating user's session); `{subjectCode,teacher}` unchanged (a teacher has one college) |
| Batch | still no collection — it is a string on Student/Subject, so it is isolated by their `collegeId` |

The college always comes from `req.tenant` (database session → `tenantContext`), never from body/query/URL. All queries go through `scopedModel(Model, req.tenant)`; aggregations get the tenant `$match` first. Another college's id → **404**, same as a missing id.

## Behaviour by area
- **Departments / shifts**: list, create, rename, delete scoped. Rename propagates only to the college's students/subjects. Delete is still blocked while the college's active students or any subject (teacher-assigned) use it; other colleges' usage is not counted.
- **Batches**: `/students/batches`, `/groups`, upload, admin CRUD, directory and **group (batch) deletion** touch only the caller's college. Uploaded files are stored under `uploads/colleges/<collegeId>/…` (legacy path kept for college-less data).
- **Cross-college references**: subject/student department & shift are validated against the caller's college lists; teacher/student ids of other colleges resolve to "not found".
- **Counts/dashboards**: academic structure tree + summary, student directory (attendance stats limited to the college's subjects), teacher performance, subject analytics, admin trash stats/list, student analytics and alert creation.
- **Auth**: `GET /departments`, `/shifts`, `/subjects/meta` are no longer public.
- Hardening: names are regex-escaped (`C++`, `Arts (Hons)` used to break the lookup); non-string body/query values are rejected.

## Defaults and migration
- New colleges get their own default departments/shifts at registration (best effort); start-up seeds colleges that have none.
- **Existing databases** must drop the old global unique indexes (`departments.name_1`, `shifts.name_1`, `students.studentId_1`, `studentId_1_department_1_batch_1_shift_1`, `roll_1_department_1_batch_1_shift_1`, `department_1_batch_1_shift_1`, `subjects.department_1_batch_1`) — otherwise a second college still cannot reuse a name. `utils/academicBackfill.js` does this, stamps subjects (by teacher) and students (by uploader) with their college, and copies the legacy department/shift lists to colleges that have none. Runs at server start and via `npm run migrate:academic`; idempotent. Rows whose owner has no college stay `collegeId: null` (visible only to college-less legacy accounts).

## Tests
- Backend `npm test`: **188 tests (185 pass, 3 skipped, 0 fail)**. New: `academicIsolation.test.js` (26, real routers/controllers/models over HTTP, two colleges with identical names), `academicMigration.test.js` (13), route audit updated.
- Frontend `npm test`: **23 pass** (15 + 8 new, `academicStructure.test.js`). `vite build` succeeds.
- Harness: `tests/helpers/mongooseFake.js` runs the real Mongoose models on a mingo-backed fake driver that **enforces unique / partial / collation indexes**. Mutation-checked: removing scoping in any of ~14 places, or reverting any unique index to a global one, fails tests.

## NOT verified
No real MongoDB was available. The fake driver is not a server: the migration's `dropIndex`/`createIndexes` calls, collation index behaviour and transactions have **not** run against MongoDB/Atlas. Frontend screens were syntax-checked and built, not exercised in a browser.

## Part 10 handoff
1. **Run on a copy of production first**: `npm run migrate:academic`, then verify with `db.students.getIndexes()` etc. that no legacy global unique index remains and the new ones exist. Index build fails if existing data already violates a new unique rule (e.g. case-variant department names) — check the start-up log.
2. **Attendance has no `collegeId`**; its college is its subject's (used everywhere above). Add `collegeId` to `Attendance` and `ConsecutiveAbsenceAlert` (student ids repeat across colleges, so alert/attendance keys by `studentId` should become college-aware), then drop the subject-id `$in` filters. Alerts `{studentId, subjectId}` remain safe only because subject ids are unique.
3. **Still global**: `AttendanceCategory` (`GET /api/attendance-categories` is the last public route; `creditType` lists in `/subjects/meta`) and `Settings` (consecutive-absence limit). Make both per college.
4. `express.static('uploads')` serves uploaded student files publicly by URL; filenames are timestamped but guessable folders. Serve behind auth or store outside the web root.
5. Legacy `collegeId: null` accounts/data are an isolated bucket nobody real can see. Decide: assign to a college via script, or add a platform super-admin.
6. Start-up re-seeds default departments/shifts for a college that deleted all of them (same as the old global behaviour) — add a "seeded" flag on `College` if undesirable.
7. Existing Part 8 items still open: college suspend/reactivate UI, email notifications, rotate secrets in the shipped `.env` files, per-process rate limiter.
8. Reuse `tests/helpers/e2eApp.js` (+ `mongooseFake.js`) for Part 10 attendance tests; run `TEST_MONGO_URI` integration tests on a real server.
