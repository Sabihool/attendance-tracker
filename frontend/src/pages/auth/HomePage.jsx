import { LuArrowRight, LuChartBar, LuCircleCheck, LuGraduationCap, LuShield, LuUsers } from 'react-icons/lu'
import { useNavigate } from 'react-router-dom'

const features = [
  { icon: LuCircleCheck, title: 'Smart Attendance', desc: 'Mark in seconds with an intuitive interface.' },
  { icon: LuChartBar,    title: 'Rich Analytics',   desc: 'Visualize trends with detailed charts and exports.' },
  { icon: LuUsers,        title: 'Multi-Role Access', desc: 'Separate portals for teachers and admins.' },
  { icon: LuShield,       title: 'Secure & Reliable', desc: 'Institutional data, safe and backed up.' },
]

export default function Home() {
  const navigate = useNavigate()

  return (
    <div className="min-h-screen flex flex-col" style={{ background: 'var(--bg-app)' }}>

      {/* Navbar */}
      <header
        className="flex items-center justify-between px-6 sm:px-10 h-14 shrink-0"
        style={{ background: 'var(--bg-navbar)', borderBottom: '1px solid var(--border)', boxShadow: 'var(--shadow-navbar)' }}
      >
        <div className="flex items-center gap-2.5">
          <div className="w-7 h-7 rounded-lg flex items-center justify-center" style={{ background: 'var(--brand-primary)' }}>
            <LuGraduationCap size={14} className="text-white" />
          </div>
          <span className="font-bold text-sm" style={{ color: 'var(--text-primary)' }}>Attendance Tracker</span>
          <span className="hidden sm:block text-xs" style={{ color: 'var(--text-muted)' }}>by Sabihool</span>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => navigate('/see-attendance')} className="btn-ghost text-sm hidden sm:inline-flex">See Your Attendance</button>
          <button onClick={() => navigate('/login')} className="btn-ghost text-sm">Sign In</button>
          <button onClick={() => navigate('/register-college')} className="btn-primary text-sm">Register Your College</button>
        </div>
      </header>

      {/* Hero */}
      <main className="flex-1 flex flex-col items-center justify-center px-6 py-14 text-center">
        {/* Tag */}
        <div
          className="inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-full mb-6"
          style={{ background: 'var(--brand-50)', color: 'var(--brand-primary)', border: '1px solid var(--brand-200)' }}
        >
          🎓 Attendance Management System
        </div>

        <h1 className="text-4xl sm:text-5xl font-bold mb-5 max-w-2xl leading-tight" style={{ color: 'var(--text-primary)' }}>
          Track Attendance,{' '}
          <span style={{ color: 'var(--brand-primary)' }}>Empower Education</span>
        </h1>

        <p className="text-base max-w-lg mb-8 leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
          A modern attendance system built for colleges and universities.
          Effortless for teachers, insightful for admins.
        </p>

        <div className="flex flex-col sm:flex-row gap-3 mb-14">
          <button
            onClick={() => navigate('/teacher')}
            className="btn-primary px-7 py-3 text-sm"
            style={{ borderRadius: '10px', fontSize: '0.9rem' }}
          >
            Teacher Portal <LuArrowRight size={16} />
          </button>
          <button
            onClick={() => navigate('/admin')}
            className="btn-secondary px-7 py-3 text-sm"
            style={{ borderRadius: '10px', fontSize: '0.9rem' }}
          >
            Admin Portal <LuArrowRight size={16} />
          </button>
          <button
            onClick={() => navigate('/see-attendance')}
            className="btn-secondary px-7 py-3 text-sm"
            style={{ borderRadius: '10px', fontSize: '0.9rem' }}
          >
            See Your Attendance <LuArrowRight size={16} />
          </button>
        </div>

        {/* Features */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 max-w-4xl w-full">
          {features.map(({ icon: Icon, title, desc }) => (
            <div
              key={title}
              className="card card-hover text-left p-5"
            >
              <div className="w-9 h-9 rounded-xl flex items-center justify-center mb-3" style={{ background: 'var(--brand-50)' }}>
                <Icon size={17} style={{ color: 'var(--brand-primary)' }} />
              </div>
              <p className="font-semibold text-sm mb-1" style={{ color: 'var(--text-primary)' }}>{title}</p>
              <p className="text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>{desc}</p>
            </div>
          ))}
        </div>
      </main>

      <footer className="text-center py-4 text-xs" style={{ color: 'var(--text-muted)', borderTop: '1px solid var(--border)' }}>
        © {new Date().getFullYear()} Attendance Tracker by Sabihool. All rights reserved.
      </footer>
    </div>
  )
}
