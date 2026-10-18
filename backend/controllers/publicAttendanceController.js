/**
 * Public "See Your Attendance" lookup — NO login, NO admin privileges.
 *
 *   POST /api/public/attendance/lookup
 *   body { collegeId, department, batch, shift, roll }
 *
 * Because the endpoint is public, safety comes from scoping, not from a session:
 *
 *  1. `collegeId` is only a CHOICE made from the public college search. It is
 *     format-checked, then resolved against an ACTIVE College on the server; an
 *     unknown / inactive / malformed id is a 404 identical to "no such student".
 *  2. The student is found ONLY by (collegeId, department, batch, shift, roll)
 *     among active students — never by a client-supplied student id or Mongo _id
 *     (those fields in the body are ignored). Roll numbers repeat across colleges
 *     (and across groups), so the college is part of every query.
 *  3. If more than one active student still matches (e.g. two departments that
 *     differ only by letter case) the answer is a generic 409: nothing is guessed
 *     and no record is disclosed.
 *  4. Analytics are computed through scopedModel with the SERVER-resolved
 *     tenant, so another college's sessions with the same registration number can
 *     never be added in.
 *  5. The response is an explicit whitelist (see toPublicStudent / toPublicStats):
 *     no _id, studentId, email, uploader, teacher names/emails, alert history,
 *     subject/teacher ids or notes.
 *
 * Every "not found" reason (bad college, wrong department/batch/shift, wrong roll,
 * deactivated student) returns the SAME 404 message, so the endpoint cannot be used
 * to learn which part of a guess was right.
 */
import College from "../models/College.js";
import Student from "../models/Student.js";
import { sendSuccess, sendError } from "../utils/response.js";
import { validateLookupInput } from "../validators/publicLookupValidator.js";
import { exactNameMatch } from "../utils/academicNames.js";
import { scopedModel } from "../utils/tenantScope.js";
import { computeStudentAnalytics } from "../utils/studentAnalytics.js";

export const NOT_FOUND_MESSAGE =
  "We couldn't find a student with those details. Check the college, department, batch, shift and roll, then try again.";
export const AMBIGUOUS_MESSAGE =
  "More than one record matches these details. Please contact your college office to get your attendance.";

/** Whitelisted student fields. */
export const toPublicStudent = (s) => ({
  name: s.name,
  roll: s.roll,
  department: s.department,
  batch: s.batch,
  shift: s.shift,
});

/** Whitelisted analytics: counts and percentages only. No ids. */
export const toPublicStats = ({ academicStats, subjectStats }) => ({
  academicStats: {
    totalSubjects: academicStats.totalSubjects,
    totalClasses: academicStats.totalClasses,
    totalAttended: academicStats.totalAttended,
    totalMissed: academicStats.totalMissed,
    overallPercentage: academicStats.overallPercentage,
    creditScore: academicStats.creditScore,
    creditScoreBreakdown: (academicStats.creditScoreBreakdown || []).map((b) => ({ ...b })),
    status: academicStats.status,
  },
  subjectStats: subjectStats.map((s) => ({
    subjectName: s.subjectName,
    subjectCode: s.subjectCode,
    totalClasses: s.totalClasses,
    attended: s.attended,
    missed: s.missed,
    attendancePercentage: s.attendancePercentage,
  })),
});

/** Factory so tests can inject fakes; production wiring is the default export. */
export const createLookupAttendance = ({ CollegeModel = College, StudentModel = Student } = {}) => async (req, res, next) => {
  try {
    res.set("Cache-Control", "no-store"); // personal data: never cached by browsers/proxies

    const parsed = validateLookupInput(req.body);
    if (!parsed.ok) {
      return res.status(400).json({ success: false, message: "Please correct the highlighted fields.", errors: parsed.errors });
    }
    const { collegeId, department, batch, shift, roll } = parsed.values;

    // 1. Resolve the chosen college to a real, active collegeId on the server.
    // (collegeId already matched the strict COL-… pattern, so it is a plain string here.)
    const college = await CollegeModel.findOne({ collegeId, status: "active" })
      .select("collegeId name district country")
      .lean();
    if (!college) return sendError(res, NOT_FOUND_MESSAGE, 404);
    const tenant = { collegeId: college.collegeId };

    // 2. Find the student INSIDE that college, by academic scope + roll only.
    const matches = await scopedModel(StudentModel, tenant)
      .find({
        isActive: true,
        roll,
        department: exactNameMatch(department),
        batch: exactNameMatch(batch),
        shift: exactNameMatch(shift),
      }, { lean: true })
      .limit(2);

    if (matches.length === 0) return sendError(res, NOT_FOUND_MESSAGE, 404);
    if (matches.length > 1) return sendError(res, AMBIGUOUS_MESSAGE, 409);
    const student = matches[0];

    // Defence in depth: the record must carry exactly the tenant's college.
    if ((student.collegeId ?? null) !== tenant.collegeId) return sendError(res, NOT_FOUND_MESSAGE, 404);

    // 3. Same analytics as the admin student page, scoped to this college only.
    const analytics = await computeStudentAnalytics(tenant, student);

    return sendSuccess(res, {
      college: { name: college.name, district: college.district ?? "", country: college.country ?? "" },
      student: toPublicStudent(student),
      ...toPublicStats(analytics),
    }, "Attendance fetched.");
  } catch (err) {
    next(err);
  }
};

export const lookupAttendance = createLookupAttendance();
