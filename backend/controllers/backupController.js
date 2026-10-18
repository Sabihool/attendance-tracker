/**
 * College backup endpoints (Part 17). See services/collegeBackupService.js for the
 * architecture note: these are COLLEGE-level; the platform-wide database backup is
 * not reachable from here.
 *
 *   GET  /api/admin/backups/college             download this college's signed backup (JSON)
 *   POST /api/admin/backups/college/restore/preview   dry run: what a restore WOULD add
 *   POST /api/admin/backups/college/restore           merge-only restore (needs confirm=RESTORE)
 *
 * The college is req.tenant.collegeId (database session). Nothing is stored on the
 * server and no backup has an id or URL: the file is generated per request for the
 * caller's own college, so there is nothing to guess or enumerate.
 */
import { createCollegeBackup, restoreCollegeBackup } from "../services/collegeBackupService.js";
import { recordActivity } from "../services/activityLog.js";

const sendFail = (res, r) => res.status(r.status).json({ success: false, message: r.message, code: r.code });

const stamp = (d) => d.toISOString().replace(/[-:]/g, "").slice(0, 13); // 20261017T0950

export const downloadCollegeBackup = async (req, res, next) => {
  try {
    const r = await createCollegeBackup(req.tenant);
    if (!r.ok) return sendFail(res, r);
    const name = `college-backup-${String(req.tenant.collegeId).replace(/[^A-Za-z0-9_-]/g, "")}-${stamp(new Date(r.file.manifest.createdAt))}.json`;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${name}"`);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    await recordActivity(req.tenant, { action: "backup.create", targetType: "college", targetId: req.tenant.collegeId, meta: { ...r.file.manifest.counts } });
    return res.status(200).send(JSON.stringify(r.file));
  } catch (err) {
    next(err);
  }
};

const readUploadedBackup = (req) => {
  if (!req.file?.buffer) return { ok: false, status: 400, code: "BACKUP_MISSING", message: 'Attach the backup file in the "file" field.' };
  try {
    return { ok: true, file: JSON.parse(req.file.buffer.toString("utf8")) };
  } catch {
    return { ok: false, status: 400, code: "BACKUP_INVALID", message: "This is not a college backup file." };
  }
};

const runRestore = (dryRun) => async (req, res, next) => {
  try {
    const parsed = readUploadedBackup(req);
    if (!parsed.ok) return sendFail(res, parsed);

    if (!dryRun && req.body?.confirm !== "RESTORE") {
      return sendFail(res, { status: 400, code: "CONFIRM_REQUIRED", message: 'Send confirm=RESTORE to restore. Run the preview first to see what will be added.' });
    }

    const r = await restoreCollegeBackup(req.tenant, parsed.file, { dryRun });
    if (!r.ok) {
      await recordActivity(req.tenant, { action: "backup.restore_refused", status: "failed", targetType: "college", targetId: req.tenant.collegeId, meta: { code: r.code, dryRun } });
      return sendFail(res, r);
    }
    await recordActivity(req.tenant, {
      action: dryRun ? "backup.restore_preview" : "backup.restore", targetType: "college", targetId: req.tenant.collegeId,
      meta: { inserted: r.totals.inserted, toInsert: r.totals.toInsert, existing: r.totals.existing, skipped: r.totals.missingReference + r.totals.conflict + r.totals.invalid },
    });
    return res.status(200).json({
      success: true,
      message: dryRun ? "Preview only — nothing was changed." : "Restore finished. Existing records were left untouched.",
      data: { dryRun: r.dryRun, backupCreatedAt: r.createdAt, mode: "merge-only", totals: r.totals, collections: r.summary },
    });
  } catch (err) {
    next(err);
  }
};

export const previewCollegeRestore = runRestore(true);
export const applyCollegeRestore = runRestore(false);
