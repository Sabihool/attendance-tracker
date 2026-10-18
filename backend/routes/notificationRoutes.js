import express from "express";
import { protect, requireApproved } from "../middleware/authMiddleware.js";
import { notificationHandlers as h } from "../controllers/notificationController.js";

const router = express.Router();
router.use(protect, requireApproved);

router.get("/", h.list);
router.patch("/read-all", h.markAllRead);
router.patch("/:id/read", h.markRead);
router.delete("/", h.clear);
router.delete("/:id", h.remove);

export default router;
