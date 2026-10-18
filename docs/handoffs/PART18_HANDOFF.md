# Part 18 handoff — after Part 17 (PDF reports, backups, activity logs)

## What Part 17 did
Full detail and before/after table: `docs/PART17_REPORTS_BACKUPS_LOGS.md`.
- **Finding:** the app had **no backup/restore code** and **no persistent activity log**. The only "backup" is the per-subject pre-deletion register ZIP (already college-scoped). Platform-wide DB backups (if any) are infrastructure and were not touched or exposed.
- **Exports/PDF:** scoping was already correct; added a fail-closed foreign-row guard, date-query validation (400), safe filenames, `no-store`/`nosniff`, no env-college-name leak for real colleges. PDF builder untouched; extracted page text of a 25-date report is identical before/after.
- **New, college-level only:** signed JSON backup (`GET /api/admin/backups/college`), restore preview, and **merge-only** restore (needs `confirm=RESTORE`; never updates/overwrites/deletes; no accounts in backups).
- **New:** `ActivityLog` + `GET /api/admin/activity` (admin only), fed by exports, backups, attendance save/edit/trash, trash actions, subject delete, teacher approve/reject/promote/demote/delete, and a per-college `trash.purge` row from the nightly job. Security-event log lines now carry `college`.
- **Tests:** `tests/exportBackupIsolation.test.js` (36 tests) + routeAudit extended. 10 mutation checks (remove each guard) all made a test fail. Full-suite result: see bottom.
- Moved the previous handoff to `docs/handoffs/PART16_to_17.md`.

## Act on these now
1. **Rotate the MongoDB Atlas user password and `JWT_SECRET`.** Every earlier ZIP contained them in `backend/.env`. This ZIP ships placeholders — copy your real values back into your local `.env` after rotating (otherwise the server won't connect).
2. Rotating `JWT_SECRET` also invalidates old college backup files unless `BACKUP_SIGNING_KEY` is set; set it before you start taking backups you want to keep.

## Verification limits (be honest)
- Everything runs on the fake Mongo driver (`mingo`), not a real server: TTL expiry of activity rows, real unique-index conflicts during restore, and large-college performance are unproven. Run the new test file against a real replica set before relying on restore.
- Backups are built in memory (25 MB upload cap on restore). Very large colleges need streaming — not done.
- Restore is not transactional (by design, merge-only + idempotent), and it does not restore accounts: a subject whose teacher account was deleted is skipped as `missingReference`.
- The rate limiter is per process (same caveat as earlier parts).
- **No frontend was added or changed**: there is no UI for backups or the activity log yet, and `frontend/src/services/api.js` has no client for the new endpoints.
- PDF text extraction in tests is a small custom parser (`tests/helpers/pdfText.js`), not a general PDF reader; it verifies words/pages, not visual rendering.

## Decisions to revisit in Part 18
1. Who may restore: any admin of the college. Consider founder-only (`isFounder` exists in teacher management).
2. Activity log retention (180 days) and whether teachers should see their own entries.
3. Add UI: admin "Backups" and "Activity" pages (+ `api.js` clients), and show `orphaned`/`unstamped` trash flags (open since Part 16).
4. Excel/CSV exports: student names starting with `= + - @` are not neutralised against spreadsheet formula injection (existing behaviour, not changed).
5. Still open from earlier parts: `express.static('uploads')`, per-process rate limiter, teacher-deletion orphans, orphaned trash purge action, `runInTransaction` non-atomic on standalone Mongo.
6. If an async/queued export or scheduled backup is ever added: capture `{collegeId}` from `req.tenant` at enqueue and re-check membership when it runs (see §6 of the Part 17 doc).
7. The full backend suite takes ~6+ minutes; run it in the background or per file with `node --test tests/<file>`.

## Test results (Part 17)
Full backend suite: **489 tests, 486 pass, 3 skipped (need a real MongoDB), 0 fail** (Part 16 baseline: 453/450/3/0, re-run before changes; +36 new). Frontend untouched.
