import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { supabase, todayISO, type PayrollRun, type Station } from '../lib/supabase'

const DAY_START_HOUR = 7 // The mill day runs 07:00 → 07:00.

/** Most recent 07:00 that is not in the future. */
function currentDayStart(): Date {
  const d = new Date()
  d.setMinutes(0, 0, 0)
  d.setHours(DAY_START_HOUR)
  if (d.getTime() > Date.now()) d.setDate(d.getDate() - 1)
  return d
}

interface Stats {
  activeWorkers: number
  stations: number
  todayEntries: number
  todayQuantity: number
  lastRun: PayrollRun | null
}

export default function Dashboard() {
  const { profile, session } = useAuth()
  const [stats, setStats] = useState<Stats | null>(null)
  const canSeePayroll = profile?.role === 'admin' || profile?.role === 'manager'

  useEffect(() => {
    async function load() {
      const today = todayISO()
      const [workers, stations, entries, runs] = await Promise.all([
        supabase.from('workers').select('id', { count: 'exact', head: true }).eq('active', true),
        supabase.from('stations').select('id', { count: 'exact', head: true }),
        supabase.from('production_entries').select('quantity').eq('work_date', today),
        canSeePayroll
          ? supabase
              .from('payroll_runs')
              .select('id, period_start, period_end, status, created_at, finalized_at')
              .order('created_at', { ascending: false })
              .limit(1)
          : Promise.resolve({ data: [] as PayrollRun[] }),
      ])
      setStats({
        activeWorkers: workers.count ?? 0,
        stations: stations.count ?? 0,
        todayEntries: entries.data?.length ?? 0,
        todayQuantity: (entries.data ?? []).reduce((s, e) => s + Number(e.quantity), 0),
        lastRun: (runs.data && runs.data[0]) || null,
      })
    }
    load()
  }, [canSeePayroll])

  return (
    <div className="stack">
      <div>
        <h1>Dashboard</h1>
        <p className="muted">
          Signed in as {session?.user.email}
          {profile?.role ? ` — role: ${profile.role}` : ''}.
        </p>
      </div>

      <StationBoard />

      <div className="grid">
        <div className="card">
          <h3>Today's production</h3>
          <p className="stat">{stats ? stats.todayEntries : '…'}</p>
          <p className="muted small">
            entries · total quantity {stats ? stats.todayQuantity : '…'}
          </p>
          <Link to="/production" className="small">Open production →</Link>
        </div>

        <div className="card">
          <h3>Workforce</h3>
          <p className="stat">{stats ? stats.activeWorkers : '…'}</p>
          <p className="muted small">active workers across {stats ? stats.stations : '…'} stations</p>
          {canSeePayroll && <Link to="/settings" className="small">Manage in settings →</Link>}
        </div>

        {canSeePayroll && (
          <div className="card">
            <h3>Last payroll run</h3>
            {stats?.lastRun ? (
              <>
                <p className="stat small-stat">
                  {stats.lastRun.period_start} → {stats.lastRun.period_end}
                </p>
                <p className="muted small">
                  status:{' '}
                  <span className={`badge ${stats.lastRun.status === 'finalized' ? 'ok' : 'off'}`}>
                    {stats.lastRun.status}
                  </span>
                </p>
              </>
            ) : (
              <p className="muted small">No runs yet.</p>
            )}
            <Link to="/payroll" className="small">Open payroll →</Link>
          </div>
        )}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* 24-hour station status board. One row per station, one column per  */
/* hour of the mill day (07:00 → 07:00). Each cell is the quantity    */
/* recorded for that station during that hour.                        */
/* ------------------------------------------------------------------ */

function StationBoard() {
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
                  <tr key={s.id}>
                    <td className="board-station">{s.name}</td>
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
        that hour. The green column is the current hour.
      </p>
    </div>
  )
}
