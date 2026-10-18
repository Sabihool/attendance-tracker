import Attendance from "../models/Attendance.js";
import Student from "../models/Student.js";
import User from "../models/User.js";
import { sendSuccess, sendError } from "../utils/response.js";
import { checkAndCreateAlerts } from "./alertsController.js";
import { getCategoryCreditMap, findCategoryByName, resolveCreditValue } from "../utils/creditUtils.js";
import { scopedModel } from "../utils/tenantScope.js";
import { sameName, exactNameMatch } from "../utils/academicNames.js";
import { logSecurityEvent } from "../utils/securityLog.js";

// ─── COLLEGE SCOPING (Part 12) ────────────────────────────────────────────────
// Attendance sessions carry their own collegeId. Every read, update and delete
// goes through scopedModel(Attendance, req.tenant), where req.tenant is built
// from the caller's database session (never from the request), and every create
// stamps that college. A session is only recorded after the subject, the
// teacher, every student (and so the batch) and the category have all been
// proven to belong to the caller's college — see validateSessionOwnership().
// The credit rules and percentage formulas below are unchanged.
const attendanceOf = (req) => scopedModel(Attendance, req.tenant);

/**
 * Prove that everything a new session points at belongs to the caller's college
 * and return the canonical student rows to store.
 *
 *   subject  — req.subject was loaded by requireSubjectOwner inside the college;
 *              re-checked here so this function is safe on its own.
 *   teacher  — the subject's assigned teacher must be a user of the same college.
 *   student  — every studentId must be an ACTIVE student of this college, and
 *   batch      of the subject's own department / batch / shift group (a roster
 *              of another batch, department or college is refused). Name and
 *              roll are taken from the student record, not from the request.
 *
 * @returns {Promise<{ok:true, students:Array}|{ok:false, status:number, message:string}>}
 */
