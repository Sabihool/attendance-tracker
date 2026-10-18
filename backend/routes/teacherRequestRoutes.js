import express from "express";
import { protect, authorize, requireApproved } from "../middleware/authMiddleware.js";
import { requireCollegeAdmin } from "../services/approvalWiring.js";
import { stripClientTenantFields } from "../middleware/tenantGuards.js";
import { teacherRequestHandlers as h } from "../controllers/teacherRequestController.js";

const router = express.Router();

// Every route: valid token → admin role → admin re-verified in the DB and tied to
// an ACTIVE college (req.adminScope). Nothing below trusts a client-sent college.
router.use(protect, requireApproved, authorize("admin"), requireCollegeAdmin, stripClientTenantFields());

router.get("/", h.list);                      // ?status=pending|approved|rejected|all&page=&limit=
router.get("/summary", h.summary);            // counts for the sidebar badge
router.patch("/:id/approve", h.approve);
router.patch("/:id/reject", h.reject);

export default router;
