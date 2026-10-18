/**
 * Teacher registration review — all business rules in one place.
 * Dependency-injected (User, College, notifier) so it is unit-testable without
 * a database, and so the HTTP layer stays thin.
 *
 * Result convention: { ok: true, status, message, data } | { ok: false, status, message, code?, ...extra }
 *
 * SECURITY MODEL
 *  - The acting admin is re-loaded from the DATABASE on every call; the JWT is
 *    never trusted for college or role.
 *  - Every query is scoped by the admin's collegeId. A request that belongs to
 *    another college is indistinguishable from one that does not exist (404).
 *  - A decision is ONE atomic conditional update (`findOneAndUpdate` with the
 *    "still pending, same college" condition in the filter). Two admins
 *    deciding at once → exactly one wins, the other gets 409.
 */
import {
  APPROVAL_STATUS,
  PENDING_FILTER,
  effectiveApprovalStatus,
  isAccessApproved,
  isObjectIdString,
} from "../utils/approval.js";

const LIST_FIELDS =
  "name email department phone approved approvalStatus approvalReviewedAt collegeId createdAt";

const fail = (status, message, code, extra = {}) => ({ ok: false, status, message, code, ...extra });
const ok = (data, message = "Success", status = 200) => ({ ok: true, status, message, data });

const NOT_FOUND = () => fail(404, "Teacher request not found.", "NOT_FOUND");

