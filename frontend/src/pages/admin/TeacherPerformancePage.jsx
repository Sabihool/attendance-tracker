/**
 * TeacherPerformancePage.jsx
 * Admin — Teacher Performance Dashboard.
 *
 * Shows how actively every teacher is using the system: subjects created,
 * attendance sessions taken, students managed, average attendance %, last
 * activity, and account status — plus headline stats (most/least active,
 * most subjects, teachers who've gone quiet).
 */
import {
  LuBookOpen, LuBuilding2, LuCalendarClock, LuChevronDown, LuClipboardList,
  LuLoaderCircle, LuMedal, LuMoon, LuRefreshCw, LuSearch, LuTrendingDown,
  LuTrendingUp, LuUsers,
} from 'react-icons/lu'
import { useState, useEffect, useCallback } from 'react'

import { teacherPerformanceAPI, getErrorMessage } from '@services/api'
import toast from 'react-hot-toast'

const SORT_OPTIONS = [
  { value: 'sessions',   label: 'Attendance Sessions' },
  { value: 'subjects',   label: 'Subjects Created' },
  { value: 'students',   label: 'Students Managed' },
  { value: 'attendance', label: 'Avg. Attendance %' },
  { value: 'recent',     label: 'Recent Activity' },
  { value: 'name',       label: 'Name (A–Z)' },
]

function formatDate(d) {
  if (!d) return 'Never'
  return new Date(d).toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' })
}

function HeadlineCard({ icon: Icon, label, teacher, metric, color, empty }) {
  return (
    <div className="card p-4">
      <div className="flex items-center gap-2 mb-3">
        <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0" style={{ background: `${color}1A`, color }}>
          <Icon size={15} />
        </div>
        <p className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>{label}</p>
      </div>
      {teacher ? (
        <>
          <p className="text-base font-bold truncate" style={{ color: 'var(--text-primary)' }}>{teacher.name}</p>
          <p className="text-xs mt-1" style={{ color: 'var(--text-secondary)' }}>{metric}</p>
        </>
      ) : (
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>{empty || 'No data yet'}</p>
      )}
    </div>
  )
}

function TeacherCard({ t }) {
  const initials = t.name?.split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase() || '??'
  const statusOk = t.accountStatus === 'Active'
  const attendanceColor = t.avgAttendancePercentage >= 75 ? '#15803D' : t.avgAttendancePercentage >= 50 ? '#B45309' : '#B91C1C'

  return (
    <div className="card p-5 card-hover">
      <div className="flex items-start justify-between gap-3 mb-4">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-11 h-11 rounded-xl flex items-center justify-center shrink-0"
            style={{ background: 'var(--brand-50)', border: '1px solid var(--brand-200)' }}>
            <span className="text-sm font-bold font-mono" style={{ color: 'var(--brand-primary)' }}>{initials}</span>
          </div>
          <div className="min-w-0">
            <p className="font-semibold truncate" style={{ color: 'var(--text-primary)' }}>{t.name}</p>
            <p className="text-xs truncate" style={{ color: 'var(--text-muted)' }}>{t.email}</p>
          </div>
        </div>
        <span className={`badge ${statusOk ? 'badge-success' : 'badge-danger'} shrink-0`}>{t.accountStatus}</span>
      </div>

      <div className="flex flex-wrap gap-x-4 gap-y-1 mb-4">
        <span className="flex items-center gap-1.5 text-xs" style={{ color: 'var(--text-secondary)' }}>
          <LuBuilding2 size={12} style={{ color: 'var(--text-muted)' }} /> {t.department}
        </span>
        <span className="flex items-center gap-1.5 text-xs" style={{ color: 'var(--text-secondary)' }}>
          <LuCalendarClock size={12} style={{ color: 'var(--text-muted)' }} /> Last taken: {formatDate(t.lastAttendanceDate)}
        </span>
      </div>

      <div className="grid grid-cols-4 gap-2 text-center pt-3" style={{ borderTop: '1px solid var(--border-soft)' }}>
        <div>
          <p className="text-lg font-bold font-mono" style={{ color: 'var(--text-primary)' }}>{t.totalSubjects}</p>
          <p className="text-[10px] mt-0.5" style={{ color: 'var(--text-muted)' }}>Subjects</p>
        </div>
        <div>
          <p className="text-lg font-bold font-mono" style={{ color: 'var(--text-primary)' }}>{t.totalAttendanceSessions}</p>
          <p className="text-[10px] mt-0.5" style={{ color: 'var(--text-muted)' }}>Sessions</p>
        </div>
        <div>
          <p className="text-lg font-bold font-mono" style={{ color: 'var(--text-primary)' }}>{t.totalStudentsManaged}</p>
          <p className="text-[10px] mt-0.5" style={{ color: 'var(--text-muted)' }}>Students</p>
        </div>
        <div>
          <p className="text-lg font-bold font-mono" style={{ color: attendanceColor }}>{t.avgAttendancePercentage}%</p>
          <p className="text-[10px] mt-0.5" style={{ color: 'var(--text-muted)' }}>Avg. Att.</p>
        </div>
      </div>
    </div>
  )
}

