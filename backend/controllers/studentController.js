import fs from "fs";
import path from "path";
import Student from "../models/Student.js";
import Attendance from "../models/Attendance.js";
import { sendSuccess, sendError } from "../utils/response.js";
import { validateStudentJSON, stripBom } from "../validators/studentValidator.js";
import { buildUploadPath, buildAbsUploadPath } from "../middleware/jsonUploadMiddleware.js";
import { findShiftByName, getShiftNames } from "../utils/shiftUtils.js";
import { getCategoryMaps, resolveCategoryCredit } from "../utils/creditUtils.js";
import { scopedModel, scopedAggregate } from "../utils/tenantScope.js";
import { escapeRegex, exactNameMatch, sameName } from "../utils/academicNames.js";
import { findDepartmentByName, getDepartmentNames } from "../utils/departmentUtils.js";
import { runInTransaction } from "../utils/txUtils.js";
import { pickOwn } from "../utils/safeKey.js";
import { planStudentImport, findStudentConflict, groupLabel } from "../services/studentRules.js";

// ── College scoping ──────────────────────────────────────────────────────────
// Every Student query goes through scopedModel(Student, req.tenant): the college
// is taken from the authenticated session, never from the request, so one
// college can never read, change or delete another college's students — even
// when both use the same department / batch / shift names or student ids.
// Query/body values must be plain strings (an object like {"$ne": ""} is
// treated as "not provided").
const str = (v) => (typeof v === "string" ? v.trim() : "");

// A batch label ("2021-2025") is short; an unbounded one would become part of a folder name and every row.
const MAX_BATCH_LENGTH = 50;
const students = (req) => scopedModel(Student, req.tenant);

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/students/upload
// Upload a JSON file containing students for a department / batch / shift.
// Multer (memoryStorage) has already parsed the file into req.file.buffer.
// We validate, then save to disk, then upsert into DB.
//
// This is the ONLY place batches get created in this system (spec section 9):
// a batch exists if and only if it appears in an admin-uploaded student file.
// There is no random/generated batch anywhere in the backend.
// ─────────────────────────────────────────────────────────────────────────────
const isDuplicateKey = (err) =>
  err?.code === 11000 || (Array.isArray(err?.writeErrors) && err.writeErrors.some((e) => (e?.code ?? e?.err?.code) === 11000));

const invalidDepartment = async (req, name) => {
  const names = await getDepartmentNames(req.tenant);
  return names.length
    ? `Invalid department "${name}". Must be one of: ${names.join(", ")}.`
    : `Invalid department "${name}". This college has no departments yet — create one first.`;
};

