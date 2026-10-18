/**
 * Idempotent tidy-up for users created before Part 8: set `approvalStatus`
 * from the legacy `approved` flag. Correctness never depends on this (see
 * utils/approval.js) — it just keeps the data uniform. Returns rows changed.
 */
export const backfillApprovalStatus = async (User) => {
  const a = await User.updateMany(
    { approvalStatus: { $exists: false }, approved: true },
    { $set: { approvalStatus: "approved" } }
  );
  const p = await User.updateMany(
    { approvalStatus: { $exists: false }, approved: { $ne: true } },
    { $set: { approvalStatus: "pending" } }
  );
  return (a?.modifiedCount ?? 0) + (p?.modifiedCount ?? 0);
};
