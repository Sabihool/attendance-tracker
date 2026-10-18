import express from "express";
import { protect, authorize, requireApproved } from "../middleware/authMiddleware.js";
import { requireCollegeAdmin } from "../services/approvalWiring.js";
import { tenantContext } from "../middleware/tenantGuards.js";
import { rejectPrivilegedFields } from "../middleware/privilegeGuards.js";
import { activityLogger } from "../services/activityLog.js";
import { teacherManagementHandlers as h } from "../controllers/teacherManagementController.js";

const router = express.Router();

// valid token → live DB session → admin role → tenant context (cache invalidation on writes)
// → admin re-verified against an ACTIVE college (req.adminScope) → no role/college/approval
// fields accepted from the client. Nothing below reads a college or a role from the request.
router.use(protect, requireApproved, authorize("admin"), tenantContext, requireCollegeAdmin, rejectPrivilegedFields);

router.get("/", h.list);                    // ?type=teacher|admin|all&status=pending|approved|rejected|all&q=&page=&limit=
router.get("/summary", h.summary);
router.get("/:id", h.detail);               // profile + status + activity + subjects
router.patch("/:id/approve", activityLogger("teacher.approve", { targetType: "user", targetParam: "id" }), h.approve);
router.patch("/:id/reject", activityLogger("teacher.reject", { targetType: "user", targetParam: "id" }), h.reject);
router.patch("/:id/promote", activityLogger("teacher.promote", { targetType: "user", targetParam: "id" }), h.promote);    // teacher → admin of THIS college
router.patch("/:id/demote", activityLogger("teacher.demote", { targetType: "user", targetParam: "id" }), h.demote);      // admin → teacher (founder / self / last admin refused)
router.delete("/:id", activityLogger("teacher.delete", { targetType: "user", targetParam: "id" }), h.remove);            // teachers only (existing hard-delete behaviour)

export default router;
