/**
 * Pure helpers for the public "See Your Attendance" page (no React, no network),
 * unit-tested with `npm test`. Limits mirror backend/validators/publicLookupValidator.js.
 */
import { isValidSelection } from './collegeSearch.js'

export const LOOKUP_LIMITS = { department: 100, batch: 50, shift: 50, roll: 64 }
export const LOOKUP_FIELDS = ['department', 'batch', 'shift', 'roll']
const LABELS = { department: 'Department', batch: 'Batch', shift: 'Shift', roll: 'Roll' }

export const EMPTY_LOOKUP_FORM = { department: '', batch: '', shift: '', roll: '' }

/** Collapse inner whitespace and trim. Non-strings become ''. */
export const cleanField = (v) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '')

/** Returns { field: message } — empty object means the form can be submitted. */
export const validateLookupForm = (college, form) => {
  const errors = {}
  if (!isValidSelection(college)) errors.college = 'Search for your college and choose it from the list.'
  for (const f of LOOKUP_FIELDS) {
    const v = cleanField(form?.[f])
    if (!v) errors[f] = `${LABELS[f]} is required.`
    else if (v.length > LOOKUP_LIMITS[f]) errors[f] = `${LABELS[f]} is too long.`
  }
  return errors
}

/**
 * The request body. The college comes ONLY from the chosen search result; the
 * server re-validates it and never trusts any other id from the client.
 */
export const buildLookupPayload = (college, form) => ({
  collegeId: college.collegeId,
  department: cleanField(form.department),
  batch: cleanField(form.batch),
  shift: cleanField(form.shift),
  roll: cleanField(form.roll),
})

/** { kind, message } for a failed lookup, so the page can style "not found" differently from "try later". */
export const lookupError = (err) => {
  const status = err?.response?.status
  const serverMsg = err?.response?.data?.message
  if (!err?.response) return { kind: 'network', message: "Can't reach the server. Check your connection and try again." }
  if (status === 404) return { kind: 'notfound', message: serverMsg || "We couldn't find a student with those details." }
  if (status === 409) return { kind: 'ambiguous', message: serverMsg || 'More than one record matches. Please contact your college office.' }
  if (status === 429) return { kind: 'throttled', message: serverMsg || 'Too many attempts. Please wait a few minutes and try again.' }
  if (status === 400) return { kind: 'invalid', message: serverMsg || 'Please check the details you entered.', fields: err.response.data?.errors || {} }
  return { kind: 'server', message: 'Something went wrong. Please try again in a moment.' }
}

/** Colour family for an overall percentage / status label. */
export const statusTone = (status) => ({
  Excellent: 'success', Good: 'info', Warning: 'warning', Critical: 'danger',
}[status] || 'info')

export const percentLabel = (n) => `${Number.isFinite(n) ? Math.round(n) : 0}%`

/** Same bands the server uses for the status label (<50 Critical, <65 Warning, <75 Good). */
export const percentTone = (pct) => (pct < 50 ? 'danger' : pct < 65 ? 'warning' : pct < 75 ? 'info' : 'success')
