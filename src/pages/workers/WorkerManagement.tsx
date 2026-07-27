// ---------------------------------------------------------------------------
// WORKER MANAGEMENT — the team chart.
//
// Three columns under the page title:
//   LEFT    New signups. Sticky, so the list rides along as you scroll down
//           to the operator rows and drag a card onto a block.
//   MIDDLE  Formation. One row per tier, top tier first, drawn as blocks:
//
//             MANAGER                 [ Manager Raj ]
//             ENGINEER                [ Wong ][ Siva ][ Tan ] …
//             STATION HEAD            [ Ahmad ][ Chin ] …
//
//           A row shows the whole tier until you pick a block above it —
//           then it narrows to that block's branch, and the trail shows in
//           the breadcrumb, so the chain reads without drawing 112 boxes.
//   RIGHT   The person you opened.
//
// Teams are the clusters inside a row: "+ Team" on a leader's block makes
// one at that leader's tier and station, named inline, and the row below
// splits into those clusters. Drop someone on a block and they join that
// leader (and that leader's team); drop them on a cluster and they join
// that team. A new signup with no tier lands on the tier straight below
// the block they are dropped on, and inherits its station.
//
// Access: any leader may build their OWN branch — that needs no capability.
// Editing a profile needs "Edit worker profile & salary", and moving people
// in someone else's branch needs "Assign workers to ANY team"; both are
// granted per tier in Settings → Tier & Station Tags setting.
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
  type Role,
  type Station,
  type Team,
} from '../../lib/supabase'

const TIER1_UNIT_CAP = 4
const RM = (n: number) => `RM ${n.toFixed(2)}`

// Route access follows the tier tag: placing someone in the chain also
// settles which pages they may open. Carried over from the old Settings
// "User access" tab, which was the only other place that kept the two in
// step.
function roleForTier(tier: number | null, name?: string): Role {
  if (tier === null) return 'operator'
  if (tier <= 2) return 'manager'
  if (tier === 3 || (name ?? '').toLowerCase().includes('engineer')) return 'engineer'
  return 'operator'
}

/** A bracket of children under one leader; `team: null` = no team. */
type Group = { team: Team | null; people: Profile[] }

