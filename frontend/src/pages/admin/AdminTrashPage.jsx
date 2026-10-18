/**
 * AdminTrash.jsx — COLOR SYSTEM FIXED
 * BUG FIXED: item.summary.presentCount / totalStudents (not item.records)
 */
import { LuRefreshCw, LuTrash2 } from 'react-icons/lu'
import { useState, useEffect } from 'react'

import { trashAPI, getErrorMessage } from '@services/api'
import toast from 'react-hot-toast'

export default function AdminTrash() {
  const [items, setItems]     = useState([])
  const [stats, setStats]     = useState(null)
  const [loading, setLoading] = useState(false)
  const [page, setPage]       = useState(1)
  const [totalPages, setTotalPages] = useState(1)
  const PER_PAGE = 20

  // Server-side paging: the API returns at most `limit` records per request (default 20, max 100).
  const load = async (targetPage = page) => {
    setLoading(true)
    try {
      const [itemRes, statRes] = await Promise.all([
        trashAPI.adminGetAll({ page: targetPage, limit: PER_PAGE }),
        trashAPI.adminGetStats(),
      ])
      const data = itemRes.data?.data
      setItems(data?.records || [])
      setTotalPages(Math.max(1, data?.pagination?.totalPages || 1))
      setStats(statRes.data?.data?.system || statRes.data?.data || null)
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load(page) }, [page]) // eslint-disable-line react-hooks/exhaustive-deps

  const paginated = items

  return (
    <div className="space-y-6 p-4 sm:p-6 max-w-6xl mx-auto">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>Global Trash</h1>
          <p className="text-sm mt-0.5" style={{ color: 'var(--text-muted)' }}>All deleted sessions across all subjects</p>
        </div>
        <button onClick={() => load(page)} disabled={loading} className="btn-secondary disabled:opacity-50">
          <LuRefreshCw size={13} className={loading ? 'animate-spin' : ''} /> Refresh
        </button>
      </div>

      {/* Stats */}
      {stats && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          {[
            { label: 'Total Items',    value: stats.totalTrashedRecords ?? 0 },
            { label: 'Restorable',     value: stats.restorableRecords ?? 0 },
            { label: 'Expired',        value: stats.expiredPendingCleanup ?? 0 },
            { label: 'Active Records', value: stats.totalActiveRecords ?? items.length },
          ].map(({ label, value }) => (
            <div key={label} className="card p-4 text-center">
              <p className="text-2xl font-bold font-mono" style={{ color: 'var(--text-primary)' }}>{value}</p>
              <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>{label}</p>
            </div>
          ))}
        </div>
      )}

      {loading ? (
        <div className="space-y-3">{[1,2,3,4,5].map(i => <div key={i} className="skeleton h-16 w-full" />)}</div>
      ) : items.length === 0 ? (
        <div className="empty-state">
          <LuTrash2 size={40} className="empty-state-icon" />
          <p>No trashed sessions found</p>
        </div>
      ) : (
        <>
          <div className="card overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--border)' }}>
                    {['Date','Class Type','Subject','Teacher','Present/Total','Deleted At'].map(h => (
                      <th key={h} className="px-4 py-3 text-left table-header">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {paginated.map((item, idx) => {
                    const presentCount = item.summary?.presentCount ?? 0
                    const totalCount   = item.summary?.totalStudents ?? 0
                    return (
                      <tr key={item._id} className="table-row-hover"
                        style={{ borderBottom: idx < paginated.length - 1 ? '1px solid var(--border-soft)' : 'none' }}>
                        <td className="px-4 py-3 text-xs font-mono font-semibold" style={{ color: 'var(--text-primary)' }}>
                          {item.date ? new Date(item.date).toLocaleDateString() : '—'}
                        </td>
                        <td className="px-4 py-3 text-xs capitalize" style={{ color: 'var(--text-secondary)' }}>{item.classType}</td>
                        <td className="px-4 py-3 text-xs font-medium" style={{ color: 'var(--brand-primary)' }}>{item.subjectId?.subjectName || '— (subject deleted)'}</td>
                        <td className="px-4 py-3 text-xs" style={{ color: 'var(--text-secondary)' }}>{item.teacher?.name || '—'}</td>
                        <td className="px-4 py-3 text-xs font-mono">
                          <span style={{ color: 'var(--success-text)', fontWeight: 600 }}>{presentCount}</span>
                          <span style={{ color: 'var(--text-muted)' }}>/{totalCount}</span>
                        </td>
                        <td className="px-4 py-3 text-xs" style={{ color: 'var(--text-muted)' }}>
                          {item.deletedAt ? new Date(item.deletedAt).toLocaleDateString() : '—'}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {totalPages > 1 && (
            <div className="flex items-center justify-center gap-2">
              <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1} className="page-btn">Prev</button>
              <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>{page} / {totalPages}</span>
              <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page === totalPages} className="page-btn">Next</button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
