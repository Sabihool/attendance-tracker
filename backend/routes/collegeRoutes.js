import express from "express";
import { registerCollege, searchColleges } from "../controllers/collegeController.js";
import { createRateLimiter } from "../middleware/rateLimit.js";

const router = express.Router();

// Public, so throttle it: default 5 registrations per hour per IP.
const registerLimiter = createRateLimiter({
  windowMs: Number(process.env.COLLEGE_REGISTER_WINDOW_MS) || 60 * 60 * 1000,
  max: Number(process.env.COLLEGE_REGISTER_MAX) || 5,
  message: "Too many registration attempts from this network. Please try again later.",
});

// Public autocomplete. Debounced on the client; 60 lookups/minute per IP by default.
const searchLimiter = createRateLimiter({
  windowMs: Number(process.env.COLLEGE_SEARCH_WINDOW_MS) || 60 * 1000,
  max: Number(process.env.COLLEGE_SEARCH_MAX) || 60,
  message: "Too many searches. Please wait a moment and try again.",
});

// GET /api/colleges/search?q=&limit= — public college lookup (id, name, district, country)
router.get("/search", searchLimiter, searchColleges);

// POST /api/colleges/register — create a college + its initial admin
router.post("/register", registerLimiter, registerCollege);

export default router;
