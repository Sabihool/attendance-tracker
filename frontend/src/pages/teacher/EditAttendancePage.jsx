/**
 * EditAttendancePage.jsx
 * Attendance Edit System (spec section 6).
 *
 * Flow:
 *   1. Teacher chooses a subject
 *   2. System shows every attendance date for that subject + that day's %
 *   3. Teacher clicks a date
 *   4. The record opens — teacher can flip any student between present/absent
 *      and save. Statistics update automatically everywhere else because
 *      they're always computed live from the saved records.
 */
import {
  LuArrowLeft, LuBookOpen, LuCalendarDays, LuChevronDown, LuCircleAlert,
  LuCircleCheck, LuCircleX, LuPencil, LuSave, LuSearch, LuUsers,
} from 'react-icons/lu'
import { useState, useEffect, useMemo } from 'react'

import toast from 'react-hot-toast'
import { useSubjects } from '@context/SubjectsContext'
import { attendanceAPI, getErrorMessage } from '@services/api'
import { useAttendance } from '@hooks/useAttendance'

const fmtDate = (d) => {
  const dt = typeof d === 'string' ? new Date(d) : d
  return dt.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
}

function PercentBadge({ pct }) {
  const color = pct >= 75 ? 'success' : pct >= 50 ? 'warning' : 'danger'
  return (
    <span className="badge" style={{
      background: `var(--${color}-bg)`, color: `var(--${color}-text)`, border: `1px solid var(--${color}-border)`,
    }}>
      {pct}% Present
    </span>
  )
}

