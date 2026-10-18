/**
 * AdminStudentAnalytics.jsx — COLOR SYSTEM FIXED
 */
import { LuTriangleAlert, LuArrowLeft, LuBookOpen, LuBuilding2, LuChartBar, LuCircleCheck, LuCircleX, LuClock, LuFileText, LuTrendingUp, LuUser, LuUsers } from 'react-icons/lu'
import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'

import { alertsAPI, getErrorMessage } from '@services/api'
import toast from 'react-hot-toast'

const STATUS_CONFIG = {
  Excellent: { color: 'var(--success-text)', bg: 'var(--success-bg)',  border: 'var(--success-border)', icon: LuCircleCheck },
  Good:      { color: 'var(--brand-primary)', bg: 'var(--brand-50)',   border: 'var(--brand-200)',       icon: LuTrendingUp   },
  Warning:   { color: 'var(--warning-text)', bg: 'var(--warning-bg)', border: 'var(--warning-border)',   icon: LuClock        },
  Critical:  { color: 'var(--danger-text)',  bg: 'var(--danger-bg)',  border: 'var(--danger-border)',    icon: LuCircleX      },
}

function PercentageRing({ value }) {
  const radius = 36
  const circumference = 2 * Math.PI * radius
  const offset = circumference - (value / 100) * circumference
  const color = value >= 75 ? '#15803D' : value >= 65 ? '#5B4BE0' : value >= 50 ? '#B45309' : '#B91C1C'
  const textColor = '#111827'

  return (
    <svg width="96" height="96" className="rotate-[-90deg]">
      <circle cx="48" cy="48" r={radius} fill="none" stroke="#E5E7EB" strokeWidth="8" />
      <circle
        cx="48" cy="48" r={radius} fill="none"
        stroke={color} strokeWidth="8"
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        strokeLinecap="round"
        style={{ transition: 'stroke-dashoffset 0.6s ease' }}
      />
      <text x="48" y="52" textAnchor="middle" fill={textColor} fontSize="16" fontWeight="700"
        style={{ transform: 'rotate(90deg)', transformOrigin: '48px 48px' }}>
        {value}%
      </text>
    </svg>
  )
}

function StatItem({ label, value, sub, color }) {
  return (
    <div className="text-center">
      <p className="text-2xl font-bold font-mono" style={{ color: color || 'var(--text-primary)' }}>{value}</p>
      <p className="text-xs font-semibold mt-0.5" style={{ color: 'var(--text-secondary)' }}>{label}</p>
      {sub && <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>{sub}</p>}
    </div>
  )
}

