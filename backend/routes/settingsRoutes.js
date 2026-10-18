import express from "express";
import { getSettings, updateSettings } from "../controllers/settingsController.js";
import { protect, authorize, requireApproved } from "../middleware/authMiddleware.js";
import { tenantContext, stripClientTenantFields } from "../middleware/tenantGuards.js";

const router = express.Router();

// All routes require authentication
router.use(protect, requireApproved, tenantContext, stripClientTenantFields());

// GET /api/settings — any authenticated user can read (teachers need alert threshold)
router.get("/", getSettings);

// PUT /api/settings — admin only
router.put("/", authorize("admin"), updateSettings);

export default router;
