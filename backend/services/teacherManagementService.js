/**
 * College teacher management (Part 15): member list, activity review, promotion
 * and demotion. Composes the existing services instead of re-implementing rules:
 *
 *   approve / reject / delete  → teacherApprovalService   (unchanged semantics)
 *   promote / demote           → accountSecurityService.changeRole (the ONE place roles change)
 *
 * Every method takes `scope` = req.adminScope (acting admin + college, resolved
 * from the DATABASE by requireCollegeAdmin). The college is never read from a request.
 * Reads are always filtered by scope.collegeId, so another college's user is
 * indistinguishable from a user that does not exist (404).
 *
 * Result convention: { ok:true, status, message, data } | { ok:false, status, message, code }
 */
import { APPROVAL_STATUS, PENDING_FILTER, effectiveApprovalStatus, isObjectIdString } from "../utils/approval.js";
import { scopedModel } from "../utils/tenantScope.js";

const fail = (status, message, code) => ({ ok: false, status, message, code });
const ok = (data, message = "Success", status = 200) => ({ ok: true, status, message, data });
const NOT_FOUND = () => fail(404, "Teacher not found.", "NOT_FOUND");

const LIST_FIELDS = "name email role department phone approved approvalStatus approvalReviewedAt collegeId createdAt";
const INACTIVE_AFTER_DAYS = 14;
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const statusFilter = (status) => {
  switch (status) {
    case APPROVAL_STATUS.PENDING:  return { ...PENDING_FILTER };
    case APPROVAL_STATUS.APPROVED: return { approved: true };
    case APPROVAL_STATUS.REJECTED: return { approvalStatus: APPROVAL_STATUS.REJECTED };
    case "all":                    return {};
    default:                       return null;
  }
};

