# Part 10 — Student management and JSON imports (college-specific)

Part 9 had already put `collegeId` on `Student` and routed every student query through `scopedModel(Student, req.tenant)`. Part 10 audited the whole student path against that and closed the gaps that were left, mostly in the **import**.

## What was already true (re-verified, now covered by tests)
- The college comes from the session (`req.tenant`), never from the body/query/URL; a `collegeId` sent in a form or JSON body is ignored and the field is immutable on the model.
- Another college's student id on `PUT/DELETE /students/admin/:id` (soft or `?hard=true`) → **404**, identical to a non-existent id; the target document is unchanged.
- Uniqueness is per college, in the database too: `{collegeId, studentId, department, batch, shift}`, partial `{collegeId, studentId}` and partial `{collegeId, roll, department, batch, shift}` (partial = active students only).
- Group (batch) deletion stays a soft delete (`isActive: false`), touches only the caller's college, and never removes attendance.

## What changed

### Import (`POST /api/students/upload`)
| Before | Now |
|---|---|
| Department was **not** checked at all (only the shift was) — any text became a "department" | Department **and** shift must exist in the caller's college (case-insensitive); the college's own spelling is stored, so `computer science` can no longer create a second group. Another college's names are "not found" and are not listed in the error |
| A clash with an existing student surfaced as a database duplicate-key error → generic `500 Database error`, with some rows already written (unordered bulk write) | The whole file is **checked against the college's existing students first**; conflicts → `409`, row-level, nothing saved |
| File written to disk before the DB write; orphan file if the DB failed | File is removed when the import is rejected or fails |
| Writes not atomic | Check + write run in one `runInTransaction`; a write failure rolls the whole file back (see "Partial failure") |
| `email` / `section` accepted by the validator but silently dropped | Stored when present in the file |
| Validator: stopped at 20 errors, no structure, 1-char names accepted, objects stringified to `[object Object]` | Every problem found, first 50 listed with `totalErrors`; structured `details`; type/length checks; BOM tolerated |
| Frontend showed only the headline message | Upload page lists the row-level errors |

Semantics that did **not** change: JSON shapes (`[...]` or `{students:[...]}`), 1 000 rows / 2 MB limits, upsert by `studentId` within the group, students missing from the file are left alone, `201` + `{uploadedFile, department, batch, shift, totalInFile, inserted, modified}` (added: `matched`, `reactivated`).

### Responses
| Status | When | Body |
|---|---|---|
| 201 | imported | `data: {…, inserted, modified, matched, reactivated}` |
| 400 | no file, missing `department`/`batch`/`shift`, department/shift not in this college, wrong extension / too large | `message` |
| 422 | not valid JSON, or the file's content is invalid | `message`, `errors[]` (text), `details[]` `{index,row,studentId,field,code,message}`, `totalErrors` |
| 409 | file is valid but clashes with existing students of **this college** | same shape; codes `STUDENT_ID_IN_USE`, `ROLL_IN_USE`, `ROLL_REASSIGNMENT`; also returned if a concurrent write clashed during the import |
| 500 | unexpected DB error | `message` says whether anything was saved |

Validation codes: `BAD_STRUCTURE`, `EMPTY_LIST`, `TOO_MANY_STUDENTS`, `NOT_AN_OBJECT`, `MISSING_FIELD`, `EMPTY_FIELD`, `WRONG_TYPE`, `TOO_LONG`, `TOO_SHORT`, `DUPLICATE_STUDENT_ID`, `DUPLICATE_ROLL`.

### Duplicate rules (all inside one college; another college never counts)
1. **Registration number (`studentId`)**: one *active* student per college, across all groups. A removed student does not hold it.
2. **Roll**: one *active* student per department + batch + shift. The same roll is fine in another batch/shift, and in any other college. Roll numbers are never treated as globally unique.
3. Import matches existing students by `studentId` inside the group (case-insensitive department/shift): found → updated (a removed one is **restored**, `reactivated`), not found → inserted.
4. A roll that belongs to another student who is *also in the file with a different roll* (swap/shift) is refused (`ROLL_REASSIGNMENT`): applying it in one pass would transiently violate the unique index. Change them one at a time.

