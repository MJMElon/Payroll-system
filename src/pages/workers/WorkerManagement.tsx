// ---------------------------------------------------------------------------
// TEAM MANAGE — the team chart.
//
// Three columns under the page banner:
//   LEFT    New signups. Sticky, so the cards ride along as you scroll down
//           to the operator row and drag one onto a block.
//   MIDDLE  Formation. One row per tier, top tier first, drawn as blocks:
//
//             MANAGER                 [ Manager Raj ]
//             ENGINEER                [ Wong ][ Siva ][ Tan ] …
//             STATION HEAD            [ Ahmad ][ Chin ] …
//
//           EVERY tier gets a row, including the ones nobody stands on, so
//           it is always clear where a card can go: dropping on the row
//           itself settles the tier and leaves the leader alone. Every name
//           stays on its row — clicking a block only opens it.
//   RIGHT   Profile details for whoever was clicked: a "Label : value"
//           sheet that the ✎ in its corner turns into one form — name,
//           staff details and pay, with Save and Cancel. Tier, station and
//           team are read-only there; they follow where the person sits on
//           the chart, so they change by dragging, not by typing.
//
// Teams are the clusters inside a row: "+ Team" on a leader's block makes
// one at that leader's tier and station, named inline. Drop someone on a
// block and they join that leader (and that leader's team); drop them on a
// cluster and they join that team, under whoever made it. A new signup with
// no tier lands on the tier straight below the block, and takes its station.
//
// Access: THE TIER TAG RULES. Nobody reaches their own tier or the tiers
// above it, whatever their account role says — an Operator-tagged admin
// still cannot place anyone. Below that line, any leader may build their
// OWN branch with no capability at all; reaching into someone else's needs
// "Change other users' settings". Editing details needs "Edit worker
// profile" and pay needs "Edit worker salary", each granted on its own per
// tier in Settings → Tier & Station Tags setting, so a lower tier can keep
// details tidy without ever seeing what anyone earns.
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
  type Profile,
  type Role,
  type Station,
  type Team,
} from '../../lib/supabase'

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

/** Has this account been given a real name, or is it still the email? */
function hasName(p: Profile | undefined | null): boolean {
  const n = p?.full_name?.trim()
  return Boolean(n && n.toLowerCase() !== (p?.email ?? '').trim().toLowerCase())
}

/**
 * What the chart calls someone: their name once it is set, otherwise the
 * part of their email before the @ — an email address is not a name, and
 * the chart is a page we show the team.
 */
