import Subject, { COLORS } from "../models/Subject.js";
import Department from "../models/Department.js";
import Attendance from "../models/Attendance.js";
import ConsecutiveAbsenceAlert from "../models/ConsecutiveAbsenceAlert.js";
import { sendSuccess, sendError } from "../utils/response.js";
import { findShiftByName, getShiftNames } from "../utils/shiftUtils.js";
import { findCategoryByName, getCategoryNames, resolveCreditValue } from "../utils/creditUtils.js";
import { runInTransaction } from "../utils/txUtils.js";
import { scopedModel } from "../utils/tenantScope.js";
import { exactNameMatch, escapeRegex } from "../utils/academicNames.js";
import { isObjectIdString } from "../utils/approval.js";
import { resolveAssignableTeacher, listAssignableTeachers, populateTeacher } from "../utils/subjectAssignment.js";
import { isOwnedBy } from "../utils/trashRules.js";
import { pickOwn } from "../utils/safeKey.js";

// Subjects, and the departments/shifts they must reference, are all looked up
// through scopedModel(…, req.tenant): the college comes from the authenticated
// session. A department or shift id/name that exists only in ANOTHER college is
// "invalid" here, and a subject of another college is "not found".
const subjects = (req) => scopedModel(Subject, req.tenant);
const strOrUndef = (v) => (typeof v === "string" ? v : undefined);

// The teacher a subject is assigned to (its owner). Only admins may assign a
// subject to someone other than themselves, and only to an approved teacher of
// THEIR OWN college (utils/subjectAssignment.js). A teacher id is never taken
// on trust: it is re-read from the database, inside the caller's college.
const wantsAssignment = (teacherId) => teacherId !== undefined && teacherId !== null && teacherId !== "";

// Department lookup is case-insensitive and returns the college's own spelling,
// which is what gets stored (so "computer science" cannot create a second,
// differently-cased department string on subjects).
const findCollegeDepartment = (req, name) =>
  scopedModel(Department, req.tenant).findOne({ name: exactNameMatch(name) });

// ─── POST /api/subjects ───────────────────────────────────────────────────────
// NOTE (spec section 3): Subjects no longer carry an attendance category.
// Teachers pick the category (Theory/Lab/etc.) each time they take attendance
// for this subject, not once at creation — a single subject can have both
// Theory and Lab sessions over its lifetime.
export const createSubject = async (req, res, next) => {
  try {
    const { subjectName, subjectCode, batch, department, shift, color, teacherId } = req.body || {};
    for (const v of [subjectName, subjectCode, batch, department, shift, color]) {
      if (v !== undefined && typeof v !== "string") return sendError(res, "Invalid subject data.", 400);
    }
    if (teacherId !== undefined && teacherId !== null && typeof teacherId !== "string") {
      return sendError(res, "Invalid subject data.", 400);
    }

    const missing = [];
    if (!subjectName)  missing.push("subjectName");
    if (!subjectCode)  missing.push("subjectCode");
    if (!batch)        missing.push("batch");
    if (!department)   missing.push("department");
    if (!shift)        missing.push("shift");
    if (missing.length > 0) return sendError(res, `Missing required fields: ${missing.join(", ")}`, 400);

    // Validate department against THIS college's departments
    const deptDoc = await findCollegeDepartment(req, department);
    if (!deptDoc) return sendError(res, "Invalid department.", 400);

    // Validate shift against the college's admin-managed shifts
    const shiftDoc = await findShiftByName(req.tenant, shift);
    if (!shiftDoc) {
      const names = await getShiftNames(req.tenant);
      return sendError(res, `Invalid shift. Must be one of: ${names.join(", ")}`, 400);
    }

    if (color && !COLORS.includes(color)) return sendError(res, `Invalid color.`, 400);

    const batchTrimmed = String(batch).trim();
    if (!batchTrimmed || batchTrimmed.length > 10) return sendError(res, "Batch must be 1–10 characters.", 400);

    const codeTrimmed = subjectCode.trim().toUpperCase();
    if (!/^[A-Z0-9\-]+$/.test(codeTrimmed)) {
      return sendError(res, "Subject code can only contain letters, numbers, and hyphens.", 400);
    }

    // Who is this subject assigned to? Default: the creator (unchanged). An
    // admin may name another teacher — who must belong to the admin's college.
    let ownerId = req.user.id;
    let assignedByAdmin = false;
    if (wantsAssignment(teacherId) && teacherId !== req.user.id) {
      if (req.user.role !== "admin") {
        return sendError(res, "Only an administrator can assign a subject to another teacher.", 403);
      }
      const r = await resolveAssignableTeacher(req.tenant, teacherId);
      if (!r.ok) return sendError(res, r.message, r.status);
      ownerId = String(r.teacher._id);
      assignedByAdmin = true;
    }

    const existing = await subjects(req).findOne({ subjectCode: codeTrimmed, teacher: ownerId });
    if (existing) {
      return sendError(
        res,
        assignedByAdmin
          ? `That teacher already has a subject with code '${codeTrimmed}'.`
          : `You already have a subject with code '${codeTrimmed}'.`,
        409
      );
    }

    const subject = await subjects(req).create({
      subjectName: subjectName.trim(),
      subjectCode: codeTrimmed,
      batch: batchTrimmed,
      department: deptDoc.name,
      shift: shiftDoc.name,
      color: color || "brand",
      teacher: ownerId,
    });
    await subject.populate(populateTeacher(req.tenant));

    return sendSuccess(res, { subject: subject.toPublicJSON() }, "Subject created successfully.", 201);
  } catch (error) {
    if (error.code === 11000) return sendError(res, "A subject with this code already exists for this teacher.", 409);
    next(error);
  }
};

