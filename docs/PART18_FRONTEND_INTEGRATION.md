# Part 18 — Frontend integration and college identity

## Changes
- Authenticated login and `/auth/me` now include a small server-resolved `college` object (`collegeId`, `name`, `district`, `country`) alongside the safe user profile. The server looks it up using the account's stored `collegeId`; the browser cannot choose the tenant by editing this object.
- The college-creation flow keeps the returned college identity on the signed-in user state, so the new admin sees the same college immediately without needing another login.
- Shared admin and teacher navigation displays the active college and location on wider screens; both dashboard content headers also show it at smaller sizes.
- Added frontend API clients for the Part 17 college backup and activity endpoints. Backup upload uses the backend's expected multipart field `file`; merge restore sends `confirm=RESTORE` in the multipart body as required by the controller, and routes match the mounted backend paths. These endpoints remain protected and college-scoped by backend middleware.
- Existing public college search remains limited to teacher registration and public student attendance lookup. Authenticated academic APIs continue to omit/strip client-supplied college fields and rely on the backend session tenant.

## Security / compatibility notes
- No college switcher or global super-admin UI was added.
- Legacy saved sessions are refreshed through `/auth/me`; the authoritative server profile replaces stale local user data.
- Login response additions are additive (`data.user.college`) and retain existing token/user response fields.
- Backend tenant authorization remains the enforcement boundary. Displayed client state is informational, not authorization.

## Verification
- Frontend unit tests: `npm test` — **39 passed, 0 failed**.
- Frontend production build: **not run successfully in this environment**. `npm run build:frontend` failed because `vite` was not installed; `npm ci` could not complete within the execution environment timeout. No successful build is claimed.
- Browser end-to-end navigation/session/access-denied checks and live database login were not possible in this environment.
