import { LuEye, LuEyeOff, LuBuilding2 } from 'react-icons/lu'
import { useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import toast from 'react-hot-toast'
import { useAuth } from '@context/AuthContext'
import { validateCollegeForm } from '@utils/collegeValidation'

const COUNTRY_SUGGESTIONS = [
  'Bangladesh', 'India', 'Pakistan', 'Nepal', 'Sri Lanka', 'Bhutan', 'Maldives',
  'United Kingdom', 'United States', 'Canada', 'Australia', 'Malaysia', 'Singapore',
  'United Arab Emirates', 'Saudi Arabia', 'Qatar', 'Kuwait',
]

const EMPTY = {
  collegeName: '', country: '', district: '',
  adminName: '', adminEmail: '', password: '', confirmPassword: '',
}

export default function RegisterCollegePage() {
  const navigate = useNavigate()
  const { registerCollege } = useAuth()
  const [form, setForm]       = useState(EMPTY)
  const [errors, setErrors]   = useState({})
  const [showPw, setShowPw]   = useState(false)
  const [loading, setLoading] = useState(false)
  const [formError, setFormError] = useState('')

  const set = (k) => (e) => {
    setForm((f) => ({ ...f, [k]: e.target.value }))
    if (errors[k]) setErrors((er) => ({ ...er, [k]: undefined }))
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    setFormError('')
    const v = validateCollegeForm(form)
    setErrors(v)
    if (Object.keys(v).length) return

    setLoading(true)
    const result = await registerCollege(form)
    setLoading(false)
    if (!result.success) {
      if (result.fieldErrors) setErrors(result.fieldErrors)
      setFormError(result.error)
      return
    }
    toast.success(`${result.college.name} is ready. Welcome, ${result.user.name}!`)
    navigate('/admin')
  }

  const field = (key, label, props = {}) => (
    <div key={key}>
      <label htmlFor={key} className="block text-xs font-600 mb-1.5" style={{ color: 'var(--text-secondary)' }}>{label}</label>
      <input
        id={key} value={form[key]} onChange={set(key)} className="input-field"
        aria-invalid={!!errors[key]} aria-describedby={errors[key] ? `${key}-err` : undefined}
        style={errors[key] ? { borderColor: 'var(--danger-border)' } : undefined}
        {...props}
      />
      {errors[key] && (
        <p id={`${key}-err`} className="text-xs mt-1" style={{ color: 'var(--danger-text)' }}>{errors[key]}</p>
      )}
    </div>
  )

  const passwordField = (key, label, withToggle) => (
    <div key={key}>
      <label htmlFor={key} className="block text-xs font-600 mb-1.5" style={{ color: 'var(--text-secondary)' }}>{label}</label>
      <div className="relative">
        <input
          id={key} type={showPw ? 'text' : 'password'} value={form[key]} onChange={set(key)}
          placeholder="••••••••" className="input-field pr-10" autoComplete="new-password"
          aria-invalid={!!errors[key]} aria-describedby={errors[key] ? `${key}-err` : undefined}
          style={errors[key] ? { borderColor: 'var(--danger-border)' } : undefined}
        />
        {withToggle && (
          <button type="button" onClick={() => setShowPw((p) => !p)}
            aria-label={showPw ? 'Hide passwords' : 'Show passwords'}
            className="absolute right-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-muted)' }}>
            {showPw ? <LuEyeOff size={15} /> : <LuEye size={15} />}
          </button>
        )}
      </div>
      {errors[key] && (
        <p id={`${key}-err`} className="text-xs mt-1" style={{ color: 'var(--danger-text)' }}>{errors[key]}</p>
      )}
    </div>
  )

  return (
    <div className="min-h-screen flex items-center justify-center px-4 py-10" style={{ background: 'var(--bg-app)' }}>
      <div className="w-full max-w-md">
        <div className="text-center mb-7">
          <div className="w-12 h-12 rounded-2xl flex items-center justify-center mx-auto mb-4"
            style={{ background: 'var(--brand-primary)', boxShadow: '0 6px 20px rgba(109,94,247,0.30)' }}>
            <LuBuilding2 size={22} className="text-white" />
          </div>
          <h1 className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>Register Your College</h1>
          <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>
            Create your institution&apos;s account · you become its administrator
          </p>
        </div>

        <div className="card p-6">
          <form onSubmit={handleSubmit} noValidate className="space-y-3.5">
            {formError && (
              <div role="alert" className="text-sm rounded-xl px-3.5 py-2.5"
                style={{ background: 'var(--danger-bg)', border: '1px solid var(--danger-border)', color: 'var(--danger-text)' }}>
                {formError}
              </div>
            )}

            <p className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>Institution</p>
            {field('collegeName', 'College Name', { type: 'text', placeholder: 'e.g. Feni Computer Institute', maxLength: 120, autoComplete: 'organization' })}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
              {field('country', 'Country', { type: 'text', placeholder: 'Bangladesh', list: 'country-list', maxLength: 80, autoComplete: 'country-name' })}
              {field('district', 'District', { type: 'text', placeholder: 'Feni', maxLength: 80 })}
            </div>
            <datalist id="country-list">
              {COUNTRY_SUGGESTIONS.map((c) => <option key={c} value={c} />)}
            </datalist>

            <p className="text-xs font-semibold uppercase tracking-wide pt-1" style={{ color: 'var(--text-muted)' }}>Administrator</p>
            {field('adminName', 'Admin Name', { type: 'text', placeholder: 'Full name', maxLength: 100, autoComplete: 'name' })}
            {field('adminEmail', 'Admin Email', { type: 'email', placeholder: 'admin@yourcollege.edu', maxLength: 254, autoComplete: 'email' })}
            {passwordField('password', 'Password', true)}
            <p className="text-xs -mt-2" style={{ color: 'var(--text-muted)' }}>
              At least 8 characters, with a letter and a number.
            </p>
            {passwordField('confirmPassword', 'Confirm Password', false)}

            <button type="submit" disabled={loading}
              className="btn-primary w-full justify-center py-2.5 disabled:opacity-60 disabled:cursor-not-allowed"
              style={{ borderRadius: '10px', fontSize: '0.875rem', marginTop: '4px' }}>
              {loading
                ? <><span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />Creating…</>
                : <><LuBuilding2 size={15} />Create College Account</>}
            </button>
          </form>

          <p className="text-center text-sm mt-4" style={{ color: 'var(--text-muted)' }}>
            Already registered?{' '}
            <Link to="/login" className="font-semibold" style={{ color: 'var(--brand-primary)' }}>Sign in</Link>
          </p>
          <p className="text-center text-xs mt-2" style={{ color: 'var(--text-muted)' }}>
            Teacher? <Link to="/signup" style={{ color: 'var(--brand-primary)' }}>Create a teacher account</Link>
          </p>
        </div>

        <p className="text-center text-xs mt-5">
          <Link to="/" style={{ color: 'var(--text-muted)' }}>← Back to Home</Link>
        </p>
      </div>
    </div>
  )
}
