import { respond } from "./teacherRequestController.js";
import { teacherManagementService } from "../services/managementWiring.js";

/** Handlers are built from a service so tests can inject another one. All rely on req.adminScope (DB-derived). */
export const createTeacherManagementHandlers = (service) => {
  const wrap = (fn) => async (req, res, next) => {
    try { respond(res, await fn(req)); } catch (err) { next(err); }
  };
  return {
    list:    wrap((req) => service.list(req.adminScope, req.query || {})),
    summary: wrap((req) => service.summary(req.adminScope)),
    detail:  wrap((req) => service.detail(req.adminScope, req.params.id)),
    approve: wrap((req) => service.approve(req.adminScope, req.params.id)),
    reject:  wrap((req) => service.reject(req.adminScope, req.params.id)),
    promote: wrap((req) => service.promote(req.adminScope, req.params.id)),
    demote:  wrap((req) => service.demote(req.adminScope, req.params.id)),
    remove:  wrap((req) => service.remove(req.adminScope, req.params.id)),
  };
};
export const teacherManagementHandlers = createTeacherManagementHandlers(teacherManagementService);
