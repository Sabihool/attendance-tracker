/**
 * AdminSettingsPage.jsx
 * Centralized Admin Settings (spec section 10).
 *
 * Department / Shift / Attendance Category management each already have
 * their own dedicated pages (linked below). This page covers the two
 * settings that don't: the consecutive-absence alert threshold, and a
 * read-only view of the batch data currently on file (sourced only from
 * admin-uploaded student data — see spec section 9).
 */
import { LuBell, LuBuilding2, LuClock, LuAward, LuLayers, LuLoaderCircle, LuSave, LuSettings } from 'react-icons/lu'
import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'

import { settingsAPI, studentAPI, getErrorMessage } from '@services/api'
import { ROUTES } from '@constants/app'
import toast from 'react-hot-toast'

function SettingsLinkCard({ to, icon: Icon, title, description }) {
  return (
    <Link to={to} className="card p-5 flex items-start gap-4 transition-all hover:shadow-sm"
      style={{ borderColor: 'var(--border)' }}>
      <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
        style={{ background: 'var(--brand-50)', border: '1px solid var(--brand-200)' }}>
        <Icon size={17} style={{ color: 'var(--brand-primary)' }} />
      </div>
      <div>
        <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{title}</p>
        <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>{description}</p>
      </div>
    </Link>
  )
}

export default function AdminSettingsPage() {
  const [limit, setLimit]         = useState('3')
  const [loading, setLoading]     = useState(true)
  const [saving, setSaving]       = useState(false)
  const [groups, setGroups]       = useState([])
  const [groupsLoading, setGroupsLoading] = useState(true)

  useEffect(() => {
    settingsAPI.get()
      .then(res => setLimit(String(res.data?.data?.settings?.consecutiveAbsenceLimit ?? 3)))
      .catch(err => toast.error(getErrorMessage(err)))
      .finally(() => setLoading(false))

    studentAPI.getGroups()
      .then(res => setGroups(res.data?.data?.groups || []))
      .catch(() => {})
      .finally(() => setGroupsLoading(false))
  }, [])

  const handleSave = async () => {
    const n = Number(limit)
    if (!Number.isInteger(n) || n < 1 || n > 100) {
      toast.error('Consecutive absence limit must be a whole number between 1 and 100')
      return
    }
    setSaving(true)
    try {
      await settingsAPI.update({ consecutiveAbsenceLimit: n })
      toast.success('Settings saved — applies to every subject immediately')
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-6 p-4 sm:p-6 max-w-4xl mx-auto">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
          <LuSettings size={22} style={{ color: 'var(--brand-primary)' }} /> Admin Settings
        </h1>
        <p className="text-sm mt-0.5" style={{ color: 'var(--text-muted)' }}>
          System-wide configuration. Changes apply everywhere immediately.
        </p>
      </div>

      {/* Quick links to the other settings areas */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <SettingsLinkCard to={ROUTES.ADMIN_DEPARTMENTS} icon={LuBuilding2}
          title="Departments" description="Add, edit, or remove departments" />
        <SettingsLinkCard to={ROUTES.ADMIN_SHIFTS} icon={LuClock}
          title="Shifts" description="Add, edit, or remove shifts" />
        <SettingsLinkCard to={ROUTES.ADMIN_ATTENDANCE_CATEGORIES} icon={LuAward}
          title="Attendance Categories" description="Manage categories and credit values" />
      </div>

      {/* Consecutive absence alert threshold */}
      <div className="card p-6 space-y-4">
        <div className="flex items-center gap-2">
          <LuBell size={16} style={{ color: 'var(--warning-text)' }} />
          <h2 className="text-base font-bold" style={{ color: 'var(--text-primary)' }}>Consecutive Absence Alerts</h2>
        </div>
        <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
          Teachers are automatically alerted once a student misses this many classes in a row, in any single subject.
        </p>
        {loading ? (
          <div className="skeleton h-11 w-40" />
        ) : (
          <div className="flex items-end gap-3 flex-wrap">
            <div>
              <label className="form-label">Consecutive absences before alert</label>
              <input
                type="number" min="1" max="100"
                value={limit}
                onChange={e => setLimit(e.target.value)}
                className="input-field w-32"
              />
            </div>
            <button onClick={handleSave} disabled={saving} className="btn-primary disabled:opacity-50">
              {saving ? <LuLoaderCircle size={14} className="animate-spin" /> : <LuSave size={14} />}
              Save
            </button>
          </div>
        )}
      </div>

      {/* Batch data viewer (spec section 9: batches come only from uploaded data) */}
      <div className="card overflow-hidden">
        <div className="px-5 py-4 flex items-center gap-2" style={{ borderBottom: '1px solid var(--border)' }}>
          <LuLayers size={15} style={{ color: 'var(--brand-primary)' }} />
          <h2 className="text-base font-bold" style={{ color: 'var(--text-primary)' }}>Batch Data on File</h2>
          <span className="ml-auto text-xs" style={{ color: 'var(--text-muted)' }}>
            {groups.length} group{groups.length !== 1 ? 's' : ''}
          </span>
        </div>
        <p className="px-5 pt-4 text-xs" style={{ color: 'var(--text-muted)' }}>
          Read-only. Every batch shown here comes directly from an admin-uploaded student file — nothing is generated automatically.
        </p>
        {groupsLoading ? (
          <div className="p-5 space-y-2">{[1, 2, 3].map(i => <div key={i} className="skeleton h-10 w-full" />)}</div>
        ) : groups.length === 0 ? (
          <div className="p-8 text-center text-sm" style={{ color: 'var(--text-muted)' }}>
            No student data uploaded yet.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border)' }}>
                  {['Department', 'Batch', 'Shift', 'Students'].map(h => (
                    <th key={h} className="text-left px-5 py-3 table-header">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {groups.map((g, idx) => (
                  <tr key={`${g.department}-${g.batch}-${g.shift}`} className="table-row-hover"
                    style={{ borderBottom: idx < groups.length - 1 ? '1px solid var(--border-soft)' : 'none' }}>
                    <td className="px-5 py-3" style={{ color: 'var(--text-primary)' }}>{g.department}</td>
                    <td className="px-5 py-3 font-mono" style={{ color: 'var(--text-secondary)' }}>{g.batch}</td>
                    <td className="px-5 py-3" style={{ color: 'var(--text-secondary)' }}>{g.shift}</td>
                    <td className="px-5 py-3 font-mono font-semibold" style={{ color: 'var(--brand-primary)' }}>{g.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