export const uploadStudentJSON = async (req, res) => {
  if (!req.file) {
    return sendError(res, "No file received. Please attach a .json file.", 400);
  }

  const departmentInput = str(req.body?.department);
  const batch = str(req.body?.batch);
  const shiftInput = str(req.body?.shift);

  // ── Basic field validation ────────────────────────────────────────────────
  const missing = [];
  if (!departmentInput) missing.push("department");
  if (!batch) missing.push("batch");
  if (!shiftInput) missing.push("shift");

  if (missing.length) {
    return sendError(
      res,
      `Missing required fields: ${missing.join(", ")}.`,
      400
    );
  }

  // ── The department and shift must belong to THIS college ─────────────────
  // Both are looked up in the caller's own college only, so another college's
  // department/shift is "not found" — and the canonical spelling of the
  // college's own name is what gets stored (no case-variant duplicate groups).
  if (batch.length > MAX_BATCH_LENGTH) {
    return sendError(res, `Batch must be at most ${MAX_BATCH_LENGTH} characters.`, 400);
  }

  const deptDoc = await findDepartmentByName(req.tenant, departmentInput);
  if (!deptDoc) {
    return sendError(res, await invalidDepartment(req, departmentInput), 400);
  }

  const shiftDoc = await findShiftByName(req.tenant, shiftInput);
  if (!shiftDoc) {
    const names = await getShiftNames(req.tenant);
    return sendError(
      res,
      `Invalid shift "${shiftInput}". Must be one of: ${names.join(", ")}.`,
      400
    );
  }

  const department = deptDoc.name;
  const shiftName = shiftDoc.name;

  // ── Parse the in-memory buffer ────────────────────────────────────────────
  let parsed;
  try {
    const raw = stripBom(req.file.buffer.toString("utf8"));
    parsed = JSON.parse(raw);
  } catch (parseErr) {
    return sendError(
      res,
      `Could not parse JSON file (${parseErr.message}). Make sure the file is valid JSON.`,
      422
    );
  }

  // ── Validate JSON structure / content ────────────────────────────────────
  const validation = validateStudentJSON(parsed);
  if (!validation.valid) {
    return res.status(422).json({
      success: false,
      message: `JSON validation failed (${validation.totalErrors} problem${validation.totalErrors === 1 ? "" : "s"}). No students were saved.`,
      errors: validation.errors,
      details: validation.details,
      totalErrors: validation.totalErrors,
    });
  }

  const { students: parsedStudents } = validation;

  // ── Save file to disk (after validation passes) ───────────────────────────
  const absDir = buildAbsUploadPath(department, batch, shiftName, req.tenant.collegeId);
  const base = path
    .basename(req.file.originalname, path.extname(req.file.originalname))
    .replace(/[^a-zA-Z0-9_\-]/g, "_");
  const filename = `${base}-${Date.now()}.json`;
  const absFilePath = path.join(absDir, filename);

  let fileWritten = false;
  try {
    fs.mkdirSync(absDir, { recursive: true });
    fs.writeFileSync(absFilePath, req.file.buffer);
    fileWritten = true;
  } catch (writeErr) {
    console.warn("[upload] Could not write file to disk:", writeErr.message);
    // Non-fatal — we still proceed with DB upsert
  }
  // A rejected/failed import must not leave its file behind as if it had been imported.
  const discardFile = () => {
    if (!fileWritten) return;
    try { fs.unlinkSync(absFilePath); } catch { /* best effort */ }
  };

  const relPath = path
    .join(buildUploadPath(department, batch, shiftName, req.tenant.collegeId), filename)
    .replace(/\\/g, "/");

  // ── Check against the college's existing students, then upsert ────────────
  // One transaction: the conflict check and the writes see the same snapshot,
  // and if any write fails NONE of the file is applied. (On a MongoDB that has
  // no transaction support — a standalone dev mongod — runInTransaction falls
  // back to running the same steps without one; the check below still rejects
  // every known conflict BEFORE the first write.)
  let usedTransaction = false;
  let outcome;
  try {
    outcome = await runInTransaction(async (session) => {
      usedTransaction = Boolean(session);
      const plan = await planStudentImport({
        tenant: req.tenant,
        department,
        batch,
        shift: shiftName,
        rows: parsedStudents,
        uploadedBy: req.user.id,
        sourceFile: relPath,
        session,
      });
      if (plan.errors.length) return { plan };
      const result = await students(req).bulkWrite(plan.ops, { ordered: false, ...(session ? { session } : {}) });
      return { plan, result };
    });
  } catch (dbError) {
    discardFile();
    console.error("[upload] DB upsert failed:", dbError.message);
    const atomicNote = usedTransaction
      ? "No students were saved."
      : "Some students may already have been saved; uploading the same file again is safe and will finish the import.";
    if (isDuplicateKey(dbError)) {
      return res.status(409).json({
        success: false,
        message: `Import stopped: a student ID or roll number clashed with data saved at the same time. ${atomicNote}`,
        errors: [],
        details: [],
        totalErrors: 0,
      });
    }
    return sendError(res, `Database error while saving students. ${atomicNote}`, 500);
  }

  const { plan, result } = outcome;
  if (plan.errors.length) {
    discardFile();
    return res.status(409).json({
      success: false,
      message: `Import rejected: ${plan.totalErrors} student${plan.totalErrors === 1 ? "" : "s"} conflict with existing students of this college. No students were saved.`,
      errors: plan.errors.map((e) => e.message),
      details: plan.errors,
      totalErrors: plan.totalErrors,
    });
  }

  return sendSuccess(
    res,
    {
      uploadedFile: relPath,
      department,
      batch,
      shift: shiftName,
      totalInFile: parsedStudents.length,
      inserted: result.upsertedCount,
      modified: result.modifiedCount,
      matched: result.matchedCount,
      reactivated: plan.counts.reactivate,
    },
    `Successfully processed ${parsedStudents.length} student(s).`,
    201
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/students
// Fetch students filtered by department, batch, shift (department required).
// ─────────────────────────────────────────────────────────────────────────────
export const getStudents = async (req, res) => {
  const department = str(req.query?.department);
  const batch = str(req.query?.batch);
  const shift = str(req.query?.shift);

  if (!department) {
    return sendError(res, 'Query param "department" is required.', 400);
  }

  const filter = { department, isActive: true };
  if (batch) filter.batch = batch;
  if (shift) filter.shift = exactNameMatch(shift);

  try {
    const list = await students(req).find(filter)
      .select("studentId roll name department batch shift createdAt")
      .sort({ roll: 1 })
      .lean();

    return sendSuccess(
      res,
      { count: list.length, students: list },
      list.length
        ? `Found ${list.length} student(s).`
        : "No students found for the given filters."
    );
  } catch (err) {
    console.error("[getStudents] DB error:", err.message);
    return sendError(res, "Failed to fetch students.", 500);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/students/groups
// List all unique department/batch/shift combinations that have students.
// ─────────────────────────────────────────────────────────────────────────────
export const getStudentGroups = async (req, res) => {
  try {
    const groups = await students(req).aggregate([
      { $match: { isActive: true } },
      {
        $group: {
          _id: { department: "$department", batch: "$batch", shift: "$shift" },
          count: { $sum: 1 },
        },
      },
      {
        $project: {
          _id: 0,
          department: "$_id.department",
          batch: "$_id.batch",
          shift: "$_id.shift",
          count: 1,
        },
      },
      { $sort: { department: 1, batch: 1, shift: 1 } },
    ]);

    return sendSuccess(res, { count: groups.length, groups }, "Student groups fetched.");
  } catch (err) {
    console.error("[getStudentGroups] DB error:", err.message);
    return sendError(res, "Failed to fetch student groups.", 500);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/students/batches
// Spec section 9 (Batch System Fix): batches shown to the UI must come ONLY
// from admin-uploaded student data — never randomly generated. This returns
// the distinct, real batch values on file, optionally scoped to a department
// and/or shift.
// ─────────────────────────────────────────────────────────────────────────────
export const getBatches = async (req, res) => {
  try {
    const department = str(req.query?.department);
    const shift = str(req.query?.shift);
    const filter = { isActive: true };
    if (department) filter.department = department;
    if (shift) filter.shift = exactNameMatch(shift);

    const batches = await students(req).distinct("batch", filter);
    batches.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

    return sendSuccess(res, { count: batches.length, batches }, "Batches fetched successfully.");
  } catch (err) {
    console.error("[getBatches] DB error:", err.message);
    return sendError(res, "Failed to fetch batches.", 500);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/students/group
// Soft-delete all students in a department/batch/shift.
// Body: { department, batch, shift }
// ─────────────────────────────────────────────────────────────────────────────
export const deleteStudentGroup = async (req, res) => {
  const department = str(req.body?.department);
  const batch = str(req.body?.batch);
  const shift = str(req.body?.shift);

  const missing = [];
  if (!department) missing.push("department");
  if (!batch) missing.push("batch");
  if (!shift) missing.push("shift");

  if (missing.length) {
    return sendError(res, `Missing required fields: ${missing.join(", ")}.`, 400);
  }

  try {
    // Only THIS college's students of the group are deactivated, even if other
    // colleges have an identically named department / batch / shift.
    const result = await students(req).updateMany(
      {
        department,
        batch,
        shift: exactNameMatch(shift),
        isActive: true,
      },
      { $set: { isActive: false } }
    );

    return sendSuccess(
      res,
      { deactivated: result.modifiedCount },
      `Deactivated ${result.modifiedCount} student(s) from group.`
    );
  } catch (err) {
    console.error("[deleteStudentGroup] DB error:", err.message);
    return sendError(res, "Failed to delete student group.", 500);
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// Student Management System (spec section 8) — Admin CRUD for individuals.
// The upload/group endpoints above remain the bulk pathway; these cover
// one-off add/edit/remove operations from the admin's Manage Students page.
// ═══════════════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/students/admin
// Admin-only: view all students system-wide. Supports optional filters
// (department, shift, batch) and pagination. Unlike GET /api/students,
// department is NOT required here.
// ─────────────────────────────────────────────────────────────────────────────
export const adminGetAllStudents = async (req, res) => {
  try {
    const { page = 1, limit = 50, includeInactive } = req.query;
    const department = str(req.query.department);
    const batch = str(req.query.batch);
    const shift = str(req.query.shift);
    const search = str(req.query.search);

    const filter = {};
    if (includeInactive !== "true") filter.isActive = true;
    if (department) filter.department = department;
    if (batch) filter.batch = batch;
    if (shift) filter.shift = exactNameMatch(shift);
    if (search) {
      const s = escapeRegex(search);
      filter.$or = [
        { name: { $regex: s, $options: "i" } },
        { roll: { $regex: s, $options: "i" } },
        { studentId: { $regex: s, $options: "i" } },
      ];
    }

    const pageNum = Math.max(1, Number(page) || 1);
    const limitNum = Math.min(200, Math.max(1, Number(limit) || 50));
    const skip = (pageNum - 1) * limitNum;

    const [list, total] = await Promise.all([
      students(req).find(filter).sort({ department: 1, batch: 1, roll: 1 }).skip(skip).limit(limitNum).lean(),
      students(req).countDocuments(filter),
    ]);

    return sendSuccess(
      res,
      {
        students: list,
        pagination: { total, page: pageNum, limit: limitNum, totalPages: Math.ceil(total / limitNum) },
      },
      "Students fetched successfully."
    );
  } catch (err) {
    console.error("[adminGetAllStudents] DB error:", err.message);
    return sendError(res, "Failed to fetch students.", 500);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/students/admin
// Admin-only: add a single student manually (outside of a JSON upload).
// Body: { studentId, roll, name, department, batch, shift, email?, section? }
// ─────────────────────────────────────────────────────────────────────────────
export const adminCreateStudent = async (req, res) => {
  try {
    const { email, section } = req.body || {};
    const studentId = typeof req.body?.studentId === "number" ? String(req.body.studentId) : req.body?.studentId;
    const roll = typeof req.body?.roll === "number" ? String(req.body.roll) : req.body?.roll;
    const { name, department, batch, shift } = req.body || {};
    for (const v of [studentId, roll, name, department, batch, shift]) {
      if (v !== undefined && typeof v !== "string") return sendError(res, "Invalid student data.", 400);
    }

    const missing = [];
    if (!studentId) missing.push("studentId");
    if (!roll) missing.push("roll");
    if (!name) missing.push("name");
    if (!department) missing.push("department");
    if (!batch) missing.push("batch");
    if (!shift) missing.push("shift");
    if (missing.length) {
      return sendError(res, `Missing required fields: ${missing.join(", ")}.`, 400);
    }

    // The department and shift must be the CALLER'S college's own; the college's
    // spelling of the name is what gets stored.
    const deptDoc = await findDepartmentByName(req.tenant, department);
    if (!deptDoc) return sendError(res, await invalidDepartment(req, department), 400);

    const shiftDoc = await findShiftByName(req.tenant, shift);
    if (!shiftDoc) {
      const names = await getShiftNames(req.tenant);
      return sendError(res, `Invalid shift "${shift}". Must be one of: ${names.join(", ")}.`, 400);
    }

    const departmentTrimmed = deptDoc.name;
    const batchTrimmed = String(batch).trim();
    if (batchTrimmed.length > MAX_BATCH_LENGTH) return sendError(res, `Batch must be at most ${MAX_BATCH_LENGTH} characters.`, 400);
    const studentIdTrimmed = String(studentId).trim();
    const rollTrimmed = String(roll).trim();

    // ── Duplicate registration prevention (spec section 1) ─────────────────
    // Block if EITHER the Registration Number (studentId) is held by another
    // active student of THIS college, OR the Roll Number is held by another
    // active student of this college's department/batch/shift. Another
    // college's students never count. Checked here for a clear, immediate
    // error; the unique indexes on the Student model are the backstop.
    const conflict = await findStudentConflict(req.tenant, {
      studentId: studentIdTrimmed,
      roll: rollTrimmed,
      department: departmentTrimmed,
      batch: batchTrimmed,
      shift: shiftDoc.name,
    });
    if (conflict) return sendError(res, conflict.message, 409);

    // A REMOVED student with this registration number in this very group still
    // occupies the group's {studentId, department, batch, shift} unique index
    // (the bulk import revives such a record; manual creation must not pretend
    // the number is "registered" without saying why).
    const removedInGroup = await students(req).findOne(
      { isActive: false, studentId: studentIdTrimmed, department: departmentTrimmed, batch: batchTrimmed, shift: shiftDoc.name },
      { lean: true }
    );
    if (removedInGroup) {
      return sendError(
        res,
        `A removed student with Registration Number "${studentIdTrimmed}" already exists in ${groupLabel({ department: departmentTrimmed, batch: batchTrimmed, shift: shiftDoc.name })}. ` +
          "Restore that student (edit it and make it active again) or use a different Registration Number.",
        409
      );
    }

    const student = await students(req).create({
      studentId: studentIdTrimmed,
      roll: rollTrimmed,
      name: String(name).trim(),
      department: departmentTrimmed,
      batch: batchTrimmed,
      shift: shiftDoc.name,
      uploadedBy: req.user.id,
      isActive: true,
      ...(email ? { email: String(email).trim() } : {}),
      ...(section ? { section: String(section).trim() } : {}),
    });

    return sendSuccess(res, { student: student.toPublicJSON() }, "Student added successfully.", 201);
  } catch (err) {
    if (err.code === 11000) return sendError(res, "This Roll Number or Registration Number is already registered.", 409);
    if (err.name === "ValidationError") {
      return sendError(res, Object.values(err.errors).map((e) => e.message).join(", "), 422);
    }
    console.error("[adminCreateStudent] DB error:", err.message);
    return sendError(res, "Failed to add student.", 500);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/students/admin/:id
// Admin-only: edit a single student's information.
// ─────────────────────────────────────────────────────────────────────────────
export const adminUpdateStudent = async (req, res) => {
  try {
    const { id } = req.params;
    // Scoped lookup: another college's student id (or any malformed id) is a plain 404.
    const student = await students(req).findById(id);
    if (!student) return sendError(res, "Student not found.", 404);

    const { studentId, roll, name, department, batch, shift, isActive } = req.body || {};
    for (const v of [studentId, roll, name, department, batch, shift]) {
      if (v !== undefined && typeof v !== "string" && typeof v !== "number") return sendError(res, "Invalid student data.", 400);
    }

    const wasActive = student.isActive;

    if (shift !== undefined) {
      const shiftDoc = await findShiftByName(req.tenant, shift);
      if (!shiftDoc) {
        const names = await getShiftNames(req.tenant);
        return sendError(res, `Invalid shift "${shift}". Must be one of: ${names.join(", ")}.`, 400);
      }
      student.shift = shiftDoc.name;
    }
    // Moving a student to another department: it must be one of THIS college's.
    // (Sending the department the student already has is not a move, so editing
    // an older record whose department was never in the list still works.)
    if (department !== undefined && !sameName(String(department), student.department)) {
      const deptDoc = await findDepartmentByName(req.tenant, String(department));
      if (!deptDoc) return sendError(res, await invalidDepartment(req, department), 400);
      student.department = deptDoc.name;
    }
    if (studentId !== undefined) student.studentId = String(studentId).trim();
    if (roll !== undefined) student.roll = String(roll).trim();
    if (name !== undefined) student.name = String(name).trim();
    if (batch !== undefined) {
      const b = String(batch).trim();
      if (b.length > MAX_BATCH_LENGTH) return sendError(res, `Batch must be at most ${MAX_BATCH_LENGTH} characters.`, 400);
      student.batch = b;
    }
    if (isActive !== undefined) student.isActive = Boolean(isActive);

    // ── Duplicate registration prevention (spec section 1) ─────────────────
    // Re-check whenever the identity or group of an ACTIVE student may have
    // changed (including bringing a removed student back), so an edit can never
    // create the duplicate that student creation blocks. A removed student that
    // stays removed holds no registration/roll, so it is not checked.
    const identityTouched = [studentId, roll, department, batch, shift].some((v) => v !== undefined) || (!wasActive && student.isActive);
    if (student.isActive && identityTouched) {
      const conflict = await findStudentConflict(req.tenant, {
        studentId: student.studentId,
        roll: student.roll,
        department: student.department,
        batch: student.batch,
        shift: student.shift,
        excludeId: student._id,
      });
      if (conflict) return sendError(res, conflict.message, 409);
    }

    await student.save();
    return sendSuccess(res, { student: student.toPublicJSON() }, "Student updated successfully.");
  } catch (err) {
    if (err.code === 11000) return sendError(res, "This Roll Number or Registration Number is already registered.", 409);
    if (err.name === "ValidationError") {
      return sendError(res, Object.values(err.errors).map((e) => e.message).join(", "), 422);
    }
    console.error("[adminUpdateStudent] DB error:", err.message);
    return sendError(res, "Failed to update student.", 500);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/students/admin/:id
// Admin-only: remove a single student. Soft-deletes (isActive=false) by
// default so attendance history stays intact; pass ?hard=true to permanently
// remove the document instead.
// ─────────────────────────────────────────────────────────────────────────────
export const adminDeleteStudent = async (req, res) => {
  try {
    const { id } = req.params;
    const { hard } = req.query;

    const student = await students(req).findById(id);
    if (!student) return sendError(res, "Student not found.", 404);

    if (hard === "true") {
      await students(req).deleteOne({ _id: student._id });
      return sendSuccess(res, { deletedId: id }, `Student "${student.name}" permanently removed.`);
    }

    student.isActive = false;
    await student.save();
    return sendSuccess(res, { student: student.toPublicJSON() }, `Student "${student.name}" removed from batch.`);
  } catch (err) {
    console.error("[adminDeleteStudent] DB error:", err.message);
    return sendError(res, "Failed to remove student.", 500);
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// Global Student Directory (Feature 3) — "All Students"
// Admin-only. One searchable, sortable, paginated table of every student in
// the system, department/batch/shift-agnostic, with computed attendance
// stats (Overall Attendance %, Credit Score, Total Subjects Enrolled).
// ═══════════════════════════════════════════════════════════════════════════

// ── Same buckets as getStudentAnalytics (alertsController.js) so a student's
// status always reads the same everywhere in the app. ──────────────────────
const statusFromPercentage = (pct) => {
  if (pct < 50) return "Critical";
  if (pct < 65) return "Warning";
  if (pct < 75) return "Good";
  return "Excellent";
};

// Fields the directory can be sorted by that already live on the Student
// document — these can be sorted/paginated straight from MongoDB (fast,
// index-friendly, no need to touch Attendance at all).
const PLAIN_SORT_FIELDS = {
  name: "name",
  roll: "roll",
  studentId: "studentId",
  department: "department",
  batch: "batch",
  shift: "shift",
  createdAt: "createdAt",
};

// Fields that only exist after aggregating Attendance — sorting by these
// requires the stats for every matching student before the page can be cut.
const COMPUTED_SORT_FIELDS = new Set([
  "totalSubjects",
  "attendancePercentage",
  "creditScore",
  "status",
]);

// ─────────────────────────────────────────────────────────────────────────────
// Given a batch of lean Student docs, compute their attendance stats in ONE
// Attendance aggregation query (never one query per student). Scoped to the
// exact studentIds passed in, so it stays cheap even with thousands of rows
// in the Attendance collection — only sessions touching this batch of
// students are read.
//
// Reuses the same math as the shared calculateCreditScore() utility
// (backend/utils/creditUtils.js) so the numbers shown here always match the
// per-student analytics page: only "present" sessions count, category names
// are normalized before grouping, and credit value comes from the
// admin-configured AttendanceCategory (falling back to the known defaults).
// ─────────────────────────────────────────────────────────────────────────────
const attachAttendanceStats = async (tenant, students, creditMap) => {
  if (students.length === 0) return [];

  const studentIds = students.map((s) => s.studentId);

  const rows = await scopedAggregate(Attendance, tenant, [
    // Only sessions that include at least one of these students, and aren't trashed.
    // scopedAggregate puts { collegeId } in front of this $match (Part 12):
    // student ids are only unique within a college, so "2023-001" in another
    // college must never feed these numbers.
    { $match: { isDeleted: false, "students.studentId": { $in: studentIds } } },
    { $unwind: "$students" },
    // Re-filter post-unwind: a session can list many students, most of whom
    // aren't in this batch — drop those rows before grouping.
    { $match: { "students.studentId": { $in: studentIds } } },
    {
      $group: {
        _id: {
          studentId: "$students.studentId",
          // Normalize the same way creditUtils.normalizeCategoryName does,
          // so "Lab" / "lab" / "LAB" collapse into one group.
          classType: { $trim: { input: { $toLower: "$classType" } } },
        },
        totalClasses: { $sum: 1 },
        presentCount: { $sum: { $cond: [{ $eq: ["$students.status", "present"] }, 1, 0] } },
        subjectIds: { $addToSet: "$subjectId" },
      },
    },
  ]);

  // Collapse the per-(student, classType) rows down to one entry per student.
  const statsByStudent = new Map();
  for (const row of rows) {
    const sid = row._id.studentId;
    if (!statsByStudent.has(sid)) {
      statsByStudent.set(sid, {
        totalClasses: 0,
        totalAttended: 0,
        subjectIds: new Set(),
        creditScore: 0,
      });
    }
    const entry = statsByStudent.get(sid);
    entry.totalClasses += row.totalClasses;
    entry.totalAttended += row.presentCount;
    for (const subjectId of row.subjectIds) entry.subjectIds.add(String(subjectId));

    const creditValue = resolveCategoryCredit(row._id.classType, creditMap);
    entry.creditScore += row.presentCount * creditValue; // absences never count
  }

  return students.map((s) => {
    const stat = statsByStudent.get(s.studentId);
    const totalClasses = stat?.totalClasses || 0;
    const totalAttended = stat?.totalAttended || 0;
    const attendancePercentage =
      totalClasses > 0 ? Math.round((totalAttended / totalClasses) * 100) : 0;

    return {
      _id: s._id,
      studentId: s.studentId,
      roll: s.roll,
      name: s.name,
      department: s.department,
      batch: s.batch,
      shift: s.shift,
      totalSubjects: stat ? stat.subjectIds.size : 0,
      totalClasses,
      totalAttended,
      attendancePercentage,
      creditScore: stat ? Math.round(stat.creditScore * 100) / 100 : 0,
      status: statusFromPercentage(attendancePercentage),
      createdAt: s.createdAt,
    };
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/students/directory
// Admin-only: every student across every department/batch/shift in one
// searchable, sortable, paginated table (spec Feature 3 — "All Students"),
// plus advanced filtering (spec Feature 4 — "Advanced Attendance Filters").
//
// Query params:
//   search          — matches name / roll / registration no. / department / batch
//   department      — exact match (case-insensitive)
//   batch           — exact match (case-insensitive)
//   shift           — exact match (case-insensitive)
//   attendanceBelow — 0–100; only students whose Overall Attendance % is
//                     STRICTLY BELOW this value are returned
//   sortBy    — name | roll | studentId | department | batch | shift |
//               createdAt | totalSubjects | attendancePercentage |
//               creditScore | status   (default: name)
//   sortOrder — asc | desc              (default: asc)
//   page, limit — pagination (limit capped at 100)
//
// All filters are combined with AND — department + batch + shift narrow the
// Student query itself (cheap, indexed), while attendanceBelow can only be
// evaluated after attendance is aggregated.
//
// Two execution paths:
//   1. No attendanceBelow AND sortBy is a plain Student field → sort/paginate
//      happens IN MongoDB (indexed, cheap), then only the current page's
//      students are sent through the Attendance aggregation. Stays fast no
//      matter how many thousands of students exist.
//   2. attendanceBelow is set, OR sortBy is a computed field (attendance %,
//      credit score, total subjects, status) → these don't exist until
//      Attendance is aggregated, so every student matching the
//      search/department/batch/shift filters first gets its stats computed
//      in ONE aggregation call (never per-student — avoids N+1), then the
//      attendance filter/sort/pagination all happen over that single
//      in-memory result set.
// ─────────────────────────────────────────────────────────────────────────────
export const getStudentDirectory = async (req, res) => {
  try {
    const { attendanceBelow = "", sortBy = "name", sortOrder = "asc", page = 1, limit = 20 } = req.query;
    const search = str(req.query.search);
    const department = str(req.query.department);
    const batch = str(req.query.batch);
    const shift = str(req.query.shift);

    const filter = { isActive: true };
    if (search) {
      const s = escapeRegex(search);
      filter.$or = [
        { name: { $regex: s, $options: "i" } },
        { roll: { $regex: s, $options: "i" } },
        { studentId: { $regex: s, $options: "i" } },
        { department: { $regex: s, $options: "i" } },
        { batch: { $regex: s, $options: "i" } },
      ];
    }
    // ── Advanced filters (spec Feature 4) — combined with AND ────────────────
    if (department) filter.department = exactNameMatch(department);
    if (batch) filter.batch = exactNameMatch(batch);
    if (shift) filter.shift = exactNameMatch(shift);

    // Attendance-percentage threshold — only valid, in-range values apply.
    const threshold = attendanceBelow === "" ? null : Number(attendanceBelow);
    const hasAttendanceFilter = threshold !== null && !Number.isNaN(threshold) && threshold >= 0 && threshold <= 100;

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
    const dir = sortOrder === "desc" ? -1 : 1;

    const { creditMap } = await getCategoryMaps(req.tenant);

    const projection = "studentId roll name department batch shift createdAt";

    // ── Path 1: no attendance filter + plain field sort → DB-level pagination ──
    if (!hasAttendanceFilter && !COMPUTED_SORT_FIELDS.has(sortBy)) {
      const sortField = pickOwn(PLAIN_SORT_FIELDS, sortBy, "name");

      const [total, pageStudents] = await Promise.all([
        students(req).countDocuments(filter),
        students(req).find(filter)
          .select(projection)
          .sort({ [sortField]: dir, _id: 1 })
          .skip((pageNum - 1) * limitNum)
          .limit(limitNum)
          .lean(),
      ]);

      const withStats = await attachAttendanceStats(req.tenant, pageStudents, creditMap);

      return sendSuccess(
        res,
        {
          students: withStats,
          pagination: {
            page: pageNum,
            limit: limitNum,
            total,
            totalPages: Math.max(1, Math.ceil(total / limitNum)),
          },
        },
        "Student directory fetched successfully."
      );
    }

    // ── Path 2: attendance filter and/or computed-field sort — need stats for
    //    every matching student before the page can be cut. Still just ONE
    //    Attendance aggregation call regardless of how many students match. ──
    const allMatching = await students(req).find(filter).select(projection).lean();
    let enriched = await attachAttendanceStats(req.tenant, allMatching, creditMap);

    if (hasAttendanceFilter) {
      enriched = enriched.filter((s) => s.attendancePercentage < threshold);
    }

    const statusRank = { Critical: 0, Warning: 1, Good: 2, Excellent: 3 };
    const localeCmp = (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
    const sorters = {
      name: (a, b) => localeCmp(a.name, b.name) * dir,
      roll: (a, b) => localeCmp(a.roll, b.roll) * dir,
      studentId: (a, b) => localeCmp(a.studentId, b.studentId) * dir,
      department: (a, b) => localeCmp(a.department, b.department) * dir,
      batch: (a, b) => localeCmp(a.batch, b.batch) * dir,
      shift: (a, b) => localeCmp(a.shift, b.shift) * dir,
      createdAt: (a, b) => (new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()) * dir,
      totalSubjects: (a, b) => (a.totalSubjects - b.totalSubjects) * dir,
      attendancePercentage: (a, b) => (a.attendancePercentage - b.attendancePercentage) * dir,
      creditScore: (a, b) => (a.creditScore - b.creditScore) * dir,
      status: (a, b) => (statusRank[a.status] - statusRank[b.status]) * dir,
    };
    enriched.sort(pickOwn(sorters, sortBy, sorters.name));

    const total = enriched.length;
    const totalPages = Math.max(1, Math.ceil(total / limitNum));
    const start = (pageNum - 1) * limitNum;
    const pageRows = enriched.slice(start, start + limitNum);

    return sendSuccess(
      res,
      { students: pageRows, pagination: { page: pageNum, limit: limitNum, total, totalPages } },
      "Student directory fetched successfully."
    );
  } catch (err) {
    console.error("[getStudentDirectory] DB error:", err.message);
    return sendError(res, "Failed to fetch student directory.", 500);
  }
};
