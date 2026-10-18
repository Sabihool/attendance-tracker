/**
 * Route wiring: every admin/teacher-request route must sit behind the full
 * guard chain, and the old unscoped handlers must be gone. Inspects the real
 * routers' `stack` (works with real Express 4).
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";

import teacherRequestRoutes from "../routes/teacherRequestRoutes.js";
import notificationRoutes from "../routes/notificationRoutes.js";
import authRoutes, { loginFailuresPerAccount, loginFailuresPerIp } from "../routes/authRoutes.js";
import * as authController from "../controllers/authController.js";
import { protect, requireApproved, authenticate } from "../middleware/authMiddleware.js";
import { requireCollegeAdmin } from "../services/approvalWiring.js";

/** All handlers guarding a route: router-level `use` layers + the route's own stack. */
const chains = (router) => {
  const uses = router.stack.filter((l) => !l.route).map((l) => l.handle);
  return router.stack.filter((l) => l.route).map((l) => ({
    path: l.route.path,
    method: Object.keys(l.route.methods).find((m) => l.route.methods[m]),
    chain: [...uses, ...l.route.stack.map((s) => s.handle)],
  }));
};

const res = () => ({ code: 0, status(c) { this.code = c; return this; }, json() { return this; } });

test("teacher-request routes: protect → requireApproved → authorize(admin) → requireCollegeAdmin on every route", () => {
  const routes = chains(teacherRequestRoutes);
  assert.deepEqual(routes.map((r) => `${r.method} ${r.path}`).sort(),
    ["get /", "get /summary", "patch /:id/approve", "patch /:id/reject"]);
  for (const r of routes) {
    assert.equal(r.chain[0], protect, r.path);
    assert.equal(r.chain[1], requireApproved, r.path);
    assert.ok(r.chain.includes(requireCollegeAdmin), r.path);
    // the authorize('admin') layer rejects a teacher
    const authz = r.chain[2];
    const out = res(); let called = false;
    authz({ user: { role: "teacher" } }, out, () => { called = true; });
    assert.equal(out.code, 403, r.path);
    assert.equal(called, false);
  }
});

test("legacy /auth admin routes are now college-scoped (guarded by requireCollegeAdmin)", () => {
  const admin = chains(authRoutes).filter((r) => r.path.startsWith("/users"));
  assert.deepEqual(admin.map((r) => `${r.method} ${r.path}`).sort(),
    ["delete /users/:id", "get /users", "patch /users/:id/approve", "patch /users/:id/reject"]);
  for (const r of admin) {
    assert.equal(r.chain[0], protect, r.path);
    assert.equal(r.chain[1], requireApproved, r.path);
    assert.ok(r.chain.includes(requireCollegeAdmin), r.path);
  }
});

test("the old unscoped handlers no longer exist", () => {
  for (const name of ["getAllUsers", "approveUser", "rejectUser", "deleteUser"]) {
    assert.equal(authController[name], undefined, name);
  }
});

test("signup is rate limited; me/login are public/protected as before", () => {
  const byPath = Object.fromEntries(chains(authRoutes).map((r) => [`${r.method} ${r.path}`, r.chain]));
  assert.equal(byPath["post /signup"].length, 2, "limiter + handler");
  // Part 19: two failed-sign-in brakes (per IP+e-mail, per IP) sit in front of the handler.
  assert.equal(byPath["post /login"].length, 3, "per-account brake + per-IP brake + handler");
  assert.equal(byPath["post /login"][2], authController.login);
  assert.equal(byPath["post /login"][0], loginFailuresPerIp);
  assert.equal(byPath["post /login"][1], loginFailuresPerAccount);
  assert.equal(byPath["get /me"][0], authenticate, "/me now resolves the session from the database");
});

test("notification routes require login + approval", () => {
  for (const r of chains(notificationRoutes)) {
    assert.equal(r.chain[0], protect, r.path);
    assert.equal(r.chain[1], requireApproved, r.path);
  }
});
