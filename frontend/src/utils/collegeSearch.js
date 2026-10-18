/**
 * Pure helpers for the college selector (no React, no network) so they can be
 * unit-tested with `npm test`. Limits mirror backend/utils/collegeSearch.js.
 */
export const MIN_QUERY_LENGTH = 2
export const MAX_QUERY_LENGTH = 80
export const SEARCH_DEBOUNCE_MS = 300

/** Trim and collapse whitespace; non-strings become ''. */
export const normalizeQuery = (q) =>
  typeof q === 'string' ? q.replace(/\s+/g, ' ').trim().slice(0, MAX_QUERY_LENGTH) : ''

/** Only hit the API once there is something worth searching for. */
export const shouldSearch = (q) => normalizeQuery(q).length >= MIN_QUERY_LENGTH

/** "Feni, Bangladesh" — District, Country line shown under the name. */
export const formatCollegeMeta = (c) =>
  [c?.district, c?.country].filter(Boolean).join(', ')

/** Wrap-around keyboard navigation. Returns -1 when there is nothing to move to. */
export const moveIndex = (current, length, direction) => {
  if (!length) return -1
  if (direction === 'home') return 0
  if (direction === 'end') return length - 1
  const step = direction === 'up' ? -1 : 1
  const base = current < 0 ? (step === 1 ? -1 : 0) : current
  return (base + step + length) % length
}

/** Keep only the public fields of a search hit — what the form stores. */
export const toSelection = (c) => ({
  collegeId: c.collegeId, name: c.name, district: c.district, country: c.country,
})

/** A usable selection must come from a search result and carry an id. */
export const isValidSelection = (c) =>
  !!c && typeof c.collegeId === 'string' && /^COL-[A-Z0-9]{10}$/.test(c.collegeId) && !!c.name

/** Friendly message for a failed search request. */
export const searchErrorMessage = (err) => {
  if (err?.response?.status === 429) return 'Too many searches. Please wait a moment and try again.'
  if (err && !err.response) return "Can't reach the server. Check your connection and try again."
  return err?.response?.data?.message || 'Could not load colleges. Please try again.'
}

export const isCanceled = (err) =>
  err?.code === 'ERR_CANCELED' || err?.name === 'CanceledError' || err?.name === 'AbortError'
