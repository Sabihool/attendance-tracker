/**
 * TeacherManagementPage — college-scoped member management.
 *
 * View teachers (and admins) of the admin's OWN college, review status and
 * activity, approve / reject, promote to admin, remove admin privileges, delete.
 * Everything is filtered by the SERVER; the UI never sends a college or a role.
 * The buttons shown mirror `member.capabilities` from the server, but the server
 * re-checks every action, so hiding a button is a convenience, not the security.
 */
import { LuBuilding2, LuCircleCheck, LuCircleX, LuCrown, LuRefreshCw, LuSearch, LuShield, LuShieldOff, LuTrash2, LuTriangleAlert, LuUsers } from 'react-icons/lu'
import { useState, useEffect, useCallback, useRef } from 'react'
import toast from 'react-hot-toast'

import { teacherManagementAPI, getErrorMessage } from '@services/api'
import { STATUS_BADGE, formatRegisteredAt } from '@utils/teacherRequests'
import { TYPE_TABS, STATUS_FILTERS, ROLE_LABEL, activitySummary, confirmMessage, actionFailure, roleChangeNotice } from '@utils/teacherManagement'

const ACTIONS = [
  { key: 'approve', cap: 'canApprove', label: 'Approve', icon: LuCircleCheck, tone: 'success' },
  { key: 'reject',  cap: 'canReject',  label: 'Reject',  icon: LuCircleX,     tone: 'warning', confirm: true },
  { key: 'promote', cap: 'canPromote', label: 'Make admin', icon: LuShield,   tone: 'brand',   confirm: true },
  { key: 'demote',  cap: 'canDemote',  label: 'Remove admin', icon: LuShieldOff, tone: 'warning', confirm: true },
  { key: 'remove',  cap: 'canDelete',  label: 'Delete',  icon: LuTrash2,      tone: 'danger',  confirm: true },
]
const TONE = {
  success: { color: 'var(--success-text)', background: 'var(--success-bg)', border: '1px solid var(--success-border)' },
  warning: { color: 'var(--warning-text)', background: 'var(--warning-bg)', border: '1px solid var(--warning-border)' },
  danger:  { color: 'var(--danger-text)',  background: 'var(--danger-bg)',  border: '1px solid var(--danger-border)' },
  brand:   { color: 'var(--brand-primary)', background: 'var(--brand-50)',  border: '1px solid var(--brand-200)' },
}

