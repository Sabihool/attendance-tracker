import express from "express";
import { lookupAttendance } from "../controllers/publicAttendanceController.js";
import { createRateLimiter, createFailureLimiter } from "../middleware/rateLimit.js";

const router = express.Router();

// PUBLIC (no login): student "See Your Attendance" lookup. Three brakes, all
// per client IP (server.js sets `trust proxy`), all tunable from the environment:
//  - overall: lookups per minute (generous: a campus can share one IP);
//  - failures: unsuccessful guesses per IP+college per 10 minutes — the guard
//    against stepping through roll numbers;
//  - failures: unsuccessful guesses per IP across all colleges.
const overall = createRateLimiter({
  windowMs: Number(process.env.PUBLIC_LOOKUP_WINDOW_MS) || 60 * 1000,
  max: Number(process.env.PUBLIC_LOOKUP_MAX) || 60,
  message: "Too many lookups. Please wait a moment and try again.",
});
const failuresPerCollege = createFailureLimiter({
  windowMs: Number(process.env.PUBLIC_LOOKUP_FAIL_WINDOW_MS) || 10 * 60 * 1000,
  max: Number(process.env.PUBLIC_LOOKUP_FAIL_MAX) || 15,
  keyGenerator: (req) => `${req.ip}|${typeof req.body?.collegeId === "string" ? req.body.collegeId.slice(0, 20) : ""}`,
});
const failuresPerIp = createFailureLimiter({
  windowMs: Number(process.env.PUBLIC_LOOKUP_FAIL_WINDOW_MS) || 10 * 60 * 1000,
  max: Number(process.env.PUBLIC_LOOKUP_FAIL_IP_MAX) || 40,
});

// POST /api/public/attendance/lookup — { collegeId, department, batch, shift, roll }
router.post("/lookup", overall, failuresPerIp, failuresPerCollege, lookupAttendance);

export default router;
