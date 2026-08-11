import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { supabase, type Grade, type Station } from '../lib/supabase'
import { ALWAYS_MODULES, DEFAULT_MODULES, tagClass } from '../lib/tags'

const DAY_START_HOUR = 7 // The mill day runs 07:00 → 07:00.

/** Most recent 07:00 that is not in the future. */
function currentDayStart(): Date {
  const d = new Date()
  d.setMinutes(0, 0, 0)
  d.setHours(DAY_START_HOUR)
  if (d.getTime() > Date.now()) d.setDate(d.getDate() - 1)
  return d
}

interface ModuleDef {
  key: string
  to: string
  title: string
  icon: JSX.Element
  show: (canSeePayroll: boolean) => boolean
}

const MODULES: ModuleDef[] = [
  {
    key: 'operation',
    to: '/operation',
    title: 'Operation Module',
    show: () => true,
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M8 6h13M8 12h13M8 18h13" />
        <path d="M3 6h.01M3 12h.01M3 18h.01" />
      </svg>
    ),
  },
  {
    key: 'worker-management',
    to: '/workers',
    title: 'Team Manage',
    show: () => true,
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="9" cy="8" r="3.5" />
        <path d="M2.5 20c0-3.5 3-5.5 6.5-5.5s6.5 2 6.5 5.5" />
        <circle cx="17.5" cy="9.5" r="2.5" />
        <path d="M16.5 14.6c2.9 0 5 1.7 5 4.4" />
      </svg>
    ),
  },
  {
    key: 'payroll',
    to: '/payroll',
    title: 'Payroll Reports',
    show: () => true,
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="2" y="6" width="20" height="12" rx="2" />
        <circle cx="12" cy="12" r="3" />
        <path d="M6 12h.01M18 12h.01" />
      </svg>
    ),
  },
  {
    key: 'piece-rate',
    to: '/piece-rate',
    title: 'Piece Rate Module',
    show: () => true,
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M20.59 13.41 12 22l-8.59-8.59A2 2 0 0 1 3 12V4a1 1 0 0 1 1-1h8a2 2 0 0 1 1.41.59l8.18 8.18a2 2 0 0 1 0 2.82z" />
        <circle cx="7.5" cy="7.5" r="1.5" />
      </svg>
    ),
  },
  {
    key: 'demo-mobile',
    to: '/demo-mobile',
    title: 'Demo Mobile View',
    show: () => true,
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="7" y="2" width="10" height="20" rx="2.5" />
        <path d="M11 18h2" />
      </svg>
    ),
  },
]

const ORDER_KEY = 'mjm-module-order'

export default function Dashboard() {
  const { profile } = useAuth()
  const isManage = profile?.role === 'admin' || profile?.role === 'manager'

  // What this USER can see. The TIER's modules (Settings → Tags management)
  // are the master switch; the per-user checkboxes in User access can only
  // narrow that list further, never extend it.
  const [allowed, setAllowed] = useState<string[] | null>(null)
  useEffect(() => {
    async function load() {
      if (isManage) return setAllowed(null) // null = everything
      if (!profile?.grade_id) {
        return setAllowed(
          profile?.modules && profile.modules.length > 0 ? profile.modules : DEFAULT_MODULES,
        )
      }
      const { data } = await supabase
        .from('shared_grades')
        .select('modules, sort_order')
        .eq('id', profile.grade_id)
        .maybeSingle()
      if (data?.sort_order === 1) return setAllowed(null) // super admin sees everything
      const tierMods = (data?.modules as string[] | undefined) ?? DEFAULT_MODULES
      const userMods = profile?.modules
      setAllowed(
        userMods && userMods.length > 0 ? tierMods.filter((m) => userMods.includes(m)) : tierMods,
      )
    }
    load()
  }, [profile, isManage])

  // The station status board is common to every tier, so it is never on
  // the allow-list — it is simply always open.
  const canSee = (key: string) =>
    allowed === null || ALWAYS_MODULES.includes(key) || allowed.includes(key)

  // Tile order is a personal preference — kept in this browser's storage.
  const [order, setOrder] = useState<string[]>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(ORDER_KEY) ?? '[]') as string[]
      const known = MODULES.map((m) => m.key)
      return [...saved.filter((k) => known.includes(k)), ...known.filter((k) => !saved.includes(k))]
    } catch {
      return MODULES.map((m) => m.key)
    }
  })
  const [dragKey, setDragKey] = useState<string | null>(null)

  function dropOn(targetKey: string) {
    if (!dragKey || dragKey === targetKey) return
    // Moving forward lands AFTER the target, moving backward lands BEFORE it —
    // so a drag works in both directions.
    const movingForward = order.indexOf(dragKey) < order.indexOf(targetKey)
    const next = order.filter((k) => k !== dragKey)
    next.splice(next.indexOf(targetKey) + (movingForward ? 1 : 0), 0, dragKey)
    setOrder(next)
    localStorage.setItem(ORDER_KEY, JSON.stringify(next))
    setDragKey(null)
  }

  const tiles = order
    .map((k) => MODULES.find((m) => m.key === k)!)
    .filter((m) => m && m.show(isManage || canSee(m.key)) && canSee(m.key))

  return (
    <div className="stack">
      <h1>Mill Performance</h1>

      {canSee('station-status') && <StationBoard />}
      {canSee('station-status') && <OnShiftBoard />}

      <div className="module-grid">
        {tiles.map((m) => (
          <Link
            key={m.key}
            to={m.to}
            className={`module-tile ${dragKey === m.key ? 'dragging' : ''}`}
            draggable
            onDragStart={() => setDragKey(m.key)}
            onDragEnd={() => setDragKey(null)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault()
              dropOn(m.key)
            }}
            title="Drag to reorder"
          >
            <span className="tile-grip" aria-hidden="true"><IconGrip /></span>
            <span className="tile-icon" aria-hidden="true">{m.icon}</span>
            <h2>{m.title}</h2>
          </Link>
        ))}
      </div>
    </div>
  )
}

