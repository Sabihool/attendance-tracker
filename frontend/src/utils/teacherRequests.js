/**
 * Pure helpers for the teacher-request screens (no React, unit-tested).
 */

export const STATUS_TABS = [
  { value: 'pending',  label: 'Pending'  },
  { value: 'approved', label: 'Approved' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'all',      label: 'All'      },
]

export const STATUS_BADGE = {
  pending:  'badge-warning',
  approved: 'badge-success',
  rejected: 'badge-danger',
}

/** "3 Oct 2026, 3:22 pm" — absolute registration time, locale-aware. */
export const formatRegisteredAt = (iso, locale) => {
  const d = new Date(iso)
  if (!iso || Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString(locale, { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' })
}

/** "just now", "5 min ago", "3 h ago", "2 d ago" */
export const timeAgo = (iso, now = Date.now()) => {
  const t = new Date(iso).getTime()
  if (!iso || Number.isNaN(t)) return ''
  const mins = Math.floor((now - t) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs} h ago`
  return `${Math.floor(hrs / 24)} d ago`
}

/** "Alpha College · Feni, Bangladesh" */
export const formatCollege = (college) => {
  if (!college?.name) return 'No college assigned'
  const where = [college.district, college.country].filter(Boolean).join(', ')
  return where ? `${college.name} · ${where}` : college.name
}

/**
 * Decide what the screen should do after a failed approve/reject.
 *  - 409 (someone else already decided) and 404 (request gone / not ours): refresh the list
 *  - 403 (college suspended/unavailable, role change): show the reason, refresh
 */
export const decisionFailure = (error) => {
  const status = error?.response?.status
  const data = error?.response?.data || {}
  const message = data.message || error?.message || 'Something went wrong'
  return {
    message,
    refresh: status === 409 || status === 404 || status === 403,
    conflict: status === 409,
    currentStatus: data.currentStatus || null,
  }
}

/** Pending count for the sidebar badge ("9+" when large). */
export const badgeLabel = (n) => (!n || n < 1 ? '' : n > 9 ? '9+' : String(n))

/** Normalise a server notification (string id) for the existing panel. */
export const toPanelNotification = (n) => ({
  id: n.id, type: n.type, title: n.title, message: n.message || n.title,
  read: !!n.read, createdAt: n.createdAt, data: n.data || null,
})
