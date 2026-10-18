/**
 * ApproveTeachersPage — college-scoped teacher registration review.
 *
 * Everything shown here is filtered by the SERVER to the logged-in admin's own
 * college; the UI never sends a college id. Approve/Reject are final decisions
 * (rejecting asks for a second click). If another admin decides first, the
 * server answers 409 and the list refreshes with an explanation.
 */
import { LuCircleCheck, LuCircleX, LuClock, LuRefreshCw, LuTrash2, LuUsers, LuBuilding2, LuTriangleAlert } from 'react-icons/lu'
import { useState, useEffect, useCallback, useRef } from 'react'

import toast from 'react-hot-toast'
import { teacherRequestAPI, authAPI, getErrorMessage } from '@services/api'
import {
  STATUS_TABS, STATUS_BADGE, formatRegisteredAt, timeAgo, formatCollege, decisionFailure,
} from '@utils/teacherRequests'

export default function ApproveTeachers() {
  const [rows, setRows]         = useState([])
  const [counts, setCounts]     = useState({ pending: 0, approved: 0, rejected: 0 })
  const [college, setCollege]   = useState(null)
  const [loading, setLoading]   = useState(false)
  const [blocked, setBlocked]   = useState('')          // e.g. "Your college is suspended…"
  const [filter, setFilter]     = useState('pending')
  const [actingOn, setActingOn] = useState(null)        // id currently being decided
  const [confirmReject, setConfirmReject] = useState(null)
  const reqSeq = useRef(0)                              // ignore out-of-order responses

  const load = useCallback(async () => {
    const seq = ++reqSeq.current
    setLoading(true)
    try {
      const res = await teacherRequestAPI.list({ status: filter })
      if (seq !== reqSeq.current) return
      const d = res.data?.data || {}
      setRows(d.requests || [])
      setCounts(d.counts || { pending: 0, approved: 0, rejected: 0 })
      setCollege(d.college || null)
      setBlocked('')
    } catch (err) {
      if (seq !== reqSeq.current) return
      if (err?.response?.status === 403) { setBlocked(getErrorMessage(err)); setRows([]) }
      else toast.error(getErrorMessage(err))
    } finally {
      if (seq === reqSeq.current) setLoading(false)
    }
  }, [filter])

  useEffect(() => { load() }, [load])

  const decide = async (row, decision) => {
    setActingOn(row.id); setConfirmReject(null)
    try {
      await (decision === 'approve' ? teacherRequestAPI.approve(row.id) : teacherRequestAPI.reject(row.id))
      toast.success(decision === 'approve' ? `${row.name} approved` : `${row.name} rejected`)
      await load()
    } catch (err) {
      const f = decisionFailure(err)
      toast.error(f.conflict ? `${f.message} Refreshing the list.` : f.message)
      if (f.refresh) await load()
    } finally {
      setActingOn(null)
    }
  }

  const handleDelete = async (row) => {
    if (!window.confirm(`Delete ${row.name} permanently? They will be able to register again.`)) return
    setActingOn(row.id)
    try {
      await authAPI.deleteUser(row.id)
      toast.success('User deleted')
      await load()
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setActingOn(null)
    }
  }

  const countFor = (v) => (v === 'all' ? counts.pending + counts.approved + counts.rejected : counts[v])

  return (
    <div className="space-y-6 p-4 sm:p-6 max-w-5xl mx-auto">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>Teacher Requests</h1>
          <p className="text-sm mt-0.5 flex items-center gap-1.5" style={{ color: 'var(--text-muted)' }}>
            <LuBuilding2 size={13} />
            {college?.name ? `Registrations for ${college.name}` : 'Approve or reject teacher registrations'}
          </p>
        </div>
        <button onClick={load} disabled={loading} className="btn-secondary disabled:opacity-50">
          <LuRefreshCw size={13} className={loading ? 'animate-spin' : ''} /> Refresh
        </button>
      </div>

      <div className="flex gap-2 flex-wrap" role="tablist" aria-label="Request status">
        {STATUS_TABS.map(({ value, label }) => (
          <button key={value} role="tab" aria-selected={filter === value} onClick={() => setFilter(value)}
            className={`filter-tab ${filter === value ? 'active' : ''}`}>
            {label}
            <span className="ml-1.5 text-[11px] opacity-70">{countFor(value)}</span>
          </button>
        ))}
      </div>

      {blocked && (
        <div role="alert" className="flex items-start gap-2 text-sm rounded-xl px-3.5 py-3"
          style={{ background: 'var(--warning-bg)', border: '1px solid var(--warning-border)', color: 'var(--warning-text)' }}>
          <LuTriangleAlert size={16} className="shrink-0 mt-0.5" />
          <span>{blocked}</span>
        </div>
      )}

      {loading && rows.length === 0 ? (
        <div className="space-y-3">{[1, 2, 3].map(i => <div key={i} className="skeleton h-16 w-full" />)}</div>
      ) : rows.length === 0 && !blocked ? (
        <div className="empty-state">
          <LuUsers size={40} className="empty-state-icon" />
          <p>{filter === 'pending' ? 'No pending requests' : `No ${filter === 'all' ? '' : filter + ' '}teachers found`}</p>
        </div>
      ) : (
        <ul className="space-y-3" aria-busy={loading}>
          {rows.map(row => {
            const busy = actingOn === row.id
            return (
              <li key={row.id} className="card p-4 flex items-start justify-between gap-4 flex-wrap">
                <div className="flex items-start gap-3 min-w-0">
                  <div className="w-10 h-10 rounded-xl flex items-center justify-center text-sm font-bold shrink-0"
                    style={{ background: 'var(--brand-50)', color: 'var(--brand-primary)', border: '1px solid var(--brand-200)' }}>
                    {row.name?.charAt(0).toUpperCase()}
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{row.name}</p>
                    <p className="text-xs break-all" style={{ color: 'var(--text-muted)' }}>{row.email}</p>
                    <p className="text-xs mt-1 flex items-center gap-1" style={{ color: 'var(--text-secondary)' }}>
                      <LuBuilding2 size={11} /> {formatCollege(row.college)}
                    </p>
                    <p className="text-xs mt-0.5 flex items-center gap-1" style={{ color: 'var(--text-muted)' }}
                      title={formatRegisteredAt(row.registeredAt)}>
                      <LuClock size={11} /> Registered {formatRegisteredAt(row.registeredAt)} ({timeAgo(row.registeredAt)})
                    </p>
                    {row.department && <p className="text-xs mt-0.5" style={{ color: 'var(--text-secondary)' }}>{row.department}</p>}
                  </div>
                </div>

                <div className="flex items-center gap-2 flex-wrap">
                  <span className={`badge ${STATUS_BADGE[row.status] || 'badge-neutral'}`}>{row.status}</span>

                  {row.status === 'pending' && confirmReject !== row.id && (
                    <>
                      <button onClick={() => decide(row, 'approve')} disabled={busy}
                        aria-label={`Approve ${row.name}`}
                        className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg transition-all disabled:opacity-50"
                        style={{ color: 'var(--success-text)', background: 'var(--success-bg)', border: '1px solid var(--success-border)' }}>
                        <LuCircleCheck size={12} /> Approve
                      </button>
                      <button onClick={() => setConfirmReject(row.id)} disabled={busy}
                        aria-label={`Reject ${row.name}`}
                        className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg transition-all disabled:opacity-50"
                        style={{ color: 'var(--warning-text)', background: 'var(--warning-bg)', border: '1px solid var(--warning-border)' }}>
                        <LuCircleX size={12} /> Reject
                      </button>
                    </>
                  )}

                  {row.status === 'pending' && confirmReject === row.id && (
                    <>
                      <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>Reject {row.name}? This cannot be undone.</span>
                      <button onClick={() => decide(row, 'reject')} disabled={busy}
                        className="text-xs px-3 py-1.5 rounded-lg disabled:opacity-50"
                        style={{ color: 'var(--danger-text)', background: 'var(--danger-bg)', border: '1px solid var(--danger-border)' }}>
                        Yes, reject
                      </button>
                      <button onClick={() => setConfirmReject(null)} className="btn-secondary text-xs">Cancel</button>
                    </>
                  )}

                  {row.status !== 'pending' && (
                    <button onClick={() => handleDelete(row)} disabled={busy}
                      aria-label={`Delete ${row.name}`}
                      className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg transition-all disabled:opacity-50"
                      style={{ color: 'var(--danger-text)', background: 'var(--danger-bg)', border: '1px solid var(--danger-border)' }}>
                      <LuTrash2 size={12} /> Delete
                    </button>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
