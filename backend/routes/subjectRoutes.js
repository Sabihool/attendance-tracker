import express from "express";
import {
  createSubject,
  getSubjects,
  getSubjectById,
  updateSubject,
  deleteSubject,
  getSubjectMeta,
  getAssignableTeachers,
} from "../controllers/subjectController.js";
import { protect, authorize, requireApproved } from "../middleware/authMiddleware.js";
import { tenantContext, stripClientTenantFields } from "../middleware/tenantGuards.js";
import { activityLogger } from "../services/activityLog.js";

const router = express.Router();

// ─── All routes require authentication + approval, and are college-scoped ─────
// (/meta used to be public; it now returns only the caller's own college's
// departments and shifts, so it needs the session to know which college that is.)
// A college id in the body/query is never read; it is dropped before any handler sees it.
router.use(protect, requireApproved, tenantContext, stripClientTenantFields());

// GET /api/subjects/meta  — valid values (this college's departments, shifts, …)
router.get("/meta", getSubjectMeta);

// GET /api/subjects/teachers — approved teachers of the admin's college (assignment selector)
router.get("/teachers", authorize("admin"), getAssignableTeachers);

// ─── Teacher & Admin routes ───────────────────────────────────────────────────
// POST   /api/subjects       — create a new subject
// GET    /api/subjects       — list own subjects (teacher) or all (admin with ?teacherId)
router
  .route("/")
  .post(authorize("teacher", "admin"), createSubject)
  .get(authorize("teacher", "admin"), getSubjects);

// GET    /api/subjects/:id   — get single subject
// PUT    /api/subjects/:id   — update subject
// DELETE /api/subjects/:id   — delete subject
router
  .route("/:id")
  .get(authorize("teacher", "admin"), getSubjectById)
  .put(authorize("teacher", "admin"), updateSubject)
  .delete(authorize("teacher", "admin"), activityLogger("subject.delete", { targetType: "subject", targetParam: "id" }), deleteSubject);

export default router;
