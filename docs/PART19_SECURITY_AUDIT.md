# Part 19 — Security & tenant-isolation audit

> **Update (Part 20):** the "NOT EXECUTED" items below were executed in Part 20 with dependencies installed. The HTTP audit suite (R1–R12 + extras, 45 tests) now passes; running it exposed 6 test-harness/fixture faults (listed in `PART20_FINAL_REPORT.md`) and no new production vulnerability. Unresolved item 10 is stale: `STRICT_COLLEGE_MEMBERSHIP` exists. Unresolved item 12: `npm audit` was run (see Part 20).

**Read this first: the full backend suite could NOT be executed in the audit environment.**
`registry.npmjs.org` was blocked (HTTP 403 from the sandbox egress policy) and the ZIP ships no `node_modules`, so
Express, Mongoose and mingo (the fake Mongo the HTTP tests use) were unavailable. Everything below is labelled
**EXECUTED** (actually run, output seen) or **NOT EXECUTED** (written / reasoned, never run).

## 1. Method
* Read every route file, middleware, controller, service, util and model (backend only; frontend not audited).
* Grepped every model call outside `scopedModel`: all remaining direct calls are registration/login/search (by design), startup
  migrations, the nightly job (loops per college) and the teacher-approval / role services (explicit `collegeId` in every filter).
* Wrote two test files + a dependency-free fake model, mutation-checked the runnable ones.

## 2. Findings (all fixed unless stated)
| # | Severity | Finding | Fix |
|---|---|---|---|
| F1 | **High** | `server.js` served `/uploads` statically. Uploaded student rosters (names, roll and registration numbers) live under `uploads/colleges/<collegeId>/department/<dept>/<batch>/<shift>/<file>-<timestamp>.json`; the college id is public (college search), the rest is guessable. Any anonymous visitor could download another college's roster. | Static serving removed (nothing in the frontend uses it). Regression test reads `server.js`. |
| F2 | **Medium** | No throttling on `POST /auth/login`; unknown e-mails returned faster than wrong passwords (account enumeration by timing). | Failure limiters (per IP+e-mail, per IP) + constant-time dummy bcrypt compare. |
| F3 | Medium | `alerts/create`: a teacher could attach an alert to any subject of the college (not only theirs). Same college only. | Ownership check (admins exempt). |
| F4 | Medium | `scripts/seedAdmin.js` contained a hard-coded e-mail + password and created a college-less admin. | Reads env vars, min 12 chars, refuses duplicates. **Rotate that password if it is used anywhere.** |
| F5 | Low | CSV / Excel export did not neutralise `= + - @` prefixes (formula injection via student names / notes). | `neutralizeFormula` on every text cell. |
| F6 | Low | `sortMap[req.query.sort]`-style lookups (subjects, student directory, subject analytics, teacher performance): `?sort=__proto__` → 500. | `pickOwn` (own-property, string keys only). |
| F7 | Low | `scopedModel` update guard did not catch `$rename` onto `collegeId` or `collegeId.x` paths. Not reachable today (no controller passes client-built updates). | Both rejected. Unit-tested. |
| F8 | Low | Student `batch` unbounded (becomes a folder name + stored on every row). Path was already sanitised. | ≤ 50 chars on upload / create / update. |
| F9 | Low | Query strings parsed with `qs` (nested objects / operators) and urlencoded `extended: true`; controllers type-check, but defence in depth. | `query parser: simple`, `urlencoded extended:false`, JSON limit 1 MB. |
| F10 | Low | No baseline response headers. | `middleware/securityHeaders.js` (nosniff, frame deny, no-referrer, CORP, HSTS over HTTPS). |
| F11 | Info | Students / departments / shifts routers did not strip client `collegeId`. Nothing read it. | `stripClientTenantFields()` added. |
| F12 | Low | `alerts` analytics populated teacher/subject without a college `match`. | Pinned to the caller's college. |

**No cross-college read or write path was found** in the controllers: every data access goes through `scopedModel`/`scopeFilter`,
aggregations get a forced tenant `$match`, `$lookup`s are pinned, objects are loaded inside the caller's college (foreign ids → 404),
and the caller's college/role come from the database on every request, not from the token.

