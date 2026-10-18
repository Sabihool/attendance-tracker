export default function Footer() {
  return (
    <footer
      className="flex items-center px-5 shrink-0"
      style={{
        height: '40px',
        background: 'var(--bg-card)',
        borderTop: '1px solid var(--border)',
      }}
    >
      <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
        Attendance Tracker by Sabihool · © {new Date().getFullYear()}
      </span>
      <span className="ml-auto text-xs" style={{ color: 'var(--text-muted)' }}>
        React + Vite
      </span>
    </footer>
  )
}
