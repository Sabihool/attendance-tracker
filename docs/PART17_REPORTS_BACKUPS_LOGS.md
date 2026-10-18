# Part 17 — PDF reports, exports, backups and activity logs are college-aware

## 1. What the audit found (read this first)

| Area | State before Part 17 | What Part 17 did |
|---|---|---|
| PDF / Excel / CSV / ZIP exports | Already college-scoped (Parts 11–12): subject loaded inside the caller's college, attendance + credit rules read through `scopedModel`. | Kept the data path. Added defence-in-depth, input hardening and tests (§3). **PDF layout/pagination code (`registerPdfBuilder.js`) is untouched**; page text is byte-identical before/after (§3.2). |
| "Backup" | **There was no backup/restore code.** The only "backup" is the *pre-deletion register ZIP* (`GET /api/export/:subjectId/register/zip`), which is per-subject and already college-scoped. Whole-database backups, if any, are infrastructure (Atlas snapshots / `mongodump` of the shared cluster) and are **platform-wide**. | Platform backups: **unchanged and unreachable from the app** — no route reads, wraps or restores them. Added a separate, explicit **college-level** backup + merge-only restore (§4). |
| Activity logs | **No persistent activity log existed.** "Activity" was (a) derived per-teacher stats (`teacherManagementService.activityFor`, `teacherPerformanceController`) — already scoped — and (b) `logSecurityEvent` lines on the server console, which carried no college. | Added a college-scoped `ActivityLog` (model, service, `GET /api/admin/activity`), wired to exports, backups, attendance edits, trash actions, subject delete, teacher approvals and the nightly purge (§5). Security events now carry `college`. |
| Background jobs | One job: nightly trash purge (`cronJobs.js`) — already per college. No async/queued exports exist (every export is generated inside its request). | Reviewed (§6); the purge now leaves a `trash.purge` row in each affected college's own log. |
| Secrets | `backend/.env` in the ZIP held a real MongoDB Atlas URI (with password) and `JWT_SECRET`. | Placeholders in the shipped `.env` (§7). **Rotate both** — earlier ZIPs contain them. |

## 2. Rules every new piece follows
The college is `req.tenant.collegeId` (database session) or, for a background job, the college it is looping over. It is never read from a body, query, URL, header or uploaded file. All reads/writes go through `scopedModel`. A foreign id is a 404 identical to a missing id.

## 3. Reports and exports

### 3.1 Changes (`controllers/exportController.js`, `routes/exportRoutes.js`)
- **Foreign-row guard:** after the scoped read, any session whose `collegeId`/`subjectId` is not the caller's college/subject aborts the export (500, nothing sent). Unreachable today; it makes a future scoping bug fail closed. Tested by forcing the read to ignore its filter.
- **College heading:** `COLLEGE_NAME` (env) is used only for a college-less legacy tenant. A registered college with no name on record gets the neutral default instead of another institution's branding.
- **Query validation:** `startDate` / `endDate` must be real `YYYY-MM-DD`/ISO strings. Arrays/operator objects (`?startDate[$gt]=…`) and garbage → **400** (was a query-cast 500).
- **Filenames:** `Content-Disposition` / ZIP names use `[A-Za-z0-9._-]` only (subject code is user text → header-injection guard). Normal codes (`CSE-101`) are unchanged.
- **Headers:** `Cache-Control: no-store`, `X-Content-Type-Options: nosniff` on every export route.
- **Activity:** each successful download is logged (`export.pdf|excel|csv|register_pdf|zip`).
- Removed three unused imports (`fs`, `path`, `os`); exports never touch the filesystem, so there are no stored files, temp files or download ids to guess.

### 3.2 Layout preserved
Test `layout: 25 dates…` pins: 10 date columns per attendance page (10+10+5), every student on every attendance page, no analytics on attendance pages, exactly one final "Attendance Analytics Summary" page (Total Classes/Present/Absent, Attendance %, Credit Score, Status), "Page i of N" footers, and golden numbers (25 / 17 / 8 / 68%). I also diffed the extracted text of a 25-date PDF generated before the change against one generated after: **identical** (one-off check, not a committed test).

### 3.3 Cross-college access
Every export route (pdf, register/pdf, register/zip, excel, csv ×3, meta) is tested with college B's subject id from A's teacher **and** A's admin: 404, body byte-identical to a random unknown id, no trace of B. Also: forged `?collegeId=` ignored, malformed id 400, no token 401, same-college non-owner teacher 403, 16 interleaved concurrent A/B downloads never mix.

## 4. College backups (new, deliberately separate from platform backups)

