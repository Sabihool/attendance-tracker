/**
 * TeacherAssignment.jsx — admin: see and change which teacher a subject is
 * assigned to. The choices are loaded from the server and are only the
 * approved teachers of the admin's OWN college; the server re-checks the
 * choice, so a tampered id from another college is refused.
 */
import { LuChevronDown, LuUserCheck } from 'react-icons/lu'
import { useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import { subjectAPI } from '@services/api'
import {
  assignedTeacherId, assignedTeacherName, isReassignment, teacherOptionLabel, subjectErrorMessage,
} from '@utils/subjectForm'

export default function TeacherAssignment({ subject, onAssigned }) {
  const [teachers, setTeachers] = useState([])
  const [loadingList, setLoadingList] = useState(true)
  const currentId = assignedTeacherId(subject)
  // The pick is stored together with the owner it was made against, so after an
  // assignment succeeds (new owner) the selector resets without an effect.
  const [pick, setPick] = useState({ forOwner: currentId, value: currentId })
  const selected = pick.forOwner === currentId ? pick.value : currentId
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let cancelled = false
    subjectAPI.getTeachers()
      .then(res => { if (!cancelled) setTeachers(res.data?.data?.teachers || []) })
      .catch(() => { if (!cancelled) setTeachers([]) })
      .finally(() => { if (!cancelled) setLoadingList(false) })
    return () => { cancelled = true }
  }, [])

  const assign = async () => {
    if (!isReassignment(subject, selected)) return
    setSaving(true)
    try {
      const res = await subjectAPI.update(subject._id, { teacherId: selected })
      const updated = res.data?.data?.subject
      toast.success('Subject assigned. Its attendance records moved with it.')
      if (updated) onAssigned?.(updated)
    } catch (err) {
      toast.error(subjectErrorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  const currentInList = teachers.some(t => String(t._id) === currentId)

  return (
    <div className="card p-5">
      <h2 className="text-sm font-semibold mb-3 flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
        <LuUserCheck size={15} /> Assigned Teacher
      </h2>
      <p className="text-xs mb-3" style={{ color: 'var(--text-secondary)' }}>
        Currently: <strong>{assignedTeacherName(subject)}</strong>. Only approved teachers of your college can be assigned.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-[16rem]">
          <select value={selected} onChange={e => setPick({ forOwner: currentId, value: e.target.value })} disabled={loadingList || saving} className="select-field">
            {!currentInList && <option value={currentId}>{currentId ? assignedTeacherName(subject) : 'Select teacher…'}</option>}
            {teachers.map(t => <option key={t._id} value={t._id}>{teacherOptionLabel(t)}</option>)}
          </select>
          <LuChevronDown size={14} className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" style={{ color: 'var(--text-muted)' }} />
        </div>
        <button onClick={assign} disabled={saving || !isReassignment(subject, selected)} className="btn-primary disabled:opacity-50">
          {saving ? 'Assigning…' : 'Assign'}
        </button>
      </div>
      {!loadingList && teachers.length === 0 && (
        <p className="text-xs mt-2" style={{ color: 'var(--text-muted)' }}>No approved teachers in your college yet.</p>
      )}
    </div>
  )
}
