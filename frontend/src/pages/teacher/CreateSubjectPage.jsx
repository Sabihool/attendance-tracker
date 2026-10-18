/**
 * CreateSubject.jsx — COLOR SYSTEM FIXED
 */
import { LuArrowLeft, LuBookOpen, LuChevronDown, LuSave } from 'react-icons/lu'
import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'

import toast from 'react-hot-toast'
import { useSubjects } from '@context/SubjectsContext'
import { studentAPI, getErrorMessage } from '@services/api'

// Must match backend Subject model's COLORS enum exactly (models/Subject.js)
const COLORS = [
  { key: 'brand',  hex: '#5B4BE0', label: 'Purple' },
  { key: 'purple', hex: '#7C3AED', label: 'Violet' },
  { key: 'green',  hex: '#16A34A', label: 'Green'  },
  { key: 'amber',  hex: '#D97706', label: 'Amber'  },
  { key: 'rose',   hex: '#DC2626', label: 'Rose'   },
  { key: 'cyan',   hex: '#0891B2', label: 'Cyan'   },
  { key: 'blue',   hex: '#2563EB', label: 'Blue'   },
  { key: 'orange', hex: '#EA580C', label: 'Orange' },
]

function FieldRow({ label, required, children }) {
  return (
    <div>
      <label className="form-label">
        {label} {required && <span style={{ color: 'var(--danger)' }}>*</span>}
      </label>
      {children}
    </div>
  )
}

