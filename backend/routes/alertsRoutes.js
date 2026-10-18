/**
 * alertsRoutes.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Routes for consecutive absence alerts and student analytics.
 *
 * Base: /api/alerts
 */
import express from "express";
import {
  getAlerts,
  createAlert,
  removeAlert,
  updateAlertNote,
  getStudentAnalytics,
} from "../controllers/alertsController.js";
import {
  protect,
  authorize,
  requireApproved,
} from "../middleware/authMiddleware.js";
import { tenantContext, stripClientTenantFields } from "../middleware/tenantGuards.js";

const router = express.Router();

// ─── All routes require authentication + approval ─────────────────────────────
router.use(protect, requireApproved, tenantContext, stripClientTenantFields());

// ── Teacher alert routes ──────────────────────────────────────────────────────

// GET  /api/alerts       — list teacher's alerts (supports ?removed=true,?department,?batch)
// POST /api/alerts/create — manually create an alert
router.get("/", authorize("teacher", "admin"), getAlerts);
router.post("/create", authorize("teacher", "admin"), createAlert);

// PATCH /api/alerts/:id/remove — teacher removes alert (keeps record for history)
// PATCH /api/alerts/:id/note   — teacher updates note
router.patch("/:id/remove", authorize("teacher", "admin"), removeAlert);
router.patch("/:id/note", authorize("teacher", "admin"), updateAlertNote);

// ── Admin student analytics ───────────────────────────────────────────────────
// GET /api/alerts/student/:studentId/analytics — full analytics for one student
// Admin only (Part 13): the analytics span every subject and every teacher's alert
// history for that student of the admin's college; a teacher is not entitled to that.
router.get(
  "/student/:studentId/analytics",
  authorize("admin"),
  getStudentAnalytics
);

export default router;
