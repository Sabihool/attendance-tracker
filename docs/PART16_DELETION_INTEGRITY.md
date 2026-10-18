# Part 16 — Trash, restore and deletion integrity

Every destructive operation is college-aware, re-checks its precondition inside the write, and answers inconsistent data with a clear status instead of a crash. Retention is unchanged: **10 days** in the trash, restorable inside the window, purged by the nightly job afterwards.

## What was already scoped (Part 12) and is now covered by tests
Trash list / restore / permanent delete / empty, admin trash list and stats, subject deletion cascade, department / shift / category deletion, single-student and student-group removal, teacher deletion. A foreign college's id (valid and existing) answers 404, byte-for-byte like a missing id.

## What changed
| Area | Before | Now |
|---|---|---|
| Permanent delete | `deleteOne({_id})` after a separate check — a record restored in between was destroyed | `deleteOne({_id, subjectId, isDeleted:true})` (college added by `scopedModel`); 0 deleted → **409**, nothing lost |
| Restore | read → `save()`; a concurrent purge gave a 500, a concurrent duplicate gave a 500, the window was checked only before the write | one atomic `findOneAndUpdate` requiring *this college + subject, still trashed, still inside the window*; lost race → **409**; unique-index clash → **409** |
| Rows with no `deletedAt` | restore threw (500); they never expired | shown with `unstamped: true`, restorable, never "expired"; the nightly job stamps them *now* so the normal 10-day window starts |
| Deleted teacher / subject without teacher | `.toString()` on null → 500 | `isOwnedBy()` (null-safe): teachers get 403, a same-college admin can still restore/delete/manage |
| Nightly cleanup | one unscoped `Attendance.deleteMany` over all colleges | college by college through `scopedModel`; a failure in one college is reported (`errors`, `colleges[].error`) and does not stop or undo another; returns `{cleaned, healed, errors, colleges[]}` |
| Admin trash list | `populate` of subject/teacher unscoped; `page`/`limit` unvalidated | populate pinned to the caller's college (a foreign/missing subject → `subjectId: null`, `orphaned: true`); `page ≥ 1`, `1 ≤ limit ≤ 100`; subject fields now `subjectName subjectCode department` (the old `name code` did not exist on the model) |
| `requireSubjectOwner`, `requireAttendanceOwner`, subject get/update/delete | `x.teacher.toString()` | `isOwnedBy()` |

New shared module: `backend/utils/trashRules.js` (`TRASH_TTL_DAYS`, `trashCutoff`, `trashExpiryDate`, `isOwnedBy`). `TRASH_TTL_DAYS` is still exported from `trashController.js`.

## Deletion behaviour that is deliberately unchanged
- Subject delete: `acknowledged: true` required; teachers only their own; removes active **and** trashed sessions and alerts of that college in one transaction (sequential fallback on standalone Mongo).
- Student group ("batch") delete only **deactivates** students of the caller's college; attendance history, subjects and trash are kept. Single-student delete is soft by default, `?hard=true` removes the document only; attendance history keeps the embedded student rows.
- Department / shift / category delete is blocked while in use **in this college** (categories also by *trashed* sessions).
- Teacher delete: teachers only, same college; the teacher's subjects/attendance stay (existing behaviour).
- Permanent delete does not wait for the 10 days (it never did); it only requires the record to be in the trash.

## Tests
`backend/tests/deletionIntegrity.test.js` — 40 tests, two colleges with identical department/batch/shift/subject name+code/student ids/dates/categories: listings, restore, permanent delete, empty trash, forged `collegeId`, auth, four race conditions (patched driver calls land a concurrent restore/purge/expiry/duplicate between check and write), retention boundary (day 9/10/11, exact-10-days purge), per-college cleanup + failure isolation, unstamped / null-teacher / no-teacher-subject / orphaned-trash rows, subject cascade incl. trashed rows and a cross-referencing foreign row, student group/single deletion, teacher deletion, dept/shift/category deletion, pure helpers.
Mutation checks run: putting back the unconditional `deleteOne` fails the race test; putting back `teacher.toString()` fails the deleted-teacher test.
Changed existing tests: `analyticsIsolation` audit now asserts the scheduler's only global read is `Attendance.distinct("collegeId")` and that it has no unscoped attendance write. `tests/helpers/mongooseFake.js` `norm()` now serialises Mongoose subdocuments/arrays via `toBSON()` (a `$push` into a subdocument array recursed forever in the fake; real MongoDB is unaffected).
