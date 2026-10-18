# Part 15 handoff — after Part 14 (Public Student Attendance Lookup)

## What Part 14 added
**Students can see their own attendance with no login or signup** at `/see-attendance`
(linked from the home page). Flow: search college → pick it (name, district, country shown) →
enter department, batch, shift, roll → individual analytics.

### Backend
| File | Purpose |
|---|---|
| `routes/publicAttendanceRoutes.js` | `POST /api/public/attendance/lookup` (public, mounted in `server.js`) with three rate limits |
| `controllers/publicAttendanceController.js` | Resolves + validates college, finds the student, computes analytics, returns a whitelisted response |
| `validators/publicLookupValidator.js` | Strict input validation (plain strings only, trimmed, length caps, no control chars, `COL-…` id pattern) |
| `utils/studentAnalytics.js` | `computeStudentAnalytics(tenant, student)` — extracted from the admin controller; used by BOTH admin and public paths |
| `middleware/rateLimit.js` | New `createFailureLimiter` (only 4xx responses count) |
| `controllers/alertsController.js` | `getStudentAnalytics` now calls the shared function (same output as before) |
| `tests/publicAttendanceLookup.test.js` | 21 tests (see below) |

### Frontend
`pages/public/SeeYourAttendancePage.jsx`, `utils/publicLookup.js` (+ `tests/publicLookup.test.js`),
`publicAttendanceAPI` in `services/api.js`, route in `AppRoutes.jsx`, buttons on `HomePage.jsx`.
`lib/axios.js` skips the JWT header for requests flagged `skipAuth` (public calls never carry a token).
Reuses `CollegeSearchSelect` / `useCollegeSearch` from Part 7.

### Security model (public endpoint, no session)
1. `collegeId` is only a *choice* from the public search. It must match `COL-…` and an **active** College on the server.
2. Student is found **only** by `collegeId + department + batch + shift + roll` among active students
   (department/batch/shift case-insensitive, regex-escaped). Any `studentId`, `_id`, `role`, etc. in the body is ignored.
3. >1 match (e.g. departments differing only by letter case) → generic **409**, nothing disclosed.
4. Analytics go through `scopedModel(…, {collegeId})`; subjects with a different `collegeId` are skipped (defence in depth).
   Same registration number in two colleges never aggregates.
5. Response whitelist — student: `name, roll, department, batch, shift`; college: `name, district, country`;
   stats: counts/percentages/credit score/breakdown; per-subject: name, code, counts, %.
   **Not** returned: `_id`, `studentId`, email, uploader, `collegeId`, subject/teacher ids, teacher names/emails, alert history.
6. Every miss (bad/inactive college, wrong scope, wrong roll, deactivated student) = identical 404 message.
7. `Cache-Control: no-store`.
8. Rate limits (per client IP; `trust proxy` already set), env-tunable, defaults in `.env.example`:
   60 lookups/min · 40 failed guesses/10 min per IP · 15 failed guesses/10 min per IP+college → 429 + `Retry-After`.
   Limiters are in-memory (single instance).

### Tests
Backend `npm test` and frontend `npm test` — see results in the hand-off message. New coverage includes **identical roll
(and identical registration number, department, batch, shift, subject code) in two colleges** → independent student, totals,
credit score; cross-college miss = 404; forged ids ignored; operator injection → 400; whitelist/no-leak; no-store;
missing / deactivated / ambiguous / inactive college; admin analytics unchanged; failure limiter unit + e2e.
`routeAudit.test.js` now lists `post /api/public/attendance/lookup` as the one new intentionally-public route.
`tests/helpers/e2eApp.js` now generates college ids that match the real `COL-` pattern (old helper ids contained `1`, which production rejects).

## Known limitations / decisions to revisit in Part 15
- **Roll numbers are guessable.** Anyone who knows college + department + batch + shift + roll sees that student's name and
  attendance. This is inherent to "no login"; mitigations are the failure limiters and minimal response. Options: add a second factor
  (DOB / last digits of phone / registration no.), mask the name (e.g. "Anika A."), or per-college opt-in switch.
- Department/batch/shift are free text (case-insensitive exact match). A public "options" endpoint (dropdowns) was deliberately
  not added to avoid exposing a college's structure; add it if typo-rate is a problem.
- Rate limiters are per process; use a shared store (Redis) if the API is scaled horizontally. Shared campus NAT IPs could trip
  the per-IP limits — raise `PUBLIC_LOOKUP_*` env values if so.
- Two colleges with the same name are distinguished only by district/country in search; a wrong pick just yields "not found".
- No CAPTCHA / bot protection yet.
- Subject-level stats include every subject in the college that lists the student (same as the admin page), not only subjects of
  the student's department/batch.

## Suggested Part 15 candidates
Second factor or name masking for the public lookup · per-college enable/disable setting · dropdown options endpoint ·
Redis-backed limiter · audit log of public lookups (counts only, no PII) · CAPTCHA.
