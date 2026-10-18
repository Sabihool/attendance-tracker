/**
 * StudentReports.jsx — COLOR SYSTEM FIXED
 */
import { LuArrowRight, LuChevronDown, LuRefreshCw, LuUsers } from 'react-icons/lu'
import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'

import { useSubjects } from '@context/SubjectsContext'
import { attendanceAPI, getErrorMessage } from '@services/api'
import toast from 'react-hot-toast'

const THRESHOLD = 75

export default function StudentReports() {
  const navigate = useNavigate()
  const { subjects, fetchSubjects } = useSubjects()
  const [subjectId, setSubjectId] = useState('')
  const [data, setData]           = useState([])
  const [loading, setLoading]     = useState(false)

  useEffect(() => { fetchSubjects() }, [fetchSubjects])

  useEffect(() => {
    if (!subjectId) { setData([]); return }
    load()
  }, [subjectId])

  const load = async () => {
    setLoading(true)
    try {
      const res = await attendanceAPI.getPercentage(subjectId)
      setData(res.data?.data?.studentStats || res.data?.data || [])
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="space-y-6 p-4 sm:p-6 max-w-4xl mx-auto">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>Student Reports</h1>
          <p className="text-sm mt-0.5" style={{ color: 'var(--text-muted)' }}>Individual attendance per student</p>
        </div>
        {subjectId && (
          <button onClick={load} className="btn-secondary">
            <LuRefreshCw size={13} />
          </button>
        )}
      </div>

      <div className="relative max-w-sm">
        <select value={subjectId} onChange={e => setSubjectId(e.target.value)} className="select-field">
          <option value="">— Select a subject —</option>
          {subjects.map(s => <option key={s._id} value={s._id}>{s.subjectName} ({s.subjectCode})</option>)}
        </select>
        <LuChevronDown size={14} className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" style={{ color: 'var(--text-muted)' }} />
      </div>

      {!subjectId ? (
        <div className="empty-state">
          <LuUsers size={40} className="empty-state-icon" />
          <p>Select a subject</p>
        </div>
      ) : loading ? (
        <div className="space-y-3">{[1,2,3,4,5].map(i => <div key={i} className="skeleton h-16 w-full" />)}</div>
      ) : data.length === 0 ? (
        <div className="empty-state">
          <LuUsers size={40} className="empty-state-icon" />
          <p>No student data</p>
        </div>
      ) : (
        <div className="space-y-2">
          {data.map(s => {
            const pct = Math.round(s.percentage)
            const pctColor = pct >= 85
              ? 'var(--success-text)'
              : pct >= THRESHOLD
                ? 'var(--warning-text)'
                : 'var(--danger-text)'
            const barColor = pct >= 85 ? 'var(--success)' : pct >= THRESHOLD ? 'var(--warning)' : 'var(--danger)'
            return (
              <div key={s.studentId} className="card p-4 flex items-center gap-4">
                <div className="w-9 h-9 rounded-xl flex items-center justify-center text-xs font-bold shrink-0"
                  style={{ background: 'var(--brand-50)', color: 'var(--brand-primary)', border: '1px solid var(--brand-200)' }}>
                  {s.name?.charAt(0).toUpperCase()}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold truncate" style={{ color: 'var(--text-primary)' }}>{s.name}</p>
                  <div className="flex items-center gap-2 mt-1">
                    <div className="flex-1 h-1.5 rounded-full" style={{ background: 'var(--border)' }}>
                      <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, background: barColor }} />
                    </div>
                    <span className="text-xs font-mono font-bold shrink-0" style={{ color: pctColor }}>{pct}%</span>
                  </div>
                </div>
                <button
                  onClick={() => navigate('/teacher/individual-report', { state: { studentId: s.studentId, subjectId } })}
                  className="icon-btn brand shrink-0"
                  title="View details"
                >
                  <LuArrowRight size={14} />
                </button>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