/** First unused "Team A", "Team B", … for a bracket just added. */
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
  const [signupsOpen, setSignupsOpen] = useState(true)
  // The block whose branch the rows below are drilled into.
  const [focusId, setFocusId] = useState<string | null>(null)
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

  // Who sees the whole chain vs. only their own branch.
  const seesAll = isAdmin || myTier === 1 || myCaps.includes('user-access')
  const isLeader = seesAll || (myTier !== null && myTier < bottomTier)
  // Granted functions. Building your OWN branch is always allowed.
  const canEditProfile = isAdmin || myTier === 1 || myCaps.includes('worker-edit')
  const canAssignAnywhere =
    isAdmin || myTier === 1 || myCaps.includes('user-access') || myCaps.includes('worker-assign-any')

  const tierOf = (p: Profile) =>
    p.grade_id ? grades.find((g) => g.id === p.grade_id)?.sort_order ?? null : null
  const gradeOf = (p: Profile) => grades.find((g) => g.id === p.grade_id)
  const teamOf = (p: Profile) => (p.team_id ? teams.find((t) => t.id === p.team_id) ?? null : null)
  const teamTier = (t: Team) => grades.find((g) => g.id === t.grade_id)?.sort_order ?? 0
  const stationsOf = (p: Profile) =>
    p.station_ids && p.station_ids.length > 0 ? p.station_ids : p.station_id ? [p.station_id] : []
  const stationLabel = (p: Profile) => {
    const ids = stationsOf(p)
    if (ids.length === 0) return 'All stations'
    return ids.map((id) => stations.find((st) => st.id === id)?.name ?? '?').join(', ')
  }

  const myStationIds = useMemo(() => (profile ? stationsOf(profile as Profile) : []), [profile])
  const stationInScope = (id: string | null) =>
    id === null || seesAll || myStationIds.length === 0 || myStationIds.includes(id)

  const confirmed = profiles.filter((p) => p.tags_confirmed)
  const pending = profiles.filter((p) => !p.tags_confirmed)

  // My branch: me + everyone whose reporting chain reaches me.
  const inMyBranch = (p: Profile): boolean => {
    let cur: Profile | undefined = p
    for (let hops = 0; cur && hops < 20; hops++) {
      if (cur.id === profile?.id) return true
      cur = profiles.find((x) => x.id === cur?.supervisor_id)
    }
    return false
  }
  // A leader sees their own branch, their team, and the lower tiers at their
  // stations — the people they can actually place.
  const visible = seesAll
    ? confirmed
    : confirmed.filter((p) => {
        if (inMyBranch(p)) return true
        if (p.team_id && p.team_id === profile?.team_id) return true
        const t = tierOf(p)
        if (t !== null && myTier !== null && t > myTier) {
          const ids = stationsOf(p)
          return ids.length === 0 || ids.some((id) => stationInScope(id))
        }
        return false
      })

  /** May I rename / remove / add a team at this tier + station? */
  const canOwnTeamsAt = (tier: number, stationId: string | null) =>
    canAssignAnywhere || (myTier !== null && myTier <= tier && stationInScope(stationId))
  const canManageTeam = (t: Team) => canOwnTeamsAt(teamTier(t), t.station_id)
  /** May I hang someone under this leader? */
  const canPlaceUnder = (leader: Profile) =>
    canAssignAnywhere || leader.id === profile?.id || inMyBranch(leader)
  /** May I move this person out of where they are now? */
  const canMove = (p: Profile) =>
    p.id !== profile?.id && (canAssignAnywhere || inMyBranch(p) || p.supervisor_id === profile?.id)

  const selected = selectedId ? profiles.find((p) => p.id === selectedId) ?? null : null

  /* ---------------- the chain ---------------- */

  const tree = useMemo(() => {
    const ids = new Set(visible.map((p) => p.id))
    const kids = new Map<string, Profile[]>()
    const roots: Profile[] = []
    for (const p of visible) {
      const sup =
        p.supervisor_id && p.supervisor_id !== p.id && ids.has(p.supervisor_id)
          ? p.supervisor_id
          : null
      if (sup) kids.set(sup, [...(kids.get(sup) ?? []), p])
      else roots.push(p)
    }
    const byRank = (a: Profile, b: Profile) =>
      (tierOf(a) ?? 99) - (tierOf(b) ?? 99) || profileName(a).localeCompare(profileName(b))
    kids.forEach((list) => list.sort(byRank))
    roots.sort(byRank)
    // Everyone under each person (the seen set guards a supervisor loop).
    const total = new Map<string, number>()
    const walk = (p: Profile, seen: Set<string>): number => {
      if (seen.has(p.id)) return 0
      seen.add(p.id)
      let n = 0
      for (const k of kids.get(p.id) ?? []) n += 1 + walk(k, seen)
      total.set(p.id, n)
      return n
    }
    roots.forEach((r) => walk(r, new Set()))
    return { kids, roots, total }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, grades])

  // Is `p` somewhere under `ancestorId` in the reporting chain?
  const isUnder = (p: Profile, ancestorId: string): boolean => {
    let cur: Profile | undefined = profiles.find((x) => x.id === p.supervisor_id)
    for (let hops = 0; cur && hops < 20; hops++) {
      if (cur.id === ancestorId) return true
      cur = profiles.find((x) => x.id === cur?.supervisor_id)
    }
    return false
  }

  // The focused block and everyone above it — the trail the rows follow.
  const focusPath = useMemo(() => {
    const chain: Profile[] = []
    let cur = focusId ? profiles.find((p) => p.id === focusId) : undefined
    for (let hops = 0; cur && hops < 20; hops++) {
      chain.unshift(cur)
      cur = cur.supervisor_id ? profiles.find((x) => x.id === cur?.supervisor_id) : undefined
    }
    return chain
  }, [focusId, profiles])

  // One row per tier, top tier first. A row shows the whole tier until a
  // block above it is picked — then it shows that block's branch only.
  const rows = useMemo(() => {
    const out: { grade: Grade; parent: Profile | null; people: Profile[] }[] = []
    for (const g of grades) {
      const parent = [...focusPath].reverse().find((f) => (tierOf(f) ?? 99) < g.sort_order) ?? null
      const people = visible
        .filter((p) => p.grade_id === g.id)
        .filter((p) => !parent || isUnder(p, parent.id))
        .sort((a, b) => profileName(a).localeCompare(profileName(b)))
      if (people.length > 0) out.push({ grade: g, parent, people })
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [grades, visible, focusPath, profiles])

  // People with a tier tag nobody knows about, plus anyone with no tier.
  const looseRow = useMemo(
    () => visible.filter((p) => !p.grade_id),
    [visible],
  )

  /** The brackets under one leader: their teams, then whoever has no team. */
  function groupsFor(leader: Profile, kids: Profile[]): Group[] {
    const mine = teams.filter((t) => t.created_by === leader.id)
    const spread = new Set(kids.map((k) => k.team_id ?? null))
    // Nothing to bracket: this leader made no team and their people all sit
    // in the same one (usually the leader's own) — the rows say so already.
    if (mine.length === 0 && spread.size <= 1) return [{ team: null, people: kids }]
    const childTeams = new Set(kids.map((k) => k.team_id).filter(Boolean) as string[])
    const shown = teams
      .filter((t) => t.created_by === leader.id || childTeams.has(t.id))
      .sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name))
    if (shown.length === 0) return [{ team: null, people: kids }]
    const groups: Group[] = shown.map((t) => ({
      team: t,
      people: kids.filter((k) => k.team_id === t.id),
    }))
    const rest = kids.filter((k) => !k.team_id || !shown.some((t) => t.id === k.team_id))
    if (rest.length > 0) groups.push({ team: null, people: rest })
    return groups
  }

  /* ---------------- team actions ---------------- */

  async function createTeam(leader: Profile) {
    const grade = gradeOf(leader)
    if (!grade) return setError('That leader has no tier tag yet — place them in the chain first.')
    const station = stationsOf(leader)[0] ?? null
    const siblings = teams.filter((t) => t.created_by === leader.id)
    const name = nextTeamName(siblings.map((t) => t.name))
    setError(null)
    const { data, error } = await supabase
      .from('teams')
      .insert({
        name,
        grade_id: grade.id,
        station_id: station,
        created_by: leader.id,
        sort_order: siblings.length,
      })
      .select()
      .single()
    if (error) return setError(error.message)
    setFocusId(leader.id)
    setNotice(`${name} added under ${profileName(leader)}.`)
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
        ? `Remove ${team.name}? Its ${members} member${members === 1 ? '' : 's'} stay in the chain, out of a team.`
        : `Remove ${team.name}?`
    if (!window.confirm(warn)) return
    const { error } = await supabase.from('teams').delete().eq('id', team.id)
    if (error) return setError(error.message)
    setError(null)
    setNotice(`${team.name} removed.`)
    load()
  }

  /* ---------------- moving people ---------------- */

  async function placeUnder(person: Profile, leader: Profile, team: Team | null) {
    if (person.id === leader.id) return
    if (!canPlaceUnder(leader)) {
      return setError(
        'You can only add people into your own branch. The "Assign workers to ANY team" function opens this up.',
      )
    }
    if (person.tags_confirmed && !canMove(person)) {
      return setError('You can only move workers who are already in your branch.')
    }
    if (inMyBranch(person) && person.id !== profile?.id) {
      // Moving someone onto their own subordinate would cut the chain loose.
      let cur: Profile | undefined = leader
      for (let hops = 0; cur && hops < 20; hops++) {
        if (cur.id === person.id) return setError('That would put a leader under their own team member.')
        cur = profiles.find((x) => x.id === cur?.supervisor_id)
      }
    }
    const lt = tierOf(leader)
    const pt = tierOf(person)
    if (lt === null) return setError('That leader has no tier tag yet — place them in the chain first.')
    if (pt !== null && lt >= pt) {
      return setError('A worker can only be placed under a strictly higher tier.')
    }
    // A new sign-up with no tier yet lands on the tier straight below.
    const nextGrade =
      pt === null ? grades.filter((g) => g.sort_order > lt).sort((a, b) => a.sort_order - b.sort_order)[0] : null
    if (pt === null && !nextGrade) return setError('There is no tier below this leader to place them on.')
    setError(null)

    const leaderStations = stationsOf(leader)
    const patch: Record<string, unknown> = {
      supervisor_id: leader.id,
      team_id: team?.id ?? null,
      tags_confirmed: true,
    }
    if (nextGrade) patch.grade_id = nextGrade.id
    if (leaderStations.length > 0) {
      patch.station_ids = leaderStations
      patch.station_id = leaderStations[0]
    }
    // Route access follows the tier tag, so placing someone also settles
    // which pages they may open. An admin is never demoted by a tag.
    const landedTier = nextGrade?.sort_order ?? pt
    const landedName = nextGrade?.name ?? gradeOf(person)?.name
    if (person.role !== 'admin') patch.role = roleForTier(landedTier, landedName)

    const { data, error } = await supabase
      .from('access_profiles')
      .update(patch)
      .eq('id', person.id)
      .select('id')
    if (error) return setError(error.message)
    // Row-level security refuses by matching no row, which PostgREST reports
    // as a success that changed nothing — so an empty result is a refusal.
    if (!data || data.length === 0) {
      return setError(
        `The database would not let you place ${profileName(person)} — that needs a higher ` +
          'tier, or the "Change other users\' settings" function.',
      )
    }
    setNotice(
      `${profileName(person)} now reports to ${profileName(leader)}${team ? ` · ${team.name}` : ''}.`,
    )
    load()
  }

  /** Move someone to another tier tag without moving them in the chain. */
  async function changeTier(person: Profile, gradeId: string) {
    const grade = grades.find((g) => g.id === gradeId)
    if (!grade) return
    if (!canAssignAnywhere && !inMyBranch(person)) {
      return setError('You can only re-tier people in your own branch.')
    }
    if (myTier !== null && !canAssignAnywhere && grade.sort_order <= myTier) {
      return setError('You can only put someone on a tier below your own.')
    }
    const sup = person.supervisor_id ? profiles.find((x) => x.id === person.supervisor_id) : null
    const supTier = sup ? tierOf(sup) : null
    if (supTier !== null && grade.sort_order <= supTier) {
      return setError(`That tier is not below ${profileName(sup)}, who they report to.`)
    }
    setError(null)
    const patch: Record<string, unknown> = { grade_id: grade.id }
    if (person.role !== 'admin') patch.role = roleForTier(grade.sort_order, grade.name)
    const { data, error } = await supabase
      .from('access_profiles')
      .update(patch)
      .eq('id', person.id)
      .select('id')
    if (error) return setError(error.message)
    if (!data || data.length === 0) {
      return setError(
        `The database would not let you re-tier ${profileName(person)} — that needs a higher ` +
          'tier, or the "Change other users\' settings" function.',
      )
    }
    setNotice(`${profileName(person)} is now ${grade.name}.`)
    load()
  }

  // The dragged id travels in the DataTransfer as well as in state: on a
  // real drag both agree, but the payload is what the drop event actually
  // carries, so it stays correct even if React has not re-rendered yet.
  function handleDrop(leader: Profile, team: Team | null, e: React.DragEvent) {
    e.preventDefault()
    e.stopPropagation()
    const carried = e.dataTransfer.getData('text/plain')
    const dragged = profiles.find((p) => p.id === (carried || dragId))
    setDragId(null)
    setDropKey(null)
    if (dragged) placeUnder(dragged, leader, team)
  }

  function dragProps(p: Profile) {
    return {
      draggable: true,
      onDragStart: (e: React.DragEvent) => {
        e.stopPropagation()
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

  function dropProps(key: string, leader: Profile, team: Team | null, allowed: boolean) {
    return {
      onDragOver: (e: React.DragEvent) => {
        if (!allowed || dragId === leader.id) return
        e.preventDefault()
        e.stopPropagation()
        e.dataTransfer.dropEffect = 'move' as const
        setDropKey(key)
      },
      onDragLeave: () => setDropKey((cur) => (cur === key ? null : cur)),
      onDrop: (e: React.DragEvent) => handleDrop(leader, team, e),
    }
  }

  if (loading) return <p className="muted">Loading…</p>

  if (!isLeader) {
    return (
      <div className="wm-page">
        <header className="wm-head">
          <Link to="/" className="btn ghost wm-back">← Back to main page</Link>
        </header>
        <h1 className="wm-page-title">Team chart</h1>
        <div className="card"><p className="muted">Only team leaders (upper tiers) can manage workers.</p></div>
      </div>
    )
  }

  /** One person's block in a tier row. */
  function block(p: Profile) {
    const grade = gradeOf(p)
    const team = teamOf(p)
    const tier = tierOf(p)
    const under = tree.total.get(p.id) ?? 0
    const isMe = p.id === profile?.id
    const key = `block:${p.id}`
    const allowed = canPlaceUnder(p)
    const canAddTeam =
      Boolean(grade) && tier !== null && tier < bottomTier && canOwnTeamsAt(tier, stationsOf(p)[0] ?? null)
    return (
      <article
        key={p.id}
        className={[
          'wm-block',
          focusId === p.id ? 'focused' : '',
          focusPath.some((f) => f.id === p.id) ? 'on-path' : '',
          selectedId === p.id ? 'selected' : '',
          dragId === p.id ? 'dragging' : '',
          dropKey === key ? 'over' : '',
          isMe ? 'me' : '',
        ].join(' ')}
        onClick={() => {
          setSelectedId(p.id)
          setFocusId((cur) => (cur === p.id ? null : p.id))
        }}
        {...dragProps(p)}
        {...dropProps(key, p, team, allowed)}
      >
        <span className={`wm-block-bar dot-${grade?.color ?? 'grey'}`} aria-hidden="true" />
        <span className="wm-block-name">
          {profileName(p)}
          {isMe && <span className="you-chip">you</span>}
        </span>
        <span className="wm-block-meta">
          {stationLabel(p)}
          {team ? ` · ${team.name}` : ''}
        </span>
        <span className="wm-block-foot">
          {under > 0 ? <span className="wm-under">{under} under</span> : <span />}
          {canAddTeam && (
            <button
              type="button"
              className="wm-add"
              title={`Add a team under ${profileName(p)}`}
              onClick={(e) => {
                e.stopPropagation()
                createTeam(p)
              }}
            >
              + Team
            </button>
          )}
        </span>
      </article>
    )
  }

  /** A tier row: the whole tier, or the picked block's branch of it. */
  function tierRow(grade: Grade | null, parent: Profile | null, people: Profile[]) {
    const clusters = parent ? groupsFor(parent, people) : [{ team: null, people } as Group]
    const bare = clusters.length === 1 && !clusters[0].team
    return (
      <section className="wm-tier-row" key={grade?.id ?? 'untagged'}>
        <div className="wm-tier-head">
          <span className={`tag-dot dot-${grade?.color ?? 'grey'}`} aria-hidden="true" />
          <h2 className="wm-tier-name">{grade?.name ?? 'No tier tag'}</h2>
          <span className="wm-tier-n">{people.length}</span>
          {parent && <span className="wm-tier-of">under {profileName(parent)}</span>}
        </div>
        <div className={`wm-row-blocks ${parent ? 'linked' : ''}`}>
          {bare
            ? clusters[0].people.map(block)
            : clusters.map((c) => {
                const key = `cluster:${parent?.id ?? 'x'}:${c.team?.id ?? 'none'}`
                return (
                  <div className="wm-cluster" key={key}>
                    <div
                      className={`wm-cluster-head ${dropKey === key ? 'over' : ''}`}
                      {...(parent ? dropProps(key, parent, c.team, canPlaceUnder(parent)) : {})}
                    >
                      {c.team && renamingId === c.team.id ? (
                        <input
                          className="wm-cluster-input"
                          autoFocus
                          value={renameDraft}
                          onChange={(e) => setRenameDraft(e.target.value)}
                          onBlur={() => saveTeamName(c.team as Team)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') saveTeamName(c.team as Team)
                            if (e.key === 'Escape') setRenamingId(null)
                          }}
                        />
                      ) : (
                        <span className={`wm-cluster-name ${c.team ? '' : 'none'}`}>
                          {c.team ? c.team.name : 'No team'}
                          {c.team && c.team.created_by && c.team.created_by !== parent?.id && (
                            <span className="wm-cluster-of">
                              {' · '}
                              {profileName(profiles.find((x) => x.id === c.team?.created_by))}
                            </span>
                          )}
                        </span>
                      )}
                      <span className="wm-cluster-n">{c.people.length}</span>
                      {c.team && canManageTeam(c.team) && renamingId !== c.team.id && (
                        <>
                          <button
                            type="button"
                            className="wm-icon"
                            title="Rename team"
                            onClick={() => {
                              setRenamingId(c.team!.id)
                              setRenameDraft(c.team!.name)
                            }}
                          >
                            ✎
                          </button>
                          <button
                            type="button"
                            className="wm-icon danger"
                            title="Remove team"
                            onClick={() => removeTeam(c.team as Team, c.people.length)}
                          >
                            ×
                          </button>
                        </>
                      )}
                    </div>
                    <div className="wm-cluster-blocks">{c.people.map(block)}</div>
                  </div>
                )
              })}
        </div>
      </section>
    )
  }

  return (
    <div className="wm-page" style={wideStyle}>
      <header className="wm-head">
        <Link to="/" className="btn ghost wm-back">← Back to main page</Link>
      </header>
      <h1 className="wm-page-title">Team chart</h1>

      {error && <div className="error">{error}</div>}
      {notice && <div className="notice">{notice}</div>}

      <div className={`wm-cols ${selected ? 'with-panel' : ''}`}>
        {/* ---------- left: new sign ups, riding along as you scroll ------- */}
        <aside className="wm-side">
          <div className="wm-side-inner">
            <button
              type="button"
              className="wm-side-title"
              aria-expanded={signupsOpen}
              onClick={() => setSignupsOpen((v) => !v)}
            >
              <span className="wm-side-caret" aria-hidden="true">{signupsOpen ? '▾' : '▸'}</span>
              New signups
              {pending.length > 0 && <span className="count-badge static">{pending.length}</span>}
            </button>
            {signupsOpen &&
              (pending.length === 0 ? (
                <p className="muted small" style={{ margin: 0 }}>None waiting.</p>
              ) : (
                <div className="wm-signup-list">
                  {pending.map((p) => (
                    <article
                      key={p.id}
                      className={`wm-signup-card ${dragId === p.id ? 'dragging' : ''}`}
                      {...dragProps(p)}
                    >
                      <span className="wm-signup-name">{profileName(p)}</span>
                      <span className="wm-signup-meta">{p.email ?? 'No tier yet'}</span>
                    </article>
                  ))}
                </div>
              ))}
          </div>
        </aside>

        {/* ---------- middle: the formation ------------------------------- */}
        <section className="wm-formation">
          <div className="wm-formation-head">
            <h2 className="wm-section-title">Formation</h2>
            <nav className="wm-crumbs">
              <button
                type="button"
                className={`wm-crumb ${focusPath.length === 0 ? 'active' : ''}`}
                onClick={() => setFocusId(null)}
              >
                Everyone
              </button>
              {focusPath.map((f) => (
                <span key={f.id}>
                  <span className="wm-crumb-sep">›</span>
                  <button
                    type="button"
                    className={`wm-crumb ${focusId === f.id ? 'active' : ''}`}
                    onClick={() => setFocusId(f.id)}
                  >
                    {profileName(f)}
                  </button>
                </span>
              ))}
            </nav>
          </div>

          {rows.length === 0 && looseRow.length === 0 && (
            <p className="muted small">No one on the chart yet.</p>
          )}
          {rows.map((r) => tierRow(r.grade, r.parent, r.people))}
          {looseRow.length > 0 && tierRow(null, null, looseRow)}
        </section>

        {/* ---------- right: the person you opened ------------------------ */}
        {selected && (
          <aside className="wm-panel">
            <WorkerPanel
              person={selected}
              grade={gradeOf(selected) ?? null}
              team={teamOf(selected)}
              stationText={stationLabel(selected)}
              leader={
                selected.supervisor_id
                  ? profileName(profiles.find((x) => x.id === selected.supervisor_id))
                  : null
              }
              jobs={jobs}
              rates={rates}
              stations={stations}
              canEditProfile={canEditProfile}
              tierOptions={
                canAssignAnywhere || inMyBranch(selected)
                  ? grades.filter((g) => canAssignAnywhere || myTier === null || g.sort_order > myTier)
                  : []
              }
              onChangeTier={(gradeId) => changeTier(selected, gradeId)}
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
/* their row in the chain.                                            */
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
  tierOptions,
  onChangeTier,
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
  tierOptions: Grade[]
  onChangeTier: (gradeId: string) => void
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
        <div className="wm-row-name" style={{ fontSize: '1.05rem' }}>{profileName(person)}</div>
        <div className="row-form" style={{ gap: '0.4rem', flexWrap: 'wrap' }}>
          {grade && <span className={tagClass(grade.color)}>{grade.name}</span>}
          {team && <span className="badge off">{team.name}</span>}
        </div>
        <div className="wm-row-meta">{stationText}</div>
        {leader && <div className="wm-row-meta">Reports to {leader}</div>}
      </div>

      {tierOptions.length > 0 && (
        <label className="field">
          <span>Tier tag</span>
          <select value={grade?.id ?? ''} onChange={(e) => onChangeTier(e.target.value)}>
            <option value="" disabled>No tier yet</option>
            {tierOptions.map((g) => (
              <option key={g.id} value={g.id}>{g.name}</option>
            ))}
          </select>
        </label>
      )}

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
                  <span className="wm-row-meta"> {stationName(j.station_id)} · {j.unit}</span>
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
          function, granted per tier in Settings → Tier &amp; Station Tags setting.
        </p>
      )}
    </>
  )
}

/* ------------------------------------------------------------------ */
/* Worker profile pop-out: personal + payroll details for one worker. */
/* Tier, station and team come from where the person sits in the      */
/* chain, not from this form.                                         */
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
          Tier tag, station tag and team are not set here — drag the person
          onto the leader (or the team) they belong to in the chain.
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
