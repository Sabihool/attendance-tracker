import { LuEye, LuEyeOff, LuLogIn } from 'react-icons/lu'
import { useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'

import toast from 'react-hot-toast'
import { useAuth } from '@context/AuthContext'

export default function Login() {
  const navigate = useNavigate()
  const { login } = useAuth()
  const [email, setEmail]       = useState('')
  const [password, setPassword] = useState('')
  const [showPw, setShowPw]     = useState(false)
  const [loading, setLoading]   = useState(false)
  const [error, setError]       = useState('')
  const [errorCode, setErrorCode] = useState('')

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError(''); setErrorCode('')
    if (!email.trim() || !password.trim()) { setError('Please fill in all fields.'); return }
    setLoading(true)
    const result = await login(email.trim(), password)
    setLoading(false)
    if (!result.success) { setError(result.error); setErrorCode(result.code || ''); return }
    toast.success(`Welcome back, ${result.user.name}!`)
    navigate(result.user.role === 'admin' ? '/admin' : '/teacher')
  }

  return (
    <div
      className="min-h-screen flex items-center justify-center px-4 py-10"
      style={{ background: 'var(--bg-app)' }}
    >
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="text-center mb-7">
          <div
            className="w-12 h-12 rounded-2xl flex items-center justify-center mx-auto mb-4"
            style={{ background: 'var(--brand-primary)', boxShadow: '0 6px 20px rgba(109,94,247,0.30)' }}
          >
            <LuLogIn size={22} className="text-white" />
          </div>
          <h1 className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>Sign In</h1>
          <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>Access your Attendance Tracker</p>
        </div>

        {/* Card */}
        <div className="card p-6">
          <form onSubmit={handleSubmit} className="space-y-4">
            {error && (
              <div role="alert" className="text-sm rounded-xl px-3.5 py-2.5"
                style={errorCode === 'ACCOUNT_PENDING' || errorCode === 'COLLEGE_UNAVAILABLE'
                  ? { background: 'var(--warning-bg)', border: '1px solid var(--warning-border)', color: 'var(--warning-text)' }
                  : { background: 'var(--danger-bg)', border: '1px solid var(--danger-border)', color: 'var(--danger-text)' }}>
                {error}
              </div>
            )}

            <div>
              <label className="block text-xs font-600 mb-1.5" style={{ color: 'var(--text-secondary)' }}>Email</label>
              <input
                type="email" value={email} onChange={e => setEmail(e.target.value)}
                placeholder="you@example.com" className="input-field"
              />
            </div>

            <div>
              <label className="block text-xs font-600 mb-1.5" style={{ color: 'var(--text-secondary)' }}>Password</label>
              <div className="relative">
                <input
                  type={showPw ? 'text' : 'password'}
                  value={password} onChange={e => setPassword(e.target.value)}
                  placeholder="••••••••" className="input-field pr-10"
                />
                <button type="button" onClick={() => setShowPw(p => !p)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 transition-colors"
                  style={{ color: 'var(--text-muted)' }}>
                  {showPw ? <LuEyeOff size={15} /> : <LuEye size={15} />}
                </button>
              </div>
            </div>

            <button
              type="submit" disabled={loading}
              className="btn-primary w-full justify-center py-2.5 disabled:opacity-60 disabled:cursor-not-allowed"
              style={{ borderRadius: '10px', fontSize: '0.875rem' }}
            >
              {loading
                ? <><span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />Signing in…</>
                : <><LuLogIn size={15} />Sign In</>
              }
            </button>
          </form>

          <p className="text-center text-sm mt-4" style={{ color: 'var(--text-muted)' }}>
            Don't have an account?{' '}
            <Link to="/signup" className="font-semibold" style={{ color: 'var(--brand-primary)' }}>Create one</Link>
          </p>
          <p className="text-center text-xs mt-2" style={{ color: 'var(--text-muted)' }}>
            New institution?{' '}
            <Link to="/register-college" style={{ color: 'var(--brand-primary)' }}>Register your college</Link>
          </p>
        </div>

        <p className="text-center text-xs mt-5" style={{ color: 'var(--text-muted)' }}>
          <Link to="/" style={{ color: 'var(--text-muted)' }}>← Back to Home</Link>
        </p>
      </div>
    </div>
  )
}
