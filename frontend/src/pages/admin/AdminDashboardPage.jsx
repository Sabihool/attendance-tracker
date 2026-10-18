/**
 * AdminDashboard.jsx — UI refinement pass 2
 * All API logic preserved exactly.
 */
import { LuArrowRight, LuBookOpen, LuCircleCheck, LuClock, LuRefreshCw, LuShield, LuTrash2, LuUsers } from 'react-icons/lu'
import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'

import { useAuth } from '@context/AuthContext'
import { authAPI, trashAPI } from '@services/api'
import toast from 'react-hot-toast'

function DashStatCard({ title, value, icon: Icon, color, link, linkLabel }) {
  const palette = {
    brand:  { iconBg: '#F4F1FF', iconColor: '#6D5EF7' },
    amber:  { iconBg: '#FFFBEB', iconColor: '#D97706' },
    green:  { iconBg: '#F0FDF4', iconColor: '#16A34A' },
    rose:   { iconBg: '#FEF2F2', iconColor: '#DC2626' },
  }
  const c = palette[color] || palette.brand

  return (
    <div className="stat-card card-hover">
      <div className="w-9 h-9 rounded-xl flex items-center justify-center mb-3" style={{ background: c.iconBg }}>
        <Icon size={17} style={{ color: c.iconColor }} />
      </div>
      <p className="text-2xl font-bold leading-none mb-0.5" style={{ color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>
        {value ?? '…'}
      </p>
      <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{title}</p>
      {link && (
        <Link to={link} className="mt-2 flex items-center gap-1 text-xs font-medium" style={{ color: c.iconColor }}>
          {linkLabel} <LuArrowRight size={11} />
        </Link>
      )}
    </div>
  )
}

export default function AdminDashboard() {
  const { user } = useAuth()
  const [stats, setStats] = useState({ total: null, pending: null, approved: null, trashItems: null })
  const [recentPending, setRecentPending] = useState([])
  const [loading, setLoading] = useState(false)

  const load = async () => {
    setLoading(true)
    try {
      const [allRes, pendingRes] = await Promise.all([
        authAPI.getUsers({ role: 'teacher' }),
        authAPI.getUsers({ role: 'teacher', approved: false }),
      ])
      // Rejected requests are not part of the college's teaching staff
      const all     = (allRes.data?.data?.users || allRes.data?.data || []).filter(u => u.approvalStatus !== 'rejected')
      const pending = pendingRes.data?.data?.users || pendingRes.data?.data || []
      const approved = all.filter(u => u.approved === true).length

      let trashItems = 0
      try {
        const trashRes = await trashAPI.adminGetStats()
        trashItems = trashRes.data?.data?.system?.totalTrashedRecords ?? 0
      } catch { /* non-critical */ }

      setStats({ total: all.length, pending: pending.length, approved, trashItems })
      setRecentPending(pending.slice(0, 5))
    } catch {
      toast.error('Failed to load dashboard data')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  return (
    <div className="space-y-4 pb-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold" style={{ color: 'var(--text-primary)' }}>Admin Dashboard</h1>
          <p className="text-sm mt-0.5" style={{ color: 'var(--text-muted)' }}>
            Welcome, <span className="font-semibold" style={{ color: 'var(--brand-primary)' }}>{user?.name}</span>
          </p>
          {user?.college?.name && <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>{user.college.name}{[user.college.district, user.college.country].filter(Boolean).length ? ` · ${[user.college.district, user.college.country].filter(Boolean).join(', ')}` : ''}</p>}
        </div>
        <button onClick={load} disabled={loading} className="btn-secondary disabled:opacity-50">
          <LuRefreshCw size={13} className={loading ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <DashStatCard title="Total Teachers"   value={stats.total}      icon={LuUsers}        color="brand" link="/admin/approve-teachers" linkLabel="Manage" />
        <DashStatCard title="Pending Approval" value={stats.pending}    icon={LuClock}        color="amber" link="/admin/approve-teachers" linkLabel="Review" />
        <DashStatCard title="Approved"         value={stats.approved}   icon={LuCircleCheck} color="green" />
        <DashStatCard title="Trash Items"      value={stats.trashItems} icon={LuTrash2}       color="rose"  link="/admin/trash" linkLabel="View trash" />
      </div>

      {/* Pending + Quick Actions */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        {/* Pending list */}
        <div className="lg:col-span-2 card p-4">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-bold flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
              <LuClock size={14} style={{ color: '#D97706' }} />
              Pending Approvals
            </h2>
            <Link to="/admin/approve-teachers" className="text-xs font-medium flex items-center gap-0.5" style={{ color: 'var(--brand-primary)' }}>
              View all <LuArrowRight size={11} />
            </Link>
          </div>

          {loading ? (
            <div className="space-y-2">
              {[1,2,3].map(i => <div key={i} className="skeleton h-12 w-full" />)}
            </div>
          ) : recentPending.length === 0 ? (
            <div className="text-center py-8">
              <LuCircleCheck size={28} className="mx-auto mb-2" style={{ color: 'var(--success)', opacity: 0.4 }} />
              <p className="text-sm" style={{ color: 'var(--text-muted)' }}>No pending approvals — all clear!</p>
            </div>
          ) : (
            <div className="space-y-1.5">
              {recentPending.map(u => (
                <div key={u._id}
                  className="flex items-center justify-between px-3 py-2.5 rounded-xl transition-colors"
                  style={{ background: 'var(--bg-muted)' }}
                  onMouseEnter={e => { e.currentTarget.style.background = '#EEEBFF' }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'var(--bg-muted)' }}
                >
                  <div className="flex items-center gap-2.5">
                    <div
                      className="w-8 h-8 rounded-lg flex items-center justify-center font-bold text-sm shrink-0"
                      style={{ background: '#FFFBEB', color: '#D97706' }}
                    >
                      {u.name?.charAt(0).toUpperCase()}
                    </div>
                    <div>
                      <p className="text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>{u.name}</p>
                      <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{u.department}</p>
                    </div>
                  </div>
                  <Link to="/admin/approve-teachers" className="text-xs font-medium" style={{ color: 'var(--brand-primary)' }}>
                    Review →
                  </Link>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Quick Actions */}
        <div className="card p-4">
          <h2 className="text-sm font-bold mb-3" style={{ color: 'var(--text-primary)' }}>Quick Actions</h2>
          <div className="space-y-1.5">
            {[
              { to: '/admin/approve-teachers', label: 'Approve Teachers',   icon: LuUsers,        iconBg: '#F4F1FF', iconColor: '#6D5EF7' },
              { to: '/admin/upload-json',      label: 'Upload Students',    icon: LuBookOpen,     iconBg: '#FAF5FF', iconColor: '#9333EA' },
              { to: '/admin/departments',      label: 'Manage Departments', icon: LuShield,       iconBg: '#F0FDF4', iconColor: '#16A34A' },
              { to: '/admin/trash',            label: 'View Trash',         icon: LuTrash2,       iconBg: '#FEF2F2', iconColor: '#DC2626' },
            ].map(({ to, label, icon: Icon, iconBg, iconColor }) => (
              <Link
                key={to}
                to={to}
                className="flex items-center gap-2.5 px-3 py-2.5 rounded-xl transition-all"
                style={{ background: 'var(--bg-muted)' }}
                onMouseEnter={e => { e.currentTarget.style.background = '#EEEBFF'; e.currentTarget.style.transform = 'translateX(3px)' }}
                onMouseLeave={e => { e.currentTarget.style.background = 'var(--bg-muted)'; e.currentTarget.style.transform = 'translateX(0)' }}
              >
                <div className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0" style={{ background: iconBg }}>
                  <Icon size={14} style={{ color: iconColor }} />
                </div>
                <span className="text-xs font-medium flex-1" style={{ color: 'var(--text-primary)' }}>{label}</span>
                <LuArrowRight size={12} style={{ color: 'var(--text-muted)' }} />
              </Link>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