export const validateSessionOwnership = async (tenant, subject, submitted) => {
  if (!subject || (subject.collegeId ?? null) !== (tenant.collegeId ?? null)) {
    return { ok: false, status: 404, message: "Subject not found." };
  }

  const teacher = await scopedModel(User, tenant).findById(String(subject.teacher), { lean: true });
  if (!teacher) {
    return { ok: false, status: 400, message: "This subject's teacher does not belong to your college." };
  }

  const ids = submitted.map((s) => s.studentId.trim());
  if (new Set(ids).size !== ids.length) {
    return { ok: false, status: 400, message: "Each student can appear only once in a session." };
  }

  const found = await scopedModel(Student, tenant).find({ studentId: { $in: ids }, isActive: true }, { lean: true });
  const byId = new Map(found.map((st) => [st.studentId, st]));
  const canonical = [];
  for (let i = 0; i < submitted.length; i++) {
    const st = byId.get(ids[i]);
    // Unknown id and "another college's student" are deliberately indistinguishable.
    if (!st) return { ok: false, status: 400, message: `students[${i}]: student "${ids[i]}" was not found in your college.` };
    if (
      !sameName(st.department, subject.department) ||
      !sameName(st.batch, subject.batch) ||
      !sameName(st.shift, subject.shift)
    ) {
      return { ok: false, status: 400, message: `students[${i}]: student "${ids[i]}" is not in this subject's department, batch and shift.` };
    }
    canonical.push({ studentId: st.studentId, roll: st.roll, name: st.name, status: submitted[i].status });
  }
  return { ok: true, students: canonical };
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Parse a date string into a UTC midnight Date object.
 * Accepts "YYYY-MM-DD" format.
 */
const parseDate = (dateStr) => {
  const match = /^\d{4}-\d{2}-\d{2}$/.test(dateStr);
  if (!match) return null;
  const d = new Date(dateStr + "T00:00:00.000Z");
  return isNaN(d.getTime()) ? null : d;
};

/**
 * Calculate attendance percentage for a student across all sessions.
 *
 * Rules:
 *  - Each session's classWeight (its snapshotted credit value) is the number
 *    of "classes" that session counts as.
 *  - Percentage = (weighted present) / (total weighted classes) × 100
 *
 * @param {Array} records - Array of Attendance documents
 * @param {string} studentId - The student's ID
 * @param {Object} [creditMap] - Fallback { categoryName: credit } map for
 *   legacy records that predate the classWeight snapshot.
 * @returns {{ attended: number, total: number, percentage: number }}
 */
export const calcStudentPercentage = (records, studentId, creditMap = {}) => {
  let totalWeight = 0;
  let attendedWeight = 0;

  for (const record of records) {
    const weight = record.classWeight ?? creditMap[record.classType?.toLowerCase()] ?? 1;
    const studentEntry = record.students.find((s) => s.studentId === studentId);

    if (studentEntry) {
      totalWeight += weight;
      if (studentEntry.status === "present") {
        attendedWeight += weight;
      }
    }
  }

  const percentage =
    totalWeight > 0 ? Math.round((attendedWeight / totalWeight) * 100) : 0;

  return {
    attended: attendedWeight,
    total: totalWeight,
    percentage,
  };
};

/**
 * Aggregate attendance stats for a subject across all sessions.
 *
 * Returns per-student breakdown with weighted percentage.
 *
 * @param {Array} records - Array of Attendance documents
 * @param {Object} [creditMap] - Fallback credit map (see calcStudentPercentage)
 * @returns {Array} Array of { studentId, roll, name, attended, total, percentage }
 */
const aggregateSubjectStats = (records, creditMap = {}) => {
  const studentMap = new Map();

  for (const record of records) {
    const weight = record.classWeight ?? creditMap[record.classType?.toLowerCase()] ?? 1;

    for (const s of record.students) {
      if (!studentMap.has(s.studentId)) {
        studentMap.set(s.studentId, {
          studentId: s.studentId,
          roll: s.roll,
          name: s.name,
          attended: 0,
          total: 0,
        });
      }

      const entry = studentMap.get(s.studentId);
      entry.total += weight;
      if (s.status === "present") {
        entry.attended += weight;
      }
    }
  }

  return Array.from(studentMap.values()).map((entry) => ({
    ...entry,
    percentage:
      entry.total > 0 ? Math.round((entry.attended / entry.total) * 100) : 0,
  }));
};

// ─── POST /api/attendance/:subjectId ──────────────────────────────────────────
/**
 * Save (create) a new attendance record for a subject session.
 *
 * Body: { date, classType, students[], note?, creditValue? }
 *   - classType   — an admin-defined attendance category name (e.g. "Theory")
 *   - creditValue — optional teacher override of that category's credit value
 *                   for THIS session only (auto-filled from the category if
 *                   omitted)
 *
 * Requires: protect + requireApproved + authorize("teacher","admin") + requireSubjectOwner
 */
export const saveAttendance = async (req, res, next) => {
  try {
    const { subjectId } = req.params;
    const { date, classType, students, note, creditValue } = req.body;

    const missing = [];
    if (!date) missing.push("date");
    if (!classType) missing.push("classType");
    if (!students) missing.push("students");

    if (missing.length > 0) {
      return sendError(res, `Missing required fields: ${missing.join(", ")}`, 400);
    }

    const parsedDate = parseDate(date);
    if (!parsedDate) {
      return sendError(res, "Invalid date format. Use YYYY-MM-DD.", 400);
    }

    const today = new Date();
    today.setUTCHours(23, 59, 59, 999);
    if (parsedDate > today) {
      return sendError(res, "Cannot record attendance for a future date.", 400);
    }

    if (typeof classType !== "string") {
      return sendError(res, "classType must be a string.", 400);
    }

    // ── Validate classType against THIS COLLEGE's admin-managed categories ────
    // (another college's category of the same name is not visible here)
    const category = await findCategoryByName(req.tenant, classType);
    if (!category) {
      return sendError(
        res,
        `Invalid attendance category "${classType}". Ask an admin to add it in Settings.`,
        400
      );
    }

    if (creditValue !== undefined && creditValue !== null && creditValue !== "") {
      const n = Number(creditValue);
      if (Number.isNaN(n) || n < 0 || n > 20) {
        return sendError(res, "Credit value must be a number between 0 and 20.", 400);
      }
    }

    if (!Array.isArray(students) || students.length === 0) {
      return sendError(res, "students must be a non-empty array.", 400);
    }

    const validStatuses = ["present", "absent"];

    for (let i = 0; i < students.length; i++) {
      const s = students[i];
      if (!s || typeof s !== "object") {
        return sendError(res, `students[${i}] must be an object.`, 400);
      }
      if (!s.studentId || typeof s.studentId !== "string") {
        return sendError(res, `students[${i}].studentId is required.`, 400);
      }
      if (!s.roll || typeof s.roll !== "string") {
        return sendError(res, `students[${i}].roll is required.`, 400);
      }
      if (!s.name || typeof s.name !== "string") {
        return sendError(res, `students[${i}].name is required.`, 400);
      }
      if (!validStatuses.includes(s.status)) {
        return sendError(
          res,
          `students[${i}].status must be 'present' or 'absent'.`,
          400
        );
      }
    }

    // ── Same-college proof (Part 12): subject, teacher, students/batch ────────
    const subjectDoc = req.subject;
    const owned = await validateSessionOwnership(req.tenant, subjectDoc, students);
    if (!owned.ok) {
      logSecurityEvent("attendance_ownership_refused", { reason: owned.message, user: req.tenant.userId, subjectId });
      return sendError(res, owned.message, owned.status);
    }

    // ── Duplicate check: same subject + date + classType (active only) ────────
    // Part 19: Only check non-deleted records (soft-delete coexistence)
    const exists = await attendanceOf(req).findOne({
      subjectId: subjectDoc._id,
      date: parsedDate,
      classType: category.name,
      isDeleted: false,
    });

    if (exists) {
      return sendError(
        res,
        `Attendance for this subject on ${date} (${category.name}) already exists. Use update if you want to modify it.`,
        409
      );
    }

    const resolvedWeight = resolveCreditValue(category, creditValue);

    // collegeId is stamped by scopedModel.create from req.tenant (anything a
    // client sent for it was already stripped, and would be overwritten anyway).
    const attendance = await attendanceOf(req).create({
      subjectId: subjectDoc._id,
      teacher: req.tenant.userId,
      date: parsedDate,
      classType: category.name,
      classWeight: resolvedWeight,
      students: owned.students,
      note: typeof note === "string" ? note.trim() : "",
    });

    // ── Auto-check for consecutive absences ───────────────────────────────────
    // subjectDoc was loaded by requireSubjectOwner INSIDE the caller's college.
    checkAndCreateAlerts(subjectDoc, owned.students, req.tenant.userId, req.tenant).catch(() => {});

    return sendSuccess(
      res,
      { attendance: attendance.toPublicJSON() },
      "Attendance saved successfully.",
      201
    );
  } catch (error) {
    if (error.code === 11000) {
      return sendError(
        res,
        "Attendance for this subject, date, and class type already exists.",
        409
      );
    }
    next(error);
  }
};

// ─── GET /api/attendance/:subjectId ──────────────────────────────────────────
/**
 * Get all ACTIVE (non-deleted) attendance records for a subject.
 * Supports optional filters: ?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD&classType=theory
 *
 * Part 19: Excludes soft-deleted records (isDeleted: false).
 *
 * Requires: protect + requireApproved + authorize("teacher","admin") + requireSubjectOwner
 */
export const getAttendance = async (req, res, next) => {
  try {
    const { subjectId } = req.params;
    const { startDate, endDate, classType } = req.query;

    // ── Part 19: Always filter out deleted records ────────────────────────────
    const filter = { subjectId, isDeleted: false };

    if (startDate || endDate) {
      filter.date = {};
      if (startDate) {
        const start = parseDate(startDate);
        if (!start) return sendError(res, "Invalid startDate format. Use YYYY-MM-DD.", 400);
        filter.date.$gte = start;
      }
      if (endDate) {
        const end = parseDate(endDate);
        if (!end) return sendError(res, "Invalid endDate format. Use YYYY-MM-DD.", 400);
        end.setUTCHours(23, 59, 59, 999);
        filter.date.$lte = end;
      }
    }

    if (typeof classType === "string" && classType) {
      filter.classType = exactNameMatch(classType); // escaped: category names are free text
    }

    // The sessions and the college's credit map are independent reads: run together.
    const [records, creditMap] = await Promise.all([
      attendanceOf(req).find(filter).sort({ date: -1 }).lean(),
      getCategoryCreditMap(req.tenant),
    ]);

    const totalWeightedClasses = records.reduce(
      (sum, r) => sum + (r.classWeight ?? creditMap[r.classType?.toLowerCase()] ?? 1),
      0
    );

    const studentStats = aggregateSubjectStats(records, creditMap);

    const overallAverage =
      studentStats.length > 0
        ? Math.round(
            studentStats.reduce((sum, s) => sum + s.percentage, 0) /
              studentStats.length
          )
        : 0;

    return sendSuccess(
      res,
      {
        records,
        meta: {
          totalSessions: records.length,
          totalWeightedClasses,
          overallAveragePercentage: overallAverage,
          studentStats,
        },
      },
      "Attendance fetched successfully."
    );
  } catch (error) {
    next(error);
  }
};

// ─── GET /api/attendance/:subjectId/dates ─────────────────────────────────────
/**
 * Part of the "Edit Attendance" flow (spec section 6, step 2).
 * Lists every active attendance date for a subject along with that day's
 * present percentage, so the teacher can pick a date to open and edit.
 *
 * Requires: protect + requireApproved + authorize("teacher","admin") + requireSubjectOwner
 */
export const getAttendanceDates = async (req, res, next) => {
  try {
    const { subjectId } = req.params;

    const records = await attendanceOf(req).find({ subjectId, isDeleted: false })
      .sort({ date: -1 })
      .select("date classType classWeight summary")
      .lean();

    const dates = records.map((r) => ({
      sessionId: r._id,
      date: r.date,
      classType: r.classType,
      classWeight: r.classWeight,
      totalStudents: r.summary?.totalStudents ?? 0,
      presentCount: r.summary?.presentCount ?? 0,
      absentCount: r.summary?.absentCount ?? 0,
      percentage:
        r.summary?.totalStudents > 0
          ? Math.round((r.summary.presentCount / r.summary.totalStudents) * 100)
          : 0,
    }));

    return sendSuccess(res, { dates, count: dates.length }, "Attendance dates fetched successfully.");
  } catch (error) {
    next(error);
  }
};

// ─── GET /api/attendance/:subjectId/session/:id ───────────────────────────────
/**
 * Get a single active attendance session by ID.
 *
 * Requires: protect + requireApproved + authorize("teacher","admin") + requireSubjectOwner
 */
export const getAttendanceById = async (req, res, next) => {
  try {
    const attendance = req.attendance;
    return sendSuccess(
      res,
      { attendance: attendance.toPublicJSON() },
      "Attendance record fetched successfully."
    );
  } catch (error) {
    next(error);
  }
};

// ─── PUT /api/attendance/:subjectId/session/:id ───────────────────────────────
/**
 * "Edit Attendance" flow (spec section 6, steps 3–4): mark an absent student
 * present, a present student absent, and save. Statistics recompute
 * automatically because they're always derived live from the records.
 *
 * Body: { students: [{ studentId, status }], note? }
 * Only status changes for students already on the record are applied —
 * this endpoint edits an existing session, it does not add/remove students.
 *
 * Requires: protect + requireApproved + authorize("teacher","admin")
 *           + requireSubjectOwner + requireAttendanceOwner
 */
export const updateAttendance = async (req, res, next) => {
  try {
    const attendance = req.attendance; // attached by requireAttendanceOwner (inside the caller's college)
    const { students, note } = req.body;

    // Belt and braces: the session being edited must be of the caller's college.
    if ((attendance.collegeId ?? null) !== (req.tenant.collegeId ?? null)) {
      logSecurityEvent("resource_not_in_tenant", { resource: "attendance", user: req.tenant.userId });
      return sendError(res, "Attendance record not found or has been deleted.", 404);
    }

    if (students !== undefined) {
      if (!Array.isArray(students) || students.length === 0) {
        return sendError(res, "students must be a non-empty array.", 400);
      }

      const validStatuses = ["present", "absent"];
      const byId = new Map(attendance.students.map((s) => [s.studentId, s]));

      for (let i = 0; i < students.length; i++) {
        const update = students[i];
        if (!update || typeof update !== "object" || !update.studentId) {
          return sendError(res, `students[${i}].studentId is required.`, 400);
        }
        if (!validStatuses.includes(update.status)) {
          return sendError(res, `students[${i}].status must be 'present' or 'absent'.`, 400);
        }
        const existing = byId.get(update.studentId);
        if (!existing) {
          return sendError(
            res,
            `Student "${update.studentId}" is not part of this attendance session.`,
            404
          );
        }
        existing.status = update.status;
      }

      attendance.markModified("students");
    }

    if (note !== undefined) {
      attendance.note = String(note).trim();
    }

    await attendance.save();

    // ── Editing statuses can change consecutive-absence counts, so re-check ───
    const subjectDoc = req.subject; // same college-scoped subject the guard loaded
    if (subjectDoc) {
      checkAndCreateAlerts(subjectDoc, attendance.students, attendance.teacher.toString(), req.tenant).catch(() => {});
    }

    return sendSuccess(
      res,
      { attendance: attendance.toPublicJSON() },
      "Attendance updated successfully."
    );
  } catch (error) {
    next(error);
  }
};

// ─── GET /api/attendance/:subjectId/percentage ────────────────────────────────
/**
 * Get attendance percentage for all students in a subject.
 * Part 19: Only counts active (non-deleted) records.
 *
 * Requires: protect + requireApproved + authorize("teacher","admin") + requireSubjectOwner
 */
export const getAttendancePercentage = async (req, res, next) => {
  try {
    const { subjectId } = req.params;
    const { studentId } = req.query;

    // Part 19: Exclude deleted records from percentage calculation
    const [records, creditMap] = await Promise.all([
      attendanceOf(req).find({ subjectId, isDeleted: false }).lean(),
      getCategoryCreditMap(req.tenant),
    ]);

    if (records.length === 0) {
      return sendSuccess(
        res,
        { studentStats: [], totalWeightedClasses: 0 },
        "No attendance records found for this subject."
      );
    }

    const totalWeightedClasses = records.reduce(
      (sum, r) => sum + (r.classWeight ?? creditMap[r.classType?.toLowerCase()] ?? 1),
      0
    );

    if (studentId) {
      const stats = calcStudentPercentage(records, studentId, creditMap);

      if (stats.total === 0) {
        return sendError(res, "Student not found in attendance records.", 404);
      }

      return sendSuccess(
        res,
        {
          studentId,
          ...stats,
          totalWeightedClasses,
          note: "Each session's credit weight (auto-filled from its attendance category, admin-configurable) counts towards attendance weight.",
        },
        "Student attendance percentage calculated."
      );
    }

    const studentStats = aggregateSubjectStats(records, creditMap);

    const overallAverage =
      studentStats.length > 0
        ? Math.round(
            studentStats.reduce((sum, s) => sum + s.percentage, 0) /
              studentStats.length
          )
        : 0;

    return sendSuccess(
      res,
      {
        studentStats,
        totalWeightedClasses,
        overallAveragePercentage: overallAverage,
        totalSessions: records.length,
        note: "Each session's credit weight (auto-filled from its attendance category, admin-configurable) counts towards attendance weight.",
      },
      "Attendance percentage calculated."
    );
  } catch (error) {
    next(error);
  }
};
