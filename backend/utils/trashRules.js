/**
 * Trash retention rules and small null-safe helpers shared by the trash
 * controller, the nightly cleanup and the ownership checks (Part 16).
 *
 * Retention is unchanged: a record stays in the trash for TRASH_TTL_DAYS (10)
 * days after `deletedAt`, can be restored during that window, and is purged
 * by the nightly cleanup afterwards.
 */
export const TRASH_TTL_DAYS = 10;
export const TRASH_TTL_MS = TRASH_TTL_DAYS * 24 * 60 * 60 * 1000;

/** Records trashed at or before this instant are past their retention window. */
export const trashCutoff = (now = Date.now()) => new Date(new Date(now).getTime() - TRASH_TTL_MS);

/**
 * When a trashed record expires, or null when it has no usable `deletedAt`
 * (an inconsistent row: flagged as deleted but never stamped). Callers must
 * handle null instead of crashing — see healUnstampedTrash in cronJobs.js.
 */
export const trashExpiryDate = (deletedAt) => {
  if (!deletedAt) return null;
  const t = new Date(deletedAt).getTime();
  return Number.isNaN(t) ? null : new Date(t + TRASH_TTL_MS);
};

/**
 * Does `userId` own a record whose owner field is `ownerRef`? Null-safe: a
 * record whose teacher was deleted (ownerRef null/undefined) is owned by nobody,
 * so a teacher is refused with 403 instead of the request crashing with a 500.
 * Admins are not affected by this check (they are checked by college elsewhere).
 */
export const isOwnedBy = (ownerRef, userId) =>
  ownerRef != null && userId != null && String(ownerRef?._id ?? ownerRef) === String(userId);
