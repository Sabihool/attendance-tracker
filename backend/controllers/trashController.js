/**
 * Trash & Restore Controller — Part 19
 * ─────────────────────────────────────
 * Handles soft-delete, trash listing, restore, and permanent deletion
 * of attendance records.
 *
 * Rules:
 *  - Soft delete sets isDeleted=true + deletedAt timestamp
 *  - Restored within 10 days → record goes back to active
 *  - After 10 days in trash → eligible for permanent deletion (cron job)
 *  - Admin can view trash for any subject; teacher only sees their own
 */

import mongoose from "mongoose";
import Attendance from "../models/Attendance.js";
import Subject from "../models/Subject.js";
import { sendSuccess, sendError } from "../utils/response.js";
import { scopedModel } from "../utils/tenantScope.js";
import { TRASH_TTL_DAYS, trashCutoff, trashExpiryDate, isOwnedBy } from "../utils/trashRules.js";

// ─── College scoping (Part 12) ────────────────────────────────────────────────
// Attendance carries its own collegeId. Every attendance read/restore/delete goes
// through scopedModel(Attendance, req.tenant) (college from the database
// session), and the subject in the URL is also looked up inside the caller's
// college, so another college's subject or session id is "not found" — the
// same answer as a missing id — and nothing of it can be restored or destroyed.
const subjectInCollege = (req, subjectId) =>
  scopedModel(Subject, req.tenant).findById(subjectId, { lean: true });
const attendanceOf = (req) => scopedModel(Attendance, req.tenant);

// ─── Part 16: deletion integrity ──────────────────────────────────────────────
// Ownership is checked twice: the subject must be in the caller's college (404
// otherwise — same answer as a missing id), and every destructive write
// re-states its precondition in the write itself (the record must STILL be in
// the trash, in this college, under this subject), so a restore/delete that
// raced with another request can never destroy an active record or resurrect a
// purged one. Inconsistent rows (no deletedAt, deleted teacher, deleted
// subject) get a clear answer instead of a crash.
export { TRASH_TTL_DAYS };

// ─── Helper: enrich a record with trash metadata ──────────────────────────────
const withTrashMeta = (record) => {
  const doc = record.toObject ? record.toObject() : { ...record };
  if (doc.isDeleted && doc.deletedAt) {
    const expiry = trashExpiryDate(doc.deletedAt);
    const msLeft = expiry - new Date();
    doc.expiresAt = expiry;
    doc.daysUntilPermanentDelete = Math.max(0, Math.ceil(msLeft / (1000 * 60 * 60 * 24)));
    doc.isExpired = msLeft <= 0;
  } else if (doc.isDeleted) {
    // Inconsistent row: flagged as deleted but never stamped. It is shown (so an
    // admin can see it), cannot be "expired" yet, and the nightly cleanup stamps
    // it so its normal 10-day retention starts.
    doc.expiresAt = null;
    doc.daysUntilPermanentDelete = null;
    doc.isExpired = false;
    doc.unstamped = true;
  }
  return doc;
};

// ─────────────────────────────────────────────────────────────────────────────
// SOFT DELETE  —  DELETE /api/attendance/:subjectId/session/:id
// Replaces the previous hard delete. Moves record to trash.
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Soft-delete an attendance session (move to trash).
 *
 * Requires: protect + requireApproved + authorize("teacher","admin")
 *           + requireSubjectOwner + requireAttendanceOwner
 */
