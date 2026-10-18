/**
 * DeleteSubjectModal.jsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Permanent subject deletion flow (spec: "Mandatory Backup Before Deletion").
 *
 * Flow:
 *  1. Show a strong warning listing exactly what permanent deletion removes.
 *  2. Offer PDF / CSV / ZIP downloads of the subject's attendance records.
 *  3. The acknowledgment checkbox only becomes clickable once at least one
 *     backup has actually been downloaded.
 *  4. "Delete Permanently" only enables once the checkbox is checked.
 *  5. On confirm, calls onConfirm() — the backend independently re-checks
 *     an `acknowledged: true` flag before actually deleting anything.
 */
import { LuTriangleAlert, LuDownload, LuFileText, LuFileDown, LuFileArchive, LuLoaderCircle, LuCircleCheck } from 'react-icons/lu'
import { useState } from 'react'

import toast from 'react-hot-toast'
import { exportAPI, downloadBlob, getErrorMessage } from '@services/api'

const WARNING_ITEMS = [
  'Delete the subject permanently.',
  'Delete all attendance sessions and records (including trashed ones).',
  'Remove all student credits earned from this subject.',
  "Recalculate every affected student's Credit Score automatically.",
  'Update attendance statistics and dashboards.',
  'Remove all alerts and reports related to this subject.',
  'This action cannot be undone.',
]

const DOWNLOAD_OPTIONS = [
  { key: 'pdf', label: 'PDF', icon: LuFileText, color: '#DC2626', bg: '#FEF2F2', border: '#FECACA' },
  { key: 'csv', label: 'CSV', icon: LuFileDown, color: '#6D5EF7', bg: '#F4F1FF', border: '#DDD6FE' },
  { key: 'zip', label: 'ZIP (PDF + CSV)', icon: LuFileArchive, color: '#16A34A', bg: '#F0FDF4', border: '#BBF7D0' },
]

export default function DeleteSubjectModal({ subject, onConfirm, onCancel }) {
  const [downloading, setDownloading] = useState(null) // which key is downloading
  const [downloaded, setDownloaded] = useState(false)
  const [checked, setChecked] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const handleDownload = async (key) => {
    setDownloading(key)
    try {
      const code = subject.subjectCode || subject._id
      let res, filename
      if (key === 'pdf') {
        res = await exportAPI.downloadRegisterPDF(subject._id)
        filename = `${code}_Attendance_Register.pdf`
      } else if (key === 'csv') {
        res = await exportAPI.downloadCSV(subject._id, { type: 'matrix' })
        filename = `${code}_Attendance_Data.csv`
      } else {
        res = await exportAPI.downloadRegisterZip(subject._id)
        filename = `${code}_Attendance.zip`
      }
      downloadBlob(res.data, filename)
      setDownloaded(true)
      toast.success(`${key.toUpperCase()} downloaded!`)
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setDownloading(null)
    }
  }

  const handleDelete = async () => {
    if (!checked || deleting) return
    setDeleting(true)
    await onConfirm()
    setDeleting(false)
  }

  return (
    <div className="modal-overlay">
      <div className="modal-card max-w-lg p-6 space-y-4 max-h-[90vh] overflow-y-auto" style={{ border: '1px solid var(--danger-border)' }}>
        <div className="flex items-start gap-3">
          <div className="w-11 h-11 rounded-xl flex items-center justify-center shrink-0"
            style={{ background: 'var(--danger-bg)', border: '1px solid var(--danger-border)' }}>
            <LuTriangleAlert size={20} style={{ color: 'var(--danger-text)' }} />
          </div>
          <div>
            <h3 className="font-semibold" style={{ color: 'var(--text-primary)' }}>
              Permanently delete "{subject.subjectName}"?
            </h3>
            <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
              This is <span className="font-semibold">not</span> a soft delete or archive. This will:
            </p>
          </div>
        </div>

        <ul className="text-xs space-y-1.5 pl-1" style={{ color: 'var(--text-secondary)' }}>
          {WARNING_ITEMS.map((item) => (
            <li key={item} className="flex gap-2">
              <span style={{ color: 'var(--danger-text)' }}>•</span>
              <span>{item}</span>
            </li>
          ))}
        </ul>

        <div className="rounded-xl p-3 space-y-2.5" style={{ background: 'var(--warning-bg)', border: '1px solid var(--warning-border)' }}>
          <p className="text-xs font-semibold" style={{ color: 'var(--warning-text)' }}>
            Please download a backup of this subject's attendance records before continuing.
          </p>
          <div className="grid grid-cols-3 gap-2">
            {DOWNLOAD_OPTIONS.map(({ key, label, icon: Icon, color, bg, border }) => (
              <button
                key={key}
                onClick={() => handleDownload(key)}
                disabled={downloading !== null}
                className="flex flex-col items-center gap-1 p-2.5 rounded-lg border transition-all disabled:opacity-60"
                style={{ borderColor: border, background: bg, color }}
              >
                {downloading === key ? <LuLoaderCircle size={16} className="animate-spin" /> : <Icon size={16} />}
                <span className="text-[11px] font-semibold text-center leading-tight">{label}</span>
              </button>
            ))}
          </div>
          {downloaded && (
            <p className="text-xs flex items-center gap-1.5" style={{ color: 'var(--warning-text)' }}>
              <LuCircleCheck size={13} /> Backup downloaded.
            </p>
          )}
        </div>

        <label
          className="flex items-start gap-2.5 text-xs p-2.5 rounded-lg"
          style={{
            background: 'var(--bg-muted)',
            color: downloaded ? 'var(--text-primary)' : 'var(--text-muted)',
            cursor: downloaded ? 'pointer' : 'not-allowed',
          }}
        >
          <input
            type="checkbox"
            checked={checked}
            disabled={!downloaded}
            onChange={(e) => setChecked(e.target.checked)}
            className="mt-0.5"
          />
          <span>I have downloaded the attendance records and understand this action cannot be undone.</span>
        </label>

        <div className="flex gap-3 pt-1">
          <button onClick={onCancel} disabled={deleting} className="btn-secondary flex-1 justify-center">Cancel</button>
          <button
            onClick={handleDelete}
            disabled={!checked || deleting}
            className="btn-danger flex-1 justify-center disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {deleting ? <><LuLoaderCircle size={14} className="animate-spin" /> Deleting…</> : <><LuDownload size={14} className="rotate-180" /> Delete Permanently</>}
          </button>
        </div>
      </div>
    </div>
  )
}
