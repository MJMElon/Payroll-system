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
import { useEffect, useMemo, useState, type ChangeEvent, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import Select from '../../components/Select'
import { useAuth } from '../../context/AuthContext'
import { useOverlayClose } from '../../lib/useOverlayClose'
import { useWideShell } from '../../lib/useWideShell'
import { canViewTier, effectiveCapabilities, tagClass } from '../../lib/tags'
import {
  profileName,
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

const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024

// Camera photos are several MB; shrink to a sensible size before uploading.
async function compressImage(file: File): Promise<Blob> {
  try {
    const MAX = 1600
    const bitmap = await createImageBitmap(file)
    const scale = Math.min(1, MAX / Math.max(bitmap.width, bitmap.height))
    if (scale === 1 && file.size < 800_000) return file
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(bitmap.width * scale)
    canvas.height = Math.round(bitmap.height * scale)
    const ctx = canvas.getContext('2d')
    if (!ctx) return file
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    bitmap.close()
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/jpeg', 0.82))
    return blob && blob.size < file.size ? blob : file
  } catch {
    return file
  }
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
const PencilIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
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
  const [showAdd, setShowAdd] = useState(false)
  const [editEntry, setEditEntry] = useState<ProductionEntry | null>(null)
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
        supabase.from('shared_stations').select('*').order('sort_order'),
        supabase.from('shared_grades').select('*').order('sort_order'),
        supabase.from('piece_rate_jobs').select('*'),
        supabase.from('piece_rates').select('*'),
        // grade_id rides along: it is the worker's tier tag in the table.
        supabase.from('shared_profiles').select('id, full_name, email, employee_code, grade_id'),
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
      .from('operation_entries')
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
          .from('operation_photos')
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
  // Adding and deleting follow their own ticks from the tag editor (Work
  // entry setting: Add New / Delete); managers and tier 1 hold every tick.
  const canAddEntry = canManage || myCaps.includes('data-entry')
  const canEditEntry = canManage || myCaps.includes('edit-entry')
  const canDeleteEntry = canManage || myCaps.includes('delete-entry')

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

  // Evidence for an entry (photo/PDF uploaded with the job record), with
  // when it was taken riding along for the lightbox caption.
  const evidenceOf = (entryId: string): { url: string; takenAt: string | null } | null => {
    const rec = photos.find((p) => p.entry_id === entryId)
    if (!rec?.photo_path) return null
    return {
      url: supabase.storage.from('records').getPublicUrl(rec.photo_path).data.publicUrl,
      takenAt: rec.taken_at ?? null,
    }
  }

  const stat = (e: ProductionEntry) => e.approval_status ?? 'approved'

  // An entry whose date falls inside a finalized payroll run is frozen —
  // the books for that period are closed (also enforced by a DB trigger).
  const isLocked = (e: ProductionEntry) =>
    lockedPeriods.some((p) => p.period_start <= e.work_date && e.work_date <= p.period_end)

  const isManagement =
    profile?.role === 'admin' || profile?.role === 'manager' || myGrade?.sort_order === 1

  /** The one step this user may take on this entry right now, if any.
   *  Below management, nobody signs off their own work; a closed payroll
   *  period takes no more from anyone. */
  const actionFor = (e: ProductionEntry): 'verified' | 'approved' | null => {
    if (!approvalLevel || isLocked(e)) return null
    if (!isManagement && e.user_id === profile?.id) return null
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
  /**
   * Whose work records this account may read at all, set per tier tag under
   * Settings → Tier Tag Access Manage → Operation Module ("View work record
   * of"). A tag nobody has set falls back to its own rank and every rank
   * below. A record by somebody with no tier tag belongs to no rung and is
   * open to everyone, the same as untagged work everywhere else.
   */
  const inReach = (e: ProductionEntry) =>
    canViewTier(myGrade, grades, 'entry', personOf(e)?.grade_id ?? null)

  const inScope = entries.filter(matchesSearch).filter(inReach)
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
      .from('operation_entries')
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
      .from('operation_entries')
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
      .from('operation_entries')
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
            const canDrop = canDeleteEntry && g.entries.every(canModify)
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
                    {canEditEntry && g.entries.every(canModify) && (
                      <button
                        className="icon-btn sm"
                        title={g.entries.length > 1 ? 'Open to edit one of these entries' : 'Edit this work record'}
                        aria-label={`Edit ${personName(first)} ${jobName(g.jobId)}`}
                        disabled={busy === g.key}
                        onClick={() =>
                          g.entries.length === 1 ? setEditEntry(g.entries[0]) : setDetailKey(g.key)
                        }
                      >
                        <PencilIcon />
                      </button>
                    )}
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
            {tab === 'open' && canAddEntry && (
              <div className="row-form op-tabbar" style={{ justifyContent: 'flex-end' }}>
                <button type="button" className="btn" onClick={() => setShowAdd(true)}>
                  + Add Job Record
                </button>
              </div>
            )}

            {/* One station picked: the rail already names it, so the block
                header goes and the records stand on their own. */}
            {oneStation
              ? groupRows(stationBlocks[0]?.rows ?? [])
              : stationBlocks.length === 0
                ? <p className="muted">Nothing here for these filters.</p>
                : stationBlocks.map(({ station, rows }) => {
                    const shut = collapsed.has(station.id)
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
                          </button>

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

      {showAdd && (
        <AddRecordModal
          stations={stations}
          jobs={jobs}
          people={people}
          bestRate={bestRate}
          amountFor={amountFor}
          lockedPeriods={lockedPeriods}
          presetStationId={scope !== 'all' ? scope : null}
          myId={profile?.id ?? null}
          onClose={() => setShowAdd(false)}
          onSaved={async () => {
            setShowAdd(false)
            setNotice('Job record saved — waiting for verification.')
            await loadEntries()
          }}
        />
      )}

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
          evidenceOf={evidenceOf}
          actionFor={actionFor}
          busy={busy}
          badge={badge}
          onAct={act}
          onActMany={actMany}
          canEditFor={(e) => canEditEntry && canModify(e)}
          onEdit={(e) => {
            setDetailKey(null)
            setEditEntry(e)
          }}
        />
      )}

      {editEntry && (
        <AddRecordModal
          stations={stations}
          jobs={jobs}
          people={people}
          bestRate={bestRate}
          amountFor={amountFor}
          lockedPeriods={lockedPeriods}
          presetStationId={editEntry.station_id}
          myId={profile?.id ?? null}
          entry={editEntry}
          onClose={() => setEditEntry(null)}
          onSaved={() => {
            setEditEntry(null)
            setNotice('Entry updated — it goes through verify and approve again.')
            loadEntries()
          }}
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
  evidenceOf,
  actionFor,
  busy,
  badge,
  onAct,
  onActMany,
  canEditFor,
  onEdit,
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
  evidenceOf: (entryId: string) => { url: string; takenAt: string | null } | null
  actionFor: (e: ProductionEntry) => 'verified' | 'approved' | null
  busy: string | null
  badge: (s: string) => JSX.Element
  onAct: (e: ProductionEntry, next: 'verified' | 'approved' | 'rejected') => void
  onActMany: (list: ProductionEntry[], next: 'verified' | 'approved') => void
  canEditFor: (e: ProductionEntry) => boolean
  onEdit: (e: ProductionEntry) => void
}) {
  const overlay = useOverlayClose(onClose)
  // A clicked photo floats over the record instead of leaving for a tab,
  // captioned with when it was taken and by whom.
  const [photoView, setPhotoView] = useState<{ url: string; takenAt: string | null } | null>(null)
  // Which row's "i" is open, answering who verified and who approved it.
  const [infoFor, setInfoFor] = useState<string | null>(null)

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
      <div className="modal modal-xwide">
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
          <div className="op-job-title">{job?.name ?? 'Work'}</div>
          <div className="tag-section-title">
            Photo evidence (from time {hh(DAY_START_HOUR)} → {hh(DAY_START_HOUR)})
          </div>
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
                  <th className="op-info-col" aria-label="Sign-off info" />
                  <th className="right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {slots.map((sl) =>
                  sl.entries.length === 0 ? (
                    <tr className="op-tl-empty" key={sl.start}>
                      <td className="op-tl-hour">{hh(DAY_START_HOUR + sl.start)} – {hh(DAY_START_HOUR + sl.end)}</td>
                      <td colSpan={7} className="op-tl-none">—</td>
                    </tr>
                  ) : (
                    sl.entries.map((e, i) => {
                      const step = actionFor(e)
                      const photo = evidenceOf(e.id)
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
                              <button
                                type="button"
                                className="op-photo-link"
                                title="View the photo"
                                aria-label="View the photo"
                                onClick={() => setPhotoView({ ...photo, takenAt: photo.takenAt ?? e.created_at })}
                              >
                                📷
                              </button>
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
                          <td className="op-info-col">
                            <button
                              type="button"
                              className="op-info"
                              aria-expanded={infoFor === e.id}
                              aria-label="Who verified and approved this row"
                              onClick={() => setInfoFor(infoFor === e.id ? null : e.id)}
                            >
                              i
                            </button>
                            {infoFor === e.id && (
                              <div className="op-info-pop" role="dialog">
                                <div><span className="muted">Verified by</span> {shortWho(e.verified_by) ?? '—'}</div>
                                <div><span className="muted">Approved by</span> {shortWho(e.approved_by) ?? '—'}</div>
                              </div>
                            )}
                          </td>
                          <td className="right nowrap op-tl-actions">
                            {canEditFor(e) && (
                              <button
                                className="linkbtn"
                                disabled={busy === e.id}
                                title="Edit this entry"
                                onClick={() => onEdit(e)}
                              >
                                ✎ Edit
                              </button>
                            )}
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
                {(toVerify.length > 0 || toApprove.length > 0) && (
                  <tr className="op-tl-allrow">
                    <td colSpan={7} />
                    <td className="right nowrap op-tl-actions">
                      {toVerify.length > 0 && (
                        <button className="linkbtn" disabled={busy === 'bulk'} onClick={() => onActMany(toVerify, 'verified')}>
                          ✓ Verify All
                        </button>
                      )}
                      {toApprove.length > 0 && (
                        <button className="linkbtn" disabled={busy === 'bulk'} onClick={() => onActMany(toApprove, 'approved')}>
                          ✓ Approve All
                        </button>
                      )}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Contract info — what the contract pays, count by count. */}
        <div className="tag-section op-rec-sec">
          <div className="tag-section-title">Contract info</div>
          {!rate ? (
            <p className="muted small" style={{ margin: 0 }}>No effective piece rate found for this job.</p>
          ) : (
            <div className="board-scroll">
              <table className="table op-contract-table">
                <thead>
                  <tr>
                    <th>Piece rate criteria</th>
                    <th className="right">Qty count</th>
                    <th className="right">Piece rate (RM)</th>
                    <th className="right">Total (RM)</th>
                  </tr>
                </thead>
                <tbody>
                  {rate.tier2_rate == null ? (
                    <tr>
                      <td>Flat rate · {job?.unit ?? 'unit'}</td>
                      <td className="right">{groupQty}</td>
                      <td className="right">{Number(rate.rate).toFixed(2)}</td>
                      <td className="right">{(groupQty * Number(rate.rate)).toFixed(2)}</td>
                    </tr>
                  ) : (
                    <>
                      <tr>
                        <td>1st–4th unit of the hour</td>
                        <td className="right">{t1Units}</td>
                        <td className="right">{Number(rate.rate).toFixed(2)}</td>
                        <td className="right">{(t1Units * Number(rate.rate)).toFixed(2)}</td>
                      </tr>
                      <tr>
                        <td>5th unit onward</td>
                        <td className="right">{t2Units}</td>
                        <td className="right">{Number(rate.tier2_rate).toFixed(2)}</td>
                        <td className="right">{(t2Units * Number(rate.tier2_rate)).toFixed(2)}</td>
                      </tr>
                    </>
                  )}
                  <tr className="total-row">
                    <td colSpan={3}>Total amount</td>
                    <td className="right">{groupAmount.toFixed(2)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </div>

      </div>

      {photoView && (
        <div className="op-lightbox" onClick={() => setPhotoView(null)}>
          <button
            type="button"
            className="modal-close"
            onClick={() => setPhotoView(null)}
            aria-label="Close the photo"
          >
            ×
          </button>
          <figure className="op-lightbox-frame" onClick={(e) => e.stopPropagation()}>
            {photoView.url.toLowerCase().includes('.pdf') ? (
              <iframe src={photoView.url} title="Attached document" />
            ) : (
              <img src={photoView.url} alt="Photo evidence" />
            )}
            <figcaption className="op-lightbox-caption">
              <span>
                📷 Taken{' '}
                {photoView.takenAt
                  ? `${fmtDate(photoView.takenAt.slice(0, 10))} · ${new Date(photoView.takenAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })}`
                  : '—'}
              </span>
              <span>by <strong>{workerName}</strong></span>
            </figcaption>
          </figure>
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Add Job Record — the pop-out. Work date, station, work description,  */
/* who did it and how much; the calculation reads back from the piece   */
/* rate masterlist; an optional photo or PDF rides along on save.       */
/* ------------------------------------------------------------------ */

function AddRecordModal({
  stations,
  jobs,
  people,
  bestRate,
  amountFor,
  lockedPeriods,
  presetStationId,
  myId,
  entry = null,
  onClose,
  onSaved,
}: {
  stations: Station[]
  jobs: Job[]
  people: Profile[]
  bestRate: Map<string, PieceRate>
  amountFor: (jobId: string, qty: number) => number
  lockedPeriods: { period_start: string; period_end: string }[]
  presetStationId: string | null
  myId: string | null
  /** An existing entry turns the window into its editor: same fields,
   *  prefilled, and saving resubmits it through verify and approve. */
  entry?: ProductionEntry | null
  onClose: () => void
  onSaved: () => void
}) {
  const overlay = useOverlayClose(onClose)
  const [workDate, setWorkDate] = useState(entry?.work_date ?? todayISO())
  const [stationId, setStationId] = useState(entry?.station_id ?? presetStationId ?? '')
  const [jobId, setJobId] = useState(entry?.job_id ?? '')
  const [employeeId, setEmployeeId] = useState(entry?.user_id ?? '')
  const [quantity, setQuantity] = useState(entry ? String(Number(entry.quantity)) : '')
  const [photo, setPhoto] = useState<File | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  // Only approved, active contracts of the chosen station are offered.
  const stationJobs = jobs.filter(
    (j) => j.station_id === stationId && j.active && j.approval_status === 'approved',
  )
  const job = jobs.find((j) => j.id === jobId) ?? null
  const rate = jobId ? bestRate.get(jobId) ?? null : null

  // People tagged to this station come first in spirit: tagged-elsewhere
  // accounts are excluded, untagged ones may work anywhere.
  const stationPeople = people.filter((u) => {
    const tags = u.station_ids && u.station_ids.length > 0 ? u.station_ids : u.station_id ? [u.station_id] : []
    return tags.length === 0 || (stationId ? tags.includes(stationId) : false)
  })

  const qty = Number(quantity) || 0
  const amount = jobId ? amountFor(jobId, qty) : 0
  const t1 = Math.min(qty, TIER1_UNIT_CAP)
  const t2 = Math.max(0, qty - TIER1_UNIT_CAP)

  function pickPhoto(ev: ChangeEvent<HTMLInputElement>) {
    const file = ev.target.files?.[0]
    ev.target.value = ''
    if (!file) return
    if (file.size > MAX_ATTACHMENT_BYTES) return setError('Attachment must be 5MB or smaller.')
    setError(null)
    setPhoto(file)
  }

  async function save(ev: FormEvent) {
    ev.preventDefault()
    setError(null)
    if (!stationId) return setError('Pick a station.')
    if (!jobId) return setError('Pick a work description.')
    if (!employeeId) return setError('Choose a name.')
    if (quantity.trim() === '' || !Number.isFinite(qty) || qty <= 0) {
      return setError('Work done must be a positive number.')
    }
    if (workDate > todayISO()) return setError('Work date cannot be in the future.')
    if (lockedPeriods.some((pd) => pd.period_start <= workDate && workDate <= pd.period_end)) {
      return setError('That work date falls in a finalized payroll period and is locked.')
    }
    if (qty > 200 && !window.confirm(`Work done ${qty} looks unusually large. Save anyway?`)) return
    setSaving(true)
    try {
      let data: { id: string } | null = null
      if (entry) {
        // A fixed entry goes back through the queue — otherwise editing
        // an approved number would smuggle it past verify and approve.
        const { data: rows, error: updErr } = await supabase
          .from('operation_entries')
          .update({
            work_date: workDate,
            station_id: stationId,
            job_id: jobId,
            user_id: employeeId,
            quantity: qty,
            approval_status: 'pending',
            verified_by: null,
            verified_at: null,
            approved_by: null,
            approved_at: null,
          } as never)
          .eq('id', entry.id)
          .select('id')
        if (updErr) throw new Error(updErr.message)
        // Row security refuses silently: success with zero rows.
        if (!rows || rows.length === 0) {
          throw new Error('The database would not let you edit this entry.')
        }
        data = rows[0]
      } else {
        const { data: made, error: insErr } = await supabase
          .from('operation_entries')
          .insert({
            work_date: workDate,
            station_id: stationId,
            job_id: jobId,
            user_id: employeeId,
            quantity: qty,
            created_by: myId,
            // Desktop entries join the same verify -> approve queue as
            // mobile ones.
            approval_status: 'pending',
          })
          .select()
          .single()
        if (insErr) throw new Error(insErr.message)
        data = made
      }

      if (photo && data) {
        const isImage = photo.type.startsWith('image/')
        const body = isImage ? await compressImage(photo) : photo
        const stamp = new Date().toISOString().replace(/[:.]/g, '-')
        const ext = photo.type === 'application/pdf' ? 'pdf' : 'jpg'
        const path = `${stationId}/entry-${stamp}.${ext}`
        const { error: upErr } = await supabase.storage
          .from('records')
          .upload(path, body, { contentType: photo.type || 'image/jpeg' })
        if (upErr) throw new Error(`Record saved, but the attachment failed to upload: ${upErr.message}`)
        const { error: prErr } = await supabase
          .from('operation_photos')
          .insert({ station_id: stationId, photo_path: path, entry_id: data.id })
        if (prErr) throw new Error(`Record saved, but the attachment couldn't be linked: ${prErr.message}`)
      }
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="modal-overlay" {...overlay}>
      <form className="modal modal-view" onSubmit={save}>
        <div className="row-form spread">
          <h2>{entry ? 'Edit Job Record' : 'Add Job Record'}</h2>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        {error && <div className="error">{error}</div>}

        <div className="row-form">
          <label className="field inline">
            <span>Work Date</span>
            <input type="date" value={workDate} max={todayISO()} onChange={(e) => setWorkDate(e.target.value)} required />
          </label>
          <div className="field inline grow">
            <span>Station</span>
            <Select
              block
              value={stationId}
              onChange={(v) => { setStationId(v); setJobId(''); setEmployeeId('') }}
              options={stations.map((st) => ({ value: st.id, label: st.name }))}
              placeholder="Pick a station…"
              ariaLabel="Station"
            />
          </div>
        </div>

        <div className="field">
          <span>Work Description</span>
          <Select
            block
            value={jobId}
            onChange={setJobId}
            options={stationJobs.map((j) => ({ value: j.id, label: j.name }))}
            placeholder={stationId ? 'Pick the work…' : 'Pick a station first…'}
            disabled={!stationId}
            ariaLabel="Work description"
          />
        </div>

        <div className="row-form">
          <div className="field inline grow">
            <span>Name</span>
            <Select
              block
              value={employeeId}
              onChange={setEmployeeId}
              options={stationPeople.map((u) => ({
                value: u.id,
                label: `${profileName(u)}${u.employee_code ? ` (${u.employee_code})` : ''}`,
              }))}
              placeholder={stationId ? 'Choose who did it…' : 'Pick a station first…'}
              disabled={!stationId}
              ariaLabel="Name"
            />
          </div>
          <label className="field inline">
            <span>Work Done {job?.unit ? `(${job.unit})` : ''}</span>
            <input
              inputMode="decimal"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              required
            />
          </label>
        </div>

        {/* The calculation, straight off the piece rate masterlist. */}
        <div className="tag-section">
          <div className="tag-section-title">The calculation</div>
          {!jobId ? (
            <p className="muted small" style={{ margin: 0 }}>Pick the work to load its rate.</p>
          ) : !rate ? (
            <p className="muted small" style={{ margin: 0 }}>No effective piece rate found for this work.</p>
          ) : (
            <div className="board-scroll">
              <table className="table op-contract-table">
                <thead>
                  <tr>
                    <th>Piece rate criteria</th>
                    <th className="right">Qty count</th>
                    <th className="right">Piece rate (RM)</th>
                    <th className="right">Total (RM)</th>
                  </tr>
                </thead>
                <tbody>
                  {rate.tier2_rate == null ? (
                    <tr>
                      <td>Flat rate · {job?.unit ?? 'unit'}</td>
                      <td className="right">{qty}</td>
                      <td className="right">{Number(rate.rate).toFixed(2)}</td>
                      <td className="right">{(qty * Number(rate.rate)).toFixed(2)}</td>
                    </tr>
                  ) : (
                    <>
                      <tr>
                        <td>1st–4th unit of the hour</td>
                        <td className="right">{t1}</td>
                        <td className="right">{Number(rate.rate).toFixed(2)}</td>
                        <td className="right">{(t1 * Number(rate.rate)).toFixed(2)}</td>
                      </tr>
                      <tr>
                        <td>5th unit onward</td>
                        <td className="right">{t2}</td>
                        <td className="right">{Number(rate.tier2_rate).toFixed(2)}</td>
                        <td className="right">{(t2 * Number(rate.tier2_rate)).toFixed(2)}</td>
                      </tr>
                    </>
                  )}
                  <tr className="total-row">
                    <td colSpan={3}>Total amount</td>
                    <td className="right">{amount.toFixed(2)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
          {rate && <p className="small muted" style={{ margin: 0 }}>🔒 Rate effective from {rate.effective_from}</p>}
        </div>

        <div className="tag-section">
          <div className="tag-section-title">Attachment (optional)</div>
          {photo ? (
            <div className="row-form spread">
              <span className="small">{photo.name}</span>
              <button type="button" className="linkbtn danger" onClick={() => setPhoto(null)}>Remove</button>
            </div>
          ) : (
            <div className="row-form">
              <label className="btn ghost">
                📷 Take Photo
                <input type="file" accept="image/*" capture="environment" onChange={pickPhoto} hidden />
              </label>
              <label className="btn ghost">
                ⬆ Upload File
                <input type="file" accept="image/*,.pdf" onChange={pickPhoto} hidden />
              </label>
            </div>
          )}
          <p className="small muted" style={{ margin: 0 }}>JPG, PNG, PDF (max 5MB).</p>
        </div>

        <div className="row-form" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn" type="submit" disabled={saving}>
            {saving ? 'Saving…' : '💾 Save Record'}
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
