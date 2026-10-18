/**
 * UploadStudents.jsx — COLOR SYSTEM FIXED
 */
import { LuTriangleAlert, LuChevronDown, LuCircleCheck, LuFileJson, LuUpload, LuX } from 'react-icons/lu'
import { useState, useRef, useEffect } from 'react'

import toast from 'react-hot-toast'
import { studentAPI, departmentAPI, shiftAPI, getErrorMessage } from '@services/api'

export default function UploadJSON() {
  const fileRef = useRef(null)
  const [file, setFile]             = useState(null)
  const [uploading, setUploading]   = useState(false)
  const [result, setResult]         = useState(null)
  const [dragOver, setDragOver]     = useState(false)
  const [departments, setDepartments] = useState([])
  const [shifts, setShifts]         = useState([])
  const [department, setDepartment] = useState('')
  const [batch, setBatch]           = useState('')
  const [shift, setShift]           = useState('')

  useEffect(() => {
    departmentAPI.getAll()
      .then(r => setDepartments(r.data?.data?.departments || []))
      .catch(() => {})
    shiftAPI.getAll()
      .then(r => setShifts(r.data?.data?.shifts || []))
      .catch(() => {})
  }, [])

  const handleFile = (f) => {
    if (!f) return
    if (!f.name.endsWith('.json')) { toast.error('Only .json files are accepted'); return }
    if (f.size > 2 * 1024 * 1024) { toast.error('File must be under 2MB'); return }
    setFile(f)
    setResult(null)
  }

  const handleDrop = (e) => {
    e.preventDefault()
    setDragOver(false)
    handleFile(e.dataTransfer.files[0])
  }

  const handleUpload = async () => {
    if (!file)       { toast.error('Select a file first'); return }
    if (!department) { toast.error('Please select a department'); return }
    if (!batch)      { toast.error('Please select a batch'); return }
    if (!shift)      { toast.error('Please select a shift'); return }
    setUploading(true)
    setResult(null)
    try {
      const fd = new FormData()
      fd.append('file', file)
      fd.append('department', department)
      fd.append('batch', batch)
      fd.append('shift', shift)
      const res = await studentAPI.upload(fd)
      setResult({ success: true, data: res.data?.data || res.data })
      toast.success('Students uploaded successfully!')
      setFile(null)
    } catch (err) {
      const msg = getErrorMessage(err)
      // The server lists every problem it found (row-level validation errors or
      // clashes with students already in this college) — show them, not just the headline.
      const lines = Array.isArray(err?.response?.data?.errors) ? err.response.data.errors : []
      setResult({ success: false, error: msg, errors: lines })
      toast.error(lines.length ? 'Import rejected — see the list below' : msg)
    } finally {
      setUploading(false)
    }
  }

  return (
    <div className="space-y-6 p-4 sm:p-6 max-w-2xl mx-auto">
      <div>
        <h1 className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>Upload Students (JSON)</h1>
        <p className="text-sm mt-0.5" style={{ color: 'var(--text-muted)' }}>Bulk-import student data from a JSON file</p>
      </div>

      {/* Group metadata fields */}
      <div className="card p-5 space-y-4">
        <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>Student Group Info</p>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <label className="form-label">Department <span style={{ color: 'var(--danger)' }}>*</span></label>
            <div className="relative">
              <select value={department} onChange={e => setDepartment(e.target.value)} className="select-field">
                <option value="">{departments.length ? 'Select…' : 'Loading…'}</option>
                {departments.map(d => <option key={d} value={d}>{d}</option>)}
              </select>
              <LuChevronDown size={12} className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" style={{ color: 'var(--text-muted)' }} />
            </div>
          </div>
          <div>
            <label className="form-label">Batch <span style={{ color: 'var(--danger)' }}>*</span></label>
            <input
              type="text"
              value={batch}
              onChange={e => setBatch(e.target.value)}
              placeholder="e.g. 24, Spring-24, A"
              className="input-field"
              maxLength={10}
            />
            <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
              This upload defines the batch — type any name/number, up to 10 characters.
            </p>
          </div>
          <div>
            <label className="form-label">Shift <span style={{ color: 'var(--danger)' }}>*</span></label>
            <div className="relative">
              <select value={shift} onChange={e => setShift(e.target.value)} className="select-field">
                <option value="">{shifts.length ? 'Select…' : 'Loading…'}</option>
                {shifts.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
              <LuChevronDown size={12} className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" style={{ color: 'var(--text-muted)' }} />
            </div>
          </div>
        </div>
      </div>

      {/* Drop Zone */}
      <div
        onDragOver={e => { e.preventDefault(); setDragOver(true) }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        onClick={() => fileRef.current?.click()}
        className={`drag-zone ${dragOver ? 'active' : ''}`}
      >
        <input ref={fileRef} type="file" accept=".json" className="hidden" onChange={e => handleFile(e.target.files[0])} />
        <LuFileJson size={36} className="mx-auto mb-3" style={{ color: dragOver ? 'var(--brand-primary)' : 'var(--border-strong)' }} />
        {file ? (
          <div>
            <p className="font-medium" style={{ color: 'var(--text-primary)' }}>{file.name}</p>
            <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>{(file.size / 1024).toFixed(1)} KB</p>
          </div>
        ) : (
          <div>
            <p className="font-medium" style={{ color: 'var(--text-secondary)' }}>Drop JSON file here or click to browse</p>
            <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>Max 2MB · .json only</p>
          </div>
        )}
      </div>

      {file && (
        <div className="flex gap-3">
          <button onClick={() => { setFile(null); setResult(null) }} className="btn-secondary flex items-center gap-2">
            <LuX size={14} /> Clear
          </button>
          <button onClick={handleUpload} disabled={uploading} className="btn-primary flex-1 justify-center disabled:opacity-50">
            {uploading
              ? <><span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> Uploading…</>
              : <><LuUpload size={15} /> Upload Students</>}
          </button>
        </div>
      )}

      {/* Result */}
      {result && (
        <div className="card p-5" style={{
          border: `1px solid ${result.success ? 'var(--success-border)' : 'var(--danger-border)'}`,
          background: result.success ? 'var(--success-bg)' : 'var(--danger-bg)'
        }}>
          <div className="flex items-center gap-3 mb-3">
            {result.success
              ? <LuCircleCheck size={18} style={{ color: 'var(--success-text)' }} />
              : <LuTriangleAlert size={18} style={{ color: 'var(--danger-text)' }} />}
            <p className="text-sm font-semibold" style={{ color: result.success ? 'var(--success-text)' : 'var(--danger-text)' }}>
              {result.success ? 'Upload Successful' : 'Upload Failed'}
            </p>
          </div>
          {result.success && result.data && (
            <div className="text-xs space-y-1" style={{ color: 'var(--text-secondary)' }}>
              {result.data.totalInFile != null && <p>Total in file: <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{result.data.totalInFile}</span></p>}
              {result.data.inserted   != null && <p>Inserted: <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{result.data.inserted}</span></p>}
              {result.data.modified   != null && <p>Updated: <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{result.data.modified}</span></p>}
              {result.data.reactivated > 0 && <p>Restored (previously removed): <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{result.data.reactivated}</span></p>}
              {result.data.department && <p>Department: <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{result.data.department}</span></p>}
              {result.data.batch      && <p>Batch: <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>Batch {result.data.batch}</span></p>}
            </div>
          )}
          {result.error && <p className="text-xs" style={{ color: 'var(--danger-text)' }}>{result.error}</p>}
          {result.errors?.length > 0 && (
            <ul className="text-xs mt-2 space-y-1 list-disc pl-5 overflow-y-auto" style={{ color: 'var(--danger-text)', maxHeight: '14rem' }}>
              {result.errors.map((line, i) => <li key={i}>{line}</li>)}
            </ul>
          )}
        </div>
      )}

      {/* Format Guide */}
      <div className="card p-5">
        <h3 className="text-sm font-semibold mb-3" style={{ color: 'var(--text-primary)' }}>Expected JSON Format</h3>
        <pre className="code-block">
{`[
  {
    "studentId": "CST-001",
    "roll": "01",
    "name": "Alice Rahman"
  }
]`}
        </pre>
        <p className="text-xs mt-2" style={{ color: 'var(--text-muted)' }}>
          Department, batch, and shift are set above — no need to include them in the JSON.
        </p>
      </div>
    </div>
  )
}
