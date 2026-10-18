/**
 * Consistent 401 / 403 / 404 responses for the security layer.
 *
 * Every failure is `{ success:false, message, code }`. Messages are written for
 * end users and are deliberately generic: they never echo the caller's role,
 * a college id, a user id, a stack trace, or WHY a token failed verification
 * (bad signature, deleted user and revoked session all look identical), so
 * the API cannot be used as an oracle.
 *
 *   401 → "I don't know who you are (any more)". The client should sign in again.
 *   403 → "I know who you are, and you may not do this".
 *   404 → used for another tenant's resources, so existence is not revealed.
 */
export const AUTH_ERRORS = Object.freeze({
  UNAUTHENTICATED:     { status: 401, message: "Authentication required. Please sign in." },
  TOKEN_EXPIRED:       { status: 401, message: "Your session has expired. Please sign in again." },
  SESSION_INVALID:     { status: 401, message: "Your session is no longer valid. Please sign in again." },

  FORBIDDEN:           { status: 403, message: "You do not have permission to perform this action." },
  ACCOUNT_PENDING:     { status: 403, message: "Your account is pending admin approval." },
  ACCOUNT_REJECTED:    { status: 403, message: "Your registration request was not approved." },
  COLLEGE_UNAVAILABLE: { status: 403, message: "Your college is currently unavailable." },
  COLLEGE_SUSPENDED:   { status: 403, message: "Your college is currently suspended." },
  NO_COLLEGE:          { status: 403, message: "Your account is not linked to a college." },

  NOT_FOUND:           { status: 404, message: "Resource not found." },
});

/** Write a catalogue error to the response. Unknown keys fall back to FORBIDDEN. */
export const sendAuthError = (res, key) => {
  const e = AUTH_ERRORS[key] || AUTH_ERRORS.FORBIDDEN;
  return res.status(e.status).json({ success: false, message: e.message, code: AUTH_ERRORS[key] ? key : "FORBIDDEN" });
};

/** Result object (same shape the services use) for a catalogue error. */
export const authFailure = (key) => {
  const e = AUTH_ERRORS[key] || AUTH_ERRORS.FORBIDDEN;
  return { ok: false, status: e.status, message: e.message, code: AUTH_ERRORS[key] ? key : "FORBIDDEN" };
};
