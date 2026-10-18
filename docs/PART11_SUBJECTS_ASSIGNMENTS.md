# Part 11 — Subjects and teacher assignments

A subject's **assignment** is its `teacher` field: that teacher takes attendance for it, sees its alerts and trash, and is the owner in every permission check. This part makes the subject, the academic structures it points at, and that assignment college-aware. **No database migration is needed** (one non-unique index is added; Mongoose builds it on start).

## What changed
| Area | Before | Now |
|---|---|---|
| Subject routes (`/api/subjects*`) | already read/wrote through `scopedModel` (Part 9) | unchanged, plus a client `collegeId`/`tenant…` in body/query is stripped (`stripClientTenantFields`) |
| Guard for `/attendance/:subjectId/*` and `/export/:subjectId/*` (`requireSubjectOwner`) | `Subject.findById` **unscoped**, then a college check for admins; a teacher using another college's id got **403** | looked up **inside the caller's college**; another college's id → **404** for teachers and admins, identical to a missing id. The loaded subject is `req.subject` |
| Attendance controller (alerts after save/edit), export controller | re-read the subject by id, unscoped | use `req.subject` (the scoped one). Export "Teacher" is now the subject's **assigned** teacher (was the downloading user), read within the subject's college; the college name is the caller's college (was only `COLLEGE_NAME` from `.env`) |
| `requireAttendanceOwner` | attendance looked up by id only | the session must belong to the subject in the URL, else 404 (stops using your subject's URL with another subject's/college's session id) |
| Department on a subject | exact, case-sensitive match; stored as typed | case-insensitive, regex-escaped match **within the college**; the college's own spelling is stored (same as shifts/students) |
| Teacher assignment | none (owner = creator) | admin may send `teacherId` on create/update; see below |
| Search | none server-side | `GET /subjects?search=` (name or code, literal text, ≤100 chars, college-scoped) |
| `populate("teacher")` | any user record | only a user of the **same college** (`match`); a mismatched teacher shows as `null` instead of leaking name/email (also in admin subject analytics) |

## Assignment rules (`utils/subjectAssignment.js`)
`teacherId` is accepted only from an **admin**. It is re-read from the database inside the admin's college and must be a user with role `teacher` who is fully approved (`approved` + `approvalStatus`, same gate as login).
| Request | Result |
|---|---|
| teacher of another college, or an id that does not exist | 400 `Teacher not found in your college.` (the two cannot be told apart) |
| not a valid id / not a string (`{"$ne":""}`, array, number) | 400 `Invalid teacher.` / `Invalid subject data.` |
| admin account | 400 `Subjects can only be assigned to teachers.` |
| pending / rejected / inconsistent teacher | 400 `Only approved teachers can be assigned subjects.` |
| a **teacher** sends someone else's `teacherId` (even a colleague) | 403 |
| naming yourself / the current owner / empty string | accepted, no change |
| target teacher already has that subject code | 409, nothing changes |
- No `teacherId` → the creator owns it, exactly as before (admins can still own subjects).
- **Re-assignment moves the subject's attendance sessions (active and trashed) and its consecutive-absence alerts to the new teacher in one transaction**, so the new owner can edit/export/trash the whole history and the old owner loses access. If any step fails everything rolls back. **Consequence:** `Attendance.teacher` stops recording who originally took a session. If that matters, add a separate `takenBy` field (see handoff).
- `GET /subjects/teachers` (admin only) feeds the selector: approved teachers of the admin's college, `{_id,name,email,department}` only.

## Uniqueness review
The only unique rule on subjects is `{subjectCode, teacher}`. A teacher belongs to one college and assignment is limited to the admin's college, so it is already per college: two colleges may use the same code, name, batch, department and shift (tested). Subject **names** are intentionally not unique. Nothing was made global and no index was dropped. A test asserts every unique index on `Subject` contains `teacher`. Added (non-unique): `{collegeId, teacher}` for admin per-teacher listings.

## Deletion (rules unchanged)
Permanent delete still requires `acknowledged: true`, removes the subject, **all** its attendance (active + trashed) and its alerts in one transaction (fallback: sequential, when MongoDB has no transactions). It is reached only through a college-scoped lookup, so a foreign id is 404 *before* the acknowledgement check and nothing of another college can be touched. Attendance/alert deletes are keyed by the subject's id, which is unique to one college.

## Frontend
- `utils/subjectForm.js` (new): field whitelists so a whole subject (with its populated `teacher`, `_id`, timestamps) is never posted back, teacher helpers, `subjectErrorMessage` (404 → "not found in your college").
- `services/api.js`: `subjectAPI.getTeachers`, `create/update` send only accepted fields (no college id), `getAll` accepts `search`/`teacherId`.
- `SubjectsContext`: `teachers` + `fetchTeachers`; errors via `subjectErrorMessage`.
- `components/forms/TeacherAssignment.jsx` on the admin **Subject Detail** page: shows the assigned teacher and lists only the college's approved teachers.
- Teacher "My Subjects" edit sends only name and code. Department/shift/batch selectors were already college-scoped (`/subjects/meta`, `/students/batches`); they are unchanged.

## Behaviour changes to be aware of
- A teacher requesting another college's subject through attendance/export/trash URLs now gets **404** (was 403 for attendance/export).
- A department typed in a different case is now accepted and stored in the college's spelling (was "Invalid department.").
- Duplicate-code messages say "for this teacher" (they no longer assume the caller).
- Subjects whose `collegeId` is still `null` (not backfilled) are not reachable through the attendance/export guards by admins of a real college any more (they already were not through `/api/subjects`). Run `npm run migrate:academic` first.

## Tests
- Backend `npm test`: **260 tests (257 pass, 3 skipped, 0 fail)** — 32 new in `tests/subjectIsolation.test.js` (real routers/controllers/models over HTTP, two colleges with identical names). Existing `tenantAuthorization.test.js` updated: guard fake now answers the scoped `findOne`; teacher→other-college subject expectation 403 → 404. `e2eApp.js` now also mounts the attendance and export routers.
- Covered: identical subjects in two colleges; per-teacher uniqueness; every unique index includes `teacher`; list/search/filters per college (regex characters literal); `teacherId` filter; foreign id on GET/PUT/DELETE is byte-identical to a missing id; `collegeId` in body/query ignored; department/shift of another college refused (create + update); assignment accepted/refused matrix; teacher cannot assign; re-assignment moves attendance (active + trashed) + alerts and locks out the old owner; refused re-assignment changes nothing; rollback on failure; corrupted teacher record never leaks; deletion leaves the other college's subject/attendance/alerts intact, 404 for a foreign admin, rollback; attendance/export/trash/alerts with another college's subject id; session ids crossed between subjects/colleges; export names the right college and teacher.
- Mutation-checked (each makes the named tests fail): unscoped teacher lookup, unscoped owner guard, removed attendance↔subject check, removed populate `match`, unscoped subject model in the controller, re-assignment that does not move attendance.
- Frontend `npm test`: **29 pass** (23 + 6 in `subjectForm.test.js`); `vite build` succeeds; ESLint clean on changed files (one pre-existing `react-refresh` warning in `SubjectsContext`).

## NOT verified
- No real MongoDB: transactions (re-assignment, deletion), the new index build and `populate({match})` ran only on the mingo-backed fake driver. The 3 `TEST_MONGO_URI` tests remain skipped.
- Frontend pages (teacher assignment card, edit modal) were linted/built, not exercised in a browser.

## Part 12 handoff
1. **Attendance and alerts still have no `collegeId`**; their college is their subject's. Add it (stamp from the subject; backfill), then key anything by `studentId` with the college (student ids repeat across colleges): `aggregateStudentStats`, alerts, reports, register PDF. Then drop the subject-id `$in` filters and `adminMayAccessOwnerRecord`.
2. **Decide authorship vs ownership.** Re-assignment overwrites `Attendance.teacher`/`Alert.teacherId`. If "who took this session" matters for audit or Teacher Performance, add `takenBy` (set once, never moved) and keep `teacher` as the current owner.
3. **`AttendanceCategory` is still global** (the last public route, `GET /api/attendance-categories`, and `creditType` in `/subjects/meta`). Renaming/deleting a category runs `Subject.updateMany` / `Attendance.updateMany` across **all** colleges (`attendanceCategoryController`). Make categories per college first; this is the largest remaining cross-college write. `Settings` (consecutive-absence limit) is global too.
4. **Batch is still free text on a subject** (not a collection); the UI only offers batches that exist among the college's students, the API accepts any 1–10 characters. Decide whether to enforce "a batch must exist for this department/shift" server-side (it would reject creating a subject before students are uploaded).
5. **Teacher lifecycle:** a teacher who is later rejected/removed keeps their subjects (they are blocked from logging in, but the subjects stay assigned). Add "reassign or archive this teacher's subjects" to the teacher-request/removal flow; the admin now has the endpoint for it.
6. No bulk re-assignment (e.g. all of one teacher's subjects) and no admin "create subject" screen yet — the API supports `teacherId` on create but the only UI is per-subject re-assignment on the Subject Detail page.
7. `express.static('uploads')` still serves uploaded student files publicly; legacy `collegeId: null` bucket; start-up default re-seeding; Part 8 items (suspend UI, email notifications, rotate shipped `.env` secrets, per-process rate limiter) — all still open from earlier handoffs.
8. Run the skipped `TEST_MONGO_URI` tests and try re-assignment/deletion against Atlas before relying on the transaction path.