// ─── GET /api/subjects ────────────────────────────────────────────────────────
export const getSubjects = async (req, res, next) => {
  try {
    const filter = {};
    if (req.user.role === "admin" && strOrUndef(req.query.teacherId)) {
      // Another college's teacher id is simply "no subjects here": the query
      // below is college-scoped, so it matches nothing.
      if (!isObjectIdString(req.query.teacherId)) return sendError(res, "Invalid teacherId.", 400);
      filter.teacher = req.query.teacherId;
    } else if (req.user.role !== "admin") {
      filter.teacher = req.user.id;
    }

    // Text search over name and code (literal text: regex characters are escaped).
    const search = strOrUndef(req.query.search)?.trim();
    if (search) {
      if (search.length > 100) return sendError(res, "Search text is too long.", 400);
      const rx = { $regex: escapeRegex(search), $options: "i" };
      filter.$or = [{ subjectName: rx }, { subjectCode: rx }];
    }

    if (strOrUndef(req.query.batch))       filter.batch      = req.query.batch;
    if (strOrUndef(req.query.department))  filter.department = req.query.department;
    if (strOrUndef(req.query.shift))       filter.shift      = exactNameMatch(req.query.shift);
    if (strOrUndef(req.query.creditType))  filter.creditType = exactNameMatch(req.query.creditType);

    if (req.query.archived === "true")     filter.isArchived = true;
    else if (req.query.archived !== "all") filter.isArchived = false;

    const sortMap = { newest: { createdAt: -1 }, oldest: { createdAt: 1 }, name: { subjectName: 1 }, code: { subjectCode: 1 } };
    const sort = pickOwn(sortMap, req.query.sort, { createdAt: -1 });

    const list = await subjects(req).find(filter).sort(sort).populate(populateTeacher(req.tenant));
    return sendSuccess(res, { subjects: list.map((s) => s.toPublicJSON()), count: list.length });
  } catch (error) {
    next(error);
  }
};

// ─── GET /api/subjects/:id ────────────────────────────────────────────────────
export const getSubjectById = async (req, res, next) => {
  try {
    const subject = await subjects(req).findById(req.params.id);
    if (!subject) return sendError(res, "Subject not found.", 404);
    if (req.user.role !== "admin" && !isOwnedBy(subject.teacher, req.user.id)) {
      return sendError(res, "You are not authorized to view this subject.", 403);
    }
    await subject.populate(populateTeacher(req.tenant));
    return sendSuccess(res, { subject: subject.toPublicJSON() });
  } catch (error) {
    next(error);
  }
};

