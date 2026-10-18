/**
 * routes/AppRoutes.jsx
 * All application routes in one place.
 */
import { Routes, Route } from 'react-router-dom'
import { lazy, Suspense } from 'react'
import DashboardLayout from '@/layouts/DashboardLayout'
import AdminLayout from '@/layouts/AdminLayout'
import ProtectedRoute from '@components/common/ProtectedRoute'

// ── Auth pages (eagerly loaded — small and always needed) ─────────────────────
import HomePage    from '@pages/auth/HomePage'
import LoginPage   from '@pages/auth/LoginPage'
import SignupPage  from '@pages/auth/SignupPage'
import RegisterCollegePage from '@pages/auth/RegisterCollegePage'
import NotFoundPage from '@pages/auth/NotFoundPage'

// ── Teacher pages (lazy) ──────────────────────────────────────────────────────
const TeacherDashboardPage          = lazy(() => import('@pages/teacher/TeacherDashboardPage'))
const CreateSubjectPage             = lazy(() => import('@pages/teacher/CreateSubjectPage'))
const SubjectListPage               = lazy(() => import('@pages/teacher/SubjectListPage'))
const TakeAttendancePage            = lazy(() => import('@pages/teacher/TakeAttendancePage'))
const EditAttendancePage            = lazy(() => import('@pages/teacher/EditAttendancePage'))
const SeeYourAttendancePage         = lazy(() => import('@pages/public/SeeYourAttendancePage'))
const ReportsPage                   = lazy(() => import('@pages/teacher/ReportsPage'))
const StudentReportsPage            = lazy(() => import('@pages/teacher/StudentReportsPage'))
const IndividualStudentReportPage   = lazy(() => import('@pages/teacher/IndividualStudentReportPage'))
const ExportPage                    = lazy(() => import('@pages/teacher/ExportPage'))
const TrashPage                     = lazy(() => import('@pages/teacher/TrashPage'))
const ProfilePage                   = lazy(() => import('@pages/teacher/ProfilePage'))
const ConsecutiveAbsenceAlertsPage  = lazy(() => import('@pages/teacher/ConsecutiveAbsenceAlertsPage'))

// ── Admin pages (lazy) ────────────────────────────────────────────────────────
const AdminDashboardPage    = lazy(() => import('@pages/admin/AdminDashboardPage'))
const ApproveTeachersPage   = lazy(() => import('@pages/admin/ApproveTeachersPage'))
const TeacherManagementPage = lazy(() => import('@pages/admin/TeacherManagementPage'))
const UploadStudentsPage    = lazy(() => import('@pages/admin/UploadStudentsPage'))
const ManageStudentsPage    = lazy(() => import('@pages/admin/ManageStudentsPage'))
const AllStudentsPage       = lazy(() => import('@pages/admin/AllStudentsPage'))
const ManageDepartmentsPage = lazy(() => import('@pages/admin/ManageDepartmentsPage'))
const ManageShiftsPage      = lazy(() => import('@pages/admin/ManageShiftsPage'))
const ManageAttendanceCategoriesPage = lazy(() => import('@pages/admin/ManageAttendanceCategoriesPage'))
const AdminSettingsPage     = lazy(() => import('@pages/admin/AdminSettingsPage'))
const AdminTrashPage        = lazy(() => import('@pages/admin/AdminTrashPage'))
const StudentAnalyticsPage  = lazy(() => import('@pages/admin/StudentAnalyticsPage'))
const TeacherPerformancePage = lazy(() => import('@pages/admin/TeacherPerformancePage'))
const AllSubjectsPage       = lazy(() => import('@pages/admin/AllSubjectsPage'))
const SubjectDetailPage     = lazy(() => import('@pages/admin/SubjectDetailPage'))
const AcademicStructurePage = lazy(() => import('@pages/admin/AcademicStructurePage'))

// ── Page loading fallback ─────────────────────────────────────────────────────
function PageLoader() {
  return (
    <div className="flex-1 flex items-center justify-center min-h-[300px]">
      <div className="w-8 h-8 border-2 border-t-transparent rounded-full animate-spin"
        style={{ borderColor: 'var(--brand-primary)', borderTopColor: 'transparent' }} />
    </div>
  )
}

