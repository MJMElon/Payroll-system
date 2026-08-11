import { useEffect, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { supabase, type Grade, type Station } from '../lib/supabase'
import { DEFAULT_GEOFENCE_M } from '../lib/geo'
import {
  ALL_CAPABILITIES,
  ALL_ENTITLEMENTS,
  CAPABILITY_GROUPS,
  CAPABILITY_OPTIONS,
  DEFAULT_MODULES,
  ENTITLEMENT_OPTIONS,
  GROUP_MODULE,
  MANAGEMENT_ONLY_GROUPS,
  MODULE_GROUP,
  MODULE_OPTIONS,
  MODULE_VIEW,
  VIEW_SCOPES,
  canGiveTier,
  defaultEntitlements,
  effectiveEntitlements,
  nextTagColor,
  roleForTier,
  runsWholeMill,
  stationTierOf,
  sortCapabilities,
  tagClass,
  viewableTierIds,
  type ViewScope,
} from '../lib/tags'
import { useOverlayClose } from '../lib/useOverlayClose'
import { useWideShell } from '../lib/useWideShell'

import AuditLogTab from './settings/AuditLogTab'

type Tab = 'tags' | 'audit'
/** Which face of a row's pop-out is showing. */
type Mode = 'view' | 'edit'
/** Just enough of a Piece Rate work type to say it is holding a station. */
type StationJob = { id: string; name: string; station_id: string; active: boolean }

/**
 * Postgres refuses to delete a row something still points at, and reports
 * it as a raw constraint violation — "violates foreign key constraint
 * jobs_station_id_fkey on table jobs" tells the user nothing about what
 * to do. Name what is holding the row instead, and where to go and clear
 * it. The trailing `on table "x"` is the table doing the holding.
 */
const HELD_BY: Record<string, string> = {
  jobs: 'work types in the Piece Rate module',
  piece_rates: 'piece rates in the Piece Rate module',
  production_entries: 'work records in the Operation module',
  access_profiles: 'people it is tagged to',
  teams: 'teams in Team Manage',
  payroll_lines: 'payroll lines',
  payroll_adjustments: 'payroll adjustments',
  photo_records: 'photo records',
}

function deleteError(err: { code?: string; message: string }, what: string): string {
  if (err.code !== '23503') return err.message
  const table = /on table "([^"]+)"\s*$/.exec(err.message)?.[1]
  const holder = (table && HELD_BY[table]) ?? (table ? `records in ${table}` : 'other records')
  return `${what} is still used by ${holder}, so it cannot be deleted. Remove or move those first, then delete it here.`
}

/**
 * Names are compared with case and surrounding space ignored: "Operator"
 * and " operator " are the same tag to a person reading a dropdown, so
 * they must not both exist.
 */
/** Enter commits an inline row, Escape abandons it. */
function rowKeys(e: React.KeyboardEvent, save: () => void, cancel: () => void) {
  if (e.key === 'Enter') {
    e.preventDefault()
    save()
  } else if (e.key === 'Escape') {
    e.preventDefault()
    cancel()
  }
}

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()

/**
 * The database has the last word on uniqueness — two people saving the
 * same name at once would slip past a check made against the list on
 * screen. Say it in the same words as that check.
 */
function saveError(err: { code?: string; message: string }, what: string, name: string): string {
  if (err.code !== '23505') return err.message
  return `A ${what} called "${name.trim()}" already exists.`
}

/** What tier 1 is for, shown under its name on both faces. */
const MANAGEMENT_NOTE =
  'Able to create, delete and do setting of tags for ALL tiers & stations.'

