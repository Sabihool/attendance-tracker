import express from "express";
import {
  getShifts,
  createShift,
  updateShift,
  deleteShift,
} from "../controllers/shiftController.js";
import { protect, authorize, requireApproved } from "../middleware/authMiddleware.js";
import { tenantContext, stripClientTenantFields } from "../middleware/tenantGuards.js";

const router = express.Router();

// All routes need a signed-in, approved user; everything is limited to that user's own college.
router.use(protect, requireApproved, tenantContext, stripClientTenantFields());

// List (used in forms everywhere)
router.get("/", getShifts);

// Admin only: create / edit / delete
router.post("/", authorize("admin"), createShift);
router.put("/:id", authorize("admin"), updateShift);
router.delete("/:id", authorize("admin"), deleteShift);

export default router;
