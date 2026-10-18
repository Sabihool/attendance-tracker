# Architecture Overview

## Frontend Architecture

### Import Aliases (vite.config.js)
All imports use `@` aliases instead of fragile relative paths:

| Alias         | Resolves To             |
|---------------|-------------------------|
| `@/`          | `src/`                  |
| `@components` | `src/components/`       |
| `@pages`      | `src/pages/`            |
| `@hooks`      | `src/hooks/`            |
| `@services`   | `src/services/`         |
| `@context`    | `src/context/`          |
| `@utils`      | `src/utils/`            |
| `@constants`  | `src/constants/`        |
| `@styles`     | `src/styles/`           |

### Code Splitting
All teacher and admin pages are **lazy-loaded** via `React.lazy()` in `routes/AppRoutes.jsx`.
Auth pages (Home, Login, Signup) are eagerly loaded as they are always needed.

### State Management
- **AuthContext** — user session, token, login/logout/refresh
- **SubjectsContext** — subject list cache for the active teacher
- **NotificationContext** — in-memory notification store (toast-driven)

### API Layer
- `lib/axios.js` — configured Axios instance with JWT interceptors
- `services/api.js` — all API calls, grouped by resource

---

## Backend Architecture

### Request Flow
```
Client → Express → Route → Middleware → Controller → Model → MongoDB
```

### Key Design Decisions
- **ESM (`"type": "module"`)** throughout — no CommonJS
- **Soft-delete (Trash)** — attendance records are flagged `isTrashed=true`, cleaned by cron after TTL
- **Role-based JWT** — `authMiddleware.js` decodes token; `teacherMiddleware.js` enforces teacher-only routes
- **Export on server** — PDF (PDFKit) and Excel (ExcelJS) generated server-side, streamed as blobs
- **Consecutive Absence Alerts** — triggered inside `attendanceController` after each save; stored in `ConsecutiveAbsenceAlert` collection

### Folder Responsibilities

| Folder        | Purpose                                      |
|---------------|----------------------------------------------|
| `controllers/`| Business logic, response formatting          |
| `models/`     | Mongoose schemas + static helpers            |
| `routes/`     | Express router definitions                   |
| `middleware/` | Auth check, error handler, file upload       |
| `services/`   | Background jobs (cron trash cleanup)         |
| `utils/`      | Pure utility functions (token, response)     |
| `validators/` | Input validation (student JSON upload)       |
| `database/`   | MongoDB connection                           |
| `scripts/`    | One-off admin scripts (seed)                 |


## Security layer (Part 8)
Request flow: `protect` (verify JWT, HS256) → `requireApproved` (resolve the trusted session from the database:
role, approval, college, college status, session version) → `authorize` / `requireAdmin` / `tenantContext`
→ controller using `utils/tenantScope.js`. The JWT's `role` / `collegeId` / `approved` claims are never trusted.
Full details, rules for new routes, and known gaps: `docs/SECURITY_AUTH_AUTHORIZATION.md`.
