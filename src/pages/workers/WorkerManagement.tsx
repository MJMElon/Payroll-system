// ---------------------------------------------------------------------------
// WORKER MANAGEMENT — the team floor plan.
//
// The page is a board, read top to bottom:
//
//   TIER NAME                        one row per tier tag (Management aside)
//     Station name                   from the station-head tier downward only
//       [ Team A ][ Team B ][ + ]    teams, with their people inside
//
// A team is created ON a tier row ("+ Team") and groups people from that
// tier DOWNWARD — so the teams a Station Head makes at their station also
// hold that team's assistant station heads and operators one row below.
// Only the tier that owns a team (and the tiers above it) may rename or
// remove it; an assistant station head can still drop a new sign-up into
// the team they themselves sit in, at their own station.
//
// New sign-ups live behind the header button, which carries an app-style
// red counter. Open it and drag a card straight into a team box.
//
// Access: any leader may fill a team they own or belong to — that needs no
// capability. Editing a profile needs "Edit worker profile & salary", and
// filling someone else's team needs "Assign workers to ANY team"; both are
// granted per tier in Settings → Tags management.
// ---------------------------------------------------------------------------
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'
import { effectiveCapabilities, tagClass } from '../../lib/tags'
import { useWideShell } from '../../lib/useWideShell'
import {
  profileName,
  supabase,
  todayISO,
  type Grade,
  type Job,
  type PieceRate,
  type ProductionEntry,
  type Profile,
  type Station,
  type Team,
} from '../../lib/supabase'

const TIER1_UNIT_CAP = 4
const RM = (n: number) => `RM ${n.toFixed(2)}`
// Section key used for "no station" / "every station" groups.
const ALL_STATIONS = '__all__'

/** A team box drawn in one tier row; `team: null` is the loose box. */
type TeamBox = { key: string; team: Team | null; people: Profile[] }
/** A station group inside a tier row (station null = belongs to all). */
type BoardSection = { key: string; station: Station | null; boxes: TeamBox[]; count: number }
/** One tier row of the board. */
type BoardRow = {
  key: string
  grade: Grade | null
  tier: number
  stationScoped: boolean
  sections: BoardSection[]
  count: number
}

/** First unused "Team A", "Team B", … for a box that has just been added. */
function nextTeamName(taken: string[]): string {
  for (let i = 0; i < 26; i++) {
    const name = `Team ${String.fromCharCode(65 + i)}`
    if (!taken.includes(name)) return name
  }
  return `Team ${taken.length + 1}`
}