export default function AdminStudentAnalytics() {
  const { studentId } = useParams()
  const navigate = useNavigate()
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const load = async () => {
      try {
        const res = await alertsAPI.getStudentAnalytics(studentId)
        setData(res.data?.data || null)
      } catch (err) {
        toast.error(getErrorMessage(err))
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [studentId])

  if (loading) {
    return (
      <div className="p-6 space-y-4 max-w-5xl mx-auto">
        <div className="skeleton h-8 w-48" />
        <div className="skeleton h-48 w-full" />
        <div className="skeleton h-64 w-full" />
      </div>
    )
  }

  if (!data) {
    return (
      <div className="p-6 text-center">
        <p style={{ color: 'var(--text-muted)' }}>Student not found.</p>
        <button onClick={() => navigate(-1)} className="mt-4 text-sm font-semibold" style={{ color: 'var(--brand-primary)' }}>
          ← Go back
        </button>
      </div>
    )
  }

  const { student, academicStats, subjectStats, alertHistory } = data
  const statusCfg = STATUS_CONFIG[academicStats.status] || STATUS_CONFIG.Good
  const StatusIcon = statusCfg.icon
  const initials = student.name?.split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase() || '??'

  return (
    <div className="space-y-6 p-4 sm:p-6 max-w-5xl mx-auto">
      {/* Back */}
      <button onClick={() => navigate(-1)} className="flex items-center gap-2 text-sm transition-colors"
        style={{ color: 'var(--text-secondary)' }}
        onMouseEnter={e => { e.currentTarget.style.color = 'var(--text-primary)' }}
        onMouseLeave={e => { e.currentTarget.style.color = 'var(--text-secondary)' }}>
        <LuArrowLeft size={14} /> Back to Students
      </button>

      {/* Student profile card */}
      <div className="card p-6">
        <div className="flex flex-col sm:flex-row items-start sm:items-center gap-5">
          <div className="w-16 h-16 rounded-2xl flex items-center justify-center shrink-0"
            style={{ background: 'var(--brand-50)', border: '2px solid var(--brand-200)' }}>
            <span className="text-xl font-bold font-mono" style={{ color: 'var(--brand-primary)' }}>{initials}</span>
          </div>
          <div className="flex-1">
            <div className="flex items-start justify-between gap-3 flex-wrap">
              <div>
                <h1 className="text-xl font-bold" style={{ color: 'var(--text-primary)' }}>{student.name}</h1>
                <p className="text-sm font-mono mt-0.5" style={{ color: 'var(--text-muted)' }}>ID: {student.studentId}</p>
              </div>
              <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-bold"
                style={{ background: statusCfg.bg, color: statusCfg.color, border: `1px solid ${statusCfg.border}` }}>
                <StatusIcon size={12} /> {academicStats.status}
              </span>
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1.5 mt-3">
              <span className="flex items-center gap-1.5 text-xs" style={{ color: 'var(--text-secondary)' }}>
                <LuUser size={12} style={{ color: 'var(--text-muted)' }} /> Roll: <strong>{student.roll}</strong>
              </span>
              <span className="flex items-center gap-1.5 text-xs" style={{ color: 'var(--text-secondary)' }}>
                <LuBuilding2 size={12} style={{ color: 'var(--text-muted)' }} /> {student.department}
              </span>
              <span className="flex items-center gap-1.5 text-xs" style={{ color: 'var(--text-secondary)' }}>
                <LuUsers size={12} style={{ color: 'var(--text-muted)' }} /> Batch {student.batch}
              </span>
              <span className="flex items-center gap-1.5 text-xs"
                style={{ color: student.isActive ? 'var(--success-text)' : 'var(--danger-text)' }}>
                <div className="w-1.5 h-1.5 rounded-full" style={{ background: student.isActive ? 'var(--success)' : 'var(--danger)' }} />
                {student.isActive ? 'Active' : 'Inactive'}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Academic statistics */}
      <div className="card p-6">
        <h2 className="text-base font-bold flex items-center gap-2 mb-5" style={{ color: 'var(--text-primary)' }}>
          <LuChartBar size={16} style={{ color: 'var(--brand-primary)' }} /> Academic Statistics
        </h2>
        <div className="flex flex-col sm:flex-row items-center gap-6">
          <div className="flex flex-col items-center gap-2 shrink-0">
            <PercentageRing value={academicStats.overallPercentage} />
            <p className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>Overall Attendance</p>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-8 gap-y-4 flex-1">
            <StatItem label="Total Subjects" value={academicStats.totalSubjects} />
            <StatItem label="Total Classes"  value={academicStats.totalClasses} />
            <StatItem label="Attended"       value={academicStats.totalAttended} color="var(--success-text)" />
            <StatItem label="Missed"         value={academicStats.totalMissed}   color="var(--danger-text)" />
            <StatItem label="Credit Score"   value={academicStats.creditScore}
              sub={academicStats.creditScoreBreakdown?.length
                ? academicStats.creditScoreBreakdown.map(c => `${c.category}×${c.creditValue}`).join(' + ')
                : undefined}
              color="var(--warning-text)" />
            <div className="flex flex-col items-center justify-center">
              <span className="text-sm font-bold px-3 py-1.5 rounded-full"
                style={{ background: statusCfg.bg, color: statusCfg.color, border: `1px solid ${statusCfg.border}` }}>
                {academicStats.status}
              </span>
              <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>Status</p>
            </div>
          </div>
        </div>
      </div>

      {/* Credit score breakdown by category */}
      {academicStats.creditScoreBreakdown?.length > 0 && (
        <div className="card p-5">
          <h2 className="text-sm font-semibold mb-3" style={{ color: 'var(--text-primary)' }}>Credit Score Breakdown</h2>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {academicStats.creditScoreBreakdown.map(c => (
              <div key={c.category} className="rounded-xl px-4 py-3" style={{ background: 'var(--bg-muted)' }}>
                <p className="text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>{c.category}</p>
                <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                  {c.attendedClasses} attended × {c.creditValue} credit{c.creditValue === 1 ? '' : 's'}
                </p>
                <p className="text-sm font-bold font-mono mt-1" style={{ color: 'var(--brand-primary)' }}>
                  +{c.pointsEarned} pts
                </p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Per-subject table */}
      <div className="card overflow-hidden">
        <div className="px-5 py-4 flex items-center gap-2" style={{ borderBottom: '1px solid var(--border)' }}>
          <LuBookOpen size={15} style={{ color: 'var(--brand-primary)' }} />
          <h2 className="text-base font-bold" style={{ color: 'var(--text-primary)' }}>Subject Statistics</h2>
        </div>
        {subjectStats.length === 0 ? (
          <div className="p-8 text-center text-sm" style={{ color: 'var(--text-muted)' }}>
            No subject data found for this student.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border)' }}>
                  {['Subject','Type','Total','Attended','Missed','Attendance %'].map(h => (
                    <th key={h} className="px-4 py-3 text-left table-header">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {subjectStats.map((sub, idx) => {
                  const pct = sub.attendancePercentage
                  const pctColor = pct >= 75
                    ? 'var(--success-text)'
                    : pct >= 65
                      ? 'var(--brand-primary)'
                      : pct >= 50
                        ? 'var(--warning-text)'
                        : 'var(--danger-text)'
                  return (
                    <tr key={sub.subjectId} className="table-row-hover"
                      style={{ borderBottom: idx < subjectStats.length - 1 ? '1px solid var(--border-soft)' : 'none' }}>
                      <td className="px-5 py-3">
                        <p className="font-medium" style={{ color: 'var(--text-primary)' }}>{sub.subjectName}</p>
                        <p className="text-xs font-mono" style={{ color: 'var(--text-muted)' }}>{sub.subjectCode}</p>
                      </td>
                      <td className="px-4 py-3 text-center">
                        {sub.creditType ? (
                          <span className="badge" style={{ background: 'var(--brand-50)', color: 'var(--brand-primary)', border: '1px solid var(--brand-200)' }}>
                            {sub.creditType} ({sub.credits}cr)
                          </span>
                        ) : (
                          <span className="text-xs" style={{ color: 'var(--text-muted)' }}>—</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-center font-mono" style={{ color: 'var(--text-secondary)' }}>{sub.totalClasses}</td>
                      <td className="px-4 py-3 text-center font-mono font-bold" style={{ color: 'var(--success-text)' }}>{sub.attended}</td>
                      <td className="px-4 py-3 text-center font-mono font-bold" style={{ color: 'var(--danger-text)' }}>{sub.missed}</td>
                      <td className="px-4 py-3 text-center">
                        <span className="font-bold font-mono text-sm" style={{ color: pctColor }}>{pct}%</span>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Alert history */}
      <div className="card overflow-hidden">
        <div className="px-5 py-4 flex items-center gap-2" style={{ borderBottom: '1px solid var(--border)' }}>
          <LuTriangleAlert size={15} style={{ color: 'var(--warning-text)' }} />
          <h2 className="text-base font-bold" style={{ color: 'var(--text-primary)' }}>Consecutive Absence History</h2>
          <span className="ml-auto text-xs" style={{ color: 'var(--text-muted)' }}>
            {alertHistory.length} record{alertHistory.length !== 1 ? 's' : ''}
          </span>
        </div>
        {alertHistory.length === 0 ? (
          <div className="p-8 text-center text-sm" style={{ color: 'var(--text-muted)' }}>
            No consecutive absence alerts on record for this student.
          </div>
        ) : (
          <div>
            {alertHistory.map((alert, idx) => (
              <div key={alert._id} className="px-5 py-4"
                style={{ borderBottom: idx < alertHistory.length - 1 ? '1px solid var(--border-soft)' : 'none' }}>
                <div className="flex items-start gap-3">
                  <div className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0 mt-0.5"
                    style={{ background: 'var(--warning-bg)', border: '1px solid var(--warning-border)' }}>
                    <span className="text-xs font-bold" style={{ color: 'var(--warning-text)' }}>#{alertHistory.length - idx}</span>
                  </div>
                  <div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                        Alert — {alert.consecutiveMissCount} Consecutive Absences
                      </p>
                      {alert.removed
                        ? <span className="badge badge-neutral">Removed</span>
                        : <span className="badge badge-warning">Active</span>
                      }
                    </div>
                    {alert.subjectId && (
                      <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                        Subject: {alert.subjectId.subjectName || 'Unknown'}
                        {alert.subjectId.subjectCode ? ` (${alert.subjectId.subjectCode})` : ''}
                      </p>
                    )}
                    <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                      Flagged: {new Date(alert.createdAt).toLocaleDateString('en-US', {
                        year: 'numeric', month: 'long', day: 'numeric'
                      })}
                      {alert.teacherId && ` · by ${alert.teacherId.name || 'Unknown Teacher'}`}
                    </p>
                    {alert.note && (
                      <div className="mt-2 flex items-start gap-1.5">
                        <LuFileText size={11} className="shrink-0 mt-0.5" style={{ color: 'var(--text-muted)' }} />
                        <p className="text-xs italic" style={{ color: 'var(--text-secondary)' }}>"{alert.note}"</p>
                      </div>
                    )}
                    {alert.removed && alert.removedAt && (
                      <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                        Removed: {new Date(alert.removedAt).toLocaleDateString('en-US', {
                          year: 'numeric', month: 'short', day: 'numeric'
                        })}
                      </p>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
