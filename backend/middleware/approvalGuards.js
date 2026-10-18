/**
 * Authorization guards that consult the DATABASE (not just the JWT).
 * Factories take their dependencies so they can be tested without a database.
 */
import { sendAuthError } from "../utils/authErrors.js";
import { createAuthSessionService } from "../services/authSessionService.js";

/**
 * Session guard — the DB-backed half of authentication. Must run after `protect`.
 *
 * Re-reads the account from the DATABASE on every request (for admins AND
 * teachers) and rejects it unless it exists, still matches the token's session
 * version, is approved, and belongs to an active college. On success it
 * attaches `req.auth` (the trusted session) and REPLACES `req.user` with the
 * database values, so nothing downstream ever sees a stale token claim.
 *
 * Name kept for backwards compatibility with every existing
 * `protect, requireApproved, authorize(...)` route chain.
 */
export const createRequireApproved = ({ User, College, sessionService, strictCollegeMembership = false }) => {
  const service = sessionService || createAuthSessionService({ User, College, strictCollegeMembership });
  return async (req, res, next) => {
    try {
      if (!req.user) return sendAuthError(res, "UNAUTHENTICATED"); // chain mistake → fail closed
      const r = await service.resolveSession(req.user);
      if (!r.ok) return res.status(r.status).json({ success: false, message: r.message, code: r.code });
      applySession(req, r.session);
      next();
    } catch (err) {
      next(err);
    }
  };
};

/** Attach the trusted session; req.user becomes a DB-derived view (legacy code reads it). */
export const applySession = (req, session) => {
  req.auth = session;
  req.user = {
    id: session.userId,
    name: session.name,
    email: session.email,
    role: session.role,
    approved: true,
    collegeId: session.collegeId,
    av: session.authVersion,
  };
};

/**
 * Resolves the acting admin + college from the database and attaches
 * `req.adminScope`. Rejects non-admins, unapproved admins, and admins whose
 * college is missing or suspended. Must run after `protect`.
 */
export const createRequireCollegeAdmin = ({ service }) => async (req, res, next) => {
  try {
    if (req.auth?.role !== "admin" && req.user?.role !== "admin") return sendAuthError(res, "FORBIDDEN");
    const r = await service.resolveAdminScope(req.user.id);
    if (!r.ok) return res.status(r.status).json({ success: false, message: r.message, code: r.code });
    req.adminScope = r.scope;
    next();
  } catch (err) {
    next(err);
  }
};
