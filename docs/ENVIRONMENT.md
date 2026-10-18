# Environment variables

Templates: `backend/.env.example`, `frontend/.env.example`. Real `.env` files are git-ignored and are **never** part of the ZIP.

## Backend

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `NODE_ENV` | yes (prod) | – | `production` makes unsafe configuration a start-up failure instead of a warning. |
| `PORT` | no | 5000 | HTTP port (hosts such as Render set it for you). |
| `MONGO_URI` | **yes** | – | MongoDB connection string. Keep it in the host's secret store. |
| `DB_NAME` | no | `attendance_tracker` | Database name. The server **and all scripts** use this one value (the URI's own default would be `test`). |
| `JWT_SECRET` | **yes** | – | ≥ 32 chars, not a placeholder. Production refuses to start otherwise. Rotating it signs everyone out. |
| `JWT_EXPIRES_IN` | no | 7d | Token lifetime. |
| `CLIENT_URL` | **yes** (prod) | `http://localhost:5173` (dev only) | CORS allow-list: comma-separated exact origins. `*` is rejected; production also rejects localhost-only and plain `http://`. |
| `BACKUP_SIGNING_KEY` | recommended | derived from `JWT_SECRET` | HMAC key (≥ 16 chars) for college backup files. Changing it makes old backups unrestorable. |
| `STRICT_COLLEGE_MEMBERSHIP` | after migration | `false` | `true` → accounts without a college get `403 NO_COLLEGE`. |
| `MONGO_SERVER_SELECTION_TIMEOUT_MS` | no | 15000 | How long to wait for the cluster before failing. |
| `TRASH_TTL_DAYS` | no | 10 | Days before trashed sessions are purged by the nightly job. |
| `ANALYTICS_CACHE_TTL_MS` | no | 15000 | Per-college dashboard cache; `0` = off. |
| `ACTIVITY_LOG_TTL_DAYS` | no | 180 | Activity-log retention (TTL index). |
| `BACKUP_RATE_MAX` | no | 20 | College backup/restore requests per college per hour. |
| `COLLEGE_REGISTER_MAX` / `_WINDOW_MS` | no | 5 / 3600000 | College registration limit per IP. |
| `COLLEGE_SEARCH_MAX` / `_WINDOW_MS` | no | 60 / 60000 | Public college search per IP. |
| `TEACHER_SIGNUP_MAX` / `_WINDOW_MS` | no | 10 / 3600000 | Teacher sign-ups per IP. |
| `PUBLIC_LOOKUP_MAX` / `_WINDOW_MS` | no | 60 / 60000 | Public attendance lookups per IP. |
| `PUBLIC_LOOKUP_FAIL_MAX` / `_FAIL_IP_MAX` / `_FAIL_WINDOW_MS` | no | 15 / 40 / 600000 | Failed-guess brakes on the lookup. |
| `LOGIN_FAIL_MAX` / `_IP_MAX` / `_WINDOW_MS` | no | 10 / 50 / 900000 | Failed sign-in brakes. |
| `COLLEGE_NAME` | legacy only | – | Report branding for college-less legacy accounts; irrelevant after the legacy migration. |
| `SEED_ADMIN_NAME/EMAIL/PASSWORD` | script only | – | `npm run seed:admin` (password ≥ 12 chars). |

All rate limiters are **in memory, per process**.

## Frontend (build time)

| Variable | Default | Purpose |
|---|---|---|
| `VITE_API_URL` | `http://localhost:5000/api` | API base URL **including `/api`**. Baked in at build; rebuild after changing. |
| `VITE_APP_NAME` | Attendance Tracker | Display name. |

Everything `VITE_*` is public in the browser bundle — never put a secret there.

## Start-up checks (`utils/securityConfig.js`)
Production exits with the list of problems if: `JWT_SECRET` missing/short/placeholder; `CLIENT_URL` missing, localhost-only, plain `http://` or `*`; `BACKUP_SIGNING_KEY` set but < 16 chars. In development the same problems are warnings.
