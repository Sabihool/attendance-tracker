/**
 * Trash.jsx — COLOR SYSTEM FIXED
 * BUG FIXED: item.summary.presentCount / totalStudents (not item.records)
 */
import { LuTriangleAlert, LuChevronDown, LuRefreshCw, LuRotateCcw, LuTrash2, LuX } from 'react-icons/lu'
import { useState, useEffect } from 'react'

import { useSubjects } from '@context/SubjectsContext'
import { trashAPI, getErrorMessage } from '@services/api'
import toast from 'react-hot-toast'

function ConfirmModal({ message, onConfirm, onCancel }) {
  return (
    <div className="modal-overlay">
      <div className="modal-card max-w-sm p-6 space-y-4" style={{ border: '1px solid var(--danger-border)' }}>
        <div className="w-12 h-12 rounded-xl flex items-center justify-center mx-auto"
          style={{ background: 'var(--danger-bg)', border: '1px solid var(--danger-border)' }}>
          <LuTriangleAlert size={22} style={{ color: 'var(--danger-text)' }} />
        </div>
        <p className="text-sm text-center" style={{ color: 'var(--text-secondary)' }}>{message}</p>
        <div className="flex gap-3">
          <button onClick={onCancel} className="btn-secondary flex-1 justify-center">Cancel</button>
          <button onClick={onConfirm} className="btn-danger flex-1 justify-center">Confirm</button>
        </div>
      </div>
    </div>
  )
}

export default function Trash() {
  const { subjects, fetchSubjects } = useSubjects()
  const [subjectId, setSubjectId] = useState('')
  const [items, setItems]         = useState([])
  const [loading, setLoading]     = useState(false)
  const [confirm, setConfirm]     = useState(null)

  useEffect(() => { fetchSubjects() }, [fetchSubjects])

  useEffect(() => {
    if (!subjectId) { setItems([]); return }
    loadTrash()
  }, [subjectId])

  const loadTrash = async () => {
    setLoading(true)
    try {
      const res = await trashAPI.getTrash(subjectId)
      setItems(res.data?.data?.records || res.data?.data || [])
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }

  const handleRestore = async (id) => {
    try {
      await trashAPI.restore(subjectId, id)
      setItems(prev => prev.filter(i => i._id !== id))
      toast.success('Session restored')
    } catch (err) {
      toast.error(getErrorMessage(err))
    }
  }

  const handlePermanentDelete = async (id) => {
    setConfirm({ message: 'Permanently delete this session? This cannot be undone.', action: async () => {
      try {
        await trashAPI.permanentDelete(subjectId, id)
        setItems(prev => prev.filter(i => i._id !== id))
        toast.success('Permanently deleted')
      } catch (err) {
        toast.error(getErrorMessage(err))
      }
      setConfirm(null)
    }})
  }

  const handleEmptyTrash = () => {
    setConfirm({ message: `Empty all trash for this subject (${items.length} sessions)?`, action: async () => {
      try {
        await trashAPI.emptyTrash(subjectId)
        setItems([])
        toast.success('Trash emptied')
      } catch (err) {
        toast.error(getErrorMessage(err))
      }
      setConfirm(null)
    }})
  }

  return (
    <div className="space-y-6 p-4 sm:p-6 max-w-4xl mx-auto">
      {confirm && <ConfirmModal message={confirm.message} onConfirm={confirm.action} onCancel={() => setConfirm(null)} />}

      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>Trash</h1>
          <p className="text-sm mt-0.5" style={{ color: 'var(--text-muted)' }}>Deleted sessions — auto-purged after 10 days</p>
        </div>
        <div className="flex items-center gap-2">
          {subjectId && (
            <button onClick={loadTrash} className="btn-secondary">
              <LuRefreshCw size={13} />
            </button>
          )}
          {items.length > 0 && (
            <button onClick={handleEmptyTrash}
              className="flex items-center gap-2 text-sm px-3 py-2 rounded-xl transition-all"
              style={{ color: 'var(--danger-text)', background: 'var(--danger-bg)', border: '1px solid var(--danger-border)' }}>
              <LuTrash2 size={13} /> Empty Trash
            </button>
          )}
        </div>
      </div>

      {/* Subject Selector */}
      <div className="relative max-w-sm">
        <select value={subjectId} onChange={e => setSubjectId(e.target.value)} className="select-field">
          <option value="">— Select a subject —</option>
          {subjects.map(s => <option key={s._id} value={s._id}>{s.subjectName} ({s.subjectCode})</option>)}
        </select>
        <LuChevronDown size={14} className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" style={{ color: 'var(--text-muted)' }} />
      </div>

      {!subjectId ? (
        <div className="empty-state"><LuTrash2 size={40} className="empty-state-icon" /><p>Select a subject to view trash</p></div>
      ) : loading ? (
        <div className="space-y-3">{[1,2,3].map(i => <div key={i} className="skeleton h-16 w-full" />)}</div>
      ) : items.length === 0 ? (
        <div className="empty-state"><LuTrash2 size={40} className="empty-state-icon" /><p>No items in trash for this subject</p></div>
      ) : (
        <div className="space-y-3">
          {items.map(item => {
            const presentCount = item.summary?.presentCount ?? 0
            const totalCount   = item.summary?.totalStudents ?? item.students?.length ?? 0
            const dateStr = item.date ? new Date(item.date).toLocaleDateString() : '—'
            return (
              <div key={item._id} className="card p-4 flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                    {dateStr} — <span className="capitalize">{item.classType}</span>
                  </p>
                  <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                    <span style={{ color: 'var(--success-text)', fontWeight: 600 }}>{presentCount}</span>
                    <span>/{totalCount} present</span>
                    {item.deletedAt && ` · Deleted ${new Date(item.deletedAt).toLocaleDateString()}`}
                    {item.daysUntilPermanentDelete != null && ` · ${item.daysUntilPermanentDelete}d left`}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <button onClick={() => handleRestore(item._id)}
                    className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg transition-all"
                    style={{ color: 'var(--success-text)', background: 'var(--success-bg)', border: '1px solid var(--success-border)' }}>
                    <LuRotateCcw size={12} /> Restore
                  </button>
                  <button onClick={() => handlePermanentDelete(item._id)}
                    className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg transition-all"
                    style={{ color: 'var(--danger-text)', background: 'var(--danger-bg)', border: '1px solid var(--danger-border)' }}>
                    <LuX size={12} /> Delete
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