// ─── PUT /api/subjects/:id ────────────────────────────────────────────────────
// Admins (of this college) may also send `teacherId` to re-assign the subject to
// another approved teacher of the SAME college. Re-assigning moves the subject's
// attendance sessions and alerts to the new teacher in one transaction, so the
// new owner can manage the subject's whole history (every ownership check
// compares the session's user with Attendance.teacher / Alert.teacherId).
export const updateSubject = async (req, res, next) => {
  try {
    const subject = await subjects(req).findById(req.params.id);
    if (!subject) return sendError(res, "Subject not found.", 404);
    if (req.user.role !== "admin" && !isOwnedBy(subject.teacher, req.user.id)) {
      return sendError(res, "Not authorized.", 403);
    }

    const { subjectName, subjectCode, batch, department, shift, creditType, credits, color, isArchived, teacherId } = req.body || {};
    for (const v of [subjectName, subjectCode, batch, department, shift, creditType, color]) {
      if (v !== undefined && typeof v !== "string") return sendError(res, "Invalid subject data.", 400);
    }
    if (teacherId !== undefined && teacherId !== null && typeof teacherId !== "string") {
      return sendError(res, "Invalid subject data.", 400);
    }

    // ── Assignment (validated first: it decides whose code namespace applies) ──
    const currentOwner = subject.teacher ? String(subject.teacher) : "";
    let newOwner = null;
    if (wantsAssignment(teacherId) && teacherId !== currentOwner) {
      if (req.user.role !== "admin") {
        return sendError(res, "Only an administrator can assign a subject to another teacher.", 403);
      }
      const r = await resolveAssignableTeacher(req.tenant, teacherId);
      if (!r.ok) return sendError(res, r.message, r.status);
      newOwner = String(r.teacher._id);
    }
    const ownerAfter = newOwner || currentOwner;

    if (subjectName !== undefined) {
      const t = subjectName.trim();
      if (t.length < 2 || t.length > 150) return sendError(res, "Subject name must be 2–150 characters.", 400);
      subject.subjectName = t;
    }
    let codeAfter = subject.subjectCode;
    if (subjectCode !== undefined) {
      const c = subjectCode.trim().toUpperCase();
      if (!/^[A-Z0-9\-]+$/.test(c)) return sendError(res, "Invalid subject code format.", 400);
      codeAfter = c;
    }
    if (codeAfter !== subject.subjectCode || newOwner) {
      // The (code, teacher) pair must stay unique. A teacher belongs to one
      // college, so this is automatically a per-college rule.
      const dup = await subjects(req).findOne({ subjectCode: codeAfter, teacher: ownerAfter, _id: { $ne: subject._id } });
      if (dup) {
        return sendError(
          res,
          newOwner ? `That teacher already has a subject with code '${codeAfter}'.` : `Code '${codeAfter}' already in use.`,
          409
        );
      }
      subject.subjectCode = codeAfter;
    }
    if (batch !== undefined) {
      const b = String(batch).trim();
      if (!b || b.length > 10) return sendError(res, "Batch must be 1–10 characters.", 400);
      subject.batch = b;
    }
    if (department !== undefined) {
      const deptDoc = await findCollegeDepartment(req, department);
      if (!deptDoc) return sendError(res, "Invalid department.", 400);
      subject.department = deptDoc.name;
    }
    if (shift !== undefined) {
      const shiftDoc = await findShiftByName(req.tenant, shift);
      if (!shiftDoc) return sendError(res, "Invalid shift.", 400);
      subject.shift = shiftDoc.name;
    }
    let category = null;
    if (creditType !== undefined) {
      category = await findCategoryByName(req.tenant, creditType);
      if (!category) return sendError(res, "Invalid subject type.", 400);
      subject.creditType = category.name;
      if (credits === undefined) subject.credits = category.credit;
    }
    if (credits !== undefined) {
      const n = Number(credits);
      if (isNaN(n) || n < 0 || n > 20) return sendError(res, "Credits must be 0–20.", 400);
      subject.credits = n;
    }
    if (color !== undefined) {
      if (!COLORS.includes(color)) return sendError(res, "Invalid color.", 400);
      subject.color = color;
    }
    if (isArchived !== undefined) subject.isArchived = Boolean(isArchived);

    let updated;
    if (newOwner) {
      // Subject, its attendance sessions (active AND trashed) and its alerts
      // change owner together or not at all. All three are keyed by the subject
      // id we just loaded INSIDE this college.
      updated = await runInTransaction(async (session) => {
        const opts = session ? { session } : {};
        subject.teacher = newOwner;
        const saved = await subject.save(opts);
        await scopedModel(Attendance, req.tenant).updateMany({ subjectId: subject._id }, { $set: { teacher: newOwner } }, opts);
        await scopedModel(ConsecutiveAbsenceAlert, req.tenant).updateMany({ subjectId: subject._id }, { $set: { teacherId: newOwner } }, opts);
        return saved;
      });
    } else {
      updated = await subject.save();
    }
    await updated.populate(populateTeacher(req.tenant));
    return sendSuccess(res, { subject: updated.toPublicJSON() }, "Subject updated successfully.");
  } catch (error) {
    if (error.code === 11000) return sendError(res, "Subject code already exists for this teacher.", 409);
    next(error);
  }
};