export default function TeacherManagementPage() {
  const [members, setMembers]   = useState([])
  const [counts, setCounts]     = useState({ pending: 0, approved: 0, rejected: 0, admins: 0 })
  const [college, setCollege]   = useState(null)
  const [loading, setLoading]   = useState(false)
  const [blocked, setBlocked]   = useState('')
  const [type, setType]         = useState('teacher')
  const [status, setStatus]     = useState('all')
  const [query, setQuery]       = useState('')
  const [search, setSearch]     = useState('')
  const [page, setPage]         = useState(1)
  const [pages, setPages]       = useState(1)
  const [actingOn, setActingOn] = useState(null)
  const [confirming, setConfirming] = useState(null)   // { id, action }
  const reqSeq = useRef(0)

  useEffect(() => { const t = setTimeout(() => { setSearch(query.trim()); setPage(1) }, 300); return () => clearTimeout(t) }, [query])

  const load = useCallback(async () => {
    const seq = ++reqSeq.current
    setLoading(true)
    try {
      const res = await teacherManagementAPI.list({ type, status: type === 'admin' ? 'all' : status, q: search || undefined, page })
      if (seq !== reqSeq.current) return
      const d = res.data?.data || {}
      setMembers(d.members || []); setCounts(d.counts || counts); setCollege(d.college || null)
      setPages(d.pagination?.totalPages || 1); setBlocked('')
    } catch (err) {
      if (seq !== reqSeq.current) return
      if (err?.response?.status === 403) { setBlocked(getErrorMessage(err)); setMembers([]) }
      else toast.error(getErrorMessage(err))
    } finally { if (seq === reqSeq.current) setLoading(false) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type, status, search, page])

  useEffect(() => { load() }, [load])

  const perform = async (m, action) => {
    setActingOn(m.id); setConfirming(null)
    try {
      await teacherManagementAPI[action](m.id)
      toast.success(
        action === 'promote' || action === 'demote' ? roleChangeNotice(action, m.name)
          : action === 'approve' ? `${m.name} approved` : action === 'reject' ? `${m.name} rejected` : 'Teacher deleted'
      )
      await load()
    } catch (err) {
      const f = actionFailure(err)
      toast.error(f.refresh ? `${f.message} Refreshing the list.` : f.message)
      if (f.refresh) await load()
    } finally { setActingOn(null) }
  }

  const onAction = (m, a) => (a.confirm ? setConfirming({ id: m.id, action: a.key }) : perform(m, a.key))

  return (
    <div className="space-y-6 p-4 sm:p-6 max-w-5xl mx-auto">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>Teachers & Admins</h1>
          <p className="text-sm mt-0.5 flex items-center gap-1.5" style={{ color: 'var(--text-muted)' }}>
            <LuBuilding2 size={13} />{college?.name ? `Members of ${college.name}` : 'Manage your college’s teachers'}
            {counts.pending > 0 && <span className="badge badge-warning ml-2">{counts.pending} pending</span>}
          </p>
        </div>
        <button onClick={load} disabled={loading} className="btn-secondary disabled:opacity-50">
          <LuRefreshCw size={13} className={loading ? 'animate-spin' : ''} /> Refresh
        </button>
      </div>

      <div className="flex gap-2 flex-wrap items-center">
        <div className="flex gap-2" role="tablist" aria-label="Member type">
          {TYPE_TABS.map(({ value, label }) => (
            <button key={value} role="tab" aria-selected={type === value} onClick={() => { setType(value); setPage(1) }}
              className={`filter-tab ${type === value ? 'active' : ''}`}>{label}</button>
          ))}
        </div>
        {type !== 'admin' && (
          <select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1) }} aria-label="Status" className="input text-xs py-1.5 w-auto">
            {STATUS_FILTERS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
        )}
        <div className="relative flex-1 min-w-[180px]">
          <LuSearch size={13} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-muted)' }} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search name or email" maxLength={100}
            aria-label="Search" className="input w-full pl-8 text-sm" />
        </div>
      </div>

      {blocked && (
        <div role="alert" className="flex items-start gap-2 text-sm rounded-xl px-3.5 py-3"
          style={{ background: 'var(--warning-bg)', border: '1px solid var(--warning-border)', color: 'var(--warning-text)' }}>
          <LuTriangleAlert size={16} className="shrink-0 mt-0.5" /><span>{blocked}</span>
        </div>
      )}

      {loading && members.length === 0 ? (
        <div className="space-y-3">{[1, 2, 3].map((i) => <div key={i} className="skeleton h-16 w-full" />)}</div>
      ) : members.length === 0 && !blocked ? (
        <div className="empty-state"><LuUsers size={40} className="empty-state-icon" /><p>No members found</p></div>
      ) : (
        <ul className="space-y-3" aria-busy={loading}>
          {members.map((m) => {
            const busy = actingOn === m.id
            const asking = confirming?.id === m.id ? ACTIONS.find((a) => a.key === confirming.action) : null
            return (
              <li key={m.id} className="card p-4 flex items-start justify-between gap-4 flex-wrap">
                <div className="min-w-0">
                  <p className="text-sm font-semibold flex items-center gap-1.5 flex-wrap" style={{ color: 'var(--text-primary)' }}>
                    {m.name}
                    {m.isSelf && <span className="badge badge-neutral">You</span>}
                    {m.isFounder && <span className="badge badge-warning" title="Original administrator — cannot be removed"><LuCrown size={10} /> Original admin</span>}
                  </p>
                  <p className="text-xs break-all" style={{ color: 'var(--text-muted)' }}>{m.email}</p>
                  {m.department && <p className="text-xs mt-0.5" style={{ color: 'var(--text-secondary)' }}>{m.department}</p>}
                  <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>Registered {formatRegisteredAt(m.registeredAt)}</p>
                  {m.activity && <p className="text-xs mt-1" style={{ color: m.activity.quiet ? 'var(--warning-text)' : 'var(--text-secondary)' }}>{activitySummary(m.activity)}{m.activity.quiet ? ' — quiet lately' : ''}</p>}
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="badge badge-neutral">{ROLE_LABEL[m.role] || m.role}</span>
                  <span className={`badge ${STATUS_BADGE[m.status] || 'badge-neutral'}`}>{m.status}</span>
                  {asking ? (
                    <>
                      <span className="text-xs max-w-xs" style={{ color: 'var(--text-secondary)' }}>{confirmMessage(asking.key, m)}</span>
                      <button onClick={() => perform(m, asking.key)} disabled={busy} className="text-xs px-3 py-1.5 rounded-lg disabled:opacity-50" style={TONE[asking.tone]}>Yes, {asking.label.toLowerCase()}</button>
                      <button onClick={() => setConfirming(null)} className="btn-secondary text-xs">Cancel</button>
                    </>
                  ) : ACTIONS.filter((a) => m.capabilities?.[a.cap]).map((a) => (
                    <button key={a.key} onClick={() => onAction(m, a)} disabled={busy} aria-label={`${a.label} ${m.name}`}
                      className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg transition-all disabled:opacity-50" style={TONE[a.tone]}>
                      <a.icon size={12} /> {a.label}
                    </button>
                  ))}
                </div>
              </li>
            )
          })}
        </ul>
      )}

      {pages > 1 && (
        <div className="flex items-center justify-center gap-3 text-sm">
          <button className="btn-secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</button>
          <span style={{ color: 'var(--text-muted)' }}>Page {page} of {pages}</span>
          <button className="btn-secondary" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>Next</button>
        </div>
      )}
    </div>
  )
}
