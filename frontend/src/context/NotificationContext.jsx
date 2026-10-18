/**
 * NotificationContext.jsx — Toast-based notifications (no dummy data)
 * Part 20: Full Integration
 */
import { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react'
import toast from 'react-hot-toast'
import { useAuth } from '@context/AuthContext'
import { notificationAPI } from '@services/api'
import { toPanelNotification } from '@utils/teacherRequests'

const POLL_MS = 45_000
// Server notifications have string ids; anything else is a purely local item.
const isServerId = (id) => typeof id === 'string'
// Fire-and-forget server call (skipped for local-only ids). The UI updates optimistically.
const sync = (fn, id) => { if (id === undefined || isServerId(id)) fn(id).catch(() => {}) }

const NotificationContext = createContext(null)

export function NotificationProvider({ children }) {
  const [teacherNotifs, setTeacherNotifs] = useState([])
  const [adminNotifs, setAdminNotifs]     = useState([])
  const { user } = useAuth()
  const seenIds = useRef(null)          // null until the first load, so old items don't toast

  // ── Server sync: load on login, refresh every 45 s while the tab is visible ──
  const role = user?.role
  const canSync = !!user && (role === 'admin' || user.approved === true)
  useEffect(() => {
    if (!canSync) {
      seenIds.current = null
      setTeacherNotifs([]); setAdminNotifs([])
      return undefined
    }
    let cancelled = false
    const apply = role === 'admin' ? setAdminNotifs : setTeacherNotifs
    const pull = async () => {
      try {
        const res  = await notificationAPI.list()
        if (cancelled) return
        const list = (res.data?.data?.notifications || []).map(toPanelNotification)
        if (seenIds.current) {
          const fresh = list.filter(n => !n.read && !seenIds.current.has(n.id))
          if (fresh.length) toast(fresh[0].title || fresh[0].message, { icon: '🔔' })
        }
        seenIds.current = new Set(list.map(n => n.id))
        apply(list)
      } catch { /* offline / transient — keep what we have */ }
    }
    pull()
    const timer = setInterval(() => { if (document.visibilityState === 'visible') pull() }, POLL_MS)
    return () => { cancelled = true; clearInterval(timer) }
  }, [canSync, role, user?.id, user?._id])

  // Teacher
  const addTeacherNotif = useCallback((notif) => {
    setTeacherNotifs(prev => [{ ...notif, id: Date.now(), read: false, createdAt: new Date().toISOString() }, ...prev])
  }, [])
  const markTeacherRead = useCallback((id) => {
    setTeacherNotifs(prev => prev.map(n => n.id === id ? { ...n, read: true } : n))
    sync(notificationAPI.markRead, id)
  }, [])
  const markAllTeacherRead = useCallback(() => {
    setTeacherNotifs(prev => prev.map(n => ({ ...n, read: true })))
    sync(notificationAPI.markAllRead)
    toast.success('All notifications marked as read')
  }, [])
  const deleteTeacherNotif = useCallback((id) => {
    setTeacherNotifs(prev => prev.filter(n => n.id !== id))
    sync(notificationAPI.remove, id)
    toast.success('Notification deleted')
  }, [])
  const clearAllTeacherNotifs = useCallback(() => {
    setTeacherNotifs([])
    sync(notificationAPI.clear)
    toast.success('All notifications cleared')
  }, [])

  // Admin
  const addAdminNotif = useCallback((notif) => {
    setAdminNotifs(prev => [{ ...notif, id: Date.now(), read: false, createdAt: new Date().toISOString() }, ...prev])
  }, [])
  const markAdminRead = useCallback((id) => {
    setAdminNotifs(prev => prev.map(n => n.id === id ? { ...n, read: true } : n))
    sync(notificationAPI.markRead, id)
  }, [])
  const markAllAdminRead = useCallback(() => {
    setAdminNotifs(prev => prev.map(n => ({ ...n, read: true })))
    sync(notificationAPI.markAllRead)
    toast.success('All notifications marked as read')
  }, [])
  const deleteAdminNotif = useCallback((id) => {
    setAdminNotifs(prev => prev.filter(n => n.id !== id))
    sync(notificationAPI.remove, id)
    toast.success('Notification deleted')
  }, [])
  const clearAllAdminNotifs = useCallback(() => {
    setAdminNotifs([])
    sync(notificationAPI.clear)
    toast.success('All notifications cleared')
  }, [])

  const showToast = useCallback((type, message) => {
    switch (type) {
      case 'success': toast.success(message); break
      case 'error':   toast.error(message); break
      case 'warning': toast(message, { icon: '⚠️' }); break
      case 'info':    toast(message, { icon: 'ℹ️' }); break
      default:        toast(message)
    }
  }, [])

  return (
    <NotificationContext.Provider value={{
      teacherNotifs,
      adminNotifs,
      addTeacherNotif,
      markTeacherRead,
      markAllTeacherRead,
      deleteTeacherNotif,
      clearAllTeacherNotifs,
      addAdminNotif,
      markAdminRead,
      markAllAdminRead,
      deleteAdminNotif,
      clearAllAdminNotifs,
      showToast,
    }}>
      {children}
    </NotificationContext.Provider>
  )
}

export function useNotifications() {
  const ctx = useContext(NotificationContext)
  if (!ctx) throw new Error('useNotifications must be used within NotificationProvider')
  return ctx
}
