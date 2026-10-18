/**
 * server.js — Application Entry Point
 * Attendance Tracker API
 */
import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import { connectDB } from './database/connection.js'
import { errorHandler } from './middleware/errorMiddleware.js'
import { securityHeaders } from './middleware/securityHeaders.js'
import { startTrashCleanupCron } from './services/cronJobs.js'
import authRoutes from './routes/authRoutes.js'
import collegeRoutes from './routes/collegeRoutes.js'
import publicAttendanceRoutes from './routes/publicAttendanceRoutes.js'
import teacherRequestRoutes from './routes/teacherRequestRoutes.js'
import teacherManagementRoutes from './routes/teacherManagementRoutes.js'
import notificationRoutes from './routes/notificationRoutes.js'
import subjectRoutes from './routes/subjectRoutes.js'
import attendanceRoutes from './routes/attendanceRoutes.js'
import studentRoutes from './routes/studentRoutes.js'
import exportRoutes from './routes/exportRoutes.js'
import departmentRoutes from './routes/departmentRoutes.js'
import { trashRouter, adminTrashRouter } from './routes/trashRoutes.js'
import alertsRoutes from './routes/alertsRoutes.js'
import teacherPerformanceRoutes from './routes/teacherPerformanceRoutes.js'
import subjectAnalyticsRoutes from './routes/subjectAnalyticsRoutes.js'
import academicStructureRoutes from './routes/academicStructureRoutes.js'
import shiftRoutes from './routes/shiftRoutes.js'
import attendanceCategoryRoutes from './routes/attendanceCategoryRoutes.js'
import settingsRoutes from './routes/settingsRoutes.js'
import activityRoutes from './routes/activityRoutes.js'
import backupRoutes from './routes/backupRoutes.js'
import College from './models/College.js'
import User from './models/User.js'
import { backfillApprovalStatus } from './utils/approvalBackfill.js'
import { backfillCollegeSearchFields } from './utils/collegeBackfill.js'
import { seedAcademicDefaults } from './services/academicDefaults.js'
import { migrateAcademicOwnership } from './utils/academicBackfill.js'
import { migrateAttendanceOwnership } from './utils/attendanceBackfill.js'
import { seedAllCategories } from './services/categoryDefaults.js'
import { checkSecurityConfig } from './utils/securityConfig.js'
import { buildCorsOptions } from './utils/corsConfig.js'
import mongoose from 'mongoose'

dotenv.config()

// Refuse to start in production with a missing / weak / placeholder JWT secret.
const securityCheck = checkSecurityConfig()
if (!securityCheck.ok) {
  const list = securityCheck.problems.map((p) => `  - ${p}`).join('\n')
  if (securityCheck.production) {
    console.error(`❌ Insecure configuration, refusing to start:\n${list}`)
    process.exit(1)
  }
  console.warn(`⚠️  Security configuration problems (fatal in production):\n${list}`)
}

const app = express()
app.disable('x-powered-by')
const PORT = process.env.PORT || 5000

// Behind Render's proxy: use the real client IP (needed for rate limiting)
app.set('trust proxy', 1)

