/**
 * AcademicStructurePage.jsx
 * Admin — Academic Structure.
 *
 * Master overview of the institution's academic hierarchy. There is no
 * separate "Class" model — a class is simply Department + Batch + Shift,
 * so this page renders that as an expandable tree:
 *
 *   Department
 *     └── Batch
 *           └── Shift → Total Students · Assigned Subjects · Assigned Teachers · Last Updated
 */
import {
  LuBookOpen, LuBuilding2, LuCalendarClock, LuChevronDown, LuChevronRight,
  LuClock, LuExpand, LuFolderTree, LuGraduationCap, LuLayers, LuMinimize2,
  LuRefreshCw, LuSearch, LuUserCheck, LuUsers,
} from 'react-icons/lu'
import { useState, useEffect, useCallback, useMemo } from 'react'
import { Link } from 'react-router-dom'

import { academicStructureAPI, departmentAPI, getErrorMessage } from '@services/api'
import toast from 'react-hot-toast'

function fmtDate(d) {
  if (!d) return 'Never'
  return new Date(d).toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' })
}

// ── Quick statistics card ───────────────────────────────────────────────────
function StatCard({ icon: Icon, label, value, color }) {
  const palette = {
    brand: { bg: '#F4F1FF', fg: '#6D5EF7' },
    purple: { bg: '#FAF5FF', fg: '#9333EA' },
    amber: { bg: '#FFFBEB', fg: '#D97706' },
    green: { bg: '#F0FDF4', fg: '#16A34A' },
    rose: { bg: '#FEF2F2', fg: '#DC2626' },
    cyan: { bg: '#ECFEFF', fg: '#0891B2' },
  }
  const c = palette[color] || palette.brand
  return (
    <div className="stat-card card-hover">
      <div className="w-8 h-8 rounded-lg flex items-center justify-center mb-2.5" style={{ background: c.bg }}>
        <Icon size={15} style={{ color: c.fg }} />
      </div>
      <p className="text-xl font-bold leading-none mb-0.5 font-mono" style={{ color: 'var(--text-primary)' }}>
        {value ?? '…'}
      </p>
      <p className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>{label}</p>
    </div>
  )
}

// ── Leaf node: one Department + Batch + Shift group ("the class") ──────────
function ShiftLeaf({ s }) {
  return (
    <div className="rounded-xl p-3.5" style={{ background: 'var(--bg-muted)', border: '1px solid var(--border-soft)' }}>
      <div className="flex items-center gap-2 mb-3">
        <div className="w-6 h-6 rounded-lg flex items-center justify-center shrink-0" style={{ background: 'var(--warning-bg)' }}>
          <LuClock size={12} style={{ color: 'var(--warning-text)' }} />
        </div>
        <p className="text-sm font-semibold truncate" style={{ color: 'var(--text-primary)' }}>{s.shift}</p>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 text-center">
        <div>
          <p className="text-base font-bold font-mono" style={{ color: 'var(--text-primary)' }}>{s.totalStudents}</p>
          <p className="text-[10px] mt-0.5" style={{ color: 'var(--text-muted)' }}>Students</p>
        </div>
        <div>
          <p className="text-base font-bold font-mono" style={{ color: 'var(--text-primary)' }}>{s.totalSubjects}</p>
          <p className="text-[10px] mt-0.5" style={{ color: 'var(--text-muted)' }}>Subjects</p>
        </div>
        <div>
          <p className="text-base font-bold font-mono" style={{ color: 'var(--text-primary)' }}>{s.totalTeachers}</p>
          <p className="text-[10px] mt-0.5" style={{ color: 'var(--text-muted)' }}>Teachers</p>
        </div>
        <div>
          <p className="text-xs font-semibold mt-1" style={{ color: 'var(--text-secondary)' }}>{fmtDate(s.lastUpdated)}</p>
          <p className="text-[10px] mt-0.5" style={{ color: 'var(--text-muted)' }}>Last Updated</p>
        </div>
      </div>
      {s.teachers?.length > 0 && (
        <p className="text-[11px] mt-2.5 truncate" style={{ color: 'var(--text-muted)' }}>
          {s.teachers.slice(0, 3).map(t => t.name).join(', ')}
          {s.teachers.length > 3 ? ` +${s.teachers.length - 3} more` : ''}
        </p>
      )}
    </div>
  )
}

