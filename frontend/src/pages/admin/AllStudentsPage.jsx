/**
 * AllStudentsPage.jsx
 * Admin — Global Student Directory ("All Students").
 *
 * Feature 3: one searchable, sortable, server-paginated table of every
 * student across every department, batch, and shift, with computed Overall
 * Attendance %, Credit Score, and Total Subjects Enrolled (all via a backend
 * aggregation over the Attendance collection — see
 * studentController.getStudentDirectory).
 *
 * Feature 4: advanced filters (Department / Batch / Shift / Attendance
 * Below %) layered on top, all combined server-side with AND semantics —
 * see the same controller for the aggregation/filter logic.
 */
import {
  LuChevronDown, LuChevronUp, LuChevronsUpDown, LuX, LuIdCard, LuRefreshCw, LuSearch, LuChevronRight,
  LuCircleCheck, LuCircleX, LuClock, LuTrendingUp, LuTriangleAlert,
} from 'react-icons/lu'
import { useState, useEffect, useCallback, useMemo } from 'react'
import { Link } from 'react-router-dom'

import { studentAPI, departmentAPI, shiftAPI, getErrorMessage } from '@services/api'
import toast from 'react-hot-toast'

const STATUS_CONFIG = {
  Excellent: { color: 'var(--success-text)',  bg: 'var(--success-bg)', border: 'var(--success-border)', icon: LuCircleCheck },
  Good:      { color: 'var(--brand-primary)', bg: 'var(--brand-50)',   border: 'var(--brand-200)',      icon: LuTrendingUp  },
  Warning:   { color: 'var(--warning-text)',  bg: 'var(--warning-bg)', border: 'var(--warning-border)', icon: LuClock       },
  Critical:  { color: 'var(--danger-text)',   bg: 'var(--danger-bg)',  border: 'var(--danger-border)',  icon: LuCircleX     },
}

// Columns the user can click to sort — value must match a sortBy the backend understands.
const COLUMNS = [
  { key: 'name',                 label: 'Student Name',     sortable: true },
  { key: 'roll',                 label: 'Roll No.',         sortable: true },
  { key: 'studentId',            label: 'Registration No.', sortable: true },
  { key: 'department',           label: 'Department',       sortable: true },
  { key: 'batch',                label: 'Batch',             sortable: true },
  { key: 'shift',                label: 'Shift',             sortable: true },
  { key: 'totalSubjects',        label: 'Subjects',         sortable: true },
  { key: 'attendancePercentage', label: 'Attendance',       sortable: true },
  { key: 'creditScore',          label: 'Credit Score',     sortable: true },
  { key: 'status',               label: 'Status',            sortable: true },
]

function AttendancePill({ pct }) {
  const style = pct >= 75
    ? { color: 'var(--success-text)', background: 'var(--success-bg)', border: '1px solid var(--success-border)' }
    : pct >= 50
      ? { color: 'var(--warning-text)', background: 'var(--warning-bg)', border: '1px solid var(--warning-border)' }
      : { color: 'var(--danger-text)', background: 'var(--danger-bg)', border: '1px solid var(--danger-border)' }
  return <span className="text-xs font-mono font-bold px-2 py-0.5 rounded-lg" style={style}>{pct}%</span>
}

function StatusPill({ status }) {
  const cfg = STATUS_CONFIG[status] || STATUS_CONFIG.Good
  const Icon = cfg.icon
  return (
    <span className="inline-flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-lg"
      style={{ color: cfg.color, background: cfg.bg, border: `1px solid ${cfg.border}` }}>
      <Icon size={11} /> {status}
    </span>
  )
}

function SortIcon({ active, order }) {
  if (!active) return <LuChevronsUpDown size={12} style={{ color: 'var(--text-muted)' }} />
  return order === 'asc' ? <LuChevronUp size={12} /> : <LuChevronDown size={12} />
}

const emptyFilters = { department: '', batch: '', shift: '', attendanceBelow: '' }

