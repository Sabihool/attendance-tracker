/**
 * Profile.jsx — UI refinement pass 2
 * All logic preserved exactly.
 */
import { LuBuilding2, LuCircleCheck, LuClock, LuLogOut, LuMail, LuPhone, LuRefreshCw, LuShield, LuUser } from 'react-icons/lu'
import { useState } from 'react'

import { useAuth } from '@context/AuthContext'
import { useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'

function InfoRow({ icon: Icon, label, value }) {
  return (
    <div className="flex items-center gap-3 py-2.5" style={{ borderBottom: '1px solid var(--border-soft)' }}>
      <div className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0" style={{ background: 'var(--bg-muted)' }}>
        <Icon size={13} style={{ color: 'var(--brand-primary)' }} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-[10px] font-600 uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>{label}</p>
        <p className="text-sm font-medium truncate" style={{ color: 'var(--text-primary)' }}>{value || '—'}</p>
      </div>
    </div>
  )
}

export default function Profile() {
  const { user, logout, refreshUser } = useAuth()
  const navigate = useNavigate()
  const [refreshing, setRefreshing] = useState(false)

  const handleLogout = () => {
    logout()
    toast.success('Logged out')
    navigate('/')
  }

  const handleRefresh = async () => {
    setRefreshing(true)
    await refreshUser()
    setRefreshing(false)
    toast.success('Profile refreshed')
  }

  const initials = user?.name?.split(' ').slice(0, 2).map(n => n[0]).join('').toUpperCase() || '?'

  return (
    <div className="max-w-lg mx-auto space-y-4 pb-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold" style={{ color: 'var(--text-primary)' }}>My Profile</h1>
        <button
          onClick={handleRefresh}
          disabled={refreshing}
          className="btn-secondary disabled:opacity-50"
        >
          <LuRefreshCw size={13} className={refreshing ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      {/* Avatar card */}
      <div className="card p-5 flex items-center gap-4">
        <div
          className="w-14 h-14 rounded-2xl flex items-center justify-center text-xl font-bold text-white shrink-0"
          style={{ background: 'var(--brand-primary)' }}
        >
          {initials}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-lg font-bold truncate" style={{ color: 'var(--text-primary)' }}>{user?.name}</p>
          <p className="text-sm truncate" style={{ color: 'var(--text-muted)' }}>{user?.email}</p>
          <div className="flex items-center gap-2 mt-2 flex-wrap">
            {/* Role badge */}
            <span
              className="badge"
              style={{
                background: 'var(--brand-50)',
                color: 'var(--brand-primary)',
                border: '1px solid var(--brand-200)',
              }}
            >
              {user?.role === 'admin' ? '🔑 Admin' : '👨‍🏫 Teacher'}
            </span>
            {/* Status badge */}
            {user?.status === 'approved' ? (
              <span className="badge badge-present flex items-center gap-1">
                <LuCircleCheck size={9} /> Approved
              </span>
            ) : (
              <span className="badge badge-late flex items-center gap-1">
                <LuClock size={9} /> Pending
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Info card */}
      <div className="card px-5 py-2">
        <p className="text-xs font-700 uppercase tracking-wider pt-2 pb-1" style={{ color: 'var(--text-muted)' }}>
          Account Information
        </p>
        <InfoRow icon={LuUser}      label="Full Name"  value={user?.name} />
        <InfoRow icon={LuMail}      label="Email"      value={user?.email} />
        <InfoRow icon={LuBuilding2} label="Department" value={user?.department} />
        <InfoRow icon={LuPhone}     label="Phone"      value={user?.phone} />
        <InfoRow icon={LuShield}    label="Role"       value={user?.role ? user.role.charAt(0).toUpperCase() + user.role.slice(1) : '—'} />
        {/* Remove bottom border from last row */}
        <div className="pb-1" />
      </div>

      {/* Logout */}
      <button
        onClick={handleLogout}
        className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-semibold transition-colors"
        style={{
          background: 'var(--danger-bg)',
          color: 'var(--danger-text)',
          border: '1px solid var(--danger-border)',
        }}
        onMouseEnter={e => { e.currentTarget.style.background = '#FEE2E2' }}
        onMouseLeave={e => { e.currentTarget.style.background = 'var(--danger-bg)' }}
      >
        <LuLogOut size={15} />
        Sign Out
      </button>
    </div>
  )
}
