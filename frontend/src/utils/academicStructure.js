/**
 * Helpers for the department / batch / shift screens (Part 9).
 *
 * The college is NEVER chosen by the browser: the server takes it from the
 * signed-in session. These helpers make sure the UI cannot send one by
 * accident, and give consistent, college-aware wording.
 */

const COLLEGE_KEYS = ['collegeid', 'college_id', 'college', 'tenantid', 'tenant_id', 'tenant']

/** Copy of `payload` without any college/tenant field (top level). Non-objects pass through. */
export const stripCollegeFields = (payload) => {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || payload instanceof FormData) return payload
  return Object.fromEntries(Object.entries(payload).filter(([k]) => !COLLEGE_KEYS.includes(k.toLowerCase())))
}

/** FormData variant (bulk upload): removes any college field before it is sent. */
export const stripCollegeFormData = (fd) => {
  if (typeof FormData === 'undefined' || !(fd instanceof FormData)) return fd
  for (const k of [...fd.keys()]) if (COLLEGE_KEYS.includes(String(k).toLowerCase())) fd.delete(k)
  return fd
}

const norm = (s) => String(s ?? '').trim().toLowerCase()

/**
 * Same rule as the server (case-insensitive, within the list you were given —
 * which is already only your college's). `exceptId` lets a rename keep its own name.
 * Items may be strings or `{ _id, name }`.
 */
export const isDuplicateName = (items, name, exceptId = null) => {
  const n = norm(name)
  if (!n) return false
  return (items || []).some((it) => {
    const label = typeof it === 'string' ? it : it?.name
    const id = typeof it === 'string' ? null : it?._id
    return norm(label) === n && (exceptId == null || id !== exceptId)
  })
}

/** Confirmation text for deleting a whole department/batch/shift group. */
export const groupDeleteConfirm = ({ department, batch, shift, collegeName } = {}) =>
  `Delete ALL students in ${department} / Batch ${batch} / ${shift}` +
  `${collegeName ? ` at ${collegeName}` : ''}? Other colleges are not affected.`

/**
 * Friendly message for a failed academic-structure request.
 * 404 on an item you were just looking at means it is not in your college
 * (or is already gone) — the server answers both the same way on purpose.
 */
export const academicErrorMessage = (error, fallback = 'Something went wrong') => {
  const status = error?.response?.status
  const server = error?.response?.data?.message
  if (status === 404) return 'Not found in your college. It may have been removed — refresh the list.'
  if (status === 403) return 'Only a college admin can do that.'
  return server || error?.message || fallback
}

/** Server `full` lists → names, in the server's order. Tolerates missing/odd data. */
export const namesFrom = (res, key = 'departments') => {
  const v = res?.data?.data?.[key]
  return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []
}
