import { LuBell, LuCheckCheck, LuTrash2, LuX } from 'react-icons/lu'
import { useRef, useEffect } from 'react'

import { useNotifications } from '@context/NotificationContext'
import { useAuth } from '@context/AuthContext'

function timeAgo(iso) {
  if (!iso) return ''
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

export default function NotificationPanel({ onClose }) {
  const panelRef = useRef(null)
  const { user } = useAuth()
  const isAdmin = user?.role === 'admin'
  const {
    teacherNotifs, adminNotifs,
    markTeacherRead, markAllTeacherRead, deleteTeacherNotif, clearAllTeacherNotifs,
    markAdminRead, markAllAdminRead, deleteAdminNotif, clearAllAdminNotifs,
  } = useNotifications()

  const notifs   = isAdmin ? adminNotifs   : teacherNotifs
  const markRead = isAdmin ? markAdminRead  : markTeacherRead
  const markAll  = isAdmin ? markAllAdminRead : markAllTeacherRead
  const del      = isAdmin ? deleteAdminNotif : deleteTeacherNotif
  const clearAll = isAdmin ? clearAllAdminNotifs : clearAllTeacherNotifs

  useEffect(() => {
    const handler = (e) => { if (panelRef.current && !panelRef.current.contains(e.target)) onClose() }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [onClose])

  return (
    <div ref={panelRef} className="absolute right-0 top-full mt-1.5 rounded-xl z-50 overflow-hidden"
      style={{ width: '300px', background: 'var(--bg-card)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-dropdown)' }}>
      <div className="flex items-center justify-between px-4 py-3" style={{ borderBottom: '1px solid var(--border)' }}>
        <p className="text-sm font-semibold flex items-center gap-1.5" style={{ color: 'var(--text-primary)' }}>
          <LuBell size={13} style={{ color: 'var(--brand-primary)' }} />
          Notifications
          {notifs.filter(n => !n.read).length > 0 && (
            <span className="text-[10px] text-white rounded-full px-1.5 py-0.5 font-bold ml-0.5"
              style={{ background: 'var(--brand-primary)' }}>
              {notifs.filter(n => !n.read).length}
            </span>
          )}
        </p>
        <div className="flex items-center gap-1.5">
          {notifs.length > 0 && (
            <>
              <button onClick={markAll} className="p-1 rounded transition-colors" style={{ color: 'var(--text-muted)' }}
                onMouseEnter={e => { e.currentTarget.style.color = 'var(--brand-primary)'; e.currentTarget.style.background = 'var(--bg-muted)' }}
                onMouseLeave={e => { e.currentTarget.style.color = 'var(--text-muted)'; e.currentTarget.style.background = 'transparent' }}>
                <LuCheckCheck size={13} />
              </button>
              <button onClick={clearAll} className="p-1 rounded transition-colors" style={{ color: 'var(--text-muted)' }}
                onMouseEnter={e => { e.currentTarget.style.color = 'var(--danger-text)'; e.currentTarget.style.background = 'var(--danger-bg)' }}
                onMouseLeave={e => { e.currentTarget.style.color = 'var(--text-muted)'; e.currentTarget.style.background = 'transparent' }}>
                <LuTrash2 size={12} />
              </button>
            </>
          )}
          <button onClick={onClose} className="p-1 rounded transition-colors" style={{ color: 'var(--text-muted)' }}
            onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-muted)' }}
            onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}>
            <LuX size={13} />
          </button>
        </div>
      </div>
      <div className="max-h-72 overflow-y-auto">
        {notifs.length === 0 ? (
          <div className="py-8 text-center">
            <LuBell size={20} className="mx-auto mb-2 opacity-20" style={{ color: 'var(--text-muted)' }} />
            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>No notifications</p>
          </div>
        ) : (
          notifs.map((n, idx) => (
            <div key={n.id} onClick={() => markRead(n.id)}
              className="px-4 py-2.5 flex gap-2.5 cursor-pointer transition-colors"
              style={{ background: !n.read ? '#FAFBFF' : 'transparent', borderBottom: idx < notifs.length - 1 ? '1px solid var(--border-soft)' : 'none' }}
              onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-muted)' }}
              onMouseLeave={e => { e.currentTarget.style.background = !n.read ? '#FAFBFF' : 'transparent' }}>
              <div className="w-1.5 h-1.5 rounded-full mt-1.5 shrink-0"
                style={{ background: !n.read ? 'var(--brand-primary)' : 'transparent' }} />
              <div className="flex-1 min-w-0">
                <p className="text-xs leading-relaxed" style={{ color: n.read ? 'var(--text-muted)' : 'var(--text-primary)' }}>
                  {n.message || n.title || 'Notification'}
                </p>
                <p className="text-[10px] mt-0.5" style={{ color: 'var(--text-muted)' }}>{timeAgo(n.createdAt)}</p>
              </div>
              <button onClick={e => { e.stopPropagation(); del(n.id) }}
                className="p-0.5 rounded shrink-0 transition-colors" style={{ color: 'var(--text-muted)' }}
                onMouseEnter={e => { e.currentTarget.style.color = 'var(--danger-text)' }}
                onMouseLeave={e => { e.currentTarget.style.color = 'var(--text-muted)' }}>
                <LuX size={11} />
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
