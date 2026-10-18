import express from "express";
import {
  uploadStudentJSON,
  getStudents,
  getStudentGroups,
  deleteStudentGroup,
  getBatches,
  adminGetAllStudents,
  adminCreateStudent,
  adminUpdateStudent,
  adminDeleteStudent,
  getStudentDirectory,
} from "../controllers/studentController.js";
import { protect, authorize, requireApproved } from "../middleware/authMiddleware.js";
import { tenantContext, stripClientTenantFields } from "../middleware/tenantGuards.js";
import { uploadJson } from "../middleware/jsonUploadMiddleware.js";

const router = express.Router();

// ─── All routes require authentication + approval ─────────────────────────────
router.use(protect, requireApproved, tenantContext, stripClientTenantFields());

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/students/upload
// Upload a JSON file with student list for a department / batch / shift.
// Form-data fields:
//   file       — the .json file
//   department — e.g. "Computer Science & Engineering"
//   batch      — e.g. "2021-2025"
//   shift      — "morning" | "day" | "afternoon"
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  "/upload",
  authorize("teacher", "admin"),
  uploadJson.single("file"),       // Multer saves file → req.file
  uploadStudentJSON                // Controller reads, validates, upserts
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/students
// Fetch students by group. All are query params:
//   department (required)
//   batch      (optional)
//   shift      (optional)
// ─────────────────────────────────────────────────────────────────────────────
router.get("/", authorize("teacher", "admin"), getStudents);

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/students/groups
// List all unique department/batch/shift combinations.
// ─────────────────────────────────────────────────────────────────────────────
router.get("/groups", authorize("teacher", "admin"), getStudentGroups);

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/students/batches
// Distinct batch values sourced ONLY from uploaded student data (spec #9).
// Optional filters: ?department=&shift=
// ─────────────────────────────────────────────────────────────────────────────
router.get("/batches", authorize("teacher", "admin"), getBatches);

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/students/group
// Soft-delete all students in a department/batch/shift.
// Body: { department, batch, shift }
// Admin only — irreversible from API perspective.
// ─────────────────────────────────────────────────────────────────────────────
router.delete("/group", authorize("admin"), deleteStudentGroup);

// ═══════════════════════════════════════════════════════════════════════════
// Student Management System (spec section 8) — admin-only individual CRUD
// ═══════════════════════════════════════════════════════════════════════════

// GET  /api/students/admin       — view all students, filter by department/shift/batch
// POST /api/students/admin       — add a new student manually
router
  .route("/admin")
  .get(authorize("admin"), adminGetAllStudents)
  .post(authorize("admin"), adminCreateStudent);

// PUT    /api/students/admin/:id — edit a student's information
// DELETE /api/students/admin/:id — remove a student (soft-delete by default, ?hard=true to purge)
router
  .route("/admin/:id")
  .put(authorize("admin"), adminUpdateStudent)
  .delete(authorize("admin"), adminDeleteStudent);

// ═══════════════════════════════════════════════════════════════════════════
// Global Student Directory (Feature 3) — admin-only "All Students" page
// ═══════════════════════════════════════════════════════════════════════════

// GET /api/students/directory — every student, searchable/sortable/paginated,
// with computed Overall Attendance %, Credit Score, and Total Subjects.
router.get("/directory", authorize("admin"), getStudentDirectory);

export default router;
