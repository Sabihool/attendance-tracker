/**
 * ManageDepartments.jsx
 * Full admin CRUD for departments (spec section 10: Add / Edit / Delete).
 */
import { LuTriangleAlert, LuBuilding2, LuLoaderCircle, LuPencil, LuPlus, LuSave, LuTrash2, LuX } from 'react-icons/lu'
import { useState, useEffect } from 'react'

import { departmentAPI } from '@services/api'
import { isDuplicateName, academicErrorMessage as getErrorMessage } from '../../utils/academicStructure.js'
import toast from 'react-hot-toast'

export default function ManageDepartments() {
  const [departments, setDepartments] = useState([])
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
      const res = await departmentAPI.getAll()
      setDepartments(res.data?.data?.full || [])
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const handleAdd = async () => {
    const trimmed = newName.trim()
    if (!trimmed) { toast.error('Enter a department name'); return }
    if (isDuplicateName(departments, trimmed)) { toast.error(`"${trimmed}" already exists in your college`); return }
    setAdding(true)
    try {
      const res = await departmentAPI.create(trimmed)
      setDepartments(prev => [...prev, res.data?.data?.department])
      setNewName('')
      toast.success(`"${trimmed}" added`)
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setAdding(false)
    }
  }

  const startEdit = (d) => { setEditingId(d._id); setEditName(d.name) }
  const cancelEdit = () => { setEditingId(null); setEditName('') }

  const saveEdit = async (id) => {
    const trimmed = editName.trim()
    if (!trimmed) { toast.error('Department name cannot be empty'); return }
    if (isDuplicateName(departments, trimmed, id)) { toast.error(`"${trimmed}" already exists in your college`); return }
    setSavingId(id)
    try {
      const res = await departmentAPI.update(id, trimmed)
      setDepartments(prev => prev.map(d => d._id === id ? res.data?.data?.department : d))
      setEditingId(null)
      toast.success('Department updated — renamed everywhere it was used')
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setSavingId(null)
    }
  }

  const handleDelete = async (id, name) => {
    setDeletingId(id)
    try {
      await departmentAPI.delete(id)
      setDepartments(prev => prev.filter(d => d._id !== id))
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
        <h1 className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>Manage Departments</h1>
        <p className="text-sm mt-0.5" style={{ color: 'var(--text-muted)' }}>Add, edit, or remove your college's departments. Changes apply instantly across your college.</p>
      </div>

      {/* Add department */}
      <div className="card p-5 space-y-3">
        <p className="text-xs font-semibold uppercase tracking-wider flex items-center gap-2" style={{ color: 'var(--text-muted)' }}>
          <LuPlus size={12} /> Add New Department
        </p>
        <div className="flex gap-3">
          <input
            type="text"
            value={newName}
            onChange={e => setNewName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleAdd()}
            placeholder="e.g. Electronics Engineering Technology"
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

      {/* Department list */}
      <div className="card p-5">
        <h2 className="text-sm font-semibold mb-3 flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
          <LuBuilding2 size={14} style={{ color: 'var(--brand-primary)' }} />
          Active Departments ({departments.length})
        </h2>

        {loading ? (
          <div className="space-y-2">
            {[1,2,3].map(i => <div key={i} className="skeleton h-12 w-full" />)}
          </div>
        ) : departments.length === 0 ? (
          <p className="text-sm text-center py-6" style={{ color: 'var(--text-muted)' }}>No departments yet. Add one above.</p>
        ) : (
          <div className="space-y-2">
            {departments.map(d => (
              <div key={d._id}
                className="flex items-center justify-between px-4 py-3 rounded-xl group transition-colors"
                style={{ background: 'var(--bg-muted)' }}>
                {editingId === d._id ? (
                  <>
                    <input
                      autoFocus
                      value={editName}
                      onChange={e => setEditName(e.target.value)}
                      onKeyDown={e => e.key === 'Enter' && saveEdit(d._id)}
                      className="input-field text-sm flex-1 mr-3"
                      style={{ padding: '0.375rem 0.625rem' }}
                    />
                    <div className="flex items-center gap-1.5 shrink-0">
                      <button onClick={() => saveEdit(d._id)} disabled={savingId === d._id} className="icon-btn success">
                        {savingId === d._id ? <LuLoaderCircle size={13} className="animate-spin" /> : <LuSave size={13} />}
                      </button>
                      <button onClick={cancelEdit} className="icon-btn"><LuX size={13} /></button>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="flex items-center gap-3">
                      <div className="w-2 h-2 rounded-full shrink-0" style={{ background: 'var(--brand-primary)' }} />
                      <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{d.name}</span>
                    </div>
                    <div className="flex items-center gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button onClick={() => startEdit(d)} className="icon-btn brand" title="Edit department"><LuPencil size={13} /></button>
                      <button
                        onClick={() => setConfirmDelete({ id: d._id, name: d.name })}
                        className="icon-btn danger"
                        title="Delete department"
                      >
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
                <p className="font-semibold" style={{ color: 'var(--text-primary)' }}>Delete Department?</p>
                <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>This action cannot be undone.</p>
              </div>
            </div>
            <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
              Are you sure you want to delete <span className="font-semibold" style={{ color: 'var(--text-primary)' }}>"{confirmDelete.name}"</span>?
              Deletion is blocked if any student or subject still uses this department.
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
