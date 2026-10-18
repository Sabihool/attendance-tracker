/**
 * Pure helpers for the college Teachers page (no React; unit-tested).
 * The server decides what is allowed — these only describe and word things.
 */

export const TYPE_TABS = [
  { value: 'teacher', label: 'Teachers' },
  { value: 'admin',   label: 'Admins'   },
  { value: 'all',     label: 'Everyone' },
]

export const STATUS_FILTERS = [
  { value: 'all',      label: 'All'      },
  { value: 'pending',  label: 'Pending'  },
  { value: 'approved', label: 'Approved' },
  { value: 'rejected', label: 'Rejected' },
]

export const ROLE_LABEL = { admin: 'Admin', teacher: 'Teacher' }

/** "Last session 3 d ago", "No sessions yet" … */
export const activitySummary = (a, now = Date.now()) => {
  if (!a) return ''
  const parts = [`${a.totalSubjects} subject${a.totalSubjects === 1 ? '' : 's'}`, `${a.totalSessions} session${a.totalSessions === 1 ? '' : 's'}`]
  if (a.lastAttendanceDate) {
    const days = Math.max(0, Math.floor((now - new Date(a.lastAttendanceDate).getTime()) / 86400000))
    parts.push(days === 0 ? 'last session today' : `last session ${days} d ago`)
  } else {
    parts.push('no sessions yet')
  }
  return parts.join(' · ')
}

/** Text of the confirmation shown before a privileged action. */
export const confirmMessage = (action, member) => ({
  promote: `Make ${member.name} an administrator? They will be able to approve teachers, manage students and change other admins' access in your college. They will have to sign in again.`,
  demote:  `Remove admin privileges from ${member.name}? They become a teacher and will have to sign in again.`,
  remove:  `Delete ${member.name} permanently? Their subjects and attendance records stay in the college. They will be able to register again.`,
  reject:  `Reject ${member.name}? This cannot be undone.`,
}[action])

const CODE_MESSAGES = {
  FOUNDER_PROTECTED: "The college's original administrator cannot lose admin privileges.",
  LAST_ADMIN: 'A college must keep at least one administrator.',
  SELF_CHANGE: 'You cannot change your own role.',
  NOT_APPROVED: 'Only approved accounts can be given a role. Approve the account first.',
  ADMIN_NOT_DELETABLE: "Remove this person's admin privileges before deleting the account.",
  CONFLICT: 'This account was just changed by someone else.',
  NO_COLLEGE: 'Your account is not assigned to a college.',
}

/** What to show and whether to reload after a failed action. */
export const actionFailure = (error) => {
  const status = error?.response?.status
  const data = error?.response?.data || {}
  return {
    message: CODE_MESSAGES[data.code] || data.message || error?.message || 'Something went wrong',
    refresh: status === 409 || status === 404 || status === 403,
  }
}

/** Success text after promote/demote (the person must sign in again). */
export const roleChangeNotice = (action, name) =>
  action === 'promote' ? `${name} is now an administrator` : `${name} is now a teacher`
