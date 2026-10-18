/**
 * Activity log service (Part 17) — college-scoped audit trail.
 *
 *   recordActivity(tenant, entry)   write one row for THIS college; never throws
 *   activityLogger(action, opts)    route middleware: records `action` after a
 *                                   request that SUCCEEDED (status < 400)
 *   listActivity(tenant, query)     read one college's rows (admin endpoint)
 *
 * The college always comes from `tenant` (req.tenant, built from the database
 * session) or, for background jobs, from an explicit `{ collegeId }` they loop
 * over — never from a request. Writes and reads go through scopedModel, so a
 * row can neither be created in nor listed from another college.
 *
 * Logging must never break the action being logged: recordActivity swallows
 * its own errors (and reports them to the server log only).
 */
import ActivityLogModel from "../models/ActivityLog.js";
import UserModel from "../models/User.js";
import { scopedModel, assertTenant } from "../utils/tenantScope.js";
import { isObjectIdString } from "../utils/approval.js";

/** Every action code the log accepts. Anything else is refused (keeps the log queryable and typo-free). */
export const ACTIVITY_ACTIONS = Object.freeze([
  // reports / exports (teacher or admin)
  "export.pdf", "export.excel", "export.csv", "export.register_pdf", "export.zip",
  // backups (admin)
  "backup.create", "backup.restore_preview", "backup.restore", "backup.restore_refused",
  // teacher activity
  "attendance.save", "attendance.update", "attendance.trash",
  "trash.restore", "trash.permanent_delete", "trash.empty",
  "subject.delete",
  // admin activity
  "teacher.approve", "teacher.reject", "teacher.promote", "teacher.demote", "teacher.delete",
  // background jobs
  "trash.purge",
]);
const ACTION_SET = new Set(ACTIVITY_ACTIONS);
const ROLES = new Set(["admin", "teacher", "system"]);

/** Keep only short primitive values; drops anything that could carry content. */
const cleanMeta = (meta) => {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return null;
  const out = {};
  for (const [k, v] of Object.entries(meta).slice(0, 12)) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,29}$/.test(k)) continue;
    if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    else if (typeof v === "boolean") out[k] = v;
    else if (typeof v === "string") out[k] = v.slice(0, 80);
  }
  return Object.keys(out).length ? out : null;
};

/**
 * Write one activity row for `tenant`'s college. `tenant` is req.tenant, or
 * `{ collegeId }` for a system row. Returns the row, or null if it could not be written.
 */
export const recordActivity = async (tenant, entry = {}, { Model = ActivityLogModel, sink = console } = {}) => {
  try {
    assertTenant(tenant);
    if (!ACTION_SET.has(entry.action)) throw new Error(`unknown activity action '${entry.action}'`);
    const actorRole = entry.actorRole ?? tenant.role ?? "system";
    if (!ROLES.has(actorRole)) throw new Error("invalid actor role");
    const actorId = entry.actorId ?? tenant.userId ?? null;
    return await scopedModel(Model, { collegeId: tenant.collegeId ?? null }).create({
      actorId: actorId && isObjectIdString(String(actorId)) ? String(actorId) : null,
      actorRole,
      action: entry.action,
      targetType: entry.targetType ?? null,
      targetId: entry.targetId != null && /^[A-Za-z0-9_-]{1,40}$/.test(String(entry.targetId)) ? String(entry.targetId) : null,
      status: entry.status === "failed" ? "failed" : "success",
      meta: cleanMeta(entry.meta),
    });
  } catch (err) {
    try { sink.error?.("activity log write failed:", err.message); } catch { /* ignore */ }
    return null;
  }
};

/**
 * Middleware factory. Place it AFTER the route's authentication / ownership
 * guards: it records only when the request finished with a status below 400, so
 * a refused or failed request is never logged as an action that happened.
 *
 *   router.get("/pdf", activityLogger("export.pdf", { targetType: "subject", targetParam: "subjectId", meta: { format: "pdf" } }), handler)
 */
