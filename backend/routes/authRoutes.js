import express from "express";
import { signup, login, getMe } from "../controllers/authController.js";
import { protect, authenticate, authorize, requireApproved } from "../middleware/authMiddleware.js";
import { stripClientTenantFields } from "../middleware/tenantGuards.js";
import { requireCollegeAdmin } from "../services/approvalWiring.js";
import { teacherRequestHandlers as h } from "../controllers/teacherRequestController.js";
import { createRateLimiter, createFailureLimiter } from "../middleware/rateLimit.js";

const router = express.Router();

// ─── Public routes ────────────────────────────────────────────────────────────
// POST /api/auth/signup  — register a new account
// Rate-limited: every signup notifies the college's admins, so it must not be spammable.
const signupLimiter = createRateLimiter({
  windowMs: Number(process.env.TEACHER_SIGNUP_WINDOW_MS) || 60 * 60 * 1000,
  max: Number(process.env.TEACHER_SIGNUP_MAX) || 10,
  message: "Too many sign-up attempts from this network. Please try again later.",
});
router.post("/signup", signupLimiter, signup);

// POST /api/auth/login   — authenticate and receive token
// Brute-force brakes (per client IP; server.js sets `trust proxy`). Only FAILED attempts (status >= 400) count,
// so people who type the right password are never throttled:
//  - per IP + e-mail: stops guessing one account's password;
//  - per IP: stops spraying one password across many accounts.
export const loginFailuresPerAccount = createFailureLimiter({
  windowMs: Number(process.env.LOGIN_FAIL_WINDOW_MS) || 15 * 60 * 1000,
  max: Number(process.env.LOGIN_FAIL_MAX) || 10,
  message: "Too many failed sign-in attempts. Please wait a few minutes and try again.",
  keyGenerator: (req) => `${req.ip}|${typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase().slice(0, 254) : ""}`,
});
export const loginFailuresPerIp = createFailureLimiter({
  windowMs: Number(process.env.LOGIN_FAIL_WINDOW_MS) || 15 * 60 * 1000,
  max: Number(process.env.LOGIN_FAIL_IP_MAX) || 50,
  message: "Too many failed sign-in attempts. Please wait a few minutes and try again.",
});
router.post("/login", loginFailuresPerIp, loginFailuresPerAccount, login);

// ─── Protected routes (any authenticated user) ────────────────────────────────
// GET /api/auth/me       — get own profile
router.get("/me", authenticate, getMe);

// ─── Admin-only routes (college-scoped — Part 8) ─────────────────────────────
// Kept for backwards compatibility. They now only ever touch users of the
// CALLING admin's own college. Prefer /api/admin/teacher-requests for new code.
const collegeAdmin = [protect, requireApproved, authorize("admin"), requireCollegeAdmin, stripClientTenantFields()];

// GET /api/auth/users               — this college's users (?role=teacher&approved=false)
router.get("/users", ...collegeAdmin, h.legacyList);

// PATCH /api/auth/users/:id/approve — approve a pending teacher of this college
router.patch("/users/:id/approve", ...collegeAdmin, h.approve);

// PATCH /api/auth/users/:id/reject  — reject a pending teacher of this college
router.patch("/users/:id/reject", ...collegeAdmin, h.reject);

// DELETE /api/auth/users/:id        — delete a user of this college
router.delete("/users/:id", ...collegeAdmin, h.remove);

export default router;
