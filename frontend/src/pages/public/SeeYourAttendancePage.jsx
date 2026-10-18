import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { LuArrowLeft, LuGraduationCap, LuSearch, LuTriangleAlert, LuRotateCcw } from 'react-icons/lu'
import CollegeSearchSelect from '@components/forms/CollegeSearchSelect'
import { publicAttendanceAPI } from '@services/api'
import { isCanceled, formatCollegeMeta } from '@utils/collegeSearch'
import {
  EMPTY_LOOKUP_FORM, LOOKUP_LIMITS, validateLookupForm, buildLookupPayload, lookupError, statusTone, percentTone, percentLabel,
} from '@utils/publicLookup'

/**
 * Public "See Your Attendance" — no login.
 *   1. search + choose the college (the id comes only from the chosen result)
 *   2. enter department, batch, shift and roll
 *   3. see that student's own analytics
 * Nothing is stored in the browser. The server does all scoping; this page only
 * ever displays what the whitelisted response contains.
 */
export default function SeeYourAttendancePage() {
  const [college, setCollege] = useState(null)
  const [form, setForm] = useState(EMPTY_LOOKUP_FORM)
  const [errors, setErrors] = useState({})
  const [failure, setFailure] = useState(null)
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState(null)
  const ctrlRef = useRef(null)

  useEffect(() => () => ctrlRef.current?.abort(), [])

  const resetOutcome = () => { setResult(null); setFailure(null) }

  const changeCollege = (c) => {
    ctrlRef.current?.abort()
    setLoading(false)
    setCollege(c)
    setErrors((e) => ({ ...e, college: undefined }))
    resetOutcome() // never keep one college's result on screen after switching
  }

  const setField = (name) => (e) => {
    setForm((f) => ({ ...f, [name]: e.target.value }))
    setErrors((er) => ({ ...er, [name]: undefined }))
    if (failure) setFailure(null)
  }

  const submit = async (e) => {
    e.preventDefault()
    if (loading) return
    const found = validateLookupForm(college, form)
    setErrors(found)
    if (Object.keys(found).length) return

    ctrlRef.current?.abort()
    const ctrl = new AbortController()
    ctrlRef.current = ctrl
    setLoading(true); setFailure(null); setResult(null)
    try {
      const res = await publicAttendanceAPI.lookup(buildLookupPayload(college, form), { signal: ctrl.signal })
      if (ctrl.signal.aborted) return
      setResult(res.data?.data || null)
    } catch (err) {
      if (isCanceled(err) || ctrl.signal.aborted) return
      const f = lookupError(err)
      setFailure(f)
      if (f.kind === 'invalid' && f.fields) setErrors(f.fields)
    } finally {
      if (!ctrl.signal.aborted) setLoading(false)
    }
  }

  const startOver = () => { resetOutcome(); setForm(EMPTY_LOOKUP_FORM); setErrors({}) }

  return (
    <div className="min-h-screen flex flex-col" style={{ background: 'var(--bg-app)' }}>
      <header className="flex items-center justify-between px-4 sm:px-10 h-14 shrink-0"
        style={{ background: 'var(--bg-navbar)', borderBottom: '1px solid var(--border)', boxShadow: 'var(--shadow-navbar)' }}>
        <Link to="/" className="flex items-center gap-2.5 min-w-0">
          <div className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0" style={{ background: 'var(--brand-primary)' }}>
            <LuGraduationCap size={14} className="text-white" />
          </div>
          <span className="font-bold text-sm truncate" style={{ color: 'var(--text-primary)' }}>Attendance Tracker</span>
        </Link>
        <Link to="/" className="btn-ghost text-sm"><LuArrowLeft size={14} /> Home</Link>
      </header>

      <main className="flex-1 w-full max-w-xl mx-auto px-4 py-6 sm:py-10">
        <h1 className="text-2xl sm:text-3xl font-bold mb-1.5" style={{ color: 'var(--text-primary)' }}>See Your Attendance</h1>
        <p className="text-sm mb-6" style={{ color: 'var(--text-secondary)' }}>
          No login needed. Find your college, then enter your department, batch, shift and roll.
        </p>

        {result ? (
          <Result data={result} onReset={startOver} />
        ) : (
          <form onSubmit={submit} noValidate className="card p-4 sm:p-6 space-y-4">
            <CollegeSearchSelect value={college} onChange={changeCollege} error={errors.college} disabled={loading} />

            {college && (
              <>
                <Field label="Department" name="department" value={form.department} onChange={setField('department')}
                  error={errors.department} max={LOOKUP_LIMITS.department} placeholder="e.g. Computer Science and Technology" />
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Batch" name="batch" value={form.batch} onChange={setField('batch')}
                    error={errors.batch} max={LOOKUP_LIMITS.batch} placeholder="e.g. 2024" />
                  <Field label="Shift" name="shift" value={form.shift} onChange={setField('shift')}
                    error={errors.shift} max={LOOKUP_LIMITS.shift} placeholder="e.g. Morning" />
                </div>
                <Field label="Roll" name="roll" value={form.roll} onChange={setField('roll')}
                  error={errors.roll} max={LOOKUP_LIMITS.roll} placeholder="Your roll number" />

                {failure && <FailureNotice failure={failure} />}

                <button type="submit" disabled={loading} className="btn-primary w-full justify-center py-3 text-sm">
                  {loading
                    ? <><span className="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin" /> Looking up…</>
                    : <><LuSearch size={16} /> Show my attendance</>}
                </button>
              </>
            )}
          </form>
        )}
      </main>
    </div>
  )
}

