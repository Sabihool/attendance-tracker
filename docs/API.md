# API Reference

Base URL: `http://localhost:5000/api`

## Auth
| Method | Endpoint                      | Description            | Auth |
|--------|-------------------------------|------------------------|------|
| POST   | `/auth/signup`                | Request a teacher account at the selected college (creates it **pending**, no token; rate-limited) | No   |
| POST   | `/auth/login`                 | Login                  | No   |
| GET    | `/auth/me`                    | Current user (session re-validated against the database) | Yes  |
| GET    | `/auth/users`                 | List users **of your own college** | Admin|
| PATCH  | `/auth/users/:id/approve`     | Approve a pending teacher of your college (same as below) | Admin|
| PATCH  | `/auth/users/:id/reject`      | Reject a pending teacher of your college (kept as *rejected*, no longer deleted) | Admin|
| DELETE | `/auth/users/:id`             | Delete a user of your own college | Admin|

## Departments (admin-managed)
| Method | Endpoint            | Description                          | Auth  |
|--------|---------------------|---------------------------------------|-------|
| GET    | `/departments`      | List departments                      | Yes   |
| POST   | `/departments`      | Create department                     | Admin |
| PUT    | `/departments/:id`  | Edit department (propagates renames)  | Admin |
| DELETE | `/departments/:id`  | Delete department (blocked if in use) | Admin |

## Shifts (admin-managed — replaces hardcoded morning/day/afternoon)
| Method | Endpoint       | Description                          | Auth  |
|--------|----------------|---------------------------------------|-------|
| GET    | `/shifts`      | List shifts                           | Yes   |
| POST   | `/shifts`      | Create shift                          | Admin |
| PUT    | `/shifts/:id`  | Edit shift (propagates renames)       | Admin |
| DELETE | `/shifts/:id`  | Delete shift (blocked if in use)      | Admin |

## Attendance Categories (admin-managed — replaces hardcoded class types/weights)
| Method | Endpoint                     | Description                                    | Auth  |
|--------|------------------------------|-------------------------------------------------|-------|
| GET    | `/attendance-categories`     | List YOUR COLLEGE's categories with credit values | Yes (teacher/admin) |
| POST   | `/attendance-categories`     | Create category `{ name, credit }`              | Admin |
| PUT    | `/attendance-categories/:id` | Edit category (propagates renames)              | Admin |
| DELETE | `/attendance-categories/:id` | Delete category (blocked if in use)             | Admin |

Categories belong to a college (Part 12): each college is seeded with its own `Theory` (credit 1), `Lab` (credit 3), `Tutorial` (credit 2); its admins can edit or delete them, and nothing they do affects another college. Names are unique per college, case-insensitively.

## Settings (admin-managed, per college)
| Method | Endpoint     | Description                                              | Auth  |
|--------|--------------|-----------------------------------------------------------|-------|
| GET    | `/settings`  | Get settings (currently: `consecutiveAbsenceLimit`)        | Yes   |
| PUT    | `/settings`  | Update settings `{ consecutiveAbsenceLimit }`               | Admin |

## Students
| Method | Endpoint                | Description                                              | Auth  |
|--------|--------------------------|-----------------------------------------------------------|-------|
| POST   | `/students/upload`       | Bulk upload students via JSON file into the caller's college (form: `file`, `department`, `batch`, `shift`; see `docs/PART10_STUDENT_IMPORTS.md` for the 201/400/409/422 responses) | Teacher/Admin |
| GET    | `/students`              | List students (requires `?department=`)                   | Teacher/Admin |
| GET    | `/students/groups`       | List unique department/batch/shift combos                 | Teacher/Admin |
| GET    | `/students/batches`      | Distinct batches from uploaded data only (`?department=&shift=`) | Teacher/Admin |
| DELETE | `/students/group`        | Soft-delete all students in a dept/batch/shift group       | Admin |
| GET    | `/students/admin`        | View all students, filter by `department/shift/batch/search`, paginated | Admin |
| POST   | `/students/admin`        | Add a single student manually                              | Admin |
| PUT    | `/students/admin/:id`    | Edit a single student                                      | Admin |
| DELETE | `/students/admin/:id`    | Remove a student (soft-delete; `?hard=true` to purge)       | Admin |

