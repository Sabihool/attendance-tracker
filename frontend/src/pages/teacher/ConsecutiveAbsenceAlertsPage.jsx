/**
 * ConsecutiveAbsenceAlerts.jsx — COLOR SYSTEM FIXED
 * All API logic preserved exactly.
 */
import { LuTriangleAlert, LuBookOpen, LuBuilding2, LuCircleCheck, LuCircleX, LuClock, LuFilter, LuRefreshCw, LuSave, LuSearch, LuUser, LuUsers, LuX } from 'react-icons/lu'
import { useState, useEffect, useCallback } from 'react'

import { alertsAPI, getErrorMessage } from '@services/api'
import toast from 'react-hot-toast'

function StatusBadge({ percentage }) {
  if (percentage >= 75) {
    return (
      <span className="badge badge-success flex items-center gap-1">
        <LuCircleCheck size={10} /> Active
      </span>
    )
  }
  if (percentage >= 50) {
    return (
      <span className="badge badge-warning flex items-center gap-1">
        <LuClock size={10} /> Warning
      </span>
    )
  }
  return (
    <span className="badge badge-danger flex items-center gap-1">
      <LuCircleX size={10} /> Critical
    </span>
  )
}

function AlertCard({ alert, onRemove, onNoteUpdate }) {
  const [note, setNote] = useState(alert.note || '')
  const [saving, setSaving] = useState(false)
  const [removing, setRemoving] = useState(false)

  const handleSaveNote = async () => {
    setSaving(true)
    try {
      await onNoteUpdate(alert._id, note)
      toast.success('Note saved')
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  const handleRemove = async () => {
    if (!window.confirm(`Remove alert for ${alert.studentName}? The record will be kept for history.`)) return
    setRemoving(true)
    try {
      await onRemove(alert._id)
      toast.success('Alert removed')
    } catch (err) {
      toast.error(getErrorMessage(err))
      setRemoving(false)
    }
  }

  const initials = alert.studentName?.split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase() || '??'

  return (
    <div className="card p-5 transition-all duration-200 hover:shadow-lg"
      style={{ borderColor: 'var(--warning-border)' }}>
      {/* Header */}
      <div className="flex items-start gap-4 mb-4">
        <div className="w-12 h-12 rounded-xl flex items-center justify-center shrink-0"
          style={{ background: 'var(--warning-bg)', border: '1px solid var(--warning-border)' }}>
          <span className="text-sm font-bold font-mono" style={{ color: 'var(--warning-text)' }}>{initials}</span>
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-2">
            <div>
              <p className="font-semibold text-sm" style={{ color: 'var(--text-primary)' }}>{alert.studentName}</p>
              <p className="text-xs font-mono mt-0.5" style={{ color: 'var(--text-muted)' }}>Roll: {alert.studentRoll}</p>
            </div>
            <span className="badge badge-danger flex items-center gap-1 shrink-0">
              <LuTriangleAlert size={10} /> {alert.consecutiveMissCount} Miss
            </span>
          </div>
          {/* Meta row */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-2">
            <span className="flex items-center gap-1 text-xs" style={{ color: 'var(--text-muted)' }}>
              <LuBuilding2 size={10} /> {alert.department}
            </span>
            <span className="flex items-center gap-1 text-xs" style={{ color: 'var(--text-muted)' }}>
              <LuUsers size={10} /> Batch {alert.batch}
            </span>
            {alert.subjectName && (
              <span className="flex items-center gap-1 text-xs" style={{ color: 'var(--text-muted)' }}>
                <LuBookOpen size={10} /> {alert.subjectName}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Alert date */}
      <p className="text-xs mb-3" style={{ color: 'var(--text-muted)' }}>
        Flagged on: {new Date(alert.createdAt).toLocaleDateString('en-US', {
          year: 'numeric', month: 'short', day: 'numeric'
        })}
      </p>

      {/* Note input */}
      <div className="mb-4">
        <label className="form-label">Teacher Note</label>
        <textarea
          value={note}
          onChange={e => setNote(e.target.value)}
          rows={2}
          placeholder="Add a follow-up note..."
          className="input-field resize-none"
          style={{ borderRadius: '10px', fontFamily: 'Poppins, sans-serif' }}
        />
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2">
        <button
          onClick={handleSaveNote}
          disabled={saving}
          className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold transition-all disabled:opacity-50"
          style={{ background: 'var(--brand-50)', color: 'var(--brand-primary)', border: '1px solid var(--brand-200)' }}
        >
          <LuSave size={12} className={saving ? 'animate-pulse' : ''} />
          {saving ? 'Saving…' : 'Save Note'}
        </button>
        <button
          onClick={handleRemove}
          disabled={removing}
          className="flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold transition-all disabled:opacity-50"
          style={{ background: 'var(--danger-bg)', color: 'var(--danger-text)', border: '1px solid var(--danger-border)' }}
        >
          <LuX size={12} className={removing ? 'animate-spin' : ''} />
          {removing ? '…' : 'Remove Alert'}
        </button>
      </div>
    </div>
  )
}

export default function ConsecutiveAbsenceAlerts() {
  const [alerts, setAlerts] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [filterDept, setFilterDept] = useState('')
  const [filterBatch, setFilterBatch] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  // Filter options accumulate across fetches so picking one department does not remove the others from the list.
  const [options, setOptions] = useState({ departments: [], batches: [] })

  const fetchAlerts = useCallback(async () => {
    try {
      const params = { removed: false }
      if (filterDept) params.department = filterDept
      if (filterBatch) params.batch = filterBatch
      const res = await alertsAPI.getAll(params)
      const list = res.data?.data?.alerts || []
      setAlerts(list)
      setOptions(prev => ({
        departments: [...new Set([...prev.departments, ...list.map(a => a.department).filter(Boolean)])].sort(),
        batches:     [...new Set([...prev.batches,     ...list.map(a => a.batch).filter(Boolean)])].sort(),
      }))
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [filterDept, filterBatch])

  useEffect(() => { fetchAlerts() }, [fetchAlerts])

  const handleRefresh = async () => {
    setRefreshing(true)
    await fetchAlerts()
    toast.success('Refreshed')
  }

  const handleRemove    = async (id) => {
    await alertsAPI.remove(id)
    setAlerts(prev => prev.filter(a => a._id !== id))
  }
  const handleNoteUpdate = async (id, note) => {
    await alertsAPI.updateNote(id, note)
    setAlerts(prev => prev.map(a => a._id === id ? { ...a, note } : a))
  }

  const departments = options.departments
  const batches     = options.batches

  const filtered = alerts.filter(a => {
    if (!search) return true
    const q = search.toLowerCase()
    return (
      a.studentName?.toLowerCase().includes(q) ||
      a.studentRoll?.toLowerCase().includes(q) ||
      a.subjectName?.toLowerCase().includes(q)
    )
  })

  return (
    <div className="space-y-6 p-4 sm:p-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
            <LuTriangleAlert size={22} style={{ color: 'var(--warning-text)' }} />
            Consecutive Absence Alerts
          </h1>
          <p className="text-sm mt-0.5" style={{ color: 'var(--text-muted)' }}>
            Students who missed 3 or more classes in a row
          </p>
        </div>
        <button onClick={handleRefresh} disabled={refreshing} className="btn-secondary disabled:opacity-50">
          <LuRefreshCw size={14} className={refreshing ? 'animate-spin' : ''} /> Refresh
        </button>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {[
          { label: 'Active Alerts', value: alerts.length, icon: LuTriangleAlert, bg: 'var(--warning-bg)', color: 'var(--warning-text)', border: 'var(--warning-border)' },
          { label: 'Unique Students', value: new Set(alerts.map(a => a.studentId)).size, icon: LuUser, bg: 'var(--danger-bg)', color: 'var(--danger-text)', border: 'var(--danger-border)' },
          { label: 'Subjects Affected', value: new Set(alerts.map(a => a.subjectId)).size, icon: LuBookOpen, bg: 'var(--brand-50)', color: 'var(--brand-primary)', border: 'var(--brand-200)' },
        ].map(({ label, value, icon: Icon, bg, color, border }) => (
          <div key={label} className="card p-4 flex items-center gap-3" style={{ borderColor: border }}>
            <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0" style={{ background: bg, border: `1px solid ${border}` }}>
              <Icon size={18} style={{ color }} />
            </div>
            <div>
              <p className="text-2xl font-bold font-mono" style={{ color }}>
                {loading ? '…' : value}
              </p>
              <p className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>{label}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div className="card p-4">
        <div className="flex flex-wrap gap-3 items-center">
          <div className="flex items-center gap-2 flex-1 min-w-48 rounded-lg px-3 py-2"
            style={{ background: 'var(--bg-input)', border: '1.5px solid var(--border-strong)' }}>
            <LuSearch size={14} style={{ color: 'var(--text-muted)' }} className="shrink-0" />
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search by name, roll, or subject…"
              className="flex-1 bg-transparent text-sm outline-none"
              style={{ color: 'var(--text-primary)', fontFamily: 'Poppins, sans-serif' }}
            />
          </div>
          <div className="flex items-center gap-2">
            <LuFilter size={14} style={{ color: 'var(--text-muted)' }} className="shrink-0" />
            <select value={filterDept} onChange={e => setFilterDept(e.target.value)} className="select-field" style={{ width: 'auto' }}>
              <option value="">All Departments</option>
              {departments.map(d => <option key={d} value={d}>{d}</option>)}
            </select>
            <select value={filterBatch} onChange={e => setFilterBatch(e.target.value)} className="select-field" style={{ width: 'auto' }}>
              <option value="">All Batches</option>
              {batches.map(b => <option key={b} value={b}>Batch {b}</option>)}
            </select>
          </div>
        </div>
      </div>

      {/* Alert grid */}
      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {[1,2,3,4,5,6].map(i => <div key={i} className="skeleton h-52 w-full" />)}
        </div>
      ) : filtered.length === 0 ? (
        <div className="card p-12 text-center">
          <LuTriangleAlert size={40} className="empty-state-icon" />
          <p className="font-medium" style={{ color: 'var(--text-secondary)' }}>
            {alerts.length === 0 ? 'No active consecutive absence alerts' : 'No alerts match your search'}
          </p>
          <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>
            Alerts are created automatically when a student misses 3 classes in a row.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {filtered.map(alert => (
            <AlertCard key={alert._id} alert={alert} onRemove={handleRemove} onNoteUpdate={handleNoteUpdate} />
          ))}
        </div>
      )}
    </div>
  )
}
