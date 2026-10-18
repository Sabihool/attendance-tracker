/**
 * ActivityLog — a college-scoped audit trail (Part 17).
 *
 * One row per significant action: report/backup downloads, backup restores,
 * attendance edits, subject deletes, teacher approvals, trash purges...
 *
 * TENANCY: every row carries the college it happened in (`collegeId`, immutable,
 * set from the server-side session — never from the request). All reads go
 * through scopedModel(ActivityLog, tenant), so an admin can only ever list their
 * own college's rows. `null` = a legacy college-less install (isolated like
 * every other legacy row).
 *
 * WHAT IS (NOT) STORED: ids, a short action code and a small whitelisted `meta`
 * object only. Never a request body, token, password, e-mail, database URI or
 * file content. Rows expire after ACTIVITY_LOG_TTL_DAYS (TTL index) so the log
 * cannot grow without bound.
 */
import mongoose from "mongoose";

export const ACTIVITY_LOG_TTL_DAYS = Math.max(1, parseInt(process.env.ACTIVITY_LOG_TTL_DAYS, 10) || 180);

const activityLogSchema = new mongoose.Schema(
  {
    collegeId: { type: String, trim: true, default: null, immutable: true },
    // Who did it. `system` rows (background jobs) have no actor id.
    actorId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    actorRole: { type: String, enum: ["admin", "teacher", "system"], required: true },
    action: { type: String, required: true, trim: true, maxlength: 60 },
    targetType: { type: String, trim: true, maxlength: 30, default: null },
    targetId: { type: String, trim: true, maxlength: 40, default: null },
    status: { type: String, enum: ["success", "failed"], default: "success" },
    meta: { type: mongoose.Schema.Types.Mixed, default: null },
    createdAt: { type: Date, default: Date.now, immutable: true },
  },
  { versionKey: false }
);

// Newest-first listing inside one college, plus the actor / action filters.
activityLogSchema.index({ collegeId: 1, createdAt: -1 });
activityLogSchema.index({ collegeId: 1, actorId: 1, createdAt: -1 });
activityLogSchema.index({ collegeId: 1, action: 1, createdAt: -1 });
// Retention.
activityLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: ACTIVITY_LOG_TTL_DAYS * 86400 });

export default mongoose.models.ActivityLog || mongoose.model("ActivityLog", activityLogSchema);
