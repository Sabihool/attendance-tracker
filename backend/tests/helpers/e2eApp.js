/**
 * End-to-end test app: the REAL routers, middleware (JWT → database session →
 * tenant context → role), controllers and Mongoose models, over real HTTP,
 * on top of the fake driver from ./mongooseFake.js.
 */
import "./mongooseFake.js"; // must be first: configures Mongoose before models compile
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-test-secret-test-secret-123";

import express from "express";
import { installFakeDb, buildSchemaIndexes, mongoose } from "./mongooseFake.js";
import { errorHandler } from "../../middleware/errorMiddleware.js";
import { generateToken, buildTokenPayload } from "../../utils/token.js";
import College from "../../models/College.js";
import User from "../../models/User.js";
import Subject from "../../models/Subject.js";
import Student from "../../models/Student.js";
import Department from "../../models/Department.js";
import Shift from "../../models/Shift.js";
import Attendance from "../../models/Attendance.js";
import ConsecutiveAbsenceAlert from "../../models/ConsecutiveAbsenceAlert.js";
import AttendanceCategory from "../../models/AttendanceCategory.js";
import Settings from "../../models/Settings.js";
import ActivityLog from "../../models/ActivityLog.js";
import { seedCollegeDefaults } from "../../services/academicDefaults.js";

import publicAttendanceRoutes from "../../routes/publicAttendanceRoutes.js";
import departmentRoutes from "../../routes/departmentRoutes.js";
import shiftRoutes from "../../routes/shiftRoutes.js";
import subjectRoutes from "../../routes/subjectRoutes.js";
import attendanceRoutes from "../../routes/attendanceRoutes.js";
import exportRoutes from "../../routes/exportRoutes.js";
import studentRoutes from "../../routes/studentRoutes.js";
import academicStructureRoutes from "../../routes/academicStructureRoutes.js";
import teacherPerformanceRoutes from "../../routes/teacherPerformanceRoutes.js";
import subjectAnalyticsRoutes from "../../routes/subjectAnalyticsRoutes.js";
import alertsRoutes from "../../routes/alertsRoutes.js";
import attendanceCategoryRoutes from "../../routes/attendanceCategoryRoutes.js";
import settingsRoutes from "../../routes/settingsRoutes.js";
import { trashRouter, adminTrashRouter } from "../../routes/trashRoutes.js";
import teacherManagementRoutes from "../../routes/teacherManagementRoutes.js";
import authRoutes from "../../routes/authRoutes.js";
import activityRoutes from "../../routes/activityRoutes.js";
import backupRoutes from "../../routes/backupRoutes.js";
import collegeRoutes from "../../routes/collegeRoutes.js";
import teacherRequestRoutes from "../../routes/teacherRequestRoutes.js";
import notificationRoutes from "../../routes/notificationRoutes.js";

export const models = { College, User, Subject, Student, Department, Shift, Attendance, ConsecutiveAbsenceAlert, AttendanceCategory, Settings, ActivityLog };

export const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.use("/api/public/attendance", publicAttendanceRoutes);
  app.use("/api/departments", departmentRoutes);
  app.use("/api/shifts", shiftRoutes);
  app.use("/api/attendance-categories", attendanceCategoryRoutes);
  app.use("/api/settings", settingsRoutes);
  app.use("/api/subjects", subjectRoutes);
  app.use("/api/students", studentRoutes);
  app.use("/api/attendance/:subjectId", attendanceRoutes);
  app.use("/api/export/:subjectId", exportRoutes);
  app.use("/api/alerts", alertsRoutes);
  app.use("/api/trash/:subjectId", trashRouter);
  app.use("/api/admin/trash", adminTrashRouter);
  app.use("/api/admin/teachers", teacherManagementRoutes);
  app.use("/api/auth", authRoutes);
  app.use("/api/admin/teacher-performance", teacherPerformanceRoutes);
  app.use("/api/admin/subjects", subjectAnalyticsRoutes);
  app.use("/api/admin/academic-structure", academicStructureRoutes);
  app.use("/api/admin/activity", activityRoutes);
  app.use("/api/admin/backups", backupRoutes);
  app.use("/api/colleges", collegeRoutes);
  app.use("/api/admin/teacher-requests", teacherRequestRoutes);
  app.use("/api/notifications", notificationRoutes);
  app.use((_req, res) => res.status(404).json({ success: false, message: "Route not found" }));
  app.use(errorHandler);
  return app;
};

