# Part 15 — College teacher management and admin promotion

## API (all under `/api/admin/teachers`, college admins only)
Chain on every route: `protect → requireApproved (live DB session) → authorize('admin') → tenantContext → requireCollegeAdmin (active college) → rejectPrivilegedFields`.

| Method / path | Purpose |
|---|---|
| `GET /` | Members of the caller's college. `?type=teacher\|admin\|all` (default teacher), `?status=pending\|approved\|rejected\|all`, `?q=` (literal text search), `?page=&limit=`. Each member: role, status, `isSelf`, `isFounder`, `activity` (subjects, sessions, last session, avg %), `capabilities` (what the UI may offer). |
| `GET /summary` | Counts: pending / approved / rejected teachers, admins. |
| `GET /:id` | One member + activity + their latest 20 subjects. |
| `PATCH /:id/approve`, `/reject` | Same rules as `/api/admin/teacher-requests` (delegates to `teacherApprovalService.decide`). |
| `PATCH /:id/promote` | teacher → admin of the same college. **No body.** |
| `PATCH /:id/demote` | admin → teacher. **No body.** |
| `DELETE /:id` | Delete a **teacher** (existing hard-delete behaviour). |

The old `/api/admin/teacher-requests` and `/api/auth/users*` routes keep working.
The member-type filter is `type`, not `role`, because `role` is a refused key on these routes.

## Rules (enforced in `accountSecurityService.changeRole`, the only place roles change)
1. Actor must be a DB-verified, approved admin of an **active, real** college; admins with no college cannot manage roles.
2. Target must be in the actor's college; anything else is `404` (indistinguishable from "does not exist").
3. Nobody changes their own role (`SELF_CHANGE`). A teacher cannot reach these routes at all (`403`).
4. Only approved accounts take part (`NOT_APPROVED`).
5. **Founding admin** (`College.createdBy`) can never be demoted or deleted through the API (`FOUNDER_PROTECTED`). Only operator tooling can change that.
6. **Multiple admins**: any active admin may promote teachers and demote other non-founder admins.
7. **Last admin**: a college always keeps one active admin (`LAST_ADMIN`), including when two admins demote each other at the same instant (post-check + undo). This also protects legacy colleges with no recorded founder.
8. **No super administrator**: the only roles are `admin` (scoped to one college) and `teacher`; there is no endpoint that accepts a role value, and `collegeId` is never writable by a client. `changeCollegeMembership` stays operator-only.
9. Admins cannot be deleted; demote first (so rules 5–7 always apply). Delete is filtered by `role: 'teacher'`, so a concurrent promotion cannot be bypassed.
10. Any `role`, `collegeId`, `approved`, `approvalStatus`, `authVersion`, `createdBy`, `isAdmin`… in a body or query on these routes → `400`, logged as `privileged_field_in_request`.

## Role changes take effect immediately
Each change bumps `User.authVersion`, so every earlier token of that person gets `401` on its next request; the next sign-in carries the new role. (The role is also re-read from the database on every request, so a token claiming `role: admin` is worthless.) The affected user and the other admins get an in-app notification (`role_promoted` / `role_demoted`).

## Not changed / not added (decisions)
* There is **no deactivate/restore for accounts** in the existing system (restore exists only for subjects/students/attendance in Trash; a rejected registration is final). Part 15 did not invent one: delete stays the existing hard delete (teachers only now).
* Teacher Performance still lists `role: teacher` only, so a promoted teacher leaves that list (their subjects/attendance stay).
