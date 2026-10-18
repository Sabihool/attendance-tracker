/** Production wiring for teacher management (tests build the same service on the fake driver). */
import User from "../models/User.js";
import Subject from "../models/Subject.js";
import Attendance from "../models/Attendance.js";
import { teacherApprovalService, notificationService } from "./approvalWiring.js";
import { accountSecurityService } from "./securityWiring.js";
import { createTeacherManagementService } from "./teacherManagementService.js";

export const teacherManagementService = createTeacherManagementService({
  User, Subject, Attendance,
  approvalService: teacherApprovalService,
  accountSecurity: accountSecurityService,
  notifier: notificationService,
});
