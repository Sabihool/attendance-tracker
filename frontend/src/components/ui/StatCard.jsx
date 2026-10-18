import { LuMinus, LuTrendingDown, LuTrendingUp } from 'react-icons/lu'

const palette = {
  brand:  { iconBg: '#F4F1FF', iconColor: '#6D5EF7' },
  green:  { iconBg: '#F0FDF4', iconColor: '#16A34A' },
  amber:  { iconBg: '#FFFBEB', iconColor: '#D97706' },
  red:    { iconBg: '#FEF2F2', iconColor: '#DC2626' },
  purple: { iconBg: '#FAF5FF', iconColor: '#9333EA' },
}

export default function StatCard({ title, value, subtitle, icon: Icon, color = 'brand', trend, trendValue }) {
  const c = palette[color] || palette.brand
  const TrendIcon = trend === 'up' ? LuTrendingUp : trend === 'down' ? LuTrendingDown : LuMinus
  const trendColor = trend === 'up' ? '#16A34A' : trend === 'down' ? '#DC2626' : '#9CA3AF'

  return (
    <div className="stat-card card-hover">
      <div className="flex items-start justify-between mb-3">
        <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0"
          style={{ background: c.iconBg }}>
          <Icon size={17} style={{ color: c.iconColor }} />
        </div>
        {trend && trendValue && (
          <div className="flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-full"
            style={{ color: trendColor, background: `${trendColor}18` }}>
            <TrendIcon size={10} />
            <span>{trendValue}</span>
          </div>
        )}
      </div>
      <p className="text-2xl font-bold mb-0.5 leading-none" style={{ color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>
        {value}
      </p>
      <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{title}</p>
      {subtitle && <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>{subtitle}</p>}
    </div>
  )
}