function displayName(p: Profile | undefined | null): string {
  if (!p) return '?'
  if (hasName(p)) return p.full_name!.trim()
  const local = (p.email ?? '').split('@')[0]
  return local || p.id.slice(0, 8)
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
  const [signupsOpen, setSignupsOpen] = useState(true)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropKey, setDropKey] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
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

  // THE TIER TAG RULES THIS PAGE, not the account's role. An operator
  // tagged as such cannot reach the tiers above them however they are
  // flagged elsewhere. The one exception is an account with no tier tag at
  // all that is flagged admin: somebody has to be able to set the very
  // first tier, and they sit above everyone until they are tagged.
  const myTierEff = myTier ?? (isAdmin ? 0 : null)
  const isTop = myTierEff !== null && myTierEff <= 1
  /** Is that tier strictly below mine — the only direction I may reach? */
  const belowMe = (tier: number | null) =>
    tier !== null && myTierEff !== null && tier > myTierEff

  // Who sees the whole chain vs. only their own branch. Everyone gets to
  // LOOK at the chart — it is the page we show the team — and what they
  // may change is settled action by action, by tier.
  const seesAll = isTop || myCaps.includes('user-access')
  // Granted functions. Building your OWN branch is always allowed.
  const canEditProfile = isTop || myCaps.includes('worker-edit')
  // Pay is its own grant, so a lower tier can keep details tidy without
  // ever seeing what anyone earns.
  const canEditSalary = isTop || myCaps.includes('worker-salary')
  // Reaching into someone ELSE's branch. Still tier-bound: this widens
  // which branch you may touch, never how far up you may reach.
  const canAssignAnywhere = isTop || myCaps.includes('user-access')

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

  /**
   * May I rename / remove / add a team at this tier + station? This mirrors
   * the teams row-level security policy exactly — a tier tag, at or above
   * the tier the team belongs to — so the button never offers something
   * the database will refuse.
   */
  const canOwnTeamsAt = (tier: number, stationId: string | null) =>
    myTier !== null &&
    (myTier === 1 || myCaps.includes('user-access') || myTier <= tier) &&
    stationInScope(stationId)
  const canManageTeam = (t: Team) => canOwnTeamsAt(teamTier(t), t.station_id)
  /** May I hang someone under this leader? */
  const canPlaceUnder = (leader: Profile) =>
    canAssignAnywhere || leader.id === profile?.id || inMyBranch(leader)
  /** May I move this person out of where they are now? */
  const canMove = (p: Profile) =>
    p.id !== profile?.id &&
    belowMe(tierOf(p)) &&
    (canAssignAnywhere || inMyBranch(p) || p.supervisor_id === profile?.id)
  /** May I put someone on this tier without giving them a leader yet? */
  const canPlaceOnTier = (g: Grade) => belowMe(g.sort_order)

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

  // One row per tier, top tier first — EVERY tier, including the ones
  // nobody stands on yet, so it is obvious where a card can be dropped.
  // Every name stays on its row; clicking a block only opens it.
  const rows = useMemo(
    () =>
      grades.map((g) => ({
        grade: g,
        people: visible
          .filter((p) => p.grade_id === g.id)
          .sort((a, b) => displayName(a).localeCompare(displayName(b))),
      })),
    [grades, visible],
  )

  // People with no tier tag at all.
  const looseRow = useMemo(() => visible.filter((p) => !p.grade_id), [visible])

  /** Split a tier row into its teams, in team order, no-team last. */
  function clustersFor(people: Profile[]): Group[] {
    const present = teams
      .filter((t) => people.some((p) => p.team_id === t.id))
      .sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name))
    if (present.length === 0) return [{ team: null, people }]
    const groups: Group[] = present.map((t) => ({
      team: t,
      people: people.filter((p) => p.team_id === t.id),
    }))
    const rest = people.filter((p) => !p.team_id || !present.some((t) => t.id === p.team_id))
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
    load()
  }

  /* ---------------- moving people ---------------- */

  async function placeUnder(person: Profile, leader: Profile, team: Team | null) {
    if (person.id === leader.id) return
    if (person.id === profile?.id) {
      return setError('You cannot move yourself on the chart — someone above you has to do that.')
    }
    if (!canPlaceUnder(leader)) {
      return setError(
        `You can only add people under yourself or under someone who reports up to you, and ` +
          `${displayName(leader)} is neither. The "Assign workers to ANY team" function opens this up.`,
      )
    }
    if (person.tags_confirmed && !canMove(person)) {
      return setError(
        `You can only move someone who reports up to you, and ${displayName(person)} does not. ` +
          'The "Assign workers to ANY team" function opens this up.',
      )
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
    // The tier tag rules: nobody reaches their own tier or above it.
    const landing = nextGrade?.sort_order ?? pt
    if (!belowMe(landing)) {
      const name = nextGrade?.name ?? gradeOf(person)?.name ?? 'that tier'
      return setError(
        `${name} is not below your own tier, so you cannot put anyone there.` +
          (myTier === null ? ' Your account has no tier tag yet.' : ''),
      )
    }
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
        `The database would not let you place ${displayName(person)} — that needs a higher ` +
          'tier, or the "Change other users\' settings" function.',
      )
    }
    load()
  }

  /**
   * Save the Profile details form. Returns whether it stuck, so the panel
   * knows to close the form. Row-level security refuses by matching no
   * row, which PostgREST reports as a success that changed nothing.
   */
  async function saveProfile(person: Profile, patch: Record<string, unknown>): Promise<boolean> {
    if (Object.keys(patch).length === 0) return true
    if (patch.basic_salary != null) {
      const n = Number(patch.basic_salary)
      if (!Number.isFinite(n) || n < 0) {
        setError('Basic salary must be a positive number.')
        return false
      }
      patch.basic_salary = n
    }
    setError(null)
    const { data, error } = await supabase
      .from('access_profiles')
      .update(patch)
      .eq('id', person.id)
      .select('id')
    if (error) {
      setError(error.message)
      return false
    }
    if (!data || data.length === 0) {
      setError(
        `The database would not let you edit ${displayName(person)} — that needs the ` +
          '"Edit worker profile" or "Edit worker salary" function.',
      )
      return false
    }
    load()
    return true
  }

  /**
   * Drop on the row itself, not on a block: it settles the tier and leaves
   * the leader alone. This is how an empty tier gets its first person —
   * without it, a tier nobody stands on can never be filled, since every
   * other route needs a block already sitting one tier above.
   */
  async function placeOnTier(person: Profile, grade: Grade) {
    if (person.id === profile?.id) {
      return setError('You cannot move yourself on the chart — someone above you has to do that.')
    }
    if (!canPlaceOnTier(grade)) {
      return setError(`${grade.name} is not below your own tier, so you cannot put someone on it.`)
    }
    if (person.tags_confirmed && !canMove(person)) {
      return setError(
        `You can only move someone who reports up to you, and ${displayName(person)} does not. ` +
          'The "Assign workers to ANY team" function opens this up.',
      )
    }
    setError(null)
    const patch: Record<string, unknown> = { grade_id: grade.id, tags_confirmed: true }
    if (person.role !== 'admin') patch.role = roleForTier(grade.sort_order, grade.name)
    // A leader who is no longer above them cannot stay their leader.
    const sup = person.supervisor_id ? profiles.find((x) => x.id === person.supervisor_id) : null
    const supTier = sup ? tierOf(sup) : null
    if (!sup || supTier === null || supTier >= grade.sort_order) {
      patch.supervisor_id = null
      patch.team_id = null
    }
    const { data, error } = await supabase
      .from('access_profiles')
      .update(patch)
      .eq('id', person.id)
      .select('id')
    if (error) return setError(error.message)
    if (!data || data.length === 0) {
      return setError(
        `The database would not let you put ${displayName(person)} on ${grade.name} — that needs ` +
          'a higher tier, or the "Change other users\' settings" function.',
      )
    }
    load()
  }

  function handleTierDrop(grade: Grade, e: React.DragEvent) {
    e.preventDefault()
    const carried = e.dataTransfer.getData('text/plain')
    const dragged = profiles.find((p) => p.id === (carried || dragId))
    setDragId(null)
    setDropKey(null)
    if (dragged) placeOnTier(dragged, grade)
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

  /** Nothing to gain from dragging what cannot be dropped anywhere. */
  const canDrag = (p: Profile) =>
    p.tags_confirmed ? canMove(p) : myTierEff !== null && myTierEff < bottomTier

  function dragProps(p: Profile) {
    return {
      draggable: canDrag(p),
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
          selectedId === p.id ? 'selected' : '',
          dragId === p.id ? 'dragging' : '',
          dropKey === key ? 'over' : '',
          isMe ? 'me' : '',
        ].join(' ')}
        onClick={() => setSelectedId(p.id)}
        {...dragProps(p)}
        {...dropProps(key, p, team, allowed)}
      >
        <span className={`wm-block-bar dot-${grade?.color ?? 'grey'}`} aria-hidden="true" />
        <span className="wm-block-name">
          {displayName(p)}
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
              title={`Add a team under ${displayName(p)}`}
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

  /** A tier row: every name on that tier, split into its teams. */
  function tierRow(grade: Grade | null, people: Profile[]) {
    const clusters = clustersFor(people)
    const bare = clusters.length === 1 && !clusters[0].team
    const rowKey = `tier:${grade?.id ?? 'untagged'}`
    // Dropping on the row itself only settles the tier — that is how the
    // first person lands on a tier nobody stands on yet.
    const rowDrop = grade && canPlaceOnTier(grade)
      ? {
          onDragOver: (e: React.DragEvent) => {
            e.preventDefault()
            e.dataTransfer.dropEffect = 'move' as const
            setDropKey(rowKey)
          },
          onDragLeave: () => setDropKey((cur) => (cur === rowKey ? null : cur)),
          onDrop: (e: React.DragEvent) => handleTierDrop(grade, e),
        }
      : {}
    return (
      <section className="wm-tier-row" key={grade?.id ?? 'untagged'}>
        <div className="wm-tier-head">
          <span className={`tag-dot dot-${grade?.color ?? 'grey'}`} aria-hidden="true" />
          <h2 className="wm-tier-name">{grade?.name ?? 'No tier tag'}</h2>
          <span className="wm-tier-n">{people.length}</span>
        </div>
        <div className={`wm-row-blocks ${dropKey === rowKey ? 'over' : ''}`} {...rowDrop}>
          {people.length === 0 && (
            <p className="wm-row-empty">
              {grade && canPlaceOnTier(grade)
                ? `Nobody on this tier yet — drop a name here to make them ${grade.name}.`
                : 'Nobody on this tier yet.'}
            </p>
          )}
          {bare
            ? clusters[0].people.map(block)
            : clusters.map((c) => {
                // A team's own leader takes the drop, so a card dropped on
                // the cluster joins that team under the person who made it.
                const owner = c.team?.created_by
                  ? profiles.find((x) => x.id === c.team?.created_by) ?? null
                  : null
                const key = `cluster:${grade?.id ?? 'x'}:${c.team?.id ?? 'none'}`
                return (
                  <div className="wm-cluster" key={key}>
                    <div
                      className={`wm-cluster-head ${dropKey === key ? 'over' : ''}`}
                      {...(owner ? dropProps(key, owner, c.team, canPlaceUnder(owner)) : {})}
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
                          {owner && (
                            <span className="wm-cluster-of">{' · '}{displayName(owner)}</span>
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
      <h1 className="wm-page-title">Team Manage</h1>

      {error && <div className="error">{error}</div>}

      <div className="wm-cols">
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
                      className={`wm-block wm-signup ${dragId === p.id ? 'dragging' : ''} ${
                        selectedId === p.id ? 'selected' : ''
                      }`}
                      onClick={() => setSelectedId(p.id)}
                      {...dragProps(p)}
                    >
                      <span className="wm-block-bar new" aria-hidden="true" />
                      <span className="wm-block-name">{displayName(p)}</span>
                      <span className="wm-block-meta">
                        {hasName(p) ? 'Waiting for a team' : 'No name yet'}
                      </span>
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
          </div>

          {rows.length === 0 && looseRow.length === 0 && (
            <p className="muted small">No one on the chart yet.</p>
          )}
          {rows.map((r) => tierRow(r.grade, r.people))}
          {looseRow.length > 0 && tierRow(null, looseRow)}
        </section>

        {/* ---------- right: the person you opened ------------------------ */}
        <aside className="wm-panel">
          {selected ? (
            <WorkerPanel
              key={selected.id}
              person={selected}
              grade={gradeOf(selected) ?? null}
              team={teamOf(selected)}
              stationText={stationLabel(selected)}
              jobs={jobs}
              rates={rates}
              canEditProfile={canEditProfile}
              canEditSalary={canEditSalary}
              onSave={(patch) => saveProfile(selected, patch)}
              onClose={() => setSelectedId(null)}
            />
          ) : (
            <>
              <div className="wm-panel-head">
                <h2 className="wm-section-title">Profile details</h2>
              </div>
              <p className="muted small" style={{ margin: 0 }}>
                Click any name to view profile.
              </p>
            </>
          )}
        </aside>
      </div>

    </div>
  )
}


/* ------------------------------------------------------------------ */
/* PROFILE DETAILS — everything about ONE person, opened by clicking   */
/* their block. One ✎ in the corner turns the whole card into a form;  */
/* Save writes it, Cancel drops it. Tier, station and team are not     */
/* edited here — those come from where the person sits on the chart.   */
/* ------------------------------------------------------------------ */

/** A read-only "Label : value" line. */
function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="wm-field">
      <span className="wm-field-label">{label}</span>
      <span className="wm-field-value">{value || '—'}</span>
    </div>
  )
}

/** The same line, holding an input. */
function EditRow({
  label,
  value,
  onChange,
  type = 'text',
  placeholder,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  type?: string
  placeholder?: string
}) {
  return (
    <label className="wm-field editing">
      <span className="wm-field-label">{label}</span>
      <input
        className="wm-field-input"
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        {...(type === 'number' ? { min: '0', step: '50' } : {})}
      />
    </label>
  )
}

function WorkerPanel({
  person,
  grade,
  team,
  stationText,
  jobs,
  rates,
  canEditProfile,
  canEditSalary,
  onSave,
  onClose,
}: {
  person: Profile
  grade: Grade | null
  team: Team | null
  stationText: string
  jobs: Job[]
  rates: PieceRate[]
  canEditProfile: boolean
  canEditSalary: boolean
  onSave: (patch: Record<string, unknown>) => Promise<boolean>
  onClose: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState({
    full_name: person.full_name ?? '',
    employee_code: person.employee_code ?? '',
    phone: person.phone ?? '',
    basic_salary: person.basic_salary != null ? String(person.basic_salary) : '',
  })
  const set = (k: keyof typeof form) => (v: string) => setForm((f) => ({ ...f, [k]: v }))

  function startEdit() {
    setForm({
      full_name: person.full_name ?? '',
      employee_code: person.employee_code ?? '',
        phone: person.phone ?? '',
            basic_salary: person.basic_salary != null ? String(person.basic_salary) : '',
    })
    setEditing(true)
  }

  async function save() {
    const patch: Record<string, unknown> = {}
    if (canEditProfile) {
      patch.full_name = form.full_name.trim() || null
      patch.employee_code = form.employee_code.trim() || null
      patch.phone = form.phone.trim() || null
    }
    if (canEditSalary) {
      const v = form.basic_salary.trim()
      patch.basic_salary = v === '' ? null : Number(v)
    }
    setSaving(true)
    const ok = await onSave(patch)
    setSaving(false)
    if (ok) setEditing(false)
  }

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

  const canEdit = canEditProfile || canEditSalary
  const tierChip = grade ? <span className={tagClass(grade.color)}>{grade.name}</span> : null

  return (
    <>
      <div className="wm-panel-head">
        <h2 className="wm-section-title">Profile details</h2>
        <div className="wm-panel-tools">
          {canEdit && !editing && (
            <button type="button" className="wm-icon" title="Edit profile" onClick={startEdit}>
              ✎
            </button>
          )}
          <button className="modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>
      </div>

      {editing ? (
        <div className="wm-fields">
          {canEditProfile ? (
            <>
              <Row label="Tier" value={tierChip} />
              <EditRow label="Name" value={form.full_name} onChange={set('full_name')} placeholder="Full name" />
              <EditRow label="Staff no." value={form.employee_code} onChange={set('employee_code')} placeholder="EMP001" />
              <Row label="Station" value={stationText} />
              <Row label="Team" value={team?.name} />
              <EditRow label="Phone" value={form.phone} onChange={set('phone')} />
            </>
          ) : (
            <>
              <Row label="Tier" value={tierChip} />
              <Row label="Name" value={displayName(person)} />
              <Row label="Station" value={stationText} />
            </>
          )}
          {canEditSalary && (
            <EditRow
              label="Basic salary"
              type="number"
              value={form.basic_salary}
              onChange={set('basic_salary')}
              placeholder="RM per month"
            />
          )}
          <div className="wm-edit-actions">
            <button type="button" className="btn ghost sm" onClick={() => setEditing(false)}>
              Cancel
            </button>
            <button type="button" className="btn sm" onClick={save} disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      ) : (
        <div className="wm-fields">
          <Row label="Tier" value={tierChip} />
          <Row label="Name" value={displayName(person)} />
          <Row label="Staff no." value={person.employee_code} />
          <Row label="Station" value={stationText} />
          <Row label="Team" value={team?.name} />
          <Row label="Email" value={person.email} />
          <Row label="Phone" value={person.phone} />
          {canEditSalary && (
            <Row
              label="Basic salary"
              value={person.basic_salary != null ? RM(Number(person.basic_salary)) : null}
            />
          )}
          {!hasName(person) && (
            <p className="wm-name-hint">No name set — the chart is showing their email.</p>
          )}
        </div>
      )}

      <div className="wm-detail-block">
        <div className="wm-detail-title">Piece-rate contracts ({contracts.length})</div>
        {contracts.length === 0 ? (
          <p className="muted small" style={{ margin: 0 }}>
            No approved contracts match this person's tier and station.
          </p>
        ) : (
          contracts.map((j) => {
            const r = currentRate.get(j.id)
            return (
              <div className="wm-line" key={j.id}>
                <span>{j.name}</span>
                <span className="wm-line-amt">
                  {r
                    ? r.tier2_rate != null
                      ? `${Number(r.rate).toFixed(2)} → ${Number(r.tier2_rate).toFixed(2)} / ${j.unit}`
                      : `${Number(r.rate).toFixed(2)} / ${j.unit}`
                    : `— / ${j.unit}`}
                </span>
              </div>
            )
          })
        )}
      </div>

      {!canEdit && (
        <p className="muted small" style={{ margin: 0 }}>
          Editing a worker needs the "Edit worker profile" or "Edit worker salary" function, granted
          per tier in Settings → Tier &amp; Station Tags setting.
        </p>
      )}
    </>
  )
}