export const createTeacherApprovalService = ({ User, College, notifier = null, now = () => new Date(), log = console }) => {
  const safeNotify = async (items) => {
    if (!notifier) return;
    try { await notifier.createMany(items); }
    catch (err) { log.error?.("Notification failed (ignored):", err?.message); }
  };

  // ── Who is acting, and for which college? ───────────────────────────────────
  const resolveAdminScope = async (adminId) => {
    if (!isObjectIdString(adminId)) return fail(401, "Invalid session.", "INVALID_SESSION");
    const admin = await User.findById(adminId).select("name role approved approvalStatus collegeId").lean();
    if (!admin || admin.role !== "admin" || !isAccessApproved(admin)) {
      return fail(403, "Only an approved administrator can manage teacher requests.", "NOT_ADMIN");
    }
    const collegeId = admin.collegeId ?? null;
    let college = null;
    if (collegeId) {
      college = await College.findOne({ collegeId }).select("collegeId name district country status createdBy").lean();
      if (!college) {
        return fail(403, "Your college is no longer available, so teacher requests cannot be managed.", "COLLEGE_UNAVAILABLE");
      }
      if (college.status !== "active") {
        return fail(403, "Your college is suspended. Teacher requests cannot be managed until it is reactivated.", "COLLEGE_SUSPENDED");
      }
    }
    // founderId: the college's original administrator (College.createdBy) — protected from demotion/deletion.
    const founderId = college?.createdBy ? String(college.createdBy) : null;
    return { ok: true, scope: { adminId: String(admin._id), adminName: admin.name, collegeId, college, founderId } };
  };

  const statusFilter = (status) => {
    switch (status) {
      case APPROVAL_STATUS.PENDING:  return { ...PENDING_FILTER };
      case APPROVAL_STATUS.APPROVED: return { approved: true };
      case APPROVAL_STATUS.REJECTED: return { approvalStatus: APPROVAL_STATUS.REJECTED };
      case "all":                    return {};
      default:                       return null;
    }
  };

  const baseFilter = (scope) => ({ role: "teacher", collegeId: scope.collegeId });

  const toRequest = (scope, u) => ({
    id: String(u._id),
    name: u.name,
    email: u.email,
    department: u.department || "",
    phone: u.phone || "",
    status: effectiveApprovalStatus(u),
    registeredAt: u.createdAt,
    reviewedAt: u.approvalReviewedAt || null,
    college: scope.college
      ? { collegeId: scope.college.collegeId, name: scope.college.name, district: scope.college.district, country: scope.college.country }
      : null,
  });

  const counts = async (scope) => {
    const base = baseFilter(scope);
    const [pending, approved, rejected] = await Promise.all([
      User.countDocuments({ ...base, ...statusFilter("pending") }),
      User.countDocuments({ ...base, ...statusFilter("approved") }),
      User.countDocuments({ ...base, ...statusFilter("rejected") }),
    ]);
    return { pending, approved, rejected };
  };

  return {
    resolveAdminScope,

    // ── GET list ──────────────────────────────────────────────────────────────
    async listRequests(scope, { status = "pending", page = 1, limit = 50 } = {}) {
      const sf = statusFilter(status);
      if (!sf) return fail(400, "Status must be pending, approved, rejected or all.", "BAD_STATUS");
      const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 100);
      const pg = Math.max(parseInt(page, 10) || 1, 1);

      const rows = await User.find({ ...baseFilter(scope), ...sf })
        .sort({ createdAt: status === "pending" ? 1 : -1, _id: 1 }) // pending: oldest first
        .skip((pg - 1) * lim)
        .limit(lim)
        .select(LIST_FIELDS)
        .lean();

      return ok(
        {
          requests: rows.map((u) => toRequest(scope, u)),
          counts: await counts(scope),
          page: pg,
          limit: lim,
          college: scope.college ? { collegeId: scope.college.collegeId, name: scope.college.name } : null,
        },
        "Teacher requests fetched."
      );
    },

    async summary(scope) {
      return ok(
        { counts: await counts(scope), college: scope.college ? { collegeId: scope.college.collegeId, name: scope.college.name } : null },
        "Summary fetched."
      );
    },

    // ── approve / reject ──────────────────────────────────────────────────────
    async decide(scope, targetId, decision) {
      if (decision !== "approve" && decision !== "reject") return fail(400, "Invalid decision.", "BAD_DECISION");
      if (!isObjectIdString(targetId)) return NOT_FOUND();
      if (targetId === scope.adminId) return fail(403, "You cannot decide your own account.", "SELF_DECISION");

      const approving = decision === "approve";
      const newStatus = approving ? APPROVAL_STATUS.APPROVED : APPROVAL_STATUS.REJECTED;

      // ONE atomic step: "this teacher, of MY college, is still pending" is part
      // of the filter, so a concurrent decision makes this match nothing.
      const updated = await User.findOneAndUpdate(
        { _id: targetId, ...baseFilter(scope), ...PENDING_FILTER },
        {
          $set: {
            approved: approving,
            approvalStatus: newStatus,
            approvalReviewedBy: scope.adminId,
            approvalReviewedAt: now(),
          },
        },
        { new: true }
      ).select(LIST_FIELDS).lean();

      if (!updated) {
        // Why nothing matched? Same-college lookup only — other colleges' users stay invisible.
        const existing = await User.findOne({ _id: targetId, ...baseFilter(scope) }).select("approved approvalStatus").lean();
        if (!existing) return NOT_FOUND();
        const current = effectiveApprovalStatus(existing);
        return fail(409, `This request was already ${current}.`, "ALREADY_DECIDED", { currentStatus: current });
      }

      // Notifications are best-effort and never change the outcome.
      const verb = approving ? "approved" : "rejected";
      const items = [];
      if (approving) {
        items.push({
          userId: updated._id,
          collegeId: scope.collegeId,
          type: "teacher_request_approved",
          title: "Registration approved",
          message: `Your account was approved${scope.college ? ` by ${scope.college.name}` : ""}. Welcome aboard!`,
        });
      }
      const otherAdmins = await User.find({ role: "admin", collegeId: scope.collegeId, approved: true }).select("_id").lean().catch(() => []);
      for (const a of otherAdmins) {
        if (String(a._id) === scope.adminId) continue;
        items.push({
          userId: a._id,
          collegeId: scope.collegeId,
          type: "teacher_request_decided",
          title: `Teacher request ${verb}`,
          message: `${scope.adminName} ${verb} ${updated.name} (${updated.email}).`,
          data: { teacherId: String(updated._id), decision: newStatus },
        });
      }
      await safeNotify(items);

      return ok({ user: toRequest(scope, updated) }, `Teacher '${updated.name}' has been ${verb}.`);
    },

    // ── delete (same college only) ────────────────────────────────────────────
    async deleteUser(scope, targetId) {
      if (!isObjectIdString(targetId)) return fail(404, "User not found.", "NOT_FOUND");
      if (targetId === scope.adminId) return fail(400, "You cannot delete your own account.", "SELF_DELETE");
      // Part 15: only TEACHER accounts are deletable. An administrator must first lose admin
      // privileges (which enforces the founder / last-admin rules) — otherwise one admin could
      // delete another, or the college's only administrator, around those rules.
      // The role is part of the delete filter, so a concurrent promotion cannot slip through.
      const gone = await User.findOneAndDelete({ _id: targetId, collegeId: scope.collegeId, role: "teacher" }).select("name").lean();
      if (!gone) {
        const existing = await User.findOne({ _id: targetId, collegeId: scope.collegeId }).select("role").lean();
        if (existing?.role === "admin") {
          return fail(409, "Remove this person's admin privileges before deleting the account.", "ADMIN_NOT_DELETABLE");
        }
        return fail(404, "User not found.", "NOT_FOUND");
      }
      return ok({}, `User '${gone.name}' has been deleted.`);
    },

    // ── legacy GET /auth/users (now scoped) ───────────────────────────────────
    async legacyListUsers(scope, query = {}) {
      const filter = { collegeId: scope.collegeId };
      if (query.role === "teacher" || query.role === "admin") filter.role = query.role;
      if (query.approved === "true") filter.approved = true;
      if (query.approved === "false") Object.assign(filter, PENDING_FILTER);
      const users = await User.find(filter).sort({ createdAt: -1 }).limit(500).select(`${LIST_FIELDS} role`).lean();
      const sanitized = users.map((u) => ({ ...u, approvalStatus: effectiveApprovalStatus(u) }));
      return ok({ users: sanitized, count: sanitized.length }, "Users fetched successfully.");
    },

    // ── on registration: tell the college's admins ────────────────────────────
    async notifyNewRequest({ teacher, college }) {
      if (!notifier || !college?.collegeId) return;
      try {
        const admins = await User.find({ role: "admin", approved: true, collegeId: college.collegeId }).select("_id").lean();
        await safeNotify(admins.map((a) => ({
          userId: a._id,
          collegeId: college.collegeId,
          type: "teacher_request_new",
          title: "New teacher request",
          message: `${teacher.name} (${teacher.email}) asked to join ${college.name}.`,
          data: { teacherId: String(teacher._id) },
        })));
      } catch (err) {
        log.error?.("notifyNewRequest failed (ignored):", err?.message);
      }
    },
  };
};