export default function AllStudentsPage() {
  const [students, setStudents]     = useState([])
  const [pagination, setPagination] = useState({ page: 1, totalPages: 1, total: 0 })
  const [loading, setLoading]       = useState(false)

  const [search, setSearch]         = useState('')
  const [filters, setFilters]       = useState(emptyFilters)
  const [sortBy, setSortBy]         = useState('name')
  const [sortOrder, setSortOrder]   = useState('asc')
  const [page, setPage]             = useState(1)
  const [showClearConfirm, setShowClearConfirm] = useState(false)
  const limit = 20

  // ── Filter dropdown data sources (reuse existing admin endpoints) ──────────
  const [departments, setDepartments] = useState([])
  const [shifts, setShifts]           = useState([])
  const [batches, setBatches]         = useState([])

  useEffect(() => {
    departmentAPI.getAll().then(r => setDepartments(r.data?.data?.departments || [])).catch(() => {})
    shiftAPI.getAll().then(r => setShifts(r.data?.data?.shifts || [])).catch(() => {})
  }, [])

  // Batches sourced only from uploaded student data, scoped to the current
  // department/shift filters (same convention as Manage Students / spec section 9).
  useEffect(() => {
    const params = {}
    if (filters.department) params.department = filters.department
    if (filters.shift) params.shift = filters.shift
    studentAPI.getBatches(params).then(r => setBatches(r.data?.data?.batches || [])).catch(() => setBatches([]))
  }, [filters.department, filters.shift])

  const filtersActive = useMemo(
    () => !!(search || filters.department || filters.batch || filters.shift || filters.attendanceBelow),
    [search, filters]
  )

  const loadStudents = useCallback(async () => {
    setLoading(true)
    try {
      const params = { search, sortBy, sortOrder, page, limit, ...filters }
      // Don't send an empty attendanceBelow — an empty string would otherwise
      // become the literal query param and confuse the backend's numeric parse.
      if (params.attendanceBelow === '') delete params.attendanceBelow
      const res = await studentAPI.getDirectory(params)
      setStudents(res.data?.data?.students || [])
      setPagination(res.data?.data?.pagination || { page: 1, totalPages: 1, total: 0 })
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }, [search, filters, sortBy, sortOrder, page])

  useEffect(() => {
    const t = setTimeout(loadStudents, 300) // debounce search + filter changes → instant-feeling search
    return () => clearTimeout(t)
  }, [loadStudents])

  useEffect(() => { setPage(1) }, [search, filters, sortBy, sortOrder])

  const toggleSort = (key) => {
    if (sortBy === key) {
      setSortOrder((o) => (o === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortBy(key)
      setSortOrder('asc')
    }
  }

  const setFilter = (key) => (e) => setFilters((f) => ({ ...f, [key]: e.target.value }))

  const requestClearFilters = () => {
    if (!filtersActive) return
    setShowClearConfirm(true)
  }

  const confirmClearFilters = () => {
    setSearch('')
    setFilters(emptyFilters)
    setShowClearConfirm(false)
    toast.success('Filters cleared')
  }

  return (
    <div className="space-y-6 p-4 sm:p-6 max-w-6xl mx-auto">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>All Students</h1>
          <p className="text-sm mt-0.5" style={{ color: 'var(--text-muted)' }}>
            Every student across every department and batch, in one place
          </p>
        </div>
        <button onClick={loadStudents} disabled={loading} className="btn-secondary disabled:opacity-50">
          <LuRefreshCw size={13} className={loading ? 'animate-spin' : ''} /> Refresh
        </button>
      </div>

      {/* Search + advanced filters */}
      <div className="card p-4 space-y-4">
        <div>
          <label className="form-label">Search</label>
          <div className="relative max-w-md">
            <LuSearch size={13} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-muted)' }} />
            <input value={search} onChange={(e) => setSearch(e.target.value)}
              placeholder="Name, roll, registration no., department, batch…"
              className="input-field pl-8" />
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div>
            <label className="form-label">Department</label>
            <div className="relative">
              <select value={filters.department} onChange={setFilter('department')} className="select-field">
                <option value="">All Departments</option>
                {departments.map(d => <option key={d} value={d}>{d}</option>)}
              </select>
              <LuChevronDown size={12} className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" style={{ color: 'var(--text-muted)' }} />
            </div>
          </div>

          <div>
            <label className="form-label">Batch</label>
            <div className="relative">
              <select value={filters.batch} onChange={setFilter('batch')} className="select-field">
                <option value="">All Batches</option>
                {batches.map(b => <option key={b} value={b}>Batch {b}</option>)}
              </select>
              <LuChevronDown size={12} className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" style={{ color: 'var(--text-muted)' }} />
            </div>
          </div>

          <div>
            <label className="form-label">Shift</label>
            <div className="relative">
              <select value={filters.shift} onChange={setFilter('shift')} className="select-field">
                <option value="">All Shifts</option>
                {shifts.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
              <LuChevronDown size={12} className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" style={{ color: 'var(--text-muted)' }} />
            </div>
          </div>

          <div>
            <label className="form-label">Attendance Below</label>
            <div className="relative">
              <input type="number" min={0} max={100} step={1} value={filters.attendanceBelow}
                onChange={setFilter('attendanceBelow')} placeholder="e.g. 75"
                className="input-field pr-8" />
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs" style={{ color: 'var(--text-muted)' }}>%</span>
            </div>
          </div>
        </div>

        {filtersActive && (
          <div className="flex justify-end">
            <button onClick={requestClearFilters}
              className="text-xs flex items-center gap-1.5 px-3 py-1.5 rounded-xl transition-all"
              style={{ color: 'var(--text-secondary)', background: 'var(--bg-muted)', border: '1px solid var(--border)' }}>
              <LuX size={12} /> Clear Filters
            </button>
          </div>
        )}
      </div>

      {/* Results */}
      {loading ? (
        <div className="space-y-2">{[1, 2, 3, 4, 5, 6].map((i) => <div key={i} className="skeleton h-14 w-full" />)}</div>
      ) : students.length === 0 ? (
        <div className="empty-state">
          <LuIdCard size={32} className="empty-state-icon" />
          <p className="text-sm">No students found{filtersActive ? ' for these filters' : ''}.</p>
          {filtersActive && (
            <button onClick={requestClearFilters} className="btn-secondary mt-3">
              <LuX size={13} /> Clear Filters
            </button>
          )}
        </div>
      ) : (
        <>
          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
            {pagination.total} student{pagination.total !== 1 ? 's' : ''} found
          </p>

          <div className="card overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--border)' }}>
                    {COLUMNS.map((col) => (
                      <th key={col.key} className="text-left px-4 py-3 table-header select-none"
                        style={col.sortable ? { cursor: 'pointer' } : undefined}
                        onClick={col.sortable ? () => toggleSort(col.key) : undefined}>
                        <span className="inline-flex items-center gap-1">
                          {col.label}
                          {col.sortable && <SortIcon active={sortBy === col.key} order={sortOrder} />}
                        </span>
                      </th>
                    ))}
                    <th className="text-left px-4 py-3 table-header"></th>
                  </tr>
                </thead>
                <tbody>
                  {students.map((s, idx) => (
                    <tr key={s._id} className="table-row-hover"
                      style={{ borderBottom: idx < students.length - 1 ? '1px solid var(--border-soft)' : 'none' }}>
                      <td className="px-4 py-3 font-medium" style={{ color: 'var(--text-primary)' }}>{s.name}</td>
                      <td className="px-4 py-3 font-mono text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>{s.roll}</td>
                      <td className="px-4 py-3 font-mono text-xs" style={{ color: 'var(--text-secondary)' }}>{s.studentId}</td>
                      <td className="px-4 py-3 text-xs" style={{ color: 'var(--text-secondary)' }}>{s.department}</td>
                      <td className="px-4 py-3 text-xs" style={{ color: 'var(--text-secondary)' }}>Batch {s.batch}</td>
                      <td className="px-4 py-3 text-xs" style={{ color: 'var(--text-secondary)' }}>{s.shift}</td>
                      <td className="px-4 py-3 font-mono text-xs" style={{ color: 'var(--text-primary)' }}>{s.totalSubjects}</td>
                      <td className="px-4 py-3"><AttendancePill pct={s.attendancePercentage} /></td>
                      <td className="px-4 py-3 font-mono text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>{s.creditScore}</td>
                      <td className="px-4 py-3"><StatusPill status={s.status} /></td>
                      <td className="px-4 py-3">
                        <Link to={`/admin/student/${s.studentId}`} className="icon-btn brand" title="View Analytics">
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
              <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1} className="page-btn">Prev</button>
              <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>{pagination.page} / {pagination.totalPages}</span>
              <button onClick={() => setPage((p) => Math.min(pagination.totalPages, p + 1))} disabled={page === pagination.totalPages} className="page-btn">Next</button>
            </div>
          )}
        </>
      )}

      {/* Confirm clear filters */}
      {showClearConfirm && (
        <div className="modal-overlay">
          <div className="modal-card max-w-sm p-6 space-y-4" style={{ border: '1px solid var(--warning-border)' }}>
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
                style={{ background: 'var(--warning-bg)', border: '1px solid var(--warning-border)' }}>
                <LuTriangleAlert size={18} style={{ color: 'var(--warning-text)' }} />
              </div>
              <p className="font-semibold" style={{ color: 'var(--text-primary)' }}>Clear all filters?</p>
            </div>
            <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
              This resets search, department, batch, shift, and the attendance threshold, and reloads the full directory.
            </p>
            <div className="flex gap-3">
              <button onClick={() => setShowClearConfirm(false)} className="btn-secondary flex-1 justify-center">Cancel</button>
              <button onClick={confirmClearFilters} className="btn-primary flex-1 justify-center">
                <LuX size={13} /> Clear Filters
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
