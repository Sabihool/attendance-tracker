/**
 * Production wiring: real Mongoose models → services/guards.
 * (Tests build the same services with in-memory fakes instead.)
 */
import User from "../models/User.js";
import College from "../models/College.js";
import Notification from "../models/Notification.js";
import { createNotificationService } from "./notificationService.js";
import { createTeacherApprovalService } from "./teacherApprovalService.js";
import { createRequireCollegeAdmin } from "../middleware/approvalGuards.js";

export const notificationService = createNotificationService({ Notification });
export const teacherApprovalService = createTeacherApprovalService({ User, College, notifier: notificationService });
export const requireCollegeAdmin = createRequireCollegeAdmin({ service: teacherApprovalService });
