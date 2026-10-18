import Shift from "../models/Shift.js";
import Student from "../models/Student.js";
import Subject from "../models/Subject.js";
import { sendSuccess, sendError } from "../utils/response.js";
import { scopedModel } from "../utils/tenantScope.js";
import { findShiftByName } from "../utils/shiftUtils.js";
import { exactNameMatch, cleanName, sameName, isPlainString } from "../utils/academicNames.js";

// Shifts belong to a college. The college always comes from req.tenant (the
// authenticated session) — see controllers/departmentController.js.

const parseOrder = (order) => {
  const n = Number(order);
  return Number.isFinite(n) ? n : 0;
};

// ─── GET /api/shifts ───────────────────────────────────────────────────────────
// Authenticated: used by every form that needs a shift dropdown. Only the
// caller's college's shifts are returned.
export const getShifts = async (req, res, next) => {
  try {
    const shifts = await scopedModel(Shift, req.tenant).find({}).sort({ order: 1, name: 1 }).lean();
    return sendSuccess(res, {
      shifts: shifts.map((s) => s.name),
      full: shifts,
    });
  } catch (err) {
    next(err);
  }
};

// ─── POST /api/shifts ──────────────────────────────────────────────────────────
// Admin only: create a new shift.
export const createShift = async (req, res, next) => {
  try {
    const { name, order } = req.body || {};
    if (!isPlainString(name) || !cleanName(name)) {
      return sendError(res, "Shift name is required.", 400);
    }
    const trimmed = cleanName(name);

    const existing = await findShiftByName(req.tenant, trimmed);
    if (existing) {
      return sendError(res, `Shift "${trimmed}" already exists.`, 409);
    }

    const shift = await scopedModel(Shift, req.tenant).create({
      name: trimmed,
      order: order !== undefined ? parseOrder(order) : 0,
      createdBy: req.user?.id,
    });

    return sendSuccess(res, { shift: shift.toPublicJSON() }, "Shift created successfully.", 201);
  } catch (err) {
    if (err.code === 11000) return sendError(res, "A shift with this name already exists.", 409);
    next(err);
  }
};

// ─── PUT /api/shifts/:id ───────────────────────────────────────────────────────
// Admin only: edit a shift (including default ones).
// Renaming a shift propagates to the college's Student/Subject records that
// reference the old name so nothing is orphaned; other colleges are untouched.
export const updateShift = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { name, order } = req.body || {};

    const shifts = scopedModel(Shift, req.tenant);
    const shift = await shifts.findById(id);
    if (!shift) return sendError(res, "Shift not found.", 404);

    const oldName = shift.name;

    if (name !== undefined) {
      if (!isPlainString(name)) return sendError(res, "Shift name must be 2–50 characters.", 400);
      const trimmed = cleanName(name);
      if (trimmed.length < 2 || trimmed.length > 50) {
        return sendError(res, "Shift name must be 2–50 characters.", 400);
      }
      if (!sameName(trimmed, oldName)) {
        const dup = await findShiftByName(req.tenant, trimmed);
        if (dup && dup._id.toString() !== id) {
          return sendError(res, `Shift "${trimmed}" already exists.`, 409);
        }
      }
      shift.name = trimmed;
    }
    if (order !== undefined) shift.order = Number(order) || 0;

    await shift.save();

    // ── Propagate rename to this college's records so nothing becomes orphaned ──
    if (name !== undefined && !sameName(shift.name, oldName)) {
      const byOldName = { shift: exactNameMatch(oldName) };
      await Promise.all([
        scopedModel(Student, req.tenant).updateMany(byOldName, { $set: { shift: shift.name } }),
        scopedModel(Subject, req.tenant).updateMany(byOldName, { $set: { shift: shift.name } }),
      ]);
    }

    return sendSuccess(res, { shift: shift.toPublicJSON() }, "Shift updated successfully.");
  } catch (err) {
    if (err.code === 11000) return sendError(res, "A shift with this name already exists.", 409);
    next(err);
  }
};

// ─── DELETE /api/shifts/:id ────────────────────────────────────────────────────
// Admin only. Blocked if the shift is currently in use by any student or
// teacher-assigned subject of THIS college.
export const deleteShift = async (req, res, next) => {
  try {
    const { id } = req.params;
    const shifts = scopedModel(Shift, req.tenant);
    const shift = await shifts.findById(id);
    if (!shift) return sendError(res, "Shift not found.", 404);

    const nameFilter = exactNameMatch(shift.name);
    const [studentCount, subjectCount] = await Promise.all([
      scopedModel(Student, req.tenant).countDocuments({ shift: nameFilter, isActive: true }),
      scopedModel(Subject, req.tenant).countDocuments({ shift: nameFilter }),
    ]);

    if (studentCount > 0 || subjectCount > 0) {
      return sendError(
        res,
        `Cannot delete "${shift.name}" — it is used by ${studentCount} student(s) and ${subjectCount} subject(s). Reassign them first.`,
        409
      );
    }

    await shifts.deleteOne({ _id: shift._id });
    return sendSuccess(res, { message: `Shift "${shift.name}" deleted.` });
  } catch (err) {
    next(err);
  }
};