/** Six-dot grip — the "you can drag this" mark, worn by every tile. */
function IconGrip() {
  return (
    <svg width="14" height="18" viewBox="0 0 14 18" fill="currentColor" aria-hidden="true">
      <circle cx="4" cy="4" r="1.6" />
      <circle cx="10" cy="4" r="1.6" />
      <circle cx="4" cy="9" r="1.6" />
      <circle cx="10" cy="9" r="1.6" />
      <circle cx="4" cy="14" r="1.6" />
      <circle cx="10" cy="14" r="1.6" />
    </svg>
  )
}

/* ------------------------------------------------------------------ */
/* All station performance. Three reads of the same records:          */
/*   Hourly — one column per hour of the mill day (07:00 → 07:00).    */
/*   This week / This month — one column per mill day, the chevron    */
/*   beside the title walking between the two.                        */
/* Click a station to open its detail records.                        */
/* ------------------------------------------------------------------ */

/** The mill day a timestamp belongs to, as a local YYYY-MM-DD key —
 *  work at 02:00 still counts to the day that started at 07:00 before. */
function millDayKey(t: string | Date): string {
  const d = new Date(t)
  d.setHours(d.getHours() - DAY_START_HOUR)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function keyOf(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function StationBoard() {
  const navigate = useNavigate()
  const [stations, setStations] = useState<Station[]>([])
  const [sums, setSums] = useState<Map<string, number[]>>(new Map())
  // station id -> mill-day key -> total, feeding the week and month reads.
  const [daySums, setDaySums] = useState<Map<string, Map<string, number>>>(new Map())
  const [range, setRange] = useState<'week' | 'month'>('week')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const dayStart = currentDayStart()
  const nowSlot = Math.floor((Date.now() - dayStart.getTime()) / 3_600_000)
  const hours = Array.from({ length: 24 }, (_, i) => (DAY_START_HOUR + i) % 24)

  // The week is Monday-first and holds the current mill day; the month is
  // the calendar month that day falls in.
  const todayKey = keyOf(dayStart)
  const weekDays = (() => {
    const monday = new Date(dayStart)
    monday.setHours(0, 0, 0, 0)
    monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7))
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(monday)
      d.setDate(monday.getDate() + i)
      return d
    })
  })()
  const monthDays = (() => {
    const first = new Date(dayStart.getFullYear(), dayStart.getMonth(), 1)
    const count = new Date(dayStart.getFullYear(), dayStart.getMonth() + 1, 0).getDate()
    return Array.from({ length: count }, (_, i) => {
      const d = new Date(first)
      d.setDate(i + 1)
      return d
    })
  })()

  useEffect(() => {
    async function load() {
      const start = currentDayStart()
      const end = new Date(start.getTime() + 24 * 3_600_000)

      // One fetch covers the week and the month: from the earlier of the
      // two starts to the later of the two ends, at mill-day boundaries.
      const monday = new Date(start)
      monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7))
      const monthFirst = new Date(start.getFullYear(), start.getMonth(), 1, DAY_START_HOUR)
      const spanStart = monday < monthFirst ? monday : monthFirst
      const weekEnd = new Date(monday.getTime() + 7 * 24 * 3_600_000)
      const monthEnd = new Date(start.getFullYear(), start.getMonth() + 1, 1, DAY_START_HOUR)
      const spanEnd = weekEnd > monthEnd ? weekEnd : monthEnd

      const [s, e, span] = await Promise.all([
        supabase.from('shared_stations').select('id, name, sort_order').order('sort_order'),
        supabase
          .from('operation_entries')
          .select('station_id, quantity, created_at, approval_status')
          .gte('created_at', start.toISOString())
          .lt('created_at', end.toISOString())
          .neq('approval_status', 'rejected'),
        supabase
          .from('operation_entries')
          .select('station_id, quantity, created_at, approval_status')
          .gte('created_at', spanStart.toISOString())
          .lt('created_at', spanEnd.toISOString())
          .neq('approval_status', 'rejected'),
      ])
      const err = s.error || e.error || span.error
      if (err) setError(err.message)
      setStations(s.data ?? [])

      const m = new Map<string, number[]>()
      for (const row of e.data ?? []) {
        const slot = Math.floor((new Date(row.created_at).getTime() - start.getTime()) / 3_600_000)
        if (slot < 0 || slot > 23) continue
        if (!m.has(row.station_id)) m.set(row.station_id, Array(24).fill(0))
        m.get(row.station_id)![slot] += Number(row.quantity)
      }
      setSums(m)

      const days = new Map<string, Map<string, number>>()
      for (const row of span.data ?? []) {
        const key = millDayKey(row.created_at)
        if (!days.has(row.station_id)) days.set(row.station_id, new Map())
        const perDay = days.get(row.station_id)!
        perDay.set(key, (perDay.get(key) ?? 0) + Number(row.quantity))
      }
      setDaySums(days)
      setLoading(false)
    }
    load()
    const timer = setInterval(load, 60_000) // refresh every minute
    return () => clearInterval(timer)
  }, [])

  const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1))
  const dateLabel = dayStart.toLocaleDateString(undefined, {
    weekday: 'short', year: 'numeric', month: 'short', day: 'numeric',
  })

  const rangeDays = range === 'week' ? weekDays : monthDays
  const rangeTitle =
    range === 'week'
      ? 'This week'
      : `This month — ${dayStart.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}`

  function dayBoard() {
    return (
      <div className="board-scroll">
        <table className="board">
          <thead>
            <tr>
              <th className="board-station">Station</th>
              {rangeDays.map((d) => {
                const k = keyOf(d)
                return (
                  <th key={k} className={k === todayKey ? 'now' : k > todayKey ? 'future' : ''}>
                    {range === 'week'
                      ? d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' })
                      : d.getDate()}
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody>
            {stations.map((s) => {
              const perDay = daySums.get(s.id)
              return (
                <tr
                  key={s.id}
                  className="board-row"
                  onClick={() => navigate(`/station/${s.id}`)}
                  title={`Open ${s.name} records`}
                >
                  <td className="board-station">
                    <Link to={`/station/${s.id}`} onClick={(e) => e.stopPropagation()}>
                      {s.name}
                    </Link>
                  </td>
                  {rangeDays.map((d) => {
                    const k = keyOf(d)
                    const v = perDay?.get(k) ?? 0
                    const cls = [
                      v > 0 ? 'filled' : '',
                      k === todayKey ? 'now' : '',
                      k > todayKey ? 'future' : '',
                    ].join(' ')
                    return (
                      <td key={k} className={cls}>
                        {v > 0 ? fmt(v) : ''}
                      </td>
                    )
                  })}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    )
  }

  return (
    <div className="card stack">
      <div className="row-form spread">
        <h3>All station performance</h3>
        <span className="muted small">day runs 07:00 → 07:00 · auto-refreshes</span>
      </div>

      {error && <div className="error">{error}</div>}
      {loading ? (
        <p className="muted">Loading…</p>
      ) : (
        <>
          <div className="board-sub">
            <h4>Hourly — {dateLabel}</h4>
          </div>
          <div className="board-scroll">
            <table className="board">
              <thead>
                <tr>
                  <th className="board-station">Station</th>
                  {hours.map((h, i) => (
                    <th key={i} className={i === nowSlot ? 'now' : i > nowSlot ? 'future' : ''}>
                      {String(h).padStart(2, '0')}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {stations.map((s) => {
                  const row = sums.get(s.id)
                  return (
                    <tr
                      key={s.id}
                      className="board-row"
                      onClick={() => navigate(`/station/${s.id}`)}
                      title={`Open ${s.name} records`}
                    >
                      <td className="board-station">
                        <Link to={`/station/${s.id}`} onClick={(e) => e.stopPropagation()}>
                          {s.name}
                        </Link>
                      </td>
                      {hours.map((_, i) => {
                        const v = row?.[i] ?? 0
                        const cls = [
                          v > 0 ? 'filled' : '',
                          i === nowSlot ? 'now' : '',
                          i > nowSlot ? 'future' : '',
                        ].join(' ')
                        return (
                          <td key={i} className={cls}>
                            {v > 0 ? fmt(v) : ''}
                          </td>
                        )
                      })}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          <div className="board-sub">
            <h4>{rangeTitle}</h4>
            <span className="board-range-nav">
              <button
                type="button"
                className="icon-btn"
                disabled={range === 'week'}
                title="Back to this week"
                aria-label="Show this week"
                onClick={() => setRange('week')}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                  strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                  <path d="m14 6-6 6 6 6" />
                </svg>
              </button>
              <button
                type="button"
                className="icon-btn"
                disabled={range === 'month'}
                title="Show this month"
                aria-label="Show this month"
                onClick={() => setRange('month')}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                  strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                  <path d="m10 6 6 6-6 6" />
                </svg>
              </button>
            </span>
          </div>
          {dayBoard()}
        </>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Who is on shift now: per station, the person behind the most       */
/* recent record of the current mill day — their name, tier tag and   */
/* team — so a glance says which crew is at each station.             */
/* ------------------------------------------------------------------ */

interface ShiftRow {
  station: Station
  name: string | null
  gradeId: string | null
  teamName: string | null
  at: string | null
}

function OnShiftBoard() {
  const [rows, setRows] = useState<ShiftRow[]>([])
  const [grades, setGrades] = useState<Grade[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function load() {
      const start = currentDayStart()
      const [s, g, e] = await Promise.all([
        supabase.from('shared_stations').select('id, name, sort_order').order('sort_order'),
        supabase.from('shared_grades').select('*').order('sort_order'),
        supabase
          .from('operation_entries')
          .select('station_id, user_id, created_by, created_at')
          .gte('created_at', start.toISOString())
          .order('created_at', { ascending: false }),
      ])
      setGrades((g.data as Grade[]) ?? [])

      // Newest entry per station; the person is whoever the record is for,
      // falling back to whoever keyed it in.
      const latest = new Map<string, { who: string | null; at: string }>()
      for (const row of e.data ?? []) {
        if (!latest.has(row.station_id)) {
          latest.set(row.station_id, { who: row.user_id ?? row.created_by, at: row.created_at })
        }
      }

      const ids = [...new Set([...latest.values()].map((l) => l.who).filter(Boolean))] as string[]
      const profiles = ids.length
        ? (await supabase.from('shared_profiles').select('id, full_name, email, grade_id, team_id').in('id', ids)).data ?? []
        : []
      const teamIds = [...new Set(profiles.map((p) => p.team_id).filter(Boolean))] as string[]
      const teams = teamIds.length
        ? (await supabase.from('shared_teams').select('id, name').in('id', teamIds)).data ?? []
        : []

      setRows(
        ((s.data as Station[]) ?? []).map((station) => {
          const l = latest.get(station.id)
          const p = l?.who ? profiles.find((x) => x.id === l.who) : undefined
          return {
            station,
            name: p ? p.full_name ?? p.email ?? null : null,
            gradeId: p?.grade_id ?? null,
            teamName: p?.team_id ? teams.find((t) => t.id === p.team_id)?.name ?? null : null,
            at: l?.at ?? null,
          }
        }),
      )
      setLoading(false)
    }
    load()
    const timer = setInterval(load, 60_000)
    return () => clearInterval(timer)
  }, [])

  const tierOf = (id: string | null) => (id ? grades.find((g) => g.id === id) : undefined)
  const timeOf = (iso: string) =>
    new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })

  return (
    <div className="card stack">
      <div className="row-form spread">
        <h3>On shift now</h3>
        <span className="muted small">latest record per station since 07:00</span>
      </div>
      {loading ? (
        <p className="muted">Loading…</p>
      ) : (
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Station</th>
                <th>Latest person</th>
                <th>Tier</th>
                <th>Team</th>
                <th className="right">Last record</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const tier = tierOf(r.gradeId)
                return (
                  <tr key={r.station.id}>
                    <td>{r.station.name}</td>
                    <td>{r.name ?? <span className="muted">No record yet today</span>}</td>
                    <td>
                      {tier ? (
                        <span className={tagClass(tier.color)}>{tier.name}</span>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td>{r.teamName ?? <span className="muted">—</span>}</td>
                    <td className="right muted">{r.at ? timeOf(r.at) : '—'}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
