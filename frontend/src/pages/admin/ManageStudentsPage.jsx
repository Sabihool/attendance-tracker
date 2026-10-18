/**
 * ManageStudentsPage.jsx
 * Student Management System (spec section 8) + Batch System Fix (spec section 9).
 *
 * - View all students, filter by Department / Shift / Batch
 * - Add a new student manually
 * - Edit a student's information
 * - Remove a student from their batch
 * All backed by real admin endpoints — no more "requires backend support" stubs.
 * Batch options are always sourced from real uploaded data, never generated.
 */
import { LuChevronDown, LuLoaderCircle, LuPencil, LuPlus, LuRefreshCw, LuSave, LuSearch, LuTrash2, LuTriangleAlert, LuUserPlus, LuUsers, LuX } from 'react-icons/lu'
import { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'

import { studentAPI, departmentAPI, shiftAPI } from '@services/api'
import { groupDeleteConfirm, academicErrorMessage as getErrorMessage } from '../../utils/academicStructure.js'
import { useAuth } from '@context/AuthContext'
import toast from 'react-hot-toast'

const emptyNewStudent = { studentId: '', roll: '', name: '', department: '', batch: '', shift: '' }

function StudentFormModal({ title, initial, departments, shifts, onCancel, onSubmit, submitting }) {
  const [form, setForm] = useState(initial)
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }))

  return (
    <div className="modal-overlay">
      <div className="modal-card max-w-md p-6 space-y-4">
        <div className="flex items-center justify-between">
          <p className="font-semibold" style={{ color: 'var(--text-primary)' }}>{title}</p>
          <button onClick={onCancel} className="icon-btn"><LuX size={14} /></button>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2">
            <label className="form-label">Name <span style={{ color: 'var(--danger)' }}>*</span></label>
            <input value={form.name} onChange={set('name')} className="input-field" placeholder="Full name" />
          </div>
          <div>
            <label className="form-label">Roll <span style={{ color: 'var(--danger)' }}>*</span></label>
            <input value={form.roll} onChange={set('roll')} className="input-field" placeholder="e.g. 01" />
          </div>
          <div>
            <label className="form-label">Registration No. <span style={{ color: 'var(--danger)' }}>*</span></label>
            <input value={form.studentId} onChange={set('studentId')} className="input-field" placeholder="e.g. CST-001" />
          </div>
          <div>
            <label className="form-label">Department <span style={{ color: 'var(--danger)' }}>*</span></label>
            <div className="relative">
              <select value={form.department} onChange={set('department')} className="select-field">
                <option value="">Select…</option>
                {departments.map(d => <option key={d} value={d}>{d}</option>)}
              </select>
              <LuChevronDown size={12} className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" style={{ color: 'var(--text-muted)' }} />
            </div>
          </div>
          <div>
            <label className="form-label">Shift <span style={{ color: 'var(--danger)' }}>*</span></label>
            <div className="relative">
              <select value={form.shift} onChange={set('shift')} className="select-field">
                <option value="">Select…</option>
                {shifts.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
              <LuChevronDown size={12} className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" style={{ color: 'var(--text-muted)' }} />
            </div>
          </div>
          <div className="col-span-2">
            <label className="form-label">Batch <span style={{ color: 'var(--danger)' }}>*</span></label>
            <input value={form.batch} onChange={set('batch')} className="input-field" placeholder="e.g. 24" maxLength={10} />
          </div>
        </div>
        <div className="flex gap-3 pt-1">
          <button onClick={onCancel} className="btn-secondary flex-1 justify-center">Cancel</button>
          <button onClick={() => onSubmit(form)} disabled={submitting} className="btn-primary flex-1 justify-center disabled:opacity-50">
            {submitting ? <LuLoaderCircle size={13} className="animate-spin" /> : <LuSave size={13} />}
            Save
          </button>
        </div>
      </div>
    </div>
  )
}

