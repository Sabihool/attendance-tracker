/**
 * services/api.js
 * All API calls. Imports the configured axios instance from lib/axios.js.
 */
import axiosInstance from '@/lib/axios'
import { stripCollegeFields, stripCollegeFormData } from '../utils/academicStructure.js'
import { pickSubjectFields, SUBJECT_CREATE_FIELDS, SUBJECT_EDIT_FIELDS } from '../utils/subjectForm.js'

// ── Helper ────────────────────────────────────────────────────────────────────
export const getErrorMessage = (error) =>
  error?.response?.data?.message ||
  error?.response?.data?.error ||
  error?.message ||
  'Something went wrong'

// ── AUTH ──────────────────────────────────────────────────────────────────────
export const authAPI = {
  login:       (data)   => axiosInstance.post('/auth/login', data),
  signup:      (data)   => axiosInstance.post('/auth/signup', data),
  registerCollege: (data) => axiosInstance.post('/colleges/register', data),
  getMe:       ()       => axiosInstance.get('/auth/me'),
  getUsers:    (params) => axiosInstance.get('/auth/users', { params }),
  approveUser: (id)     => axiosInstance.patch(`/auth/users/${id}/approve`),
  rejectUser:  (id)     => axiosInstance.patch(`/auth/users/${id}/reject`),
  deleteUser:  (id)     => axiosInstance.delete(`/auth/users/${id}`),
}

// ── TEACHER REQUESTS (college admin) ─────────────────────────────────────────
// Always scoped to the logged-in admin's own college by the server.
export const teacherRequestAPI = {
  list:    (params) => axiosInstance.get('/admin/teacher-requests', { params }),
  summary: ()       => axiosInstance.get('/admin/teacher-requests/summary'),
  approve: (id)     => axiosInstance.patch(`/admin/teacher-requests/${id}/approve`),
  reject:  (id)     => axiosInstance.patch(`/admin/teacher-requests/${id}/reject`),
}

// ── TEACHER MANAGEMENT (college admin, Part 15) ──────────────────────────────
// The server derives the college and the acting admin from the session. Promote/demote
// are separate endpoints with NO body: a role is never sent from the client.
export const teacherManagementAPI = {
  list:    (params) => axiosInstance.get('/admin/teachers', { params }),
  summary: ()       => axiosInstance.get('/admin/teachers/summary'),
  detail:  (id)     => axiosInstance.get(`/admin/teachers/${id}`),
  approve: (id)     => axiosInstance.patch(`/admin/teachers/${id}/approve`),
  reject:  (id)     => axiosInstance.patch(`/admin/teachers/${id}/reject`),
  promote: (id)     => axiosInstance.patch(`/admin/teachers/${id}/promote`),
  demote:  (id)     => axiosInstance.patch(`/admin/teachers/${id}/demote`),
  remove:  (id)     => axiosInstance.delete(`/admin/teachers/${id}`),
}

// ── NOTIFICATIONS (per user, stored on the server) ───────────────────────────
export const notificationAPI = {
  list:        ()   => axiosInstance.get('/notifications'),
  markRead:    (id) => axiosInstance.patch(`/notifications/${id}/read`),
  markAllRead: ()   => axiosInstance.patch('/notifications/read-all'),
  remove:      (id) => axiosInstance.delete(`/notifications/${id}`),
  clear:       ()   => axiosInstance.delete('/notifications'),
}

// ── COLLEGES (public) ─────────────────────────────────────────────────────────
// Autocomplete lookup used by teacher signup. Returns { colleges: [{ collegeId,
// name, district, country }] }. Pass an AbortSignal to cancel stale requests.
export const collegeAPI = {
  search: (q, { signal, limit = 8 } = {}) =>
    axiosInstance.get('/colleges/search', { params: { q, limit }, signal }),
}

// ── PUBLIC ATTENDANCE LOOKUP (no login) ───────────────────────────────────────
// Student "See Your Attendance". The token is deliberately NOT attached.
export const publicAttendanceAPI = {
  lookup: (payload, { signal } = {}) =>
    axiosInstance.post('/public/attendance/lookup', payload, { signal, skipAuth: true }),
}

// ── DEPARTMENTS ───────────────────────────────────────────────────────────────
export const departmentAPI = {
  getAll: ()          => axiosInstance.get('/departments'),
  create: (name)      => axiosInstance.post('/departments', { name }),
  update: (id, name)  => axiosInstance.put(`/departments/${id}`, { name }),
  delete: (id)        => axiosInstance.delete(`/departments/${id}`),
}

