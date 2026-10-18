/**
 * Helpers for the subject screens (Part 11).
 *
 * The college is never chosen in the browser, and neither is a teacher outside
 * it: the server takes the college from the session and only accepts a
 * `teacherId` that belongs to the admin's own college. These helpers keep the UI
 * from sending more than it should and give clear wording for the failures.
 */

/** Fields the API accepts when creating / editing a subject (teacherId: admins only). */
export const SUBJECT_CREATE_FIELDS = ['subjectName', 'subjectCode', 'batch', 'department', 'shift', 'color', 'teacherId']
export const SUBJECT_EDIT_FIELDS = ['subjectName', 'subjectCode', 'batch', 'department', 'shift', 'creditType', 'credits', 'color', 'isArchived', 'teacherId']

/**
 * Copy only the allowed keys, so a whole subject object read from the API
 * (with its populated `teacher`, `_id`, timestamps, …) is never posted back.
 * An empty `teacherId` is dropped: "no assignment" means "keep the default owner".
 */
export const pickSubjectFields = (source, allowed = SUBJECT_EDIT_FIELDS) => {
  const out = {}
  for (const key of allowed) {
    if (!source || source[key] === undefined) continue
    if (key === 'teacherId' && (source[key] === '' || source[key] === null)) continue
    out[key] = source[key]
  }
  return out
}

/** Id of the teacher a subject is assigned to (populated object, plain id, or null when hidden). */
export const assignedTeacherId = (subject) => {
  const t = subject?.teacher
  if (!t) return ''
  return typeof t === 'string' ? t : String(t._id ?? '')
}

export const assignedTeacherName = (subject) => subject?.teacher?.name || '—'

/** "Name — Department" for a teacher selector option. */
export const teacherOptionLabel = (t) => (t?.department ? `${t.name} — ${t.department}` : t?.name || '')

/**
 * Has the admin picked someone different from the current owner? (Used to
 * disable the Assign button and to skip a pointless request.)
 */
export const isReassignment = (subject, selectedTeacherId) =>
  !!selectedTeacherId && selectedTeacherId !== assignedTeacherId(subject)

/**
 * Message for a failed subject request. 404 on a subject you were just looking
 * at means it is not in your college (or is gone) — the server answers both the
 * same way on purpose, so the wording covers both.
 */
export const subjectErrorMessage = (error, fallback = 'Something went wrong') => {
  const status = error?.response?.status
  const server = error?.response?.data?.message
  if (status === 404) return 'Subject not found in your college. It may have been deleted — refresh the list.'
  if (status === 403) return server || 'You are not allowed to do that with this subject.'
  return server || error?.message || fallback
}
