/**
 * IndividualStudentReport.jsx — COLOR SYSTEM FIXED
 */
import { LuArrowLeft, LuCircleCheck, LuCircleX, LuRefreshCw } from 'react-icons/lu'
import { useState, useEffect } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'

import { attendanceAPI, getErrorMessage } from '@services/api'
import toast from 'react-hot-toast'

export default function IndividualStudentReport() {
  const location = useLocation()
  const navigate  = useNavigate()
  const { studentId, subjectId } = location.state || {}
  const [sessions, setSessions] = useState([])
  const [summary, setSummary]   = useState(null)
  const [loading, setLoading]   = useState(false)

  useEffect(() => {
    if (!subjectId || !studentId) return
    load()
  }, [subjectId, studentId])

  const load = async () => {
    setLoading(true)
    try {
      const [sessRes, pctRes] = await Promise.all([
        attendanceAPI.getAll(subjectId),
        attendanceAPI.getPercentage(subjectId),
      ])
      const allSessions = sessRes.data?.data?.records || []
      const relevant = allSessions.map(sess => {
        const record = sess.students?.find(r => r.studentId === studentId)
        return record ? { ...sess, present: record.status === 'present' } : null
      }).filter(Boolean)
      setSessions(relevant)
      const pcts = pctRes.data?.data?.studentStats || []
      const mine = pcts.find(s => s.studentId === studentId) || null
      setSummary(mine)
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }

  if (!subjectId || !studentId) {
    return (
      <div className="p-6 text-center" style={{ color: 'var(--text-muted)' }}>
        <p>No student selected.{' '}
          <button onClick={() => navigate(-1)} style={{ color: 'var(--brand-primary)' }} className="hover:underline">Go back</button>
        </p>
      </div>
    )
  }

  const pct = summary ? Math.round(summary.percentage || 0) : 0
  const pctColor = pct >= 85
    ? 'var(--success-text)'
    : pct >= 75
      ? 'var(--warning-text)'
      : 'var(--danger-text)'

  return (
    <div className="space-y-6 p-4 sm:p-6 max-w-3xl mx-auto">
      <div className="flex items-center gap-3">
        <button onClick={() => navigate(-1)} className="icon-btn"><LuArrowLeft size={18} /></button>
        <div className="flex-1">
          <h1 className="text-xl font-bold" style={{ color: 'var(--text-primary)' }}>Student Report</h1>
          <p className="text-sm font-mono" style={{ color: 'var(--text-muted)' }}>
            {summary?.roll ? `Roll: ${summary.roll}` : studentId}
          </p>
        </div>
        <button onClick={load} disabled={loading} className="btn-secondary disabled:opacity-50">
          <LuRefreshCw size={13} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {summary && (
        <div className="card p-5 flex flex-wrap gap-6 items-center">
          <div className="text-5xl font-bold font-mono" style={{ color: pctColor }}>{pct}%</div>
          <div className="space-y-1">
            <p className="font-semibold text-lg" style={{ color: 'var(--text-primary)' }}>{summary.name}</p>
            <div className="flex items-center gap-2 flex-wrap">
              {summary.roll && (
                <span className="text-sm font-mono font-bold" style={{ color: 'var(--brand-primary)' }}>Roll: {summary.roll}</span>
              )}
              <span className="text-sm font-mono" style={{ color: 'var(--text-muted)' }}>{summary.studentId}</span>
            </div>
            <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
              {summary.attended} attended · {summary.total - summary.attended} absent · {sessions.length} sessions
            </p>
          </div>
        </div>
      )}

      {loading ? (
        <div className="space-y-2">{[1,2,3,4,5].map(i => <div key={i} className="skeleton h-12 w-full" />)}</div>
      ) : sessions.length === 0 ? (
        <div className="empty-state"><p className="text-sm">No sessions found</p></div>
      ) : (
        <div className="card p-5">
          <h2 className="text-sm font-semibold mb-3" style={{ color: 'var(--text-primary)' }}>Session History ({sessions.length})</h2>
          <div className="space-y-2 max-h-80 overflow-y-auto pr-1">
            {sessions.map(sess => (
              <div key={sess._id}
                className="flex items-center gap-3 px-4 py-3 rounded-xl"
                style={{
                  background: sess.present ? 'var(--success-bg)' : 'var(--danger-bg)',
                  border: `1px solid ${sess.present ? 'var(--success-border)' : 'var(--danger-border)'}`,
                }}>
                {sess.present
                  ? <LuCircleCheck size={15} className="shrink-0" style={{ color: 'var(--success-text)' }} />
                  : <LuCircleX size={15} className="shrink-0" style={{ color: 'var(--danger-text)' }} />}
                <div className="flex-1 flex items-center justify-between">
                  <div>
                    <p className="text-sm font-mono font-medium" style={{ color: 'var(--text-primary)' }}>
                      {typeof sess.date === 'string' ? sess.date.split('T')[0] : sess.date}
                    </p>
                    <p className="text-xs capitalize" style={{ color: 'var(--text-muted)' }}>{sess.classType}</p>
                  </div>
                  <span className="text-xs font-semibold" style={{ color: sess.present ? 'var(--success-text)' : 'var(--danger-text)' }}>
                    {sess.present ? 'Present' : 'Absent'}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
