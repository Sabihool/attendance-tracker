/**
 * Reports.jsx — COLOR SYSTEM FIXED
 * BUG FIXED: stats.avg uses b.percentage (not b.attendancePercentage)
 */
import { LuTriangleAlert, LuChartBar, LuChevronDown, LuRefreshCw, LuSearch, LuTrendingUp, LuUsers } from 'react-icons/lu'
import { useState, useEffect, useMemo } from 'react'
import { useLocation } from 'react-router-dom'

import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell
} from 'recharts'
import { useSubjects } from '@context/SubjectsContext'
import { attendanceAPI, getErrorMessage } from '@services/api'
import toast from 'react-hot-toast'

const THRESHOLD = 75

function PctBadge({ pct }) {
  const style = pct >= 85
    ? { color: 'var(--success-text)', background: 'var(--success-bg)', border: '1px solid var(--success-border)' }
    : pct >= THRESHOLD
      ? { color: 'var(--warning-text)', background: 'var(--warning-bg)', border: '1px solid var(--warning-border)' }
      : { color: 'var(--danger-text)', background: 'var(--danger-bg)', border: '1px solid var(--danger-border)' }
  return (
    <span className="text-xs font-mono font-bold px-2 py-0.5 rounded-lg" style={style}>{pct}%</span>
  )
}

const barColor = (range) => {
  if (range.startsWith('86') || range.startsWith('75')) return '#15803D'
  if (range.startsWith('51')) return '#B45309'
  return '#B91C1C'
}

