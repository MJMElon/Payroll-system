import { useEffect, useLayoutEffect, useMemo, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import {
  supabase,
  todayISO,
  profileName,
  type Job,
  type PayrollAdjustment,
  type PayrollLine,
  type PayrollRun,
  type Profile,
  type Worker,
} from '../lib/supabase'
import SummaryReport from './payroll/SummaryReport'
import HourlyProduction from './payroll/HourlyProduction'
import './payroll/module-sidebar.css'

/**
 * Widens .pm-shell to fill the real browser window, past the shared
 * index.css content cap (--maxw), on any screen with room to spare — not
 * just above a fixed breakpoint. Reads --maxw live (never redefines it) so
 * it can't go stale if that shared value ever changes. Uses
 * document.documentElement.clientWidth rather than a vw CSS unit, since
 * vw includes the scrollbar gutter on some browsers and can silently
 * introduce page-level horizontal scroll — clientWidth cannot.
 */
function useShellWideStyle() {
  const [style, setStyle] = useState<{ width: number; marginLeft: number } | undefined>()

  useLayoutEffect(() => {
    const GUTTER = 20 // matches the shared .content side padding (1.25rem)

    function measure() {
      const vw = document.documentElement.clientWidth
      const maxw = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--maxw')) || 1080
      const contentInner = maxw - 40 // .content's own 1.25rem left+right padding
      const wide = vw - GUTTER * 2
      if (wide > contentInner) {
        setStyle({ width: wide, marginLeft: (contentInner - wide) / 2 })
      } else {
        setStyle(undefined)
      }
    }

    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [])

  return style
}

export default function Payroll() {
  const [tab, setTab] = useState<'summary' | 'hourly' | 'runs'>('summary')
  const shellWideStyle = useShellWideStyle()
  const [runs, setRuns] = useState<PayrollRun[]>([])
  const [openRun, setOpenRun] = useState<PayrollRun | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  async function loadRuns() {
    const { data, error } = await supabase
      .from('payroll_runs')
      .select('id, period_start, period_end, status, created_at, finalized_at')
      .order('created_at', { ascending: false })
    if (error) setError(error.message)
    else setRuns(data ?? [])
    setLoading(false)
  }

  useEffect(() => {
    loadRuns()
  }, [])

  if (loading) return <p className="muted">Loading…</p>

  if (openRun) {
    return (
      <RunDetail
        run={openRun}
        onBack={() => {
          setOpenRun(null)
          loadRuns()
        }}
      />
    )
  }

  return (
    <div className="stack">
      <div className="pm-print-hide">
        <Link to="/" className="small muted">← Back to main page</Link>
        <div className="pm-brand-row">
          <MjmLogo />
          <h1>Payroll Report</h1>
        </div>
      </div>

      <div className="pm-shell" style={shellWideStyle}>
        <nav className="pm-sidebar pm-print-hide">
          <button className={`pm-sidebar-item ${tab === 'summary' ? 'active' : ''}`} onClick={() => setTab('summary')}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="9" rx="1" /><rect x="14" y="3" width="7" height="5" rx="1" /><rect x="14" y="12" width="7" height="9" rx="1" /><rect x="3" y="16" width="7" height="5" rx="1" /></svg>
            Summary
          </button>
          <button className={`pm-sidebar-item ${tab === 'hourly' ? 'active' : ''}`} onClick={() => setTab('hourly')}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 3v18h18" /><path d="M7 15v3" /><path d="M12 10v8" /><path d="M17 6v12" /></svg>
            Hourly Production
          </button>
          <button className={`pm-sidebar-item ${tab === 'runs' ? 'active' : ''}`} onClick={() => setTab('runs')}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" /><path d="M14 2v6h6" /><path d="M9 15h6" /><path d="M9 11h2" /></svg>
            Runs
          </button>
        </nav>

        <div className="pm-content">
          {tab === 'summary' ? (
            <SummaryReport />
          ) : tab === 'hourly' ? (
            <HourlyProduction />
          ) : (
            <div className="stack">
              {error && <div className="error">{error}</div>}

              <NewRunForm onCreated={(run) => { setOpenRun(run); loadRuns() }} />

              <div className="card">
                <h3>Runs</h3>
                <table className="table">
                  <thead>
                    <tr>
                      <th>Period</th>
                      <th>Status</th>
                      <th>Created</th>
                      <th className="right">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {runs.length === 0 && (
                      <tr><td colSpan={4} className="muted">No payroll runs yet.</td></tr>
                    )}
                    {runs.map((r) => (
                      <tr key={r.id}>
                        <td>{r.period_start} → {r.period_end}</td>
                        <td><span className={`badge ${r.status === 'finalized' ? 'ok' : 'off'}`}>{r.status}</span></td>
                        <td className="muted">{r.created_at.slice(0, 10)}</td>
                        <td className="right">
                          <button className="linkbtn" onClick={() => setOpenRun(r)}>Open</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */

function NewRunForm({ onCreated }: { onCreated: (run: PayrollRun) => void }) {
  const [start, setStart] = useState('')
  const [end, setEnd] = useState(todayISO())
  const [error, setError] = useState<string | null>(null)
  const [working, setWorking] = useState(false)

  async function createRun(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setWorking(true)
    try {
      // 1. Production in the period.
      const { data: entries, error: entErr } = await supabase
        .from('production_entries')
        .select('worker_id, user_id, job_id, quantity')
        .gte('work_date', start)
        .lte('work_date', end)
      if (entErr) throw new Error(entErr.message)
      if (!entries || entries.length === 0) {
        throw new Error('No production entries in that period — nothing to pay.')
      }

      // 2. Rate per job: newest rate effective on or before the period end.
      const jobIds = [...new Set(entries.map((e) => e.job_id))]
      const { data: rates, error: rateErr } = await supabase
        .from('piece_rates')
        .select('job_id, rate, effective_from')
        .in('job_id', jobIds)
        .lte('effective_from', end)
        .order('effective_from', { ascending: false })
      if (rateErr) throw new Error(rateErr.message)
      const rateByJob = new Map<string, number>()
      for (const r of rates ?? []) {
        if (!rateByJob.has(r.job_id)) rateByJob.set(r.job_id, Number(r.rate))
      }

      // 3. Sum quantities per person (user, or legacy worker) + job.
      const sums = new Map<
        string,
        { user_id: string | null; worker_id: string | null; job_id: string; quantity: number }
      >()
      for (const en of entries) {
        const key = `${en.user_id ?? 'w:' + en.worker_id}|${en.job_id}`
        const cur = sums.get(key) ?? {
          user_id: en.user_id ?? null,
          worker_id: en.user_id ? null : en.worker_id ?? null,
          job_id: en.job_id,
          quantity: 0,
        }
        cur.quantity += Number(en.quantity)
        sums.set(key, cur)
      }

      // 4. Create the run, then its lines (rate snapshotted; 0 if job has no rate).
      const { data: run, error: runErr } = await supabase
        .from('payroll_runs')
        .insert({ period_start: start, period_end: end })
        .select()
        .single()
      if (runErr) throw new Error(runErr.message)

      const lines = [...sums.values()].map((s) => {
        const rate = rateByJob.get(s.job_id) ?? 0
        return {
          run_id: run.id,
          user_id: s.user_id,
          worker_id: s.worker_id,
          job_id: s.job_id,
          quantity: s.quantity,
          rate,
          amount: Math.round(s.quantity * rate * 100) / 100,
        }
      })
      const { error: lineErr } = await supabase.from('payroll_lines').insert(lines)
      if (lineErr) throw new Error(lineErr.message)

      onCreated(run as PayrollRun)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setWorking(false)
    }
  }

  return (
    <form className="card row-form" onSubmit={createRun}>
      <label className="field inline">
        <span>Period start</span>
        <input type="date" value={start} onChange={(e) => setStart(e.target.value)} required />
      </label>
      <label className="field inline">
        <span>Period end</span>
        <input type="date" value={end} onChange={(e) => setEnd(e.target.value)} required />
      </label>
      <button className="btn" type="submit" disabled={working}>
        {working ? 'Computing…' : 'Create run'}
      </button>
      {error && <div className="error">{error}</div>}
    </form>
  )
}

/* ------------------------------------------------------------------ */

function RunDetail({ run, onBack }: { run: PayrollRun; onBack: () => void }) {
  const [status, setStatus] = useState(run.status)
  const [lines, setLines] = useState<PayrollLine[]>([])
  const [adjustments, setAdjustments] = useState<PayrollAdjustment[]>([])
  const [users, setUsers] = useState<Profile[]>([])
  const [workers, setWorkers] = useState<Worker[]>([])
  const [jobs, setJobs] = useState<Job[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const [adjWorker, setAdjWorker] = useState('')
  const [adjAmount, setAdjAmount] = useState('')
  const [adjReason, setAdjReason] = useState('')

  const editable = status === 'draft'

  async function load() {
    const [l, a, u, w, j] = await Promise.all([
      supabase.from('payroll_lines')
        .select('id, run_id, worker_id, user_id, job_id, quantity, rate, amount')
        .eq('run_id', run.id),
      supabase.from('payroll_adjustments')
        .select('id, run_id, worker_id, user_id, amount, reason')
        .eq('run_id', run.id),
      supabase.from('access_profiles').select('*').order('email'),
      supabase.from('workers').select('id, full_name, station_id, grade_id, can_approve_rates, active'),
      supabase.from('jobs').select('id, station_id, grade_id, name, unit, active, approval_status, verified_by, approved_by'),
    ])
    const err = l.error || a.error || u.error || w.error || j.error
    if (err) setError(err.message)
    setLines(l.data ?? [])
    setAdjustments(a.data ?? [])
    setUsers((u.data ?? []) as Profile[])
    setWorkers(w.data ?? [])
    setJobs(j.data ?? [])
    setLoading(false)
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run.id])

  const personKey = (x: { user_id: string | null; worker_id: string | null }) =>
    x.user_id ?? 'w:' + (x.worker_id ?? '?')
  const personName = (key: string) =>
    key.startsWith('w:')
      ? workers.find((w) => w.id === key.slice(2))?.full_name ?? '?'
      : profileName(users.find((u) => u.id === key))
  const jobLabel = (id: string) => {
    const j = jobs.find((x) => x.id === id)
    return j ? `${j.name} (${j.unit})` : '?'
  }

  // Group lines by person (user, or legacy worker) for a payslip-style view.
  const byWorker = useMemo(() => {
    const m = new Map<string, { lines: PayrollLine[]; adjustments: PayrollAdjustment[] }>()
    for (const l of lines) {
      const k = personKey(l)
      if (!m.has(k)) m.set(k, { lines: [], adjustments: [] })
      m.get(k)!.lines.push(l)
    }
    for (const a of adjustments) {
      const k = personKey(a)
      if (!m.has(k)) m.set(k, { lines: [], adjustments: [] })
      m.get(k)!.adjustments.push(a)
    }
    return [...m.entries()].sort((x, y) => personName(x[0]).localeCompare(personName(y[0])))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lines, adjustments, workers, users])

  const grandTotal =
    lines.reduce((s, l) => s + Number(l.amount), 0) +
    adjustments.reduce((s, a) => s + Number(a.amount), 0)

  const missingRates = lines.filter((l) => Number(l.rate) === 0)

  async function addAdjustment(e: FormEvent) {
    e.preventDefault()
    setError(null)
    const amount = Number(adjAmount)
    if (Number.isNaN(amount) || amount === 0) return setError('Adjustment amount must be a non-zero number.')
    const { error } = await supabase.from('payroll_adjustments').insert({
      run_id: run.id,
      user_id: adjWorker,
      amount,
      reason: adjReason.trim(),
    })
    if (error) return setError(error.message)
    setAdjAmount('')
    setAdjReason('')
    load()
  }

  async function removeAdjustment(a: PayrollAdjustment) {
    const { error } = await supabase.from('payroll_adjustments').delete().eq('id', a.id)
    if (error) setError(error.message)
    else load()
  }

  async function finalize() {
    if (!window.confirm('Finalize this run? It can no longer be edited afterwards.')) return
    const { error } = await supabase
      .from('payroll_runs')
      .update({ status: 'finalized', finalized_at: new Date().toISOString() })
      .eq('id', run.id)
    if (error) setError(error.message)
    else setStatus('finalized')
  }

  async function removeRun() {
    if (!window.confirm('Delete this draft run and all its lines?')) return
    const { error } = await supabase.from('payroll_runs').delete().eq('id', run.id)
    if (error) setError(error.message)
    else onBack()
  }

  if (loading) return <p className="muted">Loading…</p>

  return (
    <div className="stack">
      <div className="row-form spread">
        <div>
          <h1>Payroll run</h1>
          <p className="muted">
            {run.period_start} → {run.period_end} ·{' '}
            <span className={`badge ${status === 'finalized' ? 'ok' : 'off'}`}>{status}</span>
          </p>
        </div>
        <div className="row-form">
          <button className="btn ghost" onClick={onBack}>← All runs</button>
          {editable && <button className="btn" onClick={finalize}>Finalize</button>}
          {editable && <button className="btn ghost danger" onClick={removeRun}>Delete draft</button>}
        </div>
      </div>

      {error && <div className="error">{error}</div>}

      {missingRates.length > 0 && (
        <div className="error">
          {missingRates.length} line(s) have no piece rate (amount 0). Set rates under
          Settings → Jobs &amp; Rates, delete this draft, and create the run again.
        </div>
      )}

      {byWorker.map(([personId, group]) => {
        const lineTotal = group.lines.reduce((s, l) => s + Number(l.amount), 0)
        const adjTotal = group.adjustments.reduce((s, a) => s + Number(a.amount), 0)
        return (
          <div className="card" key={personId}>
            <h3>{personName(personId)}</h3>
            <table className="table">
              <thead>
                <tr>
                  <th>Job</th>
                  <th className="right">Quantity</th>
                  <th className="right">Rate</th>
                  <th className="right">Amount</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {group.lines.map((l) => (
                  <tr key={l.id}>
                    <td>{jobLabel(l.job_id)}</td>
                    <td className="right">{Number(l.quantity)}</td>
                    <td className="right">{Number(l.rate).toFixed(4)}</td>
                    <td className="right">{Number(l.amount).toFixed(2)}</td>
                    <td />
                  </tr>
                ))}
                {group.adjustments.map((a) => (
                  <tr key={a.id}>
                    <td className="muted">Adjustment — {a.reason}</td>
                    <td className="right" colSpan={2} />
                    <td className="right">{Number(a.amount).toFixed(2)}</td>
                    <td className="right">
                      {editable && (
                        <button className="linkbtn danger" onClick={() => removeAdjustment(a)}>Remove</button>
                      )}
                    </td>
                  </tr>
                ))}
                <tr className="total-row">
                  <td colSpan={3}>Total</td>
                  <td className="right">{(lineTotal + adjTotal).toFixed(2)}</td>
                  <td />
                </tr>
              </tbody>
            </table>
          </div>
        )
      })}

      {editable && (
        <form className="card row-form" onSubmit={addAdjustment}>
          <label className="field inline">
            <span>Adjustment — user</span>
            <select value={adjWorker} onChange={(e) => setAdjWorker(e.target.value)} required>
              <option value="">Pick…</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>{profileName(u)}</option>
              ))}
            </select>
          </label>
          <label className="field inline">
            <span>Amount (+/−)</span>
            <input
              inputMode="decimal"
              value={adjAmount}
              onChange={(e) => setAdjAmount(e.target.value)}
              placeholder="0.00"
              required
            />
          </label>
          <label className="field inline grow">
            <span>Reason</span>
            <input value={adjReason} onChange={(e) => setAdjReason(e.target.value)} required />
          </label>
          <button className="btn" type="submit">Add adjustment</button>
        </form>
      )}

      <div className="card row-form spread">
        <h3>Grand total</h3>
        <h3>{grandTotal.toFixed(2)}</h3>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */

function MjmLogo() {
  return (
    <svg className="pm-logo" viewBox="0 0 120 120" role="img" aria-label="MJM Group">
      <rect width="120" height="120" rx="16" fill="#2c5940" />
      <text
        x="60" y="60" textAnchor="middle" dominantBaseline="middle"
        fontFamily="Georgia, 'Times New Roman', serif" fontWeight="700"
        fontSize="46" letterSpacing="1" fill="#ffffff"
      >
        MJM
      </text>
      <rect x="14" y="70" width="92" height="24" fill="#a9bd82" />
      <text
        x="60" y="83" textAnchor="middle" dominantBaseline="middle"
        fontFamily="Arial, Helvetica, sans-serif" fontWeight="700"
        fontSize="13" letterSpacing="2.5" fill="#ffffff"
      >
        GROUP
      </text>
    </svg>
  )
}