function Field({ label, name, value, onChange, error, max, placeholder }) {
  const id = `lookup-${name}`
  return (
    <div>
      <label htmlFor={id} className="form-label">{label} <span style={{ color: 'var(--danger)' }}>*</span></label>
      <input id={id} name={name} type="text" value={value} onChange={onChange} maxLength={max}
        placeholder={placeholder} autoComplete="off" autoCapitalize="none" spellCheck={false}
        aria-invalid={error ? true : undefined} aria-describedby={error ? `${id}-err` : undefined}
        className="input-field text-base sm:text-sm" style={error ? { borderColor: 'var(--danger)' } : undefined} />
      {error && <p id={`${id}-err`} className="text-xs mt-1.5" style={{ color: 'var(--danger-text)' }}>{error}</p>}
    </div>
  )
}

function FailureNotice({ failure }) {
  const soft = failure.kind === 'notfound' || failure.kind === 'ambiguous'
  return (
    <div role="alert" className="flex items-start gap-2.5 rounded-xl px-3.5 py-3 text-sm"
      style={{
        background: soft ? 'var(--warning-bg)' : 'var(--danger-bg)',
        border: `1px solid ${soft ? 'var(--warning-border)' : 'var(--danger-border)'}`,
        color: soft ? 'var(--warning-text)' : 'var(--danger-text)',
      }}>
      <LuTriangleAlert size={16} className="mt-0.5 shrink-0" />
      <span>{failure.message}</span>
    </div>
  )
}

const TONE = {
  success: ['var(--success-bg)', 'var(--success-border)', 'var(--success-text)', 'var(--success)'],
  info:    ['var(--info-bg)', 'var(--info-border)', 'var(--info-text)', 'var(--info)'],
  warning: ['var(--warning-bg)', 'var(--warning-border)', 'var(--warning-text)', 'var(--warning)'],
  danger:  ['var(--danger-bg)', 'var(--danger-border)', 'var(--danger-text)', 'var(--danger)'],
}

