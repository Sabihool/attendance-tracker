import jwt from 'jsonwebtoken'
import User from '../models/User.js'
import College from '../models/College.js'
import { createRequireApproved } from './approvalGuards.js'
import { createAuthSessionService } from '../services/authSessionService.js'
import { sendAuthError } from '../utils/authErrors.js'
import { sendError } from '../utils/response.js'
import { JWT_ALGORITHM } from '../utils/token.js'
import { isStrictCollegeMembership } from '../utils/securityConfig.js'
import { logSecurityEvent } from '../utils/securityLog.js'

/**
 * AUTHENTICATION IS TWO STEPS
 *
 *   1. protect          — "is this a genuine, unexpired token we issued?"
 *                         (signature + algorithm + expiry; no database).
 *                         Sets req.user to the UNTRUSTED token claims.
 *   2. requireApproved  — "who is this RIGHT NOW?" Reads the account from the
 *                         database (role, approval, college, college status,
 *                         session version) and replaces req.user / sets req.auth
 *                         with the trusted values.
 *
 * Every protected route must run both, in this order (`authenticate` below is
 * the two combined). `authorize` only trusts req.auth, so a route that forgets
 * step 2 denies everyone instead of trusting the token.
 */

/** Step 1 — verify the bearer token. Does NOT hit the database. */
export const protect = (req, res, next) => {
  try {
    const secret = process.env.JWT_SECRET
    if (!secret) {
      console.error('❌ JWT_SECRET is not set. Check server/.env')
      return sendError(res, 'Server configuration error.', 500)
    }

    const authHeader = req.headers?.authorization
    if (typeof authHeader !== 'string' || !authHeader.startsWith('Bearer ')) {
      return sendAuthError(res, 'UNAUTHENTICATED')
    }

    const token = authHeader.slice('Bearer '.length).trim()
    if (!token) return sendAuthError(res, 'UNAUTHENTICATED')

    // Algorithm pinned: rejects `alg:none` and other algorithm-confusion tokens.
    const decoded = jwt.verify(token, secret, { algorithms: [JWT_ALGORITHM] })
    req.user = decoded // UNTRUSTED claims — replaced by requireApproved
    next()
  } catch (error) {
    if (error.name === 'TokenExpiredError') return sendAuthError(res, 'TOKEN_EXPIRED')
    // Bad signature, malformed, wrong algorithm… all look the same to the caller.
    return sendAuthError(res, 'SESSION_INVALID')
  }
}

/** Shared by the guard and /auth/me. Strict college membership is an env switch (default off). */
export const sessionService = createAuthSessionService({
  User,
  College,
  strictCollegeMembership: isStrictCollegeMembership(),
})

/**
 * Step 2 — resolve the trusted session from the database.
 * Rejects (401/403) accounts that are deleted, revoked, pending, rejected, or
 * whose college is missing/suspended. See middleware/approvalGuards.js.
 */
export const requireApproved = createRequireApproved({ sessionService })

/** Steps 1 + 2 in one middleware, for new routes. */
export const authenticate = (req, res, next) =>
  protect(req, res, (err) => (err ? next(err) : requireApproved(req, res, next)))

/**
 * Restrict a route to the given roles. Must run after requireApproved.
 *
 * Reads the role from req.auth (database-derived) ONLY. If there is no session
 * the request is denied — it never falls back to the token's role claim.
 *
 * Usage: authorize('admin') or authorize('admin', 'teacher')
 */
export const authorize = (...roles) => {
  return (req, res, next) => {
    const role = req.auth?.role
    if (!role) {
      logSecurityEvent('authorize_without_session', { method: req.method, path: req.originalUrl?.split('?')[0] })
      return sendAuthError(res, 'FORBIDDEN')
    }
    if (!roles.includes(role)) return sendAuthError(res, 'FORBIDDEN')
    next()
  }
}
