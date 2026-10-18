/**
 * Ownership checks for analytics about ONE specific thing.
 *
 * Before any statistic is generated for a particular student or teacher the
 * thing must be proven to belong to the caller's college. An id from another
 * college, an unknown id and a malformed id all return `null`, so the caller can
 * answer one identical 404 and nobody can learn whether the other college has
 * that student or teacher. (Subjects are covered by middleware/teacherMiddleware.js
 * `requireSubjectOwner`, which does the same for every /:subjectId route.)
 *
 * The college is always `tenant.collegeId` (from req.tenant, i.e. the database
 * session) — never a request value.
 */
import Student from "../models/Student.js";
import User from "../models/User.js";
import { scopedModel } from "./tenantScope.js";
import { isObjectIdString } from "./approval.js";

/** Registration numbers are short free text; reject anything that is not a plain, bounded string. */
const isPlainId = (v) => typeof v === "string" && v.trim().length > 0 && v.length <= 64;

/**
 * The student with this registration number in the caller's college, or null.
 * An ACTIVE student wins when an old, removed record reused the same number.
 */
export const findOwnedStudent = async (tenant, studentId, { StudentModel = Student } = {}) => {
  if (!isPlainId(studentId)) return null;
  const students = scopedModel(StudentModel, tenant);
  const active = await students.findOne({ studentId, isActive: true }, { lean: true });
  return active || students.findOne({ studentId }, { lean: true });
};

/** The teacher (role "teacher") with this id in the caller's college, or null. */
export const findOwnedTeacher = async (tenant, teacherId, { UserModel = User } = {}) => {
  if (typeof teacherId !== "string" || !isObjectIdString(teacherId)) return null;
  const user = await scopedModel(UserModel, tenant).findById(teacherId, { lean: true });
  return user && user.role === "teacher" ? user : null;
};
