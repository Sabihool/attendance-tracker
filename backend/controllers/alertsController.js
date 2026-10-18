/**
 * alertsController.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Handles consecutive absence alert CRUD and student analytics.
 *
 * Routes:
 *   GET    /api/alerts                  — teacher's active alerts
 *   POST   /api/alerts/create           — create alert (auto-called from attendance save)
 *   PATCH  /api/alerts/:id/remove       — teacher removes an alert
 *   PATCH  /api/alerts/:id/note         — teacher updates note on an alert
 *   GET    /api/alerts/student/:id/analytics — admin: full analytics for one student
 */

import Attendance from "../models/Attendance.js";
import ConsecutiveAbsenceAlert from "../models/ConsecutiveAbsenceAlert.js";
import Subject from "../models/Subject.js";
import Student from "../models/Student.js";
import { sendSuccess, sendError } from "../utils/response.js";
import { getConsecutiveAbsenceLimit } from "../utils/settingsUtils.js";
import { scopedModel } from "../utils/tenantScope.js";
import { logSecurityEvent } from "../utils/securityLog.js";
import { findOwnedStudent } from "../utils/analyticsScope.js";
import { computeStudentAnalytics } from "../utils/studentAnalytics.js";
import { isOwnedBy } from "../utils/trashRules.js";

// COLLEGE SCOPING (Parts 9 + 12): subjects, students, attendance sessions and
// alerts are all looked up through scopedModel(…, tenant). Student ids are only
// unique within a college, so a student is always resolved inside the caller's
// college; the streak (consecutive-absence) count only reads that college's
// sessions; alerts are created with — and only ever read, edited or removed
// within — the caller's collegeId. The streak rule and threshold logic are
// unchanged (the threshold itself is now each college's own Settings value).
const alertsOf = (tenant) => scopedModel(ConsecutiveAbsenceAlert, tenant);

// ─── Helper: derive consecutive absence count for a student in a subject ──────
/**
 * Counts the trailing run of absences in a subject's sessions (oldest first):
 * sessions the student is not in are skipped, any "present" resets the run.
 * Pure — it works on sessions that were already loaded.
 */
export const countTrailingAbsences = (sessionsOldestFirst, studentId) => {
  let consecutive = 0;
  for (const record of sessionsOldestFirst) {
    const entry = record.students.find((s) => s.studentId === studentId);
    if (!entry) continue;

    if (entry.status === "absent") {
      consecutive++;
    } else {
      consecutive = 0; // reset on any present
    }
  }
  return consecutive;
};

/**
 * Reads all non-deleted attendance records for a subject (sorted oldest first),
 * inside the tenant's college only.
 */
const loadSubjectSessions = (tenant, subjectId) =>
  scopedModel(Attendance, tenant).find({ subjectId, isDeleted: false })
    .sort({ date: 1 })
    .lean();

/**
 * Current consecutive absence count for ONE student in a subject.
 *
 * @param {{collegeId: string|null}} tenant  college the subject belongs to
 * @param {string} subjectId
 * @param {string} studentId
 * @returns {number} current consecutive absence count
 */
const getConsecutiveAbsences = async (tenant, subjectId, studentId) =>
  countTrailingAbsences(await loadSubjectSessions(tenant, subjectId), studentId);

// ─── Helper: check and create alert if threshold reached ──────────────────────
/**
 * Called after every attendance save (and after an edit to an existing
 * session). If a student has reached the admin-configured consecutive
 * absence limit (Settings.consecutiveAbsenceLimit — default 3, no longer
 * hardcoded) and no active alert exists yet, creates one automatically.
 *
 * The alert's college is the SUBJECT's college (the subject was loaded inside
 * the caller's college by requireSubjectOwner). If the caller's own tenant is
 * passed and disagrees with the subject's college, nothing is written.
 *
 * @param {Object} subjectDoc  — Mongoose Subject document
 * @param {Array}  students    — array of { studentId, name, roll, status }
 * @param {string} teacherId
 * @param {{collegeId: string|null}} [callerTenant] — req.tenant, cross-checked
 */