// ── Batch node: expands to reveal its Shift leaves ──────────────────────────
function BatchNode({ b, isOpen, onToggle }) {
  return (
    <div className="rounded-xl overflow-hidden" style={{ border: '1px solid var(--border-soft)' }}>
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-2.5 px-3.5 py-3 text-left transition-colors"
        style={{ background: 'var(--bg-card)' }}
        onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-hover)' }}
        onMouseLeave={e => { e.currentTarget.style.background = 'var(--bg-card)' }}
      >
        {isOpen ? <LuChevronDown size={14} style={{ color: 'var(--text-muted)' }} /> : <LuChevronRight size={14} style={{ color: 'var(--text-muted)' }} />}
        <div className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0" style={{ background: 'var(--brand-50)' }}>
          <LuLayers size={13} style={{ color: 'var(--brand-primary)' }} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold truncate" style={{ color: 'var(--text-primary)' }}>Batch {b.batch}</p>
          <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
            {b.totalShifts} shift{b.totalShifts !== 1 ? 's' : ''} · {b.totalStudents} student{b.totalStudents !== 1 ? 's' : ''} · {b.totalSubjects} subject{b.totalSubjects !== 1 ? 's' : ''}
          </p>
        </div>
        <span className="hidden sm:flex items-center gap-1 text-[11px] shrink-0" style={{ color: 'var(--text-muted)' }}>
          <LuCalendarClock size={11} /> {fmtDate(b.lastUpdated)}
        </span>
      </button>

      {isOpen && (
        <div className="px-3.5 pb-3.5 pt-1 grid grid-cols-1 sm:grid-cols-2 gap-2.5" style={{ background: 'var(--bg-card)' }}>
          {b.shifts.map(s => <ShiftLeaf key={s.shift} s={s} />)}
        </div>
      )}
    </div>
  )
}

