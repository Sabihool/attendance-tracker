# Part 13 — Analytics and performance dashboards (college-specific)

Every dashboard number now comes from the authenticated admin's/teacher's own college. Most of this was already true after Parts 9–12 (all dashboard queries went through `scopedModel` / `scopedAggregate`); Part 13 audited each one, closed the gaps below, added guards so the gaps cannot reopen, made the dashboards cheaper, and added 45 tests. **No formula, chart or business rule changed. No migration is required** (new indexes are built by Mongoose at start-up and by `npm run migrate:attendance`).

## Audit result — what each feature reads
| Feature | Endpoint(s) | Scoping | Verdict |
|---|---|---|---|
| Admin dashboard | `/auth/users`, `/admin/trash/stats` | users filtered by the admin's `collegeId`; trash stats via `scopedModel` + `$lookup` pinned to the college | scoped; **display bug fixed** (below) |
| Teacher performance | `/admin/teacher-performance` (+ `/summary`, `/departments`) | `scopedModel` for users, subjects, attendance, students | scoped |
| Subject analytics | `/admin/subjects` (+ `/meta`) | `scopedModel` | scoped |
| Student attendance analytics / credit summary | `/alerts/student/:id/analytics`, `/students/directory` | `scopedModel`, `scopedAggregate` | scoped; **route was open to teachers — fixed** |
| Department / batch statistics | `/admin/academic-structure` (+ `/summary`), `/students/groups`, `/students/batches` | `scopedModel` | scoped |
| Attendance % per subject | `/attendance/:subjectId[/percentage|/dates]` | `requireSubjectOwner` (college first, then teacher) | scoped |
| Teacher activity | same as teacher performance | | scoped |
| Streak reports | `/alerts`, streak check after each save | `scopedModel`; per-college threshold | scoped; **N+1 removed** |
| Trash statistics | `/admin/trash/stats` | | scoped |

## What changed
### Security / isolation
1. **`GET /alerts/student/:studentId/analytics` is admin-only.** It was `authorize("admin","teacher")`, though its own header says "Admin-only" and the only page that calls it (Student Analytics) is admin-only. A teacher could read every student's cross-subject attendance and **other teachers' alert history (names, e-mails)** for their college. Now a teacher gets 403. *Behaviour change.*
2. **Ownership first.** `utils/analyticsScope.js`: `findOwnedStudent(tenant, studentId)` and `findOwnedTeacher(tenant, teacherId)` prove the student/teacher is in the caller's college before any statistic is computed. Foreign, unknown, malformed, over-long and operator-shaped ids are all `null` → one identical 404. An active student wins over a removed record that reused the number. (Subjects keep using `requireSubjectOwner`.)
3. **New optional filter `GET /admin/subjects?teacherId=`** (teacher drill-down, not used by the UI yet): the teacher is validated with `findOwnedTeacher`; foreign/unknown/malformed/admin/array ids → 404.
4. **`scopedAggregate` now refuses stages that can read another college's rows.** The forced first-stage `$match` only limits the pipeline's *input*; a `$lookup`/`$unionWith`/`$graphLookup` reads a second collection unfiltered. Refused: `$out`, `$merge`, `$unionWith`, `$graphLookup`, `$lookup` in localField/foreignField form, and any `$lookup` whose sub-pipeline does not *start* with a `$match` pinning `collegeId` to the tenant (checked recursively, also inside `$facet`; a pin inside `$or` or with an operator does not count). The existing trash-stats `$lookup` already had the right shape.
5. **Static audit test** fails if any controller/service/middleware/util calls `.aggregate()` on a bare model, touches `.collection`, uses `$unionWith`/`$graphLookup`, or writes a `$lookup` without a pipeline. (`scripts/explainAnalytics.js` is read-only tooling and not scanned.)

