// ---------------------------------------------------------------------------
// SELECT — the system's own dropdown, used instead of a native <select>.
//
// A native select paints its popup with the operating system's widget, which
// lands on the page looking nothing like the rest of the app. This is the same
// control drawn with our own surfaces: a bordered trigger that matches the
// text inputs, and a floating panel of options in the app's theme.
//
// It keeps the parts of the native control that matter: keyboard operation
// (arrows / Home / End / Enter / Escape), click-outside to dismiss, and a
// panel that flips above the trigger when there is no room below.
// ---------------------------------------------------------------------------
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'

export interface SelectOption {
  value: string
  label: string
  /** Richer row for the panel (a tag pill, say). Falls back to `label`. */
  node?: ReactNode
}

/**
 * The same control, but several rows can be ticked at once — one piece
 * rate that pays two tiers, or the same job at three stations. The panel
 * stays open while ticking and the trigger names everything chosen; the
 * rows are never shortened inside the panel, however long a tag name is.
 */
export function MultiSelect({
  values,
  onChange,
  options,
  placeholder = 'Select…',
  block = false,
  ariaLabel,
  invalid = false,
}: {
  values: string[]
  onChange: (values: string[]) => void
  options: SelectOption[]
  placeholder?: string
  block?: boolean
  ariaLabel?: string
  invalid?: boolean
}) {
  // Where the panel sits on the screen. It is placed against the window
  // rather than inside the trigger, so a window that scrolls its own
  // content — the create-rates grid, say — cannot cut the list off.
  const [at, setAt] = useState<{ left: number; top: number; width: number } | null>(null)
  const open = at !== null
  const rootRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent) {
      const t = e.target as Node
      if (!rootRef.current?.contains(t) && !menuRef.current?.contains(t)) setAt(null)
    }
    function onKey(e: globalThis.KeyboardEvent) {
      if (e.key === 'Escape') setAt(null)
    }
    const away = () => setAt(null)
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    window.addEventListener('resize', away)
    window.addEventListener('scroll', away, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', away)
      window.removeEventListener('scroll', away, true)
    }
  }, [open])

  function toggleOpen() {
    if (open) return setAt(null)
    const r = rootRef.current?.getBoundingClientRect()
    if (!r) return
    const height = Math.min(264, options.length * 38 + 10)
    const below = window.innerHeight - r.bottom
    setAt({
      left: r.left,
      top: below < height + 12 ? Math.max(8, r.top - height - 5) : r.bottom + 5,
      width: r.width,
    })
  }

  const chosen = options.filter((o) => values.includes(o.value))
  const label = chosen.map((o) => o.label).join(', ')

  function toggle(value: string) {
    onChange(values.includes(value) ? values.filter((v) => v !== value) : [...values, value])
  }

  return (
    <div
      ref={rootRef}
      className={`ui-select multi ${block ? 'block' : ''} ${open ? 'open' : ''} ${invalid ? 'invalid' : ''}`}
    >
      <button
        type="button"
        className="ui-select-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        title={label || placeholder}
        onClick={toggleOpen}
      >
        <span className={`ui-select-value ${chosen.length ? '' : 'placeholder'}`}>
          {label || placeholder}
        </span>
        <svg className="ui-select-caret" width="14" height="14" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>

      {at && (
        <div
          ref={menuRef}
          className="ui-select-menu floating"
          role="listbox"
          aria-multiselectable
          style={{ left: at.left, top: at.top, minWidth: at.width }}
        >
          {options.length === 0 && <div className="ui-select-empty">Nothing to pick.</div>}
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              role="option"
              aria-selected={values.includes(o.value)}
              className="ui-select-option"
              onClick={() => toggle(o.value)}
            >
              <span className="ui-select-box" aria-hidden="true">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                  strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round">
                  <path d="m5 12 5 5 9-9" />
                </svg>
              </span>
              <span className="ui-select-option-label">{o.node ?? o.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export default function Select({
  value,
  onChange,
  options,
  placeholder = 'Select…',
  disabled = false,
  block = false,
  className = '',
  ariaLabel,
  title,
  invalid = false,
}: {
  value: string
  onChange: (value: string) => void
  options: SelectOption[]
  placeholder?: string
  disabled?: boolean
  /** Fill the width of the parent cell instead of sitting at its own width. */
  block?: boolean
  className?: string
  ariaLabel?: string
  title?: string
  invalid?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const [flipUp, setFlipUp] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  const selected = options.find((o) => o.value === value) ?? null

  // Dismiss on a click anywhere else, or on Escape.
  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    function onKey(e: globalThis.KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  // Keep the highlighted row in view while arrowing through a long list.
  useEffect(() => {
    if (!open) return
    menuRef.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [open, active])

  function openMenu(start?: number) {
    if (disabled) return
    const rect = rootRef.current?.getBoundingClientRect()
    if (rect) {
      const below = window.innerHeight - rect.bottom
      setFlipUp(below < 260 && rect.top > below)
    }
    const i = start ?? options.findIndex((o) => o.value === value)
    setActive(i >= 0 ? i : 0)
    setOpen(true)
  }

  function choose(i: number) {
    const o = options[i]
    if (!o) return
    onChange(o.value)
    setOpen(false)
  }

  function onKeyDown(e: KeyboardEvent) {
    if (disabled) return
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        openMenu()
      }
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((i) => (i + 1) % Math.max(options.length, 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((i) => (i - 1 + options.length) % Math.max(options.length, 1))
    } else if (e.key === 'Home') {
      e.preventDefault()
      setActive(0)
    } else if (e.key === 'End') {
      e.preventDefault()
      setActive(options.length - 1)
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      choose(active)
    } else if (e.key === 'Tab') {
      setOpen(false)
    }
  }

  return (
    <div
      ref={rootRef}
      className={`ui-select ${block ? 'block' : ''} ${open ? 'open' : ''} ${invalid ? 'invalid' : ''} ${className}`}
    >
      <button
        type="button"
        className="ui-select-trigger"
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={onKeyDown}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        title={title ?? selected?.label ?? placeholder}
      >
        <span className={`ui-select-value ${selected ? '' : 'placeholder'}`}>
          {selected ? selected.node ?? selected.label : placeholder}
        </span>
        <svg className="ui-select-caret" width="14" height="14" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>

      {open && (
        <div ref={menuRef} className={`ui-select-menu ${flipUp ? 'up' : ''}`} role="listbox" tabIndex={-1}>
          {options.length === 0 && <div className="ui-select-empty">Nothing to pick.</div>}
          {options.map((o, i) => (
            <button
              key={o.value}
              type="button"
              role="option"
              aria-selected={o.value === value}
              data-active={i === active}
              className="ui-select-option"
              onMouseEnter={() => setActive(i)}
              onClick={() => choose(i)}
            >
              <span className="ui-select-option-label">{o.node ?? o.label}</span>
              <svg className="tick" width="14" height="14" viewBox="0 0 24 24" fill="none"
                stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                <path d="m5 12 5 5 9-9" />
              </svg>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
