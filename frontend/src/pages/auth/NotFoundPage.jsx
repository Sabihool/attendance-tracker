/**
 * NotFoundPage.jsx — COLOR SYSTEM FIXED
 */
import { LuArrowLeft, LuGraduationCap, LuHouse } from 'react-icons/lu'
import { useNavigate } from 'react-router-dom'

export default function NotFound() {
  const navigate = useNavigate()
  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-6 text-center"
      style={{ background: 'var(--bg-app)' }}>
      <div className="animate-fade-in">
        <div className="w-16 h-16 rounded-2xl flex items-center justify-center mx-auto mb-6"
          style={{ background: 'var(--brand-50)', border: '2px solid var(--brand-200)' }}>
          <LuGraduationCap size={28} style={{ color: 'var(--brand-primary)' }} />
        </div>
        <p className="font-mono text-8xl font-bold mb-2" style={{ color: 'var(--border-strong)' }}>404</p>
        <h1 className="text-2xl font-bold mb-3" style={{ color: 'var(--text-primary)' }}>Page Not Found</h1>
        <p className="text-sm max-w-sm mb-8 leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
          This page doesn't exist or has been moved. Let's get you back on track.
        </p>
        <div className="flex flex-col sm:flex-row gap-3 justify-center">
          <button onClick={() => navigate(-1)} className="btn-secondary px-5 py-2.5 justify-center">
            <LuArrowLeft size={15} /> Go Back
          </button>
          <button onClick={() => navigate('/')} className="btn-primary px-5 py-2.5 justify-center">
            <LuHouse size={15} /> Home
          </button>
        </div>
      </div>
    </div>
  )
}
