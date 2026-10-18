import { useEffect, useState } from 'react'
import { collegeAPI } from '@services/api'
import {
  normalizeQuery, shouldSearch, searchErrorMessage, isCanceled, SEARCH_DEBOUNCE_MS,
} from '@utils/collegeSearch'

/**
 * Debounced, cancel-safe college search.
 *
 * status: 'idle'    – query too short, nothing requested
 *         'loading' – waiting for the debounce or the response
 *         'success' – `results` is current (may be empty = "no results")
 *         'error'   – `error` holds a friendly message; call `retry()`
 *
 * Every keystroke aborts the previous request, and a response is only used if
 * it belongs to the CURRENT query, so slow answers can never overwrite newer ones.
 */
export function useCollegeSearch(rawQuery, { delay = SEARCH_DEBOUNCE_MS } = {}) {
  const query = normalizeQuery(rawQuery)
  const active = shouldSearch(query)
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState({ query: '', attempt: 0, status: 'idle', results: [], error: '' })

  useEffect(() => {
    if (!active) return undefined
    const ctrl = new AbortController()
    const timer = setTimeout(async () => {
      try {
        const res = await collegeAPI.search(query, { signal: ctrl.signal })
        const list = res.data?.data?.colleges
        if (!Array.isArray(list)) throw new Error('Unexpected response')
        setState({ query, attempt, status: 'success', results: list, error: '' })
      } catch (err) {
        if (isCanceled(err) || ctrl.signal.aborted) return
        setState({ query, attempt, status: 'error', results: [], error: searchErrorMessage(err) })
      }
    }, delay)
    return () => { clearTimeout(timer); ctrl.abort() }
  }, [query, active, attempt, delay])

  if (!active) return { status: 'idle', results: [], error: '', query, retry: () => {} }
  // A stored answer only counts if it is for this exact query + attempt;
  // otherwise we are still waiting (debounce or in-flight) -> 'loading'.
  const fresh = state.query === query && state.attempt === attempt
  return {
    status: fresh ? state.status : 'loading',
    results: fresh ? state.results : [],
    error: fresh ? state.error : '',
    query,
    retry: () => setAttempt((n) => n + 1),
  }
}
