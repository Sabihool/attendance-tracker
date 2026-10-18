/**
 * Mounted at /api/admin/backups (server.js). Admin of the caller's own college only.
 *
 *   GET  /college                      download this college's backup (signed JSON)
 *   POST /college/restore/preview      multipart "file" — dry run, writes nothing
 *   POST /college/restore              multipart "file" + confirm=RESTORE — merge-only restore
 *
 * There is deliberately no platform-wide route here. A platform backup file (or any file
 * that is not a signed backup of THIS college) is refused by the service.
 */
import express from "express";
import multer from "multer";
import { protect, authorize, requireApproved } from "../middleware/authMiddleware.js";
import { requireCollegeAdmin } from "../services/approvalWiring.js";
import { tenantContext, stripClientTenantFields } from "../middleware/tenantGuards.js";
import { createRateLimiter } from "../middleware/rateLimit.js";
import { downloadCollegeBackup, previewCollegeRestore, applyCollegeRestore } from "../controllers/backupController.js";

export const MAX_BACKUP_UPLOAD_BYTES = 25 * 1024 * 1024;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BACKUP_UPLOAD_BYTES, files: 1, fields: 5 },
}).single("file");

/** Same multer, but upload problems become a clear 400 (the global handler's text mentions the 2 MB student-import limit). */
const acceptUpload = (req, res, next) =>
  upload(req, res, (err) => {
    if (!err) return next();
    const tooBig = err.code === "LIMIT_FILE_SIZE";
    return res.status(tooBig ? 413 : 400).json({
      success: false, code: tooBig ? "BACKUP_TOO_LARGE" : "BACKUP_UPLOAD_ERROR",
      message: tooBig ? `Backup file is too large (maximum ${MAX_BACKUP_UPLOAD_BYTES / 1024 / 1024} MB).` : "Could not read the uploaded file.",
    });
  });

// Backups are heavy and sensitive: a few per college per hour is plenty. Keyed by college, not IP.
export const backupLimiter = createRateLimiter({
  windowMs: 60 * 60 * 1000,
  max: parseInt(process.env.BACKUP_RATE_MAX, 10) || 20,
  message: "Too many backup requests for this college. Please try again later.",
  keyGenerator: (req) => `${req.tenant?.collegeId ?? "none"}`,
});

const router = express.Router();
router.use(protect, requireApproved, authorize("admin"), tenantContext, requireCollegeAdmin, stripClientTenantFields(), backupLimiter);

router.get("/college", downloadCollegeBackup);
router.post("/college/restore/preview", acceptUpload, previewCollegeRestore);
router.post("/college/restore", acceptUpload, applyCollegeRestore);

export default router;