/** Fresh empty database + HTTP server. Returns { fakes, call, close }. */
export const startApp = async ({ schemaIndexes = true } = {}) => {
  const fakes = installFakeDb();
  if (schemaIndexes) await buildSchemaIndexes();
  const server = await new Promise((r) => { const s = buildApp().listen(0, "127.0.0.1", () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const origError = console.error;
  console.error = () => {}; // the error middleware logs every 4xx; keep test output readable
  const call = async (token, method, path, { body, query } = {}) => {
    const url = base + path + (query ? `?${new URLSearchParams(query)}` : "");
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json = null;
    try { json = await res.json(); } catch { /* empty */ }
    return { status: res.status, body: json, data: json?.data };
  };
  /**
   * multipart/form-data POST, like the Upload Students page sends:
   * `fields` become form fields, `content` (string or JSON-serialisable value)
   * becomes the "file" part. Omit `content` to send no file.
   */
  const upload = async (token, path, { fields = {}, content, filename = "students.json", contentType = "application/json" } = {}) => {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.append(k, v);
    if (content !== undefined) {
      const text = typeof content === "string" ? content : JSON.stringify(content);
      fd.append("file", new Blob([text], { type: contentType }), filename);
    }
    const res = await fetch(base + path, { method: "POST", headers: token ? { Authorization: `Bearer ${token}` } : {}, body: fd });
    let json = null;
    try { json = await res.json(); } catch { /* empty */ }
    return { status: res.status, body: json, data: json?.data };
  };
  const close = () => { console.error = origError; return new Promise((r) => server.close(r)); };
  return { fakes, call, upload, close, baseUrl: base };
};

let n = 0;
/** Create a college with an approved admin and an approved teacher; returns ids + tokens. */
export const makeCollege = async (name, { seedDefaults = false } = {}) => {
  // Ids must match the production pattern (COL-+10 chars of the id alphabet: no 0/1/I/L/O/U),
  // because public endpoints validate the format. n=1 -> COL-2222222223, n=2 -> COL-2222222224, ...
  const ALPHA = "23456789ABCDEFGHJKMNPQRSTVWXYZ";
  let rest = ++n, tail = "";
  do { tail = ALPHA[rest % ALPHA.length] + tail; rest = Math.floor(rest / ALPHA.length); } while (rest > 0);
  const collegeId = `COL-${tail.padStart(10, "2")}`;
  await College.create({ collegeId, name, country: "Bangladesh", district: "Feni", dedupeKey: `${name}|bd|feni|${collegeId}`, status: "active" });
  const mk = (role, i) => User.create({
    name: `${name} ${role}`, email: `${role}${i}.${collegeId.toLowerCase()}@example.com`, password: "secret123",
    role, approved: true, approvalStatus: "approved", collegeId,
  });
  const admin = await mk("admin", 1);
  // Same as registerCollege(): the registering admin is recorded as the college's founder (protected from demotion).
  await College.updateOne({ collegeId }, { $set: { createdBy: admin._id } });
  const teacher = await mk("teacher", 1);
  if (seedDefaults) await seedCollegeDefaults(collegeId);
  const tok = (u) => generateToken(buildTokenPayload(u));
  return { collegeId, admin, teacher, adminToken: tok(admin), teacherToken: tok(teacher), mkTeacher: async () => {
    const t = await mk("teacher", ++n); return { user: t, token: tok(t) };
  } };
};

export { mongoose };
