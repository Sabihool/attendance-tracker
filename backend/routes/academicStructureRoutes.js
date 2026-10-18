import express from "express";
import {
  getAcademicStructure,
  getAcademicStructureSummary,
} from "../controllers/academicStructureController.js";
import { protect, authorize, requireApproved } from "../middleware/authMiddleware.js";
import { tenantContext } from "../middleware/tenantGuards.js";

const router = express.Router();

// All routes here are admin-only
router.use(protect, requireApproved, tenantContext, authorize("admin"));

router.get("/", getAcademicStructure);
router.get("/summary", getAcademicStructureSummary);

export default router;
