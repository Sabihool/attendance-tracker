import bcrypt from 'bcryptjs'
import User from '../models/User.js'
import College from '../models/College.js'
import { findActiveCollegeById } from './collegeController.js'
import { generateToken, buildTokenPayload } from '../utils/token.js'
import { sendSuccess, sendError } from '../utils/response.js'
import { APPROVAL_STATUS } from '../utils/approval.js'
import { checkLoginEligibility } from '../services/teacherApprovalService.js'
import { teacherApprovalService } from '../services/approvalWiring.js'

// ─── POST /api/auth/signup ────────────────────────────────────────────────────
/**
 * Register a TEACHER (public signup). Admins are only created via /api/colleges/register.
 * The account is created PENDING and tied to the selected college; an admin of that college must approve it.
 */
export const createSignup = ({ User, College, findActiveCollege, onTeacherRegistered = async () => {} }) => async (req, res, next) => {
  try {
    const { name, email, password, role, department, phone, collegeId } = req.body || {}

    // Only plain strings are accepted for text fields (blocks `{ "$ne": "" }`-style
    // operator objects and arrays). `approved`, `approvalStatus`, etc. in the body
    // are never read — a teacher cannot approve themselves by sending them.
    for (const [field, value] of Object.entries({ name, email, password, role })) {
      if (value !== undefined && typeof value !== 'string') {
        return sendError(res, `Invalid ${field}.`, 400)
      }
    }
    for (const [field, value] of Object.entries({ department, phone })) {
      if (value !== undefined && value !== null && typeof value !== 'string') {
        return sendError(res, `Invalid ${field}.`, 400)
      }
    }

    // ── Validate required fields ──────────────────────────────────────────────
    if (!name || !email || !password || !role) {
      return sendError(res, 'Name, email, password, and role are required.', 400)
    }

    // ── Validate role value ───────────────────────────────────────────────────
    const validRoles = ['admin', 'teacher']
    if (!validRoles.includes(role)) {
      return sendError(res, "Role must be 'admin' or 'teacher'.", 400)
    }

    // ── Public signup can never create an admin ───────────────────────────────
    // Admins are created only through POST /api/colleges/register, which also
    // creates their college. Letting anyone self-assign "admin" here would be
    // a privilege-escalation hole.
    if (role === 'admin') {
      return sendError(
        res,
        'Admin accounts cannot be created here. Register your college to become its administrator.',
        403
      )
    }

    // ── Teacher must belong to a real, ACTIVE college ─────────────────────────
    // The id comes from the public college search (never free text). It is
    // re-checked here so a forged, stale or suspended college id is refused.
    if (collegeId === undefined || collegeId === null || collegeId === '') {
      return res.status(400).json({
        success: false,
        message: 'Please search for and select your college.',
        errors: { collegeId: 'Please search for and select your college.' },
      })
    }
    const college = await findActiveCollege(College, collegeId)
    if (!college) {
      return res.status(400).json({
        success: false,
        message: 'The selected college is not available. Please search and select it again.',
        errors: { collegeId: 'The selected college is not available. Please search and select it again.' },
      })
    }

    // ── Check for existing user ───────────────────────────────────────────────
    const normalizedEmail = email.trim().toLowerCase()
    const existingUser = await User.findOne({ email: normalizedEmail })
    if (existingUser) {
      return sendError(res, 'An account with this email already exists.', 409)
    }

    // ── Create the account: ALWAYS pending, tied to the verified college ──────
    // Teachers never start approved, whatever the request body says. The unique
    // email index is the real duplicate guard (two simultaneous signups: one 201, one 409).
    let user
    try {
      user = await User.create({
        name,
        email: normalizedEmail,
        password,
        role: 'teacher',
        approved: false,
        approvalStatus: APPROVAL_STATUS.PENDING,
        collegeId: college.collegeId, // verified server-side id — not the client's raw value
        department: department || '',
        phone: phone || '',
      })
    } catch (err) {
      if (err?.code === 11000) {
        return sendError(res, 'An account with this email already exists.', 409)
      }
      throw err
    }

    // ── Tell the college's admins (best effort — never fails the signup) ──────
    try { await onTeacherRegistered({ teacher: user, college }) } catch { /* ignored */ }

    // No token is issued: the account cannot sign in until an admin of THIS college approves it.
    return sendSuccess(
      res,
      {
        user: user.toPublicJSON(),
        college: { collegeId: college.collegeId, name: college.name },
        status: APPROVAL_STATUS.PENDING,
      },
      `Request sent to ${college.name}. You can sign in once an administrator of that college approves it.`,
      201
    )
  } catch (error) {
    next(error)
  }
}

