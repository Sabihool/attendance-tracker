import mongoose from "mongoose";

/**
 * In-app notification. Always addressed to exactly one user; every read/modify
 * endpoint filters by the caller's own id, so one user can never see or touch
 * another's notifications. Auto-deleted after 90 days (TTL index).
 */
const notificationSchema = new mongoose.Schema({
  userId:    { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  collegeId: { type: String, default: null },
  type: {
    type: String,
    required: true,
    enum: ["teacher_request_new", "teacher_request_approved", "teacher_request_decided", "role_promoted", "role_demoted"],
  },
  title:   { type: String, required: true, maxlength: 120 },
  message: { type: String, required: true, maxlength: 300 },
  data:    { type: mongoose.Schema.Types.Mixed, default: undefined },
  read:    { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now, expires: 60 * 60 * 24 * 90 },
});

notificationSchema.index({ userId: 1, createdAt: -1 });

const Notification = mongoose.model("Notification", notificationSchema);
export default Notification;
