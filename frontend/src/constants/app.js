/**
 * constants/app.js
 * Application-wide constants. Import from here instead of hard-coding strings.
 */

// ── Auth ───────────────────────────────────────────────────────────────────────
export const TOKEN_KEY = 'att_token'
export const USER_KEY  = 'att_user'

// ── Roles ─────────────────────────────────────────────────────────────────────
export const ROLES = {
  TEACHER: 'teacher',
  ADMIN: 'admin',
}

// ── Routes ────────────────────────────────────────────────────────────────────
export const ROUTES = {
  HOME: '/',
  LOGIN: '/login',
  SIGNUP: '/signup',
  REGISTER_COLLEGE: '/register-college',
  // Teacher
  TEACHER: '/teacher',
  TEACHER_CREATE_SUBJECT: '/teacher/create-subject',
  TEACHER_SUBJECTS: '/teacher/subjects',
  TEACHER_ATTENDANCE: '/teacher/attendance',
  TEACHER_REPORTS: '/teacher/reports',
  TEACHER_STUDENT_REPORTS: '/teacher/student-reports',
  TEACHER_INDIVIDUAL_REPORT: '/teacher/individual-report',
  TEACHER_EXPORT: '/teacher/export',
  TEACHER_TRASH: '/teacher/trash',
  TEACHER_PROFILE: '/teacher/profile',
  TEACHER_ABSENCE_ALERTS: '/teacher/consecutive-absence-alerts',
  TEACHER_EDIT_ATTENDANCE: '/teacher/edit-attendance',
  // Admin
  ADMIN: '/admin',
  ADMIN_APPROVE_TEACHERS: '/admin/approve-teachers',
  ADMIN_UPLOAD_JSON: '/admin/upload-json',
  ADMIN_STUDENTS: '/admin/students',
  ADMIN_DEPARTMENTS: '/admin/departments',
  ADMIN_SHIFTS: '/admin/shifts',
  ADMIN_ATTENDANCE_CATEGORIES: '/admin/attendance-categories',
  ADMIN_SETTINGS: '/admin/settings',
  ADMIN_TRASH: '/admin/trash',
  ADMIN_STUDENT: (id) => `/admin/student/${id}`,
}

// ── API ────────────────────────────────────────────────────────────────────────
export const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:5000/api'

// ── Attendance ─────────────────────────────────────────────────────────────────
export const ATTENDANCE_THRESHOLD = 75 // % below which student is "at risk"

// ── App ────────────────────────────────────────────────────────────────────────
export const APP_NAME = import.meta.env.VITE_APP_NAME || 'Attendance Tracker'
