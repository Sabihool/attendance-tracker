/**
 * In-app notification service (dependency-injected; no framework imports).
 * Every method that reads or changes a notification takes the CALLER'S userId
 * and filters on it — a notification id alone is never enough.
 */
import { isObjectIdString } from "../utils/approval.js";

const clip = (s, n) => String(s ?? "").slice(0, n);

export const toClientNotification = (n) => ({
  id: String(n._id),
  type: n.type,
  title: n.title,
  message: n.message,
  read: !!n.read,
  createdAt: n.createdAt,
  data: n.data || null,
});

export const createNotificationService = ({ Notification }) => ({
  /** Fire-and-forget safe: callers wrap in try/catch so a failure never breaks the main action. */
  async createMany(items) {
    const docs = (items || []).filter((i) => i && i.userId).map((i) => ({
      userId: i.userId,
      collegeId: i.collegeId ?? null,
      type: i.type,
      title: clip(i.title, 120),
      message: clip(i.message, 300),
      data: i.data,
      read: false,
    }));
    if (docs.length === 0) return 0;
    await Notification.insertMany(docs, { ordered: false });
    return docs.length;
  },

  async list(userId, { limit = 50 } = {}) {
    const n = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 100);
    const rows = await Notification.find({ userId }).sort({ createdAt: -1 }).limit(n).lean();
    const unread = await Notification.countDocuments({ userId, read: false });
    return { notifications: rows.map(toClientNotification), unread };
  },

  async markRead(userId, id) {
    if (!isObjectIdString(id)) return false;
    const r = await Notification.updateOne({ _id: id, userId }, { $set: { read: true } });
    return (r?.matchedCount ?? r?.n ?? 0) > 0;
  },

  async markAllRead(userId) {
    await Notification.updateMany({ userId, read: false }, { $set: { read: true } });
  },

  async remove(userId, id) {
    if (!isObjectIdString(id)) return false;
    const r = await Notification.deleteOne({ _id: id, userId });
    return (r?.deletedCount ?? 0) > 0;
  },

  async clear(userId) {
    await Notification.deleteMany({ userId });
  },
});