export const softDeleteAttendance = async (req, res, next) => {
  try {
    const attendance = req.attendance; // attached by requireAttendanceOwner

    if (attendance.isDeleted) {
      return sendError(res, "This record is already in the trash.", 400);
    }

    attendance.isDeleted = true;
    attendance.deletedAt = new Date();
    attendance.deletedBy = req.user.id;
    await attendance.save();

    const expiry = trashExpiryDate(attendance.deletedAt);

    return sendSuccess(
      res,
      {
        attendance: attendance.toPublicJSON(),
        trash: {
          deletedAt: attendance.deletedAt,
          expiresAt: expiry,
          daysUntilPermanentDelete: TRASH_TTL_DAYS,
          message: `Record moved to trash. It will be permanently deleted on ${expiry.toDateString()} unless restored.`,
        },
      },
      "Attendance moved to trash successfully."
    );
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// LIST TRASH  —  GET /api/trash/:subjectId
// Returns all soft-deleted records for a subject (with expiry info).
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Get all trashed attendance records for a subject.
 *
 * Query params:
 *   ?includeExpired=true  — include records past the 10-day window (default: true)
 *
 * Requires: protect + requireApproved + authorize("teacher","admin")
 */
export const getTrash = async (req, res, next) => {
  try {
    const { subjectId } = req.params;
    const { includeExpired = "true" } = req.query;

    if (!subjectId.match(/^[0-9a-fA-F]{24}$/)) {
      return sendError(res, "Invalid subject ID.", 400);
    }

    // Verify subject exists
    const subject = await subjectInCollege(req, subjectId);
    if (!subject) return sendError(res, "Subject not found.", 404);

    // Teachers can only see their own subject's trash
    if (req.user.role === "teacher" && !isOwnedBy(subject.teacher, req.user.id)) {
      return sendError(res, "You are not authorized to view this subject's trash.", 403);
    }

    const filter = { subjectId, isDeleted: true };

    // Optionally filter out expired records
    if (includeExpired === "false") {
      // Unstamped rows have no expiry yet, so they are not "expired" either.
      filter.$or = [{ deletedAt: { $gt: trashCutoff() } }, { deletedAt: null }];
    }

    const records = await attendanceOf(req).find(filter)
      .sort({ deletedAt: -1 })
      .lean();

    const enriched = records.map(withTrashMeta);

    const expiredCount = enriched.filter((r) => r.isExpired).length;
    const restorableCount = enriched.filter((r) => !r.isExpired).length;

    return sendSuccess(
      res,
      {
        records: enriched,
        meta: {
          totalInTrash: enriched.length,
          restorableCount,
          expiredCount,
          trashTTLDays: TRASH_TTL_DAYS,
        },
      },
      `Trash fetched successfully. ${restorableCount} record(s) can be restored.`
    );
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// RESTORE  —  POST /api/trash/:subjectId/restore/:id
// Restores a soft-deleted record if within 10-day window.
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Restore a trashed attendance record.
 *
 * Fails if:
 *  - Record is not in trash
 *  - 10-day restore window has expired
 *  - An active record with the same subject+date+classType already exists
 *
 * Requires: protect + requireApproved + authorize("teacher","admin")
 */
export const restoreAttendance = async (req, res, next) => {
  try {
    const { subjectId, id } = req.params;

    if (!id.match(/^[0-9a-fA-F]{24}$/)) {
      return sendError(res, "Invalid attendance ID.", 400);
    }

    if (!(await subjectInCollege(req, subjectId))) {
      return sendError(res, "Attendance record not found.", 404);
    }

    const attendance = await attendanceOf(req).findOne({ _id: id, subjectId });

    if (!attendance) {
      return sendError(res, "Attendance record not found.", 404);
    }

    // Teachers can only restore their own records (a record whose teacher no
    // longer exists belongs to nobody a teacher could be: admins only).
    if (req.user.role === "teacher" && !isOwnedBy(attendance.teacher, req.user.id)) {
      return sendError(res, "You are not authorized to restore this record.", 403);
    }

    if (!attendance.isDeleted) {
      return sendError(res, "This record is not in the trash.", 400);
    }

    // ── Check if still within restore window ─────────────────────────────────
    // A row with no deletedAt has no expiry yet (the nightly cleanup stamps it),
    // so it is still restorable instead of crashing the request.
    const expiry = trashExpiryDate(attendance.deletedAt);
    if (expiry && new Date() > expiry) {
      return sendError(
        res,
        `Restore window expired. This record was deleted on ${attendance.deletedAt.toDateString()} and the 10-day restore period ended on ${expiry.toDateString()}.`,
        410 // Gone
      );
    }

    // ── Check for conflict: active record with same subject+date+classType ────
    const conflict = await attendanceOf(req).findOne({
      subjectId,
      date: attendance.date,
      classType: attendance.classType,
      isDeleted: false,
      _id: { $ne: id },
    });

    if (conflict) {
      return sendError(
        res,
        `Cannot restore: an active attendance record for this subject on ${attendance.date.toDateString()} (${attendance.classType}) already exists (ID: ${conflict._id}).`,
        409
      );
    }

    // ── Restore (atomic) ──────────────────────────────────────────────────────
    // The write itself requires: this college (scopedModel), this subject, still
    // in the trash, and still inside the retention window. If another request
    // purged or restored the record in the meantime nothing is written.
    let restored;
    try {
      restored = await attendanceOf(req).findOneAndUpdate(
        {
          _id: id,
          subjectId,
          isDeleted: true,
          $or: [{ deletedAt: { $gt: trashCutoff() } }, { deletedAt: null }],
        },
        {
          $set: { isDeleted: false, deletedAt: null, deletedBy: null },
          $push: { restoreHistory: { restoredAt: new Date(), restoredBy: req.user.id } },
        },
        { new: true }
      );
    } catch (err) {
      // A concurrent request recorded the same session while we were checking.
      if (err?.code === 11000) {
        return sendError(res, "Cannot restore: an active attendance record for this subject, date and category already exists.", 409);
      }
      throw err;
    }

    if (!restored) {
      return sendError(res, "This record changed while it was being restored (already restored, purged or expired). Nothing was changed.", 409);
    }

    return sendSuccess(
      res,
      { attendance: restored.toPublicJSON() },
      "Attendance record restored successfully."
    );
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// PERMANENT DELETE  —  DELETE /api/trash/:subjectId/permanent/:id
// Permanently destroys a trashed record. Admin only, or teacher within their subject.
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Permanently delete a trashed attendance record.
 *
 * The record must already be in the trash (isDeleted=true).
 * Admins can permanently delete any trashed record.
 * Teachers can only permanently delete their own trashed records.
 *
 * Requires: protect + requireApproved + authorize("teacher","admin")
 */
export const permanentDeleteAttendance = async (req, res, next) => {
  try {
    const { subjectId, id } = req.params;

    if (!id.match(/^[0-9a-fA-F]{24}$/)) {
      return sendError(res, "Invalid attendance ID.", 400);
    }

    if (!(await subjectInCollege(req, subjectId))) {
      return sendError(res, "Attendance record not found.", 404);
    }

    const attendance = await attendanceOf(req).findOne({ _id: id, subjectId });

    if (!attendance) {
      return sendError(res, "Attendance record not found.", 404);
    }

    // Teachers can only permanently delete their own records
    if (req.user.role === "teacher" && !isOwnedBy(attendance.teacher, req.user.id)) {
      return sendError(res, "You are not authorized to permanently delete this record.", 403);
    }

    if (!attendance.isDeleted) {
      return sendError(
        res,
        "Record must be in the trash before it can be permanently deleted. Use the soft-delete route first.",
        400
      );
    }

    const snapshot = attendance.toPublicJSON(); // capture before deletion

    // The delete re-states every precondition: this college (scopedModel), this
    // subject, and STILL in the trash. A record restored a moment ago is active
    // data again and must never be destroyed by a stale permanent-delete.
    const result = await attendanceOf(req).deleteOne({ _id: id, subjectId, isDeleted: true });
    if (!result?.deletedCount) {
      return sendError(res, "This record changed while it was being deleted (already purged or restored). Nothing was deleted.", 409);
    }

    return sendSuccess(
      res,
      {
        deletedId: id,
        snapshot,
      },
      "Attendance record permanently deleted. This action cannot be undone."
    );
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// EMPTY TRASH  —  DELETE /api/trash/:subjectId/empty
// Permanently deletes ALL trashed records for a subject.
// Admin or subject owner only.
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Empty the trash for a specific subject.
 *
 * Requires: protect + requireApproved + authorize("teacher","admin")
 */
export const emptyTrash = async (req, res, next) => {
  try {
    const { subjectId } = req.params;
    const { onlyExpired = "false" } = req.query;

    if (!subjectId.match(/^[0-9a-fA-F]{24}$/)) {
      return sendError(res, "Invalid subject ID.", 400);
    }

    // Verify subject exists and user is authorized
    const subject = await subjectInCollege(req, subjectId);
    if (!subject) return sendError(res, "Subject not found.", 404);

    if (req.user.role === "teacher" && !isOwnedBy(subject.teacher, req.user.id)) {
      return sendError(res, "You are not authorized to empty this subject's trash.", 403);
    }

    const filter = { subjectId, isDeleted: true };

    // Option: only delete records past the TTL window
    if (onlyExpired === "true") {
      filter.deletedAt = { $lte: trashCutoff() };
    }

    // `subjectId` + `isDeleted: true` are in the filter itself (never a list of
    // ids fetched earlier), so only trashed rows of THIS subject in THIS college
    // can be removed, even if rows changed since the subject was checked.
    const result = await attendanceOf(req).deleteMany(filter);

    return sendSuccess(
      res,
      { deletedCount: result.deletedCount },
      `Trash emptied. ${result.deletedCount} record(s) permanently deleted.`
    );
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN: GLOBAL TRASH VIEW  —  GET /api/admin/trash
// Returns trashed records across ALL subjects (admin only).
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Admin-only: view all trashed records across the system.
 *
 * Query params:
 *   ?page=1&limit=20
 *   ?onlyExpired=true   — only show records past 10-day TTL
 *   ?teacherId=xxx      — filter by teacher
 *   ?subjectId=xxx      — filter by subject
 *
 * Requires: protect + requireApproved + authorize("admin")
 */
export const adminGetAllTrash = async (req, res, next) => {
  try {
    const {
      page = 1,
      limit = 20,
      onlyExpired,
      teacherId,
      subjectId,
    } = req.query;

    // Only trash of THIS college (scopedModel adds collegeId); a teacherId or
    // subjectId from another college simply matches nothing.
    const filter = { isDeleted: true };

    if (typeof teacherId === "string" && teacherId.match(/^[0-9a-fA-F]{24}$/)) {
      filter.teacher = new mongoose.Types.ObjectId(teacherId);
    }
    if (typeof subjectId === "string" && subjectId.match(/^[0-9a-fA-F]{24}$/)) {
      filter.subjectId = new mongoose.Types.ObjectId(subjectId);
    }
    if (onlyExpired === "true") {
      filter.deletedAt = { $lte: trashCutoff() };
    }

    // Paging values come from the query string: clamp them (NaN, negative or
    // huge values would otherwise reach the database).
    const pageNum = Math.max(1, Math.floor(Number(page)) || 1);
    const limitNum = Math.min(100, Math.max(1, Math.floor(Number(limit)) || 20));
    const skip = (pageNum - 1) * limitNum;
    const total = await attendanceOf(req).countDocuments(filter);
    // populate() reads another collection, so it is pinned to this college too:
    // a trashed row pointing at a foreign (or deleted) subject/teacher shows
    // null instead of leaking another college's names.
    const collegeMatch = { collegeId: req.tenant.collegeId };
    const records = await attendanceOf(req).find(filter)
      .sort({ deletedAt: -1 })
      .skip(skip)
      .limit(limitNum)
      .populate({ path: "teacher", select: "name email", match: collegeMatch })
      .populate({ path: "subjectId", select: "subjectName subjectCode department", match: collegeMatch })
      .lean();

    const enriched = records.map((r) => {
      const doc = withTrashMeta(r);
      if (!doc.subjectId) doc.orphaned = true; // its subject no longer exists in this college
      return doc;
    });

    const expiredCount = await attendanceOf(req).countDocuments({
      isDeleted: true,
      deletedAt: { $lte: trashCutoff() },
    });

    return sendSuccess(
      res,
      {
        records: enriched,
        pagination: {
          total,
          page: pageNum,
          limit: limitNum,
          totalPages: Math.ceil(total / limitNum),
        },
        meta: {
          totalInTrash: total,
          expiredCount,
          restorableCount: total - expiredCount,
          trashTTLDays: TRASH_TTL_DAYS,
        },
      },
      "Global trash fetched successfully."
    );
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN: TRASH STATS  —  GET /api/admin/trash/stats
// System-wide trash health metrics (admin only).
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Admin-only: get trash system statistics.
 *
 * Requires: protect + requireApproved + authorize("admin")
 */
export const adminTrashStats = async (req, res, next) => {
  try {
    const now = new Date();
    const cutoff = trashCutoff(now);

    // Everything below is limited to this college (collegeId is added by
    // scopedModel / scopedAggregate).
    const [totalActive, totalTrashed, expiredCount, byTeacher] = await Promise.all([
      // Total active (non-deleted) attendance records
      attendanceOf(req).countDocuments({ isDeleted: false }),

      // Total in trash
      attendanceOf(req).countDocuments({ isDeleted: true }),

      // Expired trash (past 10-day window, pending cleanup)
      attendanceOf(req).countDocuments({ isDeleted: true, deletedAt: { $lte: cutoff } }),

      // Breakdown by teacher (the tenant $match is forced to the front)
      attendanceOf(req).aggregate([
        { $match: { isDeleted: true } },
        {
          $group: {
            _id: "$teacher",
            count: { $sum: 1 },
            oldest: { $min: "$deletedAt" },
          },
        },
        {
          // Teacher names come only from users of the same college.
          $lookup: {
            from: "users",
            let: { teacherId: "$_id" },
            pipeline: [
              { $match: { $expr: { $eq: ["$_id", "$$teacherId"] }, collegeId: req.tenant.collegeId } },
              { $project: { name: 1 } },
            ],
            as: "teacherInfo",
          },
        },
        {
          $project: {
            teacherId: "$_id",
            teacherName: { $arrayElemAt: ["$teacherInfo.name", 0] },
            count: 1,
            oldest: 1,
          },
        },
        { $sort: { count: -1 } },
        { $limit: 10 },
      ]),
    ]);

    return sendSuccess(
      res,
      {
        system: {
          totalActiveRecords: totalActive,
          totalTrashedRecords: totalTrashed,
          expiredPendingCleanup: expiredCount,
          restorableRecords: totalTrashed - expiredCount,
        },
        trashPolicy: {
          ttlDays: TRASH_TTL_DAYS,
          cutoffDate: cutoff,
          info: `Records deleted before ${cutoff.toDateString()} are eligible for permanent deletion.`,
        },
        topTrashersByTeacher: byTeacher,
        generatedAt: now,
      },
      "Trash statistics fetched."
    );
  } catch (error) {
    next(error);
  }
};
