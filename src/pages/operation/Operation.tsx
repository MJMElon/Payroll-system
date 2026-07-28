// ---------------------------------------------------------------------------
// OPERATION MODULE — every operator work entry in one place, and the verify /
// approve queue worked from the same screen.
//
// The module opens on ALL STATIONS: one scrolling list with each station as
// its own collapsible block carrying its count, what is waiting, and its
// total. That is the view built to survive the mill growing — a rail of 30
// stations is searchable, your own stations sit at the top, and each one
// badges how many entries are waiting on someone, so an approver can see
// where the work is without opening every station in turn.
//
// Approving is done here too: rows you may act on can be ticked and cleared
// in one action, or handled one at a time on the row. The rules are the same
// ones the mobile Approvals tab enforces — nobody signs off their own entry,
// a 'verify' grant can verify, an 'approve' grant can do both, and entries
// inside a finalized payroll period are frozen (the database enforces that
// last one as well).
//
// Adding work stays on its own page (/operation/add), which pulls the rate
// from Piece Rate Master and works out the amount.
// ---------------------------------------------------------------------------
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import Select from '../../components/Select'
import { useAuth } from '../../context/AuthContext'
import { useWideShell } from '../../lib/useWideShell'
import {
  supabase,
  todayISO,
  type Grade,
  type Job,
  type PhotoRecord,
  type PieceRate,
  type ProductionEntry,
  type Profile,
  type Station,
} from '../../lib/supabase'

const TIER1_UNIT_CAP = 4 // tiered hourly rates: tier-1 price covers the first 4 units

// A station rail longer than this gets a search box above it.
const RAIL_SEARCH_FROM = 8

// Whether the rail is folded away is a personal preference, kept in this
// browser rather than on the account.
const RAIL_KEY = 'mjm-op-rail-open'

type StatusFilter = 'all' | 'pending' | 'verified' | 'approved' | 'rejected'

const STATUS_OPTIONS = [
  { value: 'all', label: 'All statuses' },
  { value: 'pending', label: 'Pending verify' },
  { value: 'verified', label: 'Pending approve' },
  { value: 'approved', label: 'Approved' },
  { value: 'rejected', label: 'Rejected' },
]

const RM = (n: number) => `RM ${n.toFixed(2)}`

function monthStartISO() {
  return todayISO().slice(0, 8) + '01'
}

/** Postgres takes the id list in the URL, so a long one is asked for in
 *  batches rather than in a single request that would be refused. */
function chunk<T>(list: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}

