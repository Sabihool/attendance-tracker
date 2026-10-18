// Utility helpers

export const formatDate = (date) =>
  new Date(date).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })

export const calcAttendancePct = (present, total) =>
  total === 0 ? 0 : Math.round((present / total) * 100)

export const getAttendanceStatus = (pct) => {
  if (pct >= 85) return { label: 'Excellent', color: 'green' }
  if (pct >= 75) return { label: 'Good', color: 'brand' }
  if (pct >= 60) return { label: 'Warning', color: 'amber' }
  return { label: 'Critical', color: 'red' }
}
