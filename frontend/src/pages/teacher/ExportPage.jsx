/**
 * ExportPage.jsx — COLOR SYSTEM FIXED
 */
import { LuCalendar, LuChevronDown, LuDownload, LuFileText, LuGrid3X3, LuRefreshCw, LuTable } from 'react-icons/lu'
import { useState, useEffect } from 'react'

import toast from 'react-hot-toast'
import { useSubjects } from '@context/SubjectsContext'
import { exportAPI, downloadBlob, getErrorMessage } from '@services/api'

const FORMATS = [
  {
    key: 'pdf',   label: 'PDF Report',   icon: LuFileText, desc: 'Formatted PDF with attendance details',
    iconColor: 'var(--danger-text)', bg: 'var(--danger-bg)', border: 'var(--danger-border)',
  },
  {
    key: 'excel', label: 'Excel (.xlsx)', icon: LuTable,    desc: 'Multi-sheet workbook: summary, sessions, matrix',
    iconColor: 'var(--success-text)', bg: 'var(--success-bg)', border: 'var(--success-border)',
  },
  {
    key: 'csv',   label: 'CSV',          icon: LuGrid3X3,     desc: 'Raw data for analysis',
    iconColor: 'var(--brand-primary)', bg: 'var(--brand-50)', border: 'var(--brand-200)',
  },
]
const CSV_TYPES = [
  { value: 'summary',  label: 'Student Summary' },
  { value: 'sessions', label: 'Session Log' },
  { value: 'matrix',   label: 'Attendance Matrix' },
]

export default function ExportPage() {
  const { subjects, fetchSubjects } = useSubjects()
  const [subjectId, setSubjectId] = useState('')
  const [meta, setMeta]           = useState(null)
  const [loadingMeta, setLoadingMeta] = useState(false)
  const [downloading, setDownloading] = useState('')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate]     = useState('')
  const [csvType, setCsvType]     = useState('summary')

  useEffect(() => { fetchSubjects() }, [fetchSubjects])

  useEffect(() => {
    if (!subjectId) { setMeta(null); return }
    loadMeta()
  }, [subjectId])

  const loadMeta = async () => {
    setLoadingMeta(true)
    try {
      const res = await exportAPI.getMeta(subjectId)
      setMeta(res.data?.data || res.data)
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setLoadingMeta(false)
    }
  }

  const handleDownload = async (format) => {
    if (!subjectId) { toast.error('Select a subject first'); return }
    setDownloading(format)
    try {
      const params = {}
      if (startDate) params.startDate = startDate
      if (endDate)   params.endDate   = endDate
      if (format === 'csv') params.type = csvType
      let res, filename
      if (format === 'pdf') {
        res = await exportAPI.downloadPDF(subjectId, params)
        filename = `attendance_${subjectId}_report.pdf`
      } else if (format === 'excel') {
        res = await exportAPI.downloadExcel(subjectId, params)
        filename = `attendance_${subjectId}_report.xlsx`
      } else {
        res = await exportAPI.downloadCSV(subjectId, params)
        filename = `attendance_${subjectId}_${csvType}.csv`
      }
      downloadBlob(res.data, filename)
      toast.success(`${format.toUpperCase()} downloaded!`)
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setDownloading('')
    }
  }

  return (
    <div className="space-y-6 p-4 sm:p-6 max-w-4xl mx-auto">
      <div>
        <h1 className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>Export Reports</h1>
        <p className="text-sm mt-0.5" style={{ color: 'var(--text-muted)' }}>Download attendance data in multiple formats</p>
      </div>

      {/* Subject */}
      <div className="relative max-w-sm">
        <select value={subjectId} onChange={e => setSubjectId(e.target.value)} className="select-field">
          <option value="">— Select a subject —</option>
          {subjects.map(s => <option key={s._id} value={s._id}>{s.subjectName} ({s.subjectCode})</option>)}
        </select>
        <LuChevronDown size={14} className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" style={{ color: 'var(--text-muted)' }} />
      </div>

      {!subjectId ? (
        <div className="empty-state">
          <LuDownload size={40} className="empty-state-icon" />
          <p>Select a subject to export reports</p>
        </div>
      ) : (
        <>
          {/* Meta */}
          {loadingMeta ? (
            <div className="skeleton h-20 w-full" />
          ) : meta ? (
            <div className="card p-4 flex flex-wrap gap-4 items-center text-sm">
              <div><span style={{ color: 'var(--text-muted)' }}>Subject:</span>{' '}
                <span className="font-semibold" style={{ color: 'var(--text-primary)' }}>{meta.subjectName}</span></div>
              <div><span style={{ color: 'var(--text-muted)' }}>Sessions:</span>{' '}
                <span className="font-mono font-semibold" style={{ color: 'var(--text-primary)' }}>{meta.totalSessions}</span></div>
              <div><span style={{ color: 'var(--text-muted)' }}>Students:</span>{' '}
                <span className="font-mono font-semibold" style={{ color: 'var(--text-primary)' }}>{meta.totalStudents}</span></div>
              {meta.avgAttendance != null && (
                <div><span style={{ color: 'var(--text-muted)' }}>Avg:</span>{' '}
                  <span className="font-mono font-bold" style={{ color: 'var(--brand-primary)' }}>{Math.round(meta.avgAttendance)}%</span></div>
              )}
            </div>
          ) : null}

          {/* Date Filters */}
          <div className="card p-4">
            <p className="text-xs font-semibold uppercase tracking-wider mb-3 flex items-center gap-2" style={{ color: 'var(--text-muted)' }}>
              <LuCalendar size={12} /> Date Range (Optional)
            </p>
            <div className="flex gap-4 flex-wrap">
              <div>
                <label className="form-label">Start Date</label>
                <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} className="input-field" />
              </div>
              <div>
                <label className="form-label">End Date</label>
                <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)} className="input-field" />
              </div>
            </div>
          </div>

          {/* CSV Type */}
          <div className="card p-4">
            <p className="text-xs font-semibold uppercase tracking-wider mb-3" style={{ color: 'var(--text-muted)' }}>CSV Type</p>
            <div className="flex gap-2 flex-wrap">
              {CSV_TYPES.map(t => (
                <button key={t.value} onClick={() => setCsvType(t.value)}
                  className={`filter-tab ${csvType === t.value ? 'active' : ''}`}>
                  {t.label}
                </button>
              ))}
            </div>
          </div>

          {/* Format Buttons */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            {FORMATS.map(({ key, label, icon: Icon, desc, iconColor, bg, border }) => (
              <button key={key} onClick={() => handleDownload(key)} disabled={!!downloading}
                className="card p-5 text-left hover:scale-[1.02] transition-all disabled:opacity-50 disabled:cursor-not-allowed group"
                style={{ borderColor: border, background: bg }}>
                <Icon size={22} className="mb-3" style={{ color: iconColor }} />
                <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{label}</p>
                <p className="text-xs mt-1 mb-3" style={{ color: 'var(--text-muted)' }}>{desc}</p>
                <div className="flex items-center gap-2 text-xs font-semibold" style={{ color: iconColor }}>
                  {downloading === key ? (
                    <><span className="w-3 h-3 border-2 border-current/30 border-t-current rounded-full animate-spin" /> Downloading…</>
                  ) : (
                    <><LuDownload size={12} /> Download</>
                  )}
                </div>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
