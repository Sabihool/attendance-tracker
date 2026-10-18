# Installation and deployment

Architecture (unchanged): **one Express API + one MongoDB database + one static React app.** All colleges share them; isolation is enforced server-side on every request (the college comes from the signed-in user's database record, never from the client).

## Requirements
Node.js ≥ 20 (tested on 22), npm ≥ 10, MongoDB 6+ (Atlas or self-hosted). For multi-document transactions (college registration is atomic) use a **replica set** (Atlas always is); on a standalone `mongod` the code falls back to a compensating cleanup.

## 1. Local development
```bash
# from the project root
npm run install:all                 # installs backend + frontend (or: cd backend && npm ci; cd ../frontend && npm ci)
cp backend/.env.example backend/.env       # fill MONGO_URI, JWT_SECRET (see docs/ENVIRONMENT.md)
cp frontend/.env.example frontend/.env
npm install                         # root: installs `concurrently`
npm run dev                         # API :5000 + Vite :5173
```
First college: open http://localhost:5173/register-college. (`npm run seed:admin` is only for legacy, college-less setups.)

## 2. Checks before you deploy
```bash
cd backend  && npm ci && npm test            # 581 tests (578 run, 3 real-DB tests skipped), ~12 minutes sequentially (CPU bound; no database needed)
cd frontend && npm ci && npm test && npm run build
```
`backend` tests use an in-memory Mongo fake. Two optional real-database tests run when `TEST_MONGO_URI` points at a **throw-away** database (use a replica set to cover transactions):
```bash
TEST_MONGO_URI="mongodb://localhost:27017/at_test?replicaSet=rs0" npm test
```

## 3. Production
### API (any Node host: Render, Railway, Fly, a VM…)
* Build: `cd backend && npm ci --omit=dev`; start: `npm start` (`node server.js`).
* Environment: see `docs/ENVIRONMENT.md`. Minimum: `NODE_ENV=production`, `MONGO_URI`, `DB_NAME`, `JWT_SECRET` (≥ 32 random chars), `CLIENT_URL=https://<your frontend origin>`; recommended `BACKUP_SIGNING_KEY`, and `STRICT_COLLEGE_MEMBERSHIP=true` once migrated.
* The server sets `trust proxy` to 1 (one reverse proxy/load balancer in front: Render, Railway, Nginx). If you run **without** a proxy, or behind two, change `app.set('trust proxy', …)` in `server.js`, otherwise rate limiting sees the wrong client IP.
* Terminate TLS at the proxy; the API sends HSTS when the request arrived over HTTPS.
* Health check: `GET /` → `{status:"OK"}`. The process shuts down gracefully on SIGTERM and exits 1 if MongoDB is unreachable at boot (the platform restarts it).
* **Single instance recommended.** Rate limiters and the dashboard cache are in memory, and the nightly purge runs inside the process; with several instances limits multiply and the purge runs per instance (harmless, but redundant).
* Atlas: allow-list the host's egress IPs; use a dedicated DB user with `readWrite` on `DB_NAME` only.
* Upgrading an existing install: **do the migration first** — `docs/MIGRATION_AND_BACKUP.md`.

### Frontend (Netlify, Vercel, Render Static, Nginx…)
```bash
cd frontend
VITE_API_URL=https://<api-host>/api npm run build     # output: frontend/dist
```
Serve `dist/` as a single-page app: every unknown path must return `index.html` (`public/_redirects` is included for Netlify/Render; on Vercel add a rewrite `/(.*) → /index.html`; Nginx `try_files $uri /index.html;`). Set the API's `CLIENT_URL` to exactly this site's origin. The JWT is stored in the browser's `localStorage` (see limitations).

### Docker/Compose
Not provided (not requested; the architecture is two processes + MongoDB). A plain `node:22-alpine` image running `npm ci --omit=dev && node server.js` in `backend/` works.

## 4. Manual setup that cannot be automated safely
* Creating/rotating secrets and the Atlas user; **rotate any credential that was ever in an earlier ZIP** (the Part 18 ZIPs contained a real DB password and JWT secret).
* Platform-level database backups and their retention.
* Choosing the founder admin and name/district of the original college during migration.
* DNS/TLS, CORS origin, SPA rewrite on your static host.
* Deciding the open policy items listed in `PART20_FINAL_REPORT.md` (public-lookup second factor, teacher uploads, shared rate-limit store).
