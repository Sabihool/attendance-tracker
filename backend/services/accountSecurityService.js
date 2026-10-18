/**
 * Privileged account operations: role changes, college-membership changes and
 * forced sign-out. This is the ONE sanctioned place that changes `role`,
 * `collegeId` or `authVersion` on an existing account — no controller should
 * `$set` those fields itself.
 *
 * Result convention matches the other services:
 *   { ok:true, status, message, data } | { ok:false, status, message, code }
 *
 * Every successful change bumps User.authVersion, which makes every token issued
 * before the change fail on its next request (see authSessionService).
 *
 * HTTP exposure (Part 15): ONLY `changeRole` is reachable, through the college
 * admin routes PATCH /api/admin/teachers/:id/promote|demote. Those routes read
 * the target from the URL and the new role from the ROUTE (never the body), and
 * pass the acting admin's trusted session. `changeCollegeMembership` and
 * `revokeSessions` remain operator-only — a college admin must never be able to
 * move accounts between colleges.
 *
 * Role-change policy (enforced here, in one place):
 *   - actor must be an admin of a REAL college; target must be in that same college;
 *   - nobody changes their own role;
 *   - only approved, active accounts take part;
 *   - the college's FOUNDING admin (College.createdBy) can never be demoted
 *     through the API — only operator tooling can change that;
 *   - a college always keeps at least one active admin (also under races);
 *   - the only roles that exist are 'admin' (this college) and 'teacher'. There is
 *     no platform-wide role, so promotion can never create a super administrator.
 */
import { isAccessApproved, isObjectIdString } from "../utils/approval.js";
import { logSecurityEvent } from "../utils/securityLog.js";
import { ROLES } from "./authSessionService.js";

const fail = (status, message, code) => ({ ok: false, status, message, code });
const ok = (data, message = "Success", status = 200) => ({ ok: true, status, message, data });
const NOT_FOUND = () => fail(404, "User not found.", "NOT_FOUND");
const KNOWN_ROLES = new Set(Object.values(ROLES));
const FIELDS = "name email role approved approvalStatus collegeId authVersion";