export default function AppRoutes() {
  return (
    <Routes>
      {/* ── Public ─────────────────────────────────────────────────────────── */}
      <Route path="/"       element={<HomePage />} />
      <Route path="/login"  element={<LoginPage />} />
      <Route path="/signup" element={<SignupPage />} />
      <Route path="/register-college" element={<RegisterCollegePage />} />
      <Route path="/see-attendance" element={<Suspense fallback={<PageLoader />}><SeeYourAttendancePage /></Suspense>} />

      {/* ── Teacher ────────────────────────────────────────────────────────── */}
      <Route
        path="/teacher"
        element={
          <ProtectedRoute allowedRole="teacher">
            <DashboardLayout role="teacher" />
          </ProtectedRoute>
        }
      >
        <Route index element={<Suspense fallback={<PageLoader />}><TeacherDashboardPage /></Suspense>} />
        <Route path="create-subject"    element={<Suspense fallback={<PageLoader />}><CreateSubjectPage /></Suspense>} />
        <Route path="subjects"          element={<Suspense fallback={<PageLoader />}><SubjectListPage /></Suspense>} />
        <Route path="attendance"        element={<Suspense fallback={<PageLoader />}><TakeAttendancePage /></Suspense>} />
        <Route path="edit-attendance"   element={<Suspense fallback={<PageLoader />}><EditAttendancePage /></Suspense>} />
        <Route path="reports"           element={<Suspense fallback={<PageLoader />}><ReportsPage /></Suspense>} />
        <Route path="student-reports"   element={<Suspense fallback={<PageLoader />}><StudentReportsPage /></Suspense>} />
        <Route path="individual-report" element={<Suspense fallback={<PageLoader />}><IndividualStudentReportPage /></Suspense>} />
        <Route path="export"            element={<Suspense fallback={<PageLoader />}><ExportPage /></Suspense>} />
        <Route path="trash"             element={<Suspense fallback={<PageLoader />}><TrashPage /></Suspense>} />
        <Route path="profile"           element={<Suspense fallback={<PageLoader />}><ProfilePage /></Suspense>} />
        <Route path="consecutive-absence-alerts" element={<Suspense fallback={<PageLoader />}><ConsecutiveAbsenceAlertsPage /></Suspense>} />
      </Route>

      {/* ── Admin ──────────────────────────────────────────────────────────── */}
      <Route
        path="/admin"
        element={
          <ProtectedRoute allowedRole="admin">
            <AdminLayout />
          </ProtectedRoute>
        }
      >
        <Route index element={<Suspense fallback={<PageLoader />}><AdminDashboardPage /></Suspense>} />
        <Route path="approve-teachers" element={<Suspense fallback={<PageLoader />}><ApproveTeachersPage /></Suspense>} />
        <Route path="teachers"         element={<Suspense fallback={<PageLoader />}><TeacherManagementPage /></Suspense>} />
        <Route path="upload-json"      element={<Suspense fallback={<PageLoader />}><UploadStudentsPage /></Suspense>} />
        <Route path="students"         element={<Suspense fallback={<PageLoader />}><ManageStudentsPage /></Suspense>} />
        <Route path="all-students"     element={<Suspense fallback={<PageLoader />}><AllStudentsPage /></Suspense>} />
        <Route path="teacher-performance" element={<Suspense fallback={<PageLoader />}><TeacherPerformancePage /></Suspense>} />
        <Route path="subjects"            element={<Suspense fallback={<PageLoader />}><AllSubjectsPage /></Suspense>} />
        <Route path="subjects/:subjectId" element={<Suspense fallback={<PageLoader />}><SubjectDetailPage /></Suspense>} />
        <Route path="academic-structure"  element={<Suspense fallback={<PageLoader />}><AcademicStructurePage /></Suspense>} />
        <Route path="departments"      element={<Suspense fallback={<PageLoader />}><ManageDepartmentsPage /></Suspense>} />
        <Route path="shifts"           element={<Suspense fallback={<PageLoader />}><ManageShiftsPage /></Suspense>} />
        <Route path="attendance-categories" element={<Suspense fallback={<PageLoader />}><ManageAttendanceCategoriesPage /></Suspense>} />
        <Route path="settings"        element={<Suspense fallback={<PageLoader />}><AdminSettingsPage /></Suspense>} />
        <Route path="trash"            element={<Suspense fallback={<PageLoader />}><AdminTrashPage /></Suspense>} />
        <Route path="student/:studentId" element={<Suspense fallback={<PageLoader />}><StudentAnalyticsPage /></Suspense>} />
      </Route>

      {/* ── 404 ────────────────────────────────────────────────────────────── */}
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  )
}