**Routes** (admin of the caller's own college; teachers 403; mounted at `/api/admin/backups`):

| Method | Path | |
|---|---|---|
| GET | `/college` | Download this college's signed JSON backup |
| POST | `/college/restore/preview` | multipart `file` — dry run, writes nothing, returns counts |
| POST | `/college/restore` | multipart `file` + `confirm=RESTORE` — **merge-only** restore |

**Contents:** `departments, shifts, attendanceCategories, settings, students, subjects, attendance (active + trashed), alerts`. **Never included:** user accounts (e-mails, password hashes, session versions), the College record, tokens, env values, DB URI. Restore therefore cannot create, change or escalate an account.

**No ids, no stored files:** the file is generated per request from the session's college. There is nothing to enumerate; `/api/admin/backups/<anything-else>` is 404.

**Signing:** manifest = `{format, version, collegeId, collegeName, createdAt, counts, dataSha256, signature}`; `signature` = HMAC-SHA256 (key = `BACKUP_SIGNING_KEY`, else derived from `JWT_SECRET`). A restore accepts only a file *this deployment* produced for *this college*. Consequence: **rotating the key invalidates older backup files** (documented, intended).

**Restore semantics (merge-only):** in order, per record — skip if the `_id` already exists in the college; skip if its references (teacher account, subject) don't resolve inside the college; otherwise insert (college stamped by `scopedModel`; the file's value is discarded). **Never updates, overwrites or deletes.** Idempotent. Unique-key clashes and ids used by another college are a generic `conflict` count (no detail about the other college). Not transactional: partial progress is safe because it is re-runnable.

**Refused before anything is written:** not JSON / not a backup / wrong format or version (400); bad or missing signature, edited content, re-labelled college, extra collections such as `users`, platform-dump shapes (400); a file of another college (403 `BACKUP_WRONG_COLLEGE`); any record stamped with another college even inside a validly signed file (403 `BACKUP_FOREIGN_RECORDS`); no `confirm` (400 `CONFIRM_REQUIRED`). An account with no college (legacy) gets 403.

**Guards:** per-college rate limit (default 20/hour, `BACKUP_RATE_MAX`), 25 MB upload cap (413), responses are `no-store`.

## 5. Activity log
`models/ActivityLog.js` (`collegeId` immutable, TTL `ACTIVITY_LOG_TTL_DAYS`, default 180), `services/activityLog.js`, `GET /api/admin/activity` (admin only).
- Written by `activityLogger(action)` route middleware **only after a request finishes < 400**, so refused/failed requests are never recorded as actions; and by `recordActivity(tenant, entry)` (never throws; the tenant decides the college, a `collegeId` in the entry is ignored).
- Stores ids, a fixed action code, role and a tiny whitelisted `meta` (counts / format). Never bodies, notes, e-mails, tokens, URIs.
- Actions: `export.*`, `backup.create|restore_preview|restore|restore_refused`, `attendance.save|update|trash`, `trash.restore|permanent_delete|empty`, `subject.delete`, `teacher.approve|reject|promote|demote|delete`, `trash.purge` (system).
- Query: `actorId, role, action (exact or group like "export"), from, to (YYYY-MM-DD), page, limit≤100`; all validated (400), no regex built from input, a foreign `actorId` matches nothing, actor names come from the caller's college users only (no e-mail).
- `logSecurityEvent` lines for tenant violations now include `college` (server console only).

## 6. Background jobs reviewed
| Job | Tenant context | Verdict |
|---|---|---|
| `runTrashCleanup` (nightly) | loops colleges; each write via `scopedModel(Attendance,{collegeId})`; failure isolated per college | OK. Only global read: `Attendance.distinct("collegeId")` (ids only). Now records `trash.purge` in each college's own log. |
| Start-up migrations/seeding (`server.js`) | global by design (stamp legacy rows, seed defaults) | Unchanged; they only add `collegeId`/defaults. |
| `analyticsCache` | keyed by tenant; cleared per college | OK (Part 13). |
| Exports / backups | synchronous, request-bound, no module state, no files | No async export queue exists. If one is ever added it must carry `{collegeId}` captured from `req.tenant` at enqueue time and re-check the requesting user's membership when the job runs. |

## 7. Secrets
`backend/.env` is shipped with placeholders for `MONGO_URI` and `JWT_SECRET`. The **previous ZIPs contain the real values — rotate the Atlas database user's password and the JWT secret** (rotating `JWT_SECRET` signs everyone out and makes older college backup files unrestorable unless `BACKUP_SIGNING_KEY` is set). Exports, backups and logs are tested not to contain `MONGO_URI`, `JWT_SECRET`, password hashes or e-mails. New optional env vars are in `backend/.env.example`.

## 8. Tests
`backend/tests/exportBackupIsolation.test.js` (36 tests; helpers `pdfText.js`, `zipRead.js`) · `routeAudit.test.js` extended with the two new routers. Mutation checks (§ handoff) show the key assertions fail when the guards are removed.

## 9. Not done / limits
See `PART18_HANDOFF.md` (verification limits, frontend UI, open decisions).