export const checkAndCreateAlerts = async (subjectDoc, students, teacherId, callerTenant) => {
  const tenant = { collegeId: subjectDoc.collegeId ?? null };
  if (callerTenant && (callerTenant.collegeId ?? null) !== tenant.collegeId) {
    logSecurityEvent("resource_not_in_tenant", { resource: "alert_check", user: callerTenant.userId });
    return;
  }
  try {
    const alerts = alertsOf(tenant);
    // The subject's sessions are read ONCE for the whole roster (they used to be
    // re-read for every student). The sessions cannot change inside this loop, so
    // each student's count is the same as before.
    const [limit, sessions] = await Promise.all([
      getConsecutiveAbsenceLimit(tenant),
      loadSubjectSessions(tenant, subjectDoc._id.toString()),
    ]);

    for (const student of students) {
      const consecutive = countTrailingAbsences(sessions, student.studentId);

      if (consecutive >= limit) {
        // Only create if no active alert exists for this student+subject combo
        const existing = await alerts.findOne({
          studentId: student.studentId,
          subjectId: subjectDoc._id,
          removed: false,
        });

        if (!existing) {
          await alerts.create({
            studentId: student.studentId,
            studentName: student.name,
            studentRoll: student.roll,
            department: subjectDoc.department,
            batch: subjectDoc.batch,
            subjectId: subjectDoc._id,
            subjectName: subjectDoc.subjectName,
            teacherId,
            consecutiveMissCount: consecutive,
            note: `Student absent for ${consecutive} consecutive classes. Needs follow-up.`,
          });
        } else if (existing.consecutiveMissCount !== consecutive) {
          // Keep the count in sync — attendance edits can raise OR lower it
          existing.consecutiveMissCount = consecutive;
          await existing.save();
        }
      } else {
        // Consecutive count dropped back below the threshold (e.g. an
        // absence was corrected to present via Edit Attendance). Auto-remove
        // an alert that's no longer earned, but keep it if a teacher already
        // manually removed it (removed stays as-is either way).
        const existing = await alerts.findOne({
          studentId: student.studentId,
          subjectId: subjectDoc._id,
          removed: false,
        });
        if (existing && existing.consecutiveMissCount !== consecutive) {
          existing.consecutiveMissCount = consecutive;
          await existing.save();
        }
      }
    }
  } catch (err) {
    // Non-fatal — don't block the attendance save
    console.error("⚠️  Alert check failed:", err.message);
  }
};

// ─── GET /api/alerts ──────────────────────────────────────────────────────────
/**
 * Get all active (non-removed) alerts for the authenticated teacher.
 * Supports optional ?removed=true to see removed alerts too.
 * Supports ?department, ?batch filters.
 */
export const getAlerts = async (req, res, next) => {
  try {
    const { removed, department, batch } = req.query;
    const teacherId = req.user.id;

    const filter = { teacherId };

    if (removed === "true") {
      filter.removed = true;
    } else {
      filter.removed = false;
    }

    // Filters must be plain strings (an object here would be a Mongo operator).
    if (typeof department === "string" && department) filter.department = department;
    if (typeof batch === "string" && batch) filter.batch = batch;

    const alerts = await alertsOf(req.tenant).find(filter)
      .sort({ createdAt: -1 })
      .lean();

    return sendSuccess(
      res,
      { alerts, total: alerts.length },
      "Alerts fetched successfully."
    );
  } catch (error) {
    next(error);
  }
};

// ─── POST /api/alerts/create ──────────────────────────────────────────────────
/**
 * Manually create an alert for a student.
 * Body: { studentId, subjectId, note? }
 */
export const createAlert = async (req, res, next) => {
  try {
    const { studentId, subjectId, note } = req.body;

    if (!studentId || !subjectId) {
      return sendError(res, "studentId and subjectId are required.", 400);
    }

    if (typeof studentId !== "string") return sendError(res, "studentId must be a string.", 400);
    if (typeof subjectId !== "string") return sendError(res, "subjectId must be a string.", 400);

    const subject = await scopedModel(Subject, req.tenant).findById(subjectId);
    if (!subject) return sendError(res, "Subject not found.", 404);
    // A teacher may raise alerts only on subjects assigned to them (admins: any subject of their college).
    // Without this a teacher could attach alerts to a colleague's subject by id.
    if (req.tenant.role !== "admin" && !isOwnedBy(subject.teacher, req.tenant.userId)) {
      logSecurityEvent("alert_on_foreign_subject", { user: req.tenant.userId, college: req.tenant.collegeId ?? null });
      return sendError(res, "You are not authorized to create alerts for this subject.", 403);
    }

    const student = await scopedModel(Student, req.tenant).findOne({ studentId, isActive: true });
    if (!student) return sendError(res, "Student not found.", 404);

    const existing = await alertsOf(req.tenant).findOne({
      studentId,
      subjectId,
      removed: false,
    });

    if (existing) {
      return sendError(
        res,
        "An active alert already exists for this student in this subject.",
        409
      );
    }

    const limit = await getConsecutiveAbsenceLimit(req.tenant);
    const consecutive = await getConsecutiveAbsences(req.tenant, subjectId, studentId);

    // collegeId is stamped from req.tenant; subject and student were both
    // resolved inside that college above.
    const alert = await alertsOf(req.tenant).create({
      studentId,
      studentName: student.name,
      studentRoll: student.roll,
      department: student.department,
      batch: student.batch,
      subjectId,
      subjectName: subject.subjectName,
      teacherId: req.user.id,
      consecutiveMissCount: Math.max(consecutive, limit),
      note: note?.trim() || `Student absent for consecutive classes. Needs follow-up.`,
    });

    return sendSuccess(res, { alert }, "Alert created successfully.", 201);
  } catch (error) {
    if (error.code === 11000) {
      return sendError(
        res,
        "An active alert already exists for this student in this subject.",
        409
      );
    }
    next(error);
  }
};

