// ---------------------------------------------------------------------------
// OPERATION MODULE — every operator work entry in one place, and the verify /
// approve queue worked from the same screen.
//
// The module opens on ALL STATIONS: one list with each station as its own
// collapsible block. Pick a station in the rail and the block header goes
// away — the rail already says which station you are looking at.
//
// Work Record is three tabs following an entry's life: Pending Verify (still
// in the approval pipeline, whether it is waiting on a checker or on
// management), Approved, and Rejected. Adding work lives under the first tab,
// since that is where a new entry lands.
//
// Approving is done here too: rows you may act on can be ticked and cleared
// in one action, or handled one at a time on the row. The rules are the same
// ones the mobile Approvals tab enforces — nobody signs off their own entry,
// a 'verify' grant can verify, an 'approve' grant can do both, and entries
// inside a finalized payroll period are frozen (the database enforces that
// last one as well).
// ---------------------------------------------------------------------------
import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'
import { useOverlayClose } from '../../lib/useOverlayClose'
import { useWideShell } from '../../lib/useWideShell'
import { tagClass } from '../../lib/tags'
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

// Work Record follows an entry's life. 'open' holds everything still in the
// approval pipeline — waiting on a checker AND waiting on management — so a
// verified-but-not-yet-approved entry has somewhere to be; the Status column
// tells the two apart.
type Tab = 'open' | 'approved' | 'rejected'

const RM = (n: number) => `RM ${n.toFixed(2)}`

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** DD/MMM/YYYY — read the same way everywhere, in any locale. */
function fmtDate(iso: string) {
  const [y, m, d] = iso.split('-')
  return `${d}/${MONTHS[Number(m) - 1] ?? '?'}/${y}`
}

/** Sign-offs are stored as e-mail; the table shows the name in front of the
 *  @ and keeps the whole address on hover, so the column stays narrow. */
function shortWho(who: string | null | undefined) {
  if (!who) return '—'
  return who.includes('@') ? who.slice(0, who.indexOf('@')) : who
}

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