### Performance
- **One attendance scan instead of two** in Subject Analytics: grouped by (subject, session type) and rolled up in JS. Totals, last date and "most-used type" are identical (golden test).
- **Streak check reads a subject's sessions once per roster**, not once per student (Part 12 handoff item 4). `countTrailingAbsences` is the same counting rule, now a pure exported function.
- `getAttendance` / `getAttendancePercentage` load sessions and the credit map in parallel.
- **Per-college dashboard cache** (`utils/analyticsCache.js`) for teacher performance, subject analytics and academic structure (list + summary share one computation). Key = `collegeId` + dataset + variant; no entry can be read without naming a college (`∅` for the legacy college-less tenant); concurrent requests share one computation; failures are not cached; bounded to 500 entries. TTL 15 s (`ANALYTICS_CACHE_TTL_MS`, `0` = off; off by default under `node --test`). **Any successful POST/PUT/PATCH/DELETE through a route that runs `tenantContext` drops that college's entries immediately**, so an admin sees their own change on the next view; other colleges' entries are untouched. Changes that bypass those routes (scripts, the nightly purge, another server process, teacher approval via `/admin/teacher-requests`, which does not run `tenantContext`) appear within the TTL.
- **Indexes** (all lead with `collegeId`): `Attendance.analytics_by_subject` `{collegeId, isDeleted, subjectId, classType, date, summary.presentCount, summary.totalStudents}` and `Attendance.analytics_by_teacher` `{collegeId, isDeleted, teacher, date, summary.presentCount, summary.totalStudents}`. They carry every field the dashboard `$group` stages read, so MongoDB *can* answer them from the index without loading each session document (which embeds the whole roster). Cost: two more index entries per session written. Reviewed and kept as they were: Student `{collegeId,isActive,department,batch,shift}`, Subject `{collegeId,…}`, User `{collegeId,role,approved,createdAt}`, alerts `{collegeId,…}`. A test checks that every dashboard query shape has a college-led index and that no compound index on a college-owned model lacks `collegeId` first except a documented allow-list (nightly purge, `{subjectCode,teacher}`, `{teacher,createdAt}`, `Notification`, `College`).
- **Scaling with the number of colleges:** every dashboard query starts from `{collegeId: …}` on a college-led index, so cost depends on one college's data, not on how many colleges exist. In-memory filtering/paging runs on that one college's rows only.

### Fixed along the way
- **Admin Dashboard "Trash items" card always showed 0**: it read `data.totalItems`, which the API never returned (`/admin/trash/stats` returns `system.totalTrashedRecords`). One-line frontend fix. (The Admin Trash page already read the right field.)

## Rules that did not change
Attendance % formulas (subject: credit-weighted; directory/student analytics: session counts; teacher/subject analytics: Σ present ÷ Σ roster), credit score, status buckets (Critical <50, Warning <65, Good <75, Excellent), streak rule and threshold, "most/least active", inactivity (14 days), pagination/sort/filter semantics, all response shapes. Golden-value tests pin them.

## Tests
- Backend `npm test`: **371 tests (368 pass, 3 skipped, 0 fail)** — the 326 from Part 12 plus 45 new in `tests/analyticsIsolation.test.js`. Frontend: 29 pass; `vite build` succeeds.
- Two colleges with **identical** department, batch name `2024`, shift, subject codes and student ids (S-1…) but different data; each dashboard asserted exact numbers for both: student groups/batches, directory (%, classes, credit score, status, filters, computed sort), academic structure + summary, subject analytics, teacher performance + summary, student analytics + credit breakdown, per-college Lab credit, streak reports with different thresholds, trash stats; and a test that recording/editing/trashing/deleting/adding students in college B leaves a full snapshot of college A byte-identical.
- Ownership: foreign student ≡ unknown ≡ over-long id (same 404 body, no data); teacher refused on student analytics; teacher drill-down (foreign, unknown, malformed, admin, array ids); foreign subject ≡ missing subject on percentage/dates/list/export; another teacher's subject 403; role rules on every dashboard; forged `collegeId`/`college`/`tenantId`/`college_id` in the query string changes nothing on 11 dashboard endpoints.
- Aggregation guard: tenant match first and caller's hostile `$match` cannot replace it; 12 refused stage shapes; allowed shapes; a guarded `$lookup` run on the fake DB; static audit.
- Cache: keyed per college (incl. legacy tenant and a hostile NUL-containing id), fails closed without a tenant, expiry/sharing/no-caching-of-failures/TTL 0, per-college invalidation (not a prefix clash `COL-A` vs `COL-AB`), bounded size, TTL resolution, and end-to-end (reads cached per college; API write refreshes only the writer; failed write and GET do not invalidate; sorting never corrupts cached rows).
- Streak batching: one read per roster, same alerts/counts; mismatched tenant writes nothing and reads nothing.
- **Mutation checks** (each made the new tests fail, run one at a time): tenant `$match` removed from `scopedAggregate`; cache key without the college; student analytics open to teachers; `findOwnedTeacher` unscoped; `$lookup` guard removed; unscoped `Student.aggregate` in teacher performance and in subject analytics; student analytics not using `findOwnedStudent`; invalidation on failed writes / clearing all colleges / no invalidation.
- The full suite takes ~4 minutes (bcrypt, 12 rounds, in every test setup).

