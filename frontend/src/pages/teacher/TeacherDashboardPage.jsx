/**
 * TeacherDashboard.jsx — UI refinement pass 2
 * All API logic preserved exactly.
 */
import { LuTriangleAlert, LuArrowRight, LuBell, LuBookOpen, LuChartBar, LuClipboardCheck, LuRefreshCw, LuTrendingUp } from 'react-icons/lu'
import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'

import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer
} from 'recharts'
import { useAuth } from '@context/AuthContext'
import { useSubjects } from '@context/SubjectsContext'
import { attendanceAPI, alertsAPI } from '@services/api'
import toast from 'react-hot-toast'
import { addRecordsToMonthMap, buildTrend } from '../../utils/attendanceTrend.js'

const STAT_PALETTE = {
  brand:  { iconBg: '#F4F1FF', iconColor: '#6D5EF7' },
  purple: { iconBg: '#FAF5FF', iconColor: '#9333EA' },
  green:  { iconBg: '#F0FDF4', iconColor: '#16A34A' },
  amber:  { iconBg: '#FFFBEB', iconColor: '#D97706' },
}

function DashStatCard({ title, value, subtitle, icon: Icon, color, trend, trendVal }) {
  const c = STAT_PALETTE[color] || STAT_PALETTE.brand
  const trendColor = trend === 'up' ? '#16A34A' : '#DC2626'
  return (
    <div className="stat-card card-hover">
      <div className="flex items-start justify-between mb-3">
        <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0" style={{ background: c.iconBg }}>
          <Icon size={17} style={{ color: c.iconColor }} />
        </div>
        {trend && trendVal && (
          <span className="text-xs font-semibold px-1.5 py-0.5 rounded-full" style={{ color: trendColor, background: `${trendColor}18` }}>
            {trend === 'up' ? '↑' : '↓'} {trendVal}
          </span>
        )}
      </div>
      <p className="text-2xl font-bold leading-none mb-0.5" style={{ color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>{value}</p>
      <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{title}</p>
      {subtitle && <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>{subtitle}</p>}
    </div>
  )
}

function ChartTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null
  return (
    <div className="card px-3 py-2 text-xs" style={{ boxShadow: 'var(--shadow-dropdown)' }}>
      <p className="font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>{label}</p>
      {payload.map((p, i) => (
        <div key={i} className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full" style={{ background: p.color }} />
          <span style={{ color: 'var(--text-muted)' }}>{p.name}:</span>
          <span className="font-semibold font-mono" style={{ color: 'var(--text-primary)' }}>{p.value}%</span>
        </div>
      ))}
    </div>
  )
}

export default function TeacherDashboard() {
  const { user } = useAuth()
  const { subjects, fetchSubjects, loading: subjectsLoading } = useSubjects()
  const [stats, setStats] = useState({ totalSessions: 0, avgAttendance: 0, belowThreshold: 0 })
  const [trendData, setTrendData] = useState([])
  const [refreshing, setRefreshing] = useState(false)
  const [alertCount, setAlertCount] = useState(0)

  useEffect(() => {
    fetchSubjects()
    alertsAPI.getAll({ removed: false })
      .then(res => setAlertCount(res.data?.data?.total || 0))
      .catch(() => {})
  }, [fetchSubjects])

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (subjects.length > 0) computeStats() }, [subjects])

  const computeStats = async () => {
    let totalSessions = 0
    let allPercentages = []
    const byMonth = {} // 'YYYY-M' -> { present, total } built from the real session summaries
    for (const subject of subjects.slice(0, 4)) {
      try {
        const res = await attendanceAPI.getAll(subject._id)
        const records = res.data?.data?.records || []
        totalSessions += records.length
        addRecordsToMonthMap(byMonth, records)
      } catch { /* ignore */ }
      try {
        const res = await attendanceAPI.getPercentage(subject._id)
        ;(res.data?.data?.studentStats || []).forEach(s => allPercentages.push(s.percentage || 0))
      } catch { /* ignore */ }
    }
    const avg   = allPercentages.length ? Math.round(allPercentages.reduce((a, b) => a + b, 0) / allPercentages.length) : 0
    const below = allPercentages.filter(p => p < 75).length
    setStats({ totalSessions, avgAttendance: avg, belowThreshold: below })

    setTrendData(buildTrend(byMonth))
  }

  const handleRefresh = async () => {
    setRefreshing(true)
    await fetchSubjects()
    await computeStats()
    try {
      const r = await alertsAPI.getAll({ removed: false })
      setAlertCount(r.data?.data?.total || 0)
    } catch { /* ignore */ }
    setRefreshing(false)
    toast.success('Dashboard refreshed')
  }

  return (
    <div className="space-y-4 pb-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold" style={{ color: 'var(--text-primary)' }}>Dashboard</h1>
          <p className="text-sm mt-0.5" style={{ color: 'var(--text-muted)' }}>
            Welcome back, <span className="font-semibold" style={{ color: 'var(--brand-primary)' }}>{user?.name?.split(' ')[0]}</span>
          </p>
          {user?.college?.name && <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>{user.college.name}{[user.college.district, user.college.country].filter(Boolean).length ? ` · ${[user.college.district, user.college.country].filter(Boolean).join(', ')}` : ''}</p>}
        </div>
        <button onClick={handleRefresh} disabled={refreshing} className="btn-secondary disabled:opacity-50">
          <LuRefreshCw size={13} className={refreshing ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <DashStatCard title="Total Subjects"  value={subjectsLoading ? '…' : subjects.length} subtitle="Active"        icon={LuBookOpen}      color="brand" />
        <DashStatCard title="Total Sessions"  value={stats.totalSessions}                      subtitle="Classes taken" icon={LuClipboardCheck} color="purple" />
        <DashStatCard title="Avg Attendance"  value={`${stats.avgAttendance}%`}                subtitle="All subjects"  icon={LuTrendingUp}     color="green"
          trend={stats.avgAttendance >= 75 ? 'up' : 'down'} trendVal={`${stats.avgAttendance}%`} />
        <DashStatCard title="Below 75%"       value={stats.belowThreshold}                     subtitle="At risk"       icon={LuTriangleAlert}  color="amber" />
      </div>

      {/* Absence alert banner */}
      {alertCount > 0 && (
        <div className="card p-4 flex items-center justify-between gap-3" style={{ border: '1px solid var(--warning-border)', background: 'var(--warning-bg)' }}>
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0" style={{ background: 'var(--warning-border)' }}>
              <LuBell size={15} style={{ color: 'var(--warning-text)' }} />
            </div>
            <div>
              <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Consecutive Absence Alerts</p>
              <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                <span className="font-bold" style={{ color: 'var(--warning-text)' }}>{alertCount}</span> student{alertCount !== 1 ? 's' : ''} flagged for repeated absences
              </p>
            </div>
          </div>
          <Link to="/teacher/consecutive-absence-alerts" className="btn-ghost text-xs shrink-0"
            style={{ borderColor: 'var(--warning-border)', color: 'var(--warning-text)' }}>
            View <LuArrowRight size={11} />
          </Link>
        </div>
      )}

      {/* Chart + Recent Subjects */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-3">
        {/* Chart */}
        <div className="lg:col-span-3 card p-4">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-bold flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
              <LuChartBar size={15} style={{ color: 'var(--brand-primary)' }} />
              Attendance Trend
            </h2>
          </div>
          <div className="h-44">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={trendData} margin={{ top: 5, right: 5, left: -25, bottom: 0 }}>
                <defs>
                  <linearGradient id="attGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%"  stopColor="var(--chart-brand)" stopOpacity={0.15} />
                    <stop offset="95%" stopColor="var(--chart-brand)" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--chart-grid)" />
                <XAxis dataKey="month" tick={{ fill: 'var(--chart-axis)', fontSize: 11 }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fill: 'var(--chart-axis)', fontSize: 11 }} domain={[0, 100]} axisLine={false} tickLine={false} />
                <Tooltip content={<ChartTooltip />} />
                <Area type="monotone" dataKey="attendance" name="Attendance"
                  stroke="var(--chart-brand)" fill="url(#attGrad)" strokeWidth={2} dot={false} connectNulls />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Recent Subjects */}
        <div className="lg:col-span-2 card p-4 flex flex-col">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>Recent Subjects</h2>
            <Link to="/teacher/subjects" className="text-xs font-medium flex items-center gap-0.5" style={{ color: 'var(--brand-primary)' }}>
              All <LuArrowRight size={11} />
            </Link>
          </div>

          {subjectsLoading ? (
            <div className="space-y-2 flex-1">
              {[1,2,3].map(i => <div key={i} className="skeleton h-12 w-full" />)}
            </div>
          ) : subjects.length === 0 ? (
            <div className="flex-1 flex flex-col items-center justify-center text-center py-6">
              <p className="text-sm" style={{ color: 'var(--text-muted)' }}>No subjects yet.</p>
              <Link to="/teacher/create-subject" className="mt-1.5 text-sm font-semibold" style={{ color: 'var(--brand-primary)' }}>
                Create one →
              </Link>
            </div>
          ) : (
            <div className="space-y-1.5 flex-1">
              {subjects.slice(0, 6).map(sub => (
                <div key={sub._id}
                  className="flex items-center justify-between px-3 py-2.5 rounded-xl transition-colors cursor-default"
                  style={{ background: 'var(--bg-muted)' }}
                  onMouseEnter={e => { e.currentTarget.style.background = '#EEEBFF' }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'var(--bg-muted)' }}
                >
                  <div className="min-w-0">
                    <p className="text-xs font-semibold truncate" style={{ color: 'var(--text-primary)' }}>{sub.subjectName}</p>
                    <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{sub.subjectCode} · {sub.department}</p>
                  </div>
                  <Link to="/teacher/attendance" state={{ subjectId: sub._id }}
                    className="text-[11px] font-semibold ml-2 shrink-0" style={{ color: 'var(--brand-primary)' }}>
                    Take →
                  </Link>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
