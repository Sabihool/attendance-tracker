import { useEffect, useId, useRef, useState } from 'react'
import { LuSearch, LuX, LuMapPin, LuCircleCheck, LuTriangleAlert } from 'react-icons/lu'
import { useCollegeSearch } from '@hooks/useCollegeSearch'
import {
  MIN_QUERY_LENGTH, MAX_QUERY_LENGTH, formatCollegeMeta, moveIndex, toSelection,
} from '@utils/collegeSearch'

/**
 * Searchable college picker (autocomplete / ARIA combobox).
 *
 *   <CollegeSearchSelect value={college} onChange={setCollege} error={err} />
 *
 * `value` is null or { collegeId, name, district, country } — and it can ONLY
 * become non-null by choosing a result from the list. Typed text alone never
 * produces a value, so a form that requires `value` cannot be submitted with an
 * arbitrary college name. (The server re-checks the id anyway.)
 */
export default function CollegeSearchSelect({
  value, onChange, error, label = 'College', required = true, disabled = false, placeholder = 'Search your college…',
}) {
  const uid = useId()
  const inputId = `${uid}-input`
  const listId = `${uid}-list`
  const rootRef = useRef(null)
  const inputRef = useRef(null)

  const [text, setText] = useState('')
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)

  const { status, results, error: searchError, query, retry } = useCollegeSearch(value ? '' : text)

  const hasOptions = status === 'success' && results.length > 0
  const active = hasOptions ? Math.min(activeIndex, results.length - 1) : -1
  const optionId = (i) => `${uid}-opt-${i}`
  const showPanel = open && !value && !disabled

  // Keep the keyboard-highlighted option visible inside the scrollable list
  useEffect(() => {
    if (active >= 0) document.getElementById(optionId(active))?.scrollIntoView({ block: 'nearest' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active])

  const select = (college) => {
    onChange(toSelection(college))
    setText('')
    setOpen(false)
  }

  const clearSelection = () => {
    onChange(null)
    setText('')
    setActiveIndex(0)
    setOpen(true)
    requestAnimationFrame(() => inputRef.current?.focus())
  }

  const handleKeyDown = (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (!open) { setOpen(true); return }
      setActiveIndex(moveIndex(active, results.length, e.key === 'ArrowDown' ? 'down' : 'up'))
    } else if (e.key === 'Home' && hasOptions && open) {
      e.preventDefault(); setActiveIndex(moveIndex(active, results.length, 'home'))
    } else if (e.key === 'End' && hasOptions && open) {
      e.preventDefault(); setActiveIndex(moveIndex(active, results.length, 'end'))
    } else if (e.key === 'Enter') {
      // Never let Enter submit the surrounding form from this field
      e.preventDefault()
      if (open && active >= 0) select(results[active])
    } else if (e.key === 'Escape') {
      if (open) { e.preventDefault(); setOpen(false) }
    }
  }

  const handleBlur = (e) => {
    if (!rootRef.current?.contains(e.relatedTarget)) setOpen(false)
  }

  // What the panel says
  let body
  if (text.trim().length < MIN_QUERY_LENGTH) {
    body = <Message>Type at least {MIN_QUERY_LENGTH} characters to search.</Message>
  } else if (status === 'loading') {
    body = <Message><Spinner /> Searching…</Message>
  } else if (status === 'error') {
    body = (
      <div className="px-3.5 py-3 text-sm" style={{ color: 'var(--danger-text)' }}>
        <div className="flex items-start gap-2"><LuTriangleAlert size={15} className="mt-0.5 shrink-0" /><span>{searchError}</span></div>
        <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={retry}
          className="mt-2 text-xs font-semibold underline" style={{ color: 'var(--brand-primary)' }}>
          Try again
        </button>
      </div>
    )
  } else if (status === 'success' && results.length === 0) {
    body = (
      <Message>
        No colleges found for “{query}”. Check the spelling, or ask your college administrator whether it has been registered.
      </Message>
    )
  }

  // Screen-reader announcement
  const announce =
    !showPanel ? ''
    : status === 'loading' ? 'Searching'
    : status === 'error' ? searchError
    : status === 'success' ? (results.length ? `${results.length} college${results.length === 1 ? '' : 's'} found` : 'No colleges found')
    : ''

  return (
    <div ref={rootRef} onBlur={handleBlur}>
      <label htmlFor={inputId} className="block text-xs font-600 mb-1.5" style={{ color: 'var(--text-secondary)' }}>
        {label}{required && <span style={{ color: 'var(--danger)' }}> *</span>}
      </label>

      {value ? (
        <div className="flex items-center gap-3 rounded-[10px] px-3.5 py-2.5"
          style={{ background: 'var(--success-bg)', border: '1.5px solid var(--success-border)' }}>
          <LuCircleCheck size={18} className="shrink-0" style={{ color: 'var(--success)' }} />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold truncate" style={{ color: 'var(--text-primary)' }}>{value.name}</div>
            <div className="text-xs truncate" style={{ color: 'var(--text-muted)' }}>{formatCollegeMeta(value)}</div>
          </div>
          {!disabled && (
            <button type="button" onClick={clearSelection}
              className="text-xs font-semibold shrink-0 px-2 py-1 rounded-md"
              style={{ color: 'var(--brand-primary)' }}>
              Change
            </button>
          )}
        </div>
      ) : (
        <div className="relative">
          <LuSearch size={15} className="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" style={{ color: 'var(--text-muted)' }} />
          <input
            ref={inputRef}
            id={inputId}
            type="text"
            role="combobox"
            aria-expanded={showPanel}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={showPanel && active >= 0 ? optionId(active) : undefined}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? `${uid}-err` : undefined}
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            maxLength={MAX_QUERY_LENGTH}
            disabled={disabled}
            value={text}
            placeholder={placeholder}
            onChange={(e) => { setText(e.target.value); setActiveIndex(0); setOpen(true) }}
            onFocus={() => setOpen(true)}
            onKeyDown={handleKeyDown}
            className="input-field text-base sm:text-sm pl-9 pr-9"
            style={error ? { borderColor: 'var(--danger)' } : undefined}
          />
          {text && (
            <button type="button" aria-label="Clear search"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => { setText(''); setActiveIndex(0); inputRef.current?.focus() }}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 rounded"
              style={{ color: 'var(--text-muted)' }}>
              <LuX size={15} />
            </button>
          )}

          {showPanel && (
            <div className="absolute left-0 right-0 top-full mt-1.5 z-30 rounded-xl overflow-hidden"
              style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-dropdown)' }}>
              {hasOptions ? (
                <ul id={listId} role="listbox" aria-label="Matching colleges" className="max-h-64 overflow-y-auto py-1">
                  {results.map((c, i) => (
                    <li key={c.collegeId} id={optionId(i)} role="option" aria-selected={i === active}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => select(c)}
                      onMouseMove={() => i !== active && setActiveIndex(i)}
                      className="px-3.5 py-2.5 cursor-pointer"
                      style={{ background: i === active ? 'var(--brand-50)' : 'transparent' }}>
                      <div className="text-sm font-semibold truncate" style={{ color: 'var(--text-primary)' }}>{c.name}</div>
                      <div className="flex items-center gap-1 text-xs truncate" style={{ color: 'var(--text-muted)' }}>
                        <LuMapPin size={11} className="shrink-0" />{formatCollegeMeta(c)}
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <div id={listId}>{body}</div>
              )}
            </div>
          )}
        </div>
      )}

      <p className="sr-only" role="status" aria-live="polite">{announce}</p>
      {error && <p id={`${uid}-err`} className="text-xs mt-1.5" style={{ color: 'var(--danger-text)' }}>{error}</p>}
    </div>
  )
}

function Message({ children }) {
  return (
    <div className="px-3.5 py-3 text-sm flex items-center gap-2" style={{ color: 'var(--text-muted)' }}>
      {children}
    </div>
  )
}

function Spinner() {
  return <span className="w-3.5 h-3.5 border-2 rounded-full animate-spin shrink-0"
    style={{ borderColor: 'var(--border-strong)', borderTopColor: 'var(--brand-primary)' }} />
}
