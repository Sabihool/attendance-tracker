/**
 * TakeAttendance.jsx — COLOR SYSTEM FIXED
 * All API logic preserved exactly.
 */
import { LuBookOpen, LuCalendarDays, LuChevronDown, LuCircleAlert, LuCircleCheck, LuCircleX, LuClipboardList, LuPencil, LuRotateCcw, LuSave, LuSearch, LuSquare, LuSquareCheck, LuUsers } from 'react-icons/lu'
import { useState, useEffect, useMemo, useCallback } from 'react'
import { useLocation } from 'react-router-dom'

import toast from 'react-hot-toast'
import { useSubjects } from '@context/SubjectsContext'
import { studentAPI, attendanceAPI, attendanceCategoryAPI, getErrorMessage } from '@services/api'

const todayISO = () => new Date().toISOString().split('T')[0]
const initials = n => n?.split(' ').slice(0, 2).map(x => x[0]).join('').toUpperCase() || '?'

// Simple letter-based avatar background (light mode)
const AVATAR_COLORS = [
  { bg: '#EEF0FF', color: '#5B4BE0' },
  { bg: '#F0FDF4', color: '#15803D' },
  { bg: '#FFFBEB', color: '#B45309' },
  { bg: '#FEF2F2', color: '#B91C1C' },
  { bg: '#F5F3FF', color: '#7C3AED' },
]
const avatarColor = id => AVATAR_COLORS[(id?.charCodeAt(id.length - 1) || 0) % AVATAR_COLORS.length]

function SelectField({ icon: Icon, label, value, onChange, options, placeholder, disabled }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="form-label flex items-center gap-1.5">
        <Icon size={12} style={{ color: 'var(--brand-primary)' }} />{label}
      </label>
      <div className="relative">
        <select value={value} onChange={e => onChange(e.target.value)} disabled={disabled}
          className="select-field"
          style={disabled ? { opacity: 0.6, cursor: 'not-allowed' } : {}}>
          <option value="">{placeholder}</option>
          {options.map(o => <option key={o._id || o} value={o._id || o}>{o.subjectName || o}</option>)}
        </select>
        <LuChevronDown size={14} className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" style={{ color: 'var(--text-muted)' }} />
      </div>
    </div>
  )
}

