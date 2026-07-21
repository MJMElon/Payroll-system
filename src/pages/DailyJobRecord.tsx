import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import {
  profileName,
  supabase,
  todayISO,
  type Grade,
  type Job,
  type Profile,
  type ProductionEntry,
  type Station,
} from '../lib/supabase'

const SHIFT_LABEL: Record<string, string> = {
  a: 'Shift A',
  b: 'Shift B',
}

// Landing page for the "Daily Job Record" module tile — Operators, Assistant
// Station Heads and Station Heads key in their production via "+ Add Job
// Record" (a fully separate page); this page is just the records list.
export default function DailyJobRecord() {
  const { profile } = useAuth()
  const [stations, setStations] = useState<Station[]>([])
  const [jobs, setJobs] = useState<Job[]>([])
  const [grades, setGrades] = useState<Grade[]>([])
  const [users, setUsers] = useState<Profile[]>([])
  const [entries, setEntries] = useState<ProductionEntry[]>([])
  const [workDate, setWorkDate] = useState(todayISO())
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const canManage = profile?.role === 'admin' || profile?.role === 'manager'
  const myStations =
    profile?.station_ids && profile.station_ids.length > 0
      ? profile.station_ids
      : profile?.station_id
        ? [profile.station_id]
        : []

  useEffect(() => {
    async function loadMaster() {
      const [s, j, g, u] = await Promise.all([
        supabase.from('stations').select('id, name, sort_order').order('sort_order'),
        supabase
          .from('jobs')
          .select('id, station_id, grade_id, name, unit, active, approval_status, verified_by, approved_by')
          .order('name'),
        supabase.from('grades').select('*').order('sort_order'),
        supabase.from('access_profiles').select('*').order('full_name'),
      ])
      setStations(s.data ?? [])
      setJobs(j.data ?? [])
      setGrades(g.data ?? [])
      setUsers((u.data ?? []) as Profile[])
      setLoading(false)
    }
    loadMaster()
  }, [])

  const visibleStations = useMemo(
    () => (canManage || myStations.length === 0 ? stations : stations.filter((s) => myStations.includes(s.id))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [stations, canManage, profile?.station_id, profile?.station_ids],
  )
  const visibleStationIds = useMemo(() => visibleStations.map((s) => s.id), [visibleStations])

  async function loadEntries() {
    if (visibleStationIds.length === 0) return setEntries([])
    const { data, error: err } = await supabase
      .from('production_entries')
      .select('id, work_date, station_id, job_id, worker_id, user_id, quantity, notes, shift, created_by, created_at')
      .eq('work_date', workDate)
      .in('station_id', visibleStationIds)
      .order('created_at', { ascending: false })
    if (err) setError(err.message)
    else setEntries(data ?? [])
  }

  useEffect(() => {
    if (!loading) loadEntries()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workDate, loading, visibleStationIds.join(',')])

  const stationName = (id: string) => stations.find((s) => s.id === id)?.name ?? '?'
  const jobById = useMemo(() => new Map(jobs.map((j) => [j.id, j])), [jobs])
  const userById = useMemo(() => new Map(users.map((u) => [u.id, u])), [users])
  const positionOf = (u: Profile | undefined) => grades.find((g) => g.id === u?.grade_id)?.name ?? '—'

  async function removeEntry(entry: ProductionEntry) {
    if (!window.confirm('Delete this entry?')) return
    const { error: err } = await supabase.from('production_entries').delete().eq('id', entry.id)
    if (err) setError(err.message)
    else loadEntries()
  }

  if (loading) return <p className="muted">Loading…</p>

  const totalQty = entries.reduce((sum, e) => sum + Number(e.quantity), 0)

  return (
    <div className="stack">
      <div>
        <Link to="/" className="small muted backlink">← Back to main page</Link>
        <h1>Daily Job Record</h1>
        <p className="muted">Records keyed in for your station(s).</p>
      </div>

      {error && <div className="error">{error}</div>}

      <div className="row-form spread">
        <label className="field inline">
          <span>Date</span>
          <input type="date" value={workDate} onChange={(e) => setWorkDate(e.target.value)} />
        </label>
        <Link to="/daily-job-record/add" className="btn">+ Add Job Record</Link>
      </div>

      {visibleStations.length === 0 ? (
        <p className="muted">
          No station is tagged to your account yet — ask an admin to set it in Settings → User access.
        </p>
      ) : (
        <div className="card">
          <h3>Records — {workDate}</h3>
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Station</th>
                  <th>Employee</th>
                  <th>Position</th>
                  <th>Job</th>
                  <th>Shift</th>
                  <th className="right">Quantity</th>
                  <th>Notes</th>
                  {canManage && <th className="right">Actions</th>}
                </tr>
              </thead>
              <tbody>
                {entries.length === 0 && (
                  <tr>
                    <td colSpan={canManage ? 9 : 8} className="muted">No records for this date.</td>
                  </tr>
                )}
                {entries.map((en) => {
                  const job = jobById.get(en.job_id)
                  const user = en.user_id ? userById.get(en.user_id) : undefined
                  return (
                    <tr key={en.id}>
                      <td className="muted">
                        {new Date(en.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </td>
                      <td>{stationName(en.station_id)}</td>
                      <td>{user ? profileName(user) : '?'}</td>
                      <td className="muted">{positionOf(user)}</td>
                      <td>{job ? `${job.name} (${job.unit})` : '?'}</td>
                      <td className="muted">{en.shift ? SHIFT_LABEL[en.shift] ?? en.shift : '—'}</td>
                      <td className="right">{Number(en.quantity)}</td>
                      <td className="muted">{en.notes}</td>
                      {canManage && (
                        <td className="right">
                          <button className="linkbtn danger" onClick={() => removeEntry(en)}>Delete</button>
                        </td>
                      )}
                    </tr>
                  )
                })}
                {entries.length > 0 && (
                  <tr className="total-row">
                    <td colSpan={6}>Total</td>
                    <td className="right">{totalQty}</td>
                    <td colSpan={canManage ? 2 : 1} />
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
