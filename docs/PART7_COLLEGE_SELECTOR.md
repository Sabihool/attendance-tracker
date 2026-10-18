# Part 7 — Searchable College Selector

## What it does
Teacher registration (`/signup`) now has a **search box** instead of a free-text/dropdown college field. The
teacher types, picks a result (name + "District, Country"), and the **college ID** is stored on the new user.
Typed text alone can never be submitted: the form needs a real selection, and the server re-verifies the ID.

`<CollegeSearchSelect value onChange error />` is reusable for any other public flow that needs a college.

## API
### `GET /api/colleges/search?q=<text>&limit=<1-20, default 10>` — public, rate-limited
```json
{ "success": true, "message": "Colleges fetched.",
  "data": { "colleges": [ { "collegeId": "COL-7K2M9XQ4TB", "name": "Feni Computer Institute",
                            "district": "Feni", "country": "Bangladesh" } ],
            "count": 1, "minQueryLength": 2 } }
```
| Case | Result |
|---|---|
| `q` missing / blank / < 2 characters | **200**, empty list, **no database query** (never lists everything) |
| `q` is an array/object (`q[]=a`, `q[$ne]=x`), > 80 chars, control chars, bad `limit` | **400** |
| > 60 requests / minute / IP (`COLLEGE_SEARCH_MAX`, `COLLEGE_SEARCH_WINDOW_MS`) | **429** + `Retry-After` |
| Database error | **500**, generic message |

Matching: every word typed must be the **start of a word** in the college name, district or country
(accent/case-insensitive; `fen comp` finds "Feni Computer Institute"; `dhaka` finds colleges in Dhaka).
Ranking: name starts with the query → all words start name words → matched via district/country; ties A–Z.
Only `status: "active"` colleges are returned (suspended, or any future non-active status, is hidden).
Responses carry `Cache-Control: public, max-age=30`.

### `POST /api/auth/signup` (teacher) — changed
New required field **`collegeId`**. 400 with `errors.collegeId` when it is missing, malformed (operator objects,
arrays, plain names), unknown, or the college is suspended. The stored value is the ID returned by the server's own
lookup, not the raw client input. Admin signup is still 403.

## Data / performance
- `College` gains `searchTokens: [String]` (words of name+district+country) and `nameKey` — both `select:false`,
  maintained by a pre-validate hook, never exposed.
- New index `{ status: 1, searchTokens: 1 }` (multikey). Queries use **anchored** prefix regexes (`^word`), which
  MongoDB can serve from the index; unanchored `/word/i` cannot, so it was deliberately avoided.
- Query bounds: ≤ 6 words, ≤ 40 chars/word, 50-row candidate pool, `maxTimeMS` 3 s, explicit field whitelist
  (`collegeId name district country`). Admin emails, `createdBy`, `dedupeKey` and status are never selected.
- **Existing colleges** (from Part 5) have no tokens yet. The server backfills them at startup (idempotent), or run
  `npm run backfill:colleges` (also builds the index).

## Frontend behaviour
Debounce 300 ms · ≥ 2 chars · each keystroke aborts the previous request and stale responses are ignored ·
states: hint, "Searching…", results, "No colleges found…", error with **Try again** (429 / offline / server) ·
keyboard: ↑ ↓ Home End, Enter selects (never submits the form), Esc closes · ARIA combobox/listbox + live-region
announcements · selected college shows as a card with **Change** · phone-friendly (16 px input text, list scrolls
inside a 16 rem box).

## Files
New backend: `utils/collegeSearch.js`, `utils/collegeBackfill.js`, `scripts/backfillCollegeSearch.js`,
`tests/collegeSearch.test.js`, `tests/collegeSearchEndpoint.test.js`, `tests/collegeSearch.integration.test.js`.
Changed backend: `models/College.js`, `controllers/collegeController.js` (+`searchColleges`, `findActiveCollegeById`),
`controllers/authController.js` (`createSignup` factory + college check), `routes/collegeRoutes.js`, `server.js`
(startup backfill), `package.json` (`backfill:colleges`), `.env.example`.
New frontend: `components/forms/CollegeSearchSelect.jsx`, `hooks/useCollegeSearch.js`, `utils/collegeSearch.js`,
`tests/collegeSearch.test.js`.
Changed frontend: `pages/auth/SignupPage.jsx`, `context/AuthContext.jsx` (signup returns field errors),
`services/api.js` (`collegeAPI.search`), `package.json` (`npm test`).

## Tests
- `cd backend && npm test` → **48 pass, 2 skipped** (the two real-DB tests skip without `TEST_MONGO_URI`; point it at a
  throw-away DB to also run the index/COLLSCAN check).
- `cd frontend && npm test` → 8 pass (selector logic). `npm run build` succeeds; no new lint problems.
- Also exercised in headless Chromium at 390 px with a mocked API: hint, 1 char = no request, results, keyboard
  select, form blocked with typed-but-unselected text (no signup request sent), no results, error + retry,
  `collegeId` in the signup payload, stale-response protection, Esc closes. The search filter was cross-checked
  against an independent MongoDB query engine (mingo).

## Not verified
No MongoDB server was available in the build environment, so the live index-usage test (`explain()` shows no
COLLSCAN) exists but **has not been run**. Run it once against your database.

## Part 8 handoff
1. **Run the real-DB test** (`TEST_MONGO_URI=… npm test`) and confirm production has the index
   (`db.colleges.getIndexes()` lists `status_1_searchTokens_1`).
2. **Teacher approval is still not college-scoped.** Teachers now carry `collegeId`, but `GET /auth/users` and
   approve/reject/delete act on every user, so an admin of college A can approve or delete college B's teachers.
   Scope by `req.user.collegeId`; decide how admins with `collegeId: null` (e.g. from `seedAdmin.js`) behave.
3. **Existing teachers have `collegeId: null`** until migrated; they can still log in. Decide how to assign them.
4. No admin UI yet to suspend/reactivate a college — `status` is changed in the database only. Search and signup
   already honour it.
5. `Cache-Control: max-age=30` means a just-suspended college may show in search for ≤ 30 s; signup rejects it immediately.
6. The in-memory rate limiter is per process (as in Part 5); use a shared store if you run several instances.
7. Departments, subjects, students, attendance and settings are still global, not per college.
8. Reuse `CollegeSearchSelect` for any future "join a college" or admin picker.
9. The ZIP contains `backend/.env` and `frontend/.env`; keep real secrets out of anything shared or committed.