### Manual create / edit (`/students/admin`)
- Create: department must be one of the college's (400 otherwise), stored with the college's spelling; duplicate messages now say which value clashed (`Registration Number …` / `Roll Number … in <group>`) instead of one generic text.
- Edit: changing the department checks it against the college (resending the current one is not a move, so old records still save); duplicates are re-checked on any identity/group change **and when a removed student is restored**; a removed student that stays removed is not checked (fixing a typo is not blocked by a reissued number).
- Creating a student whose registration number belongs to a **removed student in the same group** returns an explanatory 409 (the group's full unique index still holds the removed row); the bulk import restores such a student automatically.

### Partial failure
- **With transactions (Atlas / replica set)**: the conflict check and the bulk write run in one transaction → either the whole file is applied or none of it; a clash with a concurrent write returns 409 "No students were saved".
- **Without transactions (standalone `mongod`)**: `runInTransaction` falls back to sequential writes. All *known* conflicts are still rejected before the first write; only a concurrent clash can leave a partial import, and the response says "Some students may already have been saved; uploading the same file again is safe". Re-uploading is idempotent.

## Tests
- Backend `npm test`: **228 tests (225 pass, 3 skipped, 0 fail)** — 40 new: `studentImport.test.js` (33, real routers/controllers/models over HTTP with multipart uploads) and `studentValidator.test.js` (7).
- Headline test: *identical student ids and roll numbers import into two different colleges*; also the same roll in other batches/shifts, idempotent re-import, wrong-college department/shift, ID manipulation on edit/delete, batch deletion + restore, transactional rollback, no-transaction fallback with a real duplicate-key failure.
- Mutation-checked: unscoped planner read, a global `studentId` index, no department validation, unscoped edit lookup, skipped pre-check and bypassed transaction each fail tests.
- Harness changes: `e2eApp.js` gained `upload()` (multipart); `mongooseFake.js` transactions now **roll back** on error and its `bulkWrite` errors have the real driver's `writeErrors[n].err.index` shape (Mongoose crashed on the old shape).
- Frontend `npm test`: 23 pass; `vite build` succeeds.

## NOT verified
- No real MongoDB was available: real transactions, write-conflict retries, index builds and the upsert-inside-transaction behaviour have not run against a server. The fake driver's rollback is a snapshot/restore, not MongoDB semantics. The 3 `TEST_MONGO_URI` integration tests remain skipped.
- Frontend pages were built, not exercised in a browser.
- Part 9's document says student department/shift were already validated against the college lists; in the code only the **shift** was. The department check is added here.

## Behaviour changes to be aware of
- Uploading/creating with a department that is not in the college's list is now rejected (previously accepted).
- A file with a 1-character `name`, an identifier over 64 characters, or an `email`/`section` of the wrong type is now rejected (previously stored or stringified).
- `email`/`section` in an import file are now saved.

## Part 11 handoff
1. **Attendance is still not college-aware.** `Attendance` and `ConsecutiveAbsenceAlert` have no `collegeId`; their college is their subject's. Student ids repeat across colleges, so anything keyed by `studentId` alone (attendance entries, alerts, reports, exports, `aggregateStudentStats`, the register PDF) must become college-aware, then drop the subject-id `$in` filters.
2. **Changing or hard-deleting a student leaves attendance behind.** Attendance rows reference `studentId` as a string. Editing `studentId` orphans history; hard delete keeps it, and a later student given the same id *in the same college* inherits it. Decide: block the edit, migrate the attendance rows, or cascade.
3. **Removed students and group deletion** still only flip `isActive`; there is no purge/TTL for them. Decide a retention rule together with the attendance decision above.
4. **Same-group reissue** of a removed student's registration number needs the full `{collegeId, studentId, department, batch, shift}` index to become partial (`isActive: true`) — a migration; until then use restore/import.
5. **Still global**: `AttendanceCategory` (`GET /api/attendance-categories` is the last public route) and `Settings` (consecutive-absence limit). Make both per college.
6. `express.static('uploads')` still serves uploaded student JSON files by URL (now under `uploads/colleges/<collegeId>/…`; the paths are predictable from department/batch/shift). Serve behind auth or move out of the web root.
7. Import limits are per request (1 000 rows, 2 MB); there is no per-college rate limit or import history/audit log.
8. Batch is free text per upload (case-sensitive: `2024-A` ≠ `2024-a`), as before. Decide whether batches should become a per-college list.
9. Part 9 items still open: run `npm run migrate:academic` on a copy of production first and verify `db.students.getIndexes()`; legacy `collegeId: null` bucket decision; re-seeding of deleted default departments/shifts; Part 8 items (suspend UI, email notifications, rotate shipped `.env` secrets, per-process rate limiter).
10. Run the skipped `TEST_MONGO_URI` integration tests, and manually try an import against Atlas, before relying on the transaction path.
