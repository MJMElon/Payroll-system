import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { supabase, type Station } from '../lib/supabase'

const DAY_START_HOUR = 7 // The mill day runs 07:00 → 07:00.

/** Most recent 07:00 that is not in the future. */
function currentDayStart(): Date {
  const d = new Date()
  d.setMinutes(0, 0, 0)
  d.setHours(DAY_START_HOUR)
  if (d.getTime() > Date.now()) d.setDate(d.getDate() - 1)
  return d
}

export default function Dashboard() {
  const { profile } = useAuth()
  const canSeePayroll = profile?.role === 'admin' || profile?.role === 'manager'

  return (
    <div className="stack">
      <h1>Overall Status:</h1>

      <StationBoard />

      <div className="module-grid">
        {canSeePayroll && (
          <Link to="/payroll" className="module-tile">
            <span className="tile-icon" aria-hidden="true">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="2" y="6" width="20" height="12" rx="2" />
                <circle cx="12" cy="12" r="3" />
                <path d="M6 12h.01M18 12h.01" />
              </svg>
            </span>
            <div>
              <h2>Payroll</h2>
              <p className="muted small">Runs, adjustments &amp; finalize</p>
            </div>
          </Link>
        )}
        {canSeePayroll && (
          <Link to="/piece-rate" className="module-tile">
            <span className="tile-icon" aria-hidden="true">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M20.59 13.41 12 22l-8.59-8.59A2 2 0 0 1 3 12V4a1 1 0 0 1 1-1h8a2 2 0 0 1 1.41.59l8.18 8.18a2 2 0 0 1 0 2.82z" />
                <circle cx="7.5" cy="7.5" r="1.5" />
              </svg>
            </span>
            <div>
              <h2>Piece Rate</h2>
              <p className="muted small">Monitor rates, changes &amp; history</p>
            </div>
          </Link>
        )}
        <Link to="/demo-mobile" className="module-tile">
          <span className="tile-icon" aria-hidden="true">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="7" y="2" width="10" height="20" rx="2.5" />
              <path d="M11 18h2" />
            </svg>
          </span>
          <div>
            <h2>Demo Mobile View</h2>
            <p className="muted small">Preview the mobile app per role</p>
          </div>
        </Link>
      </div>
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
