const mockStudents = [
  { id: 1, name: 'Ayesha Rahman',  roll: 'CSE-2021-001', dept: 'CSE', status: 'Present', pct: 94 },
  { id: 2, name: 'Mohammed Hasan', roll: 'CSE-2021-002', dept: 'CSE', status: 'Absent',  pct: 78 },
  { id: 3, name: 'Nadia Islam',    roll: 'EEE-2021-014', dept: 'EEE', status: 'Present', pct: 89 },
  { id: 4, name: 'Rafiq Uddin',    roll: 'CSE-2021-008', dept: 'CSE', status: 'Late',    pct: 82 },
  { id: 5, name: 'Sadia Sultana',  roll: 'BBA-2021-032', dept: 'BBA', status: 'Present', pct: 96 },
]

const statusBadge = {
  Present: 'badge-present',
  Absent:  'badge-absent',
  Late:    'badge-late',
}

const barColor = { Present: '#22C55E', Absent: '#EF4444', Late: '#F59E0B' }

function Initials({ name }) {
  const i = name.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase()
  return (
    <div className="w-8 h-8 rounded-lg flex items-center justify-center text-white text-xs font-bold shrink-0"
      style={{ background: 'var(--brand-primary)' }}>
      {i}
    </div>
  )
}

export default function AttendanceTable() {
  return (
    <div className="card overflow-hidden">
      <div className="px-5 py-3.5 flex items-center justify-between" style={{ borderBottom: '1px solid var(--border)' }}>
        <p className="section-title">Today's Attendance</p>
        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
          {new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr style={{ background: 'var(--bg-muted)', borderBottom: '1px solid var(--border)' }}>
              {['Student', 'Roll No.', 'Dept', 'Attendance %', 'Status'].map(h => (
                <th key={h} className="px-5 py-2.5 text-left text-xs font-600 uppercase tracking-wider"
                  style={{ color: 'var(--text-muted)' }}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {mockStudents.map((s, idx) => (
              <tr
                key={s.id}
                className="table-row-hover"
                style={{ borderBottom: idx < mockStudents.length - 1 ? '1px solid var(--border-soft)' : 'none' }}
              >
                <td className="px-5 py-3">
                  <div className="flex items-center gap-2.5">
                    <Initials name={s.name} />
                    <span className="font-medium text-sm" style={{ color: 'var(--text-primary)' }}>{s.name}</span>
                  </div>
                </td>
                <td className="px-5 py-3 font-mono text-xs" style={{ color: 'var(--text-muted)' }}>{s.roll}</td>
                <td className="px-5 py-3">
                  <span className="badge badge-brand">{s.dept}</span>
                </td>
                <td className="px-5 py-3">
                  <div className="flex items-center gap-2">
                    <div className="h-1.5 rounded-full w-16" style={{ background: 'var(--border)' }}>
                      <div className="h-full rounded-full" style={{ width: `${s.pct}%`, background: barColor[s.status] }} />
                    </div>
                    <span className="text-xs font-mono font-semibold" style={{ color: 'var(--text-secondary)' }}>{s.pct}%</span>
                  </div>
                </td>
                <td className="px-5 py-3">
                  <span className={`badge ${statusBadge[s.status]}`}>{s.status}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
