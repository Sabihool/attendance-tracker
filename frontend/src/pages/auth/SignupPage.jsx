import { LuEye, LuEyeOff, LuUserPlus, LuMailCheck } from 'react-icons/lu'
import { useState } from 'react'
import { Link } from 'react-router-dom'

import toast from 'react-hot-toast'
import { useAuth } from '@context/AuthContext'
import CollegeSearchSelect from '@components/forms/CollegeSearchSelect'
import { isValidSelection } from '@utils/collegeSearch'

const DEPARTMENTS = [
  'Computer Science & Technology',
  'telecommunication Engineering',
]

export default function Signup() {
  const { signup } = useAuth()
  const [form, setForm]       = useState({ name: '', email: '', password: '', confirmPassword: '', department: '', phone: '' })
  const [showPw, setShowPw]   = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError]     = useState('')
  const [college, setCollege] = useState(null)       // chosen from search results only
  const [collegeError, setCollegeError] = useState('')
  const [submitted, setSubmitted] = useState(null)    // { collegeName, email } after a successful request

  const set = k => e => setForm(f => ({ ...f, [k]: e.target.value }))

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError(''); setCollegeError('')
    if (!isValidSelection(college)) {
      setCollegeError('Please search for your college and select it from the list.'); return
    }
    if (!form.name.trim() || !form.email.trim() || !form.password || !form.department) {
      setError('Please fill in all required fields.'); return
    }
    if (form.password.length < 6) { setError('Password must be at least 6 characters.'); return }
    if (form.password !== form.confirmPassword) { setError('Passwords do not match.'); return }
    setLoading(true)
    const result = await signup({ name: form.name, email: form.email, password: form.password, role: 'teacher', collegeId: college.collegeId, department: form.department, phone: form.phone })
    setLoading(false)
    if (!result.success) {
      if (result.fieldErrors?.collegeId) setCollegeError(result.fieldErrors.collegeId)
      else setError(result.error)
      return
    }
    toast.success('Request sent for approval.')
    setSubmitted({ collegeName: result.college?.name || college.name, email: form.email.trim() })
  }

  if (submitted) {
    return (
      <div className="min-h-screen flex items-center justify-center px-4 py-10" style={{ background: 'var(--bg-app)' }}>
        <div className="w-full max-w-sm text-center">
          <div className="card p-6" role="status">
            <div className="w-12 h-12 rounded-2xl flex items-center justify-center mx-auto mb-4"
              style={{ background: 'var(--success-bg)', border: '1px solid var(--success-border)' }}>
              <LuMailCheck size={22} style={{ color: 'var(--success-text)' }} />
            </div>
            <h1 className="text-xl font-bold" style={{ color: 'var(--text-primary)' }}>Request sent</h1>
            <p className="text-sm mt-2" style={{ color: 'var(--text-secondary)' }}>
              Your account for <strong>{submitted.collegeName}</strong> is waiting for approval by that college's administrator.
            </p>
            <p className="text-xs mt-3" style={{ color: 'var(--text-muted)' }}>
              You won't be able to sign in until it is approved. Use <strong>{submitted.email}</strong> and your password once you are.
            </p>
            <Link to="/login" className="btn-primary w-full justify-center py-2.5 mt-5 inline-flex"
              style={{ borderRadius: '10px', fontSize: '0.875rem' }}>
              Go to Sign In
            </Link>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4 py-10" style={{ background: 'var(--bg-app)' }}>
      <div className="w-full max-w-sm">
        <div className="text-center mb-7">
          <div className="w-12 h-12 rounded-2xl flex items-center justify-center mx-auto mb-4"
            style={{ background: 'var(--brand-primary)', boxShadow: '0 6px 20px rgba(109,94,247,0.30)' }}>
            <LuUserPlus size={22} className="text-white" />
          </div>
          <h1 className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>Create Account</h1>
          <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>Register as teacher · admin approval required</p>
        </div>

        <div className="card p-6">
          <form onSubmit={handleSubmit} className="space-y-3.5">
            {error && (
              <div className="text-sm rounded-xl px-3.5 py-2.5"
                style={{ background: 'var(--danger-bg)', border: '1px solid var(--danger-border)', color: 'var(--danger-text)' }}>
                {error}
              </div>
            )}

            <CollegeSearchSelect
              value={college}
              onChange={(c) => { setCollege(c); if (c) setCollegeError('') }}
              error={collegeError}
            />

            {[
              { key: 'name',  label: 'Full Name',       type: 'text',  placeholder: 'John Doe' },
              { key: 'email', label: 'Email',            type: 'email', placeholder: 'you@example.com' },
              { key: 'phone', label: 'Phone (Optional)', type: 'tel',   placeholder: '+880 1700-000000' },
            ].map(({ key, label, type, placeholder }) => (
              <div key={key}>
                <label className="block text-xs font-600 mb-1.5" style={{ color: 'var(--text-secondary)' }}>{label}</label>
                <input type={type} value={form[key]} onChange={set(key)} placeholder={placeholder} className="input-field" />
              </div>
            ))}

            <div>
              <label className="block text-xs font-600 mb-1.5" style={{ color: 'var(--text-secondary)' }}>Department</label>
              <select value={form.department} onChange={set('department')} className="input-field" style={{ cursor: 'pointer' }}>
                <option value="">Select department…</option>
                {DEPARTMENTS.map(d => <option key={d} value={d}>{d}</option>)}
              </select>
            </div>

            {['password', 'confirmPassword'].map(key => (
              <div key={key}>
                <label className="block text-xs font-600 mb-1.5" style={{ color: 'var(--text-secondary)' }}>
                  {key === 'password' ? 'Password' : 'Confirm Password'}
                </label>
                <div className="relative">
                  <input
                    type={showPw ? 'text' : 'password'}
                    value={form[key]} onChange={set(key)}
                    placeholder="••••••••" className="input-field pr-10"
                  />
                  {key === 'password' && (
                    <button type="button" onClick={() => setShowPw(p => !p)}
                      className="absolute right-3 top-1/2 -translate-y-1/2"
                      style={{ color: 'var(--text-muted)' }}>
                      {showPw ? <LuEyeOff size={15} /> : <LuEye size={15} />}
                    </button>
                  )}
                </div>
              </div>
            ))}

            <button
              type="submit" disabled={loading}
              className="btn-primary w-full justify-center py-2.5 disabled:opacity-60 disabled:cursor-not-allowed"
              style={{ borderRadius: '10px', fontSize: '0.875rem', marginTop: '4px' }}
            >
              {loading
                ? <><span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />Creating…</>
                : <><LuUserPlus size={15} />Create Account</>
              }
            </button>
          </form>

          <p className="text-center text-sm mt-4" style={{ color: 'var(--text-muted)' }}>
            Already have an account?{' '}
            <Link to="/login" className="font-semibold" style={{ color: 'var(--brand-primary)' }}>Sign in</Link>
          </p>
        </div>

        <p className="text-center text-xs mt-5">
          <Link to="/" style={{ color: 'var(--text-muted)' }}>← Back to Home</Link>
        </p>
      </div>
    </div>
  )
}