export const createTeacherManagementService = ({
  User, Subject, Attendance, approvalService, accountSecurity, notifier = null, log = console,
}) => {
  const safeNotify = async (items) => {
    if (!notifier) return;
    try { await notifier.createMany(items); } catch (err) { log.error?.("Notification failed (ignored):", err?.message); }
  };

  const tenantOf = (scope) => ({ collegeId: scope.collegeId });

  /** What the acting admin may do to this member. ADVISORY (drives the UI); every action re-checks on the server. */
  const capabilitiesFor = (scope, u, status) => {
    const none = { canApprove: false, canReject: false, canPromote: false, canDemote: false, canDelete: false };
    const id = String(u._id);
    if (id === scope.adminId) return none;
    if (u.role === "admin") {
      const founder = scope.founderId && id === scope.founderId;
      return { ...none, canDemote: !founder && status === APPROVAL_STATUS.APPROVED };
    }
    return {
      canApprove: status === APPROVAL_STATUS.PENDING,
      canReject: status === APPROVAL_STATUS.PENDING,
      canPromote: status === APPROVAL_STATUS.APPROVED,
      canDemote: false,
      canDelete: true,
    };
  };

  const toMember = (scope, u, activity = null) => {
    const status = effectiveApprovalStatus(u);
    const id = String(u._id);
    return {
      id,
      name: u.name,
      email: u.email,
      role: u.role,
      department: u.department || "",
      phone: u.phone || "",
      status,
      registeredAt: u.createdAt,
      reviewedAt: u.approvalReviewedAt || null,
      isSelf: id === scope.adminId,
      isFounder: u.role === "admin" && !!scope.founderId && id === scope.founderId,
      activity,
      capabilities: capabilitiesFor(scope, u, status),
    };
  };

  /** Subjects / sessions / last session for a set of users — two aggregations, both college-scoped. */
  const activityFor = async (scope, users) => {
    const result = new Map();
    if (users.length === 0) return result;
    const ids = users.map((u) => u._id);
    const tenant = tenantOf(scope);
    const [subj, att] = await Promise.all([
      scopedModel(Subject, tenant).aggregate([
        { $match: { teacher: { $in: ids } } },
        { $group: { _id: "$teacher", totalSubjects: { $sum: 1 } } },
      ]),
      scopedModel(Attendance, tenant).aggregate([
        { $match: { isDeleted: false, teacher: { $in: ids } } },
        { $group: {
          _id: "$teacher", totalSessions: { $sum: 1 }, lastAttendanceDate: { $max: "$date" },
          totalPresent: { $sum: "$summary.presentCount" }, totalRecords: { $sum: "$summary.totalStudents" },
        } },
      ]),
    ]);
    const s = new Map(subj.map((x) => [String(x._id), x]));
    const a = new Map(att.map((x) => [String(x._id), x]));
    for (const u of users) {
      const k = String(u._id);
      const last = a.get(k)?.lastAttendanceDate ?? null;
      const days = last ? Math.floor((Date.now() - new Date(last).getTime()) / 86400000) : null;
      result.set(k, {
        totalSubjects: s.get(k)?.totalSubjects || 0,
        totalSessions: a.get(k)?.totalSessions || 0,
        lastAttendanceDate: last,
        daysSinceLastAttendance: days,
        avgAttendancePercentage: a.get(k)?.totalRecords > 0 ? Math.round((a.get(k).totalPresent / a.get(k).totalRecords) * 1000) / 10 : 0,
        quiet: (s.get(k)?.totalSubjects || 0) > 0 && (days === null || days > INACTIVE_AFTER_DAYS),
      });
    }
    return result;
  };

  const counts = async (scope) => {
    const base = { collegeId: scope.collegeId, role: "teacher" };
    const [pending, approved, rejected, admins] = await Promise.all([
      User.countDocuments({ ...base, ...statusFilter("pending") }),
      User.countDocuments({ ...base, ...statusFilter("approved") }),
      User.countDocuments({ ...base, ...statusFilter("rejected") }),
      User.countDocuments({ collegeId: scope.collegeId, role: "admin" }),
    ]);
    return { pending, approved, rejected, admins };
  };

  /** Load one member of THIS college (any role the page manages). */
  const loadMember = (scope, id) =>
    isObjectIdString(id)
      ? User.findOne({ _id: id, collegeId: scope.collegeId, role: { $in: ["teacher", "admin"] } }).select(LIST_FIELDS).lean()
      : null;

  const actorOf = (scope) => ({ role: "admin", userId: scope.adminId, collegeId: scope.collegeId });

  return {
    // ── list ──────────────────────────────────────────────────────────────────
    // NOTE: the member filter is `type`, not `role` — `role` is a refused key on these routes.
    async list(scope, { status = "all", type = "teacher", q = "", page = 1, limit = 25 } = {}) {
      if (!scope.collegeId) return fail(403, "Your account is not assigned to a college.", "NO_COLLEGE");
      for (const [k, v] of Object.entries({ status, type, q, page, limit })) {
        if (typeof v !== "string" && typeof v !== "number") return fail(400, `Invalid ${k}.`, "BAD_QUERY");
      }
      const sf = statusFilter(status);
      if (!sf) return fail(400, "Status must be pending, approved, rejected or all.", "BAD_STATUS");
      if (!["teacher", "admin", "all"].includes(type)) return fail(400, "Type must be teacher, admin or all.", "BAD_TYPE");
      const text = String(q).trim().slice(0, 100);
      const lim = Math.min(Math.max(parseInt(limit, 10) || 25, 1), 100);
      const pg = Math.max(parseInt(page, 10) || 1, 1);

      const filter = {
        collegeId: scope.collegeId,
        role: type === "all" ? { $in: ["teacher", "admin"] } : type,
        ...sf,
      };
      if (text) {
        const rx = new RegExp(escapeRegex(text), "i"); // literal match — regex characters cannot widen it
        filter.$or = [{ name: rx }, { email: rx }];
      }
      const total = await User.countDocuments(filter);
      const rows = await User.find(filter)
        .sort({ createdAt: status === "pending" ? 1 : -1, _id: 1 })
        .skip((pg - 1) * lim).limit(lim).select(LIST_FIELDS).lean();
      const act = await activityFor(scope, rows.filter((u) => u.role === "teacher"));
      return ok({
        members: rows.map((u) => toMember(scope, u, act.get(String(u._id)) ?? null)),
        counts: await counts(scope),
        pagination: { page: pg, limit: lim, total, totalPages: Math.max(1, Math.ceil(total / lim)) },
        college: scope.college ? { collegeId: scope.college.collegeId, name: scope.college.name } : null,
        me: scope.adminId,
      }, "Members fetched.");
    },

    async summary(scope) {
      if (!scope.collegeId) return fail(403, "Your account is not assigned to a college.", "NO_COLLEGE");
      return ok({ counts: await counts(scope) }, "Summary fetched.");
    },

    // ── detail + activity review ──────────────────────────────────────────────
    async detail(scope, id) {
      if (!scope.collegeId) return fail(403, "Your account is not assigned to a college.", "NO_COLLEGE");
      const u = await loadMember(scope, id);
      if (!u) return NOT_FOUND();
      let activity = null, subjects = [];
      if (u.role === "teacher") {
        activity = (await activityFor(scope, [u])).get(String(u._id));
        subjects = await scopedModel(Subject, tenantOf(scope)).find({ teacher: u._id })
          .sort({ createdAt: -1 }).limit(20).select("name subjectCode department batch shift createdAt").lean();
      }
      return ok({
        member: toMember(scope, u, activity),
        subjects: subjects.map((s) => ({ id: String(s._id), name: s.name, subjectCode: s.subjectCode, department: s.department, batch: s.batch, shift: s.shift, createdAt: s.createdAt })),
      }, "Member fetched.");
    },

    // ── approve / reject / delete: same rules as before (teacherApprovalService) ─
    approve: (scope, id) => approvalService.decide(scope, id, "approve"),
    reject: (scope, id) => approvalService.decide(scope, id, "reject"),
    remove: (scope, id) => approvalService.deleteUser(scope, id),

    // ── promote / demote ──────────────────────────────────────────────────────
    async promote(scope, id) { return this._change(scope, id, "admin"); },
    async demote(scope, id) { return this._change(scope, id, "teacher"); },

    async _change(scope, id, newRole) {
      if (!isObjectIdString(id)) return NOT_FOUND();
      const r = await accountSecurity.changeRole(actorOf(scope), id, newRole);
      if (!r.ok) return r;
      // Best effort: tell the affected person (they are signed out and see it on next sign-in) and the other admins.
      const promoted = newRole === "admin";
      const target = r.data;
      const items = [{
        userId: target.id, collegeId: scope.collegeId, type: promoted ? "role_promoted" : "role_demoted",
        title: promoted ? "You are now an administrator" : "Administrator access removed",
        message: promoted
          ? `${scope.adminName} made you an administrator${scope.college ? ` of ${scope.college.name}` : ""}.`
          : `${scope.adminName} changed your role to teacher${scope.college ? ` at ${scope.college.name}` : ""}.`,
      }];
      try {
        const others = await User.find({ role: "admin", collegeId: scope.collegeId, approved: true }).select("_id").lean();
        for (const a of others) {
          if (String(a._id) === scope.adminId || String(a._id) === target.id) continue;
          items.push({
            userId: a._id, collegeId: scope.collegeId, type: promoted ? "role_promoted" : "role_demoted",
            title: promoted ? "New administrator" : "Administrator removed",
            message: `${scope.adminName} ${promoted ? "promoted" : "demoted"} ${target.name} (${target.email}).`,
            data: { userId: target.id },
          });
        }
      } catch { /* ignored */ }
      await safeNotify(items);
      return ok({ member: { id: target.id, name: target.name, email: target.email, role: target.role } },
        promoted ? `${target.name} is now an administrator. They must sign in again.` : `${target.name} is now a teacher. They must sign in again.`);
    },
  };
};