// ─── PATCH /api/alerts/:id/remove ────────────────────────────────────────────
/**
 * Teacher manually removes (soft-deletes) an alert.
 * The alert record is retained for history.
 */
export const removeAlert = async (req, res, next) => {
  try {
    const { id } = req.params;
    const teacherId = req.user.id;

    // Another college's alert id is "not found", like a missing one.
    const alert = await alertsOf(req.tenant).findOne({
      _id: id,
      teacherId,
    });

    if (!alert) {
      return sendError(res, "Alert not found.", 404);
    }

    if (alert.removed) {
      return sendError(res, "Alert has already been removed.", 400);
    }

    alert.removed = true;
    alert.removedAt = new Date();
    alert.removedBy = teacherId;
    await alert.save();

    return sendSuccess(res, { alert }, "Alert removed successfully.");
  } catch (error) {
    next(error);
  }
};

// ─── PATCH /api/alerts/:id/note ───────────────────────────────────────────────
/**
 * Teacher updates the note on an alert.
 * Body: { note }
 */
export const updateAlertNote = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { note } = req.body;
    const teacherId = req.user.id;

    if (note === undefined) {
      return sendError(res, "Note field is required.", 400);
    }

    if (typeof note !== "string") return sendError(res, "Note must be text.", 400);

    const alert = await alertsOf(req.tenant).findOne({
      _id: id,
      teacherId,
    });

    if (!alert) {
      return sendError(res, "Alert not found.", 404);
    }

    alert.note = note.trim();
    await alert.save();

    return sendSuccess(res, { alert }, "Note updated successfully.");
  } catch (error) {
    next(error);
  }
};

// ─── GET /api/alerts/student/:studentId/analytics ────────────────────────────
/**
 * Admin-only: Full analytics for a single student across all subjects of the
 * admin's own college. (Route-level `authorize("admin")`: a teacher would see
 * every colleague's sessions and alert history for that student.)
 * Returns:
 *   - student profile info
 *   - per-subject attendance breakdown (with credit-weighted stats)
 *   - aggregate totals
 *   - creditScore, computed via the shared calculateCreditScore() utility
 *     (backend/utils/creditUtils.js) so it always matches the admin
 *     dashboard and any other statistics page:
 *       creditScore = Σ (attended classes of a normalized category ×
 *                        that category's configured credit value)
 *     Category names are normalized (trim + lowercase) before grouping, so
 *     "Lab" / "lab" / "LAB" collapse into one group instead of three.
 *   - all consecutive absence alerts (history, including removed)
 */
export const getStudentAnalytics = async (req, res, next) => {
  try {
    const { studentId } = req.params;

    // ── Find student profile ───────────────────────────────────────────────────
    // Ownership first: the student must be in the caller's college. Another
    // college's student, an unknown id and a malformed id are the same 404, and
    // no statistic is computed before this passes.
    const student = await findOwnedStudent(req.tenant, studentId);
    if (!student) {
      return sendError(res, "Student not found.", 404);
    }

    // Shared with the public lookup (utils/studentAnalytics.js): college-scoped
    // sessions, per-subject counts, credit score and status.
    const { academicStats, subjectStats } = await computeStudentAnalytics(req.tenant, student);

    // ── Alert history ──────────────────────────────────────────────────────────
    const alertHistory = await alertsOf(req.tenant).find({ studentId })
      .populate({ path: "teacherId", select: "name email", match: { collegeId: req.tenant.collegeId } })
      .populate({ path: "subjectId", select: "subjectName subjectCode", match: { collegeId: req.tenant.collegeId } })
      .sort({ createdAt: -1 })
      .lean();

    return sendSuccess(
      res,
      {
        student,
        academicStats,
        subjectStats,
        alertHistory,
      },
      "Student analytics fetched successfully."
    );
  } catch (error) {
    next(error);
  }
};
