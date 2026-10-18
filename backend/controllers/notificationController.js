import { sendSuccess, sendError } from "../utils/response.js";
import { notificationService } from "../services/approvalWiring.js";

export const createNotificationHandlers = (service) => {
  const wrap = (fn) => async (req, res, next) => { try { await fn(req, res); } catch (e) { next(e); } };
  return {
    list: wrap(async (req, res) =>
      sendSuccess(res, await service.list(req.user.id, { limit: req.query?.limit }), "Notifications fetched.")),
    markRead: wrap(async (req, res) =>
      (await service.markRead(req.user.id, req.params.id))
        ? sendSuccess(res, {}, "Marked as read.")
        : sendError(res, "Notification not found.", 404)),
    markAllRead: wrap(async (req, res) => { await service.markAllRead(req.user.id); sendSuccess(res, {}, "All marked as read."); }),
    remove: wrap(async (req, res) =>
      (await service.remove(req.user.id, req.params.id))
        ? sendSuccess(res, {}, "Notification deleted.")
        : sendError(res, "Notification not found.", 404)),
    clear: wrap(async (req, res) => { await service.clear(req.user.id); sendSuccess(res, {}, "All notifications cleared."); }),
  };
};

export const notificationHandlers = createNotificationHandlers(notificationService);