## Subjects
| Method | Endpoint          | Description                                          |
|--------|-------------------|-------------------------------------------------------|
| GET    | `/subjects`       | List subjects of your college (teacher: own; admin: all, `?teacherId=`). `?search=` (name/code), `batch`, `department`, `shift`, `creditType`, `archived`, `sort` |
| GET    | `/subjects/teachers` | Admin only — approved teachers of your college (assignment selector) |
| POST   | `/subjects`       | Create subject. Admin may add `teacherId` (approved teacher of the same college) |
| GET    | `/subjects/:id`   | Get subject                                            |
| PUT    | `/subjects/:id`   | Update subject. Admin may add `teacherId` to re-assign (attendance + alerts move with it) |
| DELETE | `/subjects/:id`   | Delete subject                                         |
| GET    | `/subjects/meta`  | Dynamic departments/shifts/attendance categories/colors |

## Attendance
| Method | Endpoint                                     | Description                                   |
|--------|-----------------------------------------------|-----------------------------------------------|
| GET    | `/attendance/:subjectId`                     | List sessions                                  |
| POST   | `/attendance/:subjectId`                     | Save session `{ date, classType, students[], creditValue? }` |
| GET    | `/attendance/:subjectId/percentage`          | Student percentages                            |
| GET    | `/attendance/:subjectId/dates`               | Dates + daily % (Edit Attendance step 2)       |
| GET    | `/attendance/:subjectId/session/:sessionId`  | Single session                                 |
| PUT    | `/attendance/:subjectId/session/:sessionId`  | Edit session `{ students: [{studentId,status}] }` (Edit Attendance steps 3–4) |
| DELETE | `/attendance/:subjectId/session/:sessionId`  | Soft-delete session                            |

## Export
| Method | Endpoint                      | Description       |
|--------|-------------------------------|-------------------|
| GET    | `/export/:subjectId/pdf`      | Download PDF      |
| GET    | `/export/:subjectId/excel`    | Download Excel    |
| GET    | `/export/:subjectId/csv`      | Download CSV      |

## Alerts
| Method | Endpoint                              | Description              |
|--------|---------------------------------------|--------------------------|
| GET    | `/alerts`                             | List alerts              |
| POST   | `/alerts/create`                      | Create alert             |
| PATCH  | `/alerts/:id/remove`                  | Mark removed             |
| PATCH  | `/alerts/:id/note`                    | Update note              |
| GET    | `/alerts/student/:id/analytics`       | Student analytics (incl. `creditScore`) — **admin only** (Part 13); a student of another college is 404 |

