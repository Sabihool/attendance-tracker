/**
 * ManageShiftsPage.jsx
 * Full admin CRUD for shifts (spec section 1: Shift Management).
 * Every module that uses shifts (student registration, teacher panel, batch
 * filtering, reports) reads from this same admin-managed list — nothing is
 * hardcoded anywhere else in the system.
 */
import { LuTriangleAlert, LuClock, LuLoaderCircle, LuPencil, LuPlus, LuSave, LuTrash2, LuX } from 'react-icons/lu'
import { useState, useEffect } from 'react'

import { shiftAPI } from '@services/api'
import { isDuplicateName, academicErrorMessage as getErrorMessage } from '../../utils/academicStructure.js'
import toast from 'react-hot-toast'

export default function ManageShiftsPage() {
  const [shifts, setShifts]           = useState([])
  const [loading, setLoading]         = useState(true)
  const [newName, setNewName]         = useState('')
  const [adding, setAdding]           = useState(false)
  const [editingId, setEditingId]     = useState(null)
  const [editName, setEditName]       = useState('')
  const [savingId, setSavingId]       = useState(null)
  const [deletingId, setDeletingId]   = useState(null)
  const [confirmDelete, setConfirmDelete] = useState(null)

  const load = async () => {
    setLoading(true)
    try {
      const res = await shiftAPI.getAll()
      setShifts(res.data?.data?.full || [])
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const handleAdd = async () => {
    const trimmed = newName.trim()
    if (!trimmed) { toast.error('Enter a shift name'); return }
    if (isDuplicateName(shifts, trimmed)) { toast.error(`"${trimmed}" already exists in your college`); return }
    setAdding(true)
    try {
      const res = await shiftAPI.create({ name: trimmed })
      setShifts(prev => [...prev, res.data?.data?.shift].sort((a, b) => a.name.localeCompare(b.name)))
      setNewName('')
      toast.success(`"${trimmed}" added`)
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setAdding(false)
    }
  }

  const startEdit = (s) => { setEditingId(s._id); setEditName(s.name) }
  const cancelEdit = () => { setEditingId(null); setEditName('') }

  const saveEdit = async (id) => {
    const trimmed = editName.trim()
    if (!trimmed) { toast.error('Shift name cannot be empty'); return }
    if (isDuplicateName(shifts, trimmed, id)) { toast.error(`"${trimmed}" already exists in your college`); return }
    setSavingId(id)
    try {
      const res = await shiftAPI.update(id, { name: trimmed })
      setShifts(prev => prev.map(s => s._id === id ? res.data?.data?.shift : s))
      setEditingId(null)
      toast.success('Shift updated — renamed everywhere it was used')
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setSavingId(null)
    }
  }

  const handleDelete = async (id, name) => {
    setDeletingId(id)
    try {
      await shiftAPI.delete(id)
      setShifts(prev => prev.filter(s => s._id !== id))
      setConfirmDelete(null)
      toast.success(`"${name}" deleted`)
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setDeletingId(null)
    }
  }

  return (
    <div className="space-y-6 p-4 sm:p-6 max-w-3xl mx-auto">
      <div>
        <h1 className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>Manage Shifts</h1>
        <p className="text-sm mt-0.5" style={{ color: 'var(--text-muted)' }}>
          Add, edit, or remove shifts. Every form in the system — student registration, subject creation, attendance, reports — pulls this same list.
        </p>
      </div>

      {/* Add shift */}
      <div className="card p-5 space-y-3">
        <p className="text-xs font-semibold uppercase tracking-wider flex items-center gap-2" style={{ color: 'var(--text-muted)' }}>
          <LuPlus size={12} /> Add New Shift
        </p>
        <div className="flex gap-3">
          <input
            type="text"
            value={newName}
            onChange={e => setNewName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleAdd()}
            placeholder="e.g. Morning, 1st Shift, Evening"
            className="input-field flex-1"
          />
          <button
            onClick={handleAdd}
            disabled={adding || !newName.trim()}
            className="btn-primary px-5 disabled:opacity-50"
          >
            {adding ? <LuLoaderCircle size={14} className="animate-spin" /> : <LuPlus size={14} />}
            Add
          </button>
        </div>
      </div>

      {/* Shift list */}
      <div className="card p-5">
        <h2 className="text-sm font-semibold mb-3 flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
          <LuClock size={14} style={{ color: 'var(--brand-primary)' }} />
          Active Shifts ({shifts.length})
        </h2>

        {loading ? (
          <div className="space-y-2">
            {[1, 2, 3].map(i => <div key={i} className="skeleton h-12 w-full" />)}
          </div>
        ) : shifts.length === 0 ? (
          <p className="text-sm text-center py-6" style={{ color: 'var(--text-muted)' }}>No shifts yet. Add one above.</p>
        ) : (
          <div className="space-y-2">
            {shifts.map(s => (
              <div key={s._id}
                className="flex items-center justify-between px-4 py-3 rounded-xl group transition-colors"
                style={{ background: 'var(--bg-muted)' }}>
                {editingId === s._id ? (
                  <>
                    <input
                      autoFocus
                      value={editName}
                      onChange={e => setEditName(e.target.value)}
                      onKeyDown={e => e.key === 'Enter' && saveEdit(s._id)}
                      className="input-field text-sm flex-1 mr-3"
                      style={{ padding: '0.375rem 0.625rem' }}
                    />
                    <div className="flex items-center gap-1.5 shrink-0">
                      <button onClick={() => saveEdit(s._id)} disabled={savingId === s._id} className="icon-btn success">
                        {savingId === s._id ? <LuLoaderCircle size={13} className="animate-spin" /> : <LuSave size={13} />}
                      </button>
                      <button onClick={cancelEdit} className="icon-btn"><LuX size={13} /></button>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="flex items-center gap-3">
                      <div className="w-2 h-2 rounded-full shrink-0" style={{ background: 'var(--brand-primary)' }} />
                      <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{s.name}</span>
                    </div>
                    <div className="flex items-center gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button onClick={() => startEdit(s)} className="icon-btn brand" title="Edit shift"><LuPencil size={13} /></button>
                      <button onClick={() => setConfirmDelete({ id: s._id, name: s.name })} className="icon-btn danger" title="Delete shift">
                        <LuTrash2 size={13} />
                      </button>
                    </div>
                  </>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Confirm delete modal */}
      {confirmDelete && (
        <div className="modal-overlay">
          <div className="modal-card max-w-sm p-6 space-y-4" style={{ border: '1px solid var(--danger-border)' }}>
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
                style={{ background: 'var(--danger-bg)', border: '1px solid var(--danger-border)' }}>
                <LuTriangleAlert size={18} style={{ color: 'var(--danger-text)' }} />
              </div>
              <div>
                <p className="font-semibold" style={{ color: 'var(--text-primary)' }}>Delete Shift?</p>
                <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>This action cannot be undone.</p>
              </div>
            </div>
            <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
              Are you sure you want to delete <span className="font-semibold" style={{ color: 'var(--text-primary)' }}>"{confirmDelete.name}"</span>?
              Deletion is blocked if any student or subject still uses this shift.
            </p>
            <div className="flex gap-3">
              <button onClick={() => setConfirmDelete(null)} className="btn-secondary flex-1 justify-center">Cancel</button>
              <button
                onClick={() => handleDelete(confirmDelete.id, confirmDelete.name)}
                disabled={deletingId === confirmDelete.id}
                className="btn-danger flex-1 justify-center disabled:opacity-50"
              >
                {deletingId === confirmDelete.id
                  ? <><LuLoaderCircle size={13} className="animate-spin" /> Deleting…</>
                  : <><LuTrash2 size={13} /> Delete</>}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