export const signup = createSignup({
  User, College, findActiveCollege: findActiveCollegeById,
  onTeacherRegistered: (args) => teacherApprovalService.notifyNewRequest(args),
})

// ─── POST /api/auth/login ─────────────────────────────────────────────────────
/**
 * Authenticate a user and return a JWT token.
 *
 * BUG FIX: The original accepted a `role` field in the request body and sent
 * it to the frontend via login(), but the backend never validated it — the
 * frontend role selector was purely cosmetic decoration. Removed the role param
 * from login to avoid confusion; role is determined from the DB record.
 *
 * Response shape: { success, message, data: { token, user } }
 * This shape is what AuthContext.login() expects at res.data.data.
 */
// Unknown e-mail and wrong password must cost the same time, otherwise response time reveals which
// e-mail addresses have an account. A throw-away bcrypt hash (same cost as real ones) is compared instead.
let dummyHashPromise = null
const dummyHash = () => (dummyHashPromise ??= bcrypt.hash('not-a-real-password', 12))

export const createLogin = ({ User, College, issueToken = (u) => generateToken(buildTokenPayload(u)) }) => async (req, res, next) => {
  try {
    const { email, password } = req.body || {}

    // ── Validate required fields ──────────────────────────────────────────────
    if (!email || !password) {
      return sendError(res, 'Email and password are required.', 400)
    }
    if (typeof email !== 'string' || typeof password !== 'string') {
      return sendError(res, 'Invalid email or password.', 400)
    }

    // ── Find user (explicitly select password for comparison) ─────────────────
    const user = await User.findOne({ email: email.toLowerCase() }).select('+password')
    if (!user) {
      await bcrypt.compare(password, await dummyHash()) // same cost as a real check (no timing oracle)
      return sendError(res, 'Invalid email or password.', 401)
    }

    // ── Verify password ───────────────────────────────────────────────────────
    const isMatch = await user.comparePassword(password)
    if (!isMatch) {
      return sendError(res, 'Invalid email or password.', 401)
    }

    // ── Approval gate (teachers) ──────────────────────────────────────────────
    // Only reached with the CORRECT password, so status is never revealed to a
    // stranger. Pending / rejected / unavailable college → 403 with a `code`.
    const eligibility = await checkLoginEligibility({ user, College })
    if (!eligibility.ok) {
      return res.status(eligibility.status).json({
        success: false, message: eligibility.message, code: eligibility.code,
      })
    }

    // ── Generate token ────────────────────────────────────────────────────────
    const token = issueToken(user)

    // ── Respond with token + public user profile ──────────────────────────────
    // Shape: { success: true, message: "...", data: { token, user } }
    // This is the EXACT shape AuthContext.login() reads at res.data.data
    const publicUser = user.toPublicJSON()
    const college = user.collegeId ? await College.findOne({ collegeId: user.collegeId, status: 'active' }).select('collegeId name district country -_id').lean() : null
    return sendSuccess(
      res,
      { token, user: { ...publicUser, college } },
      'Logged in successfully.'
    )
  } catch (error) {
    next(error)
  }
}

export const login = createLogin({ User, College })

// ─── GET /api/auth/me ─────────────────────────────────────────────────────────
/**
 * Get the currently authenticated user's profile.
 * Protected route — requires valid JWT.
 *
 * Response shape: { success, message, data: { user } }
 * This is the EXACT shape AuthContext reads at res.data.data.user
 */
export const getMe = async (req, res, next) => {
  try {
    // req.user was rebuilt from the database by requireApproved (authenticate)
    const user = await User.findById(req.auth.userId)
    if (!user) {
      return sendError(res, 'User not found.', 404)
    }

    const publicUser = user.toPublicJSON()
    const college = user.collegeId ? await College.findOne({ collegeId: user.collegeId }).select('collegeId name district country -_id').lean() : null
    return sendSuccess(res, { user: { ...publicUser, college } }, 'User profile fetched.')
  } catch (error) {
    next(error)
  }
}
