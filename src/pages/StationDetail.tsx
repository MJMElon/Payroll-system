import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import {
  supabase,
  todayISO,
  type Grade,
  type Job,
  type ProductionEntry,
  type Station,
  type Worker,
} from '../lib/supabase'

// Production records for one station, reached by clicking it on the
// Overall Status board.
export default function StationDetail() {
  const { stationId } = useParams<{ stationId: string }>()
  const { profile } = useAuth()

  // Operators may only record for their own station (also enforced by RLS).
  const canRecord =
    profile?.role === 'admin' ||
    profile?.role === 'manager' ||
    (profile?.role === 'operator' && profile.station_id === stationId)

  const [station, setStation] = useState<Station | null>(null)
  const [jobs, setJobs] = useState<Job[]>([])
  const [grades, setGrades] = useState<Grade[]>([])
  const [workers, setWorkers] = useState<Worker[]>([])
  const [entries, setEntries] = useState<ProductionEntry[]>([])

  const [workDate, setWorkDate] = useState(todayISO())
  const [jobId, setJobId] = useState('')
  const [workerId, setWorkerId] = useState('')
  const [quantity, setQuantity] = useState('')
  const [notes, setNotes] = useState('')

  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    async function loadMaster() {
      const [s, j, w, g] = await Promise.all([
        supabase.from('stations').select('id, name, sort_order').eq('id', stationId).single(),
        supabase
          .from('jobs')
          .select('id, station_id, grade_id, name, unit, active')
          .eq('station_id', stationId)
          .eq('active', true)
          .order('name'),
        supabase
          .from('workers')
          .select('id, full_name, station_id, grade_id, active')
          .eq('active', true)
          .order('full_name'),
        supabase.from('grades').select('id, name, sort_order').order('sort_order'),
      ])
      if (s.error) setError(s.error.message)
      else setStation(s.data)
      setJobs(j.data ?? [])
      setWorkers(w.data ?? [])
      setGrades(g.data ?? [])
      setLoading(false)
    }
    loadMaster()
  }, [stationId])

  async function loadEntries() {
    const { data, error } = await supabase
      .from('production_entries')
      .select('id, work_date, station_id, job_id, worker_id, quantity, notes, created_by, created_at')
      .eq('work_date', workDate)
      .eq('station_id', stationId)
      .order('created_at', { ascending: false })
    if (error) setError(error.message)
    else setEntries(data ?? [])
  }

  useEffect(() => {
    loadEntries()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workDate, stationId])

  const jobById = useMemo(() => new Map(jobs.map((j) => [j.id, j])), [jobs])
  const workerById = useMemo(() => new Map(workers.map((w) => [w.id, w])), [workers])

  async function addEntry(e: FormEvent) {
    e.preventDefault()
    setError(null)
    const qty = Number(quantity)
    if (Number.isNaN(qty) || qty <= 0) return setError('Quantity must be a positive number.')
    setSaving(true)
    const { error } = await supabase.from('production_entries').insert({
      work_date: workDate,
      station_id: stationId,
      job_id: jobId,
      worker_id: workerId,
      quantity: qty,
      notes: notes.trim() || null,
    })
    setSaving(false)
    if (error) return setError(error.message)
    setQuantity('')
    setNotes('')
    loadEntries()
  }

  async function removeEntry(entry: ProductionEntry) {
    if (!window.confirm('Delete this entry?')) return
    const { error } = await supabase.from('production_entries').delete().eq('id', entry.id)
    if (error) setError(error.message)
    else loadEntries()
  }

  if (loading) return <p className="muted">Loading…</p>

  const totalQty = entries.reduce((sum, e) => sum + Number(e.quantity), 0)

  return (
    <div className="stack">
      <div>
        <Link to="/" className="small muted">← Back to main page</Link>
        <h1>{station?.name ?? 'Station'}</h1>
        <p className="muted">Production records for this station.</p>
      </div>

      {error && <div className="error">{error}</div>}

      <div className="card row-form">
        <label className="field inline">
          <span>Date</span>
          <input type="date" value={workDate} onChange={(e) => setWorkDate(e.target.value)} />
        </label>
      </div>

      {canRecord && (
        <form className="card row-form" onSubmit={addEntry}>
          <label className="field inline">
            <span>Job</span>
            <select value={jobId} onChange={(e) => setJobId(e.target.value)} required>
              <option value="">Pick…</option>
              {jobs.map((j) => {
                const tag = grades.find((g) => g.id === j.grade_id)?.name
                return (
                  <option key={j.id} value={j.id}>
                    {j.name}{tag ? ` · ${tag}` : ''} ({j.unit})
                  </option>
                )
              })}
            </select>
          </label>
          <label className="field inline">
            <span>Worker</span>
            <select value={workerId} onChange={(e) => setWorkerId(e.target.value)} required>
              <option value="">Pick…</option>
              {workers.map((w) => (
                <option key={w.id} value={w.id}>{w.full_name}</option>
              ))}
            </select>
          </label>
          <label className="field inline">
            <span>Quantity</span>
            <input
              inputMode="decimal"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              placeholder="0.0"
              required
            />
          </label>
          <label className="field inline grow">
            <span>Notes (optional)</span>
            <input value={notes} onChange={(e) => setNotes(e.target.value)} />
          </label>
          <button className="btn" type="submit" disabled={saving}>
            {saving ? 'Saving…' : 'Add entry'}
          </button>
        </form>
      )}

      {canRecord && jobs.length === 0 && (
        <p className="muted small">
          This station has no jobs yet — add them under Settings → Jobs &amp; Rates.
        </p>
      )}

      <div className="card">
        <h3>Entries — {workDate}</h3>
        <table className="table">
          <thead>
            <tr>
              <th>Time</th>
              <th>Worker</th>
              <th>Job</th>
              <th className="right">Quantity</th>
              <th>Notes</th>
              <th className="right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {entries.length === 0 && (
              <tr><td colSpan={6} className="muted">No entries for this date.</td></tr>
            )}
            {entries.map((en) => {
              const job = jobById.get(en.job_id)
              return (
                <tr key={en.id}>
                  <td className="muted">
                    {new Date(en.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </td>
                  <td>{workerById.get(en.worker_id)?.full_name ?? '?'}</td>
                  <td>{job ? `${job.name} (${job.unit})` : '?'}</td>
                  <td className="right">{Number(en.quantity)}</td>
                  <td className="muted">{en.notes}</td>
                  <td className="right">
                    {canRecord && (
                      <button className="linkbtn danger" onClick={() => removeEntry(en)}>Delete</button>
                    )}
                  </td>
                </tr>
              )
            })}
            {entries.length > 0 && (
              <tr className="total-row">
                <td colSpan={3}>Total</td>
                <td className="right">{totalQty}</td>
                <td colSpan={2} />
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
