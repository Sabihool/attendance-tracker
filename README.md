# Attendance Tracker — multi-college

A MERN attendance system for colleges. **One Express API and one MongoDB database serve many colleges**, with strict college-level isolation enforced server-side. Teachers take attendance, produce PDF/Excel/CSV reports and credit-weighted analytics; college admins approve teachers and manage students, structure and backups; students can look up their own attendance.

**Status:** feature-complete and tested against a fake MongoDB driver; **not verified against a real MongoDB or in a browser, so do not treat it as production-ready yet** — see `docs/PART20_FINAL_REPORT.md` (results, known limitations, go-live checklist).

**Stack** — Frontend: React 19 · Vite · Tailwind · React Router 7 · Recharts · Axios. Backend: Node · Express 4 · Mongoose 8 · JWT · PDFKit · SheetJS (export only).

## Quick start
```bash
npm run install:all && npm install
cp backend/.env.example backend/.env && cp frontend/.env.example frontend/.env   # fill MONGO_URI and JWT_SECRET
npm run dev            # API http://localhost:5000, app http://localhost:5173
```
Register the first college at `/register-college`. Tests: `cd backend && npm test`, `cd frontend && npm test && npm run build`.

## Documentation
| Topic | File |
|---|---|
| Install, deploy, manual steps | `docs/DEPLOYMENT.md` |
| **Upgrading the original single-college database** | `docs/MIGRATION_AND_BACKUP.md` |
| Environment variables | `docs/ENVIRONMENT.md` |
| Final test/build results, limitations | `docs/PART20_FINAL_REPORT.md` |
| Architecture, API, security model | `docs/ARCHITECTURE.md`, `docs/API.md`, `docs/SECURITY_AUTH_AUTHORIZATION.md`, `docs/PART19_SECURITY_AUDIT.md` |
| Feature parts 5–18 | `docs/PART*.md`, `docs/handoffs/` |

## Layout
```
backend/   controllers · routes · middleware (auth, tenant guards, rate limits) · models · services · utils
           scripts/ (migrateLegacyCollege, migrateAcademic, migrateAttendance, backfillCollegeSearch, seedAdmin, explainAnalytics)
           tests/ (node:test; in-memory Mongo fake in tests/helpers)
frontend/  src/{pages,components,context,services,routes,utils}  tests/
docs/
```

## Roles
Teacher (own subjects: attendance, reports, trash, alerts) · College admin (their college only: approve/reject teachers, promote/demote, students, subjects, structure, analytics, backups, activity log). Admins are only created by registering a college; there is no platform-wide super-admin.

## npm scripts (backend)
`start` · `dev` · `test` · `migrate:legacy-college` (original data → a real college, **run once before first multi-college start**) · `migrate:academic` · `migrate:attendance` · `backfill:colleges` · `explain:analytics` · `seed:admin`.

Built by **Sabihool** · MERN Stack

---

## College registration (Part 5)
New institutions register at `/register-college` (`POST /api/colleges/register`). Optional env vars: `COLLEGE_REGISTER_MAX` (default 5) and `COLLEGE_REGISTER_WINDOW_MS` (default 3600000). Run backend tests with `cd backend && npm test`. Details: `docs/PART5_COLLEGE_REGISTRATION.md`.

## College selector (Part 7)
Teacher signup picks the college through a searchable autocomplete (`GET /api/colleges/search`) and stores its ID. Existing colleges are backfilled automatically at server start (or `npm run backfill:colleges`). Tests: `cd backend && npm test`, `cd frontend && npm test`. Details and handoff: `docs/PART7_COLLEGE_SELECTOR.md`.

---

**Teacher registration & approval:** see [docs/PART8_TEACHER_APPROVAL.md](docs/PART8_TEACHER_APPROVAL.md).


## Multi-college academic structure (Part 9)
Departments, batches and shifts are per college — see `docs/PART9_ACADEMIC_ISOLATION.md` (includes the required index migration: `npm run migrate:academic`).

## Student management and JSON imports (Part 10)
Student create / edit / search / delete and the JSON import are per college, with precise duplicate and import errors — see `docs/PART10_STUDENT_IMPORTS.md`.

## Subjects and teacher assignments (Part 11)
Subjects, their department/shift references and the teacher assigned to them are per college; admins can assign / re-assign subjects to approved teachers of their own college — see `docs/PART11_SUBJECTS_ASSIGNMENTS.md`.

## Attendance and credit system (Part 12)
Attendance sessions, categories + credit values, streak alerts and the streak threshold are per college, and attendance is only recorded after subject, teacher, students/batch and category are proven to belong to the caller's college — see `docs/PART12_ATTENDANCE_CREDITS.md`. **Run `npm run migrate:attendance` before/at deploy** (the server also runs it at start-up); it does not modify attendance history.

## Analytics and dashboards (Part 13)
Every dashboard (teacher performance, subject analytics, academic structure, student directory/analytics, trash stats, streak reports) is computed from the caller's college only; aggregations get the tenant `$match` first and refuse stages that could join another college's rows. Dashboard datasets are cached for a few seconds per college (`ANALYTICS_CACHE_TTL_MS`, `0` = off). See `docs/PART13_ANALYTICS_DASHBOARDS.md`. New indexes are built by Mongoose at start-up and by `npm run migrate:attendance`; check plans with `npm run explain:analytics -- <collegeId>`.

Trash, restore and every destructive operation are college-scoped and re-check their precondition inside the write (a record restored or purged by a concurrent request is never destroyed or resurrected); the nightly purge runs college by college and keeps the 10-day retention. See `docs/PART16_DELETION_INTEGRITY.md`.

PDF/Excel/CSV/ZIP exports, a **college-level** backup + merge-only restore (`/api/admin/backups/college`) and a college-scoped activity log (`/api/admin/activity`) are tenant-isolated; platform-wide database backups are not exposed by the app. See `docs/PART17_REPORTS_BACKUPS_LOGS.md`. **Rotate the MongoDB password and `JWT_SECRET`** — earlier ZIPs shipped them in `backend/.env`.