function Result({ data, onReset }) {
  const { college, student, academicStats: s, subjectStats } = data
  const [bg, border, text] = TONE[statusTone(s.status)]
  return (
    <div className="space-y-4">
      <div className="card p-4 sm:p-5">
        <p className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>{student.name}</p>
        <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
          Roll {student.roll} · {student.department} · {student.batch} · {student.shift}
        </p>
        <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
          {college.name}{formatCollegeMeta(college) ? ` — ${formatCollegeMeta(college)}` : ''}
        </p>
      </div>

      <div className="card p-4 sm:p-5 flex items-center justify-between gap-3">
        <div>
          <p className="text-4xl font-bold leading-none" style={{ color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>
            {percentLabel(s.overallPercentage)}
          </p>
          <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>Overall attendance</p>
        </div>
        <span className="text-sm font-bold px-3 py-1.5 rounded-full" style={{ background: bg, color: text, border: `1px solid ${border}` }}>
          {s.status}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Stat label="Classes held" value={s.totalClasses} />
        <Stat label="Attended" value={s.totalAttended} />
        <Stat label="Missed" value={s.totalMissed} />
        <Stat label="Credit score" value={s.creditScore} />
      </div>

      {s.totalClasses === 0 && (
        <p className="text-sm text-center py-2" style={{ color: 'var(--text-muted)' }}>
          No classes have been recorded for you yet.
        </p>
      )}

      {subjectStats.length > 0 && (
        <div className="card p-4 sm:p-5">
          <h2 className="text-sm font-semibold mb-3" style={{ color: 'var(--text-primary)' }}>By subject</h2>
          <ul className="space-y-4">
            {subjectStats.map((sub) => (
              <li key={`${sub.subjectCode}-${sub.subjectName}`}>
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-sm font-medium min-w-0 truncate" style={{ color: 'var(--text-primary)' }}>
                    {sub.subjectName} <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{sub.subjectCode}</span>
                  </span>
                  <span className="text-sm font-bold shrink-0" style={{ color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>
                    {percentLabel(sub.attendancePercentage)}
                  </span>
                </div>
                <div className="h-2 rounded-full mt-1.5 overflow-hidden" style={{ background: 'var(--bg-muted)' }}
                  role="progressbar" aria-valuenow={sub.attendancePercentage} aria-valuemin={0} aria-valuemax={100}
                  aria-label={`${sub.subjectName} attendance`}>
                  <div className="h-full rounded-full"
                    style={{ width: `${Math.min(100, sub.attendancePercentage)}%`, background: TONE[percentTone(sub.attendancePercentage)][3] }} />
                </div>
                <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                  {sub.attended} attended · {sub.missed} missed · {sub.totalClasses} classes
                </p>
              </li>
            ))}
          </ul>
        </div>
      )}

      {s.creditScoreBreakdown?.length > 0 && (
        <div className="card p-4 sm:p-5">
          <h2 className="text-sm font-semibold mb-3" style={{ color: 'var(--text-primary)' }}>Credit score breakdown</h2>
          <div className="grid grid-cols-2 gap-3">
            {s.creditScoreBreakdown.map((c) => (
              <div key={c.category} className="rounded-xl px-3.5 py-3" style={{ background: 'var(--bg-muted)' }}>
                <p className="text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>{c.category}</p>
                <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>{c.attendedClasses} × {c.creditValue}</p>
                <p className="text-sm font-bold mt-1" style={{ color: 'var(--brand-primary)' }}>+{c.pointsEarned} pts</p>
              </div>
            ))}
          </div>
        </div>
      )}

      <button type="button" onClick={onReset} className="btn-secondary w-full justify-center py-3 text-sm">
        <LuRotateCcw size={15} /> Look up another student
      </button>
    </div>
  )
}

function Stat({ label, value }) {
  return (
    <div className="card p-4">
      <p className="text-2xl font-bold leading-none" style={{ color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>{value}</p>
      <p className="text-xs mt-1.5" style={{ color: 'var(--text-muted)' }}>{label}</p>
    </div>
  )
}
