import { LuChevronDown, LuCircleCheck, LuDownload, LuFileDown, LuFileSpreadsheet, LuFileText, LuLoaderCircle, LuX } from 'react-icons/lu'
import { useState, useEffect } from 'react'

import toast from 'react-hot-toast'
import { useSubjects } from '@context/SubjectsContext'
import { exportAPI, downloadBlob, getErrorMessage } from '@services/api'

const FORMAT_META = {
  PDF:   { icon: LuFileText,        color: '#DC2626', bg: '#FEF2F2', border: '#FECACA' },
  Excel: { icon: LuFileSpreadsheet, color: '#16A34A', bg: '#F0FDF4', border: '#BBF7D0' },
  CSV:   { icon: LuFileDown,        color: '#6D5EF7', bg: '#F4F1FF', border: '#DDD6FE' },
}

export default function ExportModal({ onClose }) {
  const { subjects, fetchSubjects } = useSubjects()
  const [format, setFormat]       = useState('')
  const [subjectId, setSubjectId] = useState('')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate]     = useState('')
  const [csvType, setCsvType]     = useState('summary')
  const [exporting, setExporting] = useState(false)
  const [done, setDone]           = useState(false)
  const [lastFile, setLastFile]   = useState('')

  useEffect(() => { fetchSubjects() }, [fetchSubjects])
  useEffect(() => {
    const h = e => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose])

  const canExport = !!format && !!subjectId

  async function handleExport() {
    if (!canExport) return
    setExporting(true)
    try {
      const params = {}
      if (startDate) params.startDate = startDate
      if (endDate)   params.endDate   = endDate
      if (format === 'CSV') params.type = csvType
      const sub = subjects.find(s => s._id === subjectId)
      const code = sub?.subjectCode || subjectId
      let res, filename
      if (format === 'PDF') {
        res = await exportAPI.downloadPDF(subjectId, params)
        filename = `attendance_${code}_report.pdf`
      } else if (format === 'Excel') {
        res = await exportAPI.downloadExcel(subjectId, params)
        filename = `attendance_${code}_report.xlsx`
      } else {
        res = await exportAPI.downloadCSV(subjectId, params)
        filename = `attendance_${code}_${csvType}.csv`
      }
      downloadBlob(res.data, filename)
      setLastFile(filename)
      setExporting(false)
      setDone(true)
      toast.success(`${format} downloaded!`)
    } catch (err) {
      setExporting(false)
      toast.error(getErrorMessage(err))
    }
  }

  if (done) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div className="absolute inset-0 bg-black/30" onClick={onClose} />
        <div className="relative card p-7 text-center w-full max-w-sm" style={{ boxShadow: 'var(--shadow-dropdown)' }}>
          <div className="w-14 h-14 rounded-full flex items-center justify-center mx-auto mb-4"
            style={{ background: '#F0FDF4', border: '1.5px solid #BBF7D0' }}>
            <LuCircleCheck size={26} style={{ color: '#16A34A' }} />
          </div>
          <h3 className="text-lg font-bold mb-1" style={{ color: 'var(--text-primary)' }}>Export Complete</h3>
          <p className="text-sm mb-3" style={{ color: 'var(--text-muted)' }}>Your file has been downloaded.</p>
          <p className="text-xs font-mono px-3 py-2 rounded-lg mb-5 break-all"
            style={{ background: 'var(--bg-muted)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}>
            {lastFile}
          </p>
          <div className="flex gap-2.5">
            <button onClick={() => { setDone(false); setFormat(''); setSubjectId('') }} className="btn-secondary flex-1 justify-center">Export Another</button>
            <button onClick={onClose} className="btn-primary flex-1 justify-center">Close</button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="relative card w-full max-w-md max-h-[90vh] flex flex-col" style={{ boxShadow: 'var(--shadow-dropdown)' }}>
        {exporting && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center rounded-[18px]"
            style={{ background: 'rgba(255,255,255,0.92)' }}>
            <LuLoaderCircle size={28} className="animate-spin mb-3" style={{ color: 'var(--brand-primary)' }} />
            <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Generating {format}…</p>
          </div>
        )}
        <div className="flex items-center justify-between px-5 py-3.5" style={{ borderBottom: '1px solid var(--border)' }}>
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: 'var(--bg-muted)' }}>
              <LuDownload size={15} style={{ color: 'var(--brand-primary)' }} />
            </div>
            <h2 className="font-bold text-sm" style={{ color: 'var(--text-primary)' }}>Export Data</h2>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg transition-colors" style={{ color: 'var(--text-muted)' }}
            onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-muted)' }}
            onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}>
            <LuX size={16} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          <div>
            <p className="text-xs font-600 uppercase tracking-wider mb-2.5" style={{ color: 'var(--text-muted)' }}>Format</p>
            <div className="grid grid-cols-3 gap-2">
              {['PDF', 'Excel', 'CSV'].map(f => {
                const meta = FORMAT_META[f]
                const Icon = meta.icon
                const selected = format === f
                return (
                  <button key={f} onClick={() => setFormat(f)}
                    className="flex flex-col items-center gap-1.5 p-3.5 rounded-xl border-2 transition-all"
                    style={{ borderColor: selected ? meta.color : 'var(--border)', background: selected ? meta.bg : 'var(--bg-card)', color: selected ? meta.color : 'var(--text-muted)' }}>
                    <Icon size={20} /><span className="text-xs font-semibold">{f}</span>
                  </button>
                )
              })}
            </div>
          </div>
          <div>
            <p className="text-xs font-600 uppercase tracking-wider mb-2" style={{ color: 'var(--text-muted)' }}>Subject</p>
            <div className="relative">
              <select value={subjectId} onChange={e => setSubjectId(e.target.value)} className="input-field appearance-none pr-8 cursor-pointer">
                <option value="">— Select subject —</option>
                {subjects.map(s => <option key={s._id} value={s._id}>{s.subjectCode} · {s.subjectName}</option>)}
              </select>
              <LuChevronDown size={13} className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" style={{ color: 'var(--text-muted)' }} />
            </div>
          </div>
          <div>
            <p className="text-xs font-600 uppercase tracking-wider mb-2" style={{ color: 'var(--text-muted)' }}>Date Range <span style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>(optional)</span></p>
            <div className="grid grid-cols-2 gap-2">
              <div><p className="text-xs mb-1" style={{ color: 'var(--text-muted)' }}>From</p><input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} className="input-field" /></div>
              <div><p className="text-xs mb-1" style={{ color: 'var(--text-muted)' }}>To</p><input type="date" value={endDate} onChange={e => setEndDate(e.target.value)} className="input-field" /></div>
            </div>
          </div>
          {format === 'CSV' && (
            <div>
              <p className="text-xs font-600 uppercase tracking-wider mb-2" style={{ color: 'var(--text-muted)' }}>CSV Type</p>
              <div className="flex gap-2 flex-wrap">
                {[{ v: 'summary', l: 'Summary' }, { v: 'sessions', l: 'Sessions' }, { v: 'matrix', l: 'Matrix' }].map(({ v, l }) => (
                  <button key={v} onClick={() => setCsvType(v)}
                    className="text-xs px-3 py-1.5 rounded-full border transition-all font-medium"
                    style={{ background: csvType === v ? 'var(--brand-primary)' : 'var(--bg-card)', color: csvType === v ? '#fff' : 'var(--text-secondary)', borderColor: csvType === v ? 'var(--brand-primary)' : 'var(--border)' }}>
                    {l}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
        <div className="px-5 py-3.5 flex gap-2.5" style={{ borderTop: '1px solid var(--border)' }}>
          <button onClick={onClose} className="btn-ghost">Cancel</button>
          <button onClick={handleExport} disabled={!canExport || exporting}
            className="btn-primary flex-1 justify-center disabled:opacity-50 disabled:cursor-not-allowed">
            {exporting ? <><LuLoaderCircle size={14} className="animate-spin" />Exporting…</> : <><LuDownload size={14} />Export {format || 'File'}</>}
          </button>
        </div>
      </div>
    </div>
  )
}