export default function TakeAttendance() {
  const location = useLocation()
  const { subjects, fetchSubjects, loading: subjectsLoading } = useSubjects()

  const [selectedSubjectId, setSelectedSubjectId] = useState(location.state?.subjectId || '')
  const [categories, setCategories] = useState([]) // [{ name, credit }] — admin-defined (spec section 3)
  const [classType, setClassType] = useState('')
  const [creditValue, setCreditValue] = useState('') // auto-filled from category, teacher-editable (spec section 5)
  const [creditTouched, setCreditTouched] = useState(false)
  const [date, setDate] = useState(todayISO())
  const [search, setSearch] = useState('')
  const [attendance, setAttendance] = useState({})
  const [students, setStudents] = useState([])
  const [loadingStudents, setLoadingStudents] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => { fetchSubjects() }, [fetchSubjects])

  useEffect(() => {
    attendanceCategoryAPI.getAll()
      .then(res => {
        const cats = res.data?.data?.categories || []
        setCategories(cats)
        if (cats.length > 0) {
          // Spec section 3: category dropdown defaults to "Theory" — teacher
          // can still change it. Falls back to the first category if an
          // admin has renamed/removed Theory entirely.
          const theory = cats.find(c => c.name?.toLowerCase() === 'theory')
          const defaultCat = theory || cats[0]
          setClassType(defaultCat.name)
          setCreditValue(String(defaultCat.credit))
        }
      })
      .catch(err => toast.error(getErrorMessage(err)))
  }, [])

  // Auto-fill credit value whenever the category changes, unless the teacher
  // has manually edited it for this session (spec section 5: editable override)
  useEffect(() => {
    if (creditTouched) return
    const cat = categories.find(c => c.name === classType)
    if (cat) setCreditValue(String(cat.credit))
  }, [classType, categories, creditTouched])

  const handleClassTypeChange = (val) => {
    setClassType(val)
    setCreditTouched(false) // reset override when switching category
    setSaved(false)
  }

  const selectedSubject = useMemo(() =>
    subjects.find(s => s._id === selectedSubjectId), [subjects, selectedSubjectId])

  useEffect(() => {
    if (!selectedSubject) { setStudents([]); setAttendance({}); return }
    const load = async () => {
      setLoadingStudents(true)
      try {
        const res = await studentAPI.getAll({
          department: selectedSubject.department,
          batch: selectedSubject.batch,
          shift: selectedSubject.shift,
        })
        const list = res.data?.data?.students || res.data?.data || []
        setStudents(list)
        const init = {}
        list.forEach(s => { init[s.studentId] = true })
        setAttendance(init)
      } catch (err) {
        toast.error(getErrorMessage(err))
      } finally {
        setLoadingStudents(false)
      }
    }
    load()
    setSaved(false)
  }, [selectedSubject])

  const filtered = useMemo(() =>
    students.filter(s =>
      s.name?.toLowerCase().includes(search.toLowerCase()) ||
      s.studentId?.toLowerCase().includes(search.toLowerCase())
    ), [students, search])

  const toggle = useCallback((id) => {
    setAttendance(prev => ({ ...prev, [id]: !prev[id] }))
    setSaved(false)
  }, [])

  const markAll = (val) => {
    const next = {}
    students.forEach(s => { next[s.studentId] = val })
    setAttendance(next)
    setSaved(false)
  }

  const presentCount = Object.values(attendance).filter(Boolean).length
  const absentCount  = students.length - presentCount
  const pct = students.length ? Math.round((presentCount / students.length) * 100) : 0

  const handleSave = async () => {
    if (!selectedSubjectId) { toast.error('Please select a subject'); return }
    if (!classType) { toast.error('Please select an attendance category'); return }
    if (students.length === 0) { toast.error('No students loaded'); return }
    setSaving(true)
    try {
      const students_payload = students.map(s => ({
        studentId: s.studentId,
        roll: s.roll || s.studentId,
        name: s.name,
        status: attendance[s.studentId] ? 'present' : 'absent',
      }))
      await attendanceAPI.save(selectedSubjectId, {
        date,
        classType,
        students: students_payload,
        creditValue: creditValue !== '' ? Number(creditValue) : undefined,
      })
      toast.success('Attendance saved successfully!')
      setSaved(true)
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-5 p-4 sm:p-6 max-w-5xl mx-auto">
      <div>
        <h1 className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>Take Attendance</h1>
        <p className="text-sm mt-0.5" style={{ color: 'var(--text-muted)' }}>Mark attendance for a class session</p>
      </div>

      {/* Config Panel */}
      <div className="card p-5 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <SelectField icon={LuBookOpen} label="Subject" value={selectedSubjectId}
          onChange={v => { setSelectedSubjectId(v); setSaved(false) }}
          options={subjects} placeholder="Select subject…" disabled={subjectsLoading} />
        <SelectField icon={LuClipboardList} label="Attendance Category" value={classType}
          onChange={handleClassTypeChange} options={categories.map(c => c.name)} placeholder="Select category…" />
        <div className="flex flex-col gap-1.5">
          <label className="form-label flex items-center gap-1.5">
            <LuPencil size={12} style={{ color: 'var(--brand-primary)' }} />Credit Value
          </label>
          <input
            type="number" min="0" max="20" step="0.5"
            value={creditValue}
            onChange={e => { setCreditValue(e.target.value); setCreditTouched(true); setSaved(false) }}
            className="input-field"
            title="Auto-filled from the category's credit value — edit to override for this session only"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label className="form-label flex items-center gap-1.5">
            <LuCalendarDays size={12} style={{ color: 'var(--brand-primary)' }} />Date
          </label>
          <input type="date" value={date} onChange={e => setDate(e.target.value)} max={todayISO()}
            className="input-field" />
        </div>
        {selectedSubject && (
          <div className="flex flex-col gap-1.5">
            <label className="form-label">Subject Info</label>
            <div className="rounded-xl px-3 py-2.5" style={{ background: 'var(--bg-muted)', border: '1px solid var(--border)' }}>
              <p className="text-xs font-mono font-bold" style={{ color: 'var(--brand-primary)' }}>{selectedSubject.subjectCode}</p>
              <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>{selectedSubject.department}</p>
            </div>
          </div>
        )}
      </div>

      {/* Stats */}
      {students.length > 0 && (
        <div className="grid grid-cols-3 gap-3">
          {[
            { label: 'Total',   value: students.length, bg: 'var(--bg-muted)',    color: 'var(--text-primary)',  border: 'var(--border)' },
            { label: 'Present', value: presentCount,    bg: 'var(--success-bg)',  color: 'var(--success-text)', border: 'var(--success-border)' },
            { label: 'Absent',  value: absentCount,     bg: 'var(--danger-bg)',   color: 'var(--danger-text)',  border: 'var(--danger-border)' },
          ].map(s => (
            <div key={s.label} className="rounded-xl px-4 py-3 text-center"
              style={{ background: s.bg, border: `1px solid ${s.border}` }}>
              <p className="text-2xl font-bold font-mono" style={{ color: s.color }}>{s.value}</p>
              <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>{s.label}</p>
            </div>
          ))}
        </div>
      )}

      {/* Student List */}
      {selectedSubjectId && (
        <div className="card p-5 space-y-4">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div className="relative flex-1 min-w-48">
              <LuSearch size={14} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-muted)' }} />
              <input type="text" value={search} onChange={e => setSearch(e.target.value)}
                placeholder="Search students…" className="input-field pl-9" />
            </div>
            <div className="flex gap-2">
              <button onClick={() => markAll(true)}
                className="text-xs px-3 py-1.5 rounded-lg transition-all flex items-center gap-1.5"
                style={{ background: 'var(--success-bg)', color: 'var(--success-text)', border: '1px solid var(--success-border)' }}>
                <LuSquareCheck size={12} /> All Present
              </button>
              <button onClick={() => markAll(false)}
                className="text-xs px-3 py-1.5 rounded-lg transition-all flex items-center gap-1.5"
                style={{ background: 'var(--danger-bg)', color: 'var(--danger-text)', border: '1px solid var(--danger-border)' }}>
                <LuSquare size={12} /> All Absent
              </button>
              <button onClick={() => markAll(true)} className="icon-btn" title="Reset">
                <LuRotateCcw size={12} />
              </button>
            </div>
          </div>

          {loadingStudents ? (
            <div className="space-y-2">
              {[1,2,3,4,5].map(i => <div key={i} className="skeleton h-14 w-full" />)}
            </div>
          ) : filtered.length === 0 ? (
            <div className="empty-state">
              <LuCircleAlert size={28} className="empty-state-icon" />
              <p className="text-sm">
                {search ? 'No students match your search' : 'No students found for this subject. Upload students first.'}
              </p>
            </div>
          ) : (
            <div className="space-y-2 max-h-96 overflow-y-auto pr-1">
              {filtered.map(student => {
                const present = !!attendance[student.studentId]
                const av = avatarColor(student.studentId)
                return (
                  <div
                    key={student.studentId}
                    onClick={() => toggle(student.studentId)}
                    className="flex items-center gap-3 p-3 rounded-xl border cursor-pointer transition-all select-none"
                    style={{
                      background: present ? 'var(--success-bg)' : 'var(--danger-bg)',
                      borderColor: present ? 'var(--success-border)' : 'var(--danger-border)',
                    }}
                  >
                    <div className="w-9 h-9 rounded-lg flex items-center justify-center text-xs font-bold shrink-0"
                      style={{ background: av.bg, color: av.color }}>
                      {initials(student.name)}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate" style={{ color: 'var(--text-primary)' }}>{student.name}</p>
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-mono" style={{ color: 'var(--brand-primary)' }}>Roll: {student.roll || student.studentId}</span>
                        {student.roll && <span className="text-xs font-mono" style={{ color: 'var(--text-muted)' }}>{student.studentId}</span>}
                      </div>
                    </div>
                    <div className="w-7 h-7 rounded-lg flex items-center justify-center"
                      style={{ color: present ? 'var(--success-text)' : 'var(--danger-text)' }}>
                      {present ? <LuCircleCheck size={16} /> : <LuCircleX size={16} />}
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          <div className="flex items-center justify-between pt-3" style={{ borderTop: '1px solid var(--border-soft)' }}>
            <div className="text-sm" style={{ color: 'var(--text-secondary)' }}>
              <span className="font-bold" style={{ color: 'var(--text-primary)' }}>{pct}%</span> present · {presentCount} of {students.length}
            </div>
            <button onClick={handleSave} disabled={saving || students.length === 0 || saved}
              className={saved ? 'flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold' : 'btn-primary px-5 py-2.5'}
              style={saved ? { background: 'var(--success-bg)', color: 'var(--success-text)', border: '1px solid var(--success-border)' } : {}}>
              {saving
                ? <><span className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" /> Saving…</>
                : saved
                  ? <><LuCircleCheck size={14} /> Saved!</>
                  : <><LuSave size={14} /> Save Attendance</>}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
