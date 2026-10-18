# Database migration and backup

Two kinds of upgrade exist. Pick yours.

* **A. Brand-new install** (empty database): nothing to migrate. Register the first college at `/register-college`.
* **B. Upgrading the original single-college install**: follow the runbook below. Every step before step 5 is read-only or reversible.

## B. Runbook — original single-college data → one real college

Why a dedicated step: before the upgrade no row had a `collegeId`. The Part 9/12 start-up migrations stamp a row from its *owner's* college, so they cannot work until the users belong to one. `npm run migrate:legacy-college` creates (or attaches to) the college and stamps **every** college-less row: users, students, subjects, attendance sessions, alerts, departments, shifts, categories, settings, notifications, activity log.

1. **Stop the old server** (or put it in maintenance) so nothing writes during the migration.
2. **Back up the whole database** (platform-level; see "Backups" below). Do not skip this — the script refuses `--apply` without `--confirm-backup`.
3. **Restore that backup into a scratch database** (e.g. `DB_NAME=attendance_rehearsal`) and run the whole runbook there first.
4. **Dry run** (writes nothing, not even the college):
   ```bash
   cd backend && npm ci
   npm run migrate:legacy-college -- --name "Your College" --country Bangladesh --district Feni
   ```
   Read the counts, the proposed founder (oldest approved college-less admin; override with `--founder-email`) and the "relationship check" (orphans that already exist in your data).
5. **Apply**:
   ```bash
   npm run migrate:legacy-college -- --name "Your College" --country Bangladesh --district Feni --apply --confirm-backup
   ```
   The script then verifies, per collection, that each migrated document hashes **identically before and after, ignoring `collegeId`** (so nothing — including `updatedAt`, credit snapshots, alert notes, trashed state — changed) and that orphan counts did not grow. Exit code 1 + `VERIFICATION FAILED` means: restore the backup and investigate. It finishes by running the Part 9/12 index/completion migrations.
6. **Deploy the new code and start the server** with production env vars. Start-up re-runs the idempotent migrations (no-ops now).
7. **Set `STRICT_COLLEGE_MEMBERSHIP=true`** and restart: any account that somehow still has no college is refused instead of living in a shared "no college" pool.
8. **Smoke test**: sign in as the original admin and teacher; open a subject with history; export a PDF; open Trash; download a college backup (API call, below).

Resume / attach: if a run is interrupted, re-run with `--college-id COL-XXXXXXXXXX` (the id it printed). Re-running when nothing is left is a no-op. If the target college already contains the same `studentId` as a legacy student the script stops **before writing anything** and lists the conflicts. Same-named departments/shifts/categories are merged (the duplicate college-less row stays, reported as `merged`).

Things that need a human: choosing the founder when there are several admins; deciding what to do with pre-existing orphans reported by the check (they are preserved, not fixed); users who should *not* join the college (none are moved elsewhere automatically — assign them with operator tooling afterwards).

Manual index clean-up (optional, **only after** `npm run explain:analytics -- <collegeId>` on a copy shows the college-led indexes are used): legacy single-field indexes such as `attendances.subjectId_1`, `attendances.teacher_1`, `consecutiveabsencealerts.studentId_1` are redundant for tenant queries but cost write time. **Keep** `attendances.isDeleted_1_deletedAt_1` / `isDeleted_1`: the nightly purge runs an un-scoped `distinct("collegeId", {isDeleted:true})`.

## Backups

**Platform backup (you must set this up; the app does not expose one by design).** Atlas: enable Cloud Backup / continuous backup and take an on-demand snapshot before any migration. Self-hosted: 
```bash
mongodump --uri "$MONGO_URI" --db "$DB_NAME" --gzip --archive=attendance-$(date +%F).gz
mongorestore --uri "$TARGET_URI" --gzip --archive=attendance-2026-10-18.gz --nsFrom "attendance_tracker.*" --nsTo "attendance_rehearsal.*"
```
Store backups outside the app host, encrypted, with an access list: they contain every college's data and password hashes.

**College backup (API only — the frontend has no backup page).** A college admin calls, with their bearer token:
```bash
curl -H "Authorization: Bearer $ADMIN_TOKEN" -o college-backup.json https://<api>/api/admin/backups/college
curl -H "Authorization: Bearer $ADMIN_TOKEN" -F file=@college-backup.json https://<api>/api/admin/backups/college/restore/preview   # dry look
curl -H "Authorization: Bearer $ADMIN_TOKEN" -F file=@college-backup.json https://<api>/api/admin/backups/college/restore           # apply
```
The file contains **only that college** (no accounts, no password hashes) and is HMAC-signed. Restore is **merge-only**; it refuses files from another college, tampered files, and files signed with a different `BACKUP_SIGNING_KEY`. It is a convenience for a college, not a disaster-recovery tool.

**Uploaded rosters** are stored under `backend/uploads/colleges/<collegeId>/…` and are no longer served over HTTP. Back that folder up with the host's volume snapshots, or delete it if you do not need the original files (the data is in MongoDB). On hosts with ephemeral disks the folder disappears on redeploy — nothing in the app reads it back.

## Rollback
Before step 5: nothing changed. After: restore the backup taken in step 2 into the database and redeploy the previous code. (The migration only sets `collegeId` and creates one `colleges` document; but a restore is the only supported way back.)
