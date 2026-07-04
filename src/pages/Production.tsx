import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { useAuth } from '../context/AuthContext'
import {
  supabase,
  todayISO,
  type Job,
  type ProductionEntry,
  type Station,
  type Worker,
} from '../lib/supabase'

export default function Production() {
  const { profile } = useAuth()
  // Operators are pinned to their own station; admins/managers pick freely.
  const isOperator = profile?.role === 'operator'

  const [stations, setStations] = useState<Station[]>([])
  const [jobs, setJobs] = useState<Job[]>([])
  const [workers, setWorkers] = useState<Worker[]>([])
  const [entries, setEntries] = useState<ProductionEntry[]>([])

  const [workDate, setWorkDate] = useState(todayISO())
  const [stationId, setStationId] = useState('')
  const [jobId, setJobId] = useState('')
  const [workerId, setWorkerId] = useState('')
  const [quantity, setQuantity] = useState('')
  const [notes, setNotes] = useState('')

  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    async function loadMaster() {
      const [s, j, w] = await Promise.all([
        supabase.from('stations').select('id, name, sort_order').order('sort_order'),
        supabase.from('jobs').select('id, station_id, name, unit, active').eq('active', true).order('name'),
        supabase.from('workers').select('id, full_name, station_id, active').eq('active', true).order('full_name'),
      ])
      const err = s.error || j.error || w.error
      if (err) setError(err.message)
      setStations(s.data ?? [])
      setJobs(j.data ?? [])
      setWorkers(w.data ?? [])
      setLoading(false)
    }
    loadMaster()
  }, [])

  // Default the station once master data (and profile) are in.
  useEffect(() => {
    if (!stationId) {
      if (isOperator && profile?.station_id) setStationId(profile.station_id)
      else if (stations.length) setStationId(stations[0].id)
    }
  }, [stations, profile, isOperator, stationId])

  async function loadEntries() {
    if (!stationId) return
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

  const stationJobs = useMemo(() => jobs.filter((j) => j.station_id === stationId), [jobs, stationId])
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
        <h1>Production</h1>
        <p className="muted">Record piece-rate work per station and day.</p>
      </div>

      {error && <div className="error">{error}</div>}

      <div className="card row-form">
        <label className="field inline">
          <span>Date</span>
          <input type="date" value={workDate} onChange={(e) => setWorkDate(e.target.value)} />
        </label>
        <label className="field inline">
          <span>Station</span>
          <select
            value={stationId}
            onChange={(e) => setStationId(e.target.value)}
            disabled={isOperator}
          >
            {stations.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        </label>
      </div>

      <form className="card row-form" onSubmit={addEntry}>
        <label className="field inline">
          <span>Job</span>
          <select value={jobId} onChange={(e) => setJobId(e.target.value)} required>
            <option value="">Pick…</option>
            {stationJobs.map((j) => (
              <option key={j.id} value={j.id}>{j.name} ({j.unit})</option>
            ))}
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

      {stationJobs.length === 0 && (
        <p className="muted small">
          This station has no jobs yet — add them under Settings → Jobs &amp; Rates.
        </p>
      )}

      <div className="card">
        <h3>Entries — {workDate}</h3>
        <table className="table">
          <thead>
            <tr>
              <th>Worker</th>
              <th>Job</th>
              <th className="right">Quantity</th>
              <th>Notes</th>
              <th className="right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {entries.length === 0 && (
              <tr><td colSpan={5} className="muted">No entries for this station and date.</td></tr>
            )}
            {entries.map((en) => {
              const job = jobById.get(en.job_id)
              return (
                <tr key={en.id}>
                  <td>{workerById.get(en.worker_id)?.full_name ?? '?'}</td>
                  <td>{job ? `${job.name} (${job.unit})` : '?'}</td>
                  <td className="right">{Number(en.quantity)}</td>
                  <td className="muted">{en.notes}</td>
                  <td className="right">
                    <button className="linkbtn danger" onClick={() => removeEntry(en)}>Delete</button>
                  </td>
                </tr>
              )
            })}
            {entries.length > 0 && (
              <tr className="total-row">
                <td colSpan={2}>Total</td>
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
