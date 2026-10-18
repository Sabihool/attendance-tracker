/**
 * Per-student attendance analytics, shared by the admin student page
 * (GET /api/alerts/student/:id/analytics) and the public "See Your Attendance"
 * lookup (POST /api/public/attendance/lookup).
 *
 * SCOPING CONTRACT: `tenant` is { collegeId } resolved by the SERVER (from the
 * session for admins, from a validated active College for the public lookup),
 * and `student` is a record already proven to belong to that college. Every
 * query goes through scopedModel, so student ids that repeat across colleges can
 * never mix. Subjects whose own collegeId differs from the tenant are skipped as
 * a second line of defence.
 */
import Attendance from "../models/Attendance.js";
import { getCategoryMaps, calculateCreditScore } from "./creditUtils.js";
import { scopedModel } from "./tenantScope.js";

export const statusFromPercentage = (pct) => {
  if (pct < 50) return "Critical";
  if (pct < 65) return "Warning";
  if (pct < 75) return "Good";
  return "Excellent";
};

/** @returns {{ academicStats: object, subjectStats: object[] }} */
export const computeStudentAnalytics = async (tenant, student, { AttendanceModel = Attendance } = {}) => {
  const studentId = student.studentId;

  const allRecords = await scopedModel(AttendanceModel, tenant).find({
    isDeleted: false,
    "students.studentId": studentId,
  })
    .populate("subjectId", "subjectName subjectCode creditType credits department batch collegeId")
    .sort({ date: -1 })
    .lean();

  const { creditMap, nameMap } = await getCategoryMaps(tenant);

  const subjectMap = new Map();
  for (const record of allRecords) {
    const subDoc = record.subjectId; // populated
    if (!subDoc) continue;
    if ((subDoc.collegeId ?? null) !== (tenant.collegeId ?? null)) continue; // never count a foreign subject

    const studentEntry = record.students.find((s) => s.studentId === studentId);
    if (!studentEntry) continue;

    // Total/attended are plain counts of sessions (credit weighting only affects creditScore).
    const subKey = subDoc._id.toString();
    if (!subjectMap.has(subKey)) {
      subjectMap.set(subKey, {
        subjectId: subDoc._id,
        subjectName: subDoc.subjectName,
        subjectCode: subDoc.subjectCode,
        creditType: subDoc.creditType,
        credits: subDoc.credits,
        department: subDoc.department,
        batch: subDoc.batch,
        totalClasses: 0,
        attended: 0,
        missed: 0,
      });
    }
    const sub = subjectMap.get(subKey);
    sub.totalClasses += 1;
    if (studentEntry.status === "present") sub.attended += 1;
    else sub.missed += 1;
  }

  const subjectStats = Array.from(subjectMap.values()).map((sub) => ({
    ...sub,
    attendancePercentage: sub.totalClasses > 0 ? Math.round((sub.attended / sub.totalClasses) * 100) : 0,
  }));

  const totalClasses = subjectStats.reduce((s, x) => s + x.totalClasses, 0);
  const totalAttended = subjectStats.reduce((s, x) => s + x.attended, 0);
  const totalMissed = subjectStats.reduce((s, x) => s + x.missed, 0);
  const overallPercentage = totalClasses > 0 ? Math.round((totalAttended / totalClasses) * 100) : 0;

  const { creditScore, breakdown: creditScoreBreakdown } = calculateCreditScore(allRecords, studentId, { creditMap, nameMap });

  return {
    academicStats: {
      totalSubjects: subjectStats.length,
      totalClasses,
      totalAttended,
      totalMissed,
      overallPercentage,
      creditScore,
      creditScoreBreakdown,
      status: statusFromPercentage(overallPercentage),
    },
    subjectStats,
  };
};
