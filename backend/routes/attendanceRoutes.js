import express from "express";
import {
  saveAttendance,
  getAttendance,
  getAttendanceById,
  getAttendancePercentage,
  getAttendanceDates,
  updateAttendance,
} from "../controllers/attendanceController.js";
import { softDeleteAttendance } from "../controllers/trashController.js";
import {
  protect,
  authorize,
  requireApproved,
} from "../middleware/authMiddleware.js";
import { tenantContext, stripClientTenantFields } from "../middleware/tenantGuards.js";
import { activityLogger } from "../services/activityLog.js";
import {
  requireSubjectOwner,
  requireAttendanceOwner,
} from "../middleware/teacherMiddleware.js";

const router = express.Router({ mergeParams: true });

// ─── All routes require authentication + approval ─────────────────────────────
// Part 12: tenantContext builds req.tenant from the database session, and any
// client-sent collegeId/tenant field is stripped from body and query. The
// college of an attendance record is never taken from the request.
router.use(protect, requireApproved, tenantContext, stripClientTenantFields(), authorize("teacher", "admin"));

// ─── Subject-scoped routes ────────────────────────────────────────────────────

// POST   /api/attendance/:subjectId         — save new attendance session
// GET    /api/attendance/:subjectId         — get all sessions (active only)
router
  .route("/")
  .post(requireSubjectOwner, activityLogger("attendance.save", { targetType: "subject", targetParam: "subjectId" }), saveAttendance)
  .get(requireSubjectOwner, getAttendance);

// GET    /api/attendance/:subjectId/percentage   — attendance % for all students
router.get("/percentage", requireSubjectOwner, getAttendancePercentage);

// GET    /api/attendance/:subjectId/dates        — Edit Attendance: dates + daily % (step 2)
router.get("/dates", requireSubjectOwner, getAttendanceDates);

// GET    /api/attendance/:subjectId/session/:id  — get a single session
// PUT    /api/attendance/:subjectId/session/:id  — Edit Attendance: flip present/absent (steps 3-4)
// DELETE /api/attendance/:subjectId/session/:id  — soft-delete (move to trash) ← Part 19
router
  .route("/session/:id")
  .get(requireSubjectOwner, requireAttendanceOwner, getAttendanceById)
  .put(requireSubjectOwner, requireAttendanceOwner, activityLogger("attendance.update", { targetType: "attendance", targetParam: "id" }), updateAttendance)
  .delete(requireSubjectOwner, requireAttendanceOwner, activityLogger("attendance.trash", { targetType: "attendance", targetParam: "id" }), softDeleteAttendance);

export default router;
