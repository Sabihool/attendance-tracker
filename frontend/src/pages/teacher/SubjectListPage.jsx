/**
 * SubjectList.jsx — COLOR SYSTEM FIXED
 */
import { LuBookMarked, LuBookOpen, LuFlaskConical, LuPencil, LuPlus, LuRefreshCw, LuSave, LuSearch, LuTrash2, LuX } from 'react-icons/lu'
import { useState, useEffect, useMemo } from 'react'
import { Link, useNavigate } from 'react-router-dom'

import toast from 'react-hot-toast'
import { useSubjects } from '@context/SubjectsContext'
import DeleteSubjectModal from '@components/forms/DeleteSubjectModal'
import { pickSubjectFields } from '@utils/subjectForm'

// Light-mode color palette for subject cards
const COLORS = {
  brand:  { iconBg: '#EEF0FF', iconColor: '#5B4BE0', border: '#C4BAFD', text: '#5B4BE0' },
  purple: { iconBg: '#F5F3FF', iconColor: '#7C3AED', border: '#C4B5FD', text: '#7C3AED' },
  green:  { iconBg: '#F0FDF4', iconColor: '#15803D', border: '#BBF7D0', text: '#15803D' },
  amber:  { iconBg: '#FFFBEB', iconColor: '#B45309', border: '#FDE68A', text: '#B45309' },
  rose:   { iconBg: '#FEF2F2', iconColor: '#B91C1C', border: '#FECACA', text: '#B91C1C' },
  cyan:   { iconBg: '#ECFEFF', iconColor: '#0E7490', border: '#A5F3FC', text: '#0E7490' },
  slate:  { iconBg: '#F8FAFC', iconColor: '#475569', border: '#CBD5E1', text: '#475569' },
}
const getColor = (key) => COLORS[key] || COLORS.brand

function EditModal({ subject, onSave, onClose }) {
  const [form, setForm] = useState({ ...subject })
  const set = k => e => setForm(f => ({ ...f, [k]: e.target.value }))
  const save = () => {
    if (!form.subjectName?.trim() || !form.subjectCode?.trim()) { toast.error('Name and Code are required'); return }
    onSave(pickSubjectFields(form, ['subjectName', 'subjectCode']))
  }
  return (
    <div className="modal-overlay">
      <div className="modal-card max-w-md p-6 space-y-4 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold" style={{ color: 'var(--text-primary)' }}>Edit Subject</h3>
          <button onClick={onClose} className="icon-btn"><LuX size={18} /></button>
        </div>
        <div className="space-y-3">
          {[
            { k: 'subjectName', label: 'Subject Name', placeholder: 'e.g. Data Structures' },
            { k: 'subjectCode', label: 'Subject Code', placeholder: 'e.g. CSE-301' },
          ].map(({ k, label, placeholder }) => (
            <div key={k}>
              <label className="form-label">{label}</label>
              <input type="text" value={form[k] || ''} onChange={set(k)} placeholder={placeholder}
                className="input-field" />
            </div>
          ))}
        </div>
        <div className="flex gap-3 pt-2">
          <button onClick={onClose} className="btn-secondary flex-1 justify-center">Cancel</button>
          <button onClick={save} className="btn-primary flex-1 justify-center">
            <LuSave size={14} /> Save
          </button>
        </div>
      </div>
    </div>
  )
}

