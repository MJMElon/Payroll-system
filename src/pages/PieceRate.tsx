// ---------------------------------------------------------------------------
// PIECE RATE MODULE — fully self-contained in this one file.
//
// Everything piece-rate related (overview, rate history, rate changes) lives
// here so the module can be lifted out to its own repo later. Its only
// dependencies are the shared Supabase client/types and react-router's Link.
// Tables used: jobs, stations, piece_rates (see supabase/setup.sql).
// ---------------------------------------------------------------------------
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase, todayISO, type Job, type PieceRate as Rate, type Station } from '../lib/supabase'

export default function PieceRate() {
  const [stations, setStations] = useState<Station[]>([])
  const [jobs, setJobs] = useState<Job[]>([])
  const [rates, setRates] = useState<Rate[]>([])
  const [stationFilter, setStationFilter] = useState('')
  const [historyJobId, setHistoryJobId] = useState<string | null>(null)
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

  const stationName = (id: string) => stations.find((s) => s.id === id)?.name ?? '?'

  // Rates are sorted newest-first, so the first match <= today is current and
  // the next one is the previous rate.
  const rateInfo = useMemo(() => {
    const m = new Map<string, { current?: Rate; previous?: Rate; history: Rate[] }>()
    for (const j of jobs) m.set(j.id, { history: [] })
    for (const r of rates) {
      const info = m.get(r.job_id)
      if (!info) continue
      info.history.push(r)
      if (r.effective_from <= todayISO()) {
        if (!info.current) info.current = r
        else if (!info.previous) info.previous = r
      }
    }
    return m
  }, [jobs, rates])

  const visibleJobs = stationFilter ? jobs.filter((j) => j.station_id === stationFilter) : jobs
  const activeJobs = jobs.filter((j) => j.active)
  const missingRate = activeJobs.filter((j) => !rateInfo.get(j.id)?.current)
  const lastChange = rates.length
    ? rates.reduce((max, r) => (r.effective_from > max ? r.effective_from : max), rates[0].effective_from)
    : null

  async function setRate(job: Job) {
    setError(null)
    const raw = (rateInputs[job.id] ?? '').trim()
    const value = Number(raw)
    if (!raw || Number.isNaN(value) || value < 0) return setError('Enter a valid non-negative rate.')
    const { error } = await supabase
      .from('piece_rates')
      .upsert(
        { job_id: job.id, rate: value, effective_from: todayISO() },
        { onConflict: 'job_id,effective_from' },
      )
    if (error) return setError(error.message)
    setRateInputs((m) => ({ ...m, [job.id]: '' }))
    load()
  }

  const pct = (cur: number, prev: number) =>
    prev === 0 ? null : Math.round(((cur - prev) / prev) * 1000) / 10

  if (loading) return <p className="muted">Loading…</p>

  const historyJob = historyJobId ? jobs.find((j) => j.id === historyJobId) : null
  const history = historyJobId ? rateInfo.get(historyJobId)?.history ?? [] : []

  return (
    <div className="stack">
      <div>
        <Link to="/" className="small muted">← Overall status</Link>
        <h1>Piece Rate</h1>
        <p className="muted">Monitor every job's rate, changes, and history in one place.</p>
      </div>

      {error && <div className="error">{error}</div>}

      <div className="grid">
        <div className="card">
          <h3>Active jobs</h3>
          <p className="stat">{activeJobs.length}</p>
          <p className="muted small">with a piece rate: {activeJobs.length - missingRate.length}</p>
        </div>
        <div className="card">
          <h3>Missing rates</h3>
          <p className="stat">{missingRate.length}</p>
          <p className="muted small">
            {missingRate.length
              ? missingRate.slice(0, 3).map((j) => j.name).join(', ') + (missingRate.length > 3 ? '…' : '')
              : 'every active job is priced'}
          </p>
        </div>
        <div className="card">
          <h3>Last rate change</h3>
          <p className="stat small-stat">{lastChange ?? '—'}</p>
          <p className="muted small">most recent effective date</p>
        </div>
      </div>

      <div className="card stack">
        <div className="row-form spread">
          <h3>Rates</h3>
          <label className="field inline">
            <span>Filter by station</span>
            <select value={stationFilter} onChange={(e) => setStationFilter(e.target.value)}>
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
              <th>Effective since</th>
              <th className="right">Previous</th>
              <th className="right">Change</th>
              <th className="right">New rate (today)</th>
              <th className="right">History</th>
            </tr>
          </thead>
          <tbody>
            {visibleJobs.length === 0 && (
              <tr><td colSpan={9} className="muted">No jobs yet — create them in Settings → Jobs &amp; Rates.</td></tr>
            )}
            {visibleJobs.map((j) => {
              const info = rateInfo.get(j.id)
              const cur = info?.current
              const prev = info?.previous
              const change = cur && prev ? pct(Number(cur.rate), Number(prev.rate)) : null
              return (
                <tr key={j.id} className={j.active ? '' : 'muted'}>
                  <td>{j.name}{!j.active && ' (inactive)'}</td>
                  <td>{stationName(j.station_id)}</td>
                  <td>{j.unit}</td>
                  <td className="right">
                    {cur ? Number(cur.rate) : <span className="badge off">no rate</span>}
                  </td>
                  <td className="muted">{cur?.effective_from ?? '—'}</td>
                  <td className="right muted">{prev ? Number(prev.rate) : '—'}</td>
                  <td className="right">
                    {change === null ? (
                      <span className="muted">—</span>
                    ) : (
                      <span className={`badge ${change >= 0 ? 'ok' : 'off'}`}>
                        {change > 0 ? '+' : ''}{change}%
                      </span>
                    )}
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
                      <button className="linkbtn" type="button" onClick={() => setRate(j)}>Set</button>
                    </span>
                  </td>
                  <td className="right">
                    <button
                      className="linkbtn"
                      type="button"
                      onClick={() => setHistoryJobId(historyJobId === j.id ? null : j.id)}
                    >
                      {historyJobId === j.id ? 'Hide' : 'View'}
                    </button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {historyJob && (
        <div className="card">
          <h3>Rate history — {historyJob.name} ({historyJob.unit})</h3>
          <table className="table">
            <thead>
              <tr>
                <th>Effective from</th>
                <th className="right">Rate</th>
                <th className="right">Change vs previous</th>
              </tr>
            </thead>
            <tbody>
              {history.length === 0 && (
                <tr><td colSpan={3} className="muted">No rates recorded for this job yet.</td></tr>
              )}
              {history.map((r, i) => {
                const prev = history[i + 1]
                const change = prev ? pct(Number(r.rate), Number(prev.rate)) : null
                return (
                  <tr key={r.id}>
                    <td>{r.effective_from}</td>
                    <td className="right">{Number(r.rate)}</td>
                    <td className="right">
                      {change === null ? <span className="muted">—</span> : (
                        <span className={`badge ${change >= 0 ? 'ok' : 'off'}`}>
                          {change > 0 ? '+' : ''}{change}%
                        </span>
                      )}
                    </td>
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
