/**
 * Route audit — every route of every router must either sit behind the full
 * authentication chain (protect → requireApproved) or be on an explicit
 * public list. Adding an unauthenticated route without updating this list fails
 * the test, so a new route can't be left open by accident.
 *
 * IMPORTANT: this proves routes are AUTHENTICATED, not that their data is
 * college-scoped. Scoping is integrated route-by-route in later parts.
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-test-secret-test-secret-123";

import { protect, requireApproved, authenticate } from "../middleware/authMiddleware.js";

import authRoutes from "../routes/authRoutes.js";
import collegeRoutes from "../routes/collegeRoutes.js";
import publicAttendanceRoutes from "../routes/publicAttendanceRoutes.js";
import teacherRequestRoutes from "../routes/teacherRequestRoutes.js";
import teacherManagementRoutes from "../routes/teacherManagementRoutes.js";
import notificationRoutes from "../routes/notificationRoutes.js";
import departmentRoutes from "../routes/departmentRoutes.js";
import shiftRoutes from "../routes/shiftRoutes.js";
import attendanceCategoryRoutes from "../routes/attendanceCategoryRoutes.js";
import settingsRoutes from "../routes/settingsRoutes.js";
import subjectRoutes from "../routes/subjectRoutes.js";
import attendanceRoutes from "../routes/attendanceRoutes.js";
import studentRoutes from "../routes/studentRoutes.js";
import exportRoutes from "../routes/exportRoutes.js";
import { trashRouter, adminTrashRouter } from "../routes/trashRoutes.js";
import alertsRoutes from "../routes/alertsRoutes.js";
import teacherPerformanceRoutes from "../routes/teacherPerformanceRoutes.js";
import subjectAnalyticsRoutes from "../routes/subjectAnalyticsRoutes.js";
import academicStructureRoutes from "../routes/academicStructureRoutes.js";
import activityRoutes from "../routes/activityRoutes.js";
import backupRoutes from "../routes/backupRoutes.js";

const routers = {
  auth: authRoutes, colleges: collegeRoutes, "public/attendance": publicAttendanceRoutes, "admin/teacher-requests": teacherRequestRoutes, "admin/teachers": teacherManagementRoutes,
  notifications: notificationRoutes, departments: departmentRoutes, shifts: shiftRoutes,
  "attendance-categories": attendanceCategoryRoutes, settings: settingsRoutes, subjects: subjectRoutes,
  attendance: attendanceRoutes, students: studentRoutes, export: exportRoutes, trash: trashRouter,
  "admin/trash": adminTrashRouter, alerts: alertsRoutes, "admin/teacher-performance": teacherPerformanceRoutes,
  "admin/subjects": subjectAnalyticsRoutes, "admin/academic-structure": academicStructureRoutes,
  "admin/activity": activityRoutes, "admin/backups": backupRoutes,
};

const describeRoutes = (name, router) => {
  const uses = router.stack.filter((l) => !l.route).map((l) => l.handle);
  return router.stack.filter((l) => l.route).flatMap((l) =>
    Object.keys(l.route.methods).filter((m) => l.route.methods[m]).map((method) => {
      // Express runs router-level `use` layers that were registered BEFORE the route; approximate by index.
      const idx = router.stack.indexOf(l);
      const before = router.stack.slice(0, idx).filter((x) => !x.route).map((x) => x.handle);
      const chain = [...before, ...l.route.stack.map((s) => s.handle)];
      void uses;
      return { key: `${method} /api/${name}${l.route.path === "/" ? "" : l.route.path}`, chain };
    })
  );
};

const all = Object.entries(routers).flatMap(([name, r]) => describeRoutes(name, r));
const isAuthenticated = (chain) => {
  if (chain.includes(authenticate)) return true; // protect + requireApproved combined
  const p = chain.indexOf(protect), a = chain.indexOf(requireApproved);
  return p >= 0 && a > p;
};

// Genuinely public by design.
const PUBLIC = ["post /api/auth/signup", "post /api/auth/login", "get /api/colleges/search", "post /api/colleges/register",
  "post /api/public/attendance/lookup"]; // Part 14: student lookup, strictly scoped in its controller

// Public TODAY and not college-scoped. Departments, shifts and /subjects/meta were closed in Part 9;
// attendance categories were closed in Part 12 (per-college, authenticated). Nothing is left open.
const KNOWN_OPEN_GAPS = [];

test("route audit: the router inventory is non-trivial", () => {
  assert.ok(all.length > 60, `only ${all.length} routes found`);
});

test("route audit: every route is authenticated (protect → requireApproved) unless explicitly public", () => {
  const open = all.filter((r) => !isAuthenticated(r.chain)).map((r) => r.key).sort();
  assert.deepEqual(open, [...PUBLIC, ...KNOWN_OPEN_GAPS].sort());
});

test("route audit: known open gaps (none left after Part 12) are still genuinely open", () => {
  const open = all.filter((r) => !isAuthenticated(r.chain)).map((r) => r.key);
  for (const g of KNOWN_OPEN_GAPS) assert.ok(open.includes(g), `${g} is now protected — remove it from KNOWN_OPEN_GAPS`);
});

test("route audit: admin routers are guarded by an authorization layer after authentication", () => {
  for (const name of ["admin/teacher-requests", "admin/teachers", "admin/trash", "admin/teacher-performance", "admin/subjects", "admin/academic-structure", "admin/activity", "admin/backups"]) {
    for (const r of describeRoutes(name, routers[name])) {
      assert.ok(isAuthenticated(r.chain), r.key);
      assert.ok(r.chain.length >= 3, `${r.key} has no authorization layer`);
    }
  }
});

test("route audit (Part 9): academic-structure routes build req.tenant (tenantContext) right after authentication", async () => {
  const { tenantContext } = await import("../middleware/tenantGuards.js");
  const scoped = ["departments", "shifts", "subjects", "students", "admin/academic-structure", "admin/teacher-performance", "admin/subjects", "alerts", "trash", "admin/trash", "admin/teachers",
    // Part 12: the attendance and credit system
    "attendance", "export", "attendance-categories", "settings",
    // Part 17: college activity log + college backups
    "admin/activity", "admin/backups"];
  for (const name of scoped) {
    for (const r of describeRoutes(name, routers[name])) {
      const t = r.chain.indexOf(tenantContext);
      assert.ok(t > r.chain.indexOf(requireApproved) && r.chain.indexOf(requireApproved) >= 0, `${r.key} has no tenantContext after requireApproved`);
    }
  }
});