export default function TeacherPerformancePage() {
  const [teachers, setTeachers]       = useState([])
  const [pagination, setPagination]   = useState({ page: 1, totalPages: 1, total: 0 })
  const [summary, setSummary]         = useState(null)
  const [departments, setDepartments] = useState([])
  const [loading, setLoading]         = useState(false)
  const [summaryLoading, setSummaryLoading] = useState(true)

  const [search, setSearch]     = useState('')
  const [department, setDepartment] = useState('')
  const [sortBy, setSortBy]     = useState('sessions')
  const [sortOrder, setSortOrder] = useState('desc')
  const [page, setPage]         = useState(1)

  useEffect(() => {
    teacherPerformanceAPI.getDepartments()
      .then(r => setDepartments(r.data?.data?.departments || []))
      .catch(() => {})
  }, [])

  const loadSummary = useCallback(async () => {
    setSummaryLoading(true)
    try {
      const res = await teacherPerformanceAPI.getSummary()
      setSummary(res.data?.data || null)
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setSummaryLoading(false)
    }
  }, [])

  const loadTeachers = useCallback(async () => {
    setLoading(true)
    try {
      const params = { search, department, sortBy, sortOrder, page, limit: 9 }
      const res = await teacherPerformanceAPI.getAll(params)
      setTeachers(res.data?.data?.teachers || [])
      setPagination(res.data?.data?.pagination || { page: 1, totalPages: 1, total: 0 })
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }, [search, department, sortBy, sortOrder, page])

  useEffect(() => { loadSummary() }, [loadSummary])

  useEffect(() => {
    const t = setTimeout(loadTeachers, 300) // debounce search
    return () => clearTimeout(t)
  }, [loadTeachers])

  useEffect(() => { setPage(1) }, [search, department, sortBy, sortOrder])

  const refreshAll = () => { loadSummary(); loadTeachers() }

  return (
    <div className="space-y-6 p-4 sm:p-6 max-w-6xl mx-auto">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>Teacher Performance</h1>
          <p className="text-sm mt-0.5" style={{ color: 'var(--text-muted)' }}>Monitor how actively teachers are using the system</p>
        </div>
        <button onClick={refreshAll} disabled={loading || summaryLoading} className="btn-secondary disabled:opacity-50">
          <LuRefreshCw size={13} className={(loading || summaryLoading) ? 'animate-spin' : ''} /> Refresh
        </button>
      </div>

      {/* Headline stats */}
      {summaryLoading ? (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[1, 2, 3, 4].map(i => <div key={i} className="skeleton h-28 w-full" />)}
        </div>
      ) : summary && summary.totalTeachers > 0 ? (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <HeadlineCard
            icon={LuTrendingUp} label="Most Active" color="#16A34A"
            teacher={summary.mostActiveTeacher}
            metric={summary.mostActiveTeacher ? `${summary.mostActiveTeacher.totalAttendanceSessions} sessions taken` : ''}
            empty="No sessions taken yet"
          />
          <HeadlineCard
            icon={LuTrendingDown} label="Least Active" color="#DC2626"
            teacher={summary.leastActiveTeacher}
            metric={summary.leastActiveTeacher ? `${summary.leastActiveTeacher.totalAttendanceSessions} sessions taken` : ''}
            empty="No teachers with subjects yet"
          />
          <HeadlineCard
            icon={LuMedal} label="Most Sessions Taken" color="#6D5EF7"
            teacher={summary.mostSessionsTeacher}
            metric={summary.mostSessionsTeacher ? `${summary.mostSessionsTeacher.totalAttendanceSessions} sessions` : ''}
          />
          <HeadlineCard
            icon={LuBookOpen} label="Most Subjects Created" color="#D97706"
            teacher={summary.mostSubjectsTeacher}
            metric={summary.mostSubjectsTeacher ? `${summary.mostSubjectsTeacher.totalSubjects} subjects` : ''}
          />
        </div>
      ) : (
        <div className="empty-state">
          <LuUsers size={32} className="empty-state-icon" />
          <p className="text-sm">No teachers found yet.</p>
        </div>
      )}

      {/* Long-inactive teachers */}
      {!summaryLoading && summary?.inactiveTeachers?.length > 0 && (
        <div className="card p-4" style={{ borderColor: 'var(--warning-border)', background: 'var(--warning-bg)' }}>
          <div className="flex items-center gap-2 mb-2">
            <LuMoon size={14} style={{ color: 'var(--warning-text)' }} />
            <p className="text-sm font-semibold" style={{ color: 'var(--warning-text)' }}>
              {summary.inactiveTeachers.length} teacher{summary.inactiveTeachers.length !== 1 ? 's' : ''} haven't taken attendance in over {summary.inactiveThresholdDays} days
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {summary.inactiveTeachers.slice(0, 8).map(t => (
              <span key={t.teacherId} className="text-xs px-2.5 py-1 rounded-full"
                style={{ background: 'var(--surface)', color: 'var(--text-secondary)', border: '1px solid var(--warning-border)' }}>
                {t.name} · {t.daysSinceLastAttendance === null ? 'never taken' : `${t.daysSinceLastAttendance}d ago`}
              </span>
            ))}
            {summary.inactiveTeachers.length > 8 && (
              <span className="text-xs px-2.5 py-1" style={{ color: 'var(--text-muted)' }}>
                +{summary.inactiveTeachers.length - 8} more
              </span>
            )}
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="card p-4 grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="col-span-2 sm:col-span-1">
          <label className="form-label">Search</label>
          <div className="relative">
            <LuSearch size={13} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-muted)' }} />
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Teacher name or email…"
              className="input-field pl-8" />
          </div>
        </div>
        <div>
          <label className="form-label">Department</label>
          <div className="relative">
            <select value={department} onChange={e => setDepartment(e.target.value)} className="select-field">
              <option value="">All Departments</option>
              {departments.map(d => <option key={d} value={d}>{d}</option>)}
            </select>
            <LuChevronDown size={12} className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" style={{ color: 'var(--text-muted)' }} />
          </div>
        </div>
        <div>
          <label className="form-label">Sort By</label>
          <div className="relative">
            <select value={sortBy} onChange={e => setSortBy(e.target.value)} className="select-field">
              {SORT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            <LuChevronDown size={12} className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" style={{ color: 'var(--text-muted)' }} />
          </div>
        </div>
        <div>
          <label className="form-label">Order</label>
          <div className="relative">
            <select value={sortOrder} onChange={e => setSortOrder(e.target.value)} className="select-field">
              <option value="desc">Highest first</option>
              <option value="asc">Lowest first</option>
            </select>
            <LuChevronDown size={12} className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" style={{ color: 'var(--text-muted)' }} />
          </div>
        </div>
      </div>

      {/* Results */}
      {loading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {[1, 2, 3, 4, 5, 6].map(i => <div key={i} className="skeleton h-48 w-full" />)}
        </div>
      ) : teachers.length === 0 ? (
        <div className="empty-state">
          <LuClipboardList size={32} className="empty-state-icon" />
          <p className="text-sm">No teachers match these filters.</p>
        </div>
      ) : (
        <>
          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>{pagination.total} teacher{pagination.total !== 1 ? 's' : ''} found</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {teachers.map(t => <TeacherCard key={t.teacherId} t={t} />)}
          </div>

          {pagination.totalPages > 1 && (
            <div className="flex items-center justify-center gap-3 pt-2">
              <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1} className="page-btn">
                {loading ? <LuLoaderCircle size={12} className="animate-spin" /> : 'Prev'}
              </button>
              <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>{pagination.page} / {pagination.totalPages}</span>
              <button onClick={() => setPage(p => Math.min(pagination.totalPages, p + 1))} disabled={page === pagination.totalPages} className="page-btn">Next</button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
