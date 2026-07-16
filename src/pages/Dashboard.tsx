import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { supabase, type Station } from '../lib/supabase'
import { DEFAULT_MODULES } from '../lib/tags'

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
  desc: string
  icon: JSX.Element
  show: (canSeePayroll: boolean) => boolean
}

const MODULES: ModuleDef[] = [
  {
    key: 'payroll',
    to: '/payroll',
    title: 'Payroll',
    desc: 'Runs, adjustments & finalize',
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
    title: 'Piece Rate',
    desc: 'Rates, approvals & history',
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
    desc: 'Preview the mobile app per role',
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

  // What this USER can see — set per user in the access control panel.
  // Falls back to the tag's modules for accounts saved before the change.
  const [allowed, setAllowed] = useState<string[] | null>(null)
  useEffect(() => {
    async function load() {
      if (isManage) return setAllowed(null) // null = everything
      if (profile?.modules && profile.modules.length > 0) return setAllowed(profile.modules)
      if (!profile?.grade_id) return setAllowed(DEFAULT_MODULES)
      const { data } = await supabase
        .from('grades')
        .select('modules')
        .eq('id', profile.grade_id)
        .maybeSingle()
      setAllowed((data?.modules as string[] | undefined) ?? DEFAULT_MODULES)
    }
    load()
  }, [profile, isManage])

  const canSee = (key: string) => allowed === null || allowed.includes(key)

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
      <h1>Overall Status:</h1>

      {canSee('station-status') && <StationBoard />}

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
            <span className="tile-icon" aria-hidden="true">{m.icon}</span>
            <div>
              <h2>{m.title}</h2>
              <p className="muted small">{m.desc}</p>
            </div>
          </Link>
        ))}
      </div>
      <p className="muted small">Drag the blocks to arrange them in your preferred order.</p>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* 24-hour station status board. One row per station, one column per  */
/* hour of the mill day (07:00 → 07:00). Each cell is the quantity    */
/* recorded for that station during that hour. Click a station to     */
/* open its detail records.                                           */
/* ------------------------------------------------------------------ */

function StationBoard() {
  const navigate = useNavigate()
  const [stations, setStations] = useState<Station[]>([])
  const [sums, setSums] = useState<Map<string, number[]>>(new Map())
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const dayStart = currentDayStart()
  const nowSlot = Math.floor((Date.now() - dayStart.getTime()) / 3_600_000)
  const hours = Array.from({ length: 24 }, (_, i) => (DAY_START_HOUR + i) % 24)

  useEffect(() => {
    async function load() {
      const start = currentDayStart()
      const end = new Date(start.getTime() + 24 * 3_600_000)
      const [s, e] = await Promise.all([
        supabase.from('stations').select('id, name, sort_order').order('sort_order'),
        supabase
          .from('production_entries')
          .select('station_id, quantity, created_at')
          .gte('created_at', start.toISOString())
          .lt('created_at', end.toISOString()),
      ])
      const err = s.error || e.error
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

  return (
    <div className="card">
      <div className="row-form spread">
        <h3>Station status — {dateLabel}</h3>
        <span className="muted small">day runs 07:00 → 07:00 · auto-refreshes</span>
      </div>

      {error && <div className="error">{error}</div>}
      {loading ? (
        <p className="muted">Loading…</p>
      ) : (
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
      )}
      <p className="muted small">
        Each box is one hour; the number is the quantity recorded for that station in
        that hour. The highlighted column is the current hour. Click a station to open its
        records.
      </p>
    </div>
  )
}