/* Row action icons — shared by the tier tag and station tag tables. */
const iconProps = {
  width: 15,
  height: 15,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const

const EyeIcon = () => (
  <svg {...iconProps}>
    <path d="M1.5 12S5 5.5 12 5.5 22.5 12 22.5 12 19 18.5 12 18.5 1.5 12 1.5 12Z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
)
const PencilIcon = () => (
  <svg {...iconProps}>
    <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
  </svg>
)
const TrashIcon = () => (
  <svg {...iconProps}>
    <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
    <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
    <path d="M10 11v6M14 11v6" />
  </svg>
)
const PinIcon = () => (
  <svg {...iconProps}>
    <path d="M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 0 1 16 0Z" />
    <circle cx="12" cy="10" r="3" />
  </svg>
)

export default function Settings() {
  const { profile } = useAuth()
  const [tab, setTab] = useState<Tab>('tags')
  // Settings reaches past the narrow page cap, but only so far: wide
  // margins, and a ceiling so the cards stop stretching on a big screen.
  const wideStyle = useWideShell(96, 1280)
  // The audit log's RLS only answers to admins/managers — showing the tab
  // to anyone else would just render an empty (confusing) table.
  const canAudit = profile?.role === 'admin' || profile?.role === 'manager'

  return (
    <div className="stack" style={wideStyle}>
      {/* Way out on the left, title centred over the page. */}
      <div className="page-head">
        <Link to="/" className="btn ghost backlink-btn">← Back to main page</Link>
        <h1>Settings</h1>
      </div>

      <div className="tabs glass">
        <button className={`tab ${tab === 'tags' ? 'active' : ''}`} onClick={() => setTab('tags')}>
          Tier &amp; Station Tags Setting
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
  // Work types point at a station, which is what stops a station tag being
  // deleted. Loading them lets the page SAY what is in the way, by name.
  const [jobs, setJobs] = useState<StationJob[]>([])
  const [dragId, setDragId] = useState<string | null>(null)
  // One pop-out per row, opening on either face: `view` is read-only and
  // closes with the × alone, `edit` has Cancel (back to view) and Save.
  // A null grade is a tag being created, which has no view to fall back to.
  const [tagModal, setTagModal] = useState<{ grade: Grade | null; mode: Mode } | null>(null)
  const [addingStation, setAddingStation] = useState(false)
  const [stationName, setStationName] = useState('')
  const [dragStation, setDragStation] = useState<string | null>(null)
  // A station is one field, so it is edited in the row rather than in a
  // pop-out: this is the row being edited, and the name being typed.
  const [editStationId, setEditStationId] = useState<string | null>(null)
  const [stationDraft, setStationDraft] = useState('')
  // The station whose preset coordinate is being set (the pin action).
  const [coordStation, setCoordStation] = useState<Station | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  async function load() {
    const [g, st, j] = await Promise.all([
      supabase.from('shared_grades').select('*').order('sort_order'),
      supabase.from('shared_stations').select('*').order('sort_order'),
      supabase.from('piece_rate_jobs').select('id, name, station_id, active').order('name'),
    ])
    const err = g.error || st.error
    if (err) setError(err.message)
    setGrades(((g.data ?? []) as Grade[]).sort((a, b) => a.sort_order - b.sort_order))
    setStations(st.data ?? [])
    setJobs((j.data ?? []) as StationJob[])
    setLoading(false)
  }

  useEffect(() => {
    load()
  }, [])

  // Creating tier tags and station tags, and setting what a tier may do,
  // is Management's alone — tier 1 (or an admin account). It is not a
  // per-tier function any more, so no capability opens it up.
  const myGrade = profile?.grade_id ? grades.find((g) => g.id === profile.grade_id) ?? null : null
  const myTier = myGrade?.sort_order ?? null
  const isSuperUser = profile?.role === 'admin' || myTier === 1
  const canAddTag = isSuperUser
  const canMoveTags = isSuperUser
  const canEditTags = isSuperUser
  // The tier-1 tag itself is the super admin and is never edited away.
  const rowEditable = (g: Grade) => g.sort_order !== 1 && isSuperUser
  const canManageStations = isSuperUser
  // Where the mill splits: from this tier down people work at ONE station
  // and are drawn per station in Team Manage.
  const stationTier = stationTierOf(grades)

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
    const err = await renumberTiers(next)
    if (err) setError(err.message)
    load()
  }

  // Renumber every tag 1..n, top down. Tier numbers are not labels — the
  // system reads them (which tier is above which, what route access a tag
  // carries), so they must never carry a gap.
  async function renumberTiers(list: Grade[]) {
    const results = await Promise.all(
      list.map((g, i) =>
        g.sort_order === i + 1
          ? null
          : supabase.from('shared_grades').update({ sort_order: i + 1 }).eq('id', g.id),
      ),
    )
    return results.find((r) => r?.error)?.error ?? null
  }

  async function removeTag(g: Grade) {
    if (!window.confirm(`Delete tier tag "${g.name}"?`)) return
    const { error } = await supabase.from('shared_grades').delete().eq('id', g.id)
    if (error) return setError(deleteError(error, `Tier tag "${g.name}"`))
    // Closing the gap the delete left: tier 4 of 7 going means 5, 6, 7
    // move up, not that the list runs 1, 2, 3, 5, 6, 7.
    const gapErr = await renumberTiers(grades.filter((x) => x.id !== g.id))
    setError(gapErr ? gapErr.message : null)
    load()
  }

  async function addStation() {
    setError(null)
    if (stationName.trim() === '') return setError('A station tag needs a name.')
    if (stations.some((x) => sameName(x.name, stationName))) {
      return setError(`A station tag called "${stationName.trim()}" already exists.`)
    }
    const sort = Math.max(0, ...stations.map((x) => x.sort_order)) + 1
    const { error } = await supabase
      .from('shared_stations')
      .insert({ name: stationName.trim(), sort_order: sort })
    if (error) return setError(saveError(error, 'station tag', stationName))
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
      next.map((x, i) => supabase.from('shared_stations').update({ sort_order: i + 1 }).eq('id', x.id)),
    )
    const err = results.find((r) => r.error)
    if (err?.error) setError(err.error.message)
    load()
  }

  function startAddStation() {
    setError(null)
    setEditStationId(null)
    setStationName('')
    setAddingStation(true)
  }

  function cancelAddStation() {
    setStationName('')
    setAddingStation(false)
    setError(null)
  }

  function startEditStation(st: Station) {
    setError(null)
    setAddingStation(false)
    setEditStationId(st.id)
    setStationDraft(st.name)
  }

  function cancelStationEdit() {
    setEditStationId(null)
    setStationDraft('')
    setError(null)
  }

  async function saveStationName() {
    const st = stations.find((x) => x.id === editStationId)
    if (!st) return
    const next = stationDraft.trim()
    if (next === '') return setError('A station tag needs a name.')
    if (next === st.name) return cancelStationEdit()
    if (stations.some((x) => x.id !== st.id && sameName(x.name, next))) {
      return setError(`A station tag called "${next}" already exists.`)
    }
    const { error } = await supabase.from('shared_stations').update({ name: next }).eq('id', st.id)
    if (error) return setError(saveError(error, 'station tag', next))
    cancelStationEdit()
    load()
  }

  const jobsAt = (stationId: string) => jobs.filter((j) => j.station_id === stationId)

  async function removeStation(st: Station) {
    // Say what is in the way BEFORE asking to confirm — being refused
    // after saying yes reads as a broken button.
    const used = jobsAt(st.id)
    if (used.length > 0) {
      const names = used.slice(0, 3).map((j) => `"${j.name}"`).join(', ')
      const rest = used.length > 3 ? ` and ${used.length - 3} more` : ''
      return setError(
        `Station "${st.name}" is still used by ${used.length} work type${used.length === 1 ? '' : 's'} ` +
          `in the Piece Rate module — ${names}${rest}. Clear ${used.length === 1 ? 'it' : 'them'} there first, ` +
          'then this station can be deleted.',
      )
    }
    if (!window.confirm(`Delete station tag "${st.name}"?`)) return
    const { error } = await supabase.from('shared_stations').delete().eq('id', st.id)
    if (error) return setError(deleteError(error, `Station "${st.name}"`))
    setError(null)
    load()
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
            <button className="btn" onClick={() => setTagModal({ grade: null, mode: 'edit' })}>
              + Add tag
            </button>
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
                        onClick={() => setTagModal({ grade: g, mode: 'view' })}
                      >
                        <EyeIcon />
                      </button>
                      {editable && (
                        <>
                          <button
                            className="icon-btn sm"
                            title="Edit tag"
                            aria-label={`Edit ${g.name}`}
                            onClick={() => setTagModal({ grade: g, mode: 'edit' })}
                          >
                            <PencilIcon />
                          </button>
                          {!isSuper && (
                            <button
                              className="icon-btn sm danger"
                              title="Delete tag"
                              aria-label={`Delete ${g.name}`}
                              onClick={() => removeTag(g)}
                            >
                              <TrashIcon />
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

      {/* Section 2 — station tags. A station is one field, so it is edited
          in place: the row itself becomes the form, and adding one opens a
          blank row at the end rather than a pop-out for a single name. */}
      <div className="card stack">
        <div className="row-form spread">
          <h3>Station tags</h3>
          {canManageStations && (
            <button className="btn" onClick={startAddStation} disabled={addingStation}>
              + Add station
            </button>
          )}
        </div>

        <table className="table">
          <thead>
            <tr>
              {canManageStations && <th></th>}
              <th>#</th>
              <th>Station</th>
              <th>Coordinate</th>
              <th className="right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {stations.length === 0 && !addingStation && (
              <tr><td colSpan={5} className="muted">No station tags yet.</td></tr>
            )}
            {stations.map((st, i) => {
              const editing = editStationId === st.id
              return (
                <tr
                  key={st.id}
                  className={`${canManageStations && !editing ? 'drag-row' : ''} ${
                    dragStation === st.id ? 'dragging' : ''
                  }`}
                  /* Not while editing — dragging would fight selecting text. */
                  draggable={canManageStations && !editing}
                  onDragStart={() => canManageStations && !editing && setDragStation(st.id)}
                  onDragEnd={() => setDragStation(null)}
                  onDragOver={(e) => canManageStations && !editing && e.preventDefault()}
                  onDrop={(e) => {
                    if (!canManageStations || editing) return
                    e.preventDefault()
                    dropOnStation(st.id)
                  }}
                  title={canManageStations && !editing ? 'Drag to reorder' : undefined}
                >
                  {canManageStations && (
                    <td className="drag-handle" aria-hidden="true">{editing ? '' : '⠿'}</td>
                  )}
                  <td className="muted">{i + 1}</td>
                  <td>
                    {editing ? (
                      <input
                        className="row-input"
                        value={stationDraft}
                        onChange={(e) => setStationDraft(e.target.value)}
                        onKeyDown={(e) => rowKeys(e, saveStationName, cancelStationEdit)}
                        aria-label="Station name"
                        autoFocus
                      />
                    ) : (
                      st.name
                    )}
                  </td>
                  <td className="muted">
                    {st.latitude != null && st.longitude != null
                      ? `${st.latitude.toFixed(5)}, ${st.longitude.toFixed(5)} · ±${st.geofence_m ?? DEFAULT_GEOFENCE_M} m`
                      : '—'}
                  </td>
                  <td className="right">
                    <span className="row-actions">
                      {editing ? (
                        <>
                          <button className="btn ghost row-btn" onClick={cancelStationEdit}>
                            Cancel
                          </button>
                          <button className="btn row-btn" onClick={saveStationName}>
                            Save
                          </button>
                        </>
                      ) : (
                        canManageStations && (
                          <>
                            <button
                              className="icon-btn sm"
                              title="Station setting — coordinate & targets"
                              aria-label={`Station setting for ${st.name}`}
                              onClick={() => setCoordStation(st)}
                            >
                              <PinIcon />
                            </button>
                            <button
                              className="icon-btn sm"
                              title="Edit station"
                              aria-label={`Edit ${st.name}`}
                              onClick={() => startEditStation(st)}
                            >
                              <PencilIcon />
                            </button>
                            <button
                              className="icon-btn sm danger"
                              title="Delete station"
                              aria-label={`Delete ${st.name}`}
                              onClick={() => removeStation(st)}
                            >
                              <TrashIcon />
                            </button>
                          </>
                        )
                      )}
                    </span>
                  </td>
                </tr>
              )
            })}

            {/* The new station, typed straight into the list it joins. */}
            {addingStation && (
              <tr>
                {canManageStations && <td className="drag-handle" aria-hidden="true"></td>}
                <td className="muted">{stations.length + 1}</td>
                <td>
                  <input
                    className="row-input"
                    value={stationName}
                    onChange={(e) => setStationName(e.target.value)}
                    onKeyDown={(e) => rowKeys(e, addStation, cancelAddStation)}
                    placeholder="New station name"
                    aria-label="New station name"
                    autoFocus
                  />
                </td>
                <td className="muted">—</td>
                <td className="right">
                  <span className="row-actions">
                    <button className="btn ghost row-btn" onClick={cancelAddStation}>
                      Cancel
                    </button>
                    <button className="btn row-btn" onClick={addStation}>
                      Save
                    </button>
                  </span>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {tagModal && (
        <TagModal
          grade={tagModal.grade}
          mode={tagModal.mode}
          canEdit={
            tagModal.grade
              ? canEditTags &&
                (tagModal.grade.sort_order === 1 ? isSuperUser : rowEditable(tagModal.grade))
              : true
          }
          nextTier={Math.max(0, ...grades.map((g) => g.sort_order)) + 1}
          stationTier={stationTier}
          viewerTier={isSuperUser && myTier === null ? 1 : myTier}
          allGrades={grades}
          usedColors={grades.map((g) => g.color)}
          takenNames={grades.filter((g) => g.id !== tagModal.grade?.id).map((g) => g.name)}
          onMode={(mode) => setTagModal((s) => (s ? { ...s, mode } : s))}
          onClose={() => setTagModal(null)}
          onSaved={() => {
            setTagModal(null)
            load()
          }}
        />
      )}

      {coordStation && (
        <StationCoordModal
          station={coordStation}
          onClose={() => setCoordStation(null)}
          onSaved={() => {
            setCoordStation(null)
            load()
          }}
        />
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */

/**
 * One station's own settings: the preset coordinate every clock in / out
 * stamp is checked against ("Use my current location" fills it from the
 * device standing at the station), and the two targets with their "Show
 * on Add new work record" ticks.
 */
function StationCoordModal({
  station,
  onClose,
  onSaved,
}: {
  station: Station
  onClose: () => void
  onSaved: () => void
}) {
  const [lat, setLat] = useState(station.latitude != null ? String(station.latitude) : '')
  const [lng, setLng] = useState(station.longitude != null ? String(station.longitude) : '')
  const [fence, setFence] = useState(station.geofence_m != null ? String(station.geofence_m) : '')
  // The "Show on Add new work record" block: two targets, each with its
  // own tick deciding whether its dashboard is drawn on the record screen.
  const [showHourly, setShowHourly] = useState(station.show_hourly_target === true)
  const [hourTarget, setHourTarget] = useState(
    station.hourly_target != null ? String(station.hourly_target) : '',
  )
  const [showMonthly, setShowMonthly] = useState(station.show_monthly_target === true)
  const [monthTarget, setMonthTarget] = useState(
    station.monthly_target != null ? String(station.monthly_target) : '',
  )
  const [locating, setLocating] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const overlayProps = useOverlayClose(onClose)

  function useMyLocation() {
    if (!navigator.geolocation) return setError('This browser has no location service.')
    setLocating(true)
    setError(null)
    navigator.geolocation.getCurrentPosition(
      (p) => {
        setLat(p.coords.latitude.toFixed(6))
        setLng(p.coords.longitude.toFixed(6))
        setLocating(false)
      },
      () => {
        setLocating(false)
        setError('Location unavailable — allow location access and try again.')
      },
      { enableHighAccuracy: true, timeout: 10_000 },
    )
  }

  async function save() {
    setError(null)
    const clearing = lat.trim() === '' && lng.trim() === ''
    const la = Number(lat)
    const ln = Number(lng)
    if (!clearing) {
      if (lat.trim() === '' || lng.trim() === '' || !Number.isFinite(la) || !Number.isFinite(ln)) {
        return setError('A coordinate needs both numbers — or clear both to remove the preset.')
      }
      if (la < -90 || la > 90 || ln < -180 || ln > 180) {
        return setError('Latitude runs -90 to 90 and longitude -180 to 180.')
      }
    }
    const f = fence.trim() === '' ? null : Math.round(Number(fence))
    if (f != null && (!Number.isFinite(f) || f <= 0)) {
      return setError('The allowed distance must be a positive number of metres.')
    }
    const hr = hourTarget.trim() === '' ? null : Math.round(Number(hourTarget))
    if (hr != null && (!Number.isFinite(hr) || hr <= 0)) {
      return setError('The target per hour must be a positive number.')
    }
    if (showHourly && hr == null) {
      return setError('Ticking "Target per hour" needs the hourly number filled in.')
    }
    const mo = monthTarget.trim() === '' ? null : Math.round(Number(monthTarget))
    if (mo != null && (!Number.isFinite(mo) || mo <= 0)) {
      return setError('The target per month must be a positive number.')
    }
    if (showMonthly && mo == null) {
      return setError('Ticking "Target per month" needs the monthly number filled in.')
    }
    setSaving(true)
    const { data, error: err } = await supabase
      .from('shared_stations')
      .update({
        latitude: clearing ? null : la,
        longitude: clearing ? null : ln,
        geofence_m: clearing ? null : f,
        hourly_target: hr,
        monthly_target: mo,
        show_hourly_target: showHourly,
        show_monthly_target: showMonthly,
      })
      .eq('id', station.id)
      .select('id')
    setSaving(false)
    if (err) {
      return setError(
        /latitude|longitude|geofence_m|monthly_target|show_hourly_target|show_monthly_target/.test(err.message)
          ? 'The database is missing the new station columns — run the latest supabase/setup.sql.'
          : err.message,
      )
    }
    if (!data || data.length === 0) return setError('The database would not let you set this.')
    onSaved()
  }

  return (
    <div className="modal-backdrop" {...overlayProps}>
      <div className="modal">
        <div className="modal-head">
          <h2>Station setting — {station.name}</h2>
          <button className="modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>
        {error && <div className="error">{error}</div>}

        <h3 style={{ marginTop: '0.4rem' }}>Coordinate</h3>
        <p className="muted small">
          Clock in and clock out locations are checked against this point. Leave both
          fields empty to remove the preset — with no preset, stamps are not checked.
        </p>
        <div className="form-grid">
          <label>
            Latitude
            <input value={lat} onChange={(e) => setLat(e.target.value)} placeholder="e.g. 3.139003" inputMode="decimal" />
          </label>
          <label>
            Longitude
            <input value={lng} onChange={(e) => setLng(e.target.value)} placeholder="e.g. 101.686855" inputMode="decimal" />
          </label>
          <label>
            Allowed distance (m)
            <input
              value={fence}
              onChange={(e) => setFence(e.target.value)}
              placeholder={`${DEFAULT_GEOFENCE_M} if empty`}
              inputMode="numeric"
            />
          </label>
        </div>
        <button
          className="btn ghost"
          style={{ marginTop: '0.6rem' }}
          onClick={useMyLocation}
          disabled={locating}
        >
          {locating ? 'Finding…' : '📍 Use my current location'}
        </button>

        <h3 style={{ marginTop: '1.1rem' }}>Show on Add new work record</h3>
        <p className="muted small">
          Each tick draws that target's dashboard on the mobile Add-work-record screen
          for this station.
        </p>
        <div className="stack" style={{ gap: '0.5rem' }}>
          <div className="row-form" style={{ alignItems: 'center', gap: '0.6rem' }}>
            <label className="checkbox" style={{ margin: 0, flex: '1' }}>
              <input
                type="checkbox"
                checked={showHourly}
                onChange={(e) => setShowHourly(e.target.checked)}
              />
              <span>Target per hour</span>
            </label>
            <input
              className="row-input"
              style={{ maxWidth: '7rem' }}
              value={hourTarget}
              onChange={(e) => setHourTarget(e.target.value)}
              placeholder="e.g. 6"
              inputMode="numeric"
              aria-label="Target per hour"
            />
          </div>
          <div className="row-form" style={{ alignItems: 'center', gap: '0.6rem' }}>
            <label className="checkbox" style={{ margin: 0, flex: '1' }}>
              <input
                type="checkbox"
                checked={showMonthly}
                onChange={(e) => setShowMonthly(e.target.checked)}
              />
              <span>Target per month</span>
            </label>
            <input
              className="row-input"
              style={{ maxWidth: '7rem' }}
              value={monthTarget}
              onChange={(e) => setMonthTarget(e.target.value)}
              placeholder="e.g. 900"
              inputMode="numeric"
              aria-label="Target per month"
            />
          </div>
        </div>

        <div className="row-form" style={{ marginTop: '1rem', justifyContent: 'flex-end', gap: '0.5rem' }}>
          <button className="btn ghost" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="btn" onClick={save} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* What a tier may open, and what it may do inside each module. The    */
/* SAME table serves both faces of the pop-out — viewing is the edit   */
/* form with nothing to click, so the two never drift apart.           */
/* ------------------------------------------------------------------ */

function ModuleTable({
  modules,
  capabilities,
  allGrades,
  viewTiers,
  locked,
  onToggleModule,
  onToggleCapability,
  onToggleViewTier,
}: {
  modules: string[]
  capabilities: string[]
  /** Every tier, so the view lists are drawn from the live tier list —
   *  add or remove a tier and the ticks follow without a code change. */
  allGrades: Grade[]
  /** Tier ids this tag may view, per scope. */
  viewTiers: Record<ViewScope, string[]>
  /** Read-only: the view face, and the Management tag which is fixed. */
  locked: boolean
  onToggleModule: (key: string) => void
  onToggleCapability: (key: string) => void
  onToggleViewTier: (scope: ViewScope, gradeId: string) => void
}) {
  return (
    <div className="module-table">
      {MODULE_OPTIONS.map((m) => {
        const on = modules.includes(m.key)
        const group = MODULE_GROUP[m.key]
        const inner = group ? CAPABILITY_OPTIONS.filter((c) => c.group === group) : []
        // Piece Rate and Operation each carry a "whose work may this tier
        // see" list, drawn under the module it governs.
        const view = MODULE_VIEW[m.key]
        const chosen = view ? viewTiers[view.scope] : []
        return (
          <div className={`module-row ${on ? 'on' : ''}`} key={m.key}>
            <label className="checkbox module-head">
              <input
                type="checkbox"
                checked={on}
                disabled={locked}
                onChange={() => onToggleModule(m.key)}
              />
              <span className="module-name">{m.label}</span>
              {on && inner.length > 0 && (
                <span className="module-count">
                  {inner.filter((c) => capabilities.includes(c.key)).length}/{inner.length}
                </span>
              )}
            </label>
            {on && inner.length > 0 && (
              <div className="module-caps">
                {inner.map((c) => (
                  <label key={c.key} className="checkbox small" style={{ margin: 0 }}>
                    <input
                      type="checkbox"
                      checked={capabilities.includes(c.key)}
                      disabled={locked}
                      onChange={() => onToggleCapability(c.key)}
                    />{' '}
                    {c.label}
                  </label>
                ))}
              </div>
            )}
            {on && view && (
              <div className="module-caps">
                <div className="module-subhead">
                  {view.label}
                  <span className="module-count">{chosen.length}/{allGrades.length}</span>
                </div>
                {allGrades.map((g) => (
                  <label key={g.id} className="checkbox small" style={{ margin: 0 }}>
                    <input
                      type="checkbox"
                      checked={chosen.includes(g.id)}
                      disabled={locked}
                      onChange={() => onToggleViewTier(view.scope, g.id)}
                    />{' '}
                    <span className={tagClass(g.color)}>{g.name}</span>
                  </label>
                ))}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* What the tier is ENTITLED to, as opposed to what it may do. Reads   */
/* like the module sheet above it, one row per entitlement, so the two */
/* sections are learnt once. Unlike the module sheet this one is NOT   */
/* locked on tier 1: Management runs the mill and is normally the one  */
/* tag you would switch the piece rate contract off for.               */
/* ------------------------------------------------------------------ */

function EntitlementTable({
  entitlements,
  locked,
  onToggle,
}: {
  entitlements: string[]
  /** Read-only: the view face of the pop-out. */
  locked: boolean
  onToggle: (key: string) => void
}) {
  return (
    <div className="module-table">
      {ENTITLEMENT_OPTIONS.map((e) => {
        const on = entitlements.includes(e.key)
        return (
          <div className={`module-row ${on ? 'on' : ''}`} key={e.key}>
            <label className="checkbox module-head">
              <input type="checkbox" checked={on} disabled={locked} onChange={() => onToggle(e.key)} />
              <span className="module-name">{e.label}</span>
            </label>
          </div>
        )
      })}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Tag edit pop-out: name, colour plate, what it can see, what it can */
/* do.                                                                */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* Who holds a tier. Team Manage draws the mill from the Manager tier   */
/* down, so the top tier's people are listed here instead — under the   */
/* module sheet of the tag itself.                                      */
/* ------------------------------------------------------------------ */
function TierPeople({
  grade,
  grades,
  viewerTier,
}: {
  grade: Grade
  /** Every tier, so a search result can say where its person stands now. */
  grades: Grade[]
  /** The viewer's own tier — what they may hand out is measured from it. */
  viewerTier: number | null
}) {
  type Person = {
    id: string
    full_name: string | null
    email: string | null
    grade_id: string | null
    chart_pos?: number | null
    team_id?: string | null
    station_id?: string | null
    station_ids?: string[] | null
  }
  const [people, setPeople] = useState<Person[]>([])
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<Person[] | null>(null)
  const [chosen, setChosen] = useState<Person | null>(null)
  const [searching, setSearching] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const canFill = canGiveTier(viewerTier, grade.sort_order)
  const tierOf = (p: Person) => grades.find((g) => g.id === p.grade_id) ?? null

  async function loadPeople() {
    // The list reads in the same sequence Team Manage draws this tier:
    // station boxes left to right, team columns inside them, and inside a
    // cell exactly where each block was dragged (chart_pos), names only
    // for anyone never hand-ordered. select('*') because chart_pos may
    // not exist yet on an older database.
    const [pd, st, tm] = await Promise.all([
      supabase.from('shared_profiles').select('*').eq('grade_id', grade.id),
      supabase.from('shared_stations').select('id, sort_order'),
      supabase.from('shared_teams').select('id, sort_order'),
    ])
    const stationRank = (p: Person) => {
      const ids =
        p.station_ids && p.station_ids.length > 0
          ? p.station_ids
          : p.station_id
            ? [p.station_id]
            : []
      if (ids.length === 0) return -1 // across all stations — drawn first
      return Math.min(
        ...ids.map(
          (id) => (st.data ?? []).find((x) => x.id === id)?.sort_order ?? Number.POSITIVE_INFINITY,
        ),
      )
    }
    const teamRank = (p: Person) =>
      (tm.data ?? []).find((t) => t.id === p.team_id)?.sort_order ?? Number.POSITIVE_INFINITY
    const pos = (p: Person) => p.chart_pos ?? Number.POSITIVE_INFINITY
    setPeople(
      (((pd.data ?? []) as Person[]) ?? []).sort(
        (a, b) =>
          stationRank(a) - stationRank(b) ||
          teamRank(a) - teamRank(b) ||
          pos(a) - pos(b) ||
          label(a).localeCompare(label(b)),
      ),
    )
    setLoading(false)
  }

  useEffect(() => {
    setLoading(true)
    loadPeople()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [grade.id])

  // Search every account, not only the ones waiting for a tier: moving
  // somebody up from a lower tier is the same act as placing a new
  // sign-up. Held back briefly so a query goes out per pause, not per
  // keystroke, and nothing is fetched until something is typed.
  useEffect(() => {
    const term = query.trim()
    if (!canFill || term === '') {
      setHits(null)
      return
    }
    setSearching(true)
    const timer = setTimeout(async () => {
      // Commas and brackets are the or() filter's own punctuation, so a
      // search containing them would be read as more conditions.
      const safe = term.replace(/[,()%]/g, ' ').trim()
      if (safe === '') {
        setHits([])
        setSearching(false)
        return
      }
      const { data } = await supabase
        .from('shared_profiles')
        .select('id, full_name, email, grade_id')
        .or(`full_name.ilike.%${safe}%,email.ilike.%${safe}%`)
        .order('email')
        .limit(10)
      // Somebody already on this tier has nowhere to move to.
      setHits(((data ?? []) as Person[]).filter((p) => p.grade_id !== grade.id).slice(0, 8))
      setSearching(false)
    }, 250)
    return () => clearTimeout(timer)
  }, [query, canFill, grade.id])

  // A name if the account has one, otherwise the part before the @ — an
  // email address is not a name.
  const label = (p: Person) => {
    const n = p.full_name?.trim()
    if (n && n.toLowerCase() !== (p.email ?? '').trim().toLowerCase()) return n
    return (p.email ?? '').split('@')[0] || '—'
  }

  function choose(p: Person) {
    setChosen(p)
    setHits(null)
    setQuery('')
    setError(null)
  }

  async function addChosen() {
    if (!chosen) return
    // Taking somebody off a tier needs the same reach as putting them on
    // one: nobody may pull a person down from a tier they do not outrank.
    const from = tierOf(chosen)
    if (from && !canGiveTier(viewerTier, from.sort_order)) {
      return setError(`${label(chosen)} holds ${from.name}, which is not yours to change.`)
    }
    setBusy(true)
    setError(null)
    const { data, error } = await supabase
      .from('shared_profiles')
      .update({
        grade_id: grade.id,
        tags_confirmed: true,
        role: roleForTier(grade.sort_order, grade.name),
      })
      .eq('id', chosen.id)
      .select('id')
    setBusy(false)
    if (error) return setError(error.message)
    if (!data || data.length === 0) {
      return setError('The database would not let you put anyone on this tier.')
    }
    setChosen(null)
    loadPeople()
  }

  return (
    <div className="tag-section">
      <div className="tag-section-title">People on this tier ({people.length})</div>
      {error && <div className="error">{error}</div>}
      {loading ? (
        <span className="small muted">Loading…</span>
      ) : people.length === 0 ? (
        <span className="small muted">Nobody holds this tier yet.</span>
      ) : (
        <div className="tier-people">
          {people.map((p) => (
            <span className="tier-person" key={p.id} title={p.email ?? ''}>
              {label(p)}
            </span>
          ))}
        </div>
      )}

      {/* The top tier has nothing above it, so somebody joins it from
          here — there is no upper tier to drag them in from. */}
      {canFill && !loading && (
        <div className="tier-add">
          <input
            className="row-input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search any name or email"
            aria-label="Search people by name or email"
          />

          {hits !== null && (
            <div className="tier-hits">
              {searching ? (
                <span className="small muted">Searching…</span>
              ) : hits.length === 0 ? (
                <span className="small muted">Nobody matches that.</span>
              ) : (
                hits.map((p) => {
                  const from = tierOf(p)
                  return (
                    <button key={p.id} type="button" className="tier-hit" onClick={() => choose(p)}>
                      <span className="tier-hit-name">{label(p)}</span>
                      <span className="muted small">
                        {p.email}
                        {from ? ` · ${from.name}` : ' · no tier yet'}
                      </span>
                    </button>
                  )
                })
              )}
            </div>
          )}

          {/* Picked, but not placed until Add is pressed — so the tier a
              person is being taken off is read before it changes. */}
          {chosen && (
            <div className="tier-chosen">
              <span className="tier-chosen-who">
                <span className="tier-hit-name">{label(chosen)}</span>
                <span className="muted small">
                  {chosen.email}
                  {tierOf(chosen) ? ` · now ${tierOf(chosen)!.name}` : ' · no tier yet'}
                </span>
              </span>
              <button type="button" className="btn ghost row-btn" onClick={() => setChosen(null)}>
                Clear
              </button>
              <button type="button" className="btn row-btn" onClick={addChosen} disabled={busy}>
                {busy ? 'Adding…' : 'Add'}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function TagModal({
  grade,
  mode,
  canEdit,
  nextTier,
  stationTier,
  viewerTier,
  allGrades,
  usedColors,
  takenNames,
  onMode,
  onClose,
  onSaved,
}: {
  grade: Grade | null
  mode: Mode
  canEdit: boolean
  nextTier: number
  /** The first tier that works at ONE station; above it runs the mill. */
  stationTier: number | null
  /** The viewer's own tier — what they may hand out is measured from it. */
  viewerTier: number | null
  /** Every tier, so a search result can say where its person stands now. */
  allGrades: Grade[]
  usedColors: string[]
  /** Every OTHER tier's name — no two may read the same. */
  takenNames: string[]
  onMode: (mode: Mode) => void
  onClose: () => void
  onSaved: () => void
}) {
  const overlay = useOverlayClose(onClose)
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
  // Whose contracts / work records this tag may view. Drawn under the
  // module each one governs, so the setting sits with what it governs.
  const [viewTiers, setViewTiers] = useState<Record<ViewScope, string[]>>(() =>
    Object.fromEntries(
      VIEW_SCOPES.map((v) => [
        v.scope,
        grade
          ? viewableTierIds(grade, allGrades, v.scope)
          : // A tag being created sits at the bottom, so it starts with
            // itself alone — and it has no id yet, hence nothing ticked.
            [],
      ]),
    ) as Record<ViewScope, string[]>,
  )
  // Entitlements are set on every tag, tier 1 included — see EntitlementTable.
  const [entitlements, setEntitlements] = useState<string[]>(
    grade
      ? effectiveEntitlements(grade, allGrades)
      : defaultEntitlements(nextTier, allGrades),
  )
  const ability = grade?.ability ?? ''
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  function toggleCapability(key: string) {
    if (isSuper) return
    setCapabilities((c) => (c.includes(key) ? c.filter((k) => k !== key) : [...c, key]))
  }

  function toggleViewTier(scope: ViewScope, gradeId: string) {
    setViewTiers((v) => ({
      ...v,
      [scope]: v[scope].includes(gradeId)
        ? v[scope].filter((id) => id !== gradeId)
        : [...v[scope], gradeId],
    }))
  }

  function toggleEntitlement(key: string) {
    setEntitlements((e) => (e.includes(key) ? e.filter((k) => k !== key) : [...e, key]))
  }

  function toggleModule(key: string) {
    if (isSuper) return
    const turningOff = modules.includes(key)
    setModules((m) => (turningOff ? m.filter((k) => k !== key) : [...m, key]))
    // Closing a module drops its own functions with it — there is nothing
    // to grant on a module this tier can no longer open.
    const group = turningOff ? MODULE_GROUP[key] : null
    if (group) {
      const inner = CAPABILITY_OPTIONS.filter((c) => c.group === group).map((c) => c.key)
      setCapabilities((c) => c.filter((k) => !inner.includes(k)))
    }
  }

  async function save(e: FormEvent) {
    e.preventDefault()
    setError(null)
    if (takenNames.some((n) => sameName(n, name))) {
      return setError(`A tier tag called "${name.trim()}" already exists.`)
    }
    setSaving(true)
    // Saved in the standardized order so "Can do" always reads the same,
    // no matter what sequence the boxes were ticked in.
    const caps = isSuper ? [...ALL_CAPABILITIES] : sortCapabilities(capabilities)
    const mods = isSuper
      ? MODULE_OPTIONS.map((m) => m.key)
      : MODULE_OPTIONS.map((m) => m.key).filter((k) => modules.includes(k))
    const fields = { name: name.trim(), color, modules: mods, capabilities: caps, ability: ability || null }
    const ents = ALL_ENTITLEMENTS.filter((k) => entitlements.includes(k))
    // Stored in tier order, and only ids that still exist — a tag deleted
    // while this window was open must not leave a grant behind.
    const inTierOrder = (ids: string[]) =>
      allGrades.filter((g) => ids.includes(g.id)).map((g) => g.id)
    const write = (f: Record<string, unknown>) =>
      grade
        ? supabase.from('shared_grades').update(f).eq('id', grade.id)
        : supabase.from('shared_grades').insert({ ...f, sort_order: nextTier })

    const first = await write({
      ...fields,
      entitlements: ents,
      view_rate_tiers: inTierOrder(viewTiers.rate),
      view_entry_tiers: inTierOrder(viewTiers.entry),
    })
    // "Entitled Function" needs a column that arrived after the first
    // release. On a database that has not had supabase/setup.sql re-run,
    // save everything else rather than losing the whole edit, and say
    // plainly what is missing instead of showing a Postgres error.
    if (first.error && /entitlements|view_rate_tiers|view_entry_tiers/i.test(first.error.message)) {
      const { error } = await write(fields)
      setSaving(false)
      if (error) return setError(saveError(error, 'tier tag', name))
      return setError(
        'Saved — except "Entitled Function", which needs one line of SQL. In Supabase → ' +
          'SQL editor run:  alter table public.shared_grades add column if not exists entitlements text[];  ' +
          'then set it again.',
      )
    }
    setSaving(false)
    if (first.error) return setError(saveError(first.error, 'tier tag', name))
    onSaved()
  }

  // Groups that belong to no module, so they cannot sit inside the module
  // table and keep a block of their own. Management-only groups are not
  // handed out per tier at all.
  const looseGroups = CAPABILITY_GROUPS.filter(
    (group) => !MANAGEMENT_ONLY_GROUPS.includes(group) && !GROUP_MODULE[group],
  )

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

  // Cancelling drops what was typed and shows the saved tag again. A tag
  // being created has no saved face to return to, so Cancel closes.
  function cancel() {
    if (!grade) return onClose()
    setName(grade.name)
    setModules(isSuper ? MODULE_OPTIONS.map((m) => m.key) : grade.modules ?? [...DEFAULT_MODULES])
    setCapabilities(
      isSuper ? [...ALL_CAPABILITIES] : sortCapabilities(grade.capabilities ?? ['data-entry']),
    )
    setEntitlements(effectiveEntitlements(grade, allGrades))
    setViewTiers(
      Object.fromEntries(
        VIEW_SCOPES.map((v) => [v.scope, viewableTierIds(grade, allGrades, v.scope)]),
      ) as Record<ViewScope, string[]>,
    )
    setError(null)
    onMode('view')
  }

  // The view face is the edit face with nothing to click: same title,
  // same tier line, same module table — only the name is a badge rather
  // than a field, and the buttons differ.
  if (mode === 'view' && grade) {
    return (
      <div className="modal-overlay" {...overlay}>
        <div className="modal modal-view" onClick={(e) => e.stopPropagation()}>
          <div className="row-form spread">
            <h2>Tier Tag Access Manage</h2>
            <button type="button" className="modal-close" onClick={onClose} aria-label="Close">×</button>
          </div>

          <div className="tier-line">
            <span className="tier-line-no">Tier {grade.sort_order} :</span>
            <span className={`${tagClass(grade.color)} tag-name-lg`}>{grade.name}</span>
          </div>

          {isSuper && <span className="small muted">{MANAGEMENT_NOTE}</span>}

          <div className="tag-section">
            <div className="tag-section-title">Access to Module</div>
            <ModuleTable
              modules={modules}
              capabilities={capabilities}
              allGrades={allGrades}
              viewTiers={viewTiers}
              locked
              onToggleModule={() => {}}
              onToggleCapability={() => {}}
              onToggleViewTier={() => {}}
            />
          </div>

          <div className="tag-section">
            <div className="tag-section-title">Entitled Function</div>
            <EntitlementTable entitlements={entitlements} locked onToggle={() => {}} />
          </div>

          {/* Only the tiers that run the whole mill are listed here.
              From the station-head tier down there are far too many names
              for a sheet — Team Manage draws those, station by station. */}
          {runsWholeMill(grade.sort_order, stationTier) && (
            <TierPeople grade={grade} grades={allGrades} viewerTier={viewerTier} />
          )}

          {canEdit && (
            <div className="row-form" style={{ justifyContent: 'flex-end' }}>
              <button type="button" className="btn" onClick={() => onMode('edit')}>
                Edit tag
              </button>
            </div>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="modal-overlay" {...overlay}>
      <form className="modal modal-view" onClick={(e) => e.stopPropagation()} onSubmit={save}>
        <div className="row-form spread">
          <h2>Tier Tag Access Manage</h2>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        {error && <div className="error">{error}</div>}

        {/* Which tier this is, then the tag itself as the name field —
            type straight into it to rename. */}
        <div className="tier-line">
          <span className="tier-line-no">Tier {grade?.sort_order ?? nextTier} :</span>
          <input
            className={`${tagClass(color)} tag-name-input`}
            value={name}
            onChange={(e) => setName(e.target.value)}
            size={Math.max(10, name.length + 1)}
            placeholder="Tag name"
            aria-label="Tag name"
            /* Only a tag being created opens with the cursor here — an edit
               should land on the sheet, not in the name box. */
            autoFocus={!grade}
            required
          />
        </div>

        {/* What being tier 1 means, said where it belongs: on tier 1. */}
        {isSuper && <span className="small muted">{MANAGEMENT_NOTE}</span>}

        {/* Tick a module and it opens to show that module's own functions,
            so what a tier may do sits under the module it belongs to. */}
        <div className="tag-section">
          <div className="tag-section-title">Access to Module</div>
          <ModuleTable
            modules={modules}
            capabilities={capabilities}
            allGrades={allGrades}
            viewTiers={viewTiers}
            locked={isSuper}
            onToggleModule={toggleModule}
            onToggleCapability={toggleCapability}
            onToggleViewTier={toggleViewTier}
          />
        </div>

        {/* What the tier IS, rather than what it may press. Every tag gets
            this, tier 1 included — Management is usually the tag you would
            switch the piece rate contract off for. */}
        <div className="tag-section">
          <div className="tag-section-title">Entitled Function</div>
          <EntitlementTable
            entitlements={entitlements}
            locked={false}
            onToggle={toggleEntitlement}
          />
        </div>

        {grade && runsWholeMill(grade.sort_order, stationTier) && (
          <TierPeople grade={grade} grades={allGrades} viewerTier={viewerTier} />
        )}

        {/* Anything that governs no single module keeps its own block. */}
        {looseGroups.map((group) => (
          <div className="tag-section" key={group}>
            <div className="tag-section-title">{group}</div>
            {capBoxes(group)}
          </div>
        ))}

        <div className="row-form" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn ghost" onClick={cancel}>Cancel</button>
          <button className="btn" type="submit" disabled={saving}>
            {saving ? 'Saving…' : grade ? 'Save changes' : 'Create tag'}
          </button>
        </div>
      </form>
    </div>
  )
}