// ── SHIFTS (admin-managed — replaces hardcoded morning/day/afternoon) ─────────
export const shiftAPI = {
  getAll: ()          => axiosInstance.get('/shifts'),
  create: (data)      => axiosInstance.post('/shifts', stripCollegeFields(data)),
  update: (id, data)  => axiosInstance.put(`/shifts/${id}`, stripCollegeFields(data)),
  delete: (id)        => axiosInstance.delete(`/shifts/${id}`),
}

// ── ATTENDANCE CATEGORIES (admin-managed — replaces hardcoded class types) ────
export const attendanceCategoryAPI = {
  getAll: ()          => axiosInstance.get('/attendance-categories'),
  create: (data)      => axiosInstance.post('/attendance-categories', data),
  update: (id, data)  => axiosInstance.put(`/attendance-categories/${id}`, data),
  delete: (id)        => axiosInstance.delete(`/attendance-categories/${id}`),
}

// ── SETTINGS (admin-controlled global config) ─────────────────────────────────
export const settingsAPI = {
  get:    ()     => axiosInstance.get('/settings'),
  update: (data) => axiosInstance.put('/settings', data),
}

// ── SUBJECTS ──────────────────────────────────────────────────────────────────
export const subjectAPI = {
  getMeta: ()         => axiosInstance.get('/subjects/meta'),
  // params: search, batch, department, shift, archived, sort — and, for admins, teacherId.
  // Always limited to the signed-in user's college by the server.
  getAll:  (params)   => axiosInstance.get('/subjects', { params }),
  // Admin only: approved teachers of the admin's own college (assignment selector).
  getTeachers: ()     => axiosInstance.get('/subjects/teachers'),
  getById: (id)       => axiosInstance.get(`/subjects/${id}`),
  // Payloads are reduced to the fields the API accepts; a college id is never sent.
  // `teacherId` (admins only) assigns the subject to a teacher of the same college.
  create:  (data)     => axiosInstance.post('/subjects', pickSubjectFields(stripCollegeFields(data), SUBJECT_CREATE_FIELDS)),
  update:  (id, data) => axiosInstance.put(`/subjects/${id}`, pickSubjectFields(stripCollegeFields(data), SUBJECT_EDIT_FIELDS)),
  // `acknowledged: true` must be sent only after the teacher has downloaded
  // a backup of the subject's attendance records (see DeleteSubjectModal) —
  // the backend rejects the permanent deletion otherwise.
  delete:  (id, acknowledged = false) => axiosInstance.delete(`/subjects/${id}`, { data: { acknowledged } }),
}

// ── ATTENDANCE ────────────────────────────────────────────────────────────────
export const attendanceAPI = {
  getAll:        (subjectId, params)    => axiosInstance.get(`/attendance/${subjectId}`, { params }),
  getById:       (subjectId, sessionId) => axiosInstance.get(`/attendance/${subjectId}/session/${sessionId}`),
  getPercentage: (subjectId, params)    => axiosInstance.get(`/attendance/${subjectId}/percentage`, { params }),
  getDates:      (subjectId)            => axiosInstance.get(`/attendance/${subjectId}/dates`),
  save:          (subjectId, data)      => axiosInstance.post(`/attendance/${subjectId}`, data),
  update:        (subjectId, sessionId, data) => axiosInstance.put(`/attendance/${subjectId}/session/${sessionId}`, data),
  delete:        (subjectId, sessionId) => axiosInstance.delete(`/attendance/${subjectId}/session/${sessionId}`),
}

// ── STUDENTS ──────────────────────────────────────────────────────────────────
export const studentAPI = {
  getAll:      (params)   => axiosInstance.get('/students', { params }),
  getGroups:   ()         => axiosInstance.get('/students/groups'),
  // Batches sourced only from uploaded data — never generated (spec section 9)
  getBatches:  (params)   => axiosInstance.get('/students/batches', { params }),
  upload:      (formData) => axiosInstance.post('/students/upload', stripCollegeFormData(formData), {
    headers: { 'Content-Type': 'multipart/form-data' },
  }),
  deleteGroup: (data)     => axiosInstance.delete('/students/group', { data: stripCollegeFields(data) }),

  // Admin individual student management (spec section 8)
  adminGetAll: (params)     => axiosInstance.get('/students/admin', { params }),
  adminCreate: (data)       => axiosInstance.post('/students/admin', stripCollegeFields(data)),
  adminUpdate: (id, data)   => axiosInstance.put(`/students/admin/${id}`, stripCollegeFields(data)),
  adminDelete: (id, hard)   => axiosInstance.delete(`/students/admin/${id}`, { params: hard ? { hard: true } : {} }),

  // Global Student Directory (Feature 3) — every student, with computed
  // Overall Attendance %, Credit Score, and Total Subjects.
  getDirectory: (params)    => axiosInstance.get('/students/directory', { params }),
}

