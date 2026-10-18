/**
 * exportRoutes.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Attendance Tracker — Part 18 (Export System)
 * Author: Sabihool
 *
 * Base path (mounted in server.js):
 *   /api/export/:subjectId
 *
 * Routes:
 *   GET /api/export/:subjectId/meta      — Preview export info
 *   GET /api/export/:subjectId/pdf       — Download PDF report
 *   GET /api/export/:subjectId/excel     — Download Excel (.xlsx) report
 *   GET /api/export/:subjectId/csv       — Download CSV report
 *                                          ?type=summary|sessions|matrix
 *
 * Optional query filters for all download routes:
 *   ?startDate=YYYY-MM-DD
 *   ?endDate=YYYY-MM-DD
 *   ?classType=theory|lab|tutorial|viva
 * ─────────────────────────────────────────────────────────────────────────────
 */

import express from "express";
import {
  exportPDF,
  exportExcel,
  exportCSV,
  exportRegisterPDF,
  exportSubjectZip,
  getExportMeta,
} from "../controllers/exportController.js";
import {
  protect,
  authorize,
  requireApproved,
} from "../middleware/authMiddleware.js";
import { requireSubjectOwner } from "../middleware/teacherMiddleware.js";
import { tenantContext, stripClientTenantFields } from "../middleware/tenantGuards.js";
import { activityLogger } from "../services/activityLog.js";

const router = express.Router({ mergeParams: true });

// ─── All export routes require: auth + approval + teacher/admin + subject owner ──
router.use(protect, requireApproved, tenantContext, stripClientTenantFields(), authorize("teacher", "admin"), requireSubjectOwner);

// Part 17: every export contains a college's student data. Never let a browser, proxy or CDN keep a copy.
router.use((_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  next();
});

// Part 17: a download is recorded in the caller's college activity log (success only).
const logExport = (action, format) => activityLogger(action, { targetType: "subject", targetParam: "subjectId", meta: { format } });

// ── GET /api/export/:subjectId/meta ──────────────────────────────────────────
// Returns export metadata (subject info, stats, available formats)
router.get("/meta", getExportMeta);

// ── GET /api/export/:subjectId/pdf ───────────────────────────────────────────
// Streams a fully-formatted PDF attendance report
router.get("/pdf", logExport("export.pdf", "pdf"), exportPDF);

// ── GET /api/export/:subjectId/excel ─────────────────────────────────────────
// Streams a multi-sheet Excel (.xlsx) workbook:
//   Sheet 1: Info (college, subject, teacher)
//   Sheet 2: Student Summary
//   Sheet 3: Session Log
//   Sheet 4: Attendance Matrix (students × sessions)
router.get("/excel", logExport("export.excel", "excel"), exportExcel);

// ── GET /api/export/:subjectId/csv?type=summary|sessions|matrix ───────────────
// Streams a CSV file
//   type=summary  (default) — one row per student with totals
//   type=sessions           — one row per class session
//   type=matrix             — students × sessions grid (P/A)
router.get("/csv", logExport("export.csv", "csv"), exportCSV);

// ── GET /api/export/:subjectId/register/pdf ──────────────────────────────────
// Streams the printable, session-by-session attendance register PDF (one
// column per date, P/A per student) — used as the pre-deletion backup and
// available as a standalone download too.
router.get("/register/pdf", logExport("export.register_pdf", "register_pdf"), exportRegisterPDF);

// ── GET /api/export/:subjectId/register/zip ──────────────────────────────────
// Streams a ZIP containing both the register PDF and the matrix CSV, inside
// a SubjectName_Attendance/ folder — the "download both" option required
// before a subject can be permanently deleted.
router.get("/register/zip", logExport("export.zip", "zip"), exportSubjectZip);

export default router;