Consecutive absence threshold is read from the college's own `/settings` (`consecutiveAbsenceLimit`, default 3) — no longer hardcoded, and no longer shared between colleges.
`creditScore` in student analytics = Σ (attended classes of a category × that category's credit value), per the Credit Score spec.


---

## Colleges

### POST /api/colleges/register (public, rate-limited)
Creates a college and its initial admin; returns `{ token, user, college }` (201).
Body: `collegeName, country, district, adminName, adminEmail, password, confirmPassword`.
Errors: 400 (`errors` per field), 409 (duplicate email/college), 429. See `PART5_COLLEGE_REGISTRATION.md`.

Note: `POST /api/auth/signup` no longer accepts `role: "admin"` (403).


### GET /api/colleges/search (public, rate-limited)
`?q=<text>&limit=<1-20>` → `{ colleges: [{ collegeId, name, district, country }], count }`. Active colleges only; blank or
1-character `q` returns an empty list (200); malformed input 400; rate limited 429. See `PART7_COLLEGE_SELECTOR.md`.


## Teacher requests & notifications (Part 8)
All admin routes derive the college from the **database record of the logged-in admin** — never from the request.

| Method | Endpoint                                   | Description |
|--------|--------------------------------------------|-------------|
| GET    | `/admin/teacher-requests?status=pending\|approved\|rejected\|all&page=&limit=` | This college's teachers: `{ requests:[{id,name,email,department,status,registeredAt,reviewedAt,college}], counts, page, limit, college }` |
| GET    | `/admin/teacher-requests/summary`          | `{ counts:{pending,approved,rejected}, college }` |
| PATCH  | `/admin/teacher-requests/:id/approve`      | Pending → approved |
| PATCH  | `/admin/teacher-requests/:id/reject`       | Pending → rejected |
| GET    | `/notifications`                           | Own notifications `{ notifications, unread }` |
| PATCH  | `/notifications/:id/read`, `/notifications/read-all` | Mark read (own only) |
| DELETE | `/notifications/:id`, `/notifications`     | Delete one / clear all (own only) |

Error codes (`code` field): `NOT_ADMIN` 403 · `COLLEGE_SUSPENDED` / `COLLEGE_UNAVAILABLE` 403 · `NOT_FOUND` 404 (also for another college's teacher) ·
`ALREADY_DECIDED` 409 (+ `currentStatus`) · `SELF_DECISION` 403 · `BAD_STATUS` 400.
Login adds `ACCOUNT_PENDING`, `ACCOUNT_REJECTED`, `COLLEGE_UNAVAILABLE` (all 403). Protected teacher routes answer 403 `ACCOUNT_PENDING` / `ACCOUNT_REJECTED`.

## Exports, college backups and activity log (Part 17)
College always comes from the logged-in user's database record; a `collegeId` in query/body/URL/form is ignored. Details: `docs/PART17_REPORTS_BACKUPS_LOGS.md`.

| Method | Endpoint | Who | Description |
|--------|----------|-----|-------------|
| GET | `/export/:subjectId/{meta,pdf,excel,csv,register/pdf,register/zip}` | teacher (owner) / admin of the subject's college | Unchanged. Foreign subject id → 404 (same as unknown). `startDate`/`endDate` must be `YYYY-MM-DD` (else 400). Responses are `no-store`. |
| GET | `/admin/backups/college` | college admin | Signed JSON backup of **this college only** (no accounts/secrets). |
| POST | `/admin/backups/college/restore/preview` | college admin | multipart `file`; dry run → `{ dryRun, totals, collections }`. |
| POST | `/admin/backups/college/restore` | college admin | multipart `file` + `confirm=RESTORE`; merge-only (never overwrites/deletes). |
| GET | `/admin/activity?actorId=&role=&action=&from=&to=&page=&limit=` | college admin | This college's activity log, newest first. `action` = exact code or group (`export`, `backup`, `attendance`, `trash`, `teacher`). |

Backup/restore codes: `BACKUP_INVALID` 400 · `BACKUP_SIGNATURE_INVALID` 400 · `BACKUP_VERSION` 400 · `BACKUP_MISSING` 400 · `CONFIRM_REQUIRED` 400 · `BACKUP_WRONG_COLLEGE` 403 · `BACKUP_FOREIGN_RECORDS` 403 · `NO_COLLEGE` 403 · `BACKUP_TOO_LARGE` 413 · 429 rate limit.

## Authentication & authorization errors
All auth failures are `{ success: false, message, code }`:

| Status | `code` | When |
|--------|--------|------|
| 401 | `UNAUTHENTICATED` | Missing / malformed `Authorization: Bearer` header |
| 401 | `TOKEN_EXPIRED` | Token expired |
| 401 | `SESSION_INVALID` | Bad signature, deleted account or revoked session (indistinguishable on purpose) |
| 403 | `FORBIDDEN` | Signed in, but not allowed (e.g. a teacher calling an admin route) |
| 403 | `ACCOUNT_PENDING` / `ACCOUNT_REJECTED` | Registration not approved |
| 403 | `COLLEGE_SUSPENDED` / `COLLEGE_UNAVAILABLE` | The account's college is suspended or missing |
| 404 | `NOT_FOUND` | Missing, or belongs to another college |
| 5xx | `SERVER_ERROR` | Generic message; details stay in the server log |

A `collegeId` sent in a query string, body or URL is never used to decide what you may access.
See `docs/SECURITY_AUTH_AUTHORIZATION.md`.
