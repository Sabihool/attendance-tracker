/**
 * Tenant (college) guards. Run AFTER `protect` + `requireApproved`.
 *
 *   tenantContext            builds req.tenant from the trusted session
 *   requireAdmin             admin only (+ tenant context)
 *   requireTeacher           teacher only (+ tenant context)
 *   stripClientTenantFields  drops/rejects any collegeId a client sent
 *   loadOwnedResource        loads a college-owned document by :id, inside the
 *                            caller's college, and checks per-user ownership
 *
 * None of these read a college from the request. They are building blocks:
 * a route is only protected once it actually uses them (and the controller
 * queries through utils/tenantScope.js).
 */
import { sendAuthError } from "../utils/authErrors.js";
import { isObjectIdString } from "../utils/approval.js";
import { isClientTenantKey, scopeFilter, TenantScopeError } from "../utils/tenantScope.js";
import { logSecurityEvent } from "../utils/securityLog.js";
import { analyticsCache } from "../utils/analyticsCache.js";

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Build req.tenant from req.auth. No session → 401 (fail closed).
 *
 * Also keeps the dashboard cache (utils/analyticsCache.js) honest: when a write
 * request of this college succeeds, that college's cached dashboard datasets are
 * dropped, so an admin sees the effect of their own change on the next page view.
 * Only the writer's college is touched; failed writes (4xx/5xx) change nothing.
 */
export const tenantContext = (req, res, next) => {
  const a = req.auth;
  if (!a || typeof a.userId !== "string") return sendAuthError(res, "UNAUTHENTICATED");
  req.tenant = Object.freeze({
    collegeId: a.collegeId ?? null,
    college: a.college ?? null,
    userId: a.userId,
    role: a.role,
  });
  if (WRITE_METHODS.has(req.method)) {
    const tenant = req.tenant;
    res.once("finish", () => {
      if (res.statusCode < 400) analyticsCache.invalidate(tenant);
    });
  }
  next();
};

const roleGuard = (role) => (req, res, next) => {
  if (!req.auth) return sendAuthError(res, "UNAUTHENTICATED");
  if (req.auth.role !== role) return sendAuthError(res, "FORBIDDEN");
  return tenantContext(req, res, next);
};

/** Admin of the caller's own college. (Role comes from the database session.) */
export const requireAdmin = roleGuard("admin");

/** Approved teacher of the caller's own college. */
export const requireTeacher = roleGuard("teacher");

/**
 * Remove (default) or reject any client-supplied college field from the body and
 * query string. Even if left in, nothing in the security layer reads them; this
 * stops downstream code from reaching for them by habit.
 *
 * Do NOT mount on public routes whose purpose is to receive a college id
 * (signup, college search).
 */
export const stripClientTenantFields = ({ mode = "strip" } = {}) => (req, res, next) => {
  const found = [];
  for (const bag of [req.body, req.query]) {
    if (!bag || typeof bag !== "object") continue;
    for (const key of Object.keys(bag)) {
      if (isClientTenantKey(key)) {
        found.push(key);
        if (mode === "strip") delete bag[key];
      }
    }
  }
  if (found.length) {
    logSecurityEvent("client_tenant_field", { mode, fields: [...new Set(found)], path: req.originalUrl?.split("?")[0], user: req.auth?.userId, college: req.auth?.collegeId ?? null });
    if (mode === "reject") {
      return res.status(400).json({ success: false, message: "Invalid request.", code: "INVALID_REQUEST" });
    }
  }
  next();
};

/**
 * Load a college-owned resource and verify the caller may touch it.
 *
 *   loadOwnedResource({ model: Subject, as: "subject", ownerField: "teacher" })
 *
 *  1. the document must be in the CALLER'S college — otherwise 404, the same
 *     answer as "no such id", so other colleges' ids cannot be probed;
 *  2. if `ownerField` is set, a teacher must own it (admins of the same college
 *     may manage any of its documents) — otherwise 403;
 *  3. the document is exposed as req.resources[as].
 *
 * The model must have a collegeId field (enforced), so this cannot be used on a
 * model that has not been made college-aware yet.
 */
export const loadOwnedResource = ({ model, param = "id", as, ownerField = null, filter = {}, lean = false, adminBypassOwner = true }) => {
  if (!model || !as) throw new Error("loadOwnedResource: model and as are required.");
  return async (req, res, next) => {
    try {
      if (!req.tenant) return sendAuthError(res, "UNAUTHENTICATED"); // tenantContext not run
      const id = req.params?.[param];
      if (typeof id !== "string" || !isObjectIdString(id)) return sendAuthError(res, "NOT_FOUND");

      if (model?.schema?.path && !model.schema.path("collegeId")) {
        throw new TenantScopeError(`Model '${model.modelName || "?"}' has no collegeId field.`);
      }
      let q = model.findOne(scopeFilter(req.tenant, { ...filter, _id: id }));
      if (lean && typeof q.lean === "function") q = q.lean();
      const doc = await q;

      if (!doc) {
        logSecurityEvent("resource_not_in_tenant", { resource: as, path: req.originalUrl?.split("?")[0], user: req.tenant.userId, college: req.tenant.collegeId ?? null });
        return sendAuthError(res, "NOT_FOUND");
      }

      if (ownerField) {
        const isAdmin = req.tenant.role === "admin" && adminBypassOwner;
        if (!isAdmin && String(doc[ownerField]) !== req.tenant.userId) return sendAuthError(res, "FORBIDDEN");
      }

      req.resources = { ...(req.resources || {}), [as]: doc };
      next();
    } catch (err) {
      next(err);
    }
  };
};
