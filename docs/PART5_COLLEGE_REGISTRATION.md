# Part 5 — College Account Creation

## What it does
`POST /api/colleges/register` creates a **College** and its first **admin** in one step.
Frontend page: `/register-college` (linked from Home and Login).

| Request field | Rules |
|---|---|
| `collegeName` | 2–120 chars, letters/digits/space and `. , ' & ( ) / -` |
| `country` | 2–80 chars, letters/space and `. , ' ( ) -` |
| `district` | 2–80 chars, same as country |
| `adminName` | 2–100 chars, letters/space and `. ' -` |
| `adminEmail` | valid email, ≤254, stored lower-case |
| `password` | 8–72 bytes, ≥1 letter and ≥1 number, no leading/trailing space |
| `confirmPassword` | must equal `password` |

Any other field (`role`, `collegeId`, `approved`, …) is ignored.

**201** → `{ token, user, college }` (user is the public projection, no hash; the admin is signed in).
**400** → `{ message, errors: { field: "…" } }` · **409** duplicate email or college · **429** rate limited.

## Security decisions
- `collegeId` (`COL-XXXXXXXXXX`, crypto-random) is generated server-side; unique index + retry on collision.
- Role is always `admin`, `approved: true`, `collegeId` = the new college. Never from the client.
- Passwords hashed by the existing `User` pre-save hook (bcryptjs, cost 12). `password` is `select:false`; responses use `toPublicJSON()`.
- Atomic create via existing `runInTransaction`. Without transaction support (standalone dev Mongo) the college is deleted manually if admin creation fails.
- Duplicate college = same name + country + district, ignoring case/spacing/accents (`College.dedupeKey`, unique index). Duplicate email = existing global unique index on `User.email`.
- Per-IP rate limit: 5 registrations/hour (in-memory; `trust proxy` enabled for Render).
- **Behavior change:** public `POST /api/auth/signup` now returns 403 for `role: "admin"` (previously anyone could self-register as admin). Teacher signup is unchanged.

## Files
New: `models/College.js`, `utils/collegeId.js`, `validators/collegeValidator.js`, `middleware/rateLimit.js`, `controllers/collegeController.js`, `routes/collegeRoutes.js`, `tests/*`, `.env.example`; frontend `pages/auth/RegisterCollegePage.jsx`, `utils/collegeValidation.js`.
Changed: `models/User.js` (+optional `collegeId`), `utils/token.js` (+`collegeId` in JWT), `controllers/authController.js` (admin signup blocked), `server.js` (route, trust proxy), `package.json` (test script), frontend `AuthContext`, `api.js`, `axios.js`, `AppRoutes.jsx`, `constants/app.js`, `HomePage.jsx`, `LoginPage.jsx`.

## Tests
`cd backend && npm test` — 23 pass, 1 skipped (real-DB integration test; set `TEST_MONGO_URI` to a throw-away DB, ideally a replica set/Atlas, to run it).

## Part 6 handoff
- **Not done:** teacher approval workflow; tenant scoping of any existing query/model (departments, subjects, students, attendance, settings, alerts, exports, cron) — they are still global.
- `User.collegeId` is optional; existing users have `null` until a migration assigns them to a college. `scripts/seedAdmin.js` creates a college-less admin.
- Email is globally unique (current design). Decide whether that stays in the multi-college model.
- Teacher signup has no college selection yet (`/signup` is college-less); Part 6 should add a college lookup/join code and make approval admin-of-that-college only.
- `protect` middleware puts `collegeId` on `req.user` (from JWT) — use it, never request input, for scoping.
- `getAllUsers/approveUser/rejectUser/deleteUser` are not college-scoped yet (an admin of one college can act on any user) — must be fixed before multi-college production use.
