import { useEffect, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { supabase, type Grade, type Station } from '../lib/supabase'
import {
  ALL_CAPABILITIES,
  CAPABILITY_OPTIONS,
  DEFAULT_MODULES,
  MODULE_OPTIONS,
  effectiveCapabilities,
  nextTagColor,
  sortCapabilities,
  tagClass,
} from '../lib/tags'
import { useWideShell } from '../lib/useWideShell'

import AuditLogTab from './settings/AuditLogTab'

type Tab = 'tags' | 'audit'

export default function Settings() {
  const { profile } = useAuth()
  const [tab, setTab] = useState<Tab>('tags')
  // Settings holds wide tables, so it reaches past the narrow page cap —
  // but with a real margin left on each side, not hard against the window.
  const wideStyle = useWideShell(64)
  // The audit log's RLS only answers to admins/managers — showing the tab
  // to anyone else would just render an empty (confusing) table.
  const canAudit = profile?.role === 'admin' || profile?.role === 'manager'

  return (
    <div className="stack" style={wideStyle}>
      <div>
        <Link to="/" className="small muted backlink">← Back to main page</Link>
        {/* The top bar carries the module name ("Settings"), so the page
            heading carries the system name — the two swapped places. */}
        <h1>Piece Rate &amp; Payroll System</h1>
      </div>

      <div className="tabs glass">
        <button className={`tab ${tab === 'tags' ? 'active' : ''}`} onClick={() => setTab('tags')}>
          Tier &amp; Station Tags setting
        </button>
        {canAudit && (
          <button className={`tab ${tab === 'audit' ? 'active' : ''}`} onClick={() => setTab('audit')}>
            Audit trail record
          </button>
        )}
      </div>

      {tab === 'tags' && <TagsTab />}
      {tab === 'audit' && canAudit && <AuditLogTab />}
    </div>
  )
}

/* ------------------------------------------------------------------ */

function TagsTab() {
  const { profile } = useAuth()
  const [grades, setGrades] = useState<Grade[]>([])
  const [stations, setStations] = useState<Station[]>([])
  const [dragId, setDragId] = useState<string | null>(null)
  const [editor, setEditor] = useState<'closed' | 'new' | Grade>('closed')
  // Read-only look at one tier's access — the "Can do" list left the table
  // so the summary stays short.
  const [viewer, setViewer] = useState<Grade | null>(null)
  const [addingStation, setAddingStation] = useState(false)
  const [stationName, setStationName] = useState('')
  const [dragStation, setDragStation] = useState<string | null>(null)
  const [stationEditor, setStationEditor] = useState<Station | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  async function load() {
    const [g, st] = await Promise.all([
      supabase.from('grades').select('*').order('sort_order'),
      supabase.from('stations').select('*').order('sort_order'),
    ])
    const err = g.error || st.error
    if (err) setError(err.message)
    setGrades(((g.data ?? []) as Grade[]).sort((a, b) => a.sort_order - b.sort_order))
    setStations(st.data ?? [])
    setLoading(false)
  }

  useEffect(() => {
    load()
  }, [])

  // Each admin function is granted separately per tier by the super admin
  // (tier 1): add new tag, move tag tiers, edit tags' settings, manage
  // stations. Admins and tier 1 always have everything.
  const myGrade = profile?.grade_id ? grades.find((g) => g.id === profile.grade_id) ?? null : null
  const myTier = myGrade?.sort_order ?? null
  const myCaps = effectiveCapabilities(myGrade)
  const isSuperUser = profile?.role === 'admin' || myTier === 1
  const canAddTag = isSuperUser || myCaps.includes('tag-add')
  const canMoveTags = isSuperUser || myCaps.includes('tag-move')
  const canEditTags = isSuperUser || myCaps.includes('tag-edit')
  // A granted (non-super) user may only touch tags BELOW their own tier —
  // they can never promote themselves or change their superiors.
  const rowEditable = (g: Grade) =>
    g.sort_order !== 1 && (isSuperUser || (myTier !== null && g.sort_order > myTier))
  const canManageStations =
    profile?.role === 'admin' || profile?.role === 'manager' ||
    myTier === 1 || myCaps.includes('station-create')

  // Drop a dragged tag onto another: reorder locally, then renumber every
  // tier 1..n so tier numbers always run top-down with no gaps.
  async function dropOnTag(targetId: string) {
    if (!dragId || dragId === targetId) return
    const dragged = grades.find((g) => g.id === dragId)!
    const target = grades.find((g) => g.id === targetId)
    // The tier-1 tag is the super admin — pinned at #1: it can't be moved
    // and nothing can be dropped above it. Granted users may only move
    // tags below their own tier.
    if (!target || !rowEditable(dragged) || !rowEditable(target)) {
      setDragId(null)
      return
    }
    const movingDown = grades.findIndex((g) => g.id === dragId) < grades.findIndex((g) => g.id === targetId)
    const next = grades.filter((g) => g.id !== dragId)
    next.splice(next.findIndex((g) => g.id === targetId) + (movingDown ? 1 : 0), 0, dragged)
    setDragId(null)
    setGrades(next.map((g, i) => ({ ...g, sort_order: i + 1 })))
    const results = await Promise.all(
      next.map((g, i) => supabase.from('grades').update({ sort_order: i + 1 }).eq('id', g.id)),
    )
    const err = results.find((r) => r.error)
    if (err?.error) setError(err.error.message)
    load()
  }

  async function removeTag(g: Grade) {
    if (!window.confirm(`Delete tag "${g.name}"? This fails if it is in use.`)) return
    const { error } = await supabase.from('grades').delete().eq('id', g.id)
    if (error) setError(error.message)
    else load()
  }

  async function addStation(e: FormEvent) {
    e.preventDefault()
    setError(null)
    const sort = Math.max(0, ...stations.map((x) => x.sort_order)) + 1
    const { error } = await supabase
      .from('stations')
      .insert({ name: stationName.trim(), sort_order: sort })
    if (error) return setError(error.message)
    setStationName('')
    setAddingStation(false)
    load()
  }

  // Reorder the station list by dragging (display sequence only).
  async function dropOnStation(targetId: string) {
    if (!dragStation || dragStation === targetId) return
    const movingDown =
      stations.findIndex((x) => x.id === dragStation) < stations.findIndex((x) => x.id === targetId)
    const next = stations.filter((x) => x.id !== dragStation)
    const dragged = stations.find((x) => x.id === dragStation)!
    next.splice(next.findIndex((x) => x.id === targetId) + (movingDown ? 1 : 0), 0, dragged)
    setDragStation(null)
    setStations(next.map((x, i) => ({ ...x, sort_order: i + 1 })))
    const results = await Promise.all(
      next.map((x, i) => supabase.from('stations').update({ sort_order: i + 1 }).eq('id', x.id)),
    )
    const err = results.find((r) => r.error)
    if (err?.error) setError(err.error.message)
    load()
  }

  async function removeStation(st: Station) {
    if (!window.confirm(`Delete station "${st.name}"? This fails if it is in use.`)) return
    const { error } = await supabase.from('stations').delete().eq('id', st.id)
    if (error) setError(error.message)
    else load()
  }

  if (loading) return <p className="muted">Loading…</p>

  return (
    <div className="stack">
      {error && <div className="error">{error}</div>}

      {/* Section 1 — tier tags */}
      <div className="card stack">
        <div className="row-form spread">
          <h3>Tier tags</h3>
          {canAddTag && (
            <button className="btn" onClick={() => setEditor('new')}>+ Add tag</button>
          )}
        </div>

        <table className="table">
          <thead>
            <tr>
              {canMoveTags && <th></th>}
              <th>Tier</th>
              <th>Tag</th>
              <th className="right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {grades.length === 0 && (
              <tr><td colSpan={4} className="muted">No tags yet.</td></tr>
            )}
            {grades.map((g) => {
              const isSuper = g.sort_order === 1
              const movable = canMoveTags && rowEditable(g)
              const editable = canEditTags && (isSuper ? isSuperUser : rowEditable(g))
              return (
                <tr
                  key={g.id}
                  className={`${movable ? 'drag-row' : ''} ${dragId === g.id ? 'dragging' : ''}`}
                  draggable={movable}
                  onDragStart={() => movable && setDragId(g.id)}
                  onDragEnd={() => setDragId(null)}
                  onDragOver={(e) => canMoveTags && e.preventDefault()}
                  onDrop={(e) => {
                    if (!canMoveTags) return
                    e.preventDefault()
                    dropOnTag(g.id)
                  }}
                  title={isSuper ? 'Super admin — always tier 1' : movable ? 'Drag to change tier' : undefined}
                >
                  {canMoveTags && (
                    <td className="drag-handle" aria-hidden="true">{isSuper ? '📌' : movable ? '⠿' : ''}</td>
                  )}
                  <td className="muted">{g.sort_order}</td>
                  <td><span className={tagClass(g.color)}>{g.name}</span></td>
                  <td className="right">
                    <span className="row-actions">
                      <button
                        className="icon-btn sm"
                        title="View what this tier can see and do"
                        aria-label={`View access of ${g.name}`}
                        onClick={() => setViewer(g)}
                      >
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                          strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M1.5 12S5 5.5 12 5.5 22.5 12 22.5 12 19 18.5 12 18.5 1.5 12 1.5 12Z" />
                          <circle cx="12" cy="12" r="3" />
                        </svg>
                      </button>
                      {canEditTags && editable && (
                        <>
                          <button
                            className="icon-btn sm"
                            title="Edit tag"
                            aria-label={`Edit ${g.name}`}
                            onClick={() => setEditor(g)}
                          >
                            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                              strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
                            </svg>
                          </button>
                          {!isSuper && (
                            <button
                              className="icon-btn sm danger"
                              title="Delete tag"
                              aria-label={`Delete ${g.name}`}
                              onClick={() => removeTag(g)}
                            >
                              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                                strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
                                <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                                <path d="M10 11v6M14 11v6" />
                              </svg>
                            </button>
                          )}
                        </>
                      )}
                    </span>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* Section 2 — station tags */}
      <div className="card stack">
        <div className="row-form spread">
          <h3>Station tags</h3>
          {canManageStations && (
            <button
              className="btn"
              onClick={() => {
                setStationName('')
                setAddingStation((v) => !v)
              }}
            >
              {addingStation ? 'Cancel' : '+ Add station'}
            </button>
          )}
        </div>

        {addingStation && (
          <form className="row-form" onSubmit={addStation}>
            <label className="field inline grow">
              <span>New station name</span>
              <input value={stationName} onChange={(e) => setStationName(e.target.value)} autoFocus required />
            </label>
            <button className="btn" type="submit">Save station</button>
          </form>
        )}

        <table className="table">
          <thead>
            <tr>
              {canManageStations && <th></th>}
              <th>#</th>
              <th>Station</th>
              <th>Requirement</th>
              {canManageStations && <th className="right">Actions</th>}
            </tr>
          </thead>
          <tbody>
            {stations.map((st, i) => (
              <tr
                key={st.id}
                className={`${canManageStations ? 'drag-row' : ''} ${dragStation === st.id ? 'dragging' : ''}`}
                draggable={canManageStations}
                onDragStart={() => canManageStations && setDragStation(st.id)}
                onDragEnd={() => setDragStation(null)}
                onDragOver={(e) => canManageStations && e.preventDefault()}
                onDrop={(e) => {
                  if (!canManageStations) return
                  e.preventDefault()
                  dropOnStation(st.id)
                }}
                title={canManageStations ? 'Drag to reorder' : undefined}
              >
                {canManageStations && <td className="drag-handle" aria-hidden="true">⠿</td>}
                <td className="muted">{i + 1}</td>
                <td>{st.name}</td>
                <td className="muted small">
                  {st.hourly_count
                    ? `Hourly · min ${st.hourly_min_prev ?? 0} prev hr · max ${st.hourly_target ?? 6}/hr`
                    : '—'}
                </td>
                {canManageStations && (
                  <td className="right">
                    <button
                      className="icon-btn sm"
                      title="Edit station"
                      aria-label={`Edit ${st.name}`}
                      onClick={() => setStationEditor(st)}
                    >
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                        strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
                      </svg>
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {stationEditor && (
        <StationEditModal
          station={stationEditor}
          onClose={() => setStationEditor(null)}
          onSaved={() => {
            setStationEditor(null)
            load()
          }}
          onDelete={async () => {
            await removeStation(stationEditor)
            setStationEditor(null)
          }}
        />
      )}

      {viewer && <TagViewModal grade={viewer} onClose={() => setViewer(null)} />}

      {editor !== 'closed' && (
        <TagEditModal
          grade={editor === 'new' ? null : editor}
          nextTier={Math.max(0, ...grades.map((g) => g.sort_order)) + 1}
          usedColors={grades.map((g) => g.color)}
          onClose={() => setEditor('closed')}
          onSaved={() => {
            setEditor('closed')
            load()
          }}
        />
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Tag view pop-out: what ONE tier can see and do, read only. Opened  */
/* by the eye button — the tier tags table stays a short summary.     */
/* ------------------------------------------------------------------ */

function TagViewModal({ grade, onClose }: { grade: Grade; onClose: () => void }) {
  // Tier 1 is the super admin: every module, every ability, always.
  const isSuper = grade.sort_order === 1
  const caps = isSuper ? [...ALL_CAPABILITIES] : sortCapabilities(grade.capabilities ?? [])
  const mods = isSuper ? MODULE_OPTIONS.map((m) => m.key) : grade.modules ?? []
  // Only the groups this tier actually holds something in, so the sheet
  // reads as "what it CAN do" rather than a mostly-empty checklist.
  const groups = CAPABILITY_OPTIONS.reduce<Record<string, string[]>>((acc, c) => {
    if (!caps.includes(c.key)) return acc
    ;(acc[c.group] ??= []).push(c.label)
    return acc
  }, {})

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="row-form spread">
          <h2>Tier access</h2>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        <div className="row-form" style={{ gap: '0.5rem', alignItems: 'center' }}>
          <span className={tagClass(grade.color)}>{grade.name}</span>
          <span className="muted small">tier {grade.sort_order}</span>
        </div>

        {isSuper && (
          <p className="muted small" style={{ margin: 0 }}>
            The super admin tier — every module and every ability, always.
          </p>
        )}

        <div className="tag-section">
          <div className="tag-section-title">Can see</div>
          {mods.length === 0 ? (
            <p className="tag-section-hint">No web modules — this tier sees the mobile view only.</p>
          ) : (
            <div className="cap-cols">
              {MODULE_OPTIONS.filter((m) => mods.includes(m.key)).map((m) => (
                <span key={m.key} className="small">· {m.label}</span>
              ))}
            </div>
          )}
          <p className="tag-section-hint">
            Data always follows the fixed rule: this tier and every tier below it;
            station tags narrow it to those stations.
          </p>
        </div>

        <div className="tag-section">
          <div className="tag-section-title">Can do</div>
          {caps.length === 0 ? (
            <p className="tag-section-hint">Nothing granted — this tier can view only.</p>
          ) : (
            Object.entries(groups).map(([group, labels]) => (
              <div key={group} className="cap-group">
                <div className="cap-group-name">{group}</div>
                {labels.map((l) => (
                  <span key={l} className="small">· {l}</span>
                ))}
              </div>
            ))
          )}
        </div>

        <div className="row-form" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn ghost" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Station edit pop-out: name + the work requirement preset shown in  */
/* the mobile view (hourly stamp card).                               */
/* ------------------------------------------------------------------ */

function StationEditModal({
  station,
  onClose,
  onSaved,
  onDelete,
}: {
  station: Station
  onClose: () => void
  onSaved: () => void
  onDelete: () => void
}) {
  const [name, setName] = useState(station.name)
  const [hourly, setHourly] = useState(Boolean(station.hourly_count))
  const [minPrevInput, setMinPrevInput] = useState(String(station.hourly_min_prev ?? 0))
  const [targetInput, setTargetInput] = useState(String(station.hourly_target ?? 6))
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  async function save(e: FormEvent) {
    e.preventDefault()
    setError(null)
    const target = Number(targetInput)
    const minPrev = Number(minPrevInput)
    if (hourly && (!Number.isInteger(target) || target < 1 || target > 60)) {
      return setError('Max work done this hour must be a whole number between 1 and 60.')
    }
    if (hourly && (!Number.isInteger(minPrev) || minPrev < 0 || minPrev > 60)) {
      return setError('Min work done from previous hour must be a whole number between 0 and 60.')
    }
    setSaving(true)
    const { error } = await supabase
      .from('stations')
      .update({
        name: name.trim(),
        hourly_count: hourly,
        hourly_target: hourly ? target : station.hourly_target ?? 6,
        hourly_min_prev: hourly ? minPrev : station.hourly_min_prev ?? 0,
      })
      .eq('id', station.id)
    setSaving(false)
    if (error) return setError(error.message)
    onSaved()
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={save}>
        <div className="row-form spread">
          <h2>Edit station</h2>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        {error && <div className="error">{error}</div>}

        <label className="field">
          <span>Station name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} autoFocus required />
        </label>

        <div className="field">
          <span>Work requirement (shown in the mobile view)</span>
          <label className="checkbox small" style={{ margin: 0 }}>
            <input type="checkbox" checked={hourly} onChange={(e) => setHourly(e.target.checked)} />{' '}
            Hourly count — records are counted per hour (stamp card)
          </label>
        </div>

        {hourly && (
          <div className="row-form">
            <label className="field inline grow">
              <span>1. Min work done from previous hour</span>
              <input
                inputMode="numeric"
                value={minPrevInput}
                onChange={(e) => setMinPrevInput(e.target.value)}
                placeholder="0"
                required
              />
            </label>
            <label className="field inline grow">
              <span>2. Work done in this hour (max)</span>
              <input
                inputMode="numeric"
                value={targetInput}
                onChange={(e) => setTargetInput(e.target.value)}
                placeholder="6"
                required
              />
            </label>
          </div>
        )}
        {hourly && (
          <p className="muted small" style={{ margin: 0 }}>
            When the previous hour reaches its minimum, this hour's stamps become
            bonus reward stamps.
          </p>
        )}

        <div className="row-form spread">
          <button
            type="button"
            className="btn ghost danger"
            onClick={onDelete}
          >
            Delete station
          </button>
          <span className="row-form">
            <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
            <button className="btn" type="submit" disabled={saving}>
              {saving ? 'Saving…' : 'Save station'}
            </button>
          </span>
        </div>
      </form>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Tag edit pop-out: name, colour plate, what it can see, what it can */
/* do.                                                                */
/* ------------------------------------------------------------------ */

function TagEditModal({
  grade,
  nextTier,
  usedColors,
  onClose,
  onSaved,
}: {
  grade: Grade | null
  nextTier: number
  usedColors: string[]
  onClose: () => void
  onSaved: () => void
}) {
  // Tier 1 is the super admin: every ability, always — the checkboxes are
  // shown ticked and locked.
  const isSuper = grade?.sort_order === 1
  const [name, setName] = useState(grade?.name ?? '')
  // Colours are issued automatically and stay unique across tiers — an
  // existing tag keeps its colour, a new tag takes the next free one.
  const color = grade?.color ?? nextTagColor(usedColors)
  // Which web modules this TIER can see — the master switch. The per-user
  // checkboxes in User access can only narrow it further for one person.
  const [modules, setModules] = useState<string[]>(
    isSuper ? MODULE_OPTIONS.map((m) => m.key) : grade?.modules ?? [...DEFAULT_MODULES],
  )
  const [capabilities, setCapabilities] = useState<string[]>(
    isSuper ? [...ALL_CAPABILITIES] : sortCapabilities(grade?.capabilities ?? ['data-entry']),
  )
  const ability = grade?.ability ?? ''
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  function toggleCapability(key: string) {
    if (isSuper) return
    setCapabilities((c) => (c.includes(key) ? c.filter((k) => k !== key) : [...c, key]))
  }

  function toggleModule(key: string) {
    if (isSuper) return
    setModules((m) => (m.includes(key) ? m.filter((k) => k !== key) : [...m, key]))
  }

  async function save(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setSaving(true)
    // Saved in the standardized order so "Can do" always reads the same,
    // no matter what sequence the boxes were ticked in.
    const caps = isSuper ? [...ALL_CAPABILITIES] : sortCapabilities(capabilities)
    const mods = isSuper
      ? MODULE_OPTIONS.map((m) => m.key)
      : MODULE_OPTIONS.map((m) => m.key).filter((k) => modules.includes(k))
    const fields = { name: name.trim(), color, modules: mods, capabilities: caps, ability: ability || null }
    const { error } = grade
      ? await supabase.from('grades').update(fields).eq('id', grade.id)
      : await supabase.from('grades').insert({ ...fields, sort_order: nextTier })
    setSaving(false)
    if (error) return setError(error.message)
    onSaved()
  }

  // One checkbox row per capability of a group — shared by every section.
  const capBoxes = (group: string) =>
    CAPABILITY_OPTIONS.filter((c) => c.group === group).map((c) => (
      <label key={c.key} className="checkbox small" style={{ margin: 0 }}>
        <input
          type="checkbox"
          checked={capabilities.includes(c.key)}
          disabled={isSuper}
          onChange={() => toggleCapability(c.key)}
        />{' '}
        {c.label}
      </label>
    ))

  return (
    <div className="modal-overlay" onClick={onClose}>
      <form className="modal modal-wide" onClick={(e) => e.stopPropagation()} onSubmit={save}>
        <div className="row-form spread">
          <h2>{grade ? 'Edit tag' : 'New tag'}</h2>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        {error && <div className="error">{error}</div>}
        {isSuper && (
          <p className="muted small" style={{ margin: 0 }}>
            This tag is the super admin — it always has every ability, sees every
            module, and stays at tier 1.
          </p>
        )}

        <div className="row-form">
          <label className="field grow">
            <span>Tag name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} autoFocus required />
          </label>
          <div className="field">
            <span>Colour (auto-issued)</span>
            <span className={tagClass(color)} style={{ alignSelf: 'flex-start' }}>
              {name.trim() || 'preview'}
            </span>
          </div>
        </div>

        {/* Right below the tag name, as requested: who this tier may manage. */}
        <div className="tag-section">
          <div className="tag-section-title">User setting</div>
          {capBoxes('User setting')}
          <p className="tag-section-hint">
            Lets this tier manage people in every team from Worker Management,
            not just their own.
          </p>
        </div>

        <div className="tag-section">
          <div className="tag-section-title">Can see</div>
          <p className="tag-section-hint">
            Data always follows the fixed rule: this tier and every tier below it;
            station tags narrow it to those stations. Tick the web modules this
            tier sees.
          </p>
          <div className="cap-cols">
            {MODULE_OPTIONS.map((m) => (
              <label key={m.key} className="checkbox small" style={{ margin: 0 }}>
                <input
                  type="checkbox"
                  checked={modules.includes(m.key)}
                  disabled={isSuper}
                  onChange={() => toggleModule(m.key)}
                />{' '}
                {m.label}
              </label>
            ))}
            {capBoxes('View setting')}
          </div>
        </div>

        <div className="tag-cols">
          <div className="tag-section">
            <div className="tag-section-title">Work entry setting</div>
            {capBoxes('Work entry setting')}
          </div>
          <div className="tag-section">
            <div className="tag-section-title">Piece rate setting</div>
            {capBoxes('Piece rate setting')}
          </div>
        </div>

        <div className="tag-cols">
          <div className="tag-section">
            <div className="tag-section-title">Tag management setting</div>
            {capBoxes('Tag management setting')}
          </div>
          <div className="tag-section">
            <div className="tag-section-title">Station setting</div>
            {capBoxes('Station setting')}
            <p className="tag-section-hint">
              Only tags and users below this tier can be added, moved or edited.
            </p>
          </div>
        </div>

        <div className="tag-section">
          <div className="tag-section-title">Worker management setting</div>
          {capBoxes('Worker management setting')}
          <p className="tag-section-hint">
            Adding a new sign-up to their OWN team needs no tick — every leader
            can do that. These open up the wider functions.
          </p>
        </div>

        <div className="row-form" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn" type="submit" disabled={saving}>
            {saving ? 'Saving…' : grade ? 'Save tag' : 'Create tag'}
          </button>
        </div>
      </form>
    </div>
  )
}