## NOT verified
- **No real MongoDB.** Everything ran on the mingo-backed fake driver. In particular I have **not** confirmed that the two new indexes make the dashboards *covered* queries, nor index selection in general. Run `npm run explain:analytics -- <collegeId>` against a copy of real data and read "fetches documents".
- The cache is per process: with several server instances each has its own, and writes on one instance do not invalidate another's (they expire by TTL).
- No browser run of the pages. Frontend lint reports one pre-existing `react-hooks/set-state-in-effect` error in `AdminDashboardPage.jsx` (the `load()` call inside `useEffect`); it is not from this change.
- Not load-tested: "performant as colleges increase" is argued from the query shapes and index design, not measured.

## Behaviour changes to be aware of
- Teachers get **403** on `/alerts/student/:id/analytics` (was 200 for any student of their college).
- Dashboards may lag out-of-band changes by up to 15 s (see cache); set `ANALYTICS_CACHE_TTL_MS=0` to disable.
- A `scopedAggregate` pipeline with an unscoped `$lookup`/`$unionWith`/`$graphLookup` now throws `TenantScopeError` (500) instead of running — a programming error surfaced early. No existing pipeline was affected.

## Part 14 handoff
1. **Run `explain:analytics` on real data** (see above) and confirm the two analytics indexes are used and covered; drop one if unused. Build them on a large production collection off-peak.
2. **Teacher dashboard is 2 requests per subject** (`getAll` + `getPercentage`, each returning every session with its full roster). That is the heaviest remaining read. Suggest one `GET /api/subjects/summary`-style endpoint that returns per-subject totals via `scopedAggregate` (the covered index fits it), and have the page use it.
3. **Three definitions of "attendance %" exist** and were deliberately left alone: subject reports use credit-weighted session weights; directory + student analytics count sessions (1 each); teacher performance / subject analytics use Σ present ÷ Σ roster rows. Decide with the college whether to unify (that is a business-rule change).
4. **Filtering/sorting/paging for subject analytics, teacher performance and academic structure is still in memory** over the college's whole dataset (now cached). Fine for hundreds of subjects/teachers; for very large colleges move filter + `$skip/$limit` into the pipeline.
5. **Invalidation gaps:** teacher approve/reject (`/admin/teacher-requests`, `/auth/users/*`) does not run `tenantContext`, so teacher-performance lists lag up to 15 s after an approval. Either mount `tenantContext` there or call `analyticsCache.invalidate(tenant)`.
6. `/auth/users` (used by the Admin Dashboard counts) returns at most 500 users and counts them in the browser; a count endpoint would be cheaper and exact.
7. `teacherId` filter on `/admin/subjects` exists and is tested but no page uses it; Teacher Performance could link a row to "this teacher's subjects".
8. Still open from Part 12: authorship vs ownership (`takenBy`), admin management of streak notes, auto-resolving alerts that fall below the threshold, `express.static('uploads')`, Part 8 items (suspend UI, e-mail notifications, shipped `.env` secrets, per-process rate limiter), batch is still free text on a subject. Closed in this part: the streak-check N+1.
9. Non-college-led indexes that remain (documented in the index test): Subject `{subjectCode,teacher}` (unique) and `{teacher,createdAt}` (superseded by `{collegeId,teacher}`; can be dropped with a migration), the nightly-purge index, `Notification`, `College`.
10. Conventions to keep: tenant only from `req.tenant`; analytics about one student/teacher start with `findOwnedStudent` / `findOwnedTeacher` (subjects: `requireSubjectOwner`); aggregations only through `scopedModel(...).aggregate` / `scopedAggregate`, with any `$lookup` in the `let`/`pipeline` form and its first stage a `$match` pinning `collegeId`; new dashboard datasets go through `analyticsCache.get(req.tenant, name, compute)` and are copied before sorting; new routers run `tenantContext` (that also wires invalidation) and are added to `tests/routeAudit.test.js`.
