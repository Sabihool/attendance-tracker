import express from "express";
import {
  getCategories,
  createCategory,
  updateCategory,
  deleteCategory,
} from "../controllers/attendanceCategoryController.js";
import { protect, authorize, requireApproved } from "../middleware/authMiddleware.js";
import { tenantContext, stripClientTenantFields } from "../middleware/tenantGuards.js";

const router = express.Router();

// Part 12: categories belong to a college, so every route — including the list —
// needs a signed-in, approved user and runs inside that user's college. A client
// `collegeId` in the body/query is stripped; the college only ever comes from the
// database session.
router.use(protect, requireApproved, tenantContext, stripClientTenantFields());

// List: used in attendance taking, subject editing and reports (teachers + admins).
router.get("/", authorize("teacher", "admin"), getCategories);

// Admin only: create / edit / delete (including default categories) — own college only
router.post("/", authorize("admin"), createCategory);
router.put("/:id", authorize("admin"), updateCategory);
router.delete("/:id", authorize("admin"), deleteCategory);

export default router;