export default function CreateSubject() {
  const navigate = useNavigate()
  const { addSubject, fetchMeta, meta } = useSubjects()
  const [form, setForm] = useState({
    subjectName: '', subjectCode: '', department: '',
    shift: '', batch: '', color: 'brand',
  })
  const [loading, setLoading] = useState(false)
  const [errors, setErrors]   = useState({})
  const [batches, setBatches] = useState([])
  const [batchesLoading, setBatchesLoading] = useState(false)

  useEffect(() => { fetchMeta() }, [fetchMeta])

  const DEPARTMENTS  = meta?.departments  || []
  const SHIFTS       = meta?.shifts       || []

  // Batches come only from admin-uploaded student data (spec section 9) —
  // never a fixed 1–25 list. Scoped to the chosen department + shift once set.
  useEffect(() => {
    setBatchesLoading(true)
    const params = {}
    if (form.department) params.department = form.department
    if (form.shift) params.shift = form.shift
    studentAPI.getBatches(params)
      .then(res => setBatches(res.data?.data?.batches || []))
      .catch(() => setBatches([]))
      .finally(() => setBatchesLoading(false))
  }, [form.department, form.shift])

  const set = k => e => {
    setForm(f => ({ ...f, [k]: e.target.value, ...(k === 'department' || k === 'shift' ? { batch: '' } : {}) }))
    if (errors[k]) setErrors(prev => ({ ...prev, [k]: '' }))
  }

  const validate = () => {
    const e = {}
    if (!form.subjectName.trim()) e.subjectName = 'Subject name is required'
    if (!form.subjectCode.trim()) e.subjectCode = 'Subject code is required'
    if (!form.department)         e.department  = 'Department is required'
    if (!form.batch)              e.batch       = 'Batch is required'
    if (!form.shift)              e.shift       = 'Shift is required'
    return e
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    const errs = validate()
    if (Object.keys(errs).length > 0) { setErrors(errs); return }
    setLoading(true)
    const result = await addSubject(form)
    setLoading(false)
    if (result.success) navigate('/teacher/subjects')
  }

  const SelectField = ({ field, options, placeholder, displayFn }) => (
    <div className="relative">
      <select value={form[field]} onChange={set(field)}
        className="select-field"
        style={errors[field] ? { borderColor: 'var(--danger)', boxShadow: '0 0 0 3px rgba(220,38,38,0.10)' } : {}}>
        <option value="">{placeholder}</option>
        {options.map(o => <option key={o} value={o}>{displayFn ? displayFn(o) : o}</option>)}
      </select>
      <LuChevronDown size={14} className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" style={{ color: 'var(--text-muted)' }} />
      {errors[field] && <p className="text-xs mt-1" style={{ color: 'var(--danger-text)' }}>{errors[field]}</p>}
    </div>
  )

  return (
    <div className="max-w-2xl mx-auto p-4 sm:p-6 space-y-6">
      <div className="flex items-center gap-3">
        <button onClick={() => navigate(-1)} className="icon-btn">
          <LuArrowLeft size={18} />
        </button>
        <div>
          <h1 className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>Create Subject</h1>
          <p className="text-sm mt-0.5" style={{ color: 'var(--text-muted)' }}>Add a new subject to your list</p>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="card p-6 space-y-5">
        <FieldRow label="Subject Name" required>
          <input type="text" value={form.subjectName} onChange={set('subjectName')}
            placeholder="e.g. Data Structures & Algorithms"
            className="input-field"
            style={errors.subjectName ? { borderColor: 'var(--danger)', boxShadow: '0 0 0 3px rgba(220,38,38,0.10)' } : {}} />
          {errors.subjectName && <p className="text-xs mt-1" style={{ color: 'var(--danger-text)' }}>{errors.subjectName}</p>}
        </FieldRow>

        <FieldRow label="Subject Code" required>
          <input type="text" value={form.subjectCode} onChange={set('subjectCode')}
            placeholder="e.g. CST-301"
            className="input-field"
            style={errors.subjectCode ? { borderColor: 'var(--danger)', boxShadow: '0 0 0 3px rgba(220,38,38,0.10)' } : {}} />
          {errors.subjectCode && <p className="text-xs mt-1" style={{ color: 'var(--danger-text)' }}>{errors.subjectCode}</p>}
        </FieldRow>

        <FieldRow label="Department" required>
          <SelectField field="department" options={DEPARTMENTS}
            placeholder={DEPARTMENTS.length ? 'Select department…' : 'Loading departments…'} />
        </FieldRow>

        <div className="grid grid-cols-2 gap-4">
          <FieldRow label="Batch" required>
            <div className="relative">
              <select value={form.batch} onChange={set('batch')}
                className="select-field"
                disabled={batchesLoading}
                style={errors.batch ? { borderColor: 'var(--danger)' } : {}}>
                <option value="">
                  {batchesLoading ? 'Loading batches…' : batches.length ? 'Select Batch…' : 'No batches uploaded yet'}
                </option>
                {batches.map(b => <option key={b} value={b}>Batch {b}</option>)}
              </select>
              <LuChevronDown size={14} className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" style={{ color: 'var(--text-muted)' }} />
              {errors.batch && <p className="text-xs mt-1" style={{ color: 'var(--danger-text)' }}>{errors.batch}</p>}
              {!batchesLoading && batches.length === 0 && (
                <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                  Ask an admin to upload student data for this department/shift first.
                </p>
              )}
            </div>
          </FieldRow>

          <FieldRow label="Shift" required>
            <SelectField field="shift" options={SHIFTS} placeholder="Select shift…" />
          </FieldRow>
        </div>

        <FieldRow label="Color Label">
          <div className="flex gap-3 flex-wrap mt-1">
            {COLORS.map(c => (
              <button key={c.key} type="button" onClick={() => setForm(f => ({ ...f, color: c.key }))}
                className="w-8 h-8 rounded-lg transition-all"
                style={{
                  background: c.hex,
                  border: form.color === c.key ? '3px solid var(--text-primary)' : '2px solid transparent',
                  outline: form.color === c.key ? `2px solid ${c.hex}` : 'none',
                  outlineOffset: '2px',
                  transform: form.color === c.key ? 'scale(1.15)' : 'scale(1)',
                }}
                title={c.label} />
            ))}
          </div>
        </FieldRow>

        <div className="flex gap-3 pt-2">
          <button type="button" onClick={() => navigate(-1)} className="btn-secondary flex-1 justify-center py-3">
            Cancel
          </button>
          <button type="submit" disabled={loading} className="btn-primary flex-1 justify-center py-3 disabled:opacity-50">
            {loading
              ? <><span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> Creating…</>
              : <><LuSave size={15} /> Create Subject</>}
          </button>
        </div>
      </form>
    </div>
  )
}
