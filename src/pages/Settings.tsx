import { useEffect, useState, type FormEvent } from 'react'
import {
  supabase,
  type Job,
  type PieceRate,
  type Station,
  type Worker,
  todayISO,
} from '../lib/supabase'

type Tab = 'stations' | 'workers' | 'jobs'

export default function Settings() {
  const [tab, setTab] = useState<Tab>('stations')

  return (
    <div className="stack">
      <div>
        <h1>Settings</h1>
        <p className="muted">Master data: stations, workers, jobs and piece rates.</p>
      </div>

      <div className="tabs">
        <button className={`tab ${tab === 'stations' ? 'active' : ''}`} onClick={() => setTab('stations')}>
          Stations
        </button>
        <button className={`tab ${tab === 'workers' ? 'active' : ''}`} onClick={() => setTab('workers')}>
          Workers
        </button>
        <button className={`tab ${tab === 'jobs' ? 'active' : ''}`} onClick={() => setTab('jobs')}>
          Jobs &amp; Rates
        </button>
      </div>

      {tab === 'stations' && <StationsTab />}
      {tab === 'workers' && <WorkersTab />}
      {tab === 'jobs' && <JobsTab />}
    </div>
  )
}

/* ------------------------------------------------------------------ */

function StationsTab() {
  const [stations, setStations] = useState<Station[]>([])
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  async function load() {
    const { data, error } = await supabase
      .from('stations')
      .select('id, name, sort_order')
      .order('sort_order')
    if (error) setError(error.message)
    else setStations(data ?? [])
    setLoading(false)
  }

  useEffect(() => {
    load()
  }, [])

  async function addStation(e: FormEvent) {
    e.preventDefault()
    setError(null)
    const sort = Math.max(0, ...stations.map((s) => s.sort_order)) + 1
    const { error } = await supabase.from('stations').insert({ name: name.trim(), sort_order: sort })
    if (error) return setError(error.message)
    setName('')
    load()
  }

  async function rename(s: Station) {
    const next = window.prompt('Station name', s.name)
    if (!next || next.trim() === s.name) return
    const { error } = await supabase.from('stations').update({ name: next.trim() }).eq('id', s.id)
    if (error) setError(error.message)
    else load()
  }

  async function remove(s: Station) {
    if (!window.confirm(`Delete station "${s.name}"? This fails if it has jobs, workers or records.`)) return
    const { error } = await supabase.from('stations').delete().eq('id', s.id)
    if (error) setError(error.message)
    else load()
  }

  if (loading) return <p className="muted">Loading…</p>

  return (
    <div className="stack">
      {error && <div className="error">{error}</div>}

      <div className="card">
        <table className="table">
          <thead>
            <tr>
              <th>#</th>
              <th>Station</th>
              <th className="right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {stations.map((s) => (
              <tr key={s.id}>
                <td className="muted">{s.sort_order}</td>
                <td>{s.name}</td>
                <td className="right">
                  <button className="linkbtn" onClick={() => rename(s)}>Rename</button>{' '}
                  <button className="linkbtn danger" onClick={() => remove(s)}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <form className="card row-form" onSubmit={addStation}>
        <label className="field inline">
          <span>New station name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} required />
        </label>
        <button className="btn" type="submit">Add station</button>
      </form>
    </div>
  )
}

/* ------------------------------------------------------------------ */

