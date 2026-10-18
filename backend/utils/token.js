import jwt from 'jsonwebtoken'

/** The only signing algorithm issued and accepted (blocks `alg:none` / algorithm-confusion tokens). */
export const JWT_ALGORITHM = 'HS256'

/**
 * Generate a signed JWT token for a user.
 *
 * BUG FIX: The original version called jwt.sign() with process.env.JWT_SECRET
 * at call-time only. In ESM with top-level await patterns, the secret is read
 * correctly. However, to be defensive — and to produce a clear runtime error
 * instead of a silent "invalid signature" later — we validate that JWT_SECRET
 * is present before signing.
 *
 * @param {Object} payload - Data to encode in the token
 * @returns {string} Signed JWT token
 */
export const generateToken = (payload) => {
  const secret = process.env.JWT_SECRET
  if (!secret) {
    throw new Error(
      'JWT_SECRET is not defined. Check your server/.env file.'
    )
  }
  return jwt.sign(payload, secret, {
    algorithm: JWT_ALGORITHM, // pinned: verification accepts only this algorithm too
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  })
}

/**
 * Build token payload from a User document.
 *
 * SECURITY: only `id` (who) and `av` (session version) are used by the server.
 * `role`, `approved` and `collegeId` are informational snapshots for the client
 * and are NEVER trusted — middleware/authMiddleware re-reads the real values
 * from the database on every request. `av` lets the server revoke a token by
 * bumping User.authVersion.
 *
 * @param {Object} user - Mongoose User document
 * @returns {Object} Token payload
 */
export const buildTokenPayload = (user) => ({
  id: user._id.toString(), // ensure string, not ObjectId
  name: user.name,
  email: user.email,
  role: user.role,
  approved: user.approved,
  collegeId: user.collegeId || null,
  av: Number.isInteger(user.authVersion) && user.authVersion >= 0 ? user.authVersion : 0,
})
