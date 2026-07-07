import { useEffect, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import {
  supabase,
  type Grade,
  type Profile,
  type Role,
  type Station,
} from '../lib/supabase'
import { DEFAULT_MODULES, MODULE_OPTIONS, TAG_COLORS, tagClass } from '../lib/tags'

type Tab = 'access' | 'tags'

// Role (route access) follows the tier tag so the panel only needs tags.
function roleForTier(tier: number | null, name?: string): Role {
  if (tier === null) return 'operator'
  if (tier <= 2) return 'manager'
  if (tier === 3 || (name ?? '').toLowerCase().includes('engineer')) return 'engineer'
  return 'operator'
}

export default function Settings() {
  const [tab, setTab] = useState<Tab>('access')

  return (
    <div className="stack">
      <div>
        <Link to="/" className="small muted backlink">← Back to main page</Link>
        <h1>Settings</h1>
        <p className="muted">
          User access and tags. Stations live in the{' '}
          <Link to="/piece-rate">Piece Rate module</Link>.
        </p>
      </div>

      <div className="tabs">
        <button className={`tab ${tab === 'access' ? 'active' : ''}`} onClick={() => setTab('access')}>
          User access
        </button>
        <button className={`tab ${tab === 'tags' ? 'active' : ''}`} onClick={() => setTab('tags')}>
          Tags management
        </button>
      </div>

      {tab === 'access' && <UserAccessTab />}
      {tab === 'tags' && <TagsTab />}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* User access: every signed-up email, what they can see and do.      */
/* Admin-only — RLS also enforces this on the backend.                */
/* ------------------------------------------------------------------ */

function UserAccessTab() {
  const { profile } = useAuth()
  const isAdmin = profile?.role === 'admin'
  const [profiles, setProfiles] = useState<Profile[]>([])
  const [stations, setStations] = useState<Station[]>([])
  const [grades, setGrades] = useState<Grade[]>([])
  const [tagInfo, setTagInfo] = useState<Grade | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  async function load() {
    const [p, s, g] = await Promise.all([
      supabase.from('access_profiles').select('*').order('email'),
      supabase.from('stations').select('id, name, sort_order').order('sort_order'),
      supabase.from('grades').select('*').order('sort_order'),
    ])
    const err = p.error || s.error || g.error
    if (err) setError(err.message)
    setProfiles((p.data ?? []) as Profile[])
    setStations(s.data ?? [])
    setGrades(((g.data ?? []) as Grade[]).sort((a, b) => a.sort_order - b.sort_order))
    setLoading(false)
  }

  useEffect(() => {
    load()
  }, [])

  async function update(p: Profile, fields: Partial<Profile>) {
    const { error } = await supabase.from('access_profiles').update(fields).eq('id', p.id)
    if (error) setError(error.message)
    else load()
  }

  if (!isAdmin) {
    return (
      <div className="card">
        <p className="muted">Only admins can manage user access.</p>
      </div>
    )
  }
  if (loading) return <p className="muted">Loading…</p>

  const label = (p: Profile) => p.email ?? p.full_name ?? p.id.slice(0, 8)
  const tierOf = (p: Profile) =>
    p.grade_id ? grades.find((g) => g.id === p.grade_id)?.sort_order ?? null : null
  // Approval steps follow the tags: tier 1 (Management) approves, tier 2
  // (Manager) verifies — assigned in the control panel below.
  const approvalUsers = profiles.filter((p) => tierOf(p) === 1)
  const verifyUsers = profiles.filter((p) => tierOf(p) === 2)
  // Untagged (newly signed-up) users first so they get set up quickly, then
  // everyone else in tag tier order.
  const sortedProfiles = [...profiles].sort((a, b) => {
    const ta = tierOf(a) ?? 0
    const tb = tierOf(b) ?? 0
    return ta - tb || (a.email ?? '').localeCompare(b.email ?? '')
  })

  return (
    <div className="stack">
      {error && <div className="error">{error}</div>}

      <div className="grid-2">
        {/* 1 — who verifies and who approves, derived from the tags set in
            the control panel below */}
        <div className="card stack compact approval-card">
          <h3>Piece rate approval</h3>
          <div className="field">
            <span>Verify by</span>
            {verifyUsers.length === 0
              ? <p className="muted small" style={{ margin: 0 }}>No one yet — tag a user as tier 2.</p>
              : verifyUsers.map((p) => <div className="small" key={p.id}>{label(p)}</div>)}
          </div>
          <div className="field">
            <span>Approval by</span>
            {approvalUsers.length === 0
              ? <p className="muted small" style={{ margin: 0 }}>No one yet — tag a user as tier 1.</p>
              : approvalUsers.map((p) => <div className="small" key={p.id}>{label(p)}</div>)}
          </div>
        </div>

        {/* 2 — the tags; click one to see what it can see and do */}
        <div className="card stack compact">
          <h3>Tags</h3>
          <div className="tag-list">
            {grades.map((g) => (
              <button className="tag-row" key={g.id} onClick={() => setTagInfo(g)}>
                <span className={`tag-dot dot-${g.color}`} aria-hidden="true" />
                <span>{g.name}</span>
              </button>
            ))}
          </div>
        </div>
      </div>

      {tagInfo && (
        <div className="modal-overlay" onClick={() => setTagInfo(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="row-form spread">
              <h2><span className={tagClass(tagInfo.color)}>{tagInfo.name}</span></h2>
              <button type="button" className="modal-close" onClick={() => setTagInfo(null)} aria-label="Close">×</button>
            </div>
            <p className="muted small">Tier {tagInfo.sort_order} (1 is highest) — sees its own tier and every tier below it.</p>
            <div className="field">
              <span>Can see</span>
              <p style={{ margin: 0 }}>
                {(tagInfo.modules ?? DEFAULT_MODULES)
                  .map((k) => MODULE_OPTIONS.find((m) => m.key === k)?.label ?? k)
                  .join(', ')}
              </p>
            </div>
            <div className="field">
              <span>Can do</span>
              <p style={{ margin: 0 }}>{tagInfo.ability ?? 'Not described yet — set it in Tags management.'}</p>
            </div>
          </div>
        </div>
      )}

      {/* 3 — every signed-up account, untagged first then by tier */}
      <div className="card stack">
        <h3>User access control panel</h3>
        <p className="muted small">
          Accounts appear here when someone signs up (default: Operator). Users still
          without a tag are listed first — appoint their tags; the tags decide what
          they see.
        </p>
        <table className="table">
          <thead>
            <tr>
              <th>Email</th>
              <th>Station tag</th>
              <th>Tier tag</th>
            </tr>
          </thead>
          <tbody>
            {sortedProfiles.length === 0 && (
              <tr><td colSpan={3} className="muted">No sign-ups yet.</td></tr>
            )}
            {sortedProfiles.map((p) => (
              <tr key={p.id}>
                <td>
                  {label(p)}{' '}
                  {!p.grade_id && <span className="badge new">new — set tag</span>}
                </td>
                <td>
                  <StationMultiSelect
                    stations={stations}
                    value={p.station_ids ?? (p.station_id ? [p.station_id] : [])}
                    onChange={(ids) =>
                      update(p, { station_ids: ids, station_id: ids[0] ?? null })
                    }
                  />
                </td>
                <td>
                  <select
                    value={p.grade_id ?? ''}
                    onChange={(e) => {
                      const gradeId = e.target.value || null
                      const g = grades.find((x) => x.id === gradeId)
                      const fields: Partial<Profile> = { grade_id: gradeId }
                      // Keep route access in step with the tier (admins stay admin).
                      if (p.role !== 'admin') {
                        fields.role = roleForTier(g?.sort_order ?? null, g?.name)
                      }
                      update(p, fields)
                    }}
                  >
                    <option value="">—</option>
                    {grades.map((g) => (
                      <option key={g.id} value={g.id}>{g.name}</option>
                    ))}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Tags: grade tags with colour + ability (the access legend).        */
/* ------------------------------------------------------------------ */
/* Pick any number of station tags for a user (none = all stations).  */
/* ------------------------------------------------------------------ */

function StationMultiSelect({
  stations,
  value,
  onChange,
}: {
  stations: Station[]
  value: string[]
  onChange: (ids: string[]) => void
}) {
  const [open, setOpen] = useState(false)
  const label =
    value.length === 0
      ? 'All stations'
      : value.length === 1
        ? stations.find((s) => s.id === value[0])?.name ?? '1 station'
        : `${value.length} stations`

  function toggle(id: string) {
    onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id])
  }

  return (
    <div className="multi-select">
      <button type="button" className="btn ghost multi-toggle" onClick={() => setOpen((v) => !v)}>
        {label} ▾
      </button>
      {open && (
        <div className="multi-panel" onMouseLeave={() => setOpen(false)}>
          <label className="checkbox small" style={{ margin: 0 }}>
            <input
              type="checkbox"
              checked={value.length === 0}
              onChange={() => onChange([])}
            />{' '}
            All stations
          </label>
          {stations.map((s) => (
            <label className="checkbox small" key={s.id} style={{ margin: 0 }}>
              <input
                type="checkbox"
                checked={value.includes(s.id)}
                onChange={() => toggle(s.id)}
              />{' '}
              {s.name}
            </label>
          ))}
        </div>
      )}
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

  // Only admins or tier-1 (Management) users may reorder, add, edit or
  // delete tags — the database enforces the same rule.
  const myTier = profile?.grade_id
    ? grades.find((g) => g.id === profile.grade_id)?.sort_order ?? null
    : null
  const canEditTags = profile?.role === 'admin' || myTier === 1
  const canManageStations = profile?.role === 'admin' || profile?.role === 'manager'

  // Drop a dragged tag onto another: reorder locally, then renumber every
  // tier 1..n so tier numbers always run top-down with no gaps.
  async function dropOnTag(targetId: string) {
    if (!dragId || dragId === targetId) return
    const movingDown = grades.findIndex((g) => g.id === dragId) < grades.findIndex((g) => g.id === targetId)
    const next = grades.filter((g) => g.id !== dragId)
    const dragged = grades.find((g) => g.id === dragId)!
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
          {canEditTags && (
            <button className="btn" onClick={() => setEditor('new')}>+ Add tag</button>
          )}
        </div>

        <table className="table">
          <thead>
            <tr>
              {canEditTags && <th></th>}
              <th>Tier</th>
              <th>Tag</th>
              <th>Can see</th>
              <th>Can do</th>
              {canEditTags && <th className="right">Actions</th>}
            </tr>
          </thead>
          <tbody>
            {grades.length === 0 && (
              <tr><td colSpan={6} className="muted">No tags yet.</td></tr>
            )}
            {grades.map((g) => (
              <tr
                key={g.id}
                className={`${canEditTags ? 'drag-row' : ''} ${dragId === g.id ? 'dragging' : ''}`}
                draggable={canEditTags}
                onDragStart={() => canEditTags && setDragId(g.id)}
                onDragEnd={() => setDragId(null)}
                onDragOver={(e) => canEditTags && e.preventDefault()}
                onDrop={(e) => {
                  if (!canEditTags) return
                  e.preventDefault()
                  dropOnTag(g.id)
                }}
                title={canEditTags ? 'Drag to change tier' : undefined}
              >
                {canEditTags && <td className="drag-handle" aria-hidden="true">⠿</td>}
                <td className="muted">{g.sort_order}</td>
                <td><span className={tagClass(g.color)}>{g.name}</span></td>
                <td className="muted small">
                  {(g.modules ?? DEFAULT_MODULES)
                    .map((k) => MODULE_OPTIONS.find((m) => m.key === k)?.label ?? k)
                    .join(', ')}
                </td>
                <td className="muted small">{g.ability ?? '—'}</td>
                {canEditTags && (
                  <td className="right">
                    <button className="linkbtn" onClick={() => setEditor(g)}>Edit</button>{' '}
                    <button className="linkbtn danger" onClick={() => removeTag(g)}>Delete</button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted small">
          Tier 1 is the highest. {canEditTags
            ? 'Drag rows up or down to change tiers — each tag sees its own tier and every tier below it.'
            : 'Only Management (tier 1) or admins can change tags.'}
        </p>
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
        <p className="muted small">
          A user with a station tag only sees that station's information.
        </p>
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

      {editor !== 'closed' && (
        <TagEditModal
          grade={editor === 'new' ? null : editor}
          nextTier={Math.max(0, ...grades.map((g) => g.sort_order)) + 1}
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
  onClose,
  onSaved,
}: {
  grade: Grade | null
  nextTier: number
  onClose: () => void
  onSaved: () => void
}) {
  const [name, setName] = useState(grade?.name ?? '')
  const [color, setColor] = useState(grade?.color ?? 'blue')
  const [modules, setModules] = useState<string[]>(grade?.modules ?? [...DEFAULT_MODULES])
  const ability = grade?.ability ?? ''
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  function toggleModule(key: string) {
    setModules((m) => (m.includes(key) ? m.filter((k) => k !== key) : [...m, key]))
  }

  async function save(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setSaving(true)
    const fields = { name: name.trim(), color, modules, ability: ability || null }
    const { error } = grade
      ? await supabase.from('grades').update(fields).eq('id', grade.id)
      : await supabase.from('grades').insert({ ...fields, sort_order: nextTier })
    setSaving(false)
    if (error) return setError(error.message)
    onSaved()
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={save}>
        <div className="row-form spread">
          <h2>{grade ? 'Edit tag' : 'New tag'}</h2>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        {error && <div className="error">{error}</div>}

        <label className="field">
          <span>Tag name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} autoFocus required />
        </label>

        <div className="field">
          <span>Colour</span>
          <div className="color-plate">
            {TAG_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                className={`color-swatch dot-${c} ${color === c ? 'selected' : ''}`}
                onClick={() => setColor(c)}
                title={c}
                aria-label={c}
              />
            ))}
          </div>
        </div>

        <div className="field">
          <span>Can see (modules shown on the web)</span>
          <div className="stack" style={{ gap: '0.3rem' }}>
            {MODULE_OPTIONS.map((m) => (
              <label key={m.key} className="checkbox small" style={{ margin: 0 }}>
                <input
                  type="checkbox"
                  checked={modules.includes(m.key)}
                  onChange={() => toggleModule(m.key)}
                />{' '}
                {m.label}
              </label>
            ))}
          </div>
        </div>

        <div className="field">
          <span>Can do (preset — not editable)</span>
          <p className="muted small" style={{ margin: 0 }}>
            {grade?.ability ?? 'Follows the tier: sees own tier and below; tier 2 verifies and tier 1 approves new piece rates.'}
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