function WorkersTab() {
  const [workers, setWorkers] = useState<Worker[]>([])
  const [stations, setStations] = useState<Station[]>([])
  const [name, setName] = useState('')
  const [stationId, setStationId] = useState('')
  const [showInactive, setShowInactive] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  async function load() {
    const [w, s] = await Promise.all([
      supabase.from('workers').select('id, full_name, station_id, active').order('full_name'),
      supabase.from('stations').select('id, name, sort_order').order('sort_order'),
    ])
    if (w.error) setError(w.error.message)
    else setWorkers(w.data ?? [])
    if (s.error) setError(s.error.message)
    else setStations(s.data ?? [])
    setLoading(false)
  }

  useEffect(() => {
    load()
  }, [])

  async function addWorker(e: FormEvent) {
    e.preventDefault()
    setError(null)
    const { error } = await supabase
      .from('workers')
      .insert({ full_name: name.trim(), station_id: stationId || null })
    if (error) return setError(error.message)
    setName('')
    load()
  }

  async function setActive(w: Worker, active: boolean) {
    const { error } = await supabase.from('workers').update({ active }).eq('id', w.id)
    if (error) setError(error.message)
    else load()
  }

  async function moveStation(w: Worker, station_id: string) {
    const { error } = await supabase
      .from('workers')
      .update({ station_id: station_id || null })
      .eq('id', w.id)
    if (error) setError(error.message)
    else load()
  }

  if (loading) return <p className="muted">Loading…</p>

  const visible = workers.filter((w) => showInactive || w.active)

  return (
    <div className="stack">
      {error && <div className="error">{error}</div>}

      <div className="card">
        <label className="small muted checkbox">
          <input
            type="checkbox"
            checked={showInactive}
            onChange={(e) => setShowInactive(e.target.checked)}
          />{' '}
          Show inactive workers
        </label>
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Station</th>
              <th>Status</th>
              <th className="right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 && (
              <tr><td colSpan={4} className="muted">No workers yet — add the first one below.</td></tr>
            )}
            {visible.map((w) => (
              <tr key={w.id}>
                <td>{w.full_name}</td>
                <td>
                  <select value={w.station_id ?? ''} onChange={(e) => moveStation(w, e.target.value)}>
                    <option value="">—</option>
                    {stations.map((s) => (
                      <option key={s.id} value={s.id}>{s.name}</option>
                    ))}
                  </select>
                </td>
                <td>
                  <span className={`badge ${w.active ? 'ok' : 'off'}`}>{w.active ? 'active' : 'inactive'}</span>
                </td>
                <td className="right">
                  {w.active ? (
                    <button className="linkbtn danger" onClick={() => setActive(w, false)}>Deactivate</button>
                  ) : (
                    <button className="linkbtn" onClick={() => setActive(w, true)}>Reactivate</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <form className="card row-form" onSubmit={addWorker}>
        <label className="field inline">
          <span>Full name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} required />
        </label>
        <label className="field inline">
          <span>Station</span>
          <select value={stationId} onChange={(e) => setStationId(e.target.value)}>
            <option value="">—</option>
            {stations.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        </label>
        <button className="btn" type="submit">Add worker</button>
      </form>
    </div>
  )
}

/* ------------------------------------------------------------------ */

function JobsTab() {
  const [stations, setStations] = useState<Station[]>([])
  const [jobs, setJobs] = useState<Job[]>([])
  const [rates, setRates] = useState<PieceRate[]>([])
  const [stationId, setStationId] = useState('')
  const [jobName, setJobName] = useState('')
  const [jobUnit, setJobUnit] = useState('')
  const [rateInputs, setRateInputs] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  async function load() {
    const [s, j, r] = await Promise.all([
      supabase.from('stations').select('id, name, sort_order').order('sort_order'),
      supabase.from('jobs').select('id, station_id, name, unit, active').order('name'),
      supabase
        .from('piece_rates')
        .select('id, job_id, rate, effective_from')
        .order('effective_from', { ascending: false }),
    ])
    const err = s.error || j.error || r.error
    if (err) setError(err.message)
    setStations(s.data ?? [])
    setJobs(j.data ?? [])
    setRates(r.data ?? [])
    setLoading(false)
  }

  useEffect(() => {
    load()
  }, [])

  // Newest rate whose effective_from is today or earlier (rates are sorted desc).
  const currentRate = (jobId: string) =>
    rates.find((r) => r.job_id === jobId && r.effective_from <= todayISO())

  async function addJob(e: FormEvent) {
    e.preventDefault()
    setError(null)
    if (!stationId) return setError('Pick a station for the new job.')
    const { error } = await supabase
      .from('jobs')
      .insert({ station_id: stationId, name: jobName.trim(), unit: jobUnit.trim() || 'unit' })
    if (error) return setError(error.message)
    setJobName('')
    setJobUnit('')
    load()
  }

  async function setRate(job: Job) {
    setError(null)
    const raw = (rateInputs[job.id] ?? '').trim()
    const value = Number(raw)
    if (!raw || Number.isNaN(value) || value < 0) return setError('Enter a valid non-negative rate.')
    // Upsert on (job_id, effective_from): setting twice on the same day updates.
    const { error } = await supabase
      .from('piece_rates')
      .upsert({ job_id: job.id, rate: value, effective_from: todayISO() }, { onConflict: 'job_id,effective_from' })
    if (error) return setError(error.message)
    setRateInputs((m) => ({ ...m, [job.id]: '' }))
    load()
  }

  async function setJobActive(job: Job, active: boolean) {
    const { error } = await supabase.from('jobs').update({ active }).eq('id', job.id)
    if (error) setError(error.message)
    else load()
  }

  if (loading) return <p className="muted">Loading…</p>

  const visibleJobs = stationId ? jobs.filter((j) => j.station_id === stationId) : jobs
  const stationName = (id: string) => stations.find((s) => s.id === id)?.name ?? '?'

  return (
    <div className="stack">
      {error && <div className="error">{error}</div>}

      <div className="card stack">
        <div className="row-form">
          <label className="field inline">
            <span>Filter by station</span>
            <select value={stationId} onChange={(e) => setStationId(e.target.value)}>
              <option value="">All stations</option>
              {stations.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </label>
        </div>

        <table className="table">
          <thead>
            <tr>
              <th>Job</th>
              <th>Station</th>
              <th>Unit</th>
              <th className="right">Current rate</th>
              <th className="right">New rate (from today)</th>
              <th className="right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {visibleJobs.length === 0 && (
              <tr><td colSpan={6} className="muted">No jobs yet — add the first one below.</td></tr>
            )}
            {visibleJobs.map((j) => {
              const rate = currentRate(j.id)
              return (
                <tr key={j.id} className={j.active ? '' : 'muted'}>
                  <td>{j.name}{!j.active && ' (inactive)'}</td>
                  <td>{stationName(j.station_id)}</td>
                  <td>{j.unit}</td>
                  <td className="right">
                    {rate ? rate.rate : <span className="badge off">no rate</span>}
                  </td>
                  <td className="right">
                    <span className="rate-set">
                      <input
                        className="rate-input"
                        inputMode="decimal"
                        placeholder="0.00"
                        value={rateInputs[j.id] ?? ''}
                        onChange={(e) => setRateInputs((m) => ({ ...m, [j.id]: e.target.value }))}
                      />
                      <button className="linkbtn" onClick={() => setRate(j)} type="button">Set</button>
                    </span>
                  </td>
                  <td className="right">
                    {j.active ? (
                      <button className="linkbtn danger" onClick={() => setJobActive(j, false)}>Deactivate</button>
                    ) : (
                      <button className="linkbtn" onClick={() => setJobActive(j, true)}>Reactivate</button>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <form className="card row-form" onSubmit={addJob}>
        <label className="field inline">
          <span>Station</span>
          <select value={stationId} onChange={(e) => setStationId(e.target.value)} required>
            <option value="">Pick…</option>
            {stations.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        </label>
        <label className="field inline">
          <span>Job name</span>
          <input value={jobName} onChange={(e) => setJobName(e.target.value)} required />
        </label>
        <label className="field inline">
          <span>Unit (e.g. tonne, bunch)</span>
          <input value={jobUnit} onChange={(e) => setJobUnit(e.target.value)} placeholder="unit" />
        </label>
        <button className="btn" type="submit">Add job</button>
      </form>
    </div>
  )
}
