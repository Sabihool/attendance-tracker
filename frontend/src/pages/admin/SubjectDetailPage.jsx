/**
 * SubjectDetailPage.jsx
 * Admin — drill-down view for a single subject (from All Subjects).
 *
 * Reuses the existing attendance & export endpoints, which already allow
 * admin access (requireSubjectOwner bypasses the ownership check for
 * role: 'admin') — no separate admin-only copies needed.
 */
import {
  LuArrowLeft, LuCalendarClock, LuChartBar, LuDownload, LuLoaderCircle,
  LuSearch, LuTriangleAlert, LuUsers,
} from 'react-icons/lu'
import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts'

import { subjectAPI, attendanceAPI, exportAPI, downloadBlob, getErrorMessage } from '@services/api'
import toast from 'react-hot-toast'
import TeacherAssignment from '@components/forms/TeacherAssignment'
import { assignedTeacherName } from '@utils/subjectForm'

function PctBadge({ pct }) {
  const style = pct >= 75
    ? { color: 'var(--success-text)', background: 'var(--success-bg)', border: '1px solid var(--success-border)' }
    : pct >= 50
      ? { color: 'var(--warning-text)', background: 'var(--warning-bg)', border: '1px solid var(--warning-border)' }
      : { color: 'var(--danger-text)', background: 'var(--danger-bg)', border: '1px solid var(--danger-border)' }
  return <span className="text-xs font-mono font-bold px-2 py-0.5 rounded-lg" style={style}>{pct}%</span>
}

function formatDate(d) {
  return new Date(d).toLocaleDateString('en-US', { day: 'numeric', month: 'short' })
}

