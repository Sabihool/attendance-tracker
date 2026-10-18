# Part 21 — Full project audit (folder, integration, tenant isolation)

Scope: the whole ZIP (281 files in 45 folders at intake: 21 controllers, 12 models, 25 route/middleware/service
modules, 38 utils, 29 test files, 90 frontend source files, 20 docs). Method: static review of every route, controller
query path, middleware and model; an automated frontend↔backend contract check (117 call sites / 85 API wrappers);
secret scan; dependency audit; build, lint, test and start-up runs.

## Verdict: NEEDS MORE WORK (no critical or high backend/security issue found)
Nothing found lets one college read or change another's data. The verdict is not "ready" because the checks below
could not all be run or did not all pass (no MongoDB in the audit environment; ESLint still reports the new
react-hooks style rules). See "Still required before deployment".

## Findings
| # | Sev | Status | Where | Issue |
|---|-----|--------|-------|-------|
| 1 | High | Fixed | frontend/src/pages/admin/AdminTrashPage.jsx | Global Trash read `item.subjectName` / `item.teacherName`; API returns populated `subjectId{}` / `teacher{}` objects → React "Objects are not valid as a child" crash on any trashed session |
| 2 | High | Fixed | frontend/src/pages/teacher/StudentReportsPage.jsx | "View details" navigated to `/teacher/student-report` (no such route → 404); real route is `/teacher/individual-report` |
| 3 | Medium | Fixed | AdminTrashPage.jsx | Only the first 20 records were ever fetched (server default limit) while client paging/stat cards implied more; now server-side paging |
| 4 | Medium | Fixed | frontend/src/pages/teacher/TeacherDashboardPage.jsx | "Attendance Trend" chart plotted `Math.random()` values; now computed from real session summaries (`utils/attendanceTrend.js`), empty months show a gap |
| 5 | Medium | Fixed | frontend/src/lib/axios.js, context/AuthContext.jsx | 403 codes ACCOUNT_REJECTED / COLLEGE_SUSPENDED / COLLEGE_UNAVAILABLE / NO_COLLEGE / ACCOUNT_PENDING mid-session did not end the session; a network error or 5xx on `/auth/me` at page load logged the user out |
| 6 | Low | Fixed | backend/controllers/departmentController.js | `sendSuccess(res, data, 201)` put 201 in `message` and answered HTTP 200; now 201 + message (existing tests that asserted 200 updated; regression test added) |
| 7 | Low | Fixed | axios.js | Export/backup download errors (blob responses) lost the server message; JSON error blobs are now decoded |
| 8 | Low | Fixed | ConsecutiveAbsenceAlertsPage.jsx | Department/batch filter lists were built from the already-filtered alerts and shrank after filtering |
| 9 | Low | Fixed | axios.js | Production build without `VITE_API_URL` silently targeted localhost; now logs a clear console error |
| 10 | Low | Fixed | backend/utils/creditUtils.js | `console.log` per student per credit calculation (log noise + student ids in logs) removed |
| 11 | Low | Open | frontend lint | `npm run lint`: 32 errors / 8 warnings, all from the new `react-hooks` v7 rules (set-state-in-effect ×24, immutability ×6 = handler declared after the effect that calls it, static-components ×2 in CreateSubjectPage). None breaks build or runtime; refactor deliberately rather than mass-edit working pages |
| 12 | Low | Open | backend `xlsx` dependency | `npm audit`: SheetJS advisories (prototype pollution / ReDoS) with no npm fix. The app only WRITES workbooks (exportController), never parses uploaded spreadsheets, so the vulnerable code path is not reachable; formula-injection is already guarded by `safeSheet`. Re-evaluate if spreadsheet import is ever added |
| 13 | Medium | Open (needs decision) | frontend | Backend routes `/api/admin/backups/*` (download / preview / restore) and `/api/admin/activity` have API wrappers but NO UI. Not a bug, but admins cannot reach these features from the app. Adding a page is a new feature, so it was not built without approval |
| 14 | Info | Open | frontend/src/components | Unused components kept (verified unreferenced, purpose unclear): `ui/AttendanceTable.jsx` (hard-coded mock students), `ClassCard`, `StatCard`, `AdminStatCard`, `NotificationBell`, `forms/ExportModal` |
| 15 | Info | Packaging | backend/*.whl | Three Python wheels (pymongo, dnspython, pymongo_inmemory, 1.4 MB) were in `backend/`. Referenced by nothing in the project (a Node app), so they are left out of the delivered ZIP |

## Multi-college / security review (no defects found)
* Every controller query goes through `scopedModel` / `scopeFilter` / `scopedAggregate` (college always taken from the
  database session, last in the filter; `collegeId` in an update is refused; `$lookup`/`$unionWith`/`$graphLookup`
  guarded). Raw `Model.*` calls remain only in auth, college registration, session, approval, management and migration
  services, and each is filtered by the caller's `collegeId` or a user id.
* `populate()` calls are pinned with `match: {collegeId}`; the trash `$lookup` pins the college in its sub-pipeline.
* Auth: JWT algorithm pinned; role/approval/college/`authVersion` re-read from the database on every request;
  `authorize` trusts only the database role; client `collegeId`/`tenant` keys stripped; query parser is `simple`
  (no `a[$ne]` operator injection); passwords bcrypt cost 12, `select:false`; login timing equalised; rate limits on
  login, signup, college register/search, public lookup, backups.
* Signup can only create a PENDING teacher of an ACTIVE college; admins only via college registration.
* Backups: signed, college-bound, merge-only restore, foreign records refuse the whole file; `/uploads` is not served.
* Secret scan: no real secrets in the ZIP; only `.env.example` files. Production start refuses weak JWT secret /
  missing CLIENT_URL (verified).

## Test report (commands actually run)
| Command | Result |
|---|---|
| `node --check` on every backend `.js` | pass (no syntax errors) |
| `backend: npm test` (before changes) | 581 tests: 578 pass, 0 fail, 3 skipped |
| `backend: npm test` (after changes) | 582 tests: 579 pass, 0 fail, 3 skipped |
| `frontend: npm test` (before / after) | 39 pass / 43 pass (4 new) |
| `frontend: npm run build` | pass (before and after) |
| `frontend: npm run lint` | FAIL: 32 errors, 8 warnings (same set before and after; finding 11) |
| `npm audit --omit=dev` backend / frontend | 1 high (xlsx, finding 12) / 0 |
| Start `node server.js` with dev env, no MongoDB | listens, then exits with a clear "MongoDB connection failed" |
| Start with `NODE_ENV=production`, weak secret | refuses to start (as designed) |

Not run: the 3 skipped tests need a real MongoDB (`TEST_MONGO_URI`): registerCollege, college-search index use and
teacher-approval races. No MongoDB is available in the audit environment, so the other 579 tests run against the
project's in-process Mongoose/mingo fake. Unique-index behaviour, transactions (`runInTransaction`) and migrations
have therefore NOT been exercised against a real server. Live API calls from the built frontend were not performed.

## Still required before deployment
1. `TEST_MONGO_URI=<disposable db> npm test` in `backend/` and confirm the 3 integration tests pass (never use production).
2. Run `npm run migrate:legacy-college`, then set `STRICT_COLLEGE_MEMBERSHIP=true` (see docs/MIGRATION_AND_BACKUP.md).
3. Set `VITE_API_URL` before building the frontend; set strong `JWT_SECRET`, `CLIENT_URL` (https) in the backend.
4. Decide on findings 11, 13.