/**
 * Can this (already password-verified) user log in?
 *  - admins and approved teachers: yes (unchanged behaviour)
 *  - rejected teacher: never
 *  - pending teacher: no; the message says whether the college is reachable
 */
export const checkLoginEligibility = async ({ user, College }) => {
  const collegeUnavailable = async () => {
    if (!user.collegeId) return false;
    try {
      const college = await College.findOne({ collegeId: user.collegeId }).select("status").lean();
      return !college || college.status !== "active";
    } catch { return true; /* cannot verify → treat as unavailable */ }
  };

  if (user.role !== "teacher") {
    // Admins: unchanged, except that a missing/suspended college blocks sign-in
    // (every request would be refused anyway; fail early with a clear reason).
    if (await collegeUnavailable()) {
      return {
        ok: false, status: 403, code: "COLLEGE_UNAVAILABLE",
        message: "Your college is currently unavailable, so you cannot sign in right now.",
      };
    }
    return { ok: true };
  }

  if (isAccessApproved(user)) {
    if (await collegeUnavailable()) {
      return {
        ok: false, status: 403, code: "COLLEGE_UNAVAILABLE",
        message: "Your college is currently unavailable, so you cannot sign in right now.",
      };
    }
    return { ok: true };
  }

  if (user.approvalStatus === APPROVAL_STATUS.REJECTED) {
    return {
      ok: false, status: 403, code: "ACCOUNT_REJECTED",
      message: "Your registration request was not approved by your college's administrator. You cannot sign in with this account.",
    };
  }
  if (await collegeUnavailable()) {
    return {
      ok: false, status: 403, code: "COLLEGE_UNAVAILABLE",
      message: "Your account is pending, but the college you selected is currently unavailable, so it cannot be reviewed right now.",
    };
  }
  // Same wording as before Part 8, plus a machine-readable code.
  return { ok: false, status: 403, code: "ACCOUNT_PENDING", message: "Your account is pending admin approval. Please try again later." };
};
