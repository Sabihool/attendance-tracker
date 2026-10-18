# Part 16 handoff — after Part 15 (Teacher management & admin promotion)

## What Part 15 added
Backend: `routes/teacherManagementRoutes.js`, `controllers/teacherManagementController.js`, `services/teacherManagementService.js`, `services/managementWiring.js`, `middleware/privilegeGuards.js` (`rejectPrivilegedFields`); mounted at `/api/admin/teachers` in `server.js`.
Hardened existing code: `accountSecurityService.changeRole` (no-college actors refused, founder protected, conditional update also requires `approved`), `teacherApprovalService.deleteUser` (teachers only; admins → 409 `ADMIN_NOT_DELETABLE`), `resolveAdminScope` now exposes `founderId`; `Notification` enum gained `role_promoted` / `role_demoted`.
Frontend: `pages/admin/TeacherManagementPage.jsx` (route `/admin/teachers`, sidebar "Teachers" now points here, pending badge kept), `utils/teacherManagement.js`, `teacherManagementAPI` in `services/api.js`. The old `/admin/approve-teachers` page and its dashboard links still work.
Docs: `docs/PART15_TEACHER_MANAGEMENT.md` (API + rules). Previous handoff moved to `docs/handoffs/PART14_to_15.md`.
Tests: `backend/tests/teacherManagement.test.js` (21), `frontend/tests/teacherManagement.test.js` (4), `routeAudit` updated.

## Decisions to revisit in Part 16
- **No account deactivation/restore** exists; adding it means a new state checked in `authSessionService`, login eligibility, list filters and the UI. Delete leaves the teacher's subjects/attendance orphaned (existing behaviour); consider blocking delete or forcing reassignment.
- **Founder transfer** has no UI/API (operator only). A founder who leaves the college has no sanctioned path.
- Founders are identified by `College.createdBy`; colleges without it rely on the last-admin rule only.
- Promoted teachers disappear from Teacher Performance (it lists teachers only).
- Promotion/demotion forces a re-login; the UI shows a toast but does not tell the affected user until their next request returns 401.
- No audit-log UI: role changes are written as `role_changed` security-log lines only.
- `TeacherManagementPage` triggers the same `react-hooks/set-state-in-effect` lint error that `ApproveTeachersPage` already had (pre-existing pattern).
- Full backend suite is slow (~5+ min, e2e files ≈1.7 s/test); run it in the background.
