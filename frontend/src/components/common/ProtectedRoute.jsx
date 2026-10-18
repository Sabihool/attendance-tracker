import { Navigate } from 'react-router-dom'
import { useAuth } from '@context/AuthContext'

export default function ProtectedRoute({ children, allowedRole }) {
  const { user, loading, isAuthenticated } = useAuth()

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: 'var(--bg-app)' }}>
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-2 rounded-full animate-spin"
            style={{ borderColor: 'var(--brand-primary)', borderTopColor: 'transparent' }} />
          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Loading…</p>
        </div>
      </div>
    )
  }

  if (!isAuthenticated) return <Navigate to="/login" replace />

  // Defence in depth only — the server enforces this on every request.
  if (user?.role === 'teacher' && user?.approved !== true) return <Navigate to="/login" replace />

  if (allowedRole && user?.role !== allowedRole) {
    return <Navigate to={user?.role === 'admin' ? '/admin' : '/teacher'} replace />
  }

  return children
}