/* Row action icons — the same set the Settings tables use. */
const iconProps = {
  width: 15,
  height: 15,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const

const EyeIcon = () => (
  <svg {...iconProps}>
    <path d="M1.5 12S5 5.5 12 5.5 22.5 12 22.5 12 19 18.5 12 18.5 1.5 12 1.5 12Z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
)
const TrashIcon = () => (
  <svg {...iconProps}>
    <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
    <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
    <path d="M10 11v6M14 11v6" />
  </svg>
)

export default function Operation() {
  const { profile } = useAuth()
  // Same margins as Settings: past the narrow page cap, but with wide
  // gutters and a ceiling so the cards stop stretching on a big screen.
  const wideStyle = useWideShell(96, 1280)
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
  const [tab, setTab] = useState<Tab>('open')

  // The filter bar is typed into, then applied with Search — a date half
  // keyed in should not send a query on every keystroke.
  const [fromInput, setFromInput] = useState(monthStartISO())
  const [toInput, setToInput] = useState(todayISO())
  const [searchInput, setSearchInput] = useState('')
  const [from, setFrom] = useState(monthStartISO())
  const [to, setTo] = useState(todayISO())
  const [search, setSearch] = useState('')

  const [needsMe, setNeedsMe] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [detail, setDetail] = useState<{ entry: ProductionEntry; mode: 'view' | 'edit' } | null>(null)
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

  function applyFilters(e?: FormEvent) {
    e?.preventDefault()
    setFrom(fromInput)
    setTo(toInput)
    setSearch(searchInput)
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
        // grade_id rides along: it is the worker's tier tag in the table.
        supabase.from('access_profiles').select('id, full_name, email, employee_code, grade_id'),
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
  /** The piece rate itself, as the masterlist writes it. */
  const rateLabel = (jobId: string) => {
    const r = bestRate.get(jobId)
    if (!r) return '—'
    return r.tier2_rate == null
      ? Number(r.rate).toFixed(2)
      : `${Number(r.rate).toFixed(2)} → ${Number(r.tier2_rate).toFixed(2)}`
  }

  const jobOf = (id: string) => jobs.find((j) => j.id === id) ?? null
  const jobName = (id: string) => jobOf(id)?.name ?? 'Work'
  const stationName = (id: string) => stations.find((s) => s.id === id)?.name ?? '?'
  const personOf = (e: ProductionEntry) => people.find((x) => x.id === (e.user_id ?? e.created_by)) ?? null
  const personName = (e: ProductionEntry) => {
    const p = personOf(e)
    return p ? p.full_name ?? p.email ?? '?' : '—'
  }
  /** The worker's tier tag, which is what the Tier Tag column shows. */
  const tierOf = (e: ProductionEntry) => {
    const p = personOf(e)
    return p?.grade_id ? grades.find((g) => g.id === p.grade_id) ?? null : null
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

  const inTab = (e: ProductionEntry) => {
    const s = stat(e)
    if (tab === 'open') return s === 'pending' || s === 'verified'
    if (tab === 'approved') return s === 'approved'
    return s === 'rejected'
  }

  const needle = search.trim().toLowerCase()
  const matchesFilters = (e: ProductionEntry) => {
    if (needsMe && !actionFor(e)) return false
    if (needle) {
      const hay = `${personName(e)} ${jobName(e.job_id)} ${stationName(e.station_id)}`.toLowerCase()
      if (!hay.includes(needle)) return false
    }
    return true
  }
  const inScope = entries.filter(matchesFilters)
  const visible = inScope.filter(inTab)

  const tabCounts = {
    open: inScope.filter((e) => ['pending', 'verified'].includes(stat(e))).length,
    approved: inScope.filter((e) => stat(e) === 'approved').length,
    rejected: inScope.filter((e) => stat(e) === 'rejected').length,
  }

  // One block per station, in station order. Viewing everything, a station
  // with nothing to show is left out; viewing ONE station the block header
  // is dropped altogether — the rail already names the station.
  const oneStation = scope !== 'all'
  const groups = stations
    .filter((s) => (oneStation ? s.id === scope : true))
    .map((s) => ({ station: s, rows: visible.filter((e) => e.station_id === s.id) }))
    .filter((g) => oneStation || g.rows.length > 0)

  const totals = {
    entries: visible.length,
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

  async function deleteEntry(e: ProductionEntry) {
    if (!window.confirm(`Delete this entry (${e.quantity} × ${jobName(e.job_id)})?`)) return
    setBusy(e.id)
    setError(null)
    const { error } = await supabase.from('production_entries').delete().eq('id', e.id)
    setBusy(null)
    if (error) return setError(error.message)
    setDetail(null)
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

  const colCount = (tab === 'open' ? 1 : 0) + 11

  const entryRows = (rows: ProductionEntry[]) => (
    <div className="board-scroll">
      <table className="table op-table">
        <thead>
          <tr>
            {tab === 'open' && <th className="op-check-col" />}
            <th>Date</th>
            <th>Tier Tag</th>
            <th>Name</th>
            <th>Job</th>
            <th className="right">Qty</th>
            <th className="right">Piece Rate (RM)</th>
            <th className="right">Total Amount (RM)</th>
            <th>Status</th>
            <th>Verified by</th>
            <th>Approved by</th>
            <th className="right">Actions</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={colCount} className="muted">Nothing here for these filters.</td>
            </tr>
          )}
          {rows.map((e) => {
            const s = stat(e)
            const step = actionFor(e)
            const tier = tierOf(e)
            return (
              <tr key={e.id} className={selected.has(e.id) ? 'op-row-on' : ''}>
                {tab === 'open' && (
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
                )}
                <td className="nowrap muted small">{fmtDate(e.work_date)}</td>
                <td>{tier ? <span className={tagClass(tier.color)}>{tier.name}</span> : <span className="muted">—</span>}</td>
                <td>{personName(e)}</td>
                <td className="muted small op-job" title={jobName(e.job_id)}>{jobName(e.job_id)}</td>
                <td className="right">{e.quantity}</td>
                <td className="right nowrap">{rateLabel(e.job_id)}</td>
                <td className="right nowrap"><strong>{amountFor(e.job_id, e.quantity).toFixed(2)}</strong></td>
                <td className="nowrap">
                  {badge(s)}
                  {isLocked(e) && (
                    <span className="mob-chip" title="Date falls in a finalized payroll period" style={{ marginLeft: '0.3rem' }}>
                      🔒
                    </span>
                  )}
                </td>
                <td className="muted small nowrap" title={e.verified_by ?? undefined}>{shortWho(e.verified_by)}</td>
                <td className="muted small nowrap" title={e.approved_by ?? undefined}>{shortWho(e.approved_by)}</td>
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
                  <span className="row-actions">
                    <button
                      className="icon-btn sm"
                      title="View this work record"
                      aria-label={`View ${personName(e)} ${jobName(e.job_id)}`}
                      onClick={() => setDetail({ entry: e, mode: 'view' })}
                    >
                      <EyeIcon />
                    </button>
                    {canModify(e) && (
                      <button
                        className="icon-btn sm danger"
                        title="Delete this work record"
                        aria-label={`Delete ${personName(e)} ${jobName(e.job_id)}`}
                        disabled={busy === e.id}
                        onClick={() => deleteEntry(e)}
                      >
                        <TrashIcon />
                      </button>
                    )}
                  </span>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )

  return (
    <div className="stack" style={wideStyle}>
      {/* Way out on the left, title centred over the page. */}
      <div className="page-head">
        <Link to="/" className="btn ghost backlink-btn">← Back to main page</Link>
        <h1>Operation Module</h1>
      </div>

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
            <h3>Work Record</h3>

            {/* Filters sit above the tabs: they hold whichever tab is open. */}
            <form className="row-form op-filters" onSubmit={applyFilters}>
              <label className="field inline">
                <span>From</span>
                <input type="date" value={fromInput} onChange={(e) => setFromInput(e.target.value)} />
              </label>
              <label className="field inline">
                <span>To</span>
                <input type="date" value={toInput} onChange={(e) => setToInput(e.target.value)} />
              </label>
              <label className="field inline grow">
                <span>Search</span>
                <input
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                  placeholder="Name, job or station…"
                />
              </label>
              <button className="btn" type="submit">Search</button>
              {approvalLevel && (
                <label className="small muted checkbox op-needsme">
                  <input type="checkbox" checked={needsMe} onChange={(e) => setNeedsMe(e.target.checked)} />{' '}
                  Needs my action
                </label>
              )}
            </form>

            <div className="tabs glass">
              <button
                type="button"
                className={`tab ${tab === 'open' ? 'active' : ''}`}
                onClick={() => setTab('open')}
              >
                Pending Verify {tabCounts.open > 0 && <span className="tab-count">{tabCounts.open}</span>}
              </button>
              <button
                type="button"
                className={`tab ${tab === 'approved' ? 'active' : ''}`}
                onClick={() => setTab('approved')}
              >
                Approved {tabCounts.approved > 0 && <span className="tab-count">{tabCounts.approved}</span>}
              </button>
              <button
                type="button"
                className={`tab ${tab === 'rejected' ? 'active' : ''}`}
                onClick={() => setTab('rejected')}
              >
                Rejected {tabCounts.rejected > 0 && <span className="tab-count">{tabCounts.rejected}</span>}
              </button>
            </div>

            {/* Adding work lives under the first tab — a new entry lands
                there, waiting to be verified. */}
            {tab === 'open' && (
              <div className="row-form spread op-tabbar">
                <span className="muted small">
                  {totals.entries} record{totals.entries === 1 ? '' : 's'} · {RM(totals.amount)}
                  {approvalLevel && totals.mine > 0 && <> · <strong>{totals.mine} waiting on you</strong></>}
                </span>
                <Link to="/operation/add" className="btn">+ Add Job Record</Link>
              </div>
            )}
            {tab !== 'open' && (
              <p className="muted small" style={{ margin: 0 }}>
                {totals.entries} record{totals.entries === 1 ? '' : 's'} · {RM(totals.amount)}
              </p>
            )}

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

            {/* One station picked: the rail already names it, so the block
                header goes and the records stand on their own. */}
            {oneStation
              ? entryRows(groups[0]?.rows ?? [])
              : groups.length === 0
                ? <p className="muted">Nothing here for these filters.</p>
                : groups.map(({ station, rows }) => {
                    const shut = collapsed.has(station.id)
                    const actionable = rows.filter((e) => actionFor(e))
                    const allTicked = actionable.length > 0 && actionable.every((e) => selected.has(e.id))
                    const groupAmount = rows.reduce((n, e) => n + amountFor(e.job_id, e.quantity), 0)
                    return (
                      <section className="op-group" key={station.id}>
                        <div className="op-group-head">
                          {tab === 'open' && actionable.length > 0 && (
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
                            {rows.length} record{rows.length === 1 ? '' : 's'}
                            <strong>{RM(groupAmount)}</strong>
                          </span>
                        </div>
                        {!shut && entryRows(rows)}
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

      {detail && (
        <EntryModal
          entry={detail.entry}
          mode={detail.mode}
          onMode={(mode) => setDetail({ entry: detail.entry, mode })}
          onClose={() => setDetail(null)}
          stationName={stationName(detail.entry.station_id)}
          job={jobOf(detail.entry.job_id)}
          tier={tierOf(detail.entry)}
          workerName={personName(detail.entry)}
          rateLabel={rateLabel(detail.entry.job_id)}
          amount={amountFor(detail.entry.job_id, detail.entry.quantity)}
          evidence={evidenceUrl(detail.entry.id)}
          canEdit={canModify(detail.entry)}
          badge={badge}
          onDelete={() => deleteEntry(detail.entry)}
          onSaved={async () => {
            setDetail(null)
            await Promise.all([loadEntries(), loadOpenCounts()])
          }}
        />
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* One work record, opened from the row's eye. The view face is        */
/* read-only; Edit turns the changeable parts into fields. Delete is   */
/* offered here as well as on the row.                                 */
/* ------------------------------------------------------------------ */

function EntryModal({
  entry,
  mode,
  onMode,
  onClose,
  stationName,
  job,
  tier,
  workerName,
  rateLabel,
  amount,
  evidence,
  canEdit,
  badge,
  onDelete,
  onSaved,
}: {
  entry: ProductionEntry
  mode: 'view' | 'edit'
  onMode: (mode: 'view' | 'edit') => void
  onClose: () => void
  stationName: string
  job: Job | null
  tier: Grade | null
  workerName: string
  rateLabel: string
  amount: number
  evidence: string | null
  canEdit: boolean
  badge: (s: string) => JSX.Element
  onDelete: () => void
  onSaved: () => void
}) {
  const overlay = useOverlayClose(onClose)
  const [workDate, setWorkDate] = useState(entry.work_date)
  const [quantity, setQuantity] = useState(String(entry.quantity))
  const [notes, setNotes] = useState(entry.notes ?? '')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const status = entry.approval_status ?? 'approved'

  async function save(e: FormEvent) {
    e.preventDefault()
    setError(null)
    const qty = Number(quantity)
    if (!Number.isFinite(qty) || qty <= 0) return setError('Quantity must be a positive number.')
    if (!workDate) return setError('Pick a work date.')
    if (workDate > todayISO()) return setError('Work date cannot be in the future.')
    setSaving(true)
    const fields: Record<string, unknown> = {
      work_date: workDate,
      quantity: qty,
      notes: notes.trim() || null,
    }
    // A rejected entry that gets fixed goes back into the queue.
    if (status === 'rejected') {
      Object.assign(fields, {
        approval_status: 'pending',
        rejected_reason: null,
        verified_by: null,
        verified_at: null,
        approved_by: null,
        approved_at: null,
      })
    }
    const { error: err } = await supabase.from('production_entries').update(fields).eq('id', entry.id)
    setSaving(false)
    if (err) return setError(err.message)
    onSaved()
  }

  const Line = ({ label, children }: { label: string; children: React.ReactNode }) => (
    <div className="op-line">
      <span className="op-line-label">{label}</span>
      <span className="op-line-value">{children}</span>
    </div>
  )

  const trail = (
    <div className="tag-section">
      <div className="tag-section-title">Approval trail</div>
      <Line label="Status">{badge(status)}</Line>
      <Line label="Verified by">{entry.verified_by ?? '—'}</Line>
      <Line label="Approved by">{entry.approved_by ?? '—'}</Line>
      {status === 'rejected' && entry.rejected_reason && (
        <Line label="Reason">{entry.rejected_reason}</Line>
      )}
    </div>
  )

  if (mode === 'view') {
    return (
      <div className="modal-overlay" {...overlay}>
        <div className="modal modal-view">
          <div className="row-form spread">
            <h2>Work Record</h2>
            <button type="button" className="modal-close" onClick={onClose} aria-label="Close">×</button>
          </div>

          <div className="tag-section">
            <div className="tag-section-title">The work</div>
            <Line label="Date">{fmtDate(entry.work_date)}</Line>
            <Line label="Station">{stationName}</Line>
            <Line label="Tier tag">
              {tier ? <span className={tagClass(tier.color)}>{tier.name}</span> : '—'}
            </Line>
            <Line label="Name">{workerName}</Line>
            <Line label="Job">{job?.name ?? 'Work'}</Line>
            <Line label="Shift">{entry.shift ? `Shift ${entry.shift.toUpperCase()}` : '—'}</Line>
          </div>

          <div className="tag-section">
            <div className="tag-section-title">The count</div>
            <Line label="Qty">{entry.quantity} {job?.unit ?? ''}</Line>
            <Line label="Piece rate (RM)">{rateLabel}</Line>
            <Line label="Total amount (RM)"><strong>{amount.toFixed(2)}</strong></Line>
            {entry.notes && <Line label="Notes">{entry.notes}</Line>}
            <Line label="Attachment">
              {evidence ? (
                <a className="linkbtn" href={evidence} target="_blank" rel="noreferrer">📷 Open</a>
              ) : (
                '—'
              )}
            </Line>
          </div>

          {trail}

          <div className="row-form" style={{ justifyContent: 'flex-end' }}>
            {canEdit && (
              <>
                <button type="button" className="btn ghost danger" onClick={onDelete}>Delete</button>
                <button type="button" className="btn" onClick={() => onMode('edit')}>Edit</button>
              </>
            )}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="modal-overlay" {...overlay}>
      <form className="modal modal-view" onSubmit={save}>
        <div className="row-form spread">
          <h2>Edit work record</h2>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        {error && <div className="error">{error}</div>}

        {/* Who did the work, at which station, on which job is what the
            record IS — changing those would be a different record, and the
            rate is pulled from that pairing. They stay as they are. */}
        <div className="tag-section">
          <div className="tag-section-title">Fixed</div>
          <Line label="Station">{stationName}</Line>
          <Line label="Name">{workerName}</Line>
          <Line label="Job">{job?.name ?? 'Work'}</Line>
          <Line label="Piece rate (RM)">{rateLabel}</Line>
        </div>

        <label className="field">
          <span>Date</span>
          <input type="date" value={workDate} max={todayISO()} onChange={(e) => setWorkDate(e.target.value)} required />
        </label>

        <label className="field">
          <span>Qty {job?.unit ? `(${job.unit})` : ''}</span>
          <input inputMode="decimal" value={quantity} onChange={(e) => setQuantity(e.target.value)} required />
        </label>

        <label className="field">
          <span>Notes</span>
          <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </label>

        {status === 'rejected' && (
          <p className="small muted" style={{ margin: 0 }}>
            Saving a rejected record sends it back for verification.
          </p>
        )}

        <div className="row-form" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn ghost danger" onClick={onDelete}>Delete</button>
          <button type="button" className="btn ghost" onClick={() => onMode('view')}>Cancel</button>
          <button className="btn" type="submit" disabled={saving}>
            {saving ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </form>
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