// ── Department node: expands to reveal its Batches ──────────────────────────
function DepartmentNode({ d, isOpen, onToggle, openBatches, onToggleBatch }) {
  const hasBatches = d.totalBatches > 0
  return (
    <div className="card overflow-hidden">
      <button
        onClick={onToggle}
        disabled={!hasBatches}
        className="w-full flex items-center gap-3 px-4 py-4 text-left transition-colors disabled:cursor-default"
        onMouseEnter={e => { if (hasBatches) e.currentTarget.style.background = 'var(--bg-hover)' }}
        onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
      >
        {hasBatches
          ? (isOpen ? <LuChevronDown size={15} style={{ color: 'var(--text-muted)' }} /> : <LuChevronRight size={15} style={{ color: 'var(--text-muted)' }} />)
          : <span className="w-[15px]" />}
        <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0" style={{ background: 'var(--brand-50)', border: '1px solid var(--brand-200)' }}>
          <LuBuilding2 size={16} style={{ color: 'var(--brand-primary)' }} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="font-semibold truncate" style={{ color: 'var(--text-primary)' }}>{d.department}</p>
          <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
            {d.totalBatches} batch{d.totalBatches !== 1 ? 'es' : ''} · {d.totalShiftGroups} group{d.totalShiftGroups !== 1 ? 's' : ''}
          </p>
        </div>
        <div className="hidden md:grid grid-cols-3 gap-4 text-center shrink-0 px-2">
          <div>
            <p className="text-sm font-bold font-mono" style={{ color: 'var(--text-primary)' }}>{d.totalStudents}</p>
            <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>Students</p>
          </div>
          <div>
            <p className="text-sm font-bold font-mono" style={{ color: 'var(--text-primary)' }}>{d.totalSubjects}</p>
            <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>Subjects</p>
          </div>
          <div>
            <p className="text-sm font-bold font-mono" style={{ color: 'var(--text-primary)' }}>{d.totalTeachers}</p>
            <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>Teachers</p>
          </div>
        </div>
        <span className="hidden lg:flex items-center gap-1 text-xs shrink-0" style={{ color: 'var(--text-muted)' }}>
          <LuCalendarClock size={12} /> {fmtDate(d.lastUpdated)}
        </span>
      </button>

      {/* Mobile stat row (md breakpoint hides the inline grid above) */}
      <div className="md:hidden flex items-center gap-4 px-4 pb-3 -mt-1">
        <span className="text-xs" style={{ color: 'var(--text-secondary)' }}><strong>{d.totalStudents}</strong> students</span>
        <span className="text-xs" style={{ color: 'var(--text-secondary)' }}><strong>{d.totalSubjects}</strong> subjects</span>
        <span className="text-xs" style={{ color: 'var(--text-secondary)' }}><strong>{d.totalTeachers}</strong> teachers</span>
      </div>

      {!hasBatches && (
        <div className="px-4 pb-4 -mt-1">
          <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
            No batches yet — data appears here once students are{' '}
            <Link to="/admin/upload-json" className="font-medium" style={{ color: 'var(--brand-primary)' }}>uploaded</Link>{' '}
            or a subject is created for this department.
          </p>
        </div>
      )}

      {hasBatches && isOpen && (
        <div className="px-4 pb-4 pt-1 space-y-2.5" style={{ borderTop: '1px solid var(--border-soft)' }}>
          <div className="pt-3 space-y-2.5">
            {d.batches.map(b => (
              <BatchNode
                key={b.batch}
                b={b}
                isOpen={openBatches.has(`${d.department}__${b.batch}`)}
                onToggle={() => onToggleBatch(`${d.department}__${b.batch}`)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

export default function AcademicStructurePage() {
  const [departments, setDepartments] = useState([])
  const [pagination, setPagination] = useState({ page: 1, totalPages: 1, total: 0 })
  const [summary, setSummary] = useState(null)
  const [deptOptions, setDeptOptions] = useState([])
  const [loading, setLoading] = useState(false)
  const [summaryLoading, setSummaryLoading] = useState(true)

  const [search, setSearch] = useState('')
  const [department, setDepartment] = useState('')
  const [page, setPage] = useState(1)

  const [openDepts, setOpenDepts] = useState(() => new Set())
  const [openBatches, setOpenBatches] = useState(() => new Set())

  useEffect(() => {
    departmentAPI.getAll().then(r => setDeptOptions(r.data?.data?.departments || [])).catch(() => {})
  }, [])

  const loadSummary = useCallback(async () => {
    setSummaryLoading(true)
    try {
      const res = await academicStructureAPI.getSummary()
      setSummary(res.data?.data || null)
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setSummaryLoading(false)
    }
  }, [])

  const loadStructure = useCallback(async () => {
    setLoading(true)
    try {
      const params = { search, department, page, limit: 8 }
      const res = await academicStructureAPI.getAll(params)
      setDepartments(res.data?.data?.departments || [])
      setPagination(res.data?.data?.pagination || { page: 1, totalPages: 1, total: 0 })
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }, [search, department, page])

  useEffect(() => { loadSummary() }, [loadSummary])

  useEffect(() => {
    const t = setTimeout(loadStructure, 300) // debounce search
    return () => clearTimeout(t)
  }, [loadStructure])

  useEffect(() => { setPage(1) }, [search, department])

  // When a search is active, auto-expand every matching department/batch so
  // results are immediately visible instead of hidden behind a collapsed node.
  useEffect(() => {
    if (!search) return
    setOpenDepts(new Set(departments.map(d => d.department)))
    setOpenBatches(new Set(departments.flatMap(d => d.batches.map(b => `${d.department}__${b.batch}`))))
  }, [search, departments])

  const refreshAll = () => { loadSummary(); loadStructure() }

  const toggleDept = (name) => {
    setOpenDepts(prev => {
      const next = new Set(prev)
      next.has(name) ? next.delete(name) : next.add(name)
      return next
    })
  }
  const toggleBatch = (key) => {
    setOpenBatches(prev => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      return next
    })
  }

  const allExpandable = useMemo(() => departments.filter(d => d.totalBatches > 0), [departments])
  const allExpanded = allExpandable.length > 0 && allExpandable.every(d => openDepts.has(d.department))

  const expandAll = () => {
    setOpenDepts(new Set(allExpandable.map(d => d.department)))
    setOpenBatches(new Set(allExpandable.flatMap(d => d.batches.map(b => `${d.department}__${b.batch}`))))
  }
  const collapseAll = () => {
    setOpenDepts(new Set())
    setOpenBatches(new Set())
  }

  return (
    <div className="space-y-6 p-4 sm:p-6 max-w-6xl mx-auto">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
            <LuFolderTree size={22} style={{ color: 'var(--brand-primary)' }} /> Academic Structure
          </h1>
          <p className="text-sm mt-0.5" style={{ color: 'var(--text-muted)' }}>
            Department → Batch → Shift hierarchy across the institution
          </p>
        </div>
        <button onClick={refreshAll} disabled={loading || summaryLoading} className="btn-secondary disabled:opacity-50">
          <LuRefreshCw size={13} className={(loading || summaryLoading) ? 'animate-spin' : ''} /> Refresh
        </button>
      </div>

      {/* Quick statistics */}
      {summaryLoading ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          {[1, 2, 3, 4, 5, 6].map(i => <div key={i} className="skeleton h-24 w-full" />)}
        </div>
      ) : summary ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          <StatCard icon={LuBuilding2} label="Departments" value={summary.totalDepartments} color="brand" />
          <StatCard icon={LuLayers} label="Batches" value={summary.totalBatches} color="purple" />
          <StatCard icon={LuGraduationCap} label="Class Groups" value={summary.totalShiftGroups} color="amber" />
          <StatCard icon={LuUsers} label="Students" value={summary.totalStudents} color="green" />
          <StatCard icon={LuBookOpen} label="Subjects" value={summary.totalSubjects} color="rose" />
          <StatCard icon={LuUserCheck} label="Teachers Assigned" value={summary.totalTeachersAssigned} color="cyan" />
        </div>
      ) : null}

      {/* Filters */}
      <div className="card p-4 flex flex-col sm:flex-row gap-3 sm:items-end">
        <div className="flex-1">
          <label className="form-label">Search</label>
          <div className="relative">
            <LuSearch size={13} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-muted)' }} />
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Department, batch, or shift…"
              className="input-field pl-8" />
          </div>
        </div>
        <div className="sm:w-56">
          <label className="form-label">Department</label>
          <div className="relative">
            <select value={department} onChange={e => setDepartment(e.target.value)} className="select-field">
              <option value="">All Departments</option>
              {deptOptions.map(d => <option key={d} value={d}>{d}</option>)}
            </select>
            <LuChevronDown size={12} className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" style={{ color: 'var(--text-muted)' }} />
          </div>
        </div>
        <button onClick={allExpanded ? collapseAll : expandAll} className="btn-secondary shrink-0">
          {allExpanded ? <><LuMinimize2 size={13} /> Collapse All</> : <><LuExpand size={13} /> Expand All</>}
        </button>
      </div>

      {/* Hierarchy */}
      {loading ? (
        <div className="space-y-3">
          {[1, 2, 3].map(i => <div key={i} className="skeleton h-20 w-full" />)}
        </div>
      ) : departments.length === 0 ? (
        <div className="empty-state">
          <LuFolderTree size={32} className="empty-state-icon" />
          {pagination.total === 0 && !search && !department ? (
            <>
              <p className="text-sm">No departments have been created yet.</p>
              <Link to="/admin/departments" className="text-xs font-medium mt-2 inline-block" style={{ color: 'var(--brand-primary)' }}>
                Go to Manage Departments →
              </Link>
            </>
          ) : (
            <p className="text-sm">No departments match these filters.</p>
          )}
        </div>
      ) : (
        <>
          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
            {pagination.total} department{pagination.total !== 1 ? 's' : ''} found
          </p>

          <div className="space-y-3">
            {departments.map(d => (
              <DepartmentNode
                key={d.department}
                d={d}
                isOpen={openDepts.has(d.department)}
                onToggle={() => toggleDept(d.department)}
                openBatches={openBatches}
                onToggleBatch={toggleBatch}
              />
            ))}
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
