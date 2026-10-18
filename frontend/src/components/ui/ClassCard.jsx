import { LuBookOpen, LuChevronRight, LuUsers } from 'react-icons/lu'

export default function ClassCard({ name, code, students, time, present, total }) {
  const pct = total > 0 ? Math.round((present / total) * 100) : 0
  const good = pct >= 75
  const barColor = good ? 'var(--success)' : 'var(--danger)'
  const pctColor = good ? 'var(--success-text)' : 'var(--danger-text)'

  return (
    <div
      className="card card-hover p-4 cursor-pointer group"
      onMouseEnter={e => { e.currentTarget.style.borderColor = 'rgba(109,94,247,0.30)' }}
      onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)' }}
    >
      <div className="flex items-start justify-between mb-2.5">
        <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0" style={{ background: '#F4F1FF' }}>
          <LuBookOpen size={16} style={{ color: 'var(--brand-primary)' }} />
        </div>
        <LuChevronRight size={14} style={{ color: 'var(--text-muted)' }} className="transition-colors group-hover:text-brand-primary" />
      </div>
      <p className="font-semibold text-sm mb-0.5" style={{ color: 'var(--text-primary)' }}>{name}</p>
      <p className="text-xs font-mono mb-2.5" style={{ color: 'var(--text-muted)' }}>{code}</p>
      {students != null && (
        <div className="flex items-center gap-1 text-xs mb-2.5" style={{ color: 'var(--text-muted)' }}>
          <LuUsers size={11} /><span>{students} students</span>
        </div>
      )}
      <div>
        <div className="flex justify-between text-xs mb-1">
          <span style={{ color: 'var(--text-muted)' }}>Attendance</span>
          <span className="font-semibold" style={{ color: pctColor }}>{pct}%</span>
        </div>
        <div className="h-1.5 rounded-full" style={{ background: 'var(--border)' }}>
          <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, background: barColor }} />
        </div>
      </div>
    </div>
  )
}
