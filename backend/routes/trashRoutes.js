/**
 * Trash Routes — Part 19
 * ──────────────────────
 * Subject-scoped trash operations (teacher + admin):
 *
 *   GET    /api/trash/:subjectId            — list trashed records for a subject
 *   POST   /api/trash/:subjectId/restore/:id — restore a trashed record
 *   DELETE /api/trash/:subjectId/permanent/:id — permanently delete a trashed record
 *   DELETE /api/trash/:subjectId/empty      — empty all trash for a subject
 *
 * Admin-only monitoring routes:
 *
 *   GET    /api/admin/trash                 — global trash view (all subjects)
 *   GET    /api/admin/trash/stats           — system-wide trash statistics
 */

import express from "express";
import {
  getTrash,
  restoreAttendance,
  permanentDeleteAttendance,
  emptyTrash,
  adminGetAllTrash,
  adminTrashStats,
} from "../controllers/trashController.js";
import {
  protect,
  authorize,
  requireApproved,
} from "../middleware/authMiddleware.js";
import { tenantContext, stripClientTenantFields } from "../middleware/tenantGuards.js";
import { activityLogger } from "../services/activityLog.js";

// ─── Subject-scoped trash router ──────────────────────────────────────────────
export const trashRouter = express.Router({ mergeParams: true });

// All subject-scoped trash routes: must be authenticated + approved + teacher or admin
trashRouter.use(protect, requireApproved, tenantContext, stripClientTenantFields(), authorize("teacher", "admin"));

// GET  /api/trash/:subjectId              — list trash for a subject
trashRouter.get("/", getTrash);

// POST /api/trash/:subjectId/restore/:id  — restore a record
trashRouter.post("/restore/:id", activityLogger("trash.restore", { targetType: "attendance", targetParam: "id" }), restoreAttendance);

// DELETE /api/trash/:subjectId/permanent/:id  — permanently delete a record
trashRouter.delete("/permanent/:id", activityLogger("trash.permanent_delete", { targetType: "attendance", targetParam: "id" }), permanentDeleteAttendance);

// DELETE /api/trash/:subjectId/empty  — empty all trash for a subject
trashRouter.delete("/empty", activityLogger("trash.empty", { targetType: "subject", targetParam: "subjectId" }), emptyTrash);

// ─── Admin monitoring router ──────────────────────────────────────────────────
export const adminTrashRouter = express.Router();

// All admin routes: must be admin only
adminTrashRouter.use(protect, requireApproved, tenantContext, stripClientTenantFields(), authorize("admin"));

// GET /api/admin/trash/stats  — system-wide stats (before /:subjectId to avoid conflict)
adminTrashRouter.get("/stats", adminTrashStats);

// GET /api/admin/trash        — global trash view
adminTrashRouter.get("/", adminGetAllTrash);
