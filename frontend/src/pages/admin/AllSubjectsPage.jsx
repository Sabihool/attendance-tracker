/**
 * AllSubjectsPage.jsx
 * Admin — Subject Analytics ("All Subjects") dashboard.
 *
 * Lists every subject created by every teacher with computed stats, and
 * lets the admin drill into a subject for session-by-session detail.
 */
import {
  LuBookOpen, LuChevronDown, LuRefreshCw, LuSearch, LuChevronRight,
} from 'react-icons/lu'
import { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'

import { subjectAnalyticsAPI, departmentAPI, getErrorMessage } from '@services/api'
import toast from 'react-hot-toast'

const SORT_OPTIONS = [
  { value: 'recent',     label: 'Recently Created' },
  { value: 'attendance', label: 'Attendance %' },
  { value: 'classes',    label: 'Total Classes' },
  { value: 'students',   label: 'Total Students' },
  { value: 'name',       label: 'Name (A–Z)' },
]

function formatDate(d) {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' })
}

function AttendancePill({ pct }) {
  const style = pct >= 75
    ? { color: 'var(--success-text)', background: 'var(--success-bg)', border: '1px solid var(--success-border)' }
    : pct >= 50
      ? { color: 'var(--warning-text)', background: 'var(--warning-bg)', border: '1px solid var(--warning-border)' }
      : { color: 'var(--danger-text)', background: 'var(--danger-bg)', border: '1px solid var(--danger-border)' }
  return <span className="text-xs font-mono font-bold px-2 py-0.5 rounded-lg" style={style}>{pct}%</span>
}

export default function AllSubjectsPage() {
  const [subjects, setSubjects]     = useState([])
  const [pagination, setPagination] = useState({ page: 1, totalPages: 1, total: 0 })
  const [departments, setDepartments] = useState([])
  const [batches, setBatches]       = useState([])
  const [subjectTypes, setSubjectTypes] = useState([])
  const [loading, setLoading]       = useState(false)

  const [search, setSearch]         = useState('')
  const [department, setDepartment] = useState('')
  const [batch, setBatch]           = useState('')
  const [subjectType, setSubjectType] = useState('')
  const [sortBy, setSortBy]         = useState('recent')
  const [sortOrder, setSortOrder]   = useState('desc')
  const [page, setPage]             = useState(1)

  useEffect(() => {
    departmentAPI.getAll().then(r => setDepartments(r.data?.data?.departments || [])).catch(() => {})
    subjectAnalyticsAPI.getMeta().then(r => {
      setBatches(r.data?.data?.batches || [])
      setSubjectTypes(r.data?.data?.subjectTypes || [])
    }).catch(() => {})
  }, [])

  const loadSubjects = useCallback(async () => {
    setLoading(true)
    try {
      const params = { search, department, batch, subjectType, sortBy, sortOrder, page, limit: 10 }
      const res = await subjectAnalyticsAPI.getAll(params)
      setSubjects(res.data?.data?.subjects || [])
      setPagination(res.data?.data?.pagination || { page: 1, totalPages: 1, total: 0 })
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }, [search, department, batch, subjectType, sortBy, sortOrder, page])

  useEffect(() => {
    const t = setTimeout(loadSubjects, 300) // debounce search
    return () => clearTimeout(t)
  }, [loadSubjects])

  useEffect(() => { setPage(1) }, [search, department, batch, subjectType, sortBy, sortOrder])

  return (
    <div className="space-y-6 p-4 sm:p-6 max-w-6xl mx-auto">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>All Subjects</h1>
          <p className="text-sm mt-0.5" style={{ color: 'var(--text-muted)' }}>Every subject across every teacher, with attendance analytics</p>
        </div>
        <button onClick={loadSubjects} disabled={loading} className="btn-secondary disabled:opacity-50">
          <LuRefreshCw size={13} className={loading ? 'animate-spin' : ''} /> Refresh
        </button>
      </div>

      {/* Filters */}
      <div className="card p-4 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <div className="col-span-2 sm:col-span-1 lg:col-span-2">
          <label className="form-label">Search</label>
          <div className="relative">
            <LuSearch size={13} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-muted)' }} />
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Subject, code, or teacher…"
              className="input-field pl-8" />
          </div>
        </div>
        <div>
          <label className="form-label">Department</label>
          <div className="relative">
            <select value={department} onChange={e => setDepartment(e.target.value)} className="select-field">
              <option value="">All</option>
              {departments.map(d => <option key={d} value={d}>{d}</option>)}
            </select>
            <LuChevronDown size={12} className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" style={{ color: 'var(--text-muted)' }} />
          </div>
        </div>
        <div>
          <label className="form-label">Batch</label>
          <div className="relative">
            <select value={batch} onChange={e => setBatch(e.target.value)} className="select-field">
              <option value="">All</option>
              {batches.map(b => <option key={b} value={b}>Batch {b}</option>)}
            </select>
            <LuChevronDown size={12} className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" style={{ color: 'var(--text-muted)' }} />
          </div>
        </div>
        <div>
          <label className="form-label">Type</label>
          <div className="relative">
            <select value={subjectType} onChange={e => setSubjectType(e.target.value)} className="select-field">
              <option value="">All</option>
              {subjectTypes.map(t => <option key={t} value={t}>{t}</option>)}
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
      </div>

      <div className="flex items-center justify-end">
        <div className="relative">
          <select value={sortOrder} onChange={e => setSortOrder(e.target.value)} className="select-field text-xs" style={{ padding: '0.375rem 1.75rem 0.375rem 0.75rem' }}>
            <option value="desc">Highest / Newest first</option>
            <option value="asc">Lowest / Oldest first</option>
          </select>
          <LuChevronDown size={11} className="absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none" style={{ color: 'var(--text-muted)' }} />
        </div>
      </div>

      {/* Results */}
      {loading ? (
        <div className="space-y-2">{[1, 2, 3, 4, 5].map(i => <div key={i} className="skeleton h-14 w-full" />)}</div>
      ) : subjects.length === 0 ? (
        <div className="empty-state">
          <LuBookOpen size={32} className="empty-state-icon" />
          <p className="text-sm">No subjects match these filters.</p>
        </div>
      ) : (
        <>
          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>{pagination.total} subject{pagination.total !== 1 ? 's' : ''} found</p>

          <div className="card overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--border)' }}>
                    {['Subject', 'Teacher', 'Department / Batch', 'Type', 'Classes', 'Students', 'Attendance', 'Created', ''].map(h => (
                      <th key={h} className="text-left px-4 py-3 table-header">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {subjects.map((s, idx) => (
                    <tr key={s.subjectId} className="table-row-hover"
                      style={{ borderBottom: idx < subjects.length - 1 ? '1px solid var(--border-soft)' : 'none' }}>
                      <td className="px-4 py-3">
                        <p className="font-medium" style={{ color: 'var(--text-primary)' }}>{s.subjectName}</p>
                        <p className="text-xs font-mono" style={{ color: 'var(--text-muted)' }}>{s.subjectCode}</p>
                      </td>
                      <td className="px-4 py-3 text-xs" style={{ color: 'var(--text-secondary)' }}>{s.teacherName}</td>
                      <td className="px-4 py-3 text-xs" style={{ color: 'var(--text-secondary)' }}>
                        {s.department}<br /><span style={{ color: 'var(--text-muted)' }}>Batch {s.batch} · {s.shift}</span>
                      </td>
                      <td className="px-4 py-3 text-xs" style={{ color: 'var(--text-secondary)' }}>{s.subjectType}</td>
                      <td className="px-4 py-3 font-mono text-xs" style={{ color: 'var(--text-primary)' }}>{s.totalClasses}</td>
                      <td className="px-4 py-3 font-mono text-xs" style={{ color: 'var(--text-primary)' }}>{s.totalStudents}</td>
                      <td className="px-4 py-3"><AttendancePill pct={s.attendancePercentage} /></td>
                      <td className="px-4 py-3 text-xs" style={{ color: 'var(--text-muted)' }}>{formatDate(s.createdAt)}</td>
                      <td className="px-4 py-3">
                        <Link to={`/admin/subjects/${s.subjectId}`} className="icon-btn brand" title="View Details">
                          <LuChevronRight size={14} />
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {pagination.totalPages > 1 && (
            <div className="flex items-center justify-center gap-3 pt-2">
              <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1} className="page-btn">Prev</button>
              <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>{pagination.page} / {pagination.totalPages}</span>
              <button onClick={() => setPage(p => Math.min(pagination.totalPages, p + 1))} disabled={page === pagination.totalPages} className="page-btn">Next</button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