export default function SubjectDetailPage() {
  const { subjectId } = useParams()
  const navigate = useNavigate()

  const [subject, setSubject]   = useState(null)
  const [sessions, setSessions] = useState([])
  const [students, setStudents] = useState([])
  const [loading, setLoading]   = useState(true)
  const [search, setSearch]     = useState('')
  const [exporting, setExporting] = useState(false)

  useEffect(() => {
    const load = async () => {
      setLoading(true)
      try {
        const [subjRes, datesRes, pctRes] = await Promise.all([
          subjectAPI.getById(subjectId),
          attendanceAPI.getDates(subjectId),
          attendanceAPI.getPercentage(subjectId),
        ])
        setSubject(subjRes.data?.data?.subject || null)
        setSessions((datesRes.data?.data?.dates || []).slice().reverse()) // chronological for the chart
        setStudents(pctRes.data?.data?.studentStats || [])
      } catch (err) {
        toast.error(getErrorMessage(err))
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [subjectId])

  const handleExportPDF = async () => {
    setExporting(true)
    try {
      const res = await exportAPI.downloadPDF(subjectId)
      downloadBlob(res.data, `${subject?.subjectCode || 'subject'}_report.pdf`)
      toast.success('PDF downloaded')
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setExporting(false)
    }
  }

  const filteredStudents = students.filter(s =>
    !search || s.name.toLowerCase().includes(search.toLowerCase()) || s.roll.toLowerCase().includes(search.toLowerCase())
  )

  const chartData = sessions.map(s => ({ date: formatDate(s.date), percentage: s.percentage }))

  if (loading) {
    return (
      <div className="p-6 space-y-4 max-w-5xl mx-auto">
        <div className="skeleton h-8 w-48" />
        <div className="skeleton h-32 w-full" />
        <div className="skeleton h-64 w-full" />
      </div>
    )
  }

  if (!subject) {
    return (
      <div className="p-6 text-center">
        <p style={{ color: 'var(--text-muted)' }}>Subject not found.</p>
        <button onClick={() => navigate(-1)} className="mt-4 text-sm font-semibold" style={{ color: 'var(--brand-primary)' }}>
          ← Go back
        </button>
      </div>
    )
  }

  const overallAvg = students.length > 0 ? Math.round(students.reduce((sum, s) => sum + s.percentage, 0) / students.length) : 0

  return (
    <div className="space-y-6 p-4 sm:p-6 max-w-5xl mx-auto">
      <button onClick={() => navigate(-1)} className="flex items-center gap-2 text-sm transition-colors"
        style={{ color: 'var(--text-secondary)' }}
        onMouseEnter={e => { e.currentTarget.style.color = 'var(--text-primary)' }}
        onMouseLeave={e => { e.currentTarget.style.color = 'var(--text-secondary)' }}>
        <LuArrowLeft size={14} /> Back to All Subjects
      </button>

      {/* Header */}
      <div className="card p-6">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-xl font-bold" style={{ color: 'var(--text-primary)' }}>{subject.subjectName}</h1>
            <p className="text-sm font-mono mt-0.5" style={{ color: 'var(--text-muted)' }}>{subject.subjectCode}</p>
            <div className="flex flex-wrap gap-x-4 gap-y-1.5 mt-3 text-xs" style={{ color: 'var(--text-secondary)' }}>
              <span>{subject.department}</span>
              <span>Batch {subject.batch}</span>
              <span>{subject.shift}</span>
              <span>Teacher: {assignedTeacherName(subject)}</span>
            </div>
          </div>
          <button onClick={handleExportPDF} disabled={exporting} className="btn-primary disabled:opacity-50">
            {exporting ? <LuLoaderCircle size={13} className="animate-spin" /> : <LuDownload size={13} />}
            Export PDF
          </button>
        </div>

        <div className="grid grid-cols-3 gap-4 mt-5 pt-5" style={{ borderTop: '1px solid var(--border-soft)' }}>
          <div className="text-center">
            <p className="text-2xl font-bold font-mono" style={{ color: 'var(--text-primary)' }}>{sessions.length}</p>
            <p className="text-xs font-semibold mt-0.5" style={{ color: 'var(--text-secondary)' }}>Sessions</p>
          </div>
          <div className="text-center">
            <p className="text-2xl font-bold font-mono" style={{ color: 'var(--text-primary)' }}>{students.length}</p>
            <p className="text-xs font-semibold mt-0.5" style={{ color: 'var(--text-secondary)' }}>Students</p>
          </div>
          <div className="text-center">
            <p className="text-2xl font-bold font-mono" style={{ color: overallAvg >= 75 ? 'var(--success-text)' : overallAvg >= 50 ? 'var(--warning-text)' : 'var(--danger-text)' }}>{overallAvg}%</p>
            <p className="text-xs font-semibold mt-0.5" style={{ color: 'var(--text-secondary)' }}>Avg. Attendance</p>
          </div>
        </div>
      </div>

      {/* Assignment (admin of this college only; the server enforces it) */}
      <TeacherAssignment subject={subject} onAssigned={setSubject} />

      {/* Trend chart */}
      {sessions.length > 0 && (
        <div className="card p-5">
          <h2 className="text-sm font-semibold mb-4 flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
            <LuChartBar size={15} /> Attendance Trend
          </h2>
          <div className="h-52">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData} margin={{ top: 5, right: 10, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--chart-grid)" />
                <XAxis dataKey="date" tick={{ fill: 'var(--chart-axis)', fontSize: 10 }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fill: 'var(--chart-axis)', fontSize: 11 }} axisLine={false} tickLine={false} domain={[0, 100]} />
                <Tooltip contentStyle={{ background: 'var(--chart-tooltip-bg)', border: '1px solid var(--chart-tooltip-border)', borderRadius: 10, fontSize: 12, color: '#111827' }} />
                <Line type="monotone" dataKey="percentage" name="Present %" stroke="#6D5EF7" strokeWidth={2} dot={{ r: 3, fill: '#6D5EF7' }} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* Session-by-session breakdown */}
      <div className="card p-5">
        <h2 className="text-sm font-semibold mb-4 flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
          <LuCalendarClock size={15} /> Sessions ({sessions.length})
        </h2>
        {sessions.length === 0 ? (
          <div className="empty-state">
            <LuCalendarClock size={28} className="empty-state-icon" />
            <p className="text-sm">No attendance sessions taken yet.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border)' }}>
                  {['Date', 'Type', 'Present', 'Absent', 'Attendance'].map(h => (
                    <th key={h} className="text-left px-3 py-2 table-header">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sessions.slice().reverse().map((s, idx, arr) => (
                  <tr key={s.sessionId} className="table-row-hover"
                    style={{ borderBottom: idx < arr.length - 1 ? '1px solid var(--border-soft)' : 'none' }}>
                    <td className="px-3 py-2 text-xs" style={{ color: 'var(--text-secondary)' }}>{formatDate(s.date)}</td>
                    <td className="px-3 py-2 text-xs" style={{ color: 'var(--text-secondary)' }}>{s.classType}</td>
                    <td className="px-3 py-2 font-mono text-xs" style={{ color: 'var(--success-text)' }}>{s.presentCount}</td>
                    <td className="px-3 py-2 font-mono text-xs" style={{ color: 'var(--danger-text)' }}>{s.absentCount}</td>
                    <td className="px-3 py-2"><PctBadge pct={s.percentage} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Student attendance list */}
      <div className="card p-5">
        <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
          <h2 className="text-sm font-semibold flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
            <LuUsers size={15} /> Student Attendance ({students.length})
          </h2>
          <div className="relative">
            <LuSearch size={13} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-muted)' }} />
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Name or roll…"
              className="input-field pl-8 w-48" />
          </div>
        </div>
        {filteredStudents.length === 0 ? (
          <div className="empty-state">
            <LuTriangleAlert size={28} className="empty-state-icon" />
            <p className="text-sm">No matching students.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border)' }}>
                  {['Roll', 'Name', 'Attended', 'Total', 'Percentage'].map(h => (
                    <th key={h} className="text-left px-3 py-2 table-header">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filteredStudents.map((s, idx) => (
                  <tr key={s.studentId} className="table-row-hover"
                    style={{ borderBottom: idx < filteredStudents.length - 1 ? '1px solid var(--border-soft)' : 'none' }}>
                    <td className="px-3 py-2 font-mono text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>{s.roll}</td>
                    <td className="px-3 py-2 font-medium" style={{ color: 'var(--text-primary)' }}>{s.name}</td>
                    <td className="px-3 py-2 font-mono text-xs" style={{ color: 'var(--text-secondary)' }}>{s.attended}</td>
                    <td className="px-3 py-2 font-mono text-xs" style={{ color: 'var(--text-secondary)' }}>{s.total}</td>
                    <td className="px-3 py-2"><PctBadge pct={s.percentage} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
