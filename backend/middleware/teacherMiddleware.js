import Subject from "../models/Subject.js";
import Attendance from "../models/Attendance.js";
import { sendError } from "../utils/response.js";
import { sendAuthError } from "../utils/authErrors.js";
import { logSecurityEvent } from "../utils/securityLog.js";
import { scopeFilter } from "../utils/tenantScope.js";
import { isOwnedBy } from "../utils/trashRules.js";

/**
 * Middleware to verify the authenticated teacher owns the subject.
 * Reads :subjectId from req.params.
 * Attaches the subject to req.subject for downstream use.
 *
 * Must be used AFTER protect + requireApproved.
 */
export const createRequireSubjectOwner = ({ SubjectModel = Subject } = {}) => async (req, res, next) => {
  try {
    if (!req.auth) return sendAuthError(res, "UNAUTHENTICATED"); // requireApproved did not run
    const { subjectId } = req.params;

    if (!subjectId || !subjectId.match(/^[0-9a-fA-F]{24}$/)) {
      return sendError(res, "Invalid subject ID.", 400);
    }

    // The subject is looked up INSIDE the caller's college (college from the
    // database session). A subject of another college is "not found" for
    // teachers and admins alike — the same answer as a missing id, so ids of
    // other colleges cannot be probed or reached by editing the URL.
    const subject = await SubjectModel.findOne(scopeFilter({ collegeId: req.auth.collegeId ?? null }, { _id: subjectId }));

    if (!subject) {
      logSecurityEvent("resource_not_in_tenant", { resource: "subject", user: req.auth.userId, college: req.auth.collegeId ?? null });
      return sendError(res, "Subject not found.", 404);
    }

    // Admins may manage any subject of THEIR OWN college.
    if (req.auth.role === "admin") {
      req.subject = subject;
      return next();
    }

    // Teacher must own the subject
    if (!isOwnedBy(subject.teacher, req.auth.userId)) {
      return sendError(
        res,
        "You are not authorized to manage attendance for this subject.",
        403
      );
    }

    req.subject = subject;
    next();
  } catch (error) {
    next(error);
  }
};

export const requireSubjectOwner = createRequireSubjectOwner();

/**
 * Middleware to verify the authenticated teacher owns the attendance record.
 * Reads :id from req.params (attendance record ID).
 * Attaches the attendance record to req.attendance.
 *
 * COLLEGE SCOPING (Part 12): attendance carries its own collegeId, so the record
 * is looked up INSIDE the caller's college (college from the database session).
 * A session of another college is "not found" for teachers and admins alike —
 * the same answer as a missing id, so ids cannot be probed or reached by editing
 * the URL. (This replaces the Part 9–11 fallback that inferred an attendance
 * record's college from its teacher's user record.)
 *
 * Part 19: Finds ACTIVE records only (isDeleted: false).
 * Trash operations use their own ownership checks in trashController.
 *
 * Must be used AFTER protect + requireApproved.
 */
export const createRequireAttendanceOwner = ({ AttendanceModel = Attendance } = {}) => async (req, res, next) => {
  try {
    if (!req.auth) return sendAuthError(res, "UNAUTHENTICATED");
    const { id } = req.params;

    if (!id || !id.match(/^[0-9a-fA-F]{24}$/)) {
      return sendError(res, "Invalid attendance ID.", 400);
    }

    // Part 19: Only find active records here; trashed records go through trash routes
    const attendance = await AttendanceModel.findOne(
      scopeFilter({ collegeId: req.auth.collegeId ?? null }, { _id: id, isDeleted: false })
    );

    if (!attendance) {
      logSecurityEvent("resource_not_in_tenant", { resource: "attendance", user: req.auth.userId, college: req.auth.collegeId ?? null });
      return sendError(res, "Attendance record not found or has been deleted.", 404);
    }

    // The record must belong to the subject named in the URL (which
    // requireSubjectOwner already proved is in the caller's college and, for a
    // teacher, theirs). A session id of some other subject — or college — is
    // "not found", even when the ids were edited by hand.
    if (req.subject && attendance.subjectId && String(attendance.subjectId) !== String(req.subject._id)) {
      logSecurityEvent("resource_not_in_tenant", { resource: "attendance", user: req.auth.userId });
      return sendError(res, "Attendance record not found or has been deleted.", 404);
    }

    // Admins may manage records of THEIR OWN college (already guaranteed above)
    if (req.auth.role === "admin") {
      req.attendance = attendance;
      return next();
    }

    // Teacher must own the attendance record
    if (!isOwnedBy(attendance.teacher, req.auth.userId)) {
      return sendError(
        res,
        "You are not authorized to manage this attendance record.",
        403
      );
    }

    req.attendance = attendance;
    next();
  } catch (error) {
    next(error);
  }
};

export const requireAttendanceOwner = createRequireAttendanceOwner();