export const createAccountSecurityService = ({ User, College, log = logSecurityEvent }) => {
  /** Active admins of a college (the people who can still run it). */
  const countActiveAdmins = (collegeId) =>
    User.countDocuments({ role: ROLES.ADMIN, collegeId, approved: true, approvalStatus: { $nin: ["pending", "rejected"] } });

  const publicView = (u) => ({ id: String(u._id), name: u.name, email: u.email, role: u.role, collegeId: u.collegeId ?? null });

  // ── Force sign-out everywhere ───────────────────────────────────────────────
  const revokeSessions = async (userId, { by = "system" } = {}) => {
    if (!isObjectIdString(userId)) return NOT_FOUND();
    const u = await User.findOneAndUpdate({ _id: userId }, { $inc: { authVersion: 1 } }, { new: true }).select(FIELDS).lean();
    if (!u) return NOT_FOUND();
    log("sessions_revoked", { target: String(userId), by });
    return ok({ authVersion: u.authVersion }, "All sessions for this account were signed out.");
  };

  // ── Role change (college admin acting on their own college) ─────────────────
  /**
   * @param actor   the trusted req.auth session of the acting admin
   * @param targetId  user to change
   * @param newRole  'admin' | 'teacher'
   */
  const changeRole = async (actor, targetId, newRole) => {
    if (!actor || actor.role !== ROLES.ADMIN) return fail(403, "You do not have permission to perform this action.", "FORBIDDEN");
    if (!KNOWN_ROLES.has(newRole)) return fail(400, "Invalid role.", "BAD_ROLE");
    if (!isObjectIdString(targetId)) return NOT_FOUND();
    if (String(targetId) === actor.userId) return fail(403, "You cannot change your own role.", "SELF_CHANGE");
    // Role management only makes sense inside a real college. A legacy account with no
    // college would otherwise share one "null" pool with every other unassigned account.
    if (!actor.collegeId) return fail(403, "Your account is not assigned to a college.", "NO_COLLEGE");

    // Target must be in the ACTOR'S college (anything else looks like "does not exist").
    const target = await User.findOne({ _id: targetId, collegeId: actor.collegeId }).select(FIELDS).lean();
    if (!target) return NOT_FOUND();
    if (!KNOWN_ROLES.has(target.role)) return fail(409, "This account cannot be changed.", "CONFLICT");
    if (target.role === newRole) return ok(publicView(target), "No change.");
    // Only an approved, active account may be given a role.
    if (!isAccessApproved(target)) return fail(409, "Only approved accounts can have their role changed.", "NOT_APPROVED");

    if (target.role === ROLES.ADMIN) {
      // The founding administrator is permanent: other admins cannot remove them.
      const college = await College.findOne({ collegeId: target.collegeId }).select("createdBy").lean();
      if (college?.createdBy && String(college.createdBy) === String(target._id)) {
        return fail(403, "The original administrator of a college cannot lose admin privileges.", "FOUNDER_PROTECTED");
      }
      if ((await countActiveAdmins(target.collegeId)) <= 1) {
        return fail(409, "A college must keep at least one administrator.", "LAST_ADMIN");
      }
    }

    // One conditional update: only if the target is still what we read.
    const updated = await User.findOneAndUpdate(
      { _id: targetId, collegeId: actor.collegeId, role: target.role, approved: true },
      { $set: { role: newRole }, $inc: { authVersion: 1 } },
      { new: true }
    ).select(FIELDS).lean();
    if (!updated) return fail(409, "This account was changed by someone else. Please refresh and try again.", "CONFLICT");

    // Two admins demoting each other at once can both pass the count above; undo the last one.
    if (target.role === ROLES.ADMIN && (await countActiveAdmins(updated.collegeId ?? null)) < 1) {
      await User.findOneAndUpdate({ _id: targetId }, { $set: { role: ROLES.ADMIN }, $inc: { authVersion: 1 } });
      return fail(409, "A college must keep at least one administrator.", "LAST_ADMIN");
    }

    log("role_changed", { by: actor.userId, target: String(targetId), from: target.role, to: newRole, college: actor.collegeId ?? null });
    return ok(publicView(updated), `Role changed to ${newRole}.`);
  };

  // ── College membership change (server-side / operator use only) ─────────────
  /**
   * Moves an account to another ACTIVE college. Intended for migration scripts
   * and operator tooling — never wired to an HTTP route, because a college admin
   * must not be able to pull users out of (or push users into) another college.
   */
  const changeCollegeMembership = async ({ userId, toCollegeId, reason, operator }) => {
    if (typeof reason !== "string" || reason.trim().length < 5) return fail(400, "A reason is required.", "REASON_REQUIRED");
    if (typeof operator !== "string" || !operator.trim()) return fail(400, "An operator name is required.", "OPERATOR_REQUIRED");
    if (!isObjectIdString(userId)) return NOT_FOUND();
    if (typeof toCollegeId !== "string" || !toCollegeId) return fail(400, "Target college required.", "BAD_COLLEGE");

    const dest = await College.findOne({ collegeId: toCollegeId, status: "active" }).select("collegeId").lean();
    if (!dest) return fail(404, "Target college not found or not active.", "COLLEGE_NOT_FOUND");

    const user = await User.findById(userId).select(FIELDS).lean();
    if (!user) return NOT_FOUND();
    const from = user.collegeId ?? null;
    if (from === toCollegeId) return ok(publicView(user), "No change.");

    if (user.role === ROLES.ADMIN && from && (await countActiveAdmins(from)) <= 1) {
      return fail(409, "A college must keep at least one administrator.", "LAST_ADMIN");
    }

    const updated = await User.findOneAndUpdate(
      { _id: userId, collegeId: from },
      { $set: { collegeId: toCollegeId }, $inc: { authVersion: 1 } },
      { new: true }
    ).select(FIELDS).lean();
    if (!updated) return fail(409, "This account was changed by someone else. Please try again.", "CONFLICT");

    log("membership_changed", { operator, target: String(userId), from, to: toCollegeId, reason: reason.trim() });
    return ok(publicView(updated), "College membership changed.");
  };

  return { revokeSessions, changeRole, changeCollegeMembership };
};
