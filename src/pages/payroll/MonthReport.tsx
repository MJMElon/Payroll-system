// ---------------------------------------------------------------------------
// MONTH REPORT — live month-end summary built from real production data.
// Approved entries only (the same rule as payroll runs): per-worker days
// worked, piece earnings (tiered rates respected) and basic salary, plus a
// per-station roll-up. Both tables export to Excel-ready CSV.
// ---------------------------------------------------------------------------
import { useEffect, useMemo, useState } from 'react'
import {
  supabase,
  todayISO,
  profileName,
  type Grade,
  type Job,
  type PieceRate,
  type ProductionEntry,
  type Profile,
  type Station,
} from '../../lib/supabase'

const TIER1_UNIT_CAP = 4

const fmt = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

function monthRange(month: string): { start: string; end: string } {
  const [y, m] = month.split('-').map(Number)
  const last = new Date(y, m, 0).getDate()
  return { start: `${month}-01`, end: `${month}-${String(last).padStart(2, '0')}` }
}

export default function MonthReport() {
  const [month, setMonth] = useState(todayISO().slice(0, 7))
  const [entries, setEntries] = useState<ProductionEntry[]>([])
  const [people, setPeople] = useState<Profile[]>([])
  const [grades, setGrades] = useState<Grade[]>([])
  const [stations, setStations] = useState<Station[]>([])
  const [jobs, setJobs] = useState<Job[]>([])
  const [rates, setRates] = useState<PieceRate[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function load() {
      setLoading(true)
      const { start, end } = monthRange(month)
      const [e, p, g, s, j, r] = await Promise.all([
        supabase
          .from('production_entries')
          .select('*')
          .gte('work_date', start)
          .lte('work_date', end)
          .eq('approval_status', 'approved'),
        supabase.from('access_profiles').select('*'),
        supabase.from('grades').select('*').order('sort_order'),
        supabase.from('stations').select('*').order('sort_order'),
        supabase.from('jobs').select('id, station_id, grade_id, name, unit, active, approval_status, verified_by, approved_by'),
        supabase.from('piece_rates').select('id, job_id, rate, effective_from, tier2_rate').lte('effective_from', end),
      ])
      const err = e.error || p.error || g.error || s.error || j.error || r.error
      if (err) setError(err.message)
      else setError(null)
      setEntries(e.data ?? [])
      setPeople((p.data ?? []) as Profile[])
      setGrades(g.data ?? [])
      setStations(s.data ?? [])
      setJobs((j.data ?? []) as Job[])
      setRates(r.data ?? [])
      setLoading(false)
    }
    load()
  }, [month])

  // Latest rate per job effective within the report month.
  const bestRate = useMemo(() => {
    const best = new Map<string, PieceRate>()
    for (const r of rates) {
      const cur = best.get(r.job_id)
      if (!cur || r.effective_from > cur.effective_from) best.set(r.job_id, r)
    }
    return best
  }, [rates])

  const amountOf = (jobId: string, qty: number) => {
    const r = bestRate.get(jobId)
    if (!r) return 0
    const t1 = Number(r.rate)
    if (r.tier2_rate == null) return qty * t1
    return Math.min(qty, TIER1_UNIT_CAP) * t1 + Math.max(0, qty - TIER1_UNIT_CAP) * Number(r.tier2_rate)
  }

  const gradeName = (id: string | null) =>
    id ? grades.find((g) => g.id === id)?.name ?? '—' : '—'
  const stationName = (id: string) => stations.find((s) => s.id === id)?.name ?? '?'
  const jobName = (id: string) => jobs.find((j) => j.id === id)?.name ?? '?'

  // ----- Per-worker roll-up ------------------------------------------------
  interface WorkerRow {
    person: Profile
    days: number
    qty: number
    piece: number
    basic: number
    total: number
  }
  const workerRows: WorkerRow[] = useMemo(() => {
    const byPerson = new Map<string, { dates: Set<string>; qty: number; piece: number }>()
    for (const e of entries) {
      // Credit the account the work belongs to. Legacy rows carry only a
      // worker_id — those are paid via payroll runs, not this per-account
      // table, so don't mis-credit the clerk who keyed them in.
      const pid = e.user_id ?? (e.worker_id ? null : e.created_by)
      if (!pid) continue
      const cur = byPerson.get(pid) ?? { dates: new Set<string>(), qty: 0, piece: 0 }
      cur.dates.add(e.work_date)
      cur.qty += Number(e.quantity)
      cur.piece += amountOf(e.job_id, Number(e.quantity))
      byPerson.set(pid, cur)
    }
    const rows: WorkerRow[] = []
    for (const p of people) {
      const agg = byPerson.get(p.id)
      const basic = Number(p.basic_salary ?? 0)
      if (!agg && basic <= 0) continue
      const piece = agg?.piece ?? 0
      rows.push({
        person: p,
        days: agg?.dates.size ?? 0,
        qty: agg?.qty ?? 0,
        piece,
        basic,
        total: piece + basic,
      })
    }
    return rows.sort((a, b) => profileName(a.person).localeCompare(profileName(b.person)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries, people, bestRate])

  // ----- Per-station roll-up ----------------------------------------------
  interface StationRow {
    station: Station
    entryCount: number
    workers: number
    qty: number
    piece: number
  }
  const stationRows: StationRow[] = useMemo(() => {
    const byStation = new Map<string, { count: number; people: Set<string>; qty: number; piece: number }>()
    for (const e of entries) {
      const cur = byStation.get(e.station_id) ?? { count: 0, people: new Set<string>(), qty: 0, piece: 0 }
      cur.count += 1
      const pid = e.user_id ?? (e.worker_id ? `w:${e.worker_id}` : e.created_by)
      if (pid) cur.people.add(pid)
      cur.qty += Number(e.quantity)
      cur.piece += amountOf(e.job_id, Number(e.quantity))
      byStation.set(e.station_id, cur)
    }
    return stations
      .filter((s) => byStation.has(s.id))
      .map((s) => {
        const a = byStation.get(s.id)!
        return { station: s, entryCount: a.count, workers: a.people.size, qty: a.qty, piece: a.piece }
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries, stations, bestRate])

  // ----- Per-job roll-up (what work drove the month) ----------------------
  const jobRows = useMemo(() => {
    const byJob = new Map<string, { qty: number; piece: number; count: number }>()
    for (const e of entries) {
      const cur = byJob.get(e.job_id) ?? { qty: 0, piece: 0, count: 0 }
      cur.qty += Number(e.quantity)
      cur.piece += amountOf(e.job_id, Number(e.quantity))
      cur.count += 1
      byJob.set(e.job_id, cur)
    }
    return [...byJob.entries()]
      .map(([jobId, a]) => ({ jobId, ...a }))
      .sort((a, b) => b.piece - a.piece)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries, bestRate])

  const totPiece = workerRows.reduce((s, r) => s + r.piece, 0)
  const totBasic = workerRows.reduce((s, r) => s + r.basic, 0)
  const totAll = totPiece + totBasic

  function esc(v: string) {
    return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v
  }
  function download(filename: string, rows: string[][]) {
    const csv = '\ufeff' + rows.map((r) => r.map(esc).join(',')).join('\r\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = filename
    a.click()
    URL.revokeObjectURL(a.href)
  }
  function exportWorkers() {
    const rows: string[][] = [[
      'No', 'Employee code', 'Name', 'Position', 'Days worked', 'Total quantity',
      'Piece earnings (RM)', 'Basic salary (RM)', 'Total pay (RM)',
    ]]
    workerRows.forEach((r, i) =>
      rows.push([
        String(i + 1),
        r.person.employee_code ?? '',
        profileName(r.person),
        gradeName(r.person.grade_id),
        String(r.days),
        String(r.qty),
        r.piece.toFixed(2),
        r.basic.toFixed(2),
        r.total.toFixed(2),
      ]),
    )
    rows.push(['', '', 'Total', '', '', '', totPiece.toFixed(2), totBasic.toFixed(2), totAll.toFixed(2)])
    download(`month-report-workers-${month}.csv`, rows)
  }
  function exportStations() {
    const rows: string[][] = [[
      'Station', 'Entries', 'Workers', 'Total quantity', 'Piece earnings (RM)',
    ]]
    stationRows.forEach((r) =>
      rows.push([r.station.name, String(r.entryCount), String(r.workers), String(r.qty), r.piece.toFixed(2)]),
    )
    download(`month-report-stations-${month}.csv`, rows)
  }

  return (
    <div className="stack">
      {error && <div className="error">{error}</div>}

      <div className="card row-form spread">
        <label className="field inline">
          <span>Report month</span>
          <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
        </label>
        <div className="row-form">
          <span className="muted small">Approved entries only — the same rule payroll runs use.</span>
        </div>
      </div>

      {loading ? (
        <p className="muted">Loading…</p>
      ) : (
        <>
          <div className="card stack">
            <div className="row-form spread">
              <h3>Per worker — {month}</h3>
              <button className="btn ghost" onClick={exportWorkers}>Export CSV</button>
            </div>
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Code</th>
                    <th>Name</th>
                    <th>Position</th>
                    <th className="right">Days</th>
                    <th className="right">Qty</th>
                    <th className="right">Piece (RM)</th>
                    <th className="right">Basic (RM)</th>
                    <th className="right">Total (RM)</th>
                  </tr>
                </thead>
                <tbody>
                  {workerRows.length === 0 && (
                    <tr><td colSpan={9} className="muted">No approved entries or salaried staff this month.</td></tr>
                  )}
                  {workerRows.map((r, i) => (
                    <tr key={r.person.id}>
                      <td className="muted">{i + 1}</td>
                      <td className="muted">{r.person.employee_code ?? '—'}</td>
                      <td>{profileName(r.person)}</td>
                      <td className="muted small">{gradeName(r.person.grade_id)}</td>
                      <td className="right">{r.days}</td>
                      <td className="right">{r.qty}</td>
                      <td className="right">{fmt(r.piece)}</td>
                      <td className="right">{fmt(r.basic)}</td>
                      <td className="right"><strong>{fmt(r.total)}</strong></td>
                    </tr>
                  ))}
                  {workerRows.length > 0 && (
                    <tr className="total-row">
                      <td colSpan={6}>Total</td>
                      <td className="right">{fmt(totPiece)}</td>
                      <td className="right">{fmt(totBasic)}</td>
                      <td className="right">{fmt(totAll)}</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div className="card stack">
            <div className="row-form spread">
              <h3>Per station — {month}</h3>
              <button className="btn ghost" onClick={exportStations}>Export CSV</button>
            </div>
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th>Station</th>
                    <th className="right">Entries</th>
                    <th className="right">Workers</th>
                    <th className="right">Qty</th>
                    <th className="right">Piece (RM)</th>
                  </tr>
                </thead>
                <tbody>
                  {stationRows.length === 0 && (
                    <tr><td colSpan={5} className="muted">No approved entries this month.</td></tr>
                  )}
                  {stationRows.map((r) => (
                    <tr key={r.station.id}>
                      <td>{r.station.name}</td>
                      <td className="right">{r.entryCount}</td>
                      <td className="right">{r.workers}</td>
                      <td className="right">{r.qty}</td>
                      <td className="right">{fmt(r.piece)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="card stack">
            <h3>Top work items — {month}</h3>
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th>Work description</th>
                    <th>Station</th>
                    <th className="right">Entries</th>
                    <th className="right">Qty</th>
                    <th className="right">Piece (RM)</th>
                  </tr>
                </thead>
                <tbody>
                  {jobRows.length === 0 && (
                    <tr><td colSpan={5} className="muted">No approved entries this month.</td></tr>
                  )}
                  {jobRows.map((r) => {
                    const j = jobs.find((x) => x.id === r.jobId)
                    return (
                      <tr key={r.jobId}>
                        <td>{jobName(r.jobId)}</td>
                        <td className="muted small">{j ? stationName(j.station_id) : '—'}</td>
                        <td className="right">{r.count}</td>
                        <td className="right">{r.qty}</td>
                        <td className="right">{fmt(r.piece)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
