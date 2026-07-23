// ---------------------------------------------------------------------------
// OPERATION MODULE — the desktop view of operators' work entries, station by
// station. A sidebar lists every station (your own station tags are marked
// in gold); the page shows that station's full entry list with date and
// status filters. Users granted the "Work approval screen" (Settings → User
// access) can verify / approve / reject right here on the computer — the
// same flow as the mobile Approvals tab.
// ---------------------------------------------------------------------------
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import {
  supabase,
  todayISO,
  type Grade,
  type Job,
  type PieceRate,
  type ProductionEntry,
  type Profile,
  type Station,
} from '../lib/supabase'

const TIER1_UNIT_CAP = 4 // tiered hourly rates: tier-1 price covers the first 4 units

type StatusFilter = 'all' | 'pending' | 'verified' | 'approved' | 'rejected'

const RM = (n: number) => `RM ${n.toFixed(2)}`

function monthStartISO() {
  return todayISO().slice(0, 8) + '01'
}

export default function Operation() {
  const { profile } = useAuth()
  const [stations, setStations] = useState<Station[]>([])
  const [grades, setGrades] = useState<Grade[]>([])
  const [jobs, setJobs] = useState<Job[]>([])
  const [rates, setRates] = useState<PieceRate[]>([])
  const [people, setPeople] = useState<Profile[]>([])
  const [stationId, setStationId] = useState<string | null>(null)
  const [entries, setEntries] = useState<ProductionEntry[]>([])
  const [from, setFrom] = useState(monthStartISO())
  const [to, setTo] = useState(todayISO())
  const [status, setStatus] = useState<StatusFilter>('all')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const myStationIds = profile?.station_ids ?? []

  useEffect(() => {
    async function load() {
      const [s, g, j, r, p] = await Promise.all([
        supabase.from('stations').select('*').order('sort_order'),
        supabase.from('grades').select('*').order('sort_order'),
        supabase.from('jobs').select('*'),
        supabase.from('piece_rates').select('*'),
        supabase.from('access_profiles').select('id, full_name, email, employee_code'),
      ])
      const err = s.error || g.error || j.error || r.error
      if (err) setError(err.message)
      setStations(s.data ?? [])
      setGrades(g.data ?? [])
      setJobs(j.data ?? [])
      setRates(r.data ?? [])
      setPeople((p.data ?? []) as Profile[])
      // Land on the user's own station first; else the first station.
      const list = (s.data ?? []) as Station[]
      const mine = list.find((st) => myStationIds.includes(st.id))
      setStationId((prev) => prev ?? (mine ?? list[0])?.id ?? null)
      setLoading(false)
    }
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function loadEntries() {
    if (!stationId) return
    const { data, error } = await supabase
      .from('production_entries')
      .select('*')
      .eq('station_id', stationId)
      .gte('work_date', from)
      .lte('work_date', to)
      .order('work_date', { ascending: false })
      .order('created_at', { ascending: false })
    if (error) setError(error.message)
    else setEntries(data ?? [])
  }
  useEffect(() => {
    loadEntries()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stationId, from, to])

  // Approval rights: same per-user grant as the mobile Approvals screen.
  const myGrade = profile?.grade_id ? grades.find((g) => g.id === profile.grade_id) ?? null : null
  const approvalLevel: 'verify' | 'approve' | null =
    profile?.role === 'admin' || myGrade?.sort_order === 1
      ? 'approve'
      : profile?.mobile_approval ?? null

  const bestRate = useMemo(() => {
    const today = todayISO()
    const best = new Map<string, PieceRate>()
    for (const r of rates) {
      if (r.effective_from > today) continue
      const cur = best.get(r.job_id)
      if (!cur || r.effective_from > cur.effective_from) best.set(r.job_id, r)
    }
    return best
  }, [rates])
  const amountFor = (jobId: string, qty: number) => {
    const r = bestRate.get(jobId)
    if (!r) return 0
    if (r.tier2_rate == null) return r.rate * qty
    return Math.min(qty, TIER1_UNIT_CAP) * r.rate + Math.max(0, qty - TIER1_UNIT_CAP) * r.tier2_rate
  }

  const jobName = (id: string) => jobs.find((j) => j.id === id)?.name ?? 'Work'
  const personName = (e: ProductionEntry) => {
    const p = people.find((x) => x.id === (e.user_id ?? e.created_by))
    return p ? p.full_name ?? p.email ?? '?' : '—'
  }

  const stat = (e: ProductionEntry) => e.approval_status ?? 'approved'
  const filtered = entries.filter((e) => (status === 'all' ? true : stat(e) === status))

  async function act(e: ProductionEntry, next: 'verified' | 'approved' | 'rejected') {
    let reason: string | null = null
    if (next === 'rejected') {
      reason = window.prompt('Reason for rejecting (shown to the worker):') ?? null
      if (reason === null) return
    }
    setBusy(e.id)
    setError(null)
    const me = profile?.email ?? 'unknown'
    const now = new Date().toISOString()
    const fields: Record<string, unknown> = { approval_status: next }
    if (next === 'verified') Object.assign(fields, { verified_by: me, verified_at: now })
    if (next === 'approved') Object.assign(fields, { approved_by: me, approved_at: now })
    if (next === 'rejected') fields.rejected_reason = reason || null
    const { error } = await supabase.from('production_entries').update(fields).eq('id', e.id)
    setBusy(null)
    if (error) return setError(error.message)
    loadEntries()
  }

  const badge = (s: string) => {
    const cls =
      s === 'approved' ? 'ok' : s === 'rejected' ? 'bad' : s === 'verified' ? 'mid' : 'warn'
    const label =
      s === 'approved' ? 'Approved' : s === 'rejected' ? 'Rejected'
      : s === 'verified' ? 'Pending approve' : 'Pending verify'
    return <span className={`mob-chip ${cls}`}>{label}</span>
  }

  if (loading) return <p className="muted">Loading…</p>

  const current = stations.find((s) => s.id === stationId) ?? null

  return (
    <div className="stack">
      <div>
        <Link to="/" className="small muted backlink">← Back to main page</Link>
        <h1>Operation</h1>
        <p className="muted">Work entries recorded by operators, station by station.</p>
      </div>

      {error && <div className="error">{error}</div>}

      <div className="sidebar-layout">
        {/* Station sidebar — your own station tags glow gold. */}
        <nav className="sidebar-nav">
          {stations.map((s) => {
            const mine = myStationIds.includes(s.id)
            return (
              <button
                key={s.id}
                type="button"
                className={`sidebar-link station-link ${stationId === s.id ? 'active' : ''}`}
                onClick={() => setStationId(s.id)}
                title={mine ? 'You are tagged at this station' : undefined}
              >
                <span className={`tag-dot ${mine ? 'dot-gold' : 'dot-grey'}`} aria-hidden="true" />
                <span>{s.name}</span>
                {mine && <span className="you-chip">you</span>}
              </button>
            )
          })}
          {stations.length === 0 && <p className="muted small">No stations yet.</p>}
        </nav>

        <div className="sidebar-content stack">
          <div className="card stack">
            <div className="row-form spread">
              <h3>{current?.name ?? 'Station'} — work entries</h3>
              <span className="muted small">
                {filtered.length} entr{filtered.length === 1 ? 'y' : 'ies'}
              </span>
            </div>

            {/* Filters: date range + status */}
            <div className="row-form">
              <label className="field inline">
                <span>From</span>
                <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
              </label>
              <label className="field inline">
                <span>To</span>
                <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
              </label>
              <label className="field inline">
                <span>Status</span>
                <select value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)}>
                  <option value="all">All statuses</option>
                  <option value="pending">Pending verify</option>
                  <option value="verified">Pending approve</option>
                  <option value="approved">Approved</option>
                  <option value="rejected">Rejected</option>
                </select>
              </label>
            </div>

            <div className="board-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Worker</th>
                    <th>Job</th>
                    <th className="right">Qty</th>
                    <th className="right">Amount</th>
                    <th>Status</th>
                    <th>By</th>
                    {approvalLevel && <th className="right">Actions</th>}
                  </tr>
                </thead>
                <tbody>
                  {filtered.length === 0 && (
                    <tr>
                      <td colSpan={approvalLevel ? 8 : 7} className="muted">
                        No entries in this range.
                      </td>
                    </tr>
                  )}
                  {filtered.map((e) => {
                    const s = stat(e)
                    const own = e.user_id === profile?.id
                    const canVerifyRow = approvalLevel && s === 'pending' && !own
                    const canApproveRow = approvalLevel === 'approve' && s === 'verified' && !own
                    const canRejectRow = (canVerifyRow || canApproveRow) && !own
                    return (
                      <tr key={e.id}>
                        <td className="muted small">
                          {new Date(e.work_date + 'T00:00:00').toLocaleDateString(undefined, {
                            day: '2-digit', month: 'short',
                          })}
                        </td>
                        <td>{personName(e)}</td>
                        <td className="muted small">{jobName(e.job_id)}</td>
                        <td className="right">{e.quantity}</td>
                        <td className="right">{RM(amountFor(e.job_id, e.quantity))}</td>
                        <td>
                          {badge(s)}
                          {s === 'rejected' && e.rejected_reason && (
                            <div className="muted small">{e.rejected_reason}</div>
                          )}
                        </td>
                        <td className="muted small">
                          {s === 'approved'
                            ? e.approved_by ?? '—'
                            : s === 'verified'
                              ? e.verified_by ?? '—'
                              : '—'}
                        </td>
                        {approvalLevel && (
                          <td className="right op-actions">
                            {canVerifyRow && (
                              <button
                                className="linkbtn"
                                disabled={busy === e.id}
                                onClick={() => act(e, 'verified')}
                              >
                                ✓ Verify
                              </button>
                            )}
                            {canApproveRow && (
                              <button
                                className="linkbtn"
                                disabled={busy === e.id}
                                onClick={() => act(e, 'approved')}
                              >
                                ✓ Approve
                              </button>
                            )}
                            {canRejectRow && (
                              <button
                                className="linkbtn danger"
                                disabled={busy === e.id}
                                onClick={() => act(e, 'rejected')}
                              >
                                ✗ Reject
                              </button>
                            )}
                            {own && <span className="muted small">own entry</span>}
                          </td>
                        )}
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            {!approvalLevel && (
              <p className="muted small">
                View only — the "Work approval screen" access in Settings → User access
                also unlocks verify / approve here.
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
