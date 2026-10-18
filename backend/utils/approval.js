/**
 * Teacher approval helpers (pure — no database / framework imports).
 *
 * A teacher account has TWO fields that must always agree:
 *   approved        Boolean  — what every access check reads (legacy field, kept)
 *   approvalStatus  String   — 'pending' | 'approved' | 'rejected' (new, Part 8)
 *
 * Accounts created before Part 8 have no `approvalStatus`; they are interpreted
 * from `approved` (true → approved, false → pending). No migration is required
 * for correctness (a startup backfill just tidies the data).
 */
export const APPROVAL_STATUS = Object.freeze({
  PENDING: "pending",
  APPROVED: "approved",
  REJECTED: "rejected",
});

/** Status for display / filtering. */
export const effectiveApprovalStatus = (u) => {
  if (!u) return null;
  if (u.approvalStatus) return u.approvalStatus;
  return u.approved ? APPROVAL_STATUS.APPROVED : APPROVAL_STATUS.PENDING;
};

/**
 * Access gate: BOTH fields must say "approved". An inconsistent record
 * (approved:true + approvalStatus:'rejected', or the reverse) is denied.
 * Admins are always approved at creation, so this applies to them too.
 */
export const isAccessApproved = (u) =>
  !!u && u.approved === true && (!u.approvalStatus || u.approvalStatus === APPROVAL_STATUS.APPROVED);

/**
 * Mongo filter for "pending". `$nin` also matches documents where the field is
 * missing, so legacy rows (approved:false, no approvalStatus) count as pending.
 */
export const PENDING_FILTER = Object.freeze({
  approved: false,
  approvalStatus: { $nin: [APPROVAL_STATUS.APPROVED, APPROVAL_STATUS.REJECTED] },
});

export const isObjectIdString = (v) => typeof v === "string" && /^[0-9a-fA-F]{24}$/.test(v);

/** Safe public projection of a user (never includes the password hash). */
export const buildPublicUser = (u) => ({
  _id: u._id,
  name: u.name,
  email: u.email,
  role: u.role,
  approved: u.approved,
  approvalStatus: effectiveApprovalStatus(u),
  collegeId: u.collegeId || null,
  department: u.department,
  phone: u.phone,
  createdAt: u.createdAt,
  updatedAt: u.updatedAt,
});
