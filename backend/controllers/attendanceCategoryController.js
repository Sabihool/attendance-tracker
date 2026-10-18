import AttendanceCategory from "../models/AttendanceCategory.js";
import Subject from "../models/Subject.js";
import Attendance from "../models/Attendance.js";
import { sendSuccess, sendError } from "../utils/response.js";
import { findCategoryByName } from "../utils/creditUtils.js";
import { scopedModel } from "../utils/tenantScope.js";
import { isObjectIdString } from "../utils/approval.js";

// ─── COLLEGE SCOPING (Part 12) ────────────────────────────────────────────────
// Categories and their credit values belong to a college. Every query below goes
// through scopedModel(…, req.tenant), where req.tenant comes from the caller's
// database session (never from the request). In particular the rename
// propagation and the "in use" check on delete only ever touch the caller's own
// college's subjects and attendance — before Part 12 they ran across ALL
// colleges. Default categories are seeded per college: services/categoryDefaults.js.
const categories = (req) => scopedModel(AttendanceCategory, req.tenant);
const subjects = (req) => scopedModel(Subject, req.tenant);
const attendance = (req) => scopedModel(Attendance, req.tenant);

// A name/credit must be plain values: `{"$ne":""}`-style objects are refused.
const asText = (v) => (typeof v === "string" ? v : null);

// ─── GET /api/attendance-categories ────────────────────────────────────────────
// Authenticated users of a college: its own categories. Used by attendance-taking,
// reports and the admin screen. (Was public and global before Part 12.)
export const getCategories = async (req, res, next) => {
  try {
    const rows = await categories(req).find({}).sort({ name: 1 }).lean();
    return sendSuccess(res, {
      categories: rows.map((c) => ({ name: c.name, credit: c.credit })),
      full: rows.map(({ collegeId: _c, ...c }) => c), // eslint-disable-line no-unused-vars
    });
  } catch (err) {
    next(err);
  }
};

// ─── POST /api/attendance-categories ──────────────────────────────────────────
// Admin only: create a new attendance category in the admin's college.
export const createCategory = async (req, res, next) => {
  try {
    const { name, credit } = req.body;
    const nameText = asText(name);
    if (!nameText || !nameText.trim()) {
      return sendError(res, "Category name is required.", 400);
    }
    const trimmed = nameText.trim();

    const existing = await findCategoryByName(req.tenant, trimmed);
    if (existing) {
      return sendError(res, `Category "${trimmed}" already exists.`, 409);
    }

    const creditNum = credit !== undefined ? Number(credit) : 1;
    if (Number.isNaN(creditNum) || creditNum < 0 || creditNum > 20) {
      return sendError(res, "Credit must be a number between 0 and 20.", 400);
    }

    const category = await categories(req).create({
      name: trimmed,
      credit: creditNum,
      createdBy: req.user?.id,
    });

    return sendSuccess(
      res,
      { category: category.toPublicJSON() },
      "Attendance category created successfully.",
      201
    );
  } catch (err) {
    if (err.code === 11000) return sendError(res, "A category with this name already exists.", 409);
    next(err);
  }
};

// ─── PUT /api/attendance-categories/:id ───────────────────────────────────────
// Admin only: edit a category of the admin's college (including the seeded
// defaults). Renaming propagates to THIS COLLEGE's Subject.creditType and
// Attendance.classType so nothing is left pointing at a stale name. Editing the
// credit value only affects future attendance sessions — past sessions keep
// their recorded value.
export const updateCategory = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { name, credit } = req.body;

    // Another college's id (or a malformed one) is "not found", like a missing id.
    const category = await categories(req).findById(id);
    if (!category) return sendError(res, "Category not found.", 404);

    const oldName = category.name;

    if (name !== undefined) {
      const nameText = asText(name);
      if (nameText === null) return sendError(res, "Category name must be 2–50 characters.", 400);
      const trimmed = nameText.trim();
      if (trimmed.length < 2 || trimmed.length > 50) {
        return sendError(res, "Category name must be 2–50 characters.", 400);
      }
      if (trimmed.toLowerCase() !== oldName.toLowerCase()) {
        const dup = await findCategoryByName(req.tenant, trimmed);
        if (dup && dup._id.toString() !== id) {
          return sendError(res, `Category "${trimmed}" already exists.`, 409);
        }
      }
      category.name = trimmed;
    }

    if (credit !== undefined) {
      const creditNum = Number(credit);
      if (Number.isNaN(creditNum) || creditNum < 0 || creditNum > 20) {
        return sendError(res, "Credit must be a number between 0 and 20.", 400);
      }
      category.credit = creditNum;
    }

    await category.save();

    if (name !== undefined && category.name.toLowerCase() !== oldName.toLowerCase()) {
      const oldNameFilter = { $regex: `^${escapeRegex(oldName)}$`, $options: "i" };
      await Promise.all([
        subjects(req).updateMany({ creditType: oldNameFilter }, { $set: { creditType: category.name } }),
        attendance(req).updateMany({ classType: oldNameFilter }, { $set: { classType: category.name } }),
      ]);
    }

    return sendSuccess(res, { category: category.toPublicJSON() }, "Attendance category updated successfully.");
  } catch (err) {
    if (err.code === 11000) return sendError(res, "A category with this name already exists.", 409);
    next(err);
  }
};

// ─── DELETE /api/attendance-categories/:id ────────────────────────────────────
// Admin only. Blocked if the category is currently used by any subject or
// attendance session OF THIS COLLEGE, so historical data always resolves to a
// real category.
export const deleteCategory = async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!isObjectIdString(id)) return sendError(res, "Category not found.", 404);
    const category = await categories(req).findById(id);
    if (!category) return sendError(res, "Category not found.", 404);

    const nameFilter = { $regex: `^${escapeRegex(category.name)}$`, $options: "i" };
    const [subjectCount, attendanceCount] = await Promise.all([
      subjects(req).countDocuments({ creditType: nameFilter }),
      attendance(req).countDocuments({ classType: nameFilter }),
    ]);

    if (subjectCount > 0 || attendanceCount > 0) {
      return sendError(
        res,
        `Cannot delete "${category.name}" — it is used by ${subjectCount} subject(s) and ${attendanceCount} attendance session(s).`,
        409
      );
    }

    await categories(req).deleteOne({ _id: id });
    return sendSuccess(res, { message: `Category "${category.name}" deleted.` });
  } catch (err) {
    next(err);
  }
};

// Category names are free text: escape them before using them in a RegExp (the
// old code interpolated them raw, so a category called "C++" or "Lab (2)" broke
// the rename/delete checks).
const escapeRegex = (str) => String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
