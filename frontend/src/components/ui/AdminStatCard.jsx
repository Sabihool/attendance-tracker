const palette = {
  brand:  { iconBg: '#F4F1FF', iconColor: '#6D5EF7', valueColor: '#6D5EF7' },
  amber:  { iconBg: '#FFFBEB', iconColor: '#D97706', valueColor: '#D97706' },
  purple: { iconBg: '#FAF5FF', iconColor: '#9333EA', valueColor: '#9333EA' },
  green:  { iconBg: '#F0FDF4', iconColor: '#16A34A', valueColor: '#16A34A' },
  rose:   { iconBg: '#FEF2F2', iconColor: '#DC2626', valueColor: '#DC2626' },
}

const ICONS = {
  GraduationCap: () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 10v6M2 10l10-5 10 5-10 5z"/><path d="M6 12v5c3 3 9 3 12 0v-5"/>
    </svg>
  ),
  Clock: () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
    </svg>
  ),
  Building2: () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18Z"/><path d="M6 12H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2"/><path d="M18 9h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2"/><path d="M10 6h4"/><path d="M10 10h4"/><path d="M10 14h4"/><path d="M10 18h4"/>
    </svg>
  ),
  BookOpen: () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>
    </svg>
  ),
}

export default function AdminStatCard({ title, value, subtitle, icon, color = 'brand', trendValue, pulse }) {
  const c = palette[color] || palette.brand
  const IconComp = ICONS[icon]

  return (
    <div className="stat-card card-hover">
      <div className="flex items-start justify-between mb-3">
        <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0 relative"
          style={{ background: c.iconBg, color: c.iconColor }}>
          {pulse && <span className="absolute inset-0 rounded-xl animate-ping opacity-25" style={{ background: c.iconColor }} />}
          {IconComp ? <IconComp /> : null}
        </div>
        {trendValue && (
          <span className="text-xs font-semibold px-2 py-0.5 rounded-full"
            style={{ color: c.iconColor, background: c.iconBg }}>
            {trendValue}
          </span>
        )}
      </div>
      <p className="text-2xl font-bold leading-none mb-1" style={{ color: c.valueColor, fontVariantNumeric: 'tabular-nums' }}>
        {value}
      </p>
      <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{title}</p>
      {subtitle && <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>{subtitle}</p>}
    </div>
  )
}