## 3. Test results
### EXECUTED (this environment)
| File | Result |
|---|---|
| `tests/securityAudit.unit.test.js` (new, dependency-free) | **29 / 29 pass** |
| `tests/collegeValidator.test.js` (existing) | 11 / 11 pass |
| `tests/studentValidator.test.js` (existing) | 7 / 7 pass |
| Mutation checks on the unit suite (remove tenant `$match`; unscope role-change target; unscope teacher decision) | each made a test fail; one equivalent mutant (caller-overridable `scopeFilter` order) is also guarded by an earlier throw |
| `node --check` on every backend `.js` file | OK |

### NOT EXECUTED
| File | Why |
|---|---|
| `tests/securityAudit.test.js` (new, ~45 HTTP tests, R1–R12 + extras) | needs express / mongoose / mingo |
| All 23 other pre-existing test files (≈470 tests; Part 17 baseline 486 pass / 3 skipped) | same. **They may be affected by my changes and have not been re-run.** |
Syntax is valid; **expect a few first-run failures** in the new HTTP file (assertions written against code I read, not observed output).

Existing tests worth re-running first: `routeAudit`, `authSecurity`, `teacherManagement` (they call `/auth/login`; limiters are 5–10 failures), `exportBackupIsolation`, `attendanceIsolation` (alert creation), `studentImport`.

## 4. Requirement → evidence
| # | Requirement | Evidence |
|---|---|---|
| 1–4 | Admin/Teacher A↔B cannot read/modify | R1–R4 sweep of ~45 id-addressed routes with B's real ids + byte-for-byte snapshot (NOT EXECUTED); scoping primitives EXECUTED (unit 2–8) |
| 5 | collegeId in body/query/header/token | R5 ×4 (NOT EXECUTED); strip/reject middleware EXECUTED |
| 6 | Pending / rejected teachers | session guard EXECUTED (unit 13); R6 ×4 over 14 endpoints (NOT EXECUTED) |
| 7 | Promotion forgery | role service + privileged-field guard EXECUTED (unit 9–12); R7 ×3 (NOT EXECUTED) |
| 8 | Student lookup | input validation + limiter EXECUTED; R8 ×4 (NOT EXECUTED) |
| 9 | Cross-college references | `loadOwnedResource` EXECUTED; R9 ×3 (NOT EXECUTED) |
| 10 | Batch delete / restore | R10 ×4 (NOT EXECUTED) |
| 11 | PDF / backups | backup signing EXECUTED; R11 ×5 (NOT EXECUTED) |
| 12 | Legacy single-college data | null-tenant scoping + cache bucket EXECUTED; R12 end-to-end (NOT EXECUTED) |

## 5. Unresolved issues and residual risks
1. **Test execution gap (above)** — run `npm ci && npm test` in `backend/` before deploying; treat the HTTP audit file as unverified until it is green.
2. **Public lookup uses the roll number as the only secret.** Rolls are guessable; the throttle is per IP and per process, so a distributed attacker can still enumerate a known department/batch/shift. Recommendation: add a second factor (registration number or date of birth).
3. **Rate limiters are in-memory, per process** (login, signup, lookup, backup). Behind several instances use a shared store.
4. **Any teacher can upload / replace students** (`/students/upload`, GET lists) for any department of their college. Not cross-college; decide whether uploads should be admin-only.
5. **Uploaded roster JSON files stay on disk forever** (PII at rest, no retention job) and a hard student delete leaves attendance rows.
6. **Teacher deletion orphans subjects** (open since Part 16); restore skips such subjects.
7. `runInTransaction` is not atomic on standalone MongoDB; TTL, unique-index conflicts during restore and performance were never run against real MongoDB.
8. Sign-up and registration reveal whether an e-mail exists (409). Password policy: ≥ 6 chars for teachers (≥ 8 + letter + digit for college admins).
9. Tokens last 7 days with no logout endpoint; revocation only via role change / delete / suspension (`authVersion`).
10. **Credentials:** the earlier ZIPs shipped a real DB password / JWT secret (Part 18 note) — rotate if not done. No `STRICT_COLLEGE_MEMBERSHIP` yet: set it to `true` once every account has a college.
11. Frontend was not audited (only the absence of `/uploads` use was checked); no browser or real-MongoDB testing.
12. Dependency audit (`npm audit`, e.g. `xlsx@0.18.5` has known advisories) could not be run offline.
