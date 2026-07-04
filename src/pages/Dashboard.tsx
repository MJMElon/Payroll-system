import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { supabase, todayISO, type PayrollRun } from '../lib/supabase'

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
                  status: <span className={`badge ${stats.lastRun.status === 'finalized' ? 'ok' : 'off'}`}>
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