export const activityLogger = (action, { targetType = null, targetParam = null, meta = null } = {}) => {
  if (!ACTION_SET.has(action)) throw new Error(`activityLogger: unknown action '${action}'`);
  return (req, res, next) => {
    const tenant = req.tenant;
    if (tenant) {
      res.once("finish", () => {
        if (res.statusCode >= 400) return;
        const raw = targetParam ? req.params?.[targetParam] : null;
        recordActivity(tenant, {
          action, targetType: raw && isObjectIdString(raw) ? targetType : null,
          targetId: raw && isObjectIdString(raw) ? raw : null, meta,
        });
      });
    }
    next();
  };
};

// ─── Reading ──────────────────────────────────────────────────────────────────
const fail = (status, message, code) => ({ ok: false, status, message, code });
const DAY_MS = 86400000;

const parseDate = (v, endOfDay = false) => {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?$/.test(v)) return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  if (endOfDay && v.length === 10) return new Date(d.getTime() + DAY_MS - 1);
  return d;
};

/**
 * One college's activity, newest first.
 * Query (all optional, all strings): actorId, role, action (exact code, or a group
 * such as "export" / "backup"), from, to (YYYY-MM-DD), page, limit (max 100).
 * Nothing in the query can name a college; `actorId` of another college's user
 * simply matches nothing.
 */
export const listActivity = async (tenant, query = {}, { Model = ActivityLogModel, UserM = UserModel } = {}) => {
  assertTenant(tenant);
  if (!tenant.collegeId) return fail(403, "Your account is not assigned to a college.", "NO_COLLEGE");
  for (const [k, v] of Object.entries(query)) {
    if (typeof v !== "string" && typeof v !== "number") return fail(400, `Invalid ${k}.`, "BAD_QUERY");
  }
  const { actorId, role, action, from, to } = query;
  const filter = {};

  if (actorId !== undefined) {
    if (!isObjectIdString(String(actorId))) return fail(400, "Invalid actorId.", "BAD_QUERY");
    filter.actorId = String(actorId);
  }
  if (role !== undefined) {
    if (!ROLES.has(String(role))) return fail(400, "Role must be admin, teacher or system.", "BAD_QUERY");
    filter.actorRole = String(role);
  }
  if (action !== undefined) {
    const a = String(action);
    if (ACTION_SET.has(a)) filter.action = a;
    else {
      const group = ACTIVITY_ACTIONS.filter((x) => /^[a-z_]{1,30}$/.test(a) && x.startsWith(`${a}.`));
      if (!group.length) return fail(400, "Unknown action.", "BAD_QUERY");
      filter.action = { $in: group };
    }
  }
  if (from !== undefined || to !== undefined) {
    const range = {};
    if (from !== undefined) { const d = parseDate(String(from)); if (!d) return fail(400, "from must be YYYY-MM-DD.", "BAD_QUERY"); range.$gte = d; }
    if (to !== undefined) { const d = parseDate(String(to), true); if (!d) return fail(400, "to must be YYYY-MM-DD.", "BAD_QUERY"); range.$lte = d; }
    filter.createdAt = range;
  }

  const limit = Math.min(Math.max(parseInt(query.limit, 10) || 25, 1), 100);
  const page = Math.min(Math.max(parseInt(query.page, 10) || 1, 1), 10000);
  const scoped = scopedModel(Model, { collegeId: tenant.collegeId });
  const total = await scoped.countDocuments(filter);
  const rows = await scoped.find(filter).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean();

  // Actor names come from THIS college's users only (no e-mail, no other fields).
  const ids = [...new Set(rows.map((r) => r.actorId && String(r.actorId)).filter(Boolean))];
  const users = ids.length ? await scopedModel(UserM, { collegeId: tenant.collegeId }).find({ _id: { $in: ids } }).select("name role").lean() : [];
  const byId = new Map(users.map((u) => [String(u._id), u]));

  return {
    ok: true, status: 200, message: "Activity fetched.",
    data: {
      activity: rows.map((r) => ({
        id: String(r._id),
        action: r.action,
        actor: r.actorId ? { id: String(r.actorId), name: byId.get(String(r.actorId))?.name ?? null, role: r.actorRole } : { id: null, name: null, role: r.actorRole },
        targetType: r.targetType ?? null,
        targetId: r.targetId ?? null,
        status: r.status,
        meta: r.meta ?? null,
        at: r.createdAt,
      })),
      pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
    },
  };
};
