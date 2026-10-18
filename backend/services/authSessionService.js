/**
 * Authentication-session service: turns the (untrusted) claims of a verified
 * JWT into a (trusted) session built from the DATABASE.
 *
 * The token proves only "the server once issued this to user X, at session
 * version N". Everything that decides access — role, approval, college, college
 * status — is re-read from the user/college records on every request, so:
 *   - a stale or forged `role` / `collegeId` / `approved` claim has no effect;
 *   - deleting a user, rejecting them, suspending their college, or bumping
 *     their `authVersion` (see accountSecurityService) takes effect on the very
 *     next request, not when the token expires.
 *
 * Dependency-injected (User, College) so it can be tested without a database.
 */
import { authFailure } from "../utils/authErrors.js";
import { APPROVAL_STATUS, effectiveApprovalStatus, isAccessApproved, isObjectIdString } from "../utils/approval.js";

export const ROLES = Object.freeze({ ADMIN: "admin", TEACHER: "teacher" });
const KNOWN_ROLES = new Set(Object.values(ROLES));

const USER_FIELDS = "name email role approved approvalStatus collegeId authVersion";
const COLLEGE_FIELDS = "collegeId name status";

/** The version a session was issued under; tokens/users from before this feature count as 0. */
export const versionOf = (v) => (Number.isInteger(v) && v >= 0 ? v : 0);

export const createAuthSessionService = ({ User, College, strictCollegeMembership = false }) => {
  /**
   * @param {{ id?: unknown, av?: unknown }} claims  decoded JWT payload (untrusted)
   * @returns {Promise<{ok:true, session:object} | {ok:false, status:number, message:string, code:string}>}
   */
  const resolveSession = async (claims) => {
    // 1. Who? (shape check first, so garbage never reaches the database)
    if (!claims || !isObjectIdString(claims.id)) return authFailure("SESSION_INVALID");

    const user = await User.findById(claims.id).select(USER_FIELDS).lean();
    if (!user) return authFailure("SESSION_INVALID"); // deleted account

    // 2. Is this token generation still valid? (revocation)
    if (versionOf(claims.av) !== versionOf(user.authVersion)) return authFailure("SESSION_INVALID");

    // 3. Current role — from the record, never from the token.
    if (!KNOWN_ROLES.has(user.role)) return authFailure("FORBIDDEN");

    // 4. Current account status (admins too).
    if (!isAccessApproved(user)) {
      return authFailure(effectiveApprovalStatus(user) === APPROVAL_STATUS.REJECTED ? "ACCOUNT_REJECTED" : "ACCOUNT_PENDING");
    }

    // 5. Current college membership + college status.
    const collegeId = user.collegeId ? String(user.collegeId) : null;
    let college = null;
    if (collegeId) {
      const row = await College.findOne({ collegeId }).select(COLLEGE_FIELDS).lean();
      if (!row) return authFailure("COLLEGE_UNAVAILABLE");
      if (row.status !== "active") return authFailure("COLLEGE_SUSPENDED");
      college = { collegeId: row.collegeId, name: row.name, status: row.status };
    } else if (strictCollegeMembership) {
      return authFailure("NO_COLLEGE");
    }

    const session = Object.freeze({
      userId: String(user._id),
      name: user.name,
      email: user.email,
      role: user.role,
      isAdmin: user.role === ROLES.ADMIN,
      isTeacher: user.role === ROLES.TEACHER,
      approvalStatus: effectiveApprovalStatus(user),
      authVersion: versionOf(user.authVersion),
      // null = legacy account not yet assigned to a college (see docs/PART_AUTH_SECURITY.md).
      collegeId,
      college,
    });
    return { ok: true, session };
  };

  return { resolveSession };
};
