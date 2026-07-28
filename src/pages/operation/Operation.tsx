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
// The table shows one ROW per worker + job + day — five photos submitted
// across a shift are one line with their quantities summed. Opening the row
// (the eye) lays those submissions out on the mill day's own clock, 07:00 →
// 07:00, and THAT is where verify / approve / reject live: each submission
// is signed off where it can be seen, next to its photo. The rules are the
// mobile Approvals tab's — nobody signs off their own entry, a 'verify'
// grant can verify, an 'approve' grant can do both, and entries inside a
// finalized payroll period are frozen (the database enforces that too).
// ---------------------------------------------------------------------------
import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'
import { useOverlayClose } from '../../lib/useOverlayClose'
import { useWideShell } from '../../lib/useWideShell'
import { effectiveCapabilities, tagClass } from '../../lib/tags'
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

const DAY_START_HOUR = 7 // the mill day runs 07:00 → 07:00, same as the dashboard board

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

const hh = (h: number) => `${String(h % 24).padStart(2, '0')}:00`

/** Sign-offs are stored as e-mail; the table shows the name in front of the
 *  @ and keeps the whole address on hover, so the column stays narrow. */
function shortWho(who: string | null | undefined) {
  if (!who) return null
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

/** One table row: everything one worker submitted for one job on one day. */
interface WorkGroup {
  key: string
  date: string
  stationId: string
  jobId: string
  workerKey: string
  entries: ProductionEntry[]
}

function groupKeyOf(e: ProductionEntry) {
  return `${e.work_date}::${e.station_id}::${e.job_id}::${e.user_id ?? e.created_by ?? '?'}`
}

export default function Operation() {
  const { profile } = useAuth()
  // Widened like Team Manage, but with a broader gutter so the page
  // keeps clear margins at both edges.
  const wideStyle = useWideShell(56)
  const [stations, setStations] = useState<Station[]>([])
  const [grades, setGrades] = useState<Grade[]>([])
  const [jobs, setJobs] = useState<Job[]>([])
  const [rates, setRates] = useState<PieceRate[]>([])
  const [people, setPeople] = useState<Profile[]>([])
  const [entries, setEntries] = useState<ProductionEntry[]>([])
  const [photos, setPhotos] = useState<PhotoRecord[]>([])
  const [lockedPeriods, setLockedPeriods] = useState<{ period_start: string; period_end: string }[]>([])

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

  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  // The open row, by its group key — derived fresh each render so a verify
  // inside the pop-out shows its new status without closing anything.
  const [detailKey, setDetailKey] = useState<string | null>(null)
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

  // Sign-off rights follow the tag's capabilities from Settings (Work
  // entry setting: Verify / Approve) — tier 1 holds every capability by
  // rule. Admins and managers can approve regardless, and the per-user
  // mobile grant still counts.
  const myGrade = profile?.grade_id ? grades.find((g) => g.id === profile.grade_id) ?? null : null
  const myCaps = effectiveCapabilities(myGrade)
  const approvalLevel: 'verify' | 'approve' | null =
    profile?.role === 'admin' || profile?.role === 'manager' || myCaps.includes('approve')
      ? 'approve'
      : myCaps.includes('verify')
        ? 'verify'
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
  const matchesSearch = (e: ProductionEntry) => {
    if (!needle) return true
    const hay = `${personName(e)} ${jobName(e.job_id)} ${stationName(e.station_id)}`.toLowerCase()
    return hay.includes(needle)
  }
  const inScope = entries.filter(matchesSearch)
  const visible = inScope.filter(inTab)

  /** Fold entries into one row per worker + job + day, submissions kept in
   *  the order they were sent. */
  function buildGroups(list: ProductionEntry[]): WorkGroup[] {
    const m = new Map<string, WorkGroup>()
    for (const e of list) {
      const key = groupKeyOf(e)
      let g = m.get(key)
      if (!g) {
        g = {
          key,
          date: e.work_date,
          stationId: e.station_id,
          jobId: e.job_id,
          workerKey: e.user_id ?? e.created_by ?? '?',
          entries: [],
        }
        m.set(key, g)
      }
      g.entries.push(e)
    }
    for (const g of m.values()) g.entries.sort((a, b) => a.created_at.localeCompare(b.created_at))
    return [...m.values()]
  }

  const groupAmount = (g: WorkGroup) => g.entries.reduce((n, e) => n + amountFor(e.job_id, e.quantity), 0)
  const groupQty = (g: WorkGroup) => g.entries.reduce((n, e) => n + e.quantity, 0)

  /** The row's overall place in the flow: the least-advanced entry rules. */
  const groupStatus = (g: WorkGroup): ProductionEntry['approval_status'] => {
    const ss = g.entries.map(stat)
    if (ss.includes('pending')) return 'pending'
    if (ss.includes('verified')) return 'verified'
    if (ss.includes('rejected')) return 'rejected'
    return 'approved'
  }

  const whoList = (g: WorkGroup, field: 'verified_by' | 'approved_by') => {
    const names = [...new Set(g.entries.map((e) => shortWho(e[field])).filter(Boolean))] as string[]
    return names.length ? names.join(', ') : '—'
  }

  // One block per station, in station order. Viewing everything, a station
  // with nothing to show is left out; viewing ONE station the block header
  // is dropped altogether — the rail already names the station.
  const oneStation = scope !== 'all'
  const stationBlocks = stations
    .filter((s) => (oneStation ? s.id === scope : true))
    .map((s) => ({ station: s, rows: buildGroups(visible.filter((e) => e.station_id === s.id)) }))
    .filter((b) => oneStation || b.rows.length > 0)

  const totals = {
    rows: stationBlocks.reduce((n, b) => n + b.rows.length, 0),
    amount: visible.reduce((n, e) => n + amountFor(e.job_id, e.quantity), 0),
  }

  /** The Piece Rate cell: one number — unless the rate is tiered AND the
   *  5th unit was reached, in which case both prices show with the units
   *  each one paid for. */
  const RateBreak = ({ g }: { g: WorkGroup }) => {
    const r = bestRate.get(g.jobId)
    if (!r) return <span className="muted">—</span>
    if (r.tier2_rate == null) return <>{Number(r.rate).toFixed(2)}</>
    const t1 = g.entries.reduce((n, e) => n + Math.min(e.quantity, TIER1_UNIT_CAP), 0)
    const t2 = g.entries.reduce((n, e) => n + Math.max(0, e.quantity - TIER1_UNIT_CAP), 0)
    if (t2 === 0) return <>{Number(r.rate).toFixed(2)}</>
    return (
      <span className="op-rate-break">
        <span>{t1} × {Number(r.rate).toFixed(2)}</span>
        <span>{t2} × {Number(r.tier2_rate).toFixed(2)}</span>
      </span>
    )
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
    await loadEntries()
  }

  /** The same step for every entry in the pop-out that is ready for it. */
  async function actMany(list: ProductionEntry[], next: 'verified' | 'approved') {
    if (list.length === 0) return
    setBusy('bulk')
    setError(null)
    const { error } = await supabase
      .from('production_entries')
      .update(stampFor(next))
      .in('id', list.map((e) => e.id))
    setBusy(null)
    if (error) return setError(error.message)
    setNotice(`${list.length} entr${list.length === 1 ? 'y' : 'ies'} ${next === 'verified' ? 'verified' : 'approved'}.`)
    await loadEntries()
  }

  async function deleteGroup(g: WorkGroup) {
    const n = g.entries.length
    if (
      !window.confirm(
        n === 1
          ? `Delete this entry (${g.entries[0].quantity} × ${jobName(g.jobId)})?`
          : `Delete ALL ${n} entries by ${personName(g.entries[0])} for "${jobName(g.jobId)}" on ${fmtDate(g.date)}?`,
      )
    )
      return
    setBusy(g.key)
    setError(null)
    const { error } = await supabase
      .from('production_entries')
      .delete()
      .in('id', g.entries.map((e) => e.id))
    setBusy(null)
    if (error) return setError(error.message)
    if (detailKey === g.key) setDetailKey(null)
    await loadEntries()
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

  // The pop-out's group is rebuilt from the CURRENT entries (not the tab
  // slice), so signing one submission off updates in place instead of
  // yanking the window shut.
  const detailGroup = detailKey
    ? buildGroups(entries.filter((e) => groupKeyOf(e) === detailKey))[0] ?? null
    : null

  const stationButton = (s: Station) => {
    const mine = myStationIds.includes(s.id)
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
      </button>
    )
  }

  const groupRows = (rows: WorkGroup[]) => (
    <div className="board-scroll">
      <table className="table op-table">
        <thead>
          <tr>
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
              <td colSpan={11} className="muted">Nothing here for these filters.</td>
            </tr>
          )}
          {rows.map((g) => {
            const first = g.entries[0]
            const tier = tierOf(first)
            const s = groupStatus(g)
            const canDrop = g.entries.every(canModify)
            return (
              <tr key={g.key}>
                <td className="nowrap muted small">
                  {fmtDate(g.date)}
                  {g.entries.length > 1 && (
                    <div className="small muted">{g.entries.length} entries</div>
                  )}
                </td>
                <td>{tier ? <span className={tagClass(tier.color)}>{tier.name}</span> : <span className="muted">—</span>}</td>
                <td>{personName(first)}</td>
                <td className="muted small op-job" title={jobName(g.jobId)}>{jobName(g.jobId)}</td>
                <td className="right">{groupQty(g)}</td>
                <td className="right nowrap"><RateBreak g={g} /></td>
                <td className="right nowrap"><strong>{groupAmount(g).toFixed(2)}</strong></td>
                <td className="nowrap">
                  {badge(s ?? 'approved')}
                  {g.entries.some(isLocked) && (
                    <span className="mob-chip" title="Date falls in a finalized payroll period" style={{ marginLeft: '0.3rem' }}>
                      🔒
                    </span>
                  )}
                </td>
                <td className="muted small nowrap">{whoList(g, 'verified_by')}</td>
                <td className="muted small nowrap">{whoList(g, 'approved_by')}</td>
                <td className="right op-actions">
                  <span className="row-actions">
                    <button
                      className="icon-btn sm"
                      title="View this work record"
                      aria-label={`View ${personName(first)} ${jobName(g.jobId)}`}
                      onClick={() => setDetailKey(g.key)}
                    >
                      <EyeIcon />
                    </button>
                    {canDrop && (
                      <button
                        className="icon-btn sm danger"
                        title={g.entries.length > 1 ? `Delete all ${g.entries.length} entries` : 'Delete this work record'}
                        aria-label={`Delete ${personName(first)} ${jobName(g.jobId)}`}
                        disabled={busy === g.key}
                        onClick={() => deleteGroup(g)}
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
      {/* Same door out and the same banner as Team Manage. */}
      <header className="module-bar">
        <Link to="/" className="btn ghost backlink-btn">← Back to main page</Link>
      </header>
      <h1 className="module-banner">Operation Module</h1>

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
            <span className="op-rail-word">Stations</span>
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
            <h3>
              Work Record
              {oneStation && <span className="op-h3-station"> — {stationName(scope)}</span>}
            </h3>

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
            </form>

            {/* Squared segments; the open one wears the banner's metal shine. */}
            <div className="op-tabs">
              <button
                type="button"
                className={`tab ${tab === 'open' ? 'active' : ''}`}
                onClick={() => setTab('open')}
              >
                Pending Verify
              </button>
              <button
                type="button"
                className={`tab ${tab === 'approved' ? 'active' : ''}`}
                onClick={() => setTab('approved')}
              >
                Approved
              </button>
              <button
                type="button"
                className={`tab ${tab === 'rejected' ? 'active' : ''}`}
                onClick={() => setTab('rejected')}
              >
                Rejected
              </button>
            </div>

            {/* Adding work lives under the first tab — a new entry lands
                there, waiting to be verified. */}
            {tab === 'open' ? (
              <div className="row-form spread op-tabbar">
                <span className="muted small">
                  {totals.rows} row{totals.rows === 1 ? '' : 's'} · {RM(totals.amount)}
                </span>
                <Link to="/operation/add" className="btn">+ Add Job Record</Link>
              </div>
            ) : (
              <p className="muted small" style={{ margin: 0 }}>
                {totals.rows} row{totals.rows === 1 ? '' : 's'} · {RM(totals.amount)}
              </p>
            )}

            {/* One station picked: the rail already names it, so the block
                header goes and the records stand on their own. */}
            {oneStation
              ? groupRows(stationBlocks[0]?.rows ?? [])
              : stationBlocks.length === 0
                ? <p className="muted">Nothing here for these filters.</p>
                : stationBlocks.map(({ station, rows }) => {
                    const shut = collapsed.has(station.id)
                    const amount = rows.reduce((n, g) => n + groupAmount(g), 0)
                    return (
                      <section className="op-group" key={station.id}>
                        <div className="op-group-head">
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
                            {rows.length} row{rows.length === 1 ? '' : 's'}
                            <strong>{RM(amount)}</strong>
                          </span>
                        </div>
                        {!shut && groupRows(rows)}
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

      {detailGroup && (
        <GroupModal
          group={detailGroup}
          onClose={() => setDetailKey(null)}
          stationName={stationName(detailGroup.stationId)}
          job={jobOf(detailGroup.jobId)}
          tier={tierOf(detailGroup.entries[0])}
          workerName={personName(detailGroup.entries[0])}
          rate={bestRate.get(detailGroup.jobId) ?? null}
          amountFor={amountFor}
          groupQty={groupQty(detailGroup)}
          groupAmount={groupAmount(detailGroup)}
          evidenceUrl={evidenceUrl}
          actionFor={actionFor}
          busy={busy}
          badge={badge}
          onAct={act}
          onActMany={actMany}
        />
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* One work-record row, opened. Section 1 is who did what; section 2   */
/* is the mill day's clock (07:00 → 07:00) with every submission laid  */
/* on the hour it came in — photo first, and verify / approve / reject */
/* signed off right there beside it.                                   */
/* ------------------------------------------------------------------ */

function GroupModal({
  group,
  onClose,
  stationName,
  job,
  tier,
  workerName,
  rate,
  amountFor,
  groupQty,
  groupAmount,
  evidenceUrl,
  actionFor,
  busy,
  badge,
  onAct,
  onActMany,
}: {
  group: WorkGroup
  onClose: () => void
  stationName: string
  job: Job | null
  tier: Grade | null
  workerName: string
  rate: PieceRate | null
  amountFor: (jobId: string, qty: number) => number
  groupQty: number
  groupAmount: number
  evidenceUrl: (entryId: string) => string | null
  actionFor: (e: ProductionEntry) => 'verified' | 'approved' | null
  busy: string | null
  badge: (s: string) => JSX.Element
  onAct: (e: ProductionEntry, next: 'verified' | 'approved' | 'rejected') => void
  onActMany: (list: ProductionEntry[], next: 'verified' | 'approved') => void
}) {
  const overlay = useOverlayClose(onClose)

  // The day's 24 hours starting at 07:00, each holding the submissions
  // that arrived in it; runs of empty hours fold into one quiet line.
  const slots: { start: number; end: number; entries: ProductionEntry[] }[] = []
  const byHour = new Map<number, ProductionEntry[]>()
  for (const e of group.entries) {
    const h = new Date(e.created_at).getHours()
    const slot = (h - DAY_START_HOUR + 24) % 24
    if (!byHour.has(slot)) byHour.set(slot, [])
    byHour.get(slot)!.push(e)
  }
  for (let i = 0; i < 24; i++) {
    const list = byHour.get(i) ?? []
    const prev = slots[slots.length - 1]
    if (list.length === 0 && prev && prev.entries.length === 0) {
      prev.end = i + 1
    } else {
      slots.push({ start: i, end: i + 1, entries: list })
    }
  }

  const toVerify = group.entries.filter((e) => actionFor(e) === 'verified')
  const toApprove = group.entries.filter((e) => actionFor(e) === 'approved')

  const timeOf = (e: ProductionEntry) =>
    new Date(e.created_at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })

  // What the day's count is worth, price line by price line.
  const t1Units = group.entries.reduce((n, e) => n + Math.min(e.quantity, TIER1_UNIT_CAP), 0)
  const t2Units = group.entries.reduce((n, e) => n + Math.max(0, e.quantity - TIER1_UNIT_CAP), 0)

  return (
    <div className="modal-overlay" {...overlay}>
      <div className="modal modal-view">
        <div className="row-form spread">
          <div className="op-rec-title">
            <h2>Submitted Work Record</h2>
            <span className="op-rec-by">
              by <strong>{workerName}</strong>
              {tier && <span className={`${tagClass(tier.color)} op-tag-sm`}>{tier.name}</span>}
            </span>
          </div>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        <div className="row-form spread op-rec-sub">
          <span className="op-head-station">{stationName}</span>
          <span className="op-head-date">{fmtDate(group.date)}</span>
        </div>

        <div className="tag-section op-rec-sec">
          <div className="row-form spread" style={{ gap: '0.4rem' }}>
            <div>
              <div className="op-job-title">{job?.name ?? 'Work'}</div>
              <div className="tag-section-title">The day — {hh(DAY_START_HOUR)} → {hh(DAY_START_HOUR)}</div>
            </div>
            <div className="row-form" style={{ gap: '0.4rem' }}>
              {toVerify.length > 1 && (
                <button className="btn row-btn" disabled={busy === 'bulk'} onClick={() => onActMany(toVerify, 'verified')}>
                  ✓ Verify all {toVerify.length}
                </button>
              )}
              {toApprove.length > 1 && (
                <button className="btn row-btn" disabled={busy === 'bulk'} onClick={() => onActMany(toApprove, 'approved')}>
                  ✓ Approve all {toApprove.length}
                </button>
              )}
            </div>
          </div>

          <div className="tag-section-title">Photo evidence</div>
          <div className="board-scroll">
            <table className="table op-tl-table">
              <thead>
                <tr>
                  <th>Timeline</th>
                  <th>Count</th>
                  <th>Time</th>
                  <th className="right">Rate (RM)</th>
                  <th>Photo</th>
                  <th>Status</th>
                  <th className="right" />
                </tr>
              </thead>
              <tbody>
                {slots.map((sl) =>
                  sl.entries.length === 0 ? (
                    <tr className="op-tl-empty" key={sl.start}>
                      <td className="op-tl-hour">{hh(DAY_START_HOUR + sl.start)} – {hh(DAY_START_HOUR + sl.end)}</td>
                      <td colSpan={6} className="op-tl-none">—</td>
                    </tr>
                  ) : (
                    sl.entries.map((e, i) => {
                      const step = actionFor(e)
                      const photo = evidenceUrl(e.id)
                      return (
                        <tr key={e.id}>
                          <td className="op-tl-hour">
                            {i === 0 ? `${hh(DAY_START_HOUR + sl.start)} – ${hh(DAY_START_HOUR + sl.end)}` : ''}
                          </td>
                          <td className="op-tl-no">{i + 1}</td>
                          <td className="op-tl-time">{timeOf(e)}</td>
                          <td className="right nowrap">{amountFor(e.job_id, e.quantity).toFixed(2)}</td>
                          <td>
                            {photo ? (
                              <a
                                className="op-photo-link"
                                href={photo}
                                target="_blank"
                                rel="noreferrer"
                                title="Open the photo"
                                aria-label="Open the photo"
                              >
                                📷
                              </a>
                            ) : (
                              <span className="muted">—</span>
                            )}
                          </td>
                          <td
                            className="nowrap"
                            title={e.approval_status === 'rejected' ? e.rejected_reason ?? undefined : undefined}
                          >
                            {badge(e.approval_status ?? 'approved')}
                          </td>
                          <td className="right nowrap">
                            {step === 'verified' && (
                              <button className="linkbtn" disabled={busy === e.id} onClick={() => onAct(e, 'verified')}>
                                ✓ Verify
                              </button>
                            )}
                            {step === 'approved' && (
                              <button className="linkbtn" disabled={busy === e.id} onClick={() => onAct(e, 'approved')}>
                                ✓ Approve
                              </button>
                            )}
                            {step && (
                              <button className="linkbtn danger" disabled={busy === e.id} onClick={() => onAct(e, 'rejected')}>
                                ✗ Reject
                              </button>
                            )}
                          </td>
                        </tr>
                      )
                    })
                  ),
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* The calculation — the piece rate line by line, then the total. */}
        <div className="tag-section op-rec-sec">
          <div className="tag-section-title">The calculation</div>
          {!rate ? (
            <p className="muted small" style={{ margin: 0 }}>No effective piece rate found for this job.</p>
          ) : rate.tier2_rate == null ? (
            <div className="op-calc-line">
              <span>{groupQty} {job?.unit ?? ''} × RM {Number(rate.rate).toFixed(2)}</span>
              <span>{(groupQty * Number(rate.rate)).toFixed(2)}</span>
            </div>
          ) : (
            <>
              <div className="op-calc-line">
                <span>1st–4th of the hour · {t1Units} × RM {Number(rate.rate).toFixed(2)}</span>
                <span>{(t1Units * Number(rate.rate)).toFixed(2)}</span>
              </div>
              <div className="op-calc-line">
                <span>5th onward · {t2Units} × RM {Number(rate.tier2_rate).toFixed(2)}</span>
                <span>{(t2Units * Number(rate.tier2_rate)).toFixed(2)}</span>
              </div>
            </>
          )}
          <div className="op-calc-line total">
            <span>Total amount</span>
            <span>RM {groupAmount.toFixed(2)}</span>
          </div>
        </div>
      </div>
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
