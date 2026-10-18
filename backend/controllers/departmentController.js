import Department from "../models/Department.js";
import Student from "../models/Student.js";
import Subject from "../models/Subject.js";
import { sendSuccess, sendError } from "../utils/response.js";
import { scopedModel } from "../utils/tenantScope.js";
import { exactNameMatch, cleanName, sameName, isPlainString } from "../utils/academicNames.js";

// Every query below goes through scopedModel(…, req.tenant): the college comes
// from the authenticated session (middleware/tenantGuards.js → tenantContext),
// never from the request body, query string or URL. A department id belonging
// to another college answers 404 — exactly like an id that does not exist.

const DUP_MSG = (n) => `Department "${n}" already exists`;

// ─── GET /api/departments ─────────────────────────────────────────────────────
export const getDepartments = async (req, res, next) => {
  try {
    const departments = await scopedModel(Department, req.tenant).find({}).sort({ name: 1 }).lean();
    return sendSuccess(res, { departments: departments.map((d) => d.name), full: departments });
  } catch (err) {
    next(err);
  }
};

// ─── POST /api/departments ────────────────────────────────────────────────────
export const createDepartment = async (req, res, next) => {
  try {
    const { name } = req.body || {};
    if (!isPlainString(name) || !cleanName(name)) {
      return sendError(res, "Department name is required", 400);
    }
    const trimmed = cleanName(name);
    const depts = scopedModel(Department, req.tenant);

    const existing = await depts.findOne({ name: exactNameMatch(trimmed) });
    if (existing) return sendError(res, DUP_MSG(trimmed), 409);

    const dept = await depts.create({ name: trimmed, createdBy: req.user?.id });
    return sendSuccess(res, { department: dept }, "Department created successfully.", 201);
  } catch (err) {
    if (err.code === 11000) return sendError(res, "A department with this name already exists", 409);
    next(err);
  }
};

// ─── PUT /api/departments/:id ─────────────────────────────────────────────────
// Admin only: edit a department. Renaming propagates to the college's
// Student/Subject records that reference the old name, so nothing is left
// orphaned. Other colleges' records that happen to use the same name are NOT
// touched.
export const updateDepartment = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { name } = req.body || {};

    if (!isPlainString(name) || !cleanName(name)) {
      return sendError(res, "Department name is required", 400);
    }
    const trimmed = cleanName(name);

    const depts = scopedModel(Department, req.tenant);
    const dept = await depts.findById(id);
    if (!dept) return sendError(res, "Department not found", 404);

    const oldName = dept.name;
    const renamed = !sameName(trimmed, oldName);

    if (renamed) {
      const dup = await depts.findOne({ name: exactNameMatch(trimmed), _id: { $ne: dept._id } });
      if (dup) return sendError(res, DUP_MSG(trimmed), 409);
    }

    dept.name = trimmed;
    await dept.save();

    if (renamed) {
      const byOldName = { department: exactNameMatch(oldName) };
      await Promise.all([
        scopedModel(Student, req.tenant).updateMany(byOldName, { $set: { department: trimmed } }),
        scopedModel(Subject, req.tenant).updateMany(byOldName, { $set: { department: trimmed } }),
      ]);
    }

    return sendSuccess(res, { department: dept }, "Department updated successfully.");
  } catch (err) {
    if (err.code === 11000) return sendError(res, "A department with this name already exists", 409);
    next(err);
  }
};

// ─── DELETE /api/departments/:id ─────────────────────────────────────────────
// Blocked if the department is currently in use by any student or subject OF
// THIS COLLEGE (subjects are teacher-assigned, so this is the safeguard that
// stops a department vanishing from under a teacher's subject).
export const deleteDepartment = async (req, res, next) => {
  try {
    const { id } = req.params;
    const depts = scopedModel(Department, req.tenant);
    const dept = await depts.findById(id);
    if (!dept) return sendError(res, "Department not found", 404);

    const nameFilter = exactNameMatch(dept.name);
    const [studentCount, subjectCount] = await Promise.all([
      scopedModel(Student, req.tenant).countDocuments({ department: nameFilter, isActive: true }),
      scopedModel(Subject, req.tenant).countDocuments({ department: nameFilter }),
    ]);

    if (studentCount > 0 || subjectCount > 0) {
      return sendError(
        res,
        `Cannot delete "${dept.name}" — it is used by ${studentCount} student(s) and ${subjectCount} subject(s). Reassign them first.`,
        409
      );
    }

    await depts.deleteOne({ _id: dept._id });
    return sendSuccess(res, { message: `Department "${dept.name}" deleted` });
  } catch (err) {
    next(err);
  }
};