// ── EXPORT ────────────────────────────────────────────────────────────────────
export const exportAPI = {
  getMeta:       (subjectId, params) => axiosInstance.get(`/export/${subjectId}/meta`, { params }),
  downloadPDF:   (subjectId, params) => axiosInstance.get(`/export/${subjectId}/pdf`,   { params, responseType: 'blob' }),
  downloadExcel: (subjectId, params) => axiosInstance.get(`/export/${subjectId}/excel`, { params, responseType: 'blob' }),
  downloadCSV:   (subjectId, params) => axiosInstance.get(`/export/${subjectId}/csv`,   { params, responseType: 'blob' }),
  // Printable session-by-session attendance register (one column per date) —
  // also used as the mandatory pre-deletion backup.
  downloadRegisterPDF: (subjectId, params) => axiosInstance.get(`/export/${subjectId}/register/pdf`, { params, responseType: 'blob' }),
  // ZIP containing both the register PDF and the matrix CSV, in a
  // SubjectName_Attendance/ folder — the "download both" backup option.
  downloadRegisterZip: (subjectId, params) => axiosInstance.get(`/export/${subjectId}/register/zip`, { params, responseType: 'blob' }),
}

// ── TRASH ─────────────────────────────────────────────────────────────────────
export const trashAPI = {
  getTrash:        (subjectId)     => axiosInstance.get(`/trash/${subjectId}`),
  restore:         (subjectId, id) => axiosInstance.post(`/trash/${subjectId}/restore/${id}`),
  permanentDelete: (subjectId, id) => axiosInstance.delete(`/trash/${subjectId}/permanent/${id}`),
  emptyTrash:      (subjectId)     => axiosInstance.delete(`/trash/${subjectId}/empty`),
  // Admin
  adminGetAll:   (params) => axiosInstance.get('/admin/trash', { params }),
  adminGetStats: ()       => axiosInstance.get('/admin/trash/stats'),
}

// ── COLLEGE BACKUPS (admin; server derives tenant from authenticated session) ──
export const backupAPI = {
  download: () => axiosInstance.get('/admin/backups/college', { responseType: 'blob' }),
  previewRestore: (file) => { const body = new FormData(); body.append('file', file); return axiosInstance.post('/admin/backups/college/restore/preview', body, { headers: { 'Content-Type': 'multipart/form-data' } }) },
  restore: (file) => { const body = new FormData(); body.append('file', file); body.append('confirm', 'RESTORE'); return axiosInstance.post('/admin/backups/college/restore', body, { headers: { 'Content-Type': 'multipart/form-data' } }) },
}

// ── COLLEGE ACTIVITY LOG (admin; server enforces current-college scope) ────────
export const activityAPI = {
  list: (params) => axiosInstance.get('/admin/activity', { params }),
}

// ── TEACHER PERFORMANCE (admin) ────────────────────────────────────────────────
export const teacherPerformanceAPI = {
  getAll:         (params) => axiosInstance.get('/admin/teacher-performance', { params }),
  getSummary:     ()       => axiosInstance.get('/admin/teacher-performance/summary'),
  getDepartments: ()       => axiosInstance.get('/admin/teacher-performance/departments'),
}

// ── SUBJECT ANALYTICS (admin — All Subjects) ──────────────────────────────────
export const subjectAnalyticsAPI = {
  getAll:  (params) => axiosInstance.get('/admin/subjects', { params }),
  getMeta: ()        => axiosInstance.get('/admin/subjects/meta'),
}

// ── ACADEMIC STRUCTURE (admin — Department → Batch → Shift hierarchy) ────────
export const academicStructureAPI = {
  getAll:     (params) => axiosInstance.get('/admin/academic-structure', { params }),
  getSummary: ()       => axiosInstance.get('/admin/academic-structure/summary'),
}

// ── ALERTS ────────────────────────────────────────────────────────────────────
export const alertsAPI = {
  getAll:              (params)      => axiosInstance.get('/alerts', { params }),
  create:              (data)        => axiosInstance.post('/alerts/create', data),
  remove:              (id)          => axiosInstance.patch(`/alerts/${id}/remove`),
  updateNote:          (id, note)    => axiosInstance.patch(`/alerts/${id}/note`, { note }),
  getStudentAnalytics: (studentId)   => axiosInstance.get(`/alerts/student/${studentId}/analytics`),
}

// ── FILE DOWNLOAD HELPER ──────────────────────────────────────────────────────
export const downloadBlob = (blob, filename) => {
  const url = URL.createObjectURL(blob)
  const a   = document.createElement('a')
  a.href     = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

export default axiosInstance
