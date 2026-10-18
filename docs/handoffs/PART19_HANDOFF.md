# Part 20 handoff — final integration and deployment

Full audit: `docs/PART19_SECURITY_AUDIT.md` (read the "NOT EXECUTED" table first).

## Do before deploying
1. `cd backend && npm ci && npm test` — the sandbox had no registry access, so only 47 tests actually ran
   (29 new unit + 18 existing validator tests). The new `tests/securityAudit.test.js` (HTTP, two colleges) and the other 23 test files are unrun.
2. `npm audit` (xlsx 0.18.5, multer 1.x, etc.).
3. Rotate DB password + `JWT_SECRET`; set `BACKUP_SIGNING_KEY`; set `NODE_ENV=production`.
4. Redeploy without `/uploads` (no longer served). Move uploaded rosters off the web host if you want to keep them.
5. New env knobs: `LOGIN_FAIL_MAX`, `LOGIN_FAIL_IP_MAX`, `LOGIN_FAIL_WINDOW_MS`, `SEED_ADMIN_*`.
6. Decide the open items in §5 of the audit (public-lookup second factor, teacher uploads, shared rate-limit store).