export default function SubjectList() {
  const navigate = useNavigate()
  const { subjects, loading, fetchSubjects, updateSubject, deleteSubject } = useSubjects()
  const [search, setSearch]         = useState('')
  const [editTarget, setEditTarget] = useState(null)
  const [deleteTarget, setDeleteTarget] = useState(null)
  const [deletingId, setDeletingId] = useState(null)

  useEffect(() => { fetchSubjects() }, [fetchSubjects])

  const filtered = useMemo(() =>
    subjects.filter(s =>
      s.subjectName?.toLowerCase().includes(search.toLowerCase()) ||
      s.subjectCode?.toLowerCase().includes(search.toLowerCase()) ||
      s.department?.toLowerCase().includes(search.toLowerCase())
    ),
  [subjects, search])

  const handleSaveEdit = async (updated) => {
    const result = await updateSubject(editTarget._id, updated)
    if (result.success) setEditTarget(null)
  }

  const handleDelete = async () => {
    if (!deleteTarget) return
    setDeletingId(deleteTarget._id)
    const result = await deleteSubject(deleteTarget._id, true)
    setDeletingId(null)
    if (result.success) setDeleteTarget(null)
  }

  return (
    <div className="space-y-6 p-4 sm:p-6 max-w-7xl mx-auto">
      {editTarget && <EditModal subject={editTarget} onSave={handleSaveEdit} onClose={() => setEditTarget(null)} />}
      {deleteTarget && <DeleteSubjectModal subject={deleteTarget} onConfirm={handleDelete} onCancel={() => setDeleteTarget(null)} />}

      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>My Subjects</h1>
          <p className="text-sm mt-0.5" style={{ color: 'var(--text-muted)' }}>
            {subjects.length} subject{subjects.length !== 1 ? 's' : ''} total
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => fetchSubjects()} className="btn-secondary">
            <LuRefreshCw size={13} />
          </button>
          <Link to="/teacher/create-subject" className="btn-primary">
            <LuPlus size={15} /> New Subject
          </Link>
        </div>
      </div>

      {/* Search */}
      <div className="relative">
        <LuSearch size={15} className="absolute left-4 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-muted)' }} />
        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search subjects…"
          className="input-field pl-10"
        />
        {search && (
          <button onClick={() => setSearch('')} className="icon-btn absolute right-2 top-1/2 -translate-y-1/2">
            <LuX size={14} />
          </button>
        )}
      </div>

      {/* Subject Grid */}
      {loading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {[1,2,3,4,5,6].map(i => <div key={i} className="skeleton h-48 w-full" />)}
        </div>
      ) : filtered.length === 0 ? (
        <div className="empty-state">
          <LuBookMarked size={40} className="empty-state-icon" />
          <p className="font-medium" style={{ color: 'var(--text-secondary)' }}>
            {search ? 'No subjects match your search' : 'No subjects yet'}
          </p>
          {!search && (
            <Link to="/teacher/create-subject" className="mt-3 inline-flex items-center gap-2 text-sm font-semibold"
              style={{ color: 'var(--brand-primary)' }}>
              <LuPlus size={14} /> Create your first subject
            </Link>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {filtered.map(sub => {
            const c = getColor(sub.color)
            return (
              <div key={sub._id}
                className="card p-5 group hover:shadow-lg transition-all duration-300"
                style={{ borderColor: c.border }}>
                <div className="flex items-start justify-between mb-3">
                  <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
                    style={{ background: c.iconBg, border: `1px solid ${c.border}` }}>
                    <LuBookOpen size={18} style={{ color: c.iconColor }} />
                  </div>
                  <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button onClick={() => setEditTarget(sub)} className="icon-btn brand">
                      <LuPencil size={12} />
                    </button>
                    <button onClick={() => setDeleteTarget(sub)} disabled={deletingId === sub._id} className="icon-btn danger">
                      <LuTrash2 size={12} />
                    </button>
                  </div>
                </div>
                <h3 className="text-sm font-semibold mb-0.5" style={{ color: 'var(--text-primary)' }}>{sub.subjectName}</h3>
                <p className="text-xs font-mono font-bold mb-2" style={{ color: c.text }}>{sub.subjectCode}</p>
                <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{sub.department}</p>
                {sub.shift && (
                  <p className="text-xs capitalize" style={{ color: 'var(--text-muted)' }}>
                    {sub.shift}{sub.batch ? ` · Batch ${sub.batch}` : ''}
                  </p>
                )}
                <div className="mt-3 pt-3 flex gap-2" style={{ borderTop: '1px solid var(--border-soft)' }}>
                  <button
                    onClick={() => navigate('/teacher/attendance', { state: { subjectId: sub._id } })}
                    className="flex-1 text-xs py-1.5 rounded-lg transition-all text-center font-semibold"
                    style={{ background: 'var(--brand-50)', color: 'var(--brand-primary)', border: '1px solid var(--brand-200)' }}
                    onMouseEnter={e => { e.currentTarget.style.background = 'var(--brand-100)' }}
                    onMouseLeave={e => { e.currentTarget.style.background = 'var(--brand-50)' }}
                  >
                    Attendance
                  </button>
                  <button
                    onClick={() => navigate('/teacher/reports', { state: { subjectId: sub._id } })}
                    className="flex-1 text-xs py-1.5 rounded-lg transition-all text-center font-medium"
                    style={{ background: 'var(--bg-muted)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}
                    onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-hover)'; e.currentTarget.style.color = 'var(--text-primary)' }}
                    onMouseLeave={e => { e.currentTarget.style.background = 'var(--bg-muted)'; e.currentTarget.style.color = 'var(--text-secondary)' }}
                  >
                    Reports
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