// ─── DELETE /api/subjects/:id ─────────────────────────────────────────────────
// PERMANENT deletion (not a soft delete / archive). Removes the subject and
// every piece of data that belongs to it — attendance sessions & records
// (active AND trashed), consecutive-absence alerts, etc. — so the subject
// leaves zero trace and zero effect on any future calculation. Credit
// scores, attendance percentages, and dashboard statistics are all derived
// live from Attendance records (see creditUtils/attendanceUtils), so once
// those records are gone the numbers are automatically correct — there is
// no separate cached total that needs a manual recalculation step.
//
// Requires `acknowledged: true` in the request body — the frontend only
// sends this after the teacher has downloaded a backup (PDF/CSV/ZIP) of the
// subject's attendance records and checked the confirmation checkbox. This
// enforces the "mandatory backup before deletion" requirement server-side
// too, not just in the UI.
export const deleteSubject = async (req, res, next) => {
  try {
    const subject = await subjects(req).findById(req.params.id);
    if (!subject) return sendError(res, "Subject not found.", 404);
    if (req.user.role !== "admin" && !isOwnedBy(subject.teacher, req.user.id)) {
      return sendError(res, "Not authorized.", 403);
    }

    if (req.body?.acknowledged !== true) {
      return sendError(
        res,
        "Please download a backup of this subject's attendance records and confirm the acknowledgment checkbox before deleting it permanently.",
        400
      );
    }

    const subjectId = subject._id;
    const subjectName = subject.subjectName;

    const summary = await runInTransaction(async (session) => {
      const opts = session ? { session } : {};

      // Every attendance session for this subject — active AND trashed —
      // must go; a permanently deleted subject must leave no trace even
      // in the trash bin.
      const attendanceResult = await scopedModel(Attendance, req.tenant).deleteMany({ subjectId }, opts);

      // Consecutive-absence alerts reference the subject directly.
      const alertResult = await scopedModel(ConsecutiveAbsenceAlert, req.tenant).deleteMany({ subjectId }, opts);

      const deletedSubject = await subjects(req).findOneAndDelete({ _id: subjectId }, opts);
      if (!deletedSubject) {
        // Subject vanished between our earlier lookup and now — abort so
        // the transaction rolls back the deletes above too.
        throw { status: 404, message: "Subject not found." };
      }

      return {
        deletedAttendanceSessions: attendanceResult.deletedCount || 0,
        deletedAlerts: alertResult.deletedCount || 0,
      };
    });

    return sendSuccess(
      res,
      { deletedId: subjectId, subjectName, ...summary },
      `Subject '${subjectName}' and all related attendance data were permanently deleted.`
    );
  } catch (error) {
    if (error?.status) return sendError(res, error.message, error.status);
    next(error);
  }
};

// ─── GET /api/subjects/meta ───────────────────────────────────────────────────
// Returns dynamic departments, shifts, and attendance categories from DB.
// Nothing here is hardcoded anymore — every value is admin-managed.
export const getSubjectMeta = async (req, res, next) => {
  try {
    const [depts, shiftNames, categoryNames] = await Promise.all([
      scopedModel(Department, req.tenant).find({}).sort({ name: 1 }).lean(),
      getShiftNames(req.tenant),
      getCategoryNames(req.tenant),
    ]);
    return sendSuccess(res, {
      departments: depts.map((d) => d.name),
      shifts: shiftNames,
      creditTypes: categoryNames,
      subjectTypes: categoryNames, // alias — see Subject model comment
      colors: COLORS,
    });
  } catch (err) {
    next(err);
  }
};

// ─── GET /api/subjects/teachers ───────────────────────────────────────────────
// Admin only. The approved teachers of the admin's OWN college — the only
// people a subject can be assigned to. Used by the frontend teacher selector.
export const getAssignableTeachers = async (req, res, next) => {
  try {
    const teachers = await listAssignableTeachers(req.tenant);
    return sendSuccess(res, { teachers, count: teachers.length });
  } catch (err) {
    next(err);
  }
};
