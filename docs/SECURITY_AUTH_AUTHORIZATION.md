# Authentication & Tenant Authorization (Part 8)

This part adds the **security layer** for the multi-college application: how a request
is authenticated, how its role and college are decided, and the reusable building blocks
for college-scoped authorization.

> **What this part is — and is not.** It delivers the mechanisms, upgrades the shared
> authentication chain every existing route already uses, and closes the cross-college
> hole in the existing subject/attendance ownership checks. It does **not** make every
> route college-scoped: most data models (students, departments, subjects…) still have no
> `collegeId`. Each later part must integrate the helpers below and add its own tests.
> See [Not yet covered](#not-yet-covered).

---

## 1. How a request is authenticated

```
Authorization: Bearer <JWT>
        │
        ▼  protect            verify signature (HS256 only) + expiry. No database.
        │                     → req.user = UNTRUSTED token claims
        ▼  requireApproved    read the account from the DATABASE:
        │                       exists? · session version matches? · role · approved/rejected/pending?
        │                       · college exists and is active?
        │                     → req.auth  (trusted, frozen)   → req.user is REPLACED with DB values
        ▼  authorize(...)     checks req.auth.role only (fails closed if there is no session)
        ▼  tenantContext /    builds req.tenant { collegeId, userId, role } from req.auth
           requireAdmin /
           requireTeacher
        ▼  controller         queries through utils/tenantScope.js
```

* `authenticate` = `protect` + `requireApproved` in one middleware (used by `/auth/me`; use it on new routes).
* Every existing route already runs `protect, requireApproved, authorize(...)`, so **all of them
  now get database-fresh role/status/college** without any route being edited.
* The token proves only *"the server issued this to user X under session version N"*.
  `role`, `approved` and `collegeId` are still inside the token for the client's convenience, but the
  server **never reads them**.

### Session object (`req.auth`)

```js
{ userId, name, email, role, isAdmin, isTeacher,
  approvalStatus, authVersion,
  collegeId,          // string, or null for a legacy account not yet assigned to a college
  college: { collegeId, name, status } | null }
```

## 2. The mechanisms

| Mechanism | Where | What it does |
|---|---|---|
| Algorithm pinning | `utils/token.js`, `middleware/authMiddleware.js` | Tokens are issued and accepted as **HS256 only** → `alg:none` and algorithm-confusion tokens are rejected. |
| DB-backed session | `services/authSessionService.js` | Re-reads role, approval, college membership and college status on **every** request (admins too). |
| Session versioning | `User.authVersion`, token claim `av` | Bumping the version instantly invalidates every older token. Old tokens (no `av`) count as version 0, so nobody is logged out by deploying this. |
| Role/status always fresh | `requireApproved` | A demoted/deleted/rejected/suspended account loses access on the **next request**, not at token expiry. |
| `authorize()` fails closed | `middleware/authMiddleware.js` | Reads only `req.auth.role`. Without a resolved session it denies everyone; it never falls back to the token's role. |
| Tenant context | `middleware/tenantGuards.js` → `tenantContext` | `req.tenant` comes from the user's database record. |
| `requireAdmin` / `requireTeacher` | same | Role from the DB session + tenant context. |
| Client college fields ignored | `stripClientTenantFields()` | Removes (or rejects, `{mode:'reject'}`) `collegeId`/`college`/`tenantId`… from body and query. Nothing in the security layer reads them anyway. |
| Scoped queries | `utils/tenantScope.js` | `scopeFilter`, `scopedModel`, `scopedAggregate` (see §4). |
| Ownership guard | `loadOwnedResource()` | Loads `:id` **inside the caller's college**; foreign or missing → identical `404`; per-user ownership → `403`. |
| Privileged account changes | `services/accountSecurityService.js` | `changeRole`, `changeCollegeMembership`, `revokeSessions` (see §5). |
| Consistent errors | `utils/authErrors.js` | One catalogue of 401/403/404 bodies (see §6). |
| No internal leaks | `middleware/errorMiddleware.js` | 5xx responses are generic; detail goes to the server log only. Malformed JSON → `400 Malformed request body.` |
| Security event log | `utils/securityLog.js` | One JSON line per event (role change, membership change, session revoke, cross-college probe, ignored client `collegeId`). Never logs tokens or bodies. |
| Startup config check | `utils/securityConfig.js`, `server.js` | In production the server **refuses to start** with a missing, < 32 char, or placeholder `JWT_SECRET`. `X-Powered-By` is disabled. |

## 3. Requirement map

| # | Requirement | Where it is met |
|---|---|---|
| 1 | Inspect/update JWT/session auth within the existing architecture | `protect` + `requireApproved` kept, upgraded; no route chains changed |
| 2 | Resolve current role, status, college securely | `authSessionService.resolveSession` |
| 3 | Reusable middleware for authenticated users and college admins | `authenticate`, `authorize`, `requireAdmin`, `requireTeacher`, `tenantContext`, existing `requireCollegeAdmin` |
| 4 | College from trusted server records | `req.auth.collegeId` ← `User.collegeId` |
| 5 | Never trust a client `collegeId` | not read anywhere; `stripClientTenantFields`; `scopeFilter` throws if given one; `create` overwrites it |
| 6 | Validate ownership before read/modify | `loadOwnedResource`, `scopedModel`; subject/attendance guards (below) |
| 7 | Teachers can't use admin operations | `authorize('admin')` on DB role; `requireAdmin` |
| 8 | Admins can't reach another college | `requireCollegeAdmin` (existing), `requireSubjectOwner` / `requireAttendanceOwner` now check the owning teacher's college, `loadOwnedResource` |
| 9 | Pending/rejected teachers blocked | `requireApproved` → `403 ACCOUNT_PENDING / ACCOUNT_REJECTED` |
| 10 | Protect role / membership / privileged actions | `accountSecurityService`; no HTTP route can set `role`, `collegeId`, `approved`, `authVersion` |
| 11 | No stale JWT role claims | role is never read from the token; version bump revokes tokens |
| 12 | Consistent 401/403 without internals | `utils/authErrors.js`, `errorMiddleware.js` |

## 4. Writing a college-scoped route (for later parts)

```js
import { authenticate, authorize } from "../middleware/authMiddleware.js";
import { requireAdmin, loadOwnedResource, stripClientTenantFields } from "../middleware/tenantGuards.js";
import { scopedModel } from "../utils/tenantScope.js";

router.use(authenticate, stripClientTenantFields());       // or: protect, requireApproved

router.get("/", requireAdmin, async (req, res, next) => {
  const Batches = scopedModel(Batch, req.tenant);          // throws if Batch has no collegeId field
  res.json(await Batches.find({ active: true }, { lean: true }));
});

router.put("/:id", requireAdmin,
  loadOwnedResource({ model: Batch, as: "batch" }),        // 404 if not in MY college
  async (req, res) => { /* req.resources.batch */ });
```

Rules the helpers enforce:

* `scopedModel(...).create(doc)` **replaces** any `collegeId` in `doc` with the tenant's.
* Updates that mention `collegeId` in any operator throw — a document can't be moved to another college.
* `scopedAggregate` always starts with `{ $match: { collegeId } }` and rejects `$out`/`$merge`
  (you must still scope any `$lookup` target yourself).
* A model with no `collegeId` path is **refused** (Mongoose would otherwise silently drop the field on create).
* Invalid ids, operator objects and other colleges' ids all resolve to "not found".
* A tenant with `collegeId: null` is a legacy account not yet assigned to a college. It is scoped to documents
  that have **no** college, so it can neither see a real college's data nor be seen by one.

## 5. Privileged account changes

`services/accountSecurityService.js` is the only sanctioned way to change `role`, `collegeId` or `authVersion`
on an existing account. It is **not exposed over HTTP** — there is deliberately no endpoint that lets a client
change a role or move a user between colleges. When one is added, it must call this service with `req.auth`.

* `changeRole(actorSession, targetId, newRole)` — actor must be an admin; target must be in the **actor's** college
  (else 404); no self-change; target must be approved; a college always keeps at least one active admin (with a
  compensating revert if two admins demote each other at once); one conditional update; bumps `authVersion`.
* `changeCollegeMembership({ userId, toCollegeId, reason, operator })` — operator/script use only; destination must
  be an active college; a reason and operator are mandatory and logged; the last admin can't leave; bumps `authVersion`.
* `revokeSessions(userId)` — signs the user out everywhere.

Every successful change makes all of the user's earlier tokens fail on their next request.
Existing privileged actions (approve / reject / delete teacher) stay college-scoped through `requireCollegeAdmin`;
a deleted user's token now yields `401`.

## 6. Error responses

Always `{ "success": false, "message": "...", "code": "..." }`. Messages never include the caller's role, ids,
college ids or the reason a token failed.

| Status | `code` | Meaning |
|---|---|---|
| 401 | `UNAUTHENTICATED` | no / malformed `Authorization` header |
| 401 | `TOKEN_EXPIRED` | token expired |
| 401 | `SESSION_INVALID` | bad signature, wrong algorithm, deleted user, revoked session — deliberately indistinguishable |
| 403 | `FORBIDDEN` | authenticated but not allowed |
| 403 | `ACCOUNT_PENDING` / `ACCOUNT_REJECTED` | registration not approved |
| 403 | `COLLEGE_SUSPENDED` / `COLLEGE_UNAVAILABLE` | the account's college is suspended or missing |
| 403 | `NO_COLLEGE` | only with `STRICT_COLLEGE_MEMBERSHIP=true` |
| 404 | `NOT_FOUND` | missing **or belonging to another college** |
| 5xx | `SERVER_ERROR` | generic; details only in the server log |

The frontend's existing handling (any `401` → sign out and go to `/login`) is unchanged.

## 7. Behaviour changes to be aware of

1. **Admin tokens are now checked against the database on every request.** Before, an admin's token skipped the
   database entirely, so a deleted or demoted admin kept admin access on most admin routes until the token expired
   (7 days by default).
2. **A deleted account now gets `401`** (it was `403` on the teacher-request routes).
3. **A suspended college locks out all its users** — admins *and* teachers, at login and for existing tokens
   (`COLLEGE_UNAVAILABLE` / `COLLEGE_SUSPENDED`). Before, approved teachers of a suspended college kept working. The
   old test that asserted this was replaced.
4. **`authorize()` no longer trusts the token's role** and denies requests that have no resolved session.
5. **`/api/auth/me` now uses the full chain**, so a revoked / rejected / suspended session is refused (the frontend already clears its state on failure).
6. **5xx messages are generic** (previously the raw error message was returned).
7. **`requireSubjectOwner` / `requireAttendanceOwner`**: an admin can only act on records whose owning teacher is in the admin's own college (otherwise 404). Teacher behaviour is unchanged.

## 8. Configuration

| Variable | Default | Purpose |
|---|---|---|
| `JWT_SECRET` | — | Required. In production must be ≥ 32 chars and not the example placeholder, or the server won't start. |
| `JWT_EXPIRES_IN` | `7d` | Token lifetime. Because role/status are re-read on every request, a long lifetime no longer keeps stale permissions alive. |
| `STRICT_COLLEGE_MEMBERSHIP` | unset (`false`) | When `true`, accounts without a college get `403 NO_COLLEGE`. **Turn on only after every account has been assigned to a college**, or legacy users are locked out. |

## 9. Tests

`cd backend && npm test` — 148 tests (3 pre-existing skips).

* `authSecurity.test.js` — token forgery/expiry/algorithm, fresh role & college, stale claims, pending/rejected, suspended/deleted college, strict membership, revocation, fail-closed `authorize`, response shapes, error handler, config check.
* `tenantAuthorization.test.js` — `scopeFilter`/`scopedModel`/`scopedAggregate`, `tenantContext`, role guards, client-supplied `collegeId`, `loadOwnedResource`, cross-college admin access to subjects/attendance.
* `accountSecurity.test.js` — role change, membership change, last-admin protection, race, revocation, security log.
* `routeAudit.test.js` — every route is authenticated or on an explicit public list.

The tests use the in-memory model fakes in `tests/helpers/memoryDb.js`; they do not exercise a real MongoDB server.

## Not yet covered

* **Most data routes are authenticated but not college-scoped**: students, subjects (admin list), departments, shifts, attendance categories, settings, alerts, analytics, trash, exports. Their models have no `collegeId` yet; `scopedModel` will refuse them until they do. The departments/batches/shifts part is next.
* **Four public, unscoped lists**: `GET /api/departments`, `/api/shifts`, `/api/attendance-categories`, `/api/subjects/meta`. They are pinned in `routeAudit.test.js` as known gaps.
* No role/membership-change HTTP endpoints (by design, see §5).
* No login rate limiting / account lockout (the signup and college endpoints are rate-limited; login is not).
* The browser keeps the JWT in `localStorage` (XSS-readable) — a frontend/session-storage decision for a later part.
* `backend/scripts/seedAdmin.js` contains a hard-coded admin e-mail and password.

## Part 17 addendum — exports, backups, activity logs
Exports, the college backup/restore routes and the activity log follow the same chain (`protect → requireApproved → authorize → tenantContext`, admin routes add `requireCollegeAdmin`) and query only through `scopedModel`. Backups are HMAC-signed per college and merge-only on restore; they never contain accounts or secrets. See `docs/PART17_REPORTS_BACKUPS_LOGS.md`. Still open: the shipped `.env` had live secrets (placeholders now; rotate), `express.static('uploads')`, per-process rate limiter.