export default function Reports() {
  const location = useLocation()
  const { subjects, fetchSubjects } = useSubjects()
  const [subjectId, setSubjectId] = useState(location.state?.subjectId || '')
  const [data, setData]           = useState([])
  const [sessions, setSessions]   = useState([])
  const [loading, setLoading]     = useState(false)
  const [search, setSearch]       = useState('')

  useEffect(() => { fetchSubjects() }, [fetchSubjects])

  useEffect(() => {
    if (!subjectId) { setData([]); setSessions([]); return }
    load()
  }, [subjectId])

  const load = async () => {
    setLoading(true)
    try {
      const [pctRes, sessRes] = await Promise.all([
        attendanceAPI.getPercentage(subjectId),
        attendanceAPI.getAll(subjectId),
      ])
      setData(pctRes.data?.data?.studentStats || pctRes.data?.data || [])
      setSessions(sessRes.data?.data?.records || sessRes.data?.data || [])
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }

  const filtered = useMemo(() =>
    data.filter(s =>
      s.name?.toLowerCase().includes(search.toLowerCase()) ||
      s.roll?.toLowerCase().includes(search.toLowerCase()) ||
      s.studentId?.toLowerCase().includes(search.toLowerCase())
    ), [data, search])

  const stats = useMemo(() => {
    if (!data.length) return { avg: 0, above: 0, below: 0 }
    const avg = Math.round(data.reduce((a, b) => a + (b.percentage || 0), 0) / data.length)
    const above = data.filter(s => s.percentage >= THRESHOLD).length
    return { avg, above, below: data.length - above }
  }, [data])

  const chartData = useMemo(() => {
    const buckets = [
      { range: '0–25%',   min: 0,  max: 25,  count: 0 },
      { range: '26–50%',  min: 26, max: 50,  count: 0 },
      { range: '51–74%',  min: 51, max: 74,  count: 0 },
      { range: '75–85%',  min: 75, max: 85,  count: 0 },
      { range: '86–100%', min: 86, max: 100, count: 0 },
    ]
    data.forEach(s => {
      const b = buckets.find(b => s.percentage >= b.min && s.percentage <= b.max)
      if (b) b.count++
    })
    return buckets
  }, [data])

  return (
    <div className="space-y-6 p-4 sm:p-6 max-w-6xl mx-auto">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>Attendance Reports</h1>
          <p className="text-sm mt-0.5" style={{ color: 'var(--text-muted)' }}>View attendance percentages per subject</p>
        </div>
        {subjectId && (
          <button onClick={load} className="btn-secondary">
            <LuRefreshCw size={13} /> Refresh
          </button>
        )}
      </div>

      {/* Subject Selector */}
      <div className="relative max-w-sm">
        <select value={subjectId} onChange={e => setSubjectId(e.target.value)} className="select-field">
          <option value="">— Select a subject —</option>
          {subjects.map(s => <option key={s._id} value={s._id}>{s.subjectName} ({s.subjectCode})</option>)}
        </select>
        <LuChevronDown size={14} className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" style={{ color: 'var(--text-muted)' }} />
      </div>

      {!subjectId ? (
        <div className="empty-state">
          <LuChartBar size={40} className="empty-state-icon" />
          <p>Select a subject to view reports</p>
        </div>
      ) : loading ? (
        <div className="space-y-4">{[1,2,3].map(i => <div key={i} className="skeleton h-16 w-full" />)}</div>
      ) : (
        <>
          {/* Stats */}
          <div className="grid grid-cols-3 gap-4">
            {[
              { label: 'Total Students', value: data.length, icon: LuUsers,         bg: 'var(--brand-50)',   color: 'var(--brand-primary)', border: 'var(--brand-200)' },
              { label: 'Above 75%',      value: stats.above, icon: LuTrendingUp,    bg: 'var(--success-bg)', color: 'var(--success-text)', border: 'var(--success-border)' },
              { label: 'Below 75%',      value: stats.below, icon: LuTriangleAlert, bg: 'var(--danger-bg)',  color: 'var(--danger-text)',  border: 'var(--danger-border)' },
            ].map(({ label, value, icon: Icon, bg, color, border }) => (
              <div key={label} className="rounded-xl p-4 flex items-center gap-3"
                style={{ background: bg, border: `1px solid ${border}` }}>
                <Icon size={18} style={{ color }} />
                <div>
                  <p className="text-2xl font-bold font-mono" style={{ color }}>{value}</p>
                  <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{label}</p>
                </div>
              </div>
            ))}
          </div>

          {/* Chart */}
          {chartData.some(b => b.count > 0) && (
            <div className="card p-5">
              <h2 className="text-sm font-semibold mb-4" style={{ color: 'var(--text-primary)' }}>Attendance Distribution</h2>
              <div className="h-44">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={chartData} margin={{ top: 0, right: 10, left: -20, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--chart-grid)" />
                    <XAxis dataKey="range" tick={{ fill: 'var(--chart-axis)', fontSize: 10 }} axisLine={false} tickLine={false} />
                    <YAxis tick={{ fill: 'var(--chart-axis)', fontSize: 11 }} axisLine={false} tickLine={false} allowDecimals={false} />
                    <Tooltip contentStyle={{ background: 'var(--chart-tooltip-bg)', border: '1px solid var(--chart-tooltip-border)', borderRadius: 10, fontSize: 12, color: '#111827' }} />
                    <Bar dataKey="count" name="Students" radius={[4,4,0,0]}>
                      {chartData.map((b, i) => <Cell key={i} fill={barColor(b.range)} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          {/* Student Table */}
          <div className="card p-5">
            <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
              <h2 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                Student Attendance ({sessions.length} sessions)
              </h2>
              <div className="relative">
                <LuSearch size={13} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-muted)' }} />
                <input type="text" value={search} onChange={e => setSearch(e.target.value)} placeholder="Search…"
                  className="input-field pl-8 w-48" />
              </div>
            </div>
            {filtered.length === 0 ? (
              <p className="text-center py-6 text-sm" style={{ color: 'var(--text-muted)' }}>No data available</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr style={{ borderBottom: '1px solid var(--border)' }}>
                      {['#','Roll','Name','Student ID','Present','Absent','Attendance'].map(h => (
                        <th key={h} className="pb-3 text-left pr-4 table-header">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((s, i) => (
                      <tr key={s.studentId} className="table-row-hover"
                        style={{ borderBottom: i < filtered.length - 1 ? '1px solid var(--border-soft)' : 'none' }}>
                        <td className="py-2.5 pr-4 text-xs font-mono" style={{ color: 'var(--text-muted)' }}>{i + 1}</td>
                        <td className="py-2.5 pr-4 font-mono text-xs font-bold" style={{ color: 'var(--brand-primary)' }}>{s.roll || '—'}</td>
                        <td className="py-2.5 pr-4 font-medium" style={{ color: 'var(--text-primary)' }}>{s.name}</td>
                        <td className="py-2.5 pr-4 font-mono text-xs" style={{ color: 'var(--text-muted)' }}>{s.studentId}</td>
                        <td className="py-2.5 pr-4 font-mono font-bold" style={{ color: 'var(--success-text)' }}>{s.attended}</td>
                        <td className="py-2.5 pr-4 font-mono font-bold" style={{ color: 'var(--danger-text)' }}>{s.total - s.attended}</td>
                        <td className="py-2.5"><PctBadge pct={Math.round(s.percentage)} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}
