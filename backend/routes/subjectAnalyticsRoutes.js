import express from "express";
import { getAllSubjectsAnalytics, getSubjectAnalyticsMeta } from "../controllers/subjectAnalyticsController.js";
import { protect, authorize, requireApproved } from "../middleware/authMiddleware.js";
import { tenantContext } from "../middleware/tenantGuards.js";

const router = express.Router();

// All routes here are admin-only
router.use(protect, requireApproved, tenantContext, authorize("admin"));

router.get("/", getAllSubjectsAnalytics);
router.get("/meta", getSubjectAnalyticsMeta);

export default router;
