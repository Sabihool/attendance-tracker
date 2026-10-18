# Part 8 — College-specific teacher registration & approval

## Workflow
1. **Register** (`/signup`): name, email, password, college chosen with the searchable selector (Part 7).
   The server re-verifies the college is **active**, then creates the teacher as `approved:false, approvalStatus:"pending"`
   with `collegeId` = that college. **No token is issued.** The UI shows "Request sent to *<college>*".
2. **Notify**: every approved admin of *that* college gets an in-app notification ("New teacher request").
3. **Review**: those admins see the request under *Admin → Teachers* (name, email, registration time, requested college,
   department). Pending is shown oldest-first; the sidebar shows a pending badge.
4. **Decide**: *Approve* or *Reject* (reject asks for a second click). A decision is final.
   - Approved → the teacher can sign in; they get a "Registration approved" notification; the college's other admins are told who decided.
   - Rejected → the account is **kept** with `approvalStatus:"rejected"` and can never sign in or use any teacher route.
     The email stays reserved (no re-spamming). To let the person apply again an admin deletes the rejected account (Delete button).

## Rules → where they are enforced (all on the backend)
| # | Rule | Enforcement |
|---|------|-------------|
| 1 | Only the selected college's admins decide | `services/teacherApprovalService.js` — the acting admin is **re-loaded from the DB** (JWT role/college are not trusted) and every query includes `collegeId = admin.collegeId` |
| 2 | College A's admin never sees/manages College B's requests | Same scoping; another college's teacher answers **404**, identical to "does not exist". Legacy `/auth/users*` routes are now scoped too (they were not before) |
| 3 | Rejection never grants access | Login gate (`checkLoginEligibility`) + `requireApproved` (reads the DB on every teacher request, so a forged/old token with `approved:true` is useless) |
| 4 | No duplicates / races | Unique email index (+ pre-check, 409). A decision is **one atomic `findOneAndUpdate`** whose filter contains "same college AND still pending" → two simultaneous decisions: one 200, one **409 `ALREADY_DECIDED`** |
| 5 | Notifications | New `Notification` model + `/api/notifications` (own-only, 90-day TTL); `NotificationContext` loads them, polls every 45 s, and syncs read/delete. Failures never block registration or a decision |
| 6 | Backend decides | UI is only a client; `ProtectedRoute` extra check is defence-in-depth |
| 7 | Existing logins unchanged | Admins and approved teachers (with or without `approvalStatus`/college) log in exactly as before; pending message text is unchanged (a `code` was added). `approvalStatus` is not schema-defaulted so old documents are not misread; a startup backfill tidies them |
| 8 | Deleted / suspended / unavailable colleges | Signup: refused (400). Admin of a suspended/deleted college: 403 `COLLEGE_SUSPENDED` / `COLLEGE_UNAVAILABLE`, nothing can be decided. Pending teacher login: 403 `COLLEGE_UNAVAILABLE`. DB error while checking → treated as unavailable (fails closed). Reactivating the college restores everything |

A teacher cannot approve themselves: the signup handler never reads `approved`/`approvalStatus`/`role:"admin"` from the body,
and the admin routes need an admin role that is verified in the database.

## Data changes
`User`: `approvalStatus` (`pending|approved|rejected`, no default), `approvalReviewedBy`, `approvalReviewedAt`; index
`{collegeId, role, approved, createdAt}`. New `Notification` collection. `backfillApprovalStatus` runs at startup (idempotent).

## Behaviour changes to be aware of
- `PATCH /auth/users/:id/reject` used to **delete** the user; it now marks them *rejected* (kept). Delete remains separate.
- `/auth/users`, approve, reject, delete used to act on **every** user in the database; they are now limited to the caller's college.
- `requireApproved` now costs one indexed lookup per teacher request.
- `POST /auth/signup` is rate-limited (10/h/IP, `TEACHER_SIGNUP_MAX`).
- Admin-dashboard "Total teachers" no longer counts rejected requests.

