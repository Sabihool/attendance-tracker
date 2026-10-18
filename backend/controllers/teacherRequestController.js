import { sendSuccess } from "../utils/response.js";
import { teacherApprovalService } from "../services/approvalWiring.js";

/** Map a service result onto the HTTP response. */
export const respond = (res, r) => {
  if (r.ok) return sendSuccess(res, r.data, r.message, r.status);
  const { ok, status, message, code, ...extra } = r; // eslint-disable-line no-unused-vars
  return res.status(status).json({ success: false, message, code, ...extra });
};

/**
 * Handlers are built from a service so tests can inject a fake-backed one.
 * They all rely on `req.adminScope`, which `requireCollegeAdmin` derives from
 * the DATABASE — nothing about college or role is read from the request body.
 */
export const createTeacherRequestHandlers = (service) => {
  const wrap = (fn) => async (req, res, next) => {
    try { respond(res, await fn(req)); } catch (err) { next(err); }
  };
  return {
    list:    wrap((req) => service.listRequests(req.adminScope, req.query || {})),
    summary: wrap((req) => service.summary(req.adminScope)),
    approve: wrap((req) => service.decide(req.adminScope, req.params.id, "approve")),
    reject:  wrap((req) => service.decide(req.adminScope, req.params.id, "reject")),
    remove:  wrap((req) => service.deleteUser(req.adminScope, req.params.id)),
    legacyList: wrap((req) => service.legacyListUsers(req.adminScope, req.query || {})),
  };
};

export const teacherRequestHandlers = createTeacherRequestHandlers(teacherApprovalService);
