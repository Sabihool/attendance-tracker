import { sendSuccess, sendError } from "../utils/response.js";
import { getOrCreateSettings } from "../utils/settingsUtils.js";

// ─── GET /api/settings ──────────────────────────────────────────────────────
// Any authenticated user of a college can read THEIR COLLEGE's settings
// (teachers need the alert threshold context too). Only admins can change them,
// and only their own college's (Part 12: settings are per college).
export const getSettings = async (req, res, next) => {
  try {
    const settings = await getOrCreateSettings(req.tenant);
    return sendSuccess(res, { settings: settings.toPublicJSON() });
  } catch (err) {
    next(err);
  }
};

// ─── PUT /api/settings ──────────────────────────────────────────────────────
// Admin only: update global settings. Currently supports:
//   consecutiveAbsenceLimit — number of consecutive absences before an alert
//                             is automatically raised (replaces hardcoded 3).
export const updateSettings = async (req, res, next) => {
  try {
    const { consecutiveAbsenceLimit } = req.body;
    const settings = await getOrCreateSettings(req.tenant);

    if (consecutiveAbsenceLimit !== undefined) {
      const n = Number(consecutiveAbsenceLimit);
      if (!Number.isInteger(n) || n < 1 || n > 100) {
        return sendError(res, "Consecutive absence limit must be a whole number between 1 and 100.", 400);
      }
      settings.consecutiveAbsenceLimit = n;
    }

    settings.updatedBy = req.user?.id;
    await settings.save();

    return sendSuccess(res, { settings: settings.toPublicJSON() }, "Settings updated successfully.");
  } catch (err) {
    next(err);
  }
};