## Files
Backend new: `utils/approval.js`, `utils/approvalBackfill.js`, `models/Notification.js`, `services/{teacherApprovalService,notificationService,approvalWiring}.js`,
`middleware/approvalGuards.js`, `controllers/{teacherRequestController,notificationController}.js`, `routes/{teacherRequestRoutes,notificationRoutes}.js`,
tests `teacherApprovalWorkflow`, `teacherApprovalRoutes`, `teacherApproval.integration` (+ `tests/helpers/memoryDb.js`).
Backend changed: `models/User.js`, `controllers/authController.js` (`createLogin`, signup hardening; old unscoped admin handlers removed),
`middleware/authMiddleware.js`, `routes/authRoutes.js`, `server.js`, `.env.example`.
Frontend new: `utils/teacherRequests.js`, `tests/teacherRequests.test.js`. Changed: `pages/admin/ApproveTeachersPage.jsx`, `pages/auth/{SignupPage,LoginPage}.jsx`,
`context/{NotificationContext,AuthContext}.jsx`, `components/layout/AdminSidebar.jsx`, `components/common/ProtectedRoute.jsx`, `pages/admin/AdminDashboardPage.jsx`, `services/api.js`.

## Tests
- `cd backend && npm test` — new: **35 workflow tests** (registration, tampering, login gating, forged tokens, college isolation, approve/reject,
  decision & signup races, suspended/deleted colleges, legacy users, notifications) + **5 route-wiring tests** (every admin route sits behind
  protect → requireApproved → authorize(admin) → requireCollegeAdmin). Mutation-checked: removing the college filter, the "still pending" condition,
  the DB approval check, the suspended-college check or the rejected-login check each makes tests fail.
- `TEST_MONGO_URI=… npm test` also runs `teacherApproval.integration.test.js` (real unique index + real atomicity).
- `cd frontend && npm test` — 15 pass (8 existing + 7 new).

## Verified / NOT verified in the build environment
Verified: all of the above tests pass; the approval page (pending list contents, approve, two-step reject, rejected tab, 409 conflict message,
suspended-college banner, no horizontal scroll at 390 px) and the signup "Request sent" screen and notification sync were driven in headless Chromium
against a mocked API.
**Not verified** (the npm registry and MongoDB downloads were blocked here):
- The workflow tests run on an in-memory fake of the three models, not real Mongoose/MongoDB. The real-DB test is written but **has not been run**.
- The existing suites that need real `express`/`mongoose` (`collegeController`, `collegeSearchEndpoint`, `collegeSearch.integration` …) could not run; I read them
  against my changes (they call `createSignup({User, College, findActiveCollege})` and `signup` which stay compatible) but you should run `npm test`.
- `npm install` of the backend was blocked (`zip-stream` 403), so `archiver` was not installed; `vite build` / `eslint` / Tailwind styling were not run (JSX was syntax-checked).
- Visual styling was not reviewed (Tailwind not available); the new screens reuse existing classes (`card`, `badge-*`, `filter-tab`, …).

## Part 8 handoff
1. **Run `npm install && npm test` and `TEST_MONGO_URI=… npm test`**, then `vite build`. Confirm indexes exist: `users` `collegeId_1_role_1_approved_1_createdAt_-1`, `notifications` TTL on `createdAt`.
2. **Legacy admins/teachers with `collegeId: null`** (e.g. `seedAdmin.js`): a college-less admin only sees/decides college-less teachers, and college admins never see them
   (no cross-tenant access, but nobody "owns" these). Decide the migration: assign them to a college (script) or add a platform super-admin.
3. **No self-service re-apply for rejected teachers**; an admin must delete the rejected account first. Consider a "reconsider" action or a reason/note on rejection (not built).
4. **No admin UI to suspend/reactivate a college** (still DB-only). A suspended college blocks its own admins from deciding — deliberate, but needs an owner who can reactivate.
5. An approved teacher of a college suspended later still signs in (existing behaviour kept). Decide whether suspension should lock teachers out.
6. **Email**: notifications are in-app only. No email to the teacher on approval/rejection (a rejected teacher cannot sign in to see anything; they see the rejection message at login).
7. Notifications are polled (45 s); use SSE/WebSocket if instant delivery matters. The rate limiter is per process (use a shared store when scaling).
8. `teacherPerformanceController` and other admin analytics still list **all** teachers/subjects/students across colleges (Part 7 item 7) — tenant-scope the rest of the data next; pending/rejected teachers also appear there.
9. A decision on a college that is suspended *between* the scope check and the update is not re-checked (tiny window; harmless — the request simply stays decided).
10. Real secrets are in the ZIP's `.env` files — rotate/remove before sharing.
