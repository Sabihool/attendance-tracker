/**
 * Mounted at /api/admin/activity (server.js).
 *   GET /   — this college's activity log  ?actorId=&role=&action=&from=&to=&page=&limit=
 * Admin of the caller's own college only; teachers get 403.
 */
import express from "express";
import { protect, authorize, requireApproved } from "../middleware/authMiddleware.js";
import { requireCollegeAdmin } from "../services/approvalWiring.js";
import { tenantContext, stripClientTenantFields } from "../middleware/tenantGuards.js";
import { getActivity } from "../controllers/activityController.js";

const router = express.Router();
router.use(protect, requireApproved, authorize("admin"), tenantContext, requireCollegeAdmin, stripClientTenantFields());
router.get("/", getActivity);
export default router;