export default function WorkerManagement() {
  const { profile } = useAuth()
  const wideStyle = useWideShell()
  const [profiles, setProfiles] = useState<Profile[]>([])
  const [grades, setGrades] = useState<Grade[]>([])
  const [stations, setStations] = useState<Station[]>([])
  const [teams, setTeams] = useState<Team[]>([])
  const [jobs, setJobs] = useState<Job[]>([])
  const [rates, setRates] = useState<PieceRate[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [editWorker, setEditWorker] = useState<Profile | null>(null)
  const [signupsOpen, setSignupsOpen] = useState(false)
  const [closedRows, setClosedRows] = useState<Record<string, boolean>>({})
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropKey, setDropKey] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  async function load() {
    const [p, g, s, t, j, r] = await Promise.all([
      supabase.from('access_profiles').select('*').order('full_name'),
      supabase.from('grades').select('*').order('sort_order'),
      supabase.from('stations').select('*').order('sort_order'),
      supabase.from('teams').select('*').order('sort_order'),
      supabase
        .from('jobs')
        .select('id, station_id, grade_id, name, unit, active, approval_status, verified_by, approved_by'),
      supabase.from('piece_rates').select('id, job_id, rate, effective_from, tier2_rate'),
    ])
    const err = p.error || g.error || s.error || t.error
    if (err) setError(err.message)
    setProfiles((p.data ?? []) as Profile[])
    setGrades(((g.data ?? []) as Grade[]).sort((a, b) => a.sort_order - b.sort_order))
    setStations(s.data ?? [])
    setTeams((t.data ?? []) as Team[])
    setJobs((j.data ?? []) as Job[])
    setRates(r.data ?? [])
    setLoading(false)
  }
  useEffect(() => {
    load()
  }, [])

  const isAdmin = profile?.role === 'admin'
  const myGrade = profile?.grade_id ? grades.find((g) => g.id === profile.grade_id) ?? null : null
  const myTier = myGrade?.sort_order ?? null
  const myCaps = effectiveCapabilities(myGrade)
  const bottomTier = Math.max(0, ...grades.map((g) => g.sort_order))
  // An admin without a tier tag still outranks everyone on the board.
  const myTierEff = myTier ?? (isAdmin ? 0 : Number.MAX_SAFE_INTEGER)

  // Who sees every team vs. only their own corner of the board.
  const seesAll = isAdmin || myTier === 1 || myCaps.includes('user-access')
  const isLeader = seesAll || (myTier !== null && myTier < bottomTier)
  // Granted functions. Filling a team you own or belong to is always allowed.
  const canEditProfile = isAdmin || myTier === 1 || myCaps.includes('worker-edit')
  const canAssignAnywhere =
    isAdmin || myTier === 1 || myCaps.includes('user-access') || myCaps.includes('worker-assign-any')

  const tierOf = (p: Profile) =>
    p.grade_id ? grades.find((g) => g.id === p.grade_id)?.sort_order ?? null : null
  const gradeOf = (p: Profile) => grades.find((g) => g.id === p.grade_id)
  const teamOf = (p: Profile) => (p.team_id ? teams.find((t) => t.id === p.team_id) ?? null : null)
  const teamTier = (t: Team) => grades.find((g) => g.id === t.grade_id)?.sort_order ?? 0
  const stationLabel = (p: Profile) => {
    const ids =
      p.station_ids && p.station_ids.length > 0 ? p.station_ids : p.station_id ? [p.station_id] : []
    if (ids.length === 0) return 'All stations'
    return ids.map((id) => stations.find((st) => st.id === id)?.name ?? '?').join(', ')
  }

  const myStationIds = useMemo(
    () =>
      profile?.station_ids && profile.station_ids.length > 0
        ? profile.station_ids
        : profile?.station_id
          ? [profile.station_id]
          : [],
    [profile],
  )
  // Stations I work with. Holding no station tag means "all of them".
  const scopeStations = useMemo(
    () =>
      seesAll || myStationIds.length === 0
        ? stations
        : stations.filter((s) => myStationIds.includes(s.id)),
    [seesAll, myStationIds, stations],
  )
  const stationInScope = (id: string | null) =>
    id === null || seesAll || myStationIds.length === 0 || myStationIds.includes(id)

  const confirmed = profiles.filter((p) => p.tags_confirmed)
  const pending = profiles.filter((p) => !p.tags_confirmed)

  // My subtree: me + everyone whose reporting chain reaches me.
  const inMyTeam = (p: Profile): boolean => {
    let cur: Profile | undefined = p
    for (let hops = 0; cur && hops < 20; hops++) {
      if (cur.id === profile?.id) return true
      cur = profiles.find((x) => x.id === cur?.supervisor_id)
    }
    return false
  }
  // A leader sees their reporting line, the teams they may fill, and the
  // lower tiers at their own stations — the people they can actually place.
  const visible = seesAll
    ? confirmed
    : confirmed.filter((p) => {
        if (inMyTeam(p)) return true
        if (p.team_id && (p.team_id === profile?.team_id || canFillTeamId(p.team_id))) return true
        const t = tierOf(p)
        if (t !== null && myTier !== null && t > myTier) {
          const ids = p.station_ids?.length ? p.station_ids : p.station_id ? [p.station_id] : []
          return ids.length === 0 || ids.some((id) => stationInScope(id))
        }
        return false
      })

  function canFillTeamId(id: string): boolean {
    const t = teams.find((x) => x.id === id)
    return t ? canFillTeam(t) : false
  }
  /** May I rename / remove / add boxes at this tier + station? */
  function canOwnTeamsAt(tier: number, stationId: string | null): boolean {
    if (canAssignAnywhere) return true
    return myTier !== null && myTier <= tier && stationInScope(stationId)
  }
  /** May I drop someone into this box? */
  function canFillTeam(t: Team): boolean {
    if (t.id === profile?.team_id) return true
    return canOwnTeamsAt(teamTier(t), t.station_id)
  }
  const canManageTeam = (t: Team) => canOwnTeamsAt(teamTier(t), t.station_id)

  const selected = selectedId ? profiles.find((p) => p.id === selectedId) ?? null : null

  /* ---------------- board model ---------------- */

  // The first tier that is tied to ONE station — everything from here down
  // is grouped by station name, the tiers above belong to every station.
  // Read from the tag names, and if none look like a station tier, from the
  // data (the highest tier whose people carry station tags).
  const stationTier = useMemo(() => {
    const named = grades
      .filter((g) => /station/i.test(g.name))
      .sort((a, b) => a.sort_order - b.sort_order)[0]
    if (named) return named.sort_order
    const tiers = grades
      .filter((g) =>
        profiles.some(
          (p) =>
            p.grade_id === g.id && ((p.station_ids?.length ?? 0) > 0 || Boolean(p.station_id)),
        ),
      )
      .map((g) => g.sort_order)
    return tiers.length > 0 ? Math.min(...tiers) : null
  }, [grades, profiles])

  const board: BoardRow[] = useMemo(() => {
    const teamById = new Map(teams.map((t) => [t.id, t]))
    const stationById = new Map(stations.map((s) => [s.id, s]))
    const tierOfTeam = (t: Team) => grades.find((g) => g.id === t.grade_id)?.sort_order ?? 0

    // Which station group a person is drawn in: their team's station wins,
    // otherwise their first station tag.
    const sectionKeyOf = (p: Profile): string => {
      const t = p.team_id ? teamById.get(p.team_id) : undefined
      if (t) return t.station_id ?? ALL_STATIONS
      const ids = p.station_ids?.length ? p.station_ids : p.station_id ? [p.station_id] : []
      return ids[0] ?? ALL_STATIONS
    }
    const orderOf = (key: string) =>
      key === ALL_STATIONS ? Number.MAX_SAFE_INTEGER : stationById.get(key)?.sort_order ?? 9999

    const rows: BoardRow[] = []
    const laneGrades = grades.filter((g) => g.sort_order !== 1)

    for (const g of laneGrades) {
      const tier = g.sort_order
      const people = visible.filter((p) => p.grade_id === g.id)
      const stationScoped = stationTier !== null && tier >= stationTier
      // Teams created at this tier or any tier above it reach down to here.
      const rowTeams = teams.filter(
        (t) => tierOfTeam(t) <= tier && (stationScoped || t.station_id === null),
      )

      const keys = new Set<string>()
      if (stationScoped) {
        scopeStations.forEach((s) => keys.add(s.id))
        people.forEach((p) => keys.add(sectionKeyOf(p)))
        rowTeams.forEach((t) => keys.add(t.station_id ?? ALL_STATIONS))
      } else {
        keys.add(ALL_STATIONS)
      }

      const sections = Array.from(keys)
        .sort((a, b) => orderOf(a) - orderOf(b))
        .map<BoardSection>((key) => {
          const station = key === ALL_STATIONS ? null : stationById.get(key) ?? null
          const secPeople = stationScoped ? people.filter((p) => sectionKeyOf(p) === key) : people
          const secTeams = rowTeams.filter((t) => (t.station_id ?? ALL_STATIONS) === key)
          const boxes: TeamBox[] = secTeams.map((t) => ({
            key: t.id,
            team: t,
            people: secPeople.filter((p) => p.team_id === t.id),
          }))
          boxes.push({
            key: `loose:${g.id}:${key}`,
            team: null,
            people: secPeople.filter((p) => !p.team_id || !secTeams.some((t) => t.id === p.team_id)),
          })
          return { key, station, boxes, count: secPeople.length }
        })
        // Keep the station groups this viewer actually works with: the ones
        // holding people, plus the empty ones they may still put a team in.
        // The "all stations" group (teams made above the station tier) only
        // shows where it holds someone, or to a full-board viewer.
        .filter((sec) => {
          if (!stationScoped) return true
          if (sec.count > 0) return true
          if (!sec.station) return seesAll
          if (!stationInScope(sec.station.id)) return false
          return sec.boxes.some((b) => b.team) || canOwnTeamsAt(tier, sec.station.id)
        })

      // A tier you cannot reach into and hold nobody in is just noise —
      // the full-board viewer keeps it, since an empty tier is news.
      if (seesAll || people.length > 0 || tier > myTierEff) {
        rows.push({ key: g.id, grade: g, tier, stationScoped, sections, count: people.length })
      }
    }

    const untagged = visible.filter((p) => !p.grade_id)
    if (untagged.length > 0) {
      rows.push({
        key: 'untagged',
        grade: null,
        tier: bottomTier + 1,
        stationScoped: false,
        count: untagged.length,
        sections: [
          {
            key: ALL_STATIONS,
            station: null,
            count: untagged.length,
            boxes: [{ key: 'loose:untagged', team: null, people: untagged }],
          },
        ],
      })
    }
    return rows
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [grades, stations, teams, visible, scopeStations, stationTier, seesAll, bottomTier, myTierEff])

  const leaderName = (p: Profile) => {
    const sup = p.supervisor_id ? profiles.find((x) => x.id === p.supervisor_id) : null
    return sup ? profileName(sup) : null
  }

  /* ---------------- team actions ---------------- */

  async function createTeam(grade: Grade, station: Station | null) {
    const siblings = teams.filter(
      (t) => t.grade_id === grade.id && (t.station_id ?? null) === (station?.id ?? null),
    )
    const name = nextTeamName(siblings.map((t) => t.name))
    setError(null)
    const { data, error } = await supabase
      .from('teams')
      .insert({
        name,
        grade_id: grade.id,
        station_id: station?.id ?? null,
        created_by: profile?.id ?? null,
        sort_order: siblings.length,
      })
      .select()
      .single()
    if (error) return setError(error.message)
    // Making a team at your OWN tier puts you in it, so the box has a
    // leader from the start.
    if (data && profile && profile.grade_id === grade.id && !profile.team_id) {
      await supabase.from('access_profiles').update({ team_id: data.id }).eq('id', profile.id)
    }
    setNotice(`${name} added to ${grade.name}${station ? ` · ${station.name}` : ''}.`)
    if (data) {
      setRenamingId(data.id)
      setRenameDraft(data.name)
    }
    load()
  }

  async function saveTeamName(team: Team) {
    const name = renameDraft.trim()
    setRenamingId(null)
    if (!name || name === team.name) return
    const { error } = await supabase.from('teams').update({ name }).eq('id', team.id)
    if (error) return setError(error.message)
    setError(null)
    load()
  }

  async function removeTeam(team: Team, members: number) {
    const warn =
      members > 0
        ? `Remove ${team.name}? Its ${members} member${members === 1 ? '' : 's'} stay on the board, out of a team.`
        : `Remove ${team.name}?`
    if (!window.confirm(warn)) return
    const { error } = await supabase.from('teams').delete().eq('id', team.id)
    if (error) return setError(error.message)
    setError(null)
    setNotice(`${team.name} removed.`)
    load()
  }

  /* ---------------- placing people ---------------- */

  async function place(person: Profile, row: BoardRow, section: BoardSection, box: TeamBox) {
    if (!row.grade) return setError('That row has no tier tag to place someone into.')
    if (person.id === profile?.id) return
    if (row.tier <= myTierEff) {
      return setError('You can only place someone into a tier below your own.')
    }
    if (box.team ? !canFillTeam(box.team) : !canOwnTeamsAt(row.tier, section.station?.id ?? null)) {
      return setError(
        'That box is not yours to fill. The "Assign workers to ANY team" function opens this up.',
      )
    }
    if (person.tags_confirmed && person.team_id && !canFillTeamId(person.team_id)) {
      return setError('You can only move workers out of a team you manage.')
    }
    setError(null)

    // The team's own leader takes the reporting line where there is one.
    const leader = box.team
      ? profiles.find(
          (p) => p.id === box.team?.created_by && (tierOf(p) ?? Number.MAX_SAFE_INTEGER) < row.tier,
        ) ??
        profiles.find(
          (p) => p.team_id === box.team?.id && (tierOf(p) ?? Number.MAX_SAFE_INTEGER) < row.tier,
        )
      : null
    const supervisor = leader ?? (myTierEff < row.tier ? profile : null)

    const patch: Record<string, unknown> = {
      grade_id: row.grade.id,
      team_id: box.team?.id ?? null,
      supervisor_id: supervisor?.id ?? person.supervisor_id ?? null,
      tags_confirmed: true,
    }
    if (row.stationScoped && section.station) {
      patch.station_ids = [section.station.id]
      patch.station_id = section.station.id
    }

    const { error } = await supabase.from('access_profiles').update(patch).eq('id', person.id)
    if (error) return setError(error.message)
    const where = box.team ? box.team.name : `${row.grade.name}, no team`
    setNotice(`${profileName(person)} placed in ${where}.`)
    load()
  }

  // The dragged id travels in the DataTransfer as well as in state: on a
  // real drag both agree, but the payload is what the drop event actually
  // carries, so it stays correct even if React has not re-rendered yet.
  function handleDrop(row: BoardRow, section: BoardSection, box: TeamBox, e: React.DragEvent) {
    e.preventDefault()
    const carried = e.dataTransfer.getData('text/plain')
    const dragged = profiles.find((p) => p.id === (carried || dragId))
    setDragId(null)
    setDropKey(null)
    if (dragged) place(dragged, row, section, box)
  }

  function dragProps(p: Profile) {
    return {
      draggable: true,
      onDragStart: (e: React.DragEvent) => {
        e.dataTransfer.setData('text/plain', p.id)
        e.dataTransfer.effectAllowed = 'move'
        setDragId(p.id)
      },
      onDragEnd: () => {
        setDragId(null)
        setDropKey(null)
      },
    }
  }

  if (loading) return <p className="muted">Loading…</p>

  if (!isLeader) {
    return (
      <div className="wm-page">
        <header className="wm-head">
          <Link to="/" className="btn ghost wm-back">← Back to main page</Link>
          <h1 className="wm-title">Worker Management</h1>
        </header>
        <div className="card"><p className="muted">Only team leaders (upper tiers) can manage workers.</p></div>
      </div>
    )
  }

  return (
    <div className="wm-page" style={wideStyle}>
      <header className="wm-head">
        <Link to="/" className="btn ghost wm-back">← Back to main page</Link>
        <h1 className="wm-title">Worker Management</h1>
        <div className="wm-head-actions">
          <button
            type="button"
            className={`btn badge-holder wm-signup-btn ${signupsOpen ? 'open' : ''}`}
            aria-expanded={signupsOpen}
            onClick={() => setSignupsOpen((v) => !v)}
          >
            New sign ups
            <span className="wm-caret" aria-hidden="true">{signupsOpen ? '▲' : '▼'}</span>
            {pending.length > 0 && <span className="count-badge">{pending.length}</span>}
          </button>
        </div>
      </header>

      {error && <div className="error">{error}</div>}
      {notice && <div className="notice">{notice}</div>}

      {signupsOpen && (
        <section className="wm-signups">
          {pending.length === 0 ? (
            <p className="muted small wm-signups-empty">No new sign ups waiting.</p>
          ) : (
            <div className="wm-signup-strip">
              {pending.map((p) => (
                <article
                  key={p.id}
                  className={`wm-signup-card ${dragId === p.id ? 'dragging' : ''}`}
                  {...dragProps(p)}
                >
                  <span className="wm-signup-name">{profileName(p)}</span>
                  <span className="wm-signup-meta">{p.email ?? gradeOf(p)?.name ?? 'No tier yet'}</span>
                </article>
              ))}
            </div>
          )}
        </section>
      )}

      <div className={`wm-body ${selected ? 'with-panel' : ''}`}>
        <section className="wm-board">
          {board.length === 0 && <p className="muted small">No tiers to show yet.</p>}

          {board.map((row) => {
            const shut = closedRows[row.key]
            return (
              <div className="wm-row" key={row.key}>
                <div className="wm-row-head">
                  <button
                    type="button"
                    className="wm-row-toggle"
                    aria-expanded={!shut}
                    onClick={() => setClosedRows((c) => ({ ...c, [row.key]: !c[row.key] }))}
                  >
                    <span className="wm-row-caret" aria-hidden="true">{shut ? '▸' : '▾'}</span>
                    <span className={`tag-dot dot-${row.grade?.color ?? 'grey'}`} aria-hidden="true" />
                    <h2 className="wm-row-title">{row.grade?.name ?? 'No tier tag'}</h2>
                    <span className="wm-row-count">{row.count}</span>
                  </button>
                  {row.grade && !row.stationScoped && canOwnTeamsAt(row.tier, null) && (
                    <button
                      type="button"
                      className="wm-add"
                      title={`Add a team at ${row.grade.name}`}
                      onClick={() => createTeam(row.grade as Grade, null)}
                    >
                      + Team
                    </button>
                  )}
                </div>

                {!shut &&
                  row.sections.map((section) => (
                    <div className="wm-section" key={`${row.key}:${section.key}`}>
                      {row.stationScoped && (
                        <div className="wm-section-head">
                          <span className="wm-station-name">
                            {section.station?.name ?? 'All stations'}
                          </span>
                          <span className="wm-section-count">{section.count}</span>
                          {row.grade && section.station && canOwnTeamsAt(row.tier, section.station.id) && (
                            <button
                              type="button"
                              className="wm-add"
                              title={`Add a team at ${row.grade.name}${section.station ? ` · ${section.station.name}` : ''}`}
                              onClick={() => createTeam(row.grade as Grade, section.station)}
                            >
                              + Team
                            </button>
                          )}
                        </div>
                      )}

                      <div className="wm-boxes">
                        {section.boxes.map((box) => {
                          const key = `${row.key}:${section.key}:${box.key}`
                          const canFill = box.team
                            ? canFillTeam(box.team)
                            : canOwnTeamsAt(row.tier, section.station?.id ?? null)
                          const editable = box.team ? canManageTeam(box.team) : false
                          return (
                            <div
                              key={key}
                              className={[
                                'wm-box',
                                box.team ? '' : 'loose',
                                dropKey === key ? 'over' : '',
                                canFill ? '' : 'locked',
                              ].join(' ')}
                              onDragOver={(e) => {
                                if (!canFill) return
                                e.preventDefault()
                                e.dataTransfer.dropEffect = 'move'
                                setDropKey(key)
                              }}
                              onDragLeave={() => setDropKey((cur) => (cur === key ? null : cur))}
                              onDrop={(e) => handleDrop(row, section, box, e)}
                            >
                              <div className="wm-box-head">
                                {box.team && renamingId === box.team.id ? (
                                  <input
                                    className="wm-box-input"
                                    autoFocus
                                    value={renameDraft}
                                    onChange={(e) => setRenameDraft(e.target.value)}
                                    onBlur={() => saveTeamName(box.team as Team)}
                                    onKeyDown={(e) => {
                                      if (e.key === 'Enter') saveTeamName(box.team as Team)
                                      if (e.key === 'Escape') setRenamingId(null)
                                    }}
                                  />
                                ) : (
                                  <span className="wm-box-name">
                                    {box.team ? box.team.name : 'No team'}
                                  </span>
                                )}
                                <span className="wm-box-count">{box.people.length}</span>
                                {box.team && editable && renamingId !== box.team.id && (
                                  <span className="wm-box-tools">
                                    <button
                                      type="button"
                                      className="wm-icon"
                                      title="Rename team"
                                      onClick={() => {
                                        setRenamingId(box.team!.id)
                                        setRenameDraft(box.team!.name)
                                      }}
                                    >
                                      ✎
                                    </button>
                                    <button
                                      type="button"
                                      className="wm-icon danger"
                                      title="Remove team"
                                      onClick={() => removeTeam(box.team as Team, box.people.length)}
                                    >
                                      ×
                                    </button>
                                  </span>
                                )}
                              </div>

                              <div className="wm-box-body">
                                {box.people.length === 0 ? (
                                  <span className="wm-box-empty">
                                    {canFill ? 'Drop someone here' : 'Empty'}
                                  </span>
                                ) : (
                                  box.people.map((p) => {
                                    const isMe = p.id === profile?.id
                                    const lead = leaderName(p)
                                    return (
                                      <div
                                        key={p.id}
                                        className={[
                                          'wm-person',
                                          selectedId === p.id ? 'selected' : '',
                                          dragId === p.id ? 'dragging' : '',
                                          isMe ? 'me' : '',
                                        ].join(' ')}
                                        onClick={() => setSelectedId(p.id)}
                                        {...dragProps(p)}
                                      >
                                        <span className="wm-person-name">
                                          {profileName(p)}
                                          {isMe && <span className="you-chip">you</span>}
                                        </span>
                                        <span className="wm-person-meta">
                                          {p.employee_code ? `${p.employee_code} · ` : ''}
                                          {lead ? `▲ ${lead}` : stationLabel(p)}
                                        </span>
                                      </div>
                                    )
                                  })
                                )}
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  ))}
              </div>
            )
          })}
        </section>

        {selected && (
          <aside className="wm-panel">
            <WorkerPanel
              person={selected}
              grade={gradeOf(selected) ?? null}
              team={teamOf(selected)}
              stationText={stationLabel(selected)}
              leader={leaderName(selected)}
              jobs={jobs}
              rates={rates}
              stations={stations}
              canEditProfile={canEditProfile}
              onEdit={() => setEditWorker(selected)}
              onClose={() => setSelectedId(null)}
            />
          </aside>
        )}
      </div>

      {editWorker && (
        <WorkerProfileModal
          worker={editWorker}
          onClose={() => setEditWorker(null)}
          onSaved={() => {
            setEditWorker(null)
            load()
          }}
        />
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Worker panel — everything about ONE person, opened by clicking     */
/* their card on the board.                                           */
/* ------------------------------------------------------------------ */

function WorkerPanel({
  person,
  grade,
  team,
  stationText,
  leader,
  jobs,
  rates,
  stations,
  canEditProfile,
  onEdit,
  onClose,
}: {
  person: Profile
  grade: Grade | null
  team: Team | null
  stationText: string
  leader: string | null
  jobs: Job[]
  rates: PieceRate[]
  stations: Station[]
  canEditProfile: boolean
  onEdit: () => void
  onClose: () => void
}) {
  const [entries, setEntries] = useState<ProductionEntry[]>([])
  const [loading, setLoading] = useState(true)

  const month = todayISO().slice(0, 7)
  const monthLabel = new Date(`${month}-01T00:00:00`).toLocaleDateString(undefined, {
    month: 'long',
    year: 'numeric',
  })

  useEffect(() => {
    setLoading(true)
    const start = `${month}-01`
    const end = todayISO()
    supabase
      .from('production_entries')
      .select('*')
      .eq('user_id', person.id)
      .gte('work_date', start)
      .lte('work_date', end)
      .order('work_date', { ascending: false })
      .then(({ data }) => {
        setEntries((data ?? []) as ProductionEntry[])
        setLoading(false)
      })
  }, [person.id, month])

  // The rate in force today for a job.
  const currentRate = useMemo(() => {
    const today = todayISO()
    const best = new Map<string, PieceRate>()
    for (const r of rates) {
      if (r.effective_from > today) continue
      const cur = best.get(r.job_id)
      if (!cur || r.effective_from > cur.effective_from) best.set(r.job_id, r)
    }
    return best
  }, [rates])

  const amountOf = (jobId: string, qty: number) => {
    const r = currentRate.get(jobId)
    if (!r) return 0
    const t1 = Number(r.rate)
    if (r.tier2_rate == null) return qty * t1
    return Math.min(qty, TIER1_UNIT_CAP) * t1 + Math.max(0, qty - TIER1_UNIT_CAP) * Number(r.tier2_rate)
  }

  // Contracts this person may be paid for: approved + active work at one of
  // their stations, tagged to their tier (or open to every position).
  const myStations =
    person.station_ids && person.station_ids.length > 0
      ? person.station_ids
      : person.station_id
        ? [person.station_id]
        : []
  const contracts = jobs
    .filter((j) => j.active && j.approval_status === 'approved')
    .filter((j) => myStations.length === 0 || myStations.includes(j.station_id))
    .filter((j) => j.grade_id === null || j.grade_id === person.grade_id)
    .sort((a, b) => a.name.localeCompare(b.name))

  const stationName = (id: string) => stations.find((s) => s.id === id)?.name ?? '?'
  const jobName = (id: string) => jobs.find((j) => j.id === id)?.name ?? 'Work'
  const monthTotal = entries
    .filter((e) => (e.approval_status ?? 'approved') !== 'rejected')
    .reduce((s, e) => s + amountOf(e.job_id, Number(e.quantity)), 0)

  const statusChip = (s: string) => {
    const cls = s === 'approved' ? 'ok' : s === 'rejected' ? 'bad' : s === 'verified' ? 'mid' : 'warn'
    const label =
      s === 'approved' ? 'Approved'
        : s === 'rejected' ? 'Rejected'
          : s === 'verified' ? 'Pending approve'
            : 'Pending verify'
    return <span className={`mob-chip ${cls}`}>{label}</span>
  }

  return (
    <>
      <div className="wm-panel-head">
        <h3>Worker details</h3>
        <button className="modal-close" onClick={onClose} aria-label="Close details">×</button>
      </div>

      <div className="wm-detail-id">
        <div className="wm-person-name" style={{ fontSize: '1.05rem' }}>{profileName(person)}</div>
        <div className="row-form" style={{ gap: '0.4rem', flexWrap: 'wrap' }}>
          {grade && <span className={tagClass(grade.color)}>{grade.name}</span>}
          {team && <span className="badge off">{team.name}</span>}
        </div>
        <div className="wm-person-meta">{stationText}</div>
        {leader && <div className="wm-person-meta">Reports to {leader}</div>}
      </div>

      <div className="wm-stat">
        <span className="wm-stat-label">Monthly basic salary</span>
        <span className="wm-stat-value">
          {person.basic_salary != null ? RM(Number(person.basic_salary)) : '—'}
        </span>
      </div>

      <div className="wm-detail-block">
        <div className="wm-detail-title">Entitled piece-rate contracts ({contracts.length})</div>
        {contracts.length === 0 ? (
          <p className="muted small" style={{ margin: 0 }}>
            No approved contracts match this person's tier and station.
          </p>
        ) : (
          contracts.map((j) => {
            const r = currentRate.get(j.id)
            return (
              <div className="wm-line" key={j.id}>
                <span>
                  {j.name}
                  <span className="wm-person-meta"> {stationName(j.station_id)} · {j.unit}</span>
                </span>
                <span className="wm-line-amt">
                  {r
                    ? r.tier2_rate != null
                      ? `${Number(r.rate).toFixed(2)} → ${Number(r.tier2_rate).toFixed(2)}`
                      : Number(r.rate).toFixed(2)
                    : '—'}
                </span>
              </div>
            )
          })
        )}
      </div>

      <div className="wm-detail-block">
        <div className="wm-detail-title">Work done — {monthLabel}</div>
        {loading ? (
          <p className="muted small" style={{ margin: 0 }}>Loading…</p>
        ) : entries.length === 0 ? (
          <p className="muted small" style={{ margin: 0 }}>No work recorded this month.</p>
        ) : (
          <>
            {entries.map((e) => (
              <div className="wm-line" key={e.id}>
                <span>
                  <span className="wm-line-date">
                    {new Date(e.work_date + 'T00:00:00').toLocaleDateString(undefined, {
                      day: '2-digit', month: 'short',
                    })}
                  </span>{' '}
                  {jobName(e.job_id)} × {Number(e.quantity)}
                  <div>{statusChip(e.approval_status ?? 'approved')}</div>
                </span>
                <span className="wm-line-amt">{amountOf(e.job_id, Number(e.quantity)).toFixed(2)}</span>
              </div>
            ))}
            <div className="wm-line total">
              <span>Month to date (excludes rejected)</span>
              <span className="wm-line-amt">{RM(monthTotal)}</span>
            </div>
          </>
        )}
      </div>

      {canEditProfile ? (
        <button className="btn" onClick={onEdit}>✎ Edit worker profile</button>
      ) : (
        <p className="muted small">
          Editing a worker profile needs the "Edit worker profile &amp; salary"
          function, granted per tier in Settings → Tags management.
        </p>
      )}
    </>
  )
}

/* ------------------------------------------------------------------ */
/* Worker profile pop-out: personal + payroll details for one worker. */
/* Tags/tier/access stay in Settings -> User access, and the team is  */
/* set by dropping the person into a box on the board.                */
/* ------------------------------------------------------------------ */

function WorkerProfileModal({
  worker,
  onClose,
  onSaved,
}: {
  worker: Profile
  onClose: () => void
  onSaved: () => void
}) {
  const [name, setName] = useState(worker.full_name ?? '')
  const [code, setCode] = useState(worker.employee_code ?? '')
  const [ic, setIc] = useState(worker.ic_number ?? '')
  const [phone, setPhone] = useState(worker.phone ?? '')
  const [bankName, setBankName] = useState(worker.bank_name ?? '')
  const [bankAccount, setBankAccount] = useState(worker.bank_account ?? '')
  const [joinedOn, setJoinedOn] = useState(worker.joined_on ?? '')
  const [salary, setSalary] = useState(worker.basic_salary != null ? String(worker.basic_salary) : '')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  async function save(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    const salaryValue = salary.trim() === '' ? null : Number(salary)
    if (salaryValue !== null && (!Number.isFinite(salaryValue) || salaryValue < 0)) {
      return setError('Basic salary must be a positive number.')
    }
    setSaving(true)
    const { error } = await supabase
      .from('access_profiles')
      .update({
        full_name: name.trim() || null,
        employee_code: code.trim() || null,
        ic_number: ic.trim() || null,
        phone: phone.trim() || null,
        bank_name: bankName.trim() || null,
        bank_account: bankAccount.trim() || null,
        joined_on: joinedOn || null,
        basic_salary: salaryValue,
      })
      .eq('id', worker.id)
    setSaving(false)
    if (error) return setError(error.message)
    onSaved()
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={save}>
        <div className="row-form spread">
          <h2>Worker profile</h2>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>
        {error && <div className="error">{error}</div>}

        <div className="row-form">
          <label className="field grow">
            <span>Full name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} required />
          </label>
          <label className="field">
            <span>Employee code</span>
            <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="EMP001" />
          </label>
        </div>

        <div className="row-form">
          <label className="field grow">
            <span>IC / passport number</span>
            <input value={ic} onChange={(e) => setIc(e.target.value)} />
          </label>
          <label className="field grow">
            <span>Phone</span>
            <input value={phone} onChange={(e) => setPhone(e.target.value)} />
          </label>
        </div>

        <div className="row-form">
          <label className="field grow">
            <span>Bank</span>
            <input value={bankName} onChange={(e) => setBankName(e.target.value)} />
          </label>
          <label className="field grow">
            <span>Bank account no.</span>
            <input value={bankAccount} onChange={(e) => setBankAccount(e.target.value)} />
          </label>
        </div>

        <div className="row-form">
          <label className="field">
            <span>Joined on</span>
            <input type="date" value={joinedOn} onChange={(e) => setJoinedOn(e.target.value)} />
          </label>
          <label className="field grow">
            <span>Monthly basic salary (RM)</span>
            <input
              type="number"
              min="0"
              step="50"
              value={salary}
              onChange={(e) => setSalary(e.target.value)}
              placeholder="—"
            />
          </label>
        </div>

        <p className="muted small" style={{ margin: 0 }}>
          Tier tag, station tag and access settings stay in Settings → User access.
        </p>

        <div className="row-form" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn" type="submit" disabled={saving}>
            {saving ? 'Saving…' : 'Save profile'}
          </button>
        </div>
      </form>
    </div>
  )
}
