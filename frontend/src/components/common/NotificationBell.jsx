/**
 * NotificationBell.jsx — COLOR SYSTEM FIXED
 */
import { LuBell } from 'react-icons/lu'
import { useState } from 'react'

import NotificationPanel from './NotificationPanel'

export default function NotificationBell({
  notifications,
  onMarkRead,
  onMarkAllRead,
  onDelete,
  onClearAll,
  accentColor = 'brand',
  onClose,
}) {
  const [open, setOpen] = useState(false)
  const unreadCount = notifications.filter(n => !n.read).length

  const handleClose = () => {
    setOpen(false)
    onClose?.()
  }

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(o => !o)}
        className="relative w-8 h-8 rounded-lg flex items-center justify-center transition-colors"
        style={{ color: 'var(--text-secondary)' }}
        onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-muted)' }}
        onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
        aria-label="Notifications"
      >
        <LuBell size={16} />
        {unreadCount > 0 && (
          <span
            className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 text-white text-[9px] font-bold rounded-full flex items-center justify-center px-0.5"
            style={{ background: 'var(--brand-primary)' }}
          >
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <NotificationPanel
          notifications={notifications}
          onClose={handleClose}
          onMarkRead={onMarkRead}
          onMarkAllRead={() => { onMarkAllRead() }}
          onDelete={onDelete}
          onClearAll={() => { onClearAll() }}
          accentColor={accentColor}
        />
      )}
    </div>
  )
}
