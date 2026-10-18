/**
 * ManageAttendanceCategoriesPage.jsx
 * Admin CRUD for attendance categories + their credit values
 * (spec section 3: Dynamic Attendance Categories System).
 *
 * These categories drive:
 *   - the "Subject Type" dropdown when a teacher creates a subject
 *   - the "Attendance Category" dropdown when taking attendance (auto-fills credit)
 *   - the student Credit Score calculation
 * Seeded defaults (Theory=1, Lab=3, Event=0) can still be edited or deleted here.
 */
import { LuAward, LuTriangleAlert, LuLoaderCircle, LuPencil, LuPlus, LuSave, LuTrash2, LuX } from 'react-icons/lu'
import { useState, useEffect } from 'react'

import { attendanceCategoryAPI, getErrorMessage } from '@services/api'
import toast from 'react-hot-toast'

const emptyForm = { name: '', credit: '1' }

export default function ManageAttendanceCategoriesPage() {
  const [categories, setCategories] = useState([])
  const [loading, setLoading]       = useState(true)
  const [newCat, setNewCat]         = useState(emptyForm)
  const [adding, setAdding]         = useState(false)
  const [editingId, setEditingId]   = useState(null)
  const [editForm, setEditForm]     = useState(emptyForm)
  const [savingId, setSavingId]     = useState(null)
  const [deletingId, setDeletingId] = useState(null)
  const [confirmDelete, setConfirmDelete] = useState(null)

  const load = async () => {
    setLoading(true)
    try {
      const res = await attendanceCategoryAPI.getAll()
      setCategories(res.data?.data?.full || [])
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const validCredit = (v) => {
    const n = Number(v)
    return v !== '' && !Number.isNaN(n) && n >= 0 && n <= 20
  }

  const handleAdd = async () => {
    const trimmed = newCat.name.trim()
    if (!trimmed) { toast.error('Enter a category name'); return }
    if (!validCredit(newCat.credit)) { toast.error('Credit must be a number between 0 and 20'); return }
    setAdding(true)
    try {
      const res = await attendanceCategoryAPI.create({ name: trimmed, credit: Number(newCat.credit) })
      setCategories(prev => [...prev, res.data?.data?.category].sort((a, b) => a.name.localeCompare(b.name)))
      setNewCat(emptyForm)
      toast.success(`"${trimmed}" added`)
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setAdding(false)
    }
  }

  const startEdit = (c) => { setEditingId(c._id); setEditForm({ name: c.name, credit: String(c.credit) }) }
  const cancelEdit = () => { setEditingId(null); setEditForm(emptyForm) }

  const saveEdit = async (id) => {
    const trimmed = editForm.name.trim()
    if (!trimmed) { toast.error('Category name cannot be empty'); return }
    if (!validCredit(editForm.credit)) { toast.error('Credit must be a number between 0 and 20'); return }
    setSavingId(id)
    try {
      const res = await attendanceCategoryAPI.update(id, { name: trimmed, credit: Number(editForm.credit) })
      setCategories(prev => prev.map(c => c._id === id ? res.data?.data?.category : c))
      setEditingId(null)
      toast.success('Category updated — future sessions use the new values')
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setSavingId(null)
    }
  }

  const handleDelete = async (id, name) => {
    setDeletingId(id)
    try {
      await attendanceCategoryAPI.delete(id)
      setCategories(prev => prev.filter(c => c._id !== id))
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
        <h1 className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>Attendance Categories</h1>
        <p className="text-sm mt-0.5" style={{ color: 'var(--text-muted)' }}>
          Add, edit, or remove attendance categories and their credit values. These power the attendance-taking dropdown and every student's Credit Score.
        </p>
      </div>

      {/* Add category */}
      <div className="card p-5 space-y-3">
        <p className="text-xs font-semibold uppercase tracking-wider flex items-center gap-2" style={{ color: 'var(--text-muted)' }}>
          <LuPlus size={12} /> Add New Category
        </p>
        <div className="flex gap-3">
          <input
            type="text"
            value={newCat.name}
            onChange={e => setNewCat(f => ({ ...f, name: e.target.value }))}
            placeholder="e.g. Theory, Lab, Workshop, Seminar"
            className="input-field flex-1"
          />
          <input
            type="number" min="0" max="20" step="0.5"
            value={newCat.credit}
            onChange={e => setNewCat(f => ({ ...f, credit: e.target.value }))}
            placeholder="Credit"
            className="input-field w-28"
            title="Credit value per attended class"
          />
          <button
            onClick={handleAdd}
            disabled={adding || !newCat.name.trim()}
            className="btn-primary px-5 disabled:opacity-50"
          >
            {adding ? <LuLoaderCircle size={14} className="animate-spin" /> : <LuPlus size={14} />}
            Add
          </button>
        </div>
      </div>

      {/* Category list */}
      <div className="card p-5">
        <h2 className="text-sm font-semibold mb-3 flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
          <LuAward size={14} style={{ color: 'var(--brand-primary)' }} />
          Categories ({categories.length})
        </h2>

        {loading ? (
          <div className="space-y-2">
            {[1, 2, 3].map(i => <div key={i} className="skeleton h-12 w-full" />)}
          </div>
        ) : categories.length === 0 ? (
          <p className="text-sm text-center py-6" style={{ color: 'var(--text-muted)' }}>No categories yet. Add one above.</p>
        ) : (
          <div className="space-y-2">
            {categories.map(c => (
              <div key={c._id}
                className="flex items-center justify-between px-4 py-3 rounded-xl group transition-colors"
                style={{ background: 'var(--bg-muted)' }}>
                {editingId === c._id ? (
                  <>
                    <div className="flex items-center gap-2 flex-1 mr-3">
                      <input
                        autoFocus
                        value={editForm.name}
                        onChange={e => setEditForm(f => ({ ...f, name: e.target.value }))}
                        className="input-field text-sm flex-1"
                        style={{ padding: '0.375rem 0.625rem' }}
                      />
                      <input
                        type="number" min="0" max="20" step="0.5"
                        value={editForm.credit}
                        onChange={e => setEditForm(f => ({ ...f, credit: e.target.value }))}
                        className="input-field text-sm w-24"
                        style={{ padding: '0.375rem 0.625rem' }}
                      />
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <button onClick={() => saveEdit(c._id)} disabled={savingId === c._id} className="icon-btn success">
                        {savingId === c._id ? <LuLoaderCircle size={13} className="animate-spin" /> : <LuSave size={13} />}
                      </button>
                      <button onClick={cancelEdit} className="icon-btn"><LuX size={13} /></button>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="flex items-center gap-3">
                      <div className="w-2 h-2 rounded-full shrink-0" style={{ background: 'var(--brand-primary)' }} />
                      <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{c.name}</span>
                      {c.isDefault && <span className="badge badge-neutral">Default</span>}
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="badge" style={{ background: 'var(--brand-50)', color: 'var(--brand-primary)', border: '1px solid var(--brand-200)' }}>
                        {c.credit} credit{c.credit === 1 ? '' : 's'} / class
                      </span>
                      <div className="flex items-center gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button onClick={() => startEdit(c)} className="icon-btn brand" title="Edit category"><LuPencil size={13} /></button>
                        <button onClick={() => setConfirmDelete({ id: c._id, name: c.name })} className="icon-btn danger" title="Delete category">
                          <LuTrash2 size={13} />
                        </button>
                      </div>
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
                <p className="font-semibold" style={{ color: 'var(--text-primary)' }}>Delete Category?</p>
                <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>This action cannot be undone.</p>
              </div>
            </div>
            <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
              Are you sure you want to delete <span className="font-semibold" style={{ color: 'var(--text-primary)' }}>"{confirmDelete.name}"</span>?
              Deletion is blocked if any subject or attendance session still uses this category.
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
