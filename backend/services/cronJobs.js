/**
 * Cron Job — Trash Cleanup System (Part 19)
 * ──────────────────────────────────────────
 * Automatically permanently deletes attendance records that have been
 * in the trash for more than TRASH_TTL_DAYS (10 days).
 *
 * Schedule: Runs every day at 2:00 AM server time.
 *
 * This is a lightweight pure-Node.js cron — no external cron library needed.
 * It uses setInterval under the hood, scheduled to fire at the next 2 AM.
 */

import Attendance from "../models/Attendance.js";
import { scopedModel } from "../utils/tenantScope.js";
import { TRASH_TTL_DAYS, trashCutoff } from "../utils/trashRules.js";
import { recordActivity } from "./activityLog.js";

const CRON_HOUR = 2; // 2:00 AM
const CRON_MINUTE = 0;

// ─── Cleanup function ─────────────────────────────────────────────────────────
/**
 * Permanently delete attendance sessions that have been in the trash longer than
 * TRASH_TTL_DAYS (10). Returns a summary of the run.
 *
 * Part 16: the purge runs college by college. For every college that has trashed
 * sessions, the work goes through scopedModel(Attendance, { collegeId }), so each
 * delete is pinned to that one college, a failure in one college is recorded and
 * does not stop (or roll back) another, and the summary says what each college
 * lost. The retention rule is the same for all colleges and unchanged: only rows
 * that are ALREADY in the trash (isDeleted: true) and past their window are
 * removed; active sessions are never matched.
 *
 * Inconsistent rows are handled safely:
 *   - flagged deleted but never stamped with deletedAt → they would never expire,
 *     so they are stamped "now" and get the normal 10-day window (nothing is
 *     deleted early, nothing is kept forever);
 *   - sessions of a subject that no longer exists → purged on the same schedule
 *     (they cannot be restored: restore needs the subject).
 *
 * @param {{ now?: number|Date }} [options] `now` is injectable for tests.
 */
export const runTrashCleanup = async ({ now = Date.now() } = {}) => {
  const startTime = new Date(now);
  const wallStart = Date.now(); // `now` may be injected by tests; durations use the real clock
  const cutoff = trashCutoff(startTime);

  console.log(`\n🗑️  [TRASH CLEANUP] Starting cleanup at ${startTime.toISOString()}`);
  console.log(`   Cutoff: records deleted before ${cutoff.toISOString()} will be purged (${TRASH_TTL_DAYS}-day retention).`);

  let cleaned = 0;
  let healed = 0;
  let errors = 0;
  const colleges = [];

  try {
    // Which colleges have anything in their trash? (A read of ids only; every
    // write below is scoped to one of them.) `null` = legacy rows with no college.
    const collegeIds = await Attendance.distinct("collegeId", { isDeleted: true });

    for (const collegeId of collegeIds) {
      const entry = { collegeId: collegeId ?? null, cleaned: 0, healed: 0, error: null };
      try {
        const attendance = scopedModel(Attendance, { collegeId: collegeId ?? null });

        // 1. Start the clock on trashed rows that never got a deletedAt.
        const stamped = await attendance.updateMany(
          { isDeleted: true, deletedAt: null },
          { $set: { deletedAt: startTime } }
        );
        entry.healed = stamped?.modifiedCount ?? 0;

        // 2. Purge what is past retention (trashed AND expired — both in the filter).
        const result = await attendance.deleteMany({ isDeleted: true, deletedAt: { $lte: cutoff } });
        entry.cleaned = result?.deletedCount ?? 0;
        // Part 17: leave a trace in THAT college's own activity log (system actor). The college is the
        // loop variable above — the only tenant context a background job has — never anything global.
        if (entry.cleaned > 0 && collegeId) await recordActivity({ collegeId }, { action: "trash.purge", actorRole: "system", targetType: "college", targetId: collegeId, meta: { purged: entry.cleaned } });
      } catch (error) {
        errors += 1;
        entry.error = error.message;
        console.error(`   ❌ Trash cleanup error for college ${collegeId ?? "(none)"}:`, error.message);
      }
      cleaned += entry.cleaned;
      healed += entry.healed;
      colleges.push(entry);
    }

    const duration = Date.now() - wallStart;
    if (cleaned === 0) console.log("   ✅ No expired trash records found. Nothing to clean up.");
    else console.log(`   ✅ Cleanup complete: ${cleaned} record(s) permanently deleted in ${duration}ms.`);
    if (healed > 0) console.log(`   ℹ️  ${healed} trashed record(s) had no deletedAt; their ${TRASH_TTL_DAYS}-day window starts now.`);

    return { cleaned, healed, errors, colleges, ranAt: startTime, durationMs: duration };
  } catch (error) {
    console.error("   ❌ Trash cleanup error:", error.message);
    return {
      cleaned,
      healed,
      errors: errors + 1,
      colleges,
      errorMessage: error.message,
      ranAt: startTime,
    };
  }
};

// ─── Scheduler ────────────────────────────────────────────────────────────────
/**
 * Calculate milliseconds until the next occurrence of CRON_HOUR:CRON_MINUTE.
 */
const msUntilNextRun = () => {
  const now = new Date();
  const next = new Date(now);
  next.setHours(CRON_HOUR, CRON_MINUTE, 0, 0);

  // If the time has already passed today, schedule for tomorrow
  if (next <= now) {
    next.setDate(next.getDate() + 1);
  }

  return next.getTime() - now.getTime();
};

// ─── Start the cron scheduler ─────────────────────────────────────────────────
/**
 * Initializes the trash cleanup cron job.
 * Call this once at server startup after DB is connected.
 */
export const startTrashCleanupCron = () => {
  const delay = msUntilNextRun();
  const nextRun = new Date(Date.now() + delay);

  console.log(`\n⏰ [CRON] Trash cleanup scheduled.`);
  console.log(`   Next run: ${nextRun.toLocaleString()} (in ${Math.round(delay / 60000)} minutes)`);
  console.log(`   Schedule: Daily at ${String(CRON_HOUR).padStart(2, "0")}:${String(CRON_MINUTE).padStart(2, "0")}`);

  // First run at next scheduled time
  setTimeout(() => {
    runTrashCleanup();

    // Then repeat every 24 hours
    setInterval(runTrashCleanup, 24 * 60 * 60 * 1000);
  }, delay);
};
