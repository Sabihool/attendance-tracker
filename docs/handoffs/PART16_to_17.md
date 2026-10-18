# Part 17 handoff — after Part 16 (Trash, restore & deletion integrity)

## What Part 16 did
Details and before/after table: `docs/PART16_DELETION_INTEGRITY.md`. Summary:
- `controllers/trashController.js`: atomic restore and permanent delete (precondition inside the write; lost race → 409), null-safe ownership, `unstamped` rows handled, admin list populate pinned to the college + clamped paging + `orphaned` flag.
- `services/cronJobs.js`: `runTrashCleanup({now?})` runs per college through `scopedModel`, isolates failures, stamps trashed rows lacking `deletedAt`; returns `{cleaned, healed, errors, colleges[]}`.
- `utils/trashRules.js` (new): retention constants + `isOwnedBy`. Used by `teacherMiddleware.js` and `subjectController.js` too.
- Tests: `backend/tests/deletionIntegrity.test.js` (40). Full backend suite: 453 tests, 450 pass, 3 skipped (integration tests that need a real MongoDB), 0 fail. Frontend untouched.
- Moved previous handoff to `docs/handoffs/PART15_to_16.md`.

## Verification limits (be honest about these)
- Everything runs on the fake Mongo driver (`mingo`), **not a real server**. The atomic restore/delete and the unique-index → 409 path are proven against the fake only; run `deletionIntegrity` against a real replica set before relying on them. Races are simulated by patching a driver call, not by real concurrency.
- `runInTransaction` still falls back to a non-atomic sequence on standalone Mongo (dev); the subject cascade is atomic only on a replica set / Atlas.
- I did not add a mutation check for every scoping call; two were verified (see doc).

## Decisions to revisit in Part 17
1. **Teacher deletion leaves orphans** (carried from Part 15): subjects keep a dangling `teacher`, their sessions remain. Part 16 only makes every path survive it (403 for teachers, admin still works). Consider blocking delete or forcing re-assignment.
2. **Orphaned trash** (subject gone, trashed sessions left) cannot be reached by any user route — restore/permanent/empty all need the subject — only the nightly purge removes it. The admin list now flags it (`orphaned: true`); consider an admin "purge orphans" action.
3. **Permanent delete ignores the 10-day wait** (existing). Left as is; changing it would be a product decision.
4. **Hard-deleting a student** leaves their embedded attendance rows and any alerts (consistent with soft delete and with "alerts persist"). No cascade was added.
5. **Student group delete is a soft deactivation only**; there is no batch delete that removes subjects/attendance. If a destructive batch delete is wanted it should reuse `runInTransaction` and `scopedModel` and require the same acknowledgement as subject delete.
6. `runTrashCleanup` still uses `Attendance.distinct("collegeId", {isDeleted:true})` — the only global read left in the scheduler. Unstamped rows get "now", so a row with a lost `deletedAt` lives 10 more days.
7. `AdminTrashPage.jsx` reads `item.subjectName`/`item.teacherName`, but the API returns populated `subjectId`/`teacher` objects (this mismatch pre-dates Part 16 and was not changed); it will not show `orphaned`/`unstamped` either. Frontend not touched this part.
8. Legacy tenants (`collegeId: null`) are purged as their own group by the nightly job; they remain isolated from real colleges.
9. Still open from earlier parts: `express.static('uploads')`, per-process rate limiter, suspend UI, shipped `.env` secrets (`backend/.env`, `frontend/.env` are in the ZIP).
10. The full backend suite takes ~6 min (e2e ≈1.7 s/test); run in the background, or run single files with `node --test tests/<file>`.