export default function Operation() {
  const { profile } = useAuth()
  // Ten columns of entries plus a station rail need more than the shared
  // content cap; widen to the window like Team Manage does.
  const wideStyle = useWideShell(24, 1500)
  const [stations, setStations] = useState<Station[]>([])
  const [grades, setGrades] = useState<Grade[]>([])
  const [jobs, setJobs] = useState<Job[]>([])
  const [rates, setRates] = useState<PieceRate[]>([])
  const [people, setPeople] = useState<Profile[]>([])
  const [entries, setEntries] = useState<ProductionEntry[]>([])
  const [photos, setPhotos] = useState<PhotoRecord[]>([])
  const [lockedPeriods, setLockedPeriods] = useState<{ period_start: string; period_end: string }[]>([])
  // What is still waiting, per station, across ALL dates — the rail badge
  // has to point at old stragglers too, not just the range on screen.
  const [openByStation, setOpenByStation] = useState<Map<string, number>>(new Map())

  // 'all' = every station at once, which is where the module opens.
  const [scope, setScope] = useState<'all' | string>('all')
  const [railSearch, setRailSearch] = useState('')
  const [railOpen, setRailOpen] = useState(() => localStorage.getItem(RAIL_KEY) !== 'closed')
  const [from, setFrom] = useState(monthStartISO())
  const [to, setTo] = useState(todayISO())
  const [status, setStatus] = useState<StatusFilter>('all')
  const [needsMe, setNeedsMe] = useState(false)
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const myStationIds = profile?.station_ids ?? []

  function toggleRail() {
    setRailOpen((open) => {
      localStorage.setItem(RAIL_KEY, open ? 'closed' : 'open')
      return !open
    })
  }

  /** How many entries are still waiting on someone, station by station. */
  async function loadOpenCounts() {
    const { data } = await supabase
      .from('production_entries')
      .select('station_id, approval_status')
      .in('approval_status', ['pending', 'verified'])
    const m = new Map<string, number>()
    for (const row of data ?? []) m.set(row.station_id, (m.get(row.station_id) ?? 0) + 1)
    setOpenByStation(m)
  }

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
      // Finalized payroll periods freeze their entries (visible to everyone).
      const { data: lp } = await supabase
        .from('payroll_runs')
        .select('period_start, period_end')
        .eq('status', 'finalized')
      setLockedPeriods(lp ?? [])
      await loadOpenCounts()
      setLoading(false)
    }
    load()
  }, [])

  async function loadEntries() {
    let q = supabase
      .from('production_entries')
      .select('*')
      .gte('work_date', from)
      .lte('work_date', to)
    if (scope !== 'all') q = q.eq('station_id', scope)
    const { data, error } = await q
      .order('work_date', { ascending: false })
      .order('created_at', { ascending: false })
    if (error) {
      setError(error.message)
      return
    }
    const list = data ?? []
    setEntries(list)
    setSelected(new Set())

    // Attached photo/PDF evidence for exactly the entries on screen.
    const ids = list.map((e) => e.id)
    if (ids.length === 0) return setPhotos([])
    const batches = await Promise.all(
      chunk(ids, 200).map((part) =>
        supabase
          .from('photo_records')
          .select('id, station_id, photo_path, taken_at, entry_id')
          .in('entry_id', part),
      ),
    )
    setPhotos(batches.flatMap((b) => (b.data ?? []) as PhotoRecord[]))
  }

  useEffect(() => {
    if (loading) return
    loadEntries()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, from, to, loading])

  // Approval rights: same per-user grant as the mobile Approvals screen.
  const myGrade = profile?.grade_id ? grades.find((g) => g.id === profile.grade_id) ?? null : null
  const approvalLevel: 'verify' | 'approve' | null =
    profile?.role === 'admin' || myGrade?.sort_order === 1
      ? 'approve'
      : profile?.mobile_approval ?? null
  const canManage =
    profile?.role === 'admin' || profile?.role === 'manager' || myGrade?.sort_order === 1

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
  const stationName = (id: string) => stations.find((s) => s.id === id)?.name ?? '?'
  const personName = (e: ProductionEntry) => {
    const p = people.find((x) => x.id === (e.user_id ?? e.created_by))
    return p ? p.full_name ?? p.email ?? '?' : '—'
  }

  // Evidence link for an entry (photo/PDF uploaded with the job record).
  const evidenceUrl = (entryId: string) => {
    const rec = photos.find((p) => p.entry_id === entryId)
    return rec?.photo_path
      ? supabase.storage.from('records').getPublicUrl(rec.photo_path).data.publicUrl
      : null
  }

  const stat = (e: ProductionEntry) => e.approval_status ?? 'approved'

  // An entry whose date falls inside a finalized payroll run is frozen —
  // the books for that period are closed (also enforced by a DB trigger).
  const isLocked = (e: ProductionEntry) =>
    lockedPeriods.some((p) => p.period_start <= e.work_date && e.work_date <= p.period_end)

  /** The one step this user may take on this entry right now, if any.
   *  Nobody signs off their own work, and a closed period takes no more. */
  const actionFor = (e: ProductionEntry): 'verified' | 'approved' | null => {
    if (!approvalLevel || isLocked(e)) return null
    if (e.user_id === profile?.id) return null
    const s = stat(e)
    if (s === 'pending') return 'verified'
    if (s === 'verified' && approvalLevel === 'approve') return 'approved'
    return null
  }

  // Edit / delete: managers always; a worker may fix or remove their OWN
  // entry while it is still pending (or was rejected — editing resubmits).
  const canModify = (e: ProductionEntry) =>
    !isLocked(e) &&
    (canManage ||
      ((e.created_by === profile?.id || e.user_id === profile?.id) &&
        ['pending', 'rejected'].includes(stat(e))))

  const needle = search.trim().toLowerCase()
  const visible = entries.filter((e) => {
    if (status !== 'all' && stat(e) !== status) return false
    if (needsMe && !actionFor(e)) return false
    if (needle) {
      const hay = `${personName(e)} ${jobName(e.job_id)} ${stationName(e.station_id)}`.toLowerCase()
      if (!hay.includes(needle)) return false
    }
    return true
  })

  // One block per station, in station order. Viewing everything, a station
  // with nothing to show is left out rather than sitting there as an empty
  // header; viewing one station, its block stays so it can say so.
  const groups = stations
    .filter((s) => (scope === 'all' ? true : s.id === scope))
    .map((s) => ({ station: s, rows: visible.filter((e) => e.station_id === s.id) }))
    .filter((g) => scope !== 'all' || g.rows.length > 0)

  const totals = {
    entries: visible.length,
    pending: visible.filter((e) => stat(e) === 'pending').length,
    verified: visible.filter((e) => stat(e) === 'verified').length,
    mine: visible.filter((e) => actionFor(e)).length,
    amount: visible.reduce((n, e) => n + amountFor(e.job_id, e.quantity), 0),
  }

  const selectedRows = visible.filter((e) => selected.has(e.id))
  const toVerify = selectedRows.filter((e) => actionFor(e) === 'verified')
  const toApprove = selectedRows.filter((e) => actionFor(e) === 'approved')

  function toggleRow(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  /** Tick (or untick) every row in one station block that this user may
   *  actually action — the rest are not selectable in the first place. */
  function toggleGroup(rows: ProductionEntry[]) {
    const actionable = rows.filter((e) => actionFor(e)).map((e) => e.id)
    const allOn = actionable.length > 0 && actionable.every((id) => selected.has(id))
    setSelected((prev) => {
      const next = new Set(prev)
      for (const id of actionable) {
        if (allOn) next.delete(id)
        else next.add(id)
      }
      return next
    })
  }

  function stampFor(next: 'verified' | 'approved' | 'rejected', reason?: string | null) {
    const me = profile?.email ?? 'unknown'
    const now = new Date().toISOString()
    const fields: Record<string, unknown> = { approval_status: next }
    if (next === 'verified') Object.assign(fields, { verified_by: me, verified_at: now })
    if (next === 'approved') Object.assign(fields, { approved_by: me, approved_at: now })
    if (next === 'rejected') fields.rejected_reason = reason || null
    return fields
  }

  async function act(e: ProductionEntry, next: 'verified' | 'approved' | 'rejected') {
    let reason: string | null = null
    if (next === 'rejected') {
      reason = window.prompt('Reason for rejecting (shown to the worker):') ?? null
      if (reason === null) return
    }
    setBusy(e.id)
    setError(null)
    const { error } = await supabase
      .from('production_entries')
      .update(stampFor(next, reason))
      .eq('id', e.id)
    setBusy(null)
    if (error) return setError(error.message)
    await Promise.all([loadEntries(), loadOpenCounts()])
  }

  /** The same step taken on every ticked row that is ready for it. */
  async function bulk(next: 'verified' | 'approved' | 'rejected') {
    const rows =
      next === 'verified' ? toVerify : next === 'approved' ? toApprove : selectedRows.filter((e) => actionFor(e))
    if (rows.length === 0) return
    let reason: string | null = null
    if (next === 'rejected') {
      reason = window.prompt(`Reason for rejecting ${rows.length} entr${rows.length === 1 ? 'y' : 'ies'} (shown to the workers):`) ?? null
      if (reason === null) return
    }
    setBusy('bulk')
    setError(null)
    setNotice(null)
    const { error } = await supabase
      .from('production_entries')
      .update(stampFor(next, reason))
      .in('id', rows.map((r) => r.id))
    setBusy(null)
    if (error) return setError(error.message)
    setNotice(
      `${rows.length} entr${rows.length === 1 ? 'y' : 'ies'} ${
        next === 'verified' ? 'verified' : next === 'approved' ? 'approved' : 'rejected'
      }.`,
    )
    await Promise.all([loadEntries(), loadOpenCounts()])
  }

  async function editEntry(e: ProductionEntry) {
    const raw = window.prompt('New quantity:', String(e.quantity))
    if (raw === null) return
    const qty = Number(raw)
    if (!Number.isFinite(qty) || qty <= 0) return setError('Quantity must be a positive number.')
    setBusy(e.id)
    setError(null)
    const fields: Record<string, unknown> = { quantity: qty }
    if (stat(e) === 'rejected') {
      // Editing a rejected entry resubmits it for approval.
      Object.assign(fields, {
        approval_status: 'pending',
        rejected_reason: null,
        verified_by: null,
        verified_at: null,
        approved_by: null,
        approved_at: null,
      })
    }
    const { error } = await supabase.from('production_entries').update(fields).eq('id', e.id)
    setBusy(null)
    if (error) return setError(error.message)
    await Promise.all([loadEntries(), loadOpenCounts()])
  }

  async function deleteEntry(e: ProductionEntry) {
    if (!window.confirm(`Delete this entry (${e.quantity} × ${jobName(e.job_id)})?`)) return
    setBusy(e.id)
    setError(null)
    const { error } = await supabase.from('production_entries').delete().eq('id', e.id)
    setBusy(null)
    if (error) return setError(error.message)
    await Promise.all([loadEntries(), loadOpenCounts()])
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

  const railNeedle = railSearch.trim().toLowerCase()
  const railList = stations.filter((s) => (railNeedle ? s.name.toLowerCase().includes(railNeedle) : true))
  const mineList = railList.filter((s) => myStationIds.includes(s.id))
  const otherList = railList.filter((s) => !myStationIds.includes(s.id))
  const totalOpen = [...openByStation.values()].reduce((a, b) => a + b, 0)

  const stationButton = (s: Station) => {
    const mine = myStationIds.includes(s.id)
    const open = openByStation.get(s.id) ?? 0
    return (
      <button
        key={s.id}
        type="button"
        className={`sidebar-link station-link ${scope === s.id ? 'active' : ''}`}
        onClick={() => setScope(s.id)}
        title={mine ? 'You are tagged at this station' : undefined}
      >
        <span className={`tag-dot ${mine ? 'dot-gold' : 'dot-grey'}`} aria-hidden="true" />
        <span className="op-rail-name">{s.name}</span>
        {open > 0 && (
          <span className="count-badge static" title={`${open} waiting on someone`}>{open}</span>
        )}
      </button>
    )
  }

  return (
    <div className="stack" style={wideStyle}>
      <header className="module-head">
        <Link to="/" className="btn ghost module-back">← Back to main page</Link>
      </header>
      <h1 className="module-title">Operation module</h1>

      {error && <div className="error">{error}</div>}
      {notice && <div className="notice">{notice}</div>}

      <div className="sidebar-layout">
        {/* Station rail — searchable, your own stations first, each badged
            with what is still waiting there, and foldable when the entry
            list wants the whole width. */}
        {!railOpen ? (
          <div className="op-rail-mini">
            <button
              type="button"
              className="op-rail-toggle"
              onClick={toggleRail}
              title="Show the station list"
              aria-label="Show the station list"
              aria-expanded={false}
            >
              »
            </button>
            <span className="op-rail-vert">Stations</span>
            {totalOpen > 0 && (
              <span className="count-badge static" title={`${totalOpen} waiting across every station`}>
                {totalOpen}
              </span>
            )}
          </div>
        ) : (
        <nav className="sidebar-nav op-rail">
          <div className="op-rail-head">
            {stations.length > RAIL_SEARCH_FROM && (
              <input
                className="op-rail-search"
                value={railSearch}
                onChange={(e) => setRailSearch(e.target.value)}
                placeholder="Search station…"
                aria-label="Search station"
              />
            )}
            <button
              type="button"
              className="op-rail-toggle"
              onClick={toggleRail}
              title="Hide the station list"
              aria-label="Hide the station list"
              aria-expanded
              style={{ marginLeft: 'auto' }}
            >
              «
            </button>
          </div>
          <button
            type="button"
            className={`sidebar-link station-link ${scope === 'all' ? 'active' : ''}`}
            onClick={() => setScope('all')}
          >
            <IconAllStations />
            <span className="op-rail-name">All stations</span>
            {totalOpen > 0 && (
              <span className="count-badge static" title={`${totalOpen} waiting across every station`}>
                {totalOpen}
              </span>
            )}
          </button>

          {mineList.length > 0 && <p className="rail-group-title">Your stations</p>}
          {mineList.map(stationButton)}
          {otherList.length > 0 && (
            <p className="rail-group-title">{mineList.length > 0 ? 'Other stations' : 'Stations'}</p>
          )}
          {otherList.map(stationButton)}
          {railList.length === 0 && <p className="muted small">No station matches.</p>}
        </nav>
        )}

        <div className="sidebar-content stack">
          <div className="card stack">
            <div className="row-form spread">
              <h3>{scope === 'all' ? 'All stations' : stationName(scope)} — work entries</h3>
              <Link to="/operation/add" className="btn">+ Add Job Record</Link>
            </div>

            {/* What the current filter adds up to. */}
            <div className="op-stats">
              <Stat label="Entries" value={String(totals.entries)} />
              <Stat label="Pending verify" value={String(totals.pending)} tone={totals.pending ? 'warn' : undefined} />
              <Stat label="Pending approve" value={String(totals.verified)} tone={totals.verified ? 'warn' : undefined} />
              {approvalLevel && (
                <Stat label="Waiting on you" value={String(totals.mine)} tone={totals.mine ? 'act' : undefined} />
              )}
              <Stat label="Amount" value={RM(totals.amount)} />
            </div>

            {/* Filters: date range, status, free-text, and the approver's
                "only what I can act on" switch. */}
            <div className="row-form">
              <label className="field inline">
                <span>From</span>
                <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
              </label>
              <label className="field inline">
                <span>To</span>
                <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
              </label>
              <div className="field inline">
                <span>Status</span>
                <Select
                  block
                  value={status}
                  onChange={(v) => setStatus(v as StatusFilter)}
                  options={STATUS_OPTIONS}
                  ariaLabel="Filter by status"
                />
              </div>
              <label className="field inline grow">
                <span>Search</span>
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Worker, job or station…"
                />
              </label>
              {approvalLevel && (
                <label className="small muted checkbox op-needsme">
                  <input type="checkbox" checked={needsMe} onChange={(e) => setNeedsMe(e.target.checked)} />{' '}
                  Needs my action
                </label>
              )}
            </div>

            {/* Ticked rows get cleared together instead of one click each. */}
            {selectedRows.length > 0 && (
              <div className="op-bulkbar">
                <span className="op-bulk-count">{selectedRows.length} selected</span>
                {toVerify.length > 0 && (
                  <button className="btn" disabled={busy === 'bulk'} onClick={() => bulk('verified')}>
                    ✓ Verify {toVerify.length}
                  </button>
                )}
                {toApprove.length > 0 && (
                  <button className="btn" disabled={busy === 'bulk'} onClick={() => bulk('approved')}>
                    ✓ Approve {toApprove.length}
                  </button>
                )}
                <button className="btn ghost danger" disabled={busy === 'bulk'} onClick={() => bulk('rejected')}>
                  ✗ Reject
                </button>
                <button type="button" className="linkbtn" onClick={() => setSelected(new Set())}>
                  Clear
                </button>
              </div>
            )}

            {groups.length === 0 && (
              <p className="muted">No entries match these filters.</p>
            )}

            {groups.map(({ station, rows }) => {
              const shut = collapsed.has(station.id)
              const actionable = rows.filter((e) => actionFor(e))
              const allTicked = actionable.length > 0 && actionable.every((e) => selected.has(e.id))
              const groupOpen = rows.filter((e) => ['pending', 'verified'].includes(stat(e))).length
              const groupAmount = rows.reduce((n, e) => n + amountFor(e.job_id, e.quantity), 0)
              return (
                <section className="op-group" key={station.id}>
                  <div className="op-group-head">
                    {actionable.length > 0 && (
                      <input
                        type="checkbox"
                        className="op-check"
                        checked={allTicked}
                        onChange={() => toggleGroup(rows)}
                        title={`Select the ${actionable.length} entr${actionable.length === 1 ? 'y' : 'ies'} you can action here`}
                        aria-label={`Select actionable entries at ${station.name}`}
                      />
                    )}
                    <button
                      type="button"
                      className="op-group-toggle"
                      aria-expanded={!shut}
                      onClick={() =>
                        setCollapsed((prev) => {
                          const next = new Set(prev)
                          if (next.has(station.id)) next.delete(station.id)
                          else next.add(station.id)
                          return next
                        })
                      }
                    >
                      <span className="op-caret" aria-hidden="true">{shut ? '▸' : '▾'}</span>
                      <span className="op-group-name">{station.name}</span>
                      {myStationIds.includes(station.id) && <span className="you-chip">you</span>}
                    </button>
                    <span className="op-group-meta">
                      {rows.length} entr{rows.length === 1 ? 'y' : 'ies'}
                      {groupOpen > 0 && <span className="mob-chip warn">{groupOpen} waiting</span>}
                      <strong>{RM(groupAmount)}</strong>
                    </span>
                  </div>

                  {!shut && (
                    <div className="board-scroll">
                      <table className="table">
                        <thead>
                          <tr>
                            <th className="op-check-col" />
                            <th>Date</th>
                            <th>Worker</th>
                            <th>Job</th>
                            <th className="right">Qty</th>
                            <th className="right">Amount</th>
                            <th>Photo</th>
                            <th>Status</th>
                            <th>By</th>
                            <th className="right">Actions</th>
                          </tr>
                        </thead>
                        <tbody>
                          {rows.length === 0 && (
                            <tr>
                              <td colSpan={10} className="muted">No entries in this range.</td>
                            </tr>
                          )}
                          {rows.map((e) => {
                            const s = stat(e)
                            const step = actionFor(e)
                            const locked = isLocked(e)
                            return (
                              <tr key={e.id} className={selected.has(e.id) ? 'op-row-on' : ''}>
                                <td className="op-check-col">
                                  {step && (
                                    <input
                                      type="checkbox"
                                      className="op-check"
                                      checked={selected.has(e.id)}
                                      onChange={() => toggleRow(e.id)}
                                      aria-label={`Select ${personName(e)} ${jobName(e.job_id)}`}
                                    />
                                  )}
                                </td>
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
                                  {evidenceUrl(e.id) ? (
                                    <a
                                      className="linkbtn"
                                      href={evidenceUrl(e.id)!}
                                      target="_blank"
                                      rel="noreferrer"
                                      title="Open attached evidence"
                                    >
                                      📷 View
                                    </a>
                                  ) : (
                                    <span className="muted small">—</span>
                                  )}
                                </td>
                                <td>
                                  {badge(s)}
                                  {locked && (
                                    <span className="mob-chip" title="Date falls in a finalized payroll period" style={{ marginLeft: '0.3rem' }}>
                                      🔒
                                    </span>
                                  )}
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
                                <td className="right op-actions">
                                  {step === 'verified' && (
                                    <button className="linkbtn" disabled={busy === e.id} onClick={() => act(e, 'verified')}>
                                      ✓ Verify
                                    </button>
                                  )}
                                  {step === 'approved' && (
                                    <button className="linkbtn" disabled={busy === e.id} onClick={() => act(e, 'approved')}>
                                      ✓ Approve
                                    </button>
                                  )}
                                  {step && (
                                    <button className="linkbtn danger" disabled={busy === e.id} onClick={() => act(e, 'rejected')}>
                                      ✗ Reject
                                    </button>
                                  )}
                                  {canModify(e) && (
                                    <>
                                      <button
                                        className="linkbtn"
                                        disabled={busy === e.id}
                                        onClick={() => editEntry(e)}
                                        title={s === 'rejected' ? 'Edit & resubmit' : 'Edit quantity'}
                                      >
                                        ✎ Edit
                                      </button>
                                      <button className="linkbtn danger" disabled={busy === e.id} onClick={() => deleteEntry(e)}>
                                        🗑 Delete
                                      </button>
                                    </>
                                  )}
                                </td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </section>
              )
            })}

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

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'warn' | 'act' }) {
  return (
    <div className={`op-stat ${tone ?? ''}`}>
      <span className="op-stat-label">{label}</span>
      <span className="op-stat-value">{value}</span>
    </div>
  )
}

function IconAllStations() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flex: 'none' }}>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </svg>
  )
}
