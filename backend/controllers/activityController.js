/**
 * GET /api/admin/activity — the college's own activity log (admin only).
 * The college comes from req.tenant (database session); the query cannot name one.
 */
import { listActivity } from "../services/activityLog.js";

export const getActivity = async (req, res, next) => {
  try {
    const r = await listActivity(req.tenant, req.query || {});
    if (!r.ok) return res.status(r.status).json({ success: false, message: r.message, code: r.code });
    return res.status(200).json({ success: true, message: r.message, data: r.data });
  } catch (err) {
    next(err);
  }
};
