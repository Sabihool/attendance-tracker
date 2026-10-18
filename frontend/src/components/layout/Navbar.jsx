import { LuBell, LuClipboardCheck, LuLogOut, LuMenu, LuSearch } from 'react-icons/lu'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'

import { useAuth } from '@context/AuthContext'
import { useNotifications } from '@context/NotificationContext'
import NotificationPanel from '@components/common/NotificationPanel'
import toast from 'react-hot-toast'

export default function Navbar({ onMenuClick }) {
  const { user, logout } = useAuth()
  const { teacherNotifs, adminNotifs } = useNotifications()
  const navigate = useNavigate()
  const [showNotifs, setShowNotifs] = useState(false)

  const isAdmin = user?.role === 'admin'
  const notifs  = isAdmin ? adminNotifs : teacherNotifs
  const unread  = notifs.filter(n => !n.read).length

  const handleLogout = () => {
    logout()
    toast.success('Logged out')
    navigate('/')
  }

  const initials = user?.name
    ? user.name.split(' ').map(p => p[0]).slice(0, 2).join('').toUpperCase()
    : 'U'

  return (
    <header
      className="flex items-center justify-between px-5 h-14 shrink-0 sticky top-0 z-40"
      style={{ background: 'var(--bg-navbar)', borderBottom: '1px solid var(--border)', boxShadow: 'var(--shadow-navbar)' }}
    >
      <div className="flex items-center gap-3">
        <button
          className="md:hidden p-1.5 rounded-lg transition-colors"
          style={{ color: 'var(--text-secondary)' }}
          onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-muted)' }}
          onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
          onClick={onMenuClick}
        >
          <LuMenu size={18} />
        </button>
        <Link to={isAdmin ? '/admin' : '/teacher'} className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg flex items-center justify-center" style={{ background: 'var(--brand-primary)' }}>
            <LuClipboardCheck size={13} className="text-white" />
          </div>
          <span className="hidden sm:block text-sm font-bold" style={{ color: 'var(--text-primary)' }}>AttendTrack</span>
        </Link>
      </div>

      {user?.college?.name && (
        <div className="hidden lg:flex min-w-0 flex-col flex-1 px-3" aria-label="Current college">
          <span className="text-xs font-semibold truncate" style={{ color: 'var(--text-primary)' }}>{user.college.name}</span>
          <span className="text-[11px] truncate" style={{ color: 'var(--text-muted)' }}>
            {[user.college.district, user.college.country].filter(Boolean).join(', ')}
          </span>
        </div>
      )}

      <div className="hidden md:flex items-center gap-2 flex-1 max-w-xs mx-6">
        <div className="flex items-center gap-2 w-full px-3 py-1.5 rounded-lg"
          style={{ background: 'var(--bg-input)', border: '1.5px solid var(--border)' }}>
          <LuSearch size={13} style={{ color: 'var(--text-muted)' }} />
          <input type="text" placeholder="Search…" className="bg-transparent outline-none text-sm flex-1"
            style={{ color: 'var(--text-primary)', fontFamily: 'Poppins, sans-serif' }} />
        </div>
      </div>

      <div className="flex items-center gap-1.5">
        <div className="relative">
          <button
            onClick={() => setShowNotifs(s => !s)}
            className="relative w-8 h-8 rounded-lg flex items-center justify-center transition-colors"
            style={{ color: 'var(--text-secondary)' }}
            onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-muted)' }}
            onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
          >
            <LuBell size={16} />
            {unread > 0 && (
              <span className="absolute -top-0.5 -right-0.5 w-4 h-4 text-white text-[9px] font-bold rounded-full flex items-center justify-center"
                style={{ background: 'var(--brand-primary)' }}>
                {unread > 9 ? '9+' : unread}
              </span>
            )}
          </button>
          {showNotifs && <NotificationPanel onClose={() => setShowNotifs(false)} />}
        </div>

        <Link
          to={isAdmin ? '/admin' : '/teacher/profile'}
          className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg transition-colors"
          style={{ border: '1.5px solid var(--border)' }}
          onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-muted)' }}
          onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
        >
          <div className="w-6 h-6 rounded-md flex items-center justify-center text-white text-xs font-bold shrink-0"
            style={{ background: 'var(--brand-primary)' }}>
            {initials}
          </div>
          <span className="hidden sm:block text-xs font-medium max-w-20 truncate" style={{ color: 'var(--text-primary)' }}>
            {user?.name?.split(' ')[0]}
          </span>
        </Link>

        <button
          onClick={handleLogout}
          title="Sign out"
          className="w-8 h-8 rounded-lg flex items-center justify-center transition-colors"
          style={{ color: 'var(--text-muted)' }}
          onMouseEnter={e => { e.currentTarget.style.background = 'var(--danger-bg)'; e.currentTarget.style.color = 'var(--danger-text)' }}
          onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--text-muted)' }}
        >
          <LuLogOut size={15} />
        </button>
      </div>
    </header>
  )
}
