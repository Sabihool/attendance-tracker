import { LuAward, LuBookOpen, LuBuilding2, LuChevronLeft, LuChevronRight, LuClock, LuFolderTree, LuGauge, LuIdCard, LuLayoutDashboard, LuLogOut, LuSettings, LuShield, LuTrash2, LuUpload, LuUserCheck, LuUsers } from 'react-icons/lu'
import { NavLink, useNavigate } from 'react-router-dom'

import { useState, useEffect } from 'react'
import { useAuth } from '@context/AuthContext'
import { teacherRequestAPI } from '@services/api'
import { badgeLabel } from '@utils/teacherRequests'
import toast from 'react-hot-toast'

const NAV_ITEMS = [
  { to: '/admin',                        label: 'Dashboard',            icon: LuLayoutDashboard, end: true },
  { to: '/admin/academic-structure',     label: 'Academic Structure',   icon: LuFolderTree },
  { to: '/admin/teachers',              label: 'Teachers',             icon: LuUserCheck },
  { to: '/admin/teacher-performance',    label: 'Teacher Performance',  icon: LuGauge },
  { to: '/admin/subjects',               label: 'All Subjects',         icon: LuBookOpen },
  { to: '/admin/upload-json',            label: 'Upload Students',      icon: LuUpload },
  { to: '/admin/students',               label: 'Manage Students',      icon: LuUsers },
  { to: '/admin/all-students',           label: 'All Students',         icon: LuIdCard },
  { to: '/admin/departments',            label: 'Departments',          icon: LuBuilding2 },
  { to: '/admin/shifts',                 label: 'Shifts',               icon: LuClock },
  { to: '/admin/attendance-categories',  label: 'Attendance Categories',icon: LuAward },
  { to: '/admin/settings',               label: 'Settings',             icon: LuSettings },
  { to: '/admin/trash',                  label: 'Trash',                icon: LuTrash2 },
]

export default function AdminSidebar() {
  const { logout } = useAuth()
  const navigate = useNavigate()
  const [collapsed, setCollapsed] = useState(false)
  const [pending, setPending] = useState(0)   // this college's pending teacher requests

  useEffect(() => {
    let cancelled = false
    const pull = async () => {
      try {
        const res = await teacherRequestAPI.summary()
        if (!cancelled) setPending(res.data?.data?.counts?.pending || 0)
      } catch { if (!cancelled) setPending(0) }
    }
    pull()
    const t = setInterval(() => { if (document.visibilityState === 'visible') pull() }, 45_000)
    return () => { cancelled = true; clearInterval(t) }
  }, [])

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
          <LuShield size={14} className="text-white" />
        </div>
        {!collapsed && (
          <div className="min-w-0">
            <p className="text-sm font-bold leading-tight truncate" style={{ color: 'var(--text-primary)' }}>Admin Panel</p>
            <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>Attendance Tracker</p>
          </div>
        )}
      </div>

      <nav className="flex-1 overflow-y-auto py-3 px-2 space-y-0.5">
        {!collapsed && (
          <p className="text-[10px] font-600 uppercase tracking-widest px-2 pb-1.5 pt-0.5" style={{ color: 'var(--text-muted)' }}>Admin Menu</p>
        )}
        {NAV_ITEMS.map(({ to, label, icon: Icon, end }) => (
          <NavLink key={to} to={to} end={end} title={collapsed ? label : undefined}
            className={({ isActive }) =>
              `sidebar-link ${isActive ? 'active' : ''} ${collapsed ? 'justify-center px-0 w-10 mx-auto' : ''}`
            }
          >
            <Icon size={15} className="shrink-0" />
            {!collapsed && <span className="truncate">{label}</span>}
            {to === '/admin/teachers' && badgeLabel(pending) && (
              <span className="ml-auto text-[10px] font-bold text-white rounded-full px-1.5 py-0.5 shrink-0"
                style={{ background: 'var(--brand-primary)' }} aria-label={`${pending} pending requests`}>
                {badgeLabel(pending)}
              </span>
            )}
          </NavLink>
        ))}
      </nav>

      <div className="px-2 py-2 space-y-0.5" style={{ borderTop: '1px solid var(--border)' }}>
        <button onClick={handleLogout}
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
