import { LuBell, LuBookOpen, LuChartBar, LuChevronLeft, LuChevronRight, LuCirclePlus, LuClipboardCheck, LuFileDown, LuLayoutDashboard, LuLogOut, LuPencil, LuTrash2, LuUser, LuUsers } from 'react-icons/lu'
import { NavLink, useNavigate } from 'react-router-dom'

import { useState } from 'react'
import { useAuth } from '@context/AuthContext'
import toast from 'react-hot-toast'

const NAV_ITEMS = [
  { to: '/teacher',                            label: 'Dashboard',       icon: LuLayoutDashboard, end: true },
  { to: '/teacher/create-subject',             label: 'Create Subject',  icon: LuCirclePlus },
  { to: '/teacher/subjects',                   label: 'My Subjects',     icon: LuBookOpen },
  { to: '/teacher/attendance',                 label: 'Take Attendance', icon: LuClipboardCheck },
  { to: '/teacher/edit-attendance',            label: 'Edit Attendance', icon: LuPencil },
  { to: '/teacher/reports',                    label: 'Reports',         icon: LuChartBar },
  { to: '/teacher/student-reports',            label: 'Students',        icon: LuUsers },
  { to: '/teacher/consecutive-absence-alerts', label: 'Absence Alerts',  icon: LuBell, alert: true },
  { to: '/teacher/export',                     label: 'Export',          icon: LuFileDown },
  { to: '/teacher/trash',                      label: 'Trash',           icon: LuTrash2 },
  { to: '/teacher/profile',                    label: 'Profile',         icon: LuUser },
]

export default function Sidebar() {
  const { logout } = useAuth()
  const navigate = useNavigate()
  const [collapsed, setCollapsed] = useState(false)

  const handleLogout = () => {
    logout()
    toast.success('Logged out')
    navigate('/')
  }

  return (
    <aside
      className={`hidden md:flex flex-col shrink-0 transition-all duration-250 ${collapsed ? 'w-14' : 'w-56'}`}
      style={{ background: 'var(--bg-sidebar)', borderRight: '1px solid var(--border)', minHeight: 0 }}
    >
      <div className={`flex items-center h-14 px-3 shrink-0 gap-2.5 ${collapsed ? 'justify-center px-0' : ''}`}
        style={{ borderBottom: '1px solid var(--border)' }}>
        <div className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0" style={{ background: 'var(--brand-primary)' }}>
          <LuClipboardCheck size={14} className="text-white" />
        </div>
        {!collapsed && (
          <div className="min-w-0">
            <p className="text-sm font-bold leading-tight truncate" style={{ color: 'var(--text-primary)' }}>AttendTrack</p>
            <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>by Sabihool</p>
          </div>
        )}
      </div>

      <nav className="flex-1 overflow-y-auto py-3 px-2 space-y-0.5">
        {!collapsed && (
          <p className="text-[10px] font-600 uppercase tracking-widest px-2 pb-1.5 pt-0.5" style={{ color: 'var(--text-muted)' }}>Menu</p>
        )}
        {NAV_ITEMS.map(({ to, label, icon: Icon, end, alert: isAlert }) => (
          <NavLink key={to} to={to} end={end} title={collapsed ? label : undefined}
            className={({ isActive }) =>
              `sidebar-link ${isActive ? 'active' : ''} ${collapsed ? 'justify-center px-0 w-10 mx-auto' : ''}`
            }
            style={({ isActive }) => !isActive && isAlert ? { color: '#D97706' } : undefined}
          >
            <Icon size={15} className="shrink-0" />
            {!collapsed && <span className="truncate">{label}</span>}
          </NavLink>
        ))}
      </nav>

      <div className="px-2 py-2 space-y-0.5" style={{ borderTop: '1px solid var(--border)' }}>
        <button onClick={handleLogout} title={collapsed ? 'Sign Out' : undefined}
          className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-[10px] text-xs font-500 transition-colors ${collapsed ? 'justify-center px-0 w-10 mx-auto' : ''}`}
          style={{ color: 'var(--danger-text)' }}
          onMouseEnter={e => { e.currentTarget.style.background = 'var(--danger-bg)' }}
          onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}>
          <LuLogOut size={14} className="shrink-0" />
          {!collapsed && 'Sign Out'}
        </button>
        <button onClick={() => setCollapsed(c => !c)}
          className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-[10px] text-xs transition-colors ${collapsed ? 'justify-center px-0 w-10 mx-auto' : ''}`}
          style={{ color: 'var(--text-muted)' }}
          onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-muted)'; e.currentTarget.style.color = 'var(--text-secondary)' }}
          onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--text-muted)' }}>
          {collapsed ? <LuChevronRight size={13} /> : <><LuChevronLeft size={13} /><span>Collapse</span></>}
        </button>
      </div>
    </aside>
  )
}
