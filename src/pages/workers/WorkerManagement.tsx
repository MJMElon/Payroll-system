// ---------------------------------------------------------------------------
// TEAM MANAGE — the team chart.
//
// Three columns under the page banner:
//   LEFT    Pending Allocation. Everyone waiting to be placed, sticky so it
//           rides along as you scroll, and it takes drops both ways: drag a
//           card out to place someone, drag a name back in to un-place them.
//   MIDDLE  Formation, in two halves that match how the mill is organised:
//
//           ABOVE the station-head tier — one box, "Across all stations",
//           since those tiers run the whole mill:
//             Manager :    [ Rahim ]
//             Executive :  [ Chandran ]
//           The TOP tier is not here at all: it is managed in Settings →
//           Tier Access Manage, which lists its people under the module
//           sheet of the tag itself.
//
//           FROM the station-head tier down — one box per STATION, side by
//           side (they are the same tier), each closed until its name is
//           clicked. Inside an open box, a grid:
//           TEAMS ARE THE COLUMNS, named once at the top; TIERS ARE THE
//           ROWS, named once down the left:
//
//             ┌ STERILIZER & TIPPLER STATION ──────────────────────────┐
//             │ Station Head :      [ Norhayati ]                      │
//             │                     TEAM A            TEAM B           │
//             │ Assistant Station   [ Siti ]          [ Mei Ling ]     │
//             │ Head :              [ Zulkifli ]                       │
//             │ Operator :          [Anand][Faiz]     [Aina][Lim]      │
//             │                     [Devi][Joseph]                     │
//             └────────────────────────────────────────────────────────┘
//
//           A name never repeats what its column and row already say, and
//           the shape says the numbers, so nothing is counted out loud.
//   RIGHT   Profile details for whoever was clicked: a "Label : value"
//           sheet that the ✎ in its corner turns into one form, with Save
//           and Cancel. Tier, station and team are read-only there; they
//           follow where the person sits, so they change by dragging.
//
// Drops: on a block, they join that leader and that leader's team; on a
// grid cell, the team of that column at the tier of that row, reporting to
// the lowest person already above them in it; on a station's head row or a
// bare tier row, the tier (and station) alone. A pending card with no tier lands on
// the tier straight below whatever block it is dropped on.
//
// Access: THE TIER TAG RULES. Nobody reaches their own tier or the tiers
// above it, whatever their account role says — an Operator-tagged admin
// still cannot place anyone. Below that line, any leader may build their
// OWN branch with no capability at all; reaching into someone else's needs
// "Change other users' settings". Editing details needs "Edit profile
// details" and pay needs "Edit basic salary", each granted on its own per
// tier in Settings → Tier & Station Tags setting, so a lower tier can keep
// details tidy without ever seeing what anyone earns.
// ---------------------------------------------------------------------------
import { Fragment, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'
import { effectiveCapabilities, roleForTier, tagClass } from '../../lib/tags'
import { useWideShell } from '../../lib/useWideShell'
import {
  supabase,
  todayISO,
  type Grade,
  type Job,
  type PieceRate,
  type Profile,
  type Station,
  type Team,
} from '../../lib/supabase'

const RM = (n: number) => `RM ${n.toFixed(2)}`

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

/**
 * Chart order: exactly where the user dragged the block (chart_pos, lower
 * first). Anyone never hand-ordered queues at the end, by name.
 */
function byChartPos(a: Profile, b: Profile): number {
  const pa = a.chart_pos ?? Number.POSITIVE_INFINITY
  const pb = b.chart_pos ?? Number.POSITIVE_INFINITY
  if (pa !== pb) return pa - pb
  return displayName(a).localeCompare(displayName(b))
}

/** Pending Allocation order: first signed up, first in line to be placed. */
function bySignup(a: Profile, b: Profile): number {
  return (a.created_at ?? '').localeCompare(b.created_at ?? '')
}

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
  // Which station boxes are open. A station is a lot of chart, so they
  // start closed and open on their own name.
  const [openStations, setOpenStations] = useState<Record<string, boolean>>({})
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropKey, setDropKey] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  async function load() {
    const [p, g, s, t, j, r] = await Promise.all([
      supabase.from('shared_profiles').select('*').order('full_name'),
      supabase.from('shared_grades').select('*').order('sort_order'),
      supabase.from('shared_stations').select('*').order('sort_order'),
      supabase.from('shared_teams').select('*').order('sort_order'),
      supabase
        .from('piece_rate_jobs')
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
  // The Worker ID is the payroll key, so retyping it is not covered by
  // the general profile grant — it takes its own tick.
  const canEditWorkerId = isTop || myCaps.includes('worker-id-edit')
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

  const confirmed = profiles.filter((p) => p.tags_confirmed).sort(byChartPos)
  const pending = profiles.filter((p) => !p.tags_confirmed).sort(bySignup)

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

  /**
   * Which row/cell a block stands in: the tier, the team and the station
   * together. Two people with the same key are side by side on the chart,
   * so dropping one on the other REORDERS instead of re-placing.
   */
  const slotKey = (p: Profile) =>
    `${p.grade_id ?? ''}|${p.team_id ?? ''}|${stationsOf(p).slice().sort().join(',')}`

  // Does the database have the chart_pos column yet? select('*') returns it
  // on every row once setup.sql has been re-run; until then placements must
  // not mention it or every drag would fail outright.
  const hasChartPos = profiles.length > 0 && 'chart_pos' in profiles[0]

  /**
   * The first tier that belongs to ONE station. Everything from here down
   * carries station tags and a basic salary; the tiers above it run the
   * whole mill, so they sit on every station and are not paid per station.
   * Read from the tag names, and failing that from the data.
   */
  const stationTier = useMemo(() => {
    const named = grades
      .filter((g) => /station/i.test(g.name))
      .sort((a, b) => a.sort_order - b.sort_order)[0]
    if (named) return named.sort_order
    const tiers = grades
      .filter((g) => profiles.some((p) => p.grade_id === g.id && stationsOf(p).length > 0))
      .map((g) => g.sort_order)
    return tiers.length > 0 ? Math.min(...tiers) : null
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [grades, profiles])
  /** Does this tier work at a station, or across all of them? */
  const worksAtAStation = (tier: number | null) =>
    tier !== null && stationTier !== null && tier >= stationTier

  const stationsInScope = seesAll
    ? stations
    : stations.filter((st) => myStationIds.length === 0 || myStationIds.includes(st.id))

  // The tiers from the station tier down, in order: the head tier, the tier
  // under it (the assistants), and everything deeper.
  const stationGrades = grades.filter((g) => worksAtAStation(g.sort_order))
  const headGrade = stationGrades[0] ?? null

  const selected = selectedId ? profiles.find((p) => p.id === selectedId) ?? null : null

  // One row per tier, top tier first — EVERY tier, including the ones
  // nobody stands on yet, so it is obvious where a card can be dropped.
  // Every name stays on its row; clicking a block only opens it.
  // The top tier is not on this chart: it is managed in Settings → Tier
  // Access Manage, where its people are listed under the module sheet.
  const rows = useMemo(
    () =>
      grades
        .filter((g) => g.sort_order !== 1)
        .map((g) => ({
        grade: g,
        people: visible.filter((p) => p.grade_id === g.id).sort(byChartPos),
      })),
    [grades, visible],
  )

  // People with no tier tag at all.
  const looseRow = useMemo(() => visible.filter((p) => !p.grade_id), [visible])

  /* ---------------- team actions ---------------- */

  /**
   * Add a team to a station. It belongs to the station-head tier and to
   * the station it was added in; its name is the first "Team A", "Team B",
   * … not already used AT THAT STATION, since two teams at one station
   * reading the same is exactly what makes a chart useless.
   */
  async function createTeam(station: Station | null) {
    if (!headGrade) return
    const head = visible.find(
      (p) =>
        p.grade_id === headGrade.id &&
        (station ? stationsOf(p).includes(station.id) : stationsOf(p).length === 0),
    )
    const siblings = teams.filter((t) => (t.station_id ?? null) === (station?.id ?? null))
    const name = nextTeamName(siblings.map((t) => t.name))
    setError(null)
    const { data, error } = await supabase
      .from('shared_teams')
      .insert({
        name,
        grade_id: headGrade.id,
        station_id: station?.id ?? null,
        created_by: head?.id ?? profile?.id ?? null,
        sort_order: siblings.length,
      })
      .select()
      .single()
    if (error) {
      // A refusal here is nearly always the teams table missing its
      // policies (a half-applied setup.sql), so say which of the two it is
      // instead of passing the raw database message through.
      return setError(
        /row-level security/i.test(error.message)
          ? `The database refused a team at ${headGrade.name}. That needs a tier tag of ` +
            `${headGrade.name} or above — yours is ${myGrade?.name ?? 'not set'}. If it already is, ` +
            'the teams table has no write policy: run supabase/fix-team-policies.sql.'
          : error.message,
      )
    }
    if (data) {
      setRenamingId(data.id)
      setRenameDraft(data.name)
    }
    load()
  }

  async function saveTeamName(team: Team) {
    const name = renameDraft.trim()
    if (!name || name === team.name) return setRenamingId(null)
    // Two teams at one station may not read the same.
    const clash = teams.some(
      (t) =>
        t.id !== team.id &&
        (t.station_id ?? null) === (team.station_id ?? null) &&
        t.name.trim().toLowerCase() === name.toLowerCase(),
    )
    if (clash) {
      return setError(`This station already has a team called "${name}".`)
    }
    setRenamingId(null)
    const { error } = await supabase.from('shared_teams').update({ name }).eq('id', team.id)
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
    const { error } = await supabase.from('shared_teams').delete().eq('id', team.id)
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

    const patch: Record<string, unknown> = {
      supervisor_id: leader.id,
      team_id: team?.id ?? null,
      tags_confirmed: true,
    }
    // A fresh placement queues at the end of its new row/cell.
    if (hasChartPos) patch.chart_pos = null
    if (nextGrade) patch.grade_id = nextGrade.id
    const leaderStations = stationsOf(leader)
    if (!worksAtAStation(landing)) {
      // Station Head and above run every station, so the tag comes off.
      patch.station_ids = []
      patch.station_id = null
    } else if (leaderStations.length > 0) {
      patch.station_ids = leaderStations
      patch.station_id = leaderStations[0]
    }
    // Route access follows the tier tag, so placing someone also settles
    // which pages they may open. An admin is never demoted by a tag.
    const landedTier = nextGrade?.sort_order ?? pt
    const landedName = nextGrade?.name ?? gradeOf(person)?.name
    if (person.role !== 'admin') patch.role = roleForTier(landedTier, landedName)

    const { data, error } = await supabase
      .from('shared_profiles')
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
    // Two people must not share a phone number. Compared by its digits
    // alone, so "012-345 6789" and "0123456789" are the same number.
    if (typeof patch.phone === 'string' && patch.phone.trim() !== '') {
      const digits = (v: string) => v.replace(/\D/g, '')
      const mine = digits(patch.phone)
      const clash =
        mine === ''
          ? undefined
          : profiles.find((p) => p.id !== person.id && p.phone && digits(p.phone) === mine)
      if (clash) {
        setError(`That phone number already belongs to ${displayName(clash)}.`)
        return false
      }
    }
    // A staff number is unique too, and saying so beats a database error
    // about a constraint nobody outside this file has heard of.
    if (typeof patch.employee_code === 'string' && patch.employee_code.trim() !== '') {
      const code = patch.employee_code.trim().toLowerCase()
      const clash = profiles.find(
        (p) => p.id !== person.id && (p.employee_code ?? '').trim().toLowerCase() === code,
      )
      if (clash) {
        setError(`Staff no. ${patch.employee_code} already belongs to ${displayName(clash)}.`)
        return false
      }
    }
    setError(null)
    const { data, error } = await supabase
      .from('shared_profiles')
      .update(patch)
      .eq('id', person.id)
      .select('id')
    if (error) {
      // The database has the last word on uniqueness — two people saving
      // the same value at once would slip past the checks above. Name the
      // field that actually clashed: this form does not touch the email,
      // so blaming the email for every duplicate is just wrong.
      const where = error.message.toLowerCase()
      setError(
        error.code === '23505'
          ? where.includes('phone')
            ? 'That phone number is already used by someone else.'
            : where.includes('employee_code')
              ? 'That staff no. is already used by someone else.'
              : where.includes('email')
                ? 'That email is already used by another account.'
                : `Those details clash with another account (${error.message}).`
          : error.message,
      )
      return false
    }
    if (!data || data.length === 0) {
      setError(
        `The database would not let you edit ${displayName(person)} — that needs the ` +
          '"Edit profile details" or "Edit basic salary" function.',
      )
      return false
    }
    load()
    return true
  }

  /**
   * Drag a name out of the formation and back into Pending Allocation:
   * strips the tier, leader, team and station, so they queue again for
   * whoever decides where they belong.
   */
  async function sendBackToPending(person: Profile) {
    if (person.id === profile?.id) {
      return setError('You cannot move yourself on the chart — someone above you has to do that.')
    }
    if (!person.tags_confirmed) return
    if (!canMove(person)) {
      return setError(
        `You can only move someone who reports up to you, and ${displayName(person)} does not.`,
      )
    }
    setError(null)
    const patch: Record<string, unknown> = {
      grade_id: null,
      supervisor_id: null,
      team_id: null,
      station_ids: [],
      station_id: null,
      tags_confirmed: false,
    }
    if (hasChartPos) patch.chart_pos = null
    if (person.role !== 'admin') patch.role = 'operator'
    const { data, error } = await supabase
      .from('shared_profiles')
      .update(patch)
      .eq('id', person.id)
      .select('id')
    if (error) return setError(error.message)
    if (!data || data.length === 0) {
      return setError(
        `The database would not let you unplace ${displayName(person)} — that needs a higher tier.`,
      )
    }
    setSelectedId(null)
    load()
  }

  /**
   * Drop on the row itself, not on a block: it settles the tier and leaves
   * the leader alone. This is how an empty tier gets its first person —
   * without it, a tier nobody stands on can never be filled, since every
   * other route needs a block already sitting one tier above.
   */
  async function placeOnTier(person: Profile, grade: Grade, station?: Station | null) {
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
    if (hasChartPos) patch.chart_pos = null
    if (person.role !== 'admin') patch.role = roleForTier(grade.sort_order, grade.name)
    if (!worksAtAStation(grade.sort_order)) {
      // A tier above the station tier belongs to every station.
      patch.station_ids = []
      patch.station_id = null
    } else if (station) {
      // Dropped inside a station box: that is the station they work at.
      patch.station_ids = [station.id]
      patch.station_id = station.id
    }
    // A leader who is no longer above them cannot stay their leader.
    const sup = person.supervisor_id ? profiles.find((x) => x.id === person.supervisor_id) : null
    const supTier = sup ? tierOf(sup) : null
    if (!sup || supTier === null || supTier >= grade.sort_order) {
      patch.supervisor_id = null
      patch.team_id = null
    }
    const { data, error } = await supabase
      .from('shared_profiles')
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

  /**
   * Drop on a team's line inside a station box: the tier, the team and the
   * station are all settled by WHERE it landed, and they report to the
   * lowest person already above them in that team.
   */
  async function placeInTeam(
    person: Profile,
    grade: Grade,
    team: Team | null,
    station: Station | null,
  ) {
    if (person.id === profile?.id) {
      return setError('You cannot move yourself on the chart — someone above you has to do that.')
    }
    if (person.tags_confirmed && !canMove(person)) {
      return setError(
        `You can only move someone who reports up to you, and ${displayName(person)} does not.`,
      )
    }
    if (!belowMe(grade.sort_order)) {
      return setError(`${grade.name} is not below your own tier, so you cannot put anyone there.`)
    }
    const inTeam = team ? visible.filter((p) => p.team_id === team.id && p.id !== person.id) : []
    const leader =
      inTeam
        .filter((p) => (tierOf(p) ?? 99) < grade.sort_order)
        .sort((a, b) => (tierOf(b) ?? 0) - (tierOf(a) ?? 0))[0] ??
      (team?.created_by ? profiles.find((x) => x.id === team.created_by) ?? null : null)
    if (leader && !canPlaceUnder(leader)) {
      return setError(
        `You can only add people under yourself or under someone who reports up to you, and ` +
          `${displayName(leader)} is neither.`,
      )
    }
    setError(null)
    const patch: Record<string, unknown> = {
      grade_id: grade.id,
      team_id: team?.id ?? null,
      supervisor_id: leader?.id ?? null,
      tags_confirmed: true,
    }
    if (hasChartPos) patch.chart_pos = null
    if (person.role !== 'admin') patch.role = roleForTier(grade.sort_order, grade.name)
    if (station) {
      patch.station_ids = [station.id]
      patch.station_id = station.id
    }
    const { data, error } = await supabase
      .from('shared_profiles')
      .update(patch)
      .eq('id', person.id)
      .select('id')
    if (error) return setError(error.message)
    if (!data || data.length === 0) {
      return setError(
        `The database would not let you place ${displayName(person)} — that needs a higher ` +
          'tier, or the "Change other users\' settings" function.',
      )
    }
    load()
  }

  /**
   * Drop a block on a TEAMMATE in the same row/cell: the two names SWAP —
   * the dragged name takes the target's spot and the target moves to where
   * the dragged name stood. Nobody else in the row shifts. The whole slot
   * is renumbered 0,1,2… so the order the user put stays put.
   */
  async function swapBlocks(person: Profile, target: Profile) {
    if (person.id === target.id) return
    if (person.id === profile?.id) {
      return setError('You cannot move yourself on the chart — someone above you has to do that.')
    }
    if (!canMove(person)) {
      return setError(
        `You can only move someone who reports up to you, and ${displayName(person)} does not.`,
      )
    }
    setError(null)
    const order = visible.filter((p) => slotKey(p) === slotKey(target)).sort(byChartPos)
    const i = order.findIndex((p) => p.id === person.id)
    const j = order.findIndex((p) => p.id === target.id)
    if (i < 0 || j < 0) return
    ;[order[i], order[j]] = [order[j], order[i]]
    // Show the new order at once; the writes then make it stick.
    const pos = new Map(order.map((p, i) => [p.id, i]))
    setProfiles((cur) => cur.map((p) => (pos.has(p.id) ? { ...p, chart_pos: pos.get(p.id)! } : p)))
    const updates = order
      .map((p, i) => ({ p, i }))
      .filter(({ p, i }) => (p.chart_pos ?? null) !== i)
    const results = await Promise.all(
      updates.map(({ p, i }) =>
        supabase.from('shared_profiles').update({ chart_pos: i }).eq('id', p.id).select('id'),
      ),
    )
    const err = results.find((r) => r.error)?.error
    if (err) {
      setError(
        /chart_pos/i.test(err.message)
          ? 'The database is missing the chart_pos column — run the latest supabase/setup.sql ' +
            '(or just: alter table public.shared_profiles add column chart_pos int;).'
          : err.message,
      )
    } else if (results.length > 0 && results.every((r) => !r.data || r.data.length === 0)) {
      setError(
        `The database would not let you swap ${displayName(person)} — that needs a higher tier.`,
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
    if (!dragged || dragged.id === leader.id) return
    // Same row/cell: the two names swap places.
    if (dragged.tags_confirmed && slotKey(dragged) === slotKey(leader)) {
      void swapBlocks(dragged, leader)
      return
    }
    placeUnder(dragged, leader, team)
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

  /** The head count beside a tier label — faint, and silent at zero. */
  function countChip(n: number) {
    return n > 0 ? <span className="wm-srow-count">{n}</span> : null
  }

  /** The dashed slot that says a name may be dropped here. */
  function addSlot(canDrop: boolean) {
    if (!canDrop) return null
    return (
      <span className="wm-add-person" title="Drag a name here">
        + Add person
      </span>
    )
  }

  /** One person's block. `mini` is the compact one used deep in a team. */
  function block(p: Profile, mini = false, inContext = false) {
    const grade = gradeOf(p)
    const team = teamOf(p)
    const tier = tierOf(p)
    const isMe = p.id === profile?.id
    const key = `block:${p.id}`
    // A drop is welcome to place someone UNDER this block, or — when the
    // dragged name already stands in the same row/cell — to SWAP with it.
    const dragged = dragId ? profiles.find((x) => x.id === dragId) : null
    const swapping = Boolean(
      dragged && dragged.id !== p.id && dragged.tags_confirmed && slotKey(dragged) === slotKey(p),
    )
    const allowed = swapping ? canMove(dragged!) : canPlaceUnder(p)
    // The station line only means something on the floor: the tiers above
    // run the whole mill, so their block is just a name.
    const onTheFloor = worksAtAStation(tier)
    return (
      <article
        key={p.id}
        className={[
          'wm-block',
          `fill-${grade?.color ?? 'grey'}`,
          mini ? 'mini' : '',
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
        {/* Hovering a teammate while dragging: the ⇄ says "these two will
            swap places", so the drop is never a guess. */}
        {swapping && dropKey === key && (
          <span className="wm-swap-mark" aria-hidden="true">⇄</span>
        )}
        <span className="wm-block-name" title={displayName(p)}>
          {displayName(p)}
          {isMe && <span className="you-chip">you</span>}
        </span>
        {/* Inside a station or team box the surrounding box already says
            the station and the team, so the block is just a name. */}
        {!mini && !inContext && onTheFloor && (
          <span className="wm-block-meta">
            {stationLabel(p)}
            {team ? ` · ${team.name}` : ''}
          </span>
        )}
      </article>
    )
  }

  /**
   * From the station-head tier down the chart is one box per STATION, and
   * inside the box a grid: TEAMS ARE THE COLUMNS, named once at the top,
   * TIERS ARE THE ROWS, named once down the left.
   *
   *   ┌ STERILIZER & TIPPLER STATION ─────────────────────────┐
   *   │ Station Head :             [ Norhayati ]              │
   *   │                    TEAM A            TEAM B           │
   *   │ Assistant Station  [ Siti ]          [ Mei Ling ]     │
   *   │ Head :             [ Zulkifli ]                       │
   *   │ Operator :         [Anand][Faiz]     [Aina][Lim]      │
   *   │                    [Devi][Joseph]                     │
   *   └───────────────────────────────────────────────────────┘
   *
   * so a name never repeats what its column and row already say.
   */
  function stationBox(station: Station | null) {
    if (!headGrade) return null
    const key = station?.id ?? 'nostation'
    const atStation = (p: Profile) =>
      station ? stationsOf(p).includes(station.id) : stationsOf(p).length === 0
    const here = visible.filter((p) => worksAtAStation(tierOf(p)) && atStation(p))
    const heads = here.filter((p) => p.grade_id === headGrade.id)
    const below = here.filter((p) => (tierOf(p) ?? 0) > headGrade.sort_order)
    const lowerGrades = stationGrades.slice(1)

    // This station's teams: the ones its heads made, the ones tagged to it,
    // and any team its people belong to.
    const boxTeams = teams
      .filter(
        (t) =>
          heads.some((h) => h.id === t.created_by) ||
          (station && t.station_id === station.id) ||
          here.some((p) => p.team_id === t.id),
      )
      .sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name))
    const hasLoose = below.some((p) => !p.team_id || !boxTeams.some((t) => t.id === p.team_id))
    const columns: (Team | null)[] = [...boxTeams, ...(hasLoose ? [null] : [])]

    const headRowKey = `srow:${key}:${headGrade.id}`
    const open = openStations[key] ?? false
    return (
      <section className={`wm-station-box ${open ? '' : 'shut'}`} key={key}>
        <button
          type="button"
          className="wm-station-head"
          aria-expanded={open}
          aria-label={`${open ? 'Collapse' : 'Expand'} ${station?.name ?? 'No station yet'}`}
          title={open ? 'Collapse' : 'Expand'}
          onClick={() => setOpenStations((m) => ({ ...m, [key]: !open }))}
        >
          <span className="wm-station-name">{station?.name ?? 'No station yet'}</span>
          {/* Chevrons pointing out to open, in to close — the symbol says
              it without a word to read. */}
          <span className="wm-station-toggle" aria-hidden="true">
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              {open ? (
                <>
                  <path d="M4 7l5 5-5 5" />
                  <path d="M20 7l-5 5 5 5" />
                </>
              ) : (
                <>
                  <path d="M9 7l-5 5 5 5" />
                  <path d="M15 7l5 5-5 5" />
                </>
              )}
            </svg>
          </span>
        </button>
        {open && (
          <>

        {/* The station head runs every team here, so they sit above the grid. */}
        <div className="wm-srow">
          <span className="wm-srow-label">{headGrade.name} :{countChip(heads.length)}</span>
          <div
            className={`wm-srow-body ${dropKey === headRowKey ? 'over' : ''}`}
            onDragOver={(e) => {
              if (!belowMe(headGrade.sort_order)) return
              e.preventDefault()
              e.dataTransfer.dropEffect = 'move'
              setDropKey(headRowKey)
            }}
            onDragLeave={() => setDropKey((cur) => (cur === headRowKey ? null : cur))}
            onDrop={(e) => {
              e.preventDefault()
              const carried = e.dataTransfer.getData('text/plain')
              const dragged = profiles.find((x) => x.id === (carried || dragId))
              setDragId(null)
              setDropKey(null)
              if (dragged) placeOnTier(dragged, headGrade, station)
            }}
          >
            {heads.map((one) => block(one, true, true))}
            {addSlot(belowMe(headGrade.sort_order))}
          </div>
        </div>

        {columns.length === 0 ? (
          <div className="wm-srow">
            <span className="wm-srow-label" />
            <div className="wm-srow-body">
              <span className="wm-cluster-empty">No team yet.</span>
              {canOwnTeamsAt(headGrade.sort_order, station?.id ?? null) && (
                <button
                  type="button"
                  className="wm-add-icon"
                  title={`Add a team at ${station?.name ?? 'this station'}`}
                  aria-label="Add team"
                  onClick={() => createTeam(station)}
                >
                  +
                </button>
              )}
            </div>
          </div>
        ) : (
          <div
            className="wm-grid"
            style={{
              // Two blocks wide, so a team column is never a single-file
              // queue of names and every station reads at the same rhythm.
              gridTemplateColumns: `9rem repeat(${columns.length}, 352px) auto`,
            }}
          >
            {/* Row of team names — the column headings, said once — with
                the add button at its right end, since a new team is a new
                column. */}
            <span />
            {columns.map((t, col) => (
              <div
                className={`wm-grid-head ${col % 2 ? 'alt' : ''} ${col > 0 ? 'divided' : ''}`}
                key={`h:${key}:${t?.id ?? 'none'}`}
              >
                {t && renamingId === t.id ? (
                  <input
                    className="wm-cluster-input"
                    autoFocus
                    value={renameDraft}
                    onChange={(e) => setRenameDraft(e.target.value)}
                    onBlur={() => saveTeamName(t)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') saveTeamName(t)
                      if (e.key === 'Escape') setRenamingId(null)
                    }}
                  />
                ) : (
                  <span className={`wm-tline-name ${t ? '' : 'none'}`}>{t ? t.name : 'No team'}</span>
                )}
                {t && canManageTeam(t) && renamingId !== t.id && (
                  <span className="wm-tline-tools">
                    <button
                      type="button"
                      className="wm-icon"
                      title="Rename team"
                      onClick={() => {
                        setRenamingId(t.id)
                        setRenameDraft(t.name)
                      }}
                    >
                      ✎
                    </button>
                    <button
                      type="button"
                      className="wm-icon danger"
                      title="Remove team"
                      onClick={() => removeTeam(t, below.filter((p) => p.team_id === t.id).length)}
                    >
                      ×
                    </button>
                  </span>
                )}
              </div>
            ))}
            <div className="wm-grid-head add">
              {canOwnTeamsAt(headGrade.sort_order, station?.id ?? null) && (
                <button
                  type="button"
                  className="wm-add-icon"
                  title={`Add a team at ${station?.name ?? 'this station'}`}
                  aria-label="Add team"
                  onClick={() => createTeam(station)}
                >
                  +
                </button>
              )}
            </div>

            {/* One row per tier below the head. */}
            {lowerGrades.map((g) => (
              <Fragment key={g.id}>
                <span className="wm-srow-label">
                  {g.name} :{countChip(below.filter((p) => p.grade_id === g.id).length)}
                </span>
                {columns.map((t, col) => {
                  const cellKey = `cell:${key}:${g.id}:${t?.id ?? 'none'}`
                  const people = below.filter(
                    (p) =>
                      p.grade_id === g.id &&
                      (t
                        ? p.team_id === t.id
                        : !p.team_id || !boxTeams.some((bt) => bt.id === p.team_id)),
                  )
                  return (
                    <div
                      className={[
                        'wm-cell',
                        col % 2 ? 'alt' : '',
                        col > 0 ? 'divided' : '',
                        dropKey === cellKey ? 'over' : '',
                      ].join(' ')}
                      key={cellKey}
                      onDragOver={(e) => {
                        if (!belowMe(g.sort_order)) return
                        e.preventDefault()
                        e.dataTransfer.dropEffect = 'move'
                        setDropKey(cellKey)
                      }}
                      onDragLeave={() => setDropKey((cur) => (cur === cellKey ? null : cur))}
                      onDrop={(e) => {
                        e.preventDefault()
                        const carried = e.dataTransfer.getData('text/plain')
                        const dragged = profiles.find((x) => x.id === (carried || dragId))
                        setDragId(null)
                        setDropKey(null)
                        if (dragged) placeInTeam(dragged, g, t, station)
                      }}
                    >
                      {people.map((one) => block(one, true, true))}
                      {addSlot(belowMe(g.sort_order))}
                    </div>
                  )
                })}
                <span />
              </Fragment>
            ))}
          </div>
        )}
          </>
        )}
      </section>
    )
  }

  /**
   * A tier row above the station floor: the tier name on the left, its
   * people on the right — the same shape as a row inside a station box, so
   * the whole chart reads one way.
   */
  function tierRow(grade: Grade | null, people: Profile[]) {
    const rowKey = `tier:${grade?.id ?? 'untagged'}`
    const canDropHere = Boolean(grade) && canPlaceOnTier(grade as Grade)
    return (
      <div className="wm-srow" key={grade?.id ?? 'untagged'}>
        <span className="wm-srow-label">
          {grade?.name ?? 'No tier tag'} :{countChip(people.length)}
        </span>
        <div
          className={`wm-srow-body ${dropKey === rowKey ? 'over' : ''}`}
          onDragOver={(e) => {
            if (!canDropHere) return
            e.preventDefault()
            e.dataTransfer.dropEffect = 'move'
            setDropKey(rowKey)
          }}
          onDragLeave={() => setDropKey((cur) => (cur === rowKey ? null : cur))}
          onDrop={(e) => grade && handleTierDrop(grade, e)}
        >
          {people.map((one) => block(one, true, true))}
          {canDropHere ? addSlot(true) : people.length === 0 && (
            <span className="wm-cluster-empty">Nobody on this tier yet</span>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="wm-page" style={wideStyle}>
      <header className="module-bar">
        <Link to="/" className="btn ghost backlink-btn">← Back to main page</Link>
      </header>
      <h1 className="module-banner">Team Manage</h1>

      {error && <div className="error">{error}</div>}

      <div className="wm-cols">
        {/* ---------- left: pending allocation, riding along as you scroll -- */}
        <aside className="wm-side">
          <div
            className={`wm-side-inner ${dropKey === 'pending' ? 'over' : ''}`}
            onDragOver={(e) => {
              const carried = dragId ? profiles.find((p) => p.id === dragId) : null
              if (carried && !carried.tags_confirmed) return
              e.preventDefault()
              e.dataTransfer.dropEffect = 'move'
              setDropKey('pending')
            }}
            onDragLeave={() => setDropKey((cur) => (cur === 'pending' ? null : cur))}
            onDrop={(e) => {
              e.preventDefault()
              const carried = e.dataTransfer.getData('text/plain')
              const dragged = profiles.find((p) => p.id === (carried || dragId))
              setDragId(null)
              setDropKey(null)
              if (dragged) sendBackToPending(dragged)
            }}
          >
            <button
              type="button"
              className="wm-side-title"
              aria-expanded={signupsOpen}
              onClick={() => setSignupsOpen((v) => !v)}
            >
              <span className="wm-side-caret" aria-hidden="true">{signupsOpen ? '▾' : '▸'}</span>
              <span className="wm-side-label">Pending Allocation</span>
              {pending.length > 0 && <span className="count-badge static">{pending.length}</span>}
            </button>
            {signupsOpen &&
              (pending.length === 0 ? (
                <p className="muted small" style={{ margin: 0 }}>
                  Nothing pending. Drag a name here to take them out of the formation.
                </p>
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
          {/* Above the station floor: one box, since those tiers run the
              whole mill rather than a station. */}
          {rows.some((r) => !worksAtAStation(r.grade.sort_order)) && (
            <section className="wm-station-box wm-all-stations">
              <header className="wm-station-head">
                <span className="wm-station-name">Across all stations</span>
              </header>
              {rows
                .filter((r) => !worksAtAStation(r.grade.sort_order))
                .map((r) => tierRow(r.grade, r.people))}
            </section>
          )}
          {/* Station tier and below: one box per station. */}
          {headGrade && (
            <div className="wm-stations">
              {stationsInScope.map((st) => stationBox(st))}
              {visible.some((p) => worksAtAStation(tierOf(p)) && stationsOf(p).length === 0) &&
                stationBox(null)}
            </div>
          )}
          {!headGrade && rows.map((r) => tierRow(r.grade, r.people))}
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
              canEditWorkerId={canEditWorkerId}
              canEditSalary={canEditSalary && worksAtAStation(tierOf(selected))}
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
  canEditWorkerId,
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
  canEditWorkerId: boolean
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
      patch.phone = form.phone.trim() || null
    }
    if (canEditWorkerId) patch.employee_code = form.employee_code.trim() || null
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

  const canEdit = canEditProfile || canEditWorkerId || canEditSalary
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
              <EditRow label="Name" value={form.full_name} onChange={set('full_name')} />
              {canEditWorkerId ? (
                <EditRow label="Staff no." value={form.employee_code} onChange={set('employee_code')} />
              ) : (
                <Row label="Staff no." value={person.employee_code} />
              )}
              <Row label="Station" value={stationText} />
              <Row label="Team" value={team?.name} />
              <Row label="Email" value={person.email} />
              <EditRow label="Phone" value={form.phone} onChange={set('phone')} />
            </>
          ) : (
            <>
              <Row label="Tier" value={tierChip} />
              <Row label="Name" value={displayName(person)} />
              {canEditWorkerId && (
                <EditRow label="Staff no." value={form.employee_code} onChange={set('employee_code')} />
              )}
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
          Editing a worker needs the "Edit profile details" or "Edit basic salary" function, granted
          per tier in Settings → Tier &amp; Station Tags setting.
        </p>
      )}
    </>
  )
}