export default function EditAttendancePage() {
  const { subjects, fetchSubjects, loading: subjectsLoading } = useSubjects()
  const [selectedSubjectId, setSelectedSubjectId] = useState('')
  const { dates, loading: datesLoading, fetchDates, updateSession, saving } = useAttendance(selectedSubjectId)

  const [selectedSession, setSelectedSession] = useState(null) // full attendance doc
  const [sessionLoading, setSessionLoading] = useState(false)
  const [statusMap, setStatusMap] = useState({}) // studentId -> 'present' | 'absent'
  const [search, setSearch] = useState('')

  useEffect(() => { fetchSubjects() }, [fetchSubjects])

  const selectedSubject = useMemo(() =>
    subjects.find(s => s._id === selectedSubjectId), [subjects, selectedSubjectId])

  useEffect(() => {
    if (selectedSubjectId) fetchDates()
    setSelectedSession(null)
  }, [selectedSubjectId, fetchDates])

  const openSession = async (sessionId) => {
    setSessionLoading(true)
    try {
      const res = await attendanceAPI.getById(selectedSubjectId, sessionId)
      const record = res.data?.data?.attendance
      setSelectedSession(record)
      const map = {}
      record.students.forEach(s => { map[s.studentId] = s.status })
      setStatusMap(map)
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setSessionLoading(false)
    }
  }

  const toggle = (studentId) => {
    setStatusMap(prev => ({ ...prev, [studentId]: prev[studentId] === 'present' ? 'absent' : 'present' }))
  }

  const hasChanges = useMemo(() => {
    if (!selectedSession) return false
    return selectedSession.students.some(s => statusMap[s.studentId] !== s.status)
  }, [selectedSession, statusMap])

  const handleSave = async () => {
    if (!selectedSession) return
    const changed = selectedSession.students
      .filter(s => statusMap[s.studentId] !== s.status)
      .map(s => ({ studentId: s.studentId, status: statusMap[s.studentId] }))
    if (changed.length === 0) { toast('No changes to save', { icon: 'ℹ️' }); return }

    const result = await updateSession(selectedSession._id, { students: changed })
    if (result?.success) {
      setSelectedSession(result.data)
      await fetchDates() // refresh the daily percentages in the list
    }
  }

  const filteredStudents = useMemo(() => {
    if (!selectedSession) return []
    if (!search) return selectedSession.students
    const q = search.toLowerCase()
    return selectedSession.students.filter(s =>
      s.name?.toLowerCase().includes(q) || s.roll?.toLowerCase().includes(q) || s.studentId?.toLowerCase().includes(q)
    )
  }, [selectedSession, search])

  const presentCount = Object.values(statusMap).filter(v => v === 'present').length
  const totalCount = selectedSession?.students.length || 0

  return (
    <div className="space-y-5 p-4 sm:p-6 max-w-5xl mx-auto">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
          <LuPencil size={20} style={{ color: 'var(--brand-primary)' }} /> Edit Attendance
        </h1>
        <p className="text-sm mt-0.5" style={{ color: 'var(--text-muted)' }}>
          Fix a mistake on a past session — flip a student between present and absent, then save.
        </p>
      </div>

      {/* Step 1: choose subject */}
      <div className="card p-5">
        <label className="form-label flex items-center gap-1.5">
          <LuBookOpen size={12} style={{ color: 'var(--brand-primary)' }} /> Subject
        </label>
        <div className="relative max-w-sm">
          <select
            value={selectedSubjectId}
            onChange={e => setSelectedSubjectId(e.target.value)}
            disabled={subjectsLoading}
            className="select-field"
          >
            <option value="">Select subject…</option>
            {subjects.map(s => <option key={s._id} value={s._id}>{s.subjectName} ({s.subjectCode})</option>)}
          </select>
          <LuChevronDown size={14} className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" style={{ color: 'var(--text-muted)' }} />
        </div>
      </div>

      {selectedSubjectId && !selectedSession && (
        <div className="card p-5">
          <h2 className="text-sm font-semibold mb-3 flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
            <LuCalendarDays size={14} style={{ color: 'var(--brand-primary)' }} /> Attendance Dates
          </h2>
          {datesLoading ? (
            <div className="space-y-2">{[1, 2, 3, 4].map(i => <div key={i} className="skeleton h-14 w-full" />)}</div>
          ) : dates.length === 0 ? (
            <div className="empty-state">
              <LuCircleAlert size={28} className="empty-state-icon" />
              <p className="text-sm">No attendance recorded for this subject yet.</p>
            </div>
          ) : (
            <div className="space-y-2">
              {dates.map(d => (
                <button
                  key={d.sessionId}
                  onClick={() => openSession(d.sessionId)}
                  className="w-full flex items-center justify-between px-4 py-3 rounded-xl transition-colors text-left"
                  style={{ background: 'var(--bg-muted)' }}
                >
                  <div>
                    <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{fmtDate(d.date)}</p>
                    <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                      {d.classType} · {d.presentCount}/{d.totalStudents} present
                    </p>
                  </div>
                  <PercentBadge pct={d.percentage} />
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Steps 3-4: edit the opened session */}
      {sessionLoading && (
        <div className="card p-5 space-y-2">{[1, 2, 3].map(i => <div key={i} className="skeleton h-14 w-full" />)}</div>
      )}

      {selectedSession && (
        <div className="card p-5 space-y-4">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div className="flex items-center gap-3">
              <button onClick={() => setSelectedSession(null)} className="icon-btn"><LuArrowLeft size={16} /></button>
              <div>
                <p className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>{fmtDate(selectedSession.date)}</p>
                <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                  {selectedSession.classType} · {selectedSubject?.subjectName}
                </p>
              </div>
            </div>
            <div className="text-sm" style={{ color: 'var(--text-secondary)' }}>
              <span className="font-bold" style={{ color: 'var(--text-primary)' }}>{presentCount}</span> / {totalCount} present
            </div>
          </div>

          <div className="relative">
            <LuSearch size={14} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-muted)' }} />
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search students…"
              className="input-field pl-9" />
          </div>

          {filteredStudents.length === 0 ? (
            <div className="empty-state">
              <LuUsers size={28} className="empty-state-icon" />
              <p className="text-sm">No students match your search</p>
            </div>
          ) : (
            <div className="space-y-2 max-h-96 overflow-y-auto pr-1">
              {filteredStudents.map(s => {
                const present = statusMap[s.studentId] === 'present'
                const changed = statusMap[s.studentId] !== s.status
                return (
                  <div
                    key={s.studentId}
                    onClick={() => toggle(s.studentId)}
                    className="flex items-center gap-3 p-3 rounded-xl border cursor-pointer transition-all select-none"
                    style={{
                      background: present ? 'var(--success-bg)' : 'var(--danger-bg)',
                      borderColor: changed ? 'var(--brand-primary)' : (present ? 'var(--success-border)' : 'var(--danger-border)'),
                      borderWidth: changed ? '2px' : '1px',
                    }}
                  >
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate" style={{ color: 'var(--text-primary)' }}>{s.name}</p>
                      <span className="text-xs font-mono" style={{ color: 'var(--text-muted)' }}>Roll: {s.roll}</span>
                    </div>
                    {changed && <span className="badge" style={{ background: 'var(--brand-50)', color: 'var(--brand-primary)', border: '1px solid var(--brand-200)' }}>Changed</span>}
                    <div className="w-7 h-7 rounded-lg flex items-center justify-center"
                      style={{ color: present ? 'var(--success-text)' : 'var(--danger-text)' }}>
                      {present ? <LuCircleCheck size={16} /> : <LuCircleX size={16} />}
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          <div className="flex items-center justify-end pt-3" style={{ borderTop: '1px solid var(--border-soft)' }}>
            <button onClick={handleSave} disabled={saving || !hasChanges} className="btn-primary px-5 py-2.5 disabled:opacity-50">
              {saving
                ? <><span className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" /> Saving…</>
                : <><LuSave size={14} /> Save Changes</>}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