export default function AdminStudents() {
  const { user } = useAuth()
  const [students, setStudents]       = useState([])
  const [departments, setDepartments] = useState([])
  const [shifts, setShifts]           = useState([])
  const [batches, setBatches]         = useState([])
  const [loading, setLoading]         = useState(false)
  const [department, setDepartment]   = useState('')
  const [batch, setBatch]             = useState('')
  const [shift, setShift]             = useState('')
  const [search, setSearch]           = useState('')
  const [editingId, setEditingId]     = useState(null)
  const [editForm, setEditForm]       = useState({})
  const [savingEdit, setSavingEdit]   = useState(false)
  const [deletingId, setDeletingId]   = useState(null)
  const [confirmDel, setConfirmDel]   = useState(null)
  const [showAddModal, setShowAddModal] = useState(false)
  const [addSubmitting, setAddSubmitting] = useState(false)

  useEffect(() => {
    departmentAPI.getAll().then(r => setDepartments(r.data?.data?.departments || [])).catch(() => {})
    shiftAPI.getAll().then(r => setShifts(r.data?.data?.shifts || [])).catch(() => {})
  }, [])

  // Batches sourced only from uploaded data, scoped to the current filters (spec section 9)
  useEffect(() => {
    const params = {}
    if (department) params.department = department
    if (shift) params.shift = shift
    studentAPI.getBatches(params).then(r => setBatches(r.data?.data?.batches || [])).catch(() => setBatches([]))
  }, [department, shift])

  const loadStudents = useCallback(async () => {
    setLoading(true)
    try {
      const params = {}
      if (department) params.department = department
      if (batch) params.batch = batch
      if (shift) params.shift = shift
      if (search) params.search = search
      const res = await studentAPI.adminGetAll(params)
      setStudents(res.data?.data?.students || [])
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }, [department, batch, shift, search])

  useEffect(() => {
    const t = setTimeout(loadStudents, 300) // debounce search
    return () => clearTimeout(t)
  }, [loadStudents])

  const startEdit = (s) => {
    setEditingId(s._id)
    setEditForm({ name: s.name, roll: s.roll, studentId: s.studentId, department: s.department, batch: s.batch, shift: s.shift })
  }

  const cancelEdit = () => { setEditingId(null); setEditForm({}) }

  const saveEdit = async (id) => {
    setSavingEdit(true)
    try {
      const res = await studentAPI.adminUpdate(id, editForm)
      const updated = res.data?.data?.student
      setStudents(prev => prev.map(s => s._id === id ? updated : s))
      setEditingId(null)
      toast.success('Student updated')
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setSavingEdit(false)
    }
  }

  const confirmDelete = (id, name) => setConfirmDel({ id, name })

  const doDelete = async () => {
    if (!confirmDel) return
    setDeletingId(confirmDel.id)
    try {
      await studentAPI.adminDelete(confirmDel.id)
      setStudents(prev => prev.filter(s => s._id !== confirmDel.id))
      toast.success(`"${confirmDel.name}" removed from batch`)
      setConfirmDel(null)
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setDeletingId(null)
    }
  }

  const handleAddStudent = async (form) => {
    if (!form.name.trim() || !form.roll.trim() || !form.studentId.trim() || !form.department || !form.shift || !form.batch.trim()) {
      toast.error('Please fill in all required fields')
      return
    }
    setAddSubmitting(true)
    try {
      await studentAPI.adminCreate(form)
      toast.success(`"${form.name}" added`)
      setShowAddModal(false)
      loadStudents()
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setAddSubmitting(false)
    }
  }

  const deleteGroup = async () => {
    if (!department || !batch || !shift) {
      toast.error('Select department, batch, and shift to delete entire group')
      return
    }
    if (!window.confirm(groupDeleteConfirm({ department, batch, shift, collegeName: user?.college?.name }))) return
    try {
      await studentAPI.deleteGroup({ department, batch, shift })
      setStudents([])
      toast.success('Group deleted')
    } catch (err) {
      toast.error(getErrorMessage(err))
    }
  }

  return (
    <div className="space-y-6 p-4 sm:p-6 max-w-6xl mx-auto">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>Manage Students</h1>
          <p className="text-sm mt-0.5" style={{ color: 'var(--text-muted)' }}>View, add, edit, and remove student records</p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => setShowAddModal(true)} className="btn-primary">
            <LuUserPlus size={14} /> Add Student
          </button>
          <button onClick={loadStudents} disabled={loading} className="btn-secondary disabled:opacity-50">
            <LuRefreshCw size={13} className={loading ? 'animate-spin' : ''} /> Refresh
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="card p-4 grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div>
          <label className="form-label">Department</label>
          <div className="relative">
            <select value={department} onChange={e => { setDepartment(e.target.value); setBatch('') }} className="select-field">
              <option value="">All Departments</option>
              {departments.map(d => <option key={d} value={d}>{d}</option>)}
            </select>
            <LuChevronDown size={12} className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" style={{ color: 'var(--text-muted)' }} />
          </div>
        </div>

        <div>
          <label className="form-label">Batch</label>
          <div className="relative">
            <select value={batch} onChange={e => setBatch(e.target.value)} className="select-field">
              <option value="">All Batches</option>
              {batches.map(b => <option key={b} value={b}>Batch {b}</option>)}
            </select>
            <LuChevronDown size={12} className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" style={{ color: 'var(--text-muted)' }} />
          </div>
        </div>

        <div>
          <label className="form-label">Shift</label>
          <div className="relative">
            <select value={shift} onChange={e => setShift(e.target.value)} className="select-field">
              <option value="">All Shifts</option>
              {shifts.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
            <LuChevronDown size={12} className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" style={{ color: 'var(--text-muted)' }} />
          </div>
        </div>

        <div>
          <label className="form-label">Search</label>
          <div className="relative">
            <LuSearch size={13} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-muted)' }} />
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Name, roll, ID…"
              className="input-field pl-8" />
          </div>
        </div>
      </div>

      {/* Results */}
      {loading ? (
        <div className="space-y-2">{[1,2,3,4,5].map(i => <div key={i} className="skeleton h-14 w-full" />)}</div>
      ) : (
        <>
          <div className="flex items-center justify-between">
            <p className="text-sm" style={{ color: 'var(--text-muted)' }}>{students.length} student{students.length !== 1 ? 's' : ''} found</p>
            {department && batch && shift && (
              <button onClick={deleteGroup}
                className="text-xs flex items-center gap-1.5 px-3 py-1.5 rounded-xl transition-all"
                style={{ color: 'var(--danger-text)', background: 'var(--danger-bg)', border: '1px solid var(--danger-border)' }}>
                <LuTrash2 size={12} /> Delete Entire Group
              </button>
            )}
          </div>

          {students.length === 0 ? (
            <div className="empty-state">
              <LuUsers size={32} className="empty-state-icon" />
              <p className="text-sm">No students found. Try adjusting filters, or add one.</p>
            </div>
          ) : (
            <div className="card overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr style={{ borderBottom: '1px solid var(--border)' }}>
                      {['Roll', 'Name', 'Student ID', 'Department', 'Batch', 'Shift', ''].map(h => (
                        <th key={h} className="text-left px-4 py-3 table-header">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {students.map((s, idx) => (
                      <tr key={s._id} className="table-row-hover"
                        style={{ borderBottom: idx < students.length - 1 ? '1px solid var(--border-soft)' : 'none' }}>
                        {editingId === s._id ? (
                          <>
                            <td className="px-4 py-2">
                              <input value={editForm.roll} onChange={e => setEditForm(f => ({...f, roll: e.target.value}))}
                                className="input-field text-xs" style={{ padding: '0.375rem 0.625rem' }} />
                            </td>
                            <td className="px-4 py-2">
                              <input value={editForm.name} onChange={e => setEditForm(f => ({...f, name: e.target.value}))}
                                className="input-field text-xs" style={{ padding: '0.375rem 0.625rem' }} />
                            </td>
                            <td className="px-4 py-2">
                              <input value={editForm.studentId} onChange={e => setEditForm(f => ({...f, studentId: e.target.value}))}
                                className="input-field text-xs" style={{ padding: '0.375rem 0.625rem' }} />
                            </td>
                            <td className="px-4 py-2 text-xs" style={{ color: 'var(--text-secondary)' }}>{s.department}</td>
                            <td className="px-4 py-2">
                              <input value={editForm.batch} onChange={e => setEditForm(f => ({...f, batch: e.target.value}))}
                                className="input-field text-xs" style={{ padding: '0.375rem 0.625rem' }} />
                            </td>
                            <td className="px-4 py-2 text-xs" style={{ color: 'var(--text-secondary)' }}>{s.shift}</td>
                            <td className="px-4 py-2">
                              <div className="flex items-center gap-2">
                                <button onClick={() => saveEdit(s._id)} disabled={savingEdit} className="icon-btn success">
                                  {savingEdit ? <LuLoaderCircle size={13} className="animate-spin" /> : <LuSave size={13} />}
                                </button>
                                <button onClick={cancelEdit} className="icon-btn"><LuX size={13} /></button>
                              </div>
                            </td>
                          </>
                        ) : (
                          <>
                            <td className="px-4 py-3 font-mono text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>{s.roll}</td>
                            <td className="px-4 py-3 font-medium" style={{ color: 'var(--text-primary)' }}>{s.name}</td>
                            <td className="px-4 py-3 font-mono text-xs" style={{ color: 'var(--text-secondary)' }}>{s.studentId}</td>
                            <td className="px-4 py-3 text-xs" style={{ color: 'var(--text-secondary)' }}>{s.department}</td>
                            <td className="px-4 py-3 text-xs" style={{ color: 'var(--text-secondary)' }}>Batch {s.batch}</td>
                            <td className="px-4 py-3 text-xs" style={{ color: 'var(--text-secondary)' }}>{s.shift}</td>
                            <td className="px-4 py-3">
                              <div className="flex items-center gap-1.5">
                                <Link to={`/admin/student/${s.studentId}`} className="icon-btn brand" title="View Analytics">
                                  <LuUsers size={13} />
                                </Link>
                                <button onClick={() => startEdit(s)} className="icon-btn brand" title="Edit"><LuPencil size={13} /></button>
                                <button onClick={() => confirmDelete(s._id, s.name)} className="icon-btn danger" title="Remove"><LuTrash2 size={13} /></button>
                              </div>
                            </td>
                          </>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}

      {/* Add student modal */}
      {showAddModal && (
        <StudentFormModal
          title="Add Student"
          initial={emptyNewStudent}
          departments={departments}
          shifts={shifts}
          onCancel={() => setShowAddModal(false)}
          onSubmit={handleAddStudent}
          submitting={addSubmitting}
        />
      )}

      {/* Confirm delete modal */}
      {confirmDel && (
        <div className="modal-overlay">
          <div className="modal-card max-w-sm p-6 space-y-4" style={{ border: '1px solid var(--danger-border)' }}>
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
                style={{ background: 'var(--danger-bg)', border: '1px solid var(--danger-border)' }}>
                <LuTriangleAlert size={18} style={{ color: 'var(--danger-text)' }} />
              </div>
              <p className="font-semibold" style={{ color: 'var(--text-primary)' }}>Remove Student?</p>
            </div>
            <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
              Remove <span className="font-medium" style={{ color: 'var(--text-primary)' }}>"{confirmDel.name}"</span> from their batch? Their attendance history is kept.
            </p>
            <div className="flex gap-3">
              <button onClick={() => setConfirmDel(null)} className="btn-secondary flex-1 justify-center">Cancel</button>
              <button onClick={doDelete} disabled={!!deletingId} className="btn-danger flex-1 justify-center disabled:opacity-50">
                {deletingId ? <><LuLoaderCircle size={13} className="animate-spin" /> Removing…</> : <><LuTrash2 size={13} /> Remove</>}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