// ── DB connect → seed → cron ──────────────────────────────────────────────────
connectDB().then(async () => {
  // Part 9: departments/batches/shifts belong to a college. Order matters:
  // drop the old global unique indexes + stamp existing rows with their college
  // first, THEN seed defaults for colleges that still have none (all idempotent).
  try {
    const r = await migrateAcademicOwnership()
    if (r.changed) console.log('🏫 Academic structure migrated:', JSON.stringify(r))
  } catch (err) {
    console.error('Academic structure migration failed:', err.message)
  }
  await seedAcademicDefaults()
  // Part 12: attendance sessions/alerts/categories/settings belong to a college.
  // Stamp existing rows from their subject's college and give every college its
  // own categories + streak setting, THEN seed defaults for colleges that still
  // have no categories (all idempotent; history is never modified).
  try {
    const r = await migrateAttendanceOwnership()
    if (r.changed) console.log('📚 Attendance migrated:', JSON.stringify(r))
    if (r.unassigned.attendance || r.unassigned.alerts || r.teacherMismatches) {
      console.warn('⚠️  Attendance rows without a college / with a foreign teacher need review:', JSON.stringify({ unassigned: r.unassigned, teacherMismatches: r.teacherMismatches }))
    }
  } catch (err) {
    console.error('Attendance migration failed:', err.message)
  }
  await seedAllCategories()
  // Part 7: make sure pre-existing colleges are searchable (idempotent)
  try {
    const n = await backfillCollegeSearchFields(College)
    if (n) console.log(`🔎 College search fields added to ${n} existing college(s)`)
  } catch (err) {
    console.error('College search backfill failed:', err.message)
  }
  // Part 8: give pre-existing users an explicit approvalStatus (idempotent)
  try {
    const n = await backfillApprovalStatus(User)
    if (n) console.log(`🛂 approvalStatus set on ${n} existing user(s)`)
  } catch (err) {
    console.error('Approval status backfill failed:', err.message)
  }
  startTrashCleanupCron()
})

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(securityHeaders)
app.use(cors(buildCorsOptions()))
// Simple query parser: `?a[$ne]=x` stays the flat key "a[$ne]" instead of becoming the object { a: { $ne: 'x' } }.
// Controllers also type-check every query value; this removes the whole class of operator-injection-by-query.
app.set('query parser', 'simple')
app.use(express.json({ limit: '1mb' }))
app.use(express.urlencoded({ extended: false, limit: '100kb' }))
// SECURITY (Part 19): `/uploads` used to be served statically. It holds uploaded student rosters
// (names, roll numbers, registration numbers) under colleges/<collegeId>/..., so ANY visitor who could guess a
// path could download another college's roster. Nothing in the frontend reads from it, so it is no longer served.
// If files must ever be downloadable, add an authenticated, college-checked route instead.

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/api/auth',               authRoutes)
app.use('/api/colleges',           collegeRoutes)
app.use('/api/public/attendance',  publicAttendanceRoutes)
app.use('/api/admin/teacher-requests', teacherRequestRoutes)
app.use('/api/admin/teachers',     teacherManagementRoutes)
app.use('/api/notifications',      notificationRoutes)
app.use('/api/departments',        departmentRoutes)
app.use('/api/shifts',             shiftRoutes)
app.use('/api/attendance-categories', attendanceCategoryRoutes)
app.use('/api/settings',           settingsRoutes)
app.use('/api/subjects',           subjectRoutes)
app.use('/api/attendance/:subjectId', attendanceRoutes)
app.use('/api/students',           studentRoutes)
app.use('/api/export/:subjectId',  exportRoutes)
app.use('/api/trash/:subjectId',   trashRouter)
app.use('/api/admin/trash',        adminTrashRouter)
app.use('/api/alerts',             alertsRoutes)
app.use('/api/admin/teacher-performance', teacherPerformanceRoutes)
app.use('/api/admin/subjects',      subjectAnalyticsRoutes)
app.use('/api/admin/academic-structure', academicStructureRoutes)
app.use('/api/admin/activity',      activityRoutes)
app.use('/api/admin/backups',       backupRoutes)

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/', (_req, res) => {
  res.json({
    message: 'Attendance Tracker API is running 🚀',
    version: '1.0.0',
    status: 'OK',
  })
})

// ── 404 handler ───────────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ success: false, message: 'Route not found' })
})

// ── Global error handler ──────────────────────────────────────────────────────
app.use(errorHandler)

const server = app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`)
  console.log(`📌 Environment: ${process.env.NODE_ENV || 'development'}`)
})

// Graceful shutdown (Render / Docker / systemd send SIGTERM on deploy): stop accepting requests, finish the
// in-flight ones, close the database connection, then exit. A hard timeout guards against a stuck connection.
let shuttingDown = false
const shutdown = (signal) => {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`↩️  ${signal} received — shutting down`)
  const force = setTimeout(() => process.exit(1), 10_000)
  force.unref()
  server.close(async () => {
    try { await mongoose.disconnect() } catch { /* ignore */ }
    process.exit(0)
  })
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('unhandledRejection', (reason) => console.error('Unhandled promise rejection:', reason))

export default app
