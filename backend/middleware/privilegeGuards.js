/**
 * rejectPrivilegedFields — for routes that act on ANOTHER account's standing
 * (approve, promote, demote, delete).
 *
 * Those routes take everything they need from the URL (:id) and the route itself
 * (promote vs demote). They never read the body. A request that nevertheless
 * carries `role`, `collegeId`, `approved`, `authVersion`... is either a bug or an
 * escalation attempt, so it is refused outright (400) instead of silently ignored —
 * and logged. Checked in body and query, case-insensitively, one level deep.
 */
import { isClientTenantKey } from "../utils/tenantScope.js";
import { logSecurityEvent } from "../utils/securityLog.js";

export const PRIVILEGED_KEYS = Object.freeze([
  "role", "roles", "isadmin", "is_admin", "admin", "superadmin", "issuperadmin",
  "approved", "approvalstatus", "approvalreviewedby", "approvalreviewedat",
  "authversion", "createdby", "permissions", "scope",
]);

const isPrivilegedKey = (k) =>
  typeof k === "string" && (PRIVILEGED_KEYS.includes(k.toLowerCase()) || isClientTenantKey(k));

const findKeys = (bag, depth = 0) => {
  if (!bag || typeof bag !== "object" || depth > 1) return [];
  return Object.entries(bag).flatMap(([k, v]) => [
    ...(isPrivilegedKey(k) ? [k] : []),
    ...(v && typeof v === "object" ? findKeys(v, depth + 1) : []),
  ]);
};

export const rejectPrivilegedFields = (req, res, next) => {
  const found = [...findKeys(req.body), ...findKeys(req.query)];
  if (found.length) {
    logSecurityEvent("privileged_field_in_request", {
      fields: [...new Set(found)], path: req.originalUrl?.split("?")[0], user: req.auth?.userId,
    });
    return res.status(400).json({
      success: false, code: "INVALID_REQUEST",
      message: "Invalid request: role, college and approval fields cannot be sent to this endpoint.",
    });
  }
  next();
};
