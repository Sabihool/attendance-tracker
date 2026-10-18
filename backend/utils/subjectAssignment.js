/**
 * Teacher ↔ subject assignment rules (Part 11).
 *
 * A subject's `teacher` field is its assignment: that teacher takes attendance
 * for it, sees its alerts and trash, and is the owner for every permission
 * check. These helpers decide who may be assigned, always from the DATABASE and
 * always inside the caller's college:
 *
 *   - the teacher must exist in the SAME college as the acting admin;
 *   - must have the `teacher` role (an admin account is not assignable);
 *   - must be fully approved (`approved` + `approvalStatus`, see utils/approval.js).
 *
 * A teacher id of another college is answered exactly like an id that does not
 * exist, so the API cannot be used to discover who works at another college.
 *
 * Pure of HTTP; the User model is injectable for tests.
 */
import User from "../models/User.js";
import { scopedModel } from "./tenantScope.js";
import { isAccessApproved, isObjectIdString } from "./approval.js";

const fail = (status, message, code) => ({ ok: false, status, message, code });

/**
 * @param {{collegeId: string|null}} tenant  req.tenant of the acting admin
 * @param {unknown} teacherId                value from the request body (untrusted)
 * @returns {Promise<{ok:true, teacher:object} | {ok:false, status:number, message:string, code:string}>}
 */
export const resolveAssignableTeacher = async (tenant, teacherId, UserModel = User) => {
  if (typeof teacherId !== "string" || !isObjectIdString(teacherId)) {
    return fail(400, "Invalid teacher.", "INVALID_TEACHER");
  }
  const teacher = await scopedModel(UserModel, tenant).findById(teacherId, { lean: true });
  if (!teacher) return fail(400, "Teacher not found in your college.", "TEACHER_NOT_IN_COLLEGE");
  if (teacher.role !== "teacher") return fail(400, "Subjects can only be assigned to teachers.", "NOT_A_TEACHER");
  if (!isAccessApproved(teacher)) return fail(400, "Only approved teachers can be assigned subjects.", "TEACHER_NOT_APPROVED");
  return { ok: true, teacher };
};

/** Approved teachers of the tenant's college — what an admin may pick from. */
export const listAssignableTeachers = async (tenant, UserModel = User) => {
  const rows = await scopedModel(UserModel, tenant)
    .find({ role: "teacher", approved: true })
    .select("name email department role approved approvalStatus")
    .sort({ name: 1 })
    .lean();
  return rows
    .filter(isAccessApproved)
    .map((t) => ({ _id: t._id, name: t.name, email: t.email, department: t.department || "" }));
};

/**
 * Mongoose `populate` options for a subject's teacher. The `match` means a
 * teacher record from ANOTHER college (corrupted or hand-edited data) is shown
 * as `null` instead of leaking that person's name and email.
 */
export const populateTeacher = (tenant, select = "name email department") => ({
  path: "teacher",
  select,
  match: { collegeId: tenant.collegeId },
});
