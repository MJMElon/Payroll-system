// ---------------------------------------------------------------------------
// PIECE RATE MODULE — fully self-contained in this one file.
//
// A piece-rate contract is the mix-and-match of STATION × TAG (grade) × WORK
// DESCRIPTION, each with its own unit and rate. Every new contract — admin
// submissions included — waits in the Approvals queue until a 'verify'
// capability holder checks it, then an 'approve' capability holder (or an
// admin, who can do either step) signs off. The page has three sidebar
// sections: Pending Piece Rate Approval (submissions not yet approved),
// Piece Rate Masterlist (approved contracts, pivoted so each tag/position
// is its own column for a station + work description), and Piece Rate History
// (past rate changes for approved contracts, derived from piece_rates rows
// — no separate history table). Everyone can open the listing, but
// non-managers only see rates for their own grade tier and below (tier =
// the tag's order in Settings).
// Tables used: stations, grades, jobs, piece_rates (see supabase/setup.sql).
// ---------------------------------------------------------------------------
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import Select, { MultiSelect, type SelectOption } from '../components/Select'
import { useAuth } from '../context/AuthContext'
import { useOverlayClose } from '../lib/useOverlayClose'
import { useWideShell } from '../lib/useWideShell'
import { effectiveCapabilities, isEntitled, tagClass } from '../lib/tags'
import {
  profileName,
  supabase,
  todayISO,
  type Grade,
  type Job,
  type PieceRate as Rate,
  type Station,
} from '../lib/supabase'

const UNIT_SUGGESTIONS = ['/cage tipped', '/job done', '/tonne', '/bunch', '/trip', '/hour']

// Picking this in the Unit dropdown swaps that cell for a free-text box, so
// the suggestions stay a short list without shutting anything out.
const UNIT_OTHER = '__other__'

// Also picked in the Unit dropdown. Not a unit but a pay shape: the rate
// is per hour and comes in two steps, so the two hourly columns open.
const TIERED = '__tiered__'

// Bucket key for jobs with no tag, so the pivoted tables still give them a column.
const NO_TAG = '__none__'

/** Dropdown rows for the station and tier-tag pickers, shared by the create
 *  window, the edit window and the listing filters. */
function stationOptions(stations: Station[]): SelectOption[] {
  return stations.map((s) => ({ value: s.id, label: s.name }))
}

/**
 * The tier tags a piece rate may be written for.
 *
 * Set per tag in Settings → Tags management → Entitled Function. A tag
 * nobody has touched falls back to the old rule — Station Head and every
 * tier below it, since the tiers above run the whole mill rather than a
 * piece of work — so this list only changes once somebody unticks a box.
 *
 * `keep` is the tag a row already carries: an existing contract keeps
 * showing its own tier even after that tier stops being entitled, so
 * editing something else about the row cannot silently re-tag it.
 */
function tierTagOptions(grades: Grade[], keep?: string | null): SelectOption[] {
  return tagOptions(
    grades.filter((g) => g.id === keep || isEntitled(g, 'piece-rate', grades)),
  )
}

function tagOptions(grades: Grade[]): SelectOption[] {
  return grades.map((g) => ({
    value: g.id,
    label: g.name,
    node: <span className={tagClass(g.color)}>{g.name}</span>,
  }))
}

export default function PieceRate() {
  const { profile } = useAuth()
  const [stations, setStations] = useState<Station[]>([])
  const [grades, setGrades] = useState<Grade[]>([])
  const [jobs, setJobs] = useState<Job[]>([])
  const [rates, setRates] = useState<Rate[]>([])
  const [myTier, setMyTier] = useState<number | null>(null)
  const canManage = profile?.role === 'admin' || profile?.role === 'manager'
  const isAdmin = profile?.role === 'admin'
  const [modal, setModal] = useState<'closed' | 'create'>('closed')
  // The masterlist is what the module is FOR, so it leads and opens first;
  // approvals and history follow it.
  const [tab, setTab] = useState<'master' | 'approval' | 'history'>('master')
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  // The masterlist pivots a column per tier tag, so this page wants the
  // real window rather than the shared reading-width cap.
  const wideStyle = useWideShell(48, 1560)

  async function load() {
    const [s, g, j, r] = await Promise.all([
      supabase.from('stations').select('id, name, sort_order').order('sort_order'),
      supabase.from('grades').select('*').order('sort_order'),
      // select('*') so the optional record_job flag rides along once its
      // column migration has run — and is simply absent until then.
      supabase.from('jobs').select('*').order('name'),
      supabase
        .from('piece_rates')
        .select('id, job_id, rate, effective_from, tier2_rate')
        .order('effective_from', { ascending: false }),
    ])
    const err = s.error || g.error || j.error || r.error
    if (err) setError(err.message)
    setStations(s.data ?? [])
    setGrades(g.data ?? [])
    setJobs(j.data ?? [])
    setRates(r.data ?? [])
    setLoading(false)
  }

  useEffect(() => {
    load()
  }, [])

  // Piece-rate rights follow the tag's standardized capabilities (Settings
  // → Tags management): rate-create / rate-verify / rate-approve. Tier 1 is
  // the super admin and has all of them; admins can do everything too.
  const myCaps = effectiveCapabilities(
    profile?.grade_id ? grades.find((g) => g.id === profile.grade_id) : null,
  )
  const canCreate = canManage || myCaps.includes('rate-create')
  const canEditRate = canManage || myCaps.includes('rate-edit')
  const canDeleteRate = canManage || myCaps.includes('rate-delete')
  const canVerify = isAdmin || myCaps.includes('rate-verify')
  const canFinal = isAdmin || myCaps.includes('rate-approve')
  const isApprover = isAdmin || canVerify || canFinal

  // Tier comes from the signed-in account's grade tag.
  useEffect(() => {
    if (profile?.grade_id) {
      const g = grades.find((x) => x.id === profile.grade_id)
      setMyTier(g ? g.sort_order : null)
    } else {
      setMyTier(null)
    }
  }, [profile, grades])

  const currentRate = useMemo(() => {
    const m = new Map<string, Rate>()
    const today = todayISO()
    for (const r of rates) {
      if (r.effective_from <= today && !m.has(r.job_id)) m.set(r.job_id, r)
    }
    return m
  }, [rates])

  // Unlike currentRate, this includes rates scheduled for a future
  // effective date — so a just-submitted rate still shows up while
  // it's waiting for its effective date to arrive.
  const latestRate = useMemo(() => {
    const m = new Map<string, Rate>()
    for (const r of rates) {
      if (!m.has(r.job_id)) m.set(r.job_id, r)
    }
    return m
  }, [rates])

  if (loading) return <p className="muted">Loading…</p>

  const openApprovals = jobs.filter(
    (j) => j.approval_status === 'pending' || j.approval_status === 'verified',
  )
  const notYetApproved = jobs.filter((j) => j.approval_status !== 'approved')

  // Managers/admins see every contract. Others are scoped two ways:
  // 1. Station — a user with station tags only sees those stations.
  // 2. Tier — tier 1 is highest; a user sees their tier and every tier
  //    below it (larger tier numbers). Untagged rates are visible to all.
  const tierOf = (gradeId: string | null) =>
    gradeId ? grades.find((g) => g.id === gradeId)?.sort_order ?? 0 : null
  const myStations =
    profile?.station_ids && profile.station_ids.length > 0
      ? profile.station_ids
      : profile?.station_id
        ? [profile.station_id]
        : []
  const visibleTo = (j: Job) => {
    if (canManage) return true
    if (myStations.length > 0 && !myStations.includes(j.station_id)) return false
    const t = tierOf(j.grade_id)
    if (t === null) return true
    return myTier !== null && t >= myTier
  }

  return (
    <div className="stack" style={wideStyle}>
      <header className="module-bar">
        <Link to="/" className="btn ghost backlink-btn">← Back to main page</Link>
      </header>
      <h1 className="module-banner">Piece Rate Module</h1>

      {error && <div className="error">{error}</div>}
      {notice && <div className="notice">{notice}</div>}

      <div className="sidebar-layout">
        <nav className="sidebar-nav">
          <button
            type="button"
            className={`sidebar-link ${tab === 'master' ? 'active' : ''}`}
            onClick={() => setTab('master')}
          >
            <IconMaster />
            <span>Piece Rate Masterlist</span>
          </button>
          <button
            type="button"
            className={`sidebar-link ${tab === 'approval' ? 'active' : ''}`}
            onClick={() => setTab('approval')}
          >
            <IconApproval />
            <span>Pending Approval</span>
            {openApprovals.length > 0 && (
              <span className="count-badge static">{openApprovals.length}</span>
            )}
          </button>
          <button
            type="button"
            className={`sidebar-link ${tab === 'history' ? 'active' : ''}`}
            onClick={() => setTab('history')}
          >
            <IconHistory />
            <span>Piece Rate History</span>
          </button>
        </nav>

        <div className="sidebar-content stack">
          {/* The two module actions belong to the module, not to one tab —
              the masterlist is the front page now, so "create" has to be
              reachable from it as well as from the approvals tracker. */}
          {tab !== 'history' && canCreate && (
            <div className="row-form" style={{ justifyContent: 'flex-end' }}>
              <button className="btn" onClick={() => setModal('create')}>+ Create new piece rate</button>
            </div>
          )}

          {tab === 'approval' ? (
            <>
              {canCreate || isApprover ? (
                <SubmissionsList
                  stations={stations}
                  grades={grades}
                  jobs={notYetApproved.filter(visibleTo)}
                  currentRate={latestRate}
                  pendingCount={openApprovals.length}
                  canResubmit={canManage || canCreate || isApprover}
                  canVerify={canVerify}
                  canFinal={canFinal}
                  canDelete={canDeleteRate}
                  myEmail={profile?.email ?? 'unknown'}
                  onChanged={load}
                  onError={setError}
                />
              ) : (
                <p className="muted">You don't have access to submit or review piece rates.</p>
              )}
            </>
          ) : tab === 'master' ? (
            <RatesList
              stations={stations}
              grades={grades}
              jobs={jobs.filter((j) => j.approval_status === 'approved' && visibleTo(j))}
              currentRate={currentRate}
              canManage={canEditRate}
              canDelete={canDeleteRate}
              onChanged={load}
              onError={setError}
            />
          ) : (
            <HistoryList
              stations={stations}
              grades={grades}
              jobs={jobs.filter(visibleTo)}
              rates={rates}
              currentRate={currentRate}
              canManage={canEditRate}
              canDelete={canDeleteRate}
              onChanged={load}
              onError={setError}
            />
          )}
        </div>
      </div>

      {modal === 'create' && (
        <CreateRatesModal
          stations={stations}
          grades={grades}
          onClose={() => setModal('closed')}
          onReload={load}
          onSaved={(count) => {
            setModal('closed')
            setNotice(
              `${count} piece rate${count === 1 ? '' : 's'} submitted — waiting for approval.`,
            )
            load()
          }}
        />
      )}


    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Sidebar icons                                                      */
/* ------------------------------------------------------------------ */

function IconPencil() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 20h4L20 8a2.8 2.8 0 0 0-4-4L4 16v4Z" />
      <path d="m14.5 5.5 4 4" />
    </svg>
  )
}

function IconArchive() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 4h18v4H3z" />
      <path d="M5 8v12h14V8" />
      <path d="M10 12h4" />
    </svg>
  )
}

function IconClock() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5.5l3.5 2" />
    </svg>
  )
}

function IconEye() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  )
}

function IconCheck() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="m4 12.5 5 5L20 6.5" />
    </svg>
  )
}

function IconDoubleCheck() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="m2 13 4 4L14 8" />
      <path d="m11 13 4 4L23 8" />
    </svg>
  )
}

function IconCross() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 6l12 12" />
      <path d="M18 6 6 18" />
    </svg>
  )
}

function IconRedo() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12a9 9 0 1 1-2.6-6.4" />
      <path d="M21 3v6h-6" />
    </svg>
  )
}

function IconApproval() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="6" y="3" width="12" height="18" rx="2" />
      <path d="M9 3h6" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  )
}

function IconMaster() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 10h18" />
      <path d="M9 4v16" />
    </svg>
  )
}

function IconHistory() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 3" />
    </svg>
  )
}

/* ------------------------------------------------------------------ */
/* Grouping helpers — shared by Piece Rate Masterlist and History, which */
/* both pivot rows by Station + Work description so each tag/position */
/* gets its own column instead of one row per contract.               */
/* ------------------------------------------------------------------ */

interface JobGroup {
  station_id: string
  name: string
  jobs: Job[]
}

function groupKey(g: { station_id: string; name: string }) {
  return `${g.station_id}::${g.name}`
}

function groupJobs(jobs: Job[]): JobGroup[] {
  const m = new Map<string, JobGroup>()
  for (const j of jobs) {
    const key = groupKey(j)
    let g = m.get(key)
    if (!g) {
      g = { station_id: j.station_id, name: j.name, jobs: [] }
      m.set(key, g)
    }
    g.jobs.push(j)
  }
  return [...m.values()]
}

// The Master/History pivot only ever shows these three positions — other
// tags (e.g. Management, Manager, Engineer) are left out. They are ordered
// by TIER, upper first, so the columns read down the ranks the way the tier
// list does rather than in whatever order this array happens to be in.
const MASTER_TAG_NAMES = ['Station Head', 'Assistant Station Head', 'Operator']

/** One pivoted column per tag in MASTER_TAG_NAMES that exists in `grades`,
 *  plus a column for any OTHER tag actually used by the listed jobs (custom
 *  tags, Engineer, …), plus "All positions" when a job carries no tag. */
function tagColumns(grades: Grade[], jobs?: Job[]): { key: string; label: string }[] {
  const byName = new Map(grades.map((g) => [g.name, g]))
  const cols = MASTER_TAG_NAMES
    .map((name) => byName.get(name))
    .filter((g): g is Grade => Boolean(g))
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((g) => ({ key: g.id, label: g.name }))
  if (jobs) {
    const covered = new Set(cols.map((c) => c.key))
    const extras = [...new Set(jobs.map((j) => j.grade_id).filter((id): id is string => Boolean(id)))]
      .filter((id) => !covered.has(id))
      .map((id) => grades.find((g) => g.id === id))
      .filter((g): g is Grade => Boolean(g))
      .sort((a, b) => a.sort_order - b.sort_order)
    for (const g of extras) cols.push({ key: g.id, label: g.name })
    if (jobs.some((j) => j.grade_id === null)) cols.push({ key: NO_TAG, label: 'All positions' })
  }
  return cols
}

function addDays(dateStr: string, delta: number) {
  const d = new Date(`${dateStr}T00:00:00`)
  d.setDate(d.getDate() + delta)
  return d.toISOString().slice(0, 10)
}

/** A tiered rate shows both tiers stacked with a small tag; a flat rate
 *  shows its single number, same as before. Used everywhere a rate cell
 *  is rendered (Masterlist, Manage popout, History). */
function RateCell({ rate }: { rate: Rate | undefined }) {
  if (!rate) return <span className="muted">—</span>
  if (rate.tier2_rate == null) return <strong>{Number(rate.rate).toFixed(2)}</strong>
  return (
    <span className="rate-tiered">
      <span className="rate-tier-line"><span className="rate-tier-lbl">1st–4th</span>{Number(rate.rate).toFixed(2)}</span>
      <span className="rate-tier-line"><span className="rate-tier-lbl">5th+</span>{Number(rate.tier2_rate).toFixed(2)}</span>
      <span className="tagbadge tag-blue rate-tiered-pill">Tiered / hour</span>
    </span>
  )
}

/* ------------------------------------------------------------------ */
/* Pending Approval tracker — every piece rate not yet approved. The   */
/* two-step flow lives on the rows themselves: a 'verify' holder       */
/* checks a proposal, then an 'approve' holder makes it final. View    */
/* opens the full details, and that is where a proposal is deleted —   */
/* with a remark saying why, kept in the audit log.                    */
/* ------------------------------------------------------------------ */

const STATUS_LABEL: Record<Job['approval_status'], string> = {
  pending: 'Waiting verification',
  verified: 'Waiting approval',
  approved: 'Approved',
  rejected: 'Rejected',
}

const STATUS_CLASS: Record<Job['approval_status'], string> = {
  pending: 'badge warn',
  verified: 'badge warn',
  approved: 'badge ok',
  rejected: 'badge new',
}

function SubmissionsList({
  stations,
  grades,
  jobs,
  currentRate,
  pendingCount,
  canResubmit,
  canVerify,
  canFinal,
  canDelete,
  myEmail,
  onChanged,
  onError,
}: {
  stations: Station[]
  grades: Grade[]
  jobs: Job[]
  currentRate: Map<string, Rate>
  pendingCount: number
  canResubmit: boolean
  canVerify: boolean
  canFinal: boolean
  canDelete: boolean
  myEmail: string
  onChanged: () => void
  onError: (m: string | null) => void
}) {
  const [stationFilter, setStationFilter] = useState('')
  const [viewing, setViewing] = useState<Job | null>(null)
  // The double-check window: which proposal, and what the click meant.
  const [confirm, setConfirm] = useState<{ job: Job; mode: 'verify' | 'approve' | 'reject' } | null>(null)

  const stationName = (id: string) => stations.find((s) => s.id === id)?.name ?? '?'
  const gradeName = (id: string | null) => grades.find((g) => g.id === id)?.name ?? null

  /**
   * Write the new approval state — and check something actually moved.
   *
   * Postgres does not treat "row-level security says no" as an error: the
   * update matches zero rows and comes back clean. Without the `select` we
   * would reload, find the row still pending, and look like the database
   * had lost the approval. Say so instead.
   */
  async function act(job: Job, fields: Partial<Job> & { approval_status: Job['approval_status'] }) {
    const { data, error } = await supabase.from('jobs').update(fields).eq('id', job.id).select('id')
    if (error) return onError(error.message)
    if (!data || data.length === 0) {
      return onError(
        'Nothing was saved — the database refused the change for your account. ' +
          'The tier tag needs Verify or Approve ticked under Piece rate setting ' +
          '(Settings → Tags management).',
      )
    }
    onChanged()
  }

  const verify = (j: Job) =>
    act(j, { approval_status: 'verified', verified_by: myEmail, verified_at: new Date().toISOString() } as never)
  const approve = (j: Job) =>
    act(j, { approval_status: 'approved', approved_by: myEmail, approved_at: new Date().toISOString() } as never)
  const reject = (j: Job) =>
    act(j, {
      approval_status: 'rejected',
      verified_by: null,
      verified_at: null,
      approved_by: null,
      approved_at: null,
    } as never)

  // A rejected proposal goes back into the approval queue from the start.
  const resubmit = (j: Job) =>
    act(j, {
      approval_status: 'pending',
      verified_by: null,
      verified_at: null,
      approved_by: null,
      approved_at: null,
    } as never)

  const list = jobs
    .filter((j) => (stationFilter ? j.station_id === stationFilter : true))
    .sort(
      (a, b) =>
        stationName(a.station_id).localeCompare(stationName(b.station_id)) ||
        a.name.localeCompare(b.name),
    )

  return (
    <div className="card stack">
      <div className="row-form spread">
        <h3>
          Pending Piece Rate Approval
          {pendingCount > 0 && (
            <span className="count-badge static" style={{ marginLeft: '0.5rem' }}>{pendingCount}</span>
          )}
        </h3>
        <Select
          value={stationFilter}
          onChange={setStationFilter}
          options={[{ value: '', label: 'All stations' }, ...stationOptions(stations)]}
          placeholder="All stations"
          ariaLabel="Filter by station"
        />
      </div>
      <div className="table-scroll">
        <table className="table">
          <thead>
            <tr>
              <th>Tier</th>
              <th>Station</th>
              <th>Work description</th>
              <th className="right">Proposed rate</th>
              <th>Unit</th>
              <th>Effective date</th>
              <th>Status</th>
              <th className="right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {list.length === 0 && (
              <tr>
                <td colSpan={8} className="muted">Nothing waiting for approval.</td>
              </tr>
            )}
            {list.map((j) => {
              const rate = currentRate.get(j.id)
              const tag = gradeName(j.grade_id)
              return (
                <tr key={j.id}>
                  <td>{tag ? <span className={tagClass(grades.find((g) => g.id === j.grade_id)?.color)}>{tag}</span> : <span className="muted">—</span>}</td>
                  <td>{stationName(j.station_id)}</td>
                  <td>{j.name}</td>
                  <td className="right">
                    {rate ? <RateCell rate={rate} /> : <span className="badge off">no rate</span>}
                  </td>
                  <td className="muted">{j.unit}</td>
                  <td className="muted">{rate ? rate.effective_from : '—'}</td>
                  <td><span className={STATUS_CLASS[j.approval_status]}>{STATUS_LABEL[j.approval_status]}</span></td>
                  <td className="right">
                    <span className="row-actions">
                      <button
                        type="button"
                        className="icon-btn"
                        title="View details"
                        aria-label={`View ${j.name}`}
                        onClick={() => setViewing(j)}
                      >
                        <IconEye />
                      </button>
                      {j.approval_status === 'pending' && canVerify && (
                        <button
                          type="button"
                          className="icon-btn ok"
                          title="Verify"
                          aria-label={`Verify ${j.name}`}
                          onClick={() => setConfirm({ job: j, mode: 'verify' })}
                        >
                          <IconCheck />
                        </button>
                      )}
                      {/* A tier holding BOTH functions chooses on the row:
                          verify only, or approve in one step. */}
                      {j.approval_status === 'pending' && canFinal && (
                        <button
                          type="button"
                          className="icon-btn ok"
                          title="Approve directly"
                          aria-label={`Approve ${j.name} directly`}
                          onClick={() => setConfirm({ job: j, mode: 'approve' })}
                        >
                          <IconDoubleCheck />
                        </button>
                      )}
                      {j.approval_status === 'verified' && canFinal && (
                        <button
                          type="button"
                          className="icon-btn ok"
                          title="Approve"
                          aria-label={`Approve ${j.name}`}
                          onClick={() => setConfirm({ job: j, mode: 'approve' })}
                        >
                          <IconDoubleCheck />
                        </button>
                      )}
                      {(j.approval_status === 'pending' || j.approval_status === 'verified') &&
                        (canVerify || canFinal) && (
                          <button
                            type="button"
                            className="icon-btn danger"
                            title="Reject"
                            aria-label={`Reject ${j.name}`}
                            onClick={() => setConfirm({ job: j, mode: 'reject' })}
                          >
                            <IconCross />
                          </button>
                        )}
                      {j.approval_status === 'rejected' && canResubmit && (
                        <button
                          type="button"
                          className="icon-btn"
                          title="Resubmit for approval"
                          aria-label={`Resubmit ${j.name}`}
                          onClick={() => resubmit(j)}
                        >
                          <IconRedo />
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
      <p className="muted small">{list.length} submission(s) shown.</p>

      {confirm && (
        <ConfirmActionModal
          job={confirm.job}
          mode={confirm.mode}
          rate={currentRate.get(confirm.job.id)}
          stationName={stationName(confirm.job.station_id)}
          grades={grades}
          canReject={canVerify || canFinal}
          onClose={() => setConfirm(null)}
          onConfirm={() => {
            const { job, mode } = confirm
            setConfirm(null)
            if (mode === 'verify') verify(job)
            else if (mode === 'approve') approve(job)
            else reject(job)
          }}
          onReject={() => {
            const { job } = confirm
            setConfirm(null)
            reject(job)
          }}
        />
      )}

      {viewing && (
        <ViewRateModal
          job={viewing}
          rate={currentRate.get(viewing.id)}
          stationName={stationName(viewing.station_id)}
          grades={grades}
          canDelete={canDelete}
          onClose={() => setViewing(null)}
          onChanged={() => {
            setViewing(null)
            onChanged()
          }}
          onError={onError}
        />
      )}
    </div>
  )
}

/** One read-only cell of a proposal line, its column name repeated inside
 *  for the narrow-screen stacked layout (same trick as the create grid). */
function ProposalCell({ label, wide, children }: { label: string; wide?: boolean; children: ReactNode }) {
  return (
    <div className={`pr-cell ${wide ? 'wide' : ''}`}>
      <span className="pr-cell-label">{label}</span>
      <span className="pr-cell-val">{children}</span>
    </div>
  )
}

/** One proposal as one line under column names — the same shape a line has
 *  in the create window. Shared by the view and confirm windows. */
function ProposalLine({
  job,
  rate,
  stationName,
  grades,
}: {
  job: Job
  rate: Rate | undefined
  stationName: string
  grades: Grade[]
}) {
  const grade = grades.find((g) => g.id === job.grade_id)
  const tiered = rate?.tier2_rate != null
  return (
    <div className={`pr-grid pr-confirm ${tiered ? 'tiered' : ''}`}>
      <div className="pr-grid-head">
        <span>Tier Tag</span>
        <span>Station Tag</span>
        <span>Piece Rate Work Description</span>
        <span>Unit</span>
        <span>Piece Rate (RM)</span>
        {tiered && <span>Tier 1 — 1st to 4th /hr</span>}
        {tiered && <span>Tier 2 — 5th onward /hr</span>}
        <span>Effective date</span>
        <span />
      </div>
      <div className="pr-grid-row">
        <ProposalCell label="Tier Tag">
          {grade ? <span className={tagClass(grade.color)}>{grade.name}</span> : 'All positions'}
        </ProposalCell>
        <ProposalCell label="Station Tag">{stationName}</ProposalCell>
        <ProposalCell label="Piece Rate Work Description" wide>{job.name}</ProposalCell>
        <ProposalCell label="Unit">{tiered ? '/hour (tiered)' : job.unit}</ProposalCell>
        <ProposalCell label="Piece Rate (RM)">
          {tiered ? '—' : rate ? Number(rate.rate).toFixed(2) : '—'}
        </ProposalCell>
        {tiered && (
          <ProposalCell label="Tier 1 — 1st to 4th /hr">{Number(rate!.rate).toFixed(2)}</ProposalCell>
        )}
        {tiered && (
          <ProposalCell label="Tier 2 — 5th onward /hr">{Number(rate!.tier2_rate).toFixed(2)}</ProposalCell>
        )}
        <ProposalCell label="Effective date">{rate ? rate.effective_from : '—'}</ProposalCell>
      </div>
    </div>
  )
}

/** One question before the pen moves: shows the proposal being acted on
 *  and asks for a yes — laid out as one line under column names, the same
 *  way a line reads in the create window. Approving and verifying also
 *  offer Reject here, so a checker who spots a wrong rate turns it away
 *  in the same window. */
function ConfirmActionModal({
  job,
  mode,
  rate,
  stationName,
  grades,
  canReject,
  onClose,
  onConfirm,
  onReject,
}: {
  job: Job
  mode: 'verify' | 'approve' | 'reject'
  rate: Rate | undefined
  stationName: string
  grades: Grade[]
  canReject: boolean
  onClose: () => void
  onConfirm: () => void
  onReject: () => void
}) {
  const tiered = rate?.tier2_rate != null
  const titles = {
    verify: 'Verify this piece rate?',
    approve: 'Approve this piece rate?',
    reject: 'Reject this piece rate?',
  }
  const yes = { verify: 'Yes, verify', approve: 'Yes, approve', reject: 'Yes, reject' }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className={`modal modal-xwide ${tiered ? 'tiered' : ''}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="row-form spread">
          <h2>{titles[mode]}</h2>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        <ProposalLine job={job} rate={rate} stationName={stationName} grades={grades} />

        {mode === 'approve' && job.approval_status === 'pending' && (
          <p className="small muted" style={{ margin: 0 }}>
            This approves it in one step — the separate verify step is skipped.
          </p>
        )}

        <div className="row-form" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          {mode !== 'reject' && canReject && (
            <button type="button" className="btn ghost danger" onClick={onReject}>Reject</button>
          )}
          <button
            type="button"
            className={mode === 'reject' ? 'btn danger' : 'btn'}
            onClick={onConfirm}
          >
            {yes[mode]}
          </button>
        </div>
      </div>
    </div>
  )
}

/** The full details of one proposal, and the place a proposal dies: the
 *  delete asks for a remark saying why, writes it onto the row, then
 *  removes it — so the audit log holds both the reason and the rate. */
function ViewRateModal({
  job,
  rate,
  stationName,
  grades,
  canDelete,
  onClose,
  onChanged,
  onError,
}: {
  job: Job
  rate: Rate | undefined
  stationName: string
  grades: Grade[]
  canDelete: boolean
  onClose: () => void
  onChanged: () => void
  onError: (m: string | null) => void
}) {
  const [remark, setRemark] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const tiered = rate?.tier2_rate != null

  async function destroy() {
    if (!remark.trim()) return onError('Say why this proposed piece rate is being deleted.')
    setDeleting(true)
    onError(null)
    // The remark goes onto the row first: the audit trail logs the update
    // and then the delete, so the reason survives the row itself.
    const { error: remarkErr } = await supabase
      .from('jobs')
      .update({ delete_remark: remark.trim() } as never)
      .eq('id', job.id)
    if (remarkErr) {
      setDeleting(false)
      return onError(remarkErr.message)
    }
    // A delete refused by row security still "succeeds" with zero rows,
    // so ask for the ids back and treat an empty answer as a refusal.
    const { data, error } = await supabase.from('jobs').delete().eq('id', job.id).select('id')
    setDeleting(false)
    if (error) {
      onError(
        error.message.includes('foreign key')
          ? 'This piece rate is already used in production or payroll records, so it cannot be deleted.'
          : error.message,
      )
    } else if (!data || data.length === 0) {
      onError('You are not allowed to delete this piece rate.')
    } else {
      onChanged()
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className={`modal modal-xwide ${tiered ? 'tiered' : ''}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="row-form spread">
          <h2>Piece rate details</h2>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        <ProposalLine job={job} rate={rate} stationName={stationName} grades={grades} />

        <div className="row-form" style={{ gap: '0.8rem', alignItems: 'center' }}>
          <span className={STATUS_CLASS[job.approval_status]}>{STATUS_LABEL[job.approval_status]}</span>
          {job.verified_by && <span className="muted small">Verified by {job.verified_by}</span>}
          {job.approved_by && <span className="muted small">Approved by {job.approved_by}</span>}
        </div>

        {canDelete && !confirming && (
          <div className="row-form" style={{ justifyContent: 'flex-end' }}>
            <button className="btn ghost danger" onClick={() => setConfirming(true)}>
              Delete piece rate
            </button>
          </div>
        )}
        {canDelete && confirming && (
          <div className="stack" style={{ gap: '0.5rem' }}>
            <label className="field">
              <span>Why is this proposed piece rate being deleted?</span>
              <textarea
                rows={2}
                value={remark}
                onChange={(e) => setRemark(e.target.value)}
                autoFocus
              />
            </label>
            <div className="row-form" style={{ justifyContent: 'flex-end' }}>
              <button className="btn ghost" onClick={() => setConfirming(false)}>Keep it</button>
              <button
                className="btn danger"
                disabled={deleting || !remark.trim()}
                onClick={destroy}
              >
                {deleting ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Piece Rate Masterlist — approved contracts, pivoted so each tag/    */
/* position for a Station + Work description is its own column.       */
/* ------------------------------------------------------------------ */

function RatesList({
  stations,
  grades,
  jobs,
  currentRate,
  canManage,
  canDelete,
  onChanged,
  onError,
}: {
  stations: Station[]
  grades: Grade[]
  jobs: Job[]
  currentRate: Map<string, Rate>
  canManage: boolean
  canDelete: boolean
  onChanged: () => void
  onError: (m: string | null) => void
}) {
  const [stationFilter, setStationFilter] = useState('')
  const [search, setSearch] = useState('')
  // The open Manage window is held by KEY, not by a snapshot of the group:
  // deactivating a tier or renaming the work reloads `jobs`, and the window
  // has to show the reloaded rows rather than the ones it opened with.
  const [manageKey, setManageKey] = useState<string | null>(null)

  const stationName = (id: string) => stations.find((s) => s.id === id)?.name ?? '?'

  const filtered = jobs
    // Archived work is not listed here — Piece Rate History keeps it, and
    // that is also where it is restored from.
    .filter((j) => j.active)
    .filter((j) => (stationFilter ? j.station_id === stationFilter : true))
    .filter((j) => (search.trim() ? j.name.toLowerCase().includes(search.trim().toLowerCase()) : true))

  const groups = groupJobs(filtered).sort(
    (a, b) => stationName(a.station_id).localeCompare(stationName(b.station_id)) || a.name.localeCompare(b.name),
  )
  const manageGroup = manageKey
    ? groupJobs(jobs).find((g) => groupKey(g) === manageKey) ?? null
    : null
  const tagCols = tagColumns(grades, filtered)
  const colCount = 3 + tagCols.length + 1 + 1

  // Download the visible masterlist as CSV (opens directly in Excel).
  function exportCsv() {
    const esc = (v: string) => `"${v.replace(/"/g, '""')}"`
    const head = ['Station', 'Work description', 'Unit', ...tagCols.map((c) => `${c.label} (RM)`), 'Effective date']
    const lines = [head.map(esc).join(',')]
    for (const g of groups) {
      const dates = g.jobs
        .map((j) => currentRate.get(j.id)?.effective_from)
        .filter((d): d is string => Boolean(d))
        .sort()
      const cells = [
        stationName(g.station_id),
        g.name,
        g.jobs[0]?.unit ?? '',
        ...tagCols.map((c) => {
          const j = g.jobs.find((x) => (x.grade_id ?? NO_TAG) === c.key)
          const r = j ? currentRate.get(j.id) : undefined
          if (!r) return ''
          return r.tier2_rate != null ? `${r.rate} / ${r.tier2_rate}` : String(r.rate)
        }),
        dates.length ? dates[dates.length - 1] : '',
      ]
      lines.push(cells.map(esc).join(','))
    }
    const blob = new Blob(['\ufeff' + lines.join('\n')], { type: 'text/csv;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `piece-rate-masterlist-${todayISO()}.csv`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  return (
    <div className="card stack">
      <div className="row-form spread">
        <h3>Piece Rate Masterlist</h3>
        <div className="row-form">
          <Select
            value={stationFilter}
            onChange={setStationFilter}
            options={[{ value: '', label: 'All stations' }, ...stationOptions(stations)]}
            placeholder="All stations"
            ariaLabel="Filter by station"
          />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search work description…"
            style={{ minWidth: '220px' }}
          />
          <button className="btn ghost" onClick={exportCsv}>Export CSV</button>
        </div>
      </div>
      <div className="table-scroll">
        <table className="table">
          <thead>
            <tr>
              <th>Station</th>
              <th>Work description</th>
              <th>Unit</th>
              {tagCols.map((c) => (
                <th key={c.key} className="right">{c.label} (RM)</th>
              ))}
              <th>Effective date</th>
              <th className="right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {groups.length === 0 && (
              <tr>
                <td colSpan={colCount} className="muted">
                  No piece rates here — click “Create new piece rate” to add one.
                </td>
              </tr>
            )}
            {groups.map((g) => {
              const dates = g.jobs
                .map((j) => currentRate.get(j.id)?.effective_from)
                .filter((d): d is string => Boolean(d))
                .sort()
              const effectiveDate = dates.length ? dates[dates.length - 1] : null
              return (
                <tr key={groupKey(g)}>
                  <td>{stationName(g.station_id)}</td>
                  <td>{g.name}</td>
                  <td className="muted">{g.jobs[0]?.unit}</td>
                  {tagCols.map((c) => {
                    const j = g.jobs.find((x) => (x.grade_id ?? NO_TAG) === c.key)
                    const rate = j ? currentRate.get(j.id) : undefined
                    return (
                      <td key={c.key} className="right">
                        <RateCell rate={rate} />
                      </td>
                    )
                  })}
                  <td className="muted">{effectiveDate ?? '—'}</td>
                  {/* The list only VIEWS: the window it opens starts
                      read-only, and the pencil to edit lives inside it. */}
                  <td className="right">
                    <button
                      type="button"
                      className="icon-btn"
                      title="View this piece rate"
                      aria-label={`View ${g.name}`}
                      onClick={() => setManageKey(groupKey(g))}
                    >
                      <IconEye />
                    </button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <div className="row-form spread">
        <p className="muted small">{groups.length} work item(s) shown.</p>
        <p className="muted small">Archived work is kept in Piece Rate History.</p>
      </div>

      {manageGroup && (
        <GroupManageModal
          jobs={manageGroup.jobs}
          stationName={stationName(manageGroup.station_id)}
          grades={grades}
          currentRate={currentRate}
          canEdit={canManage}
          canDelete={canDelete}
          onChanged={onChanged}
          onError={onError}
          onClose={() => setManageKey(null)}
        />
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Manage window — one work type, read across its tier tags.          */
/*                                                                    */
/* Three faces behind the same window: the contract as it stands, the */
/* same table with its rate boxes open for amendment, and everything  */
/* that has ever been changed on it. Amending asks for the change to  */
/* be confirmed side by side before any of it is written.             */
/* ------------------------------------------------------------------ */

/** What one tier's rate looks like while it is being amended. */
interface RateDraft {
  unit: string
  rate: string
  tier2: string
  effectiveFrom: string
  /** Offered in the mobile work entry screen. */
  onMobile: boolean
  /** Counted on the mobile Mill output dashboard. */
  onMill: boolean
}

/** One line of the before/after sheet shown before anything is written. */
interface Change {
  what: string
  before: string
  after: string
}

function GroupManageModal({
  jobs: unsortedJobs,
  stationName,
  grades,
  currentRate,
  canEdit,
  canDelete,
  onChanged,
  onError,
  onClose,
}: {
  jobs: Job[]
  stationName: string
  grades: Grade[]
  currentRate: Map<string, Rate>
  canEdit: boolean
  canDelete: boolean
  onChanged: () => void
  onError: (m: string | null) => void
  onClose: () => void
}) {
  const gradeName = (id: string | null) => grades.find((g) => g.id === id)?.name ?? 'No tag'
  const gradeColor = (id: string | null) => grades.find((g) => g.id === id)?.color
  // Columns run upper tier first, the same way the masterlist and the tier
  // list do. An untagged contract has no rank, so it sits at the end.
  const tierRank = (id: string | null) => grades.find((g) => g.id === id)?.sort_order ?? 999
  const jobs = [...unsortedJobs].sort((a, b) => tierRank(a.grade_id) - tierRank(b.grade_id))

  const blankDraft = () =>
    Object.fromEntries(
      jobs.map((j) => {
        const r = currentRate.get(j.id)
        return [
          j.id,
          {
            // Paid by the hour is a UNIT choice, the same as it is in the
            // create window — the tiering itself lives in tier2_rate.
            unit: r?.tier2_rate != null ? TIERED : j.unit,
            rate: r ? String(Number(r.rate)) : '',
            tier2: r?.tier2_rate != null ? String(Number(r.tier2_rate)) : '',
            effectiveFrom: r?.effective_from ?? todayISO(),
            onMobile: j.record_job !== false,
            onMill: j.show_on_mill !== false,
          } as RateDraft,
        ]
      }),
    )

  const [mode, setMode] = useState<'view' | 'edit' | 'history'>('view')
  const [name, setName] = useState(jobs[0]?.name ?? '')
  const [draft, setDraft] = useState<Record<string, RateDraft>>(blankDraft)
  const [confirm, setConfirm] = useState<'save' | 'archive' | null>(null)
  const [remark, setRemark] = useState('')
  const [busy, setBusy] = useState(false)

  const patch = (jobId: string, fields: Partial<RateDraft>) =>
    setDraft((d) => ({ ...d, [jobId]: { ...d[jobId], ...fields } }))

  function startEdit() {
    setName(jobs[0]?.name ?? '')
    setDraft(blankDraft())
    onError(null)
    setMode('edit')
  }

  function cancelEdit() {
    setName(jobs[0]?.name ?? '')
    setDraft(blankDraft())
    onError(null)
    setMode('view')
  }

  const fmtRate = (v: number | null | undefined) =>
    v == null || Number.isNaN(v) ? '—' : Number(v).toFixed(2)
  const unitLabel = (u: string) => (u === TIERED ? '/hour (tiered)' : u)

  /** Everything the amendment would change, in the order it is read. */
  const changes: Change[] = (() => {
    const out: Change[] = []
    const oldName = jobs[0]?.name ?? ''
    if (name.trim() && name.trim() !== oldName) {
      out.push({ what: 'Work description', before: oldName, after: name.trim() })
    }
    for (const j of jobs) {
      const d = draft[j.id]
      if (!d) continue
      const r = currentRate.get(j.id)
      const tier = gradeName(j.grade_id)
      const beforeUnit = r?.tier2_rate != null ? TIERED : j.unit
      if (unitLabel(d.unit) !== unitLabel(beforeUnit)) {
        out.push({ what: `${tier} · unit`, before: unitLabel(beforeUnit), after: unitLabel(d.unit) })
      }
      const afterRate = d.rate.trim() === '' ? null : Number(d.rate)
      if (fmtRate(afterRate) !== fmtRate(r ? Number(r.rate) : null)) {
        out.push({
          what: `${tier} · ${d.unit === TIERED ? 'tier 1 rate' : 'rate'}`,
          before: fmtRate(r ? Number(r.rate) : null),
          after: fmtRate(afterRate),
        })
      }
      const afterTier2 = d.unit === TIERED && d.tier2.trim() !== '' ? Number(d.tier2) : null
      if (fmtRate(afterTier2) !== fmtRate(r?.tier2_rate ?? null)) {
        out.push({
          what: `${tier} · tier 2 rate`,
          before: fmtRate(r?.tier2_rate ?? null),
          after: fmtRate(afterTier2),
        })
      }
      if (d.effectiveFrom !== (r?.effective_from ?? '')) {
        out.push({
          what: `${tier} · effective date`,
          before: r?.effective_from ?? '—',
          after: d.effectiveFrom || '—',
        })
      }
      if (d.onMobile !== (j.record_job !== false)) {
        out.push({
          what: `${tier} · show on mobile apps work entry`,
          before: j.record_job !== false ? 'Yes' : 'No',
          after: d.onMobile ? 'Yes' : 'No',
        })
      }
      if (d.onMill !== (j.show_on_mill !== false)) {
        out.push({
          what: `${tier} · show on mill performance`,
          before: j.show_on_mill !== false ? 'Yes' : 'No',
          after: d.onMill ? 'Yes' : 'No',
        })
      }
    }
    return out
  })()


  /** Write the amendment. Every write is checked for a refusal, since row
   *  security answers "no" with zero rows rather than with an error. */
  async function save() {
    setBusy(true)
    onError(null)
    try {
      const newName = name.trim()
      if (!newName) throw new Error('Enter the work description.')

      if (newName !== jobs[0]?.name) {
        for (const j of jobs) {
          const { data, error } = await supabase
            .from('jobs')
            .update({ name: newName })
            .eq('id', j.id)
            .select('id')
          if (error) throw new Error(saveMessage(error.message))
          if (!data || data.length === 0) {
            throw new Error('You are not allowed to edit this piece rate.')
          }
        }
      }

      for (const j of jobs) {
        const d = draft[j.id]
        if (!d) continue
        const tier = gradeName(j.grade_id)
        const tiered = d.unit === TIERED
        const rateValue = Number(d.rate)
        if (d.rate.trim() === '' || Number.isNaN(rateValue) || rateValue < 0) {
          throw new Error(`${tier}: enter a valid non-negative ${tiered ? 'tier 1' : 'piece'} rate.`)
        }
        const tier2Value = tiered ? Number(d.tier2) : null
        if (tiered && (d.tier2.trim() === '' || Number.isNaN(tier2Value) || (tier2Value as number) < 0)) {
          throw new Error(`${tier}: enter a valid non-negative tier 2 rate.`)
        }
        if (!d.effectiveFrom) throw new Error(`${tier}: pick an effective date.`)

        const unitValue = tiered ? '/hour' : d.unit.trim() || 'unit'
        if (unitValue !== j.unit) {
          const { error } = await supabase.from('jobs').update({ unit: unitValue }).eq('id', j.id)
          if (error) throw new Error(saveMessage(error.message))
        }

        // Both switches live on the jobs row, and both arrived after the
        // first release — a database that has not had setup.sql re-run says
        // which column is missing rather than showing a Postgres error.
        const flags: Record<string, boolean> = {}
        if (d.onMobile !== (j.record_job !== false)) flags.record_job = d.onMobile
        if (d.onMill !== (j.show_on_mill !== false)) flags.show_on_mill = d.onMill
        if (Object.keys(flags).length > 0) {
          const { error } = await supabase.from('jobs').update(flags).eq('id', j.id)
          if (error) {
            const missing = /record_job|show_on_mill/i.exec(error.message)?.[0]
            throw new Error(
              missing
                ? `The database is missing the ${missing} column — run the latest ` +
                  `supabase/setup.sql (or just: alter table public.jobs add column ` +
                  `${missing} boolean not null default true;).`
                : error.message,
            )
          }
        }

        const r = currentRate.get(j.id)
        const rateUnchanged =
          r &&
          Number(r.rate) === rateValue &&
          (r.tier2_rate ?? null) === tier2Value &&
          r.effective_from === d.effectiveFrom
        if (rateUnchanged) continue

        const { error } = await supabase.from('piece_rates').upsert(
          { job_id: j.id, rate: rateValue, tier2_rate: tier2Value, effective_from: d.effectiveFrom },
          { onConflict: 'job_id,effective_from' },
        )
        if (error) throw new Error(error.message)
        // A price change on an APPROVED contract goes back through verify
        // and approve — otherwise amending the rate would bypass the flow.
        if (j.approval_status === 'approved') {
          const { error: reErr } = await supabase
            .from('jobs')
            .update({
              approval_status: 'pending',
              verified_by: null,
              verified_at: null,
              approved_by: null,
              approved_at: null,
            } as never)
            .eq('id', j.id)
          if (reErr) throw new Error(reErr.message)
        }
      }
      setConfirm(null)
      onChanged()
      onClose()
    } catch (err) {
      setConfirm(null)
      onError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  /**
   * Archive every tier's contract for this work, or bring it back.
   *
   * Nothing is deleted: a piece rate that has already paid somebody is
   * part of the payroll record, so archiving takes it out of the listing
   * and out of the mobile work entry screen and leaves the row where it
   * is. The reason goes onto each row first, so the audit log keeps it.
   */
  async function archive() {
    if (!remark.trim()) return onError('Say why this piece rate is being archived.')
    setBusy(true)
    onError(null)
    try {
      for (const j of jobs) {
        const { data, error } = await supabase
          .from('jobs')
          .update({ active: false, delete_remark: remark.trim() } as never)
          .eq('id', j.id)
          .select('id')
        if (error) throw new Error(error.message)
        if (!data || data.length === 0) {
          throw new Error('You are not allowed to archive this piece rate.')
        }
      }
      setConfirm(null)
      onChanged()
      onClose()
    } catch (err) {
      setConfirm(null)
      onError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  /** Put an archived piece rate back into the listing. */
  async function restore() {
    setBusy(true)
    onError(null)
    const ids = jobs.map((j) => j.id)
    const { data, error } = await supabase
      .from('jobs')
      .update({ active: true })
      .in('id', ids)
      .select('id')
    setBusy(false)
    if (error) return onError(error.message)
    if (!data || data.length === 0) {
      return onError('You are not allowed to restore this piece rate.')
    }
    onChanged()
    onClose()
  }

  const editing = mode === 'edit'
  // Archiving takes the whole work, so a work is archived when none of its
  // tiers is active any more.
  const archived = jobs.every((j) => !j.active)

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-manage" onClick={(e) => e.stopPropagation()}>
        <div className="row-form spread">
          <h2>{stationName}</h2>
          <div className="row-form manage-tools">
            {/* Reading the history? The eye beside it goes back to the
                piece rate itself. */}
            {mode === 'history' && (
              <button
                type="button"
                className="icon-btn"
                onClick={() => setMode('view')}
                title="View this piece rate"
                aria-label="View this piece rate"
              >
                <IconEye />
              </button>
            )}
            {!editing && (
              <button
                type="button"
                className={`icon-btn ${mode === 'history' ? 'on' : ''}`}
                onClick={() => setMode(mode === 'history' ? 'view' : 'history')}
                title="Amendment history"
                aria-label="Amendment history"
              >
                <IconClock />
              </button>
            )}
            {!editing && canEdit && mode !== 'history' && (
              <button type="button" className="icon-btn" onClick={startEdit} title="Edit" aria-label="Edit">
                <IconPencil />
              </button>
            )}
            {!editing && canDelete && mode !== 'history' && (
              archived ? (
                <button
                  type="button"
                  className="icon-btn"
                  onClick={restore}
                  disabled={busy}
                  title="Restore this piece rate"
                  aria-label="Restore this piece rate"
                >
                  <IconRedo />
                </button>
              ) : (
                <button
                  type="button"
                  className="icon-btn danger"
                  onClick={() => { setRemark(''); setConfirm('archive') }}
                  title="Archive this piece rate"
                  aria-label="Archive this piece rate"
                >
                  <IconArchive />
                </button>
              )
            )}
            <button type="button" className="modal-close" onClick={onClose} aria-label="Close">×</button>
          </div>
        </div>

        {mode === 'history' ? (
          <GroupHistory jobs={jobs} grades={grades} onError={onError} />
        ) : (
          /* The unit dropdown is positioned inside its cell, so a scroll
             container would clip it — only the read-only face gets one. */
          <div className={editing ? '' : 'table-scroll'}>
            <table className="table pr-manage">
              <thead>
                <tr>
                  <th className="pr-manage-corner">Work</th>
                  {jobs.map((j) => (
                    <th key={j.id}>
                      <span className={tagClass(gradeColor(j.grade_id))}>{gradeName(j.grade_id)}</span>
                      {!j.active && <> <span className="badge off">archived</span></>}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <tr>
                  <th scope="row" className="pr-manage-work">
                    {editing ? (
                      <input
                        className="quiet-input"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        aria-label="Work description"
                      />
                    ) : (
                      jobs[0]?.name
                    )}
                  </th>
                  {jobs.map((j) => {
                    const d = draft[j.id]
                    const r = currentRate.get(j.id)
                    const tiered = d?.unit === TIERED
                    return (
                      <td key={j.id}>
                        {editing ? (
                          /* Same shape as the read face — the number where
                             the number was, the unit under it — only now the
                             number is a box and the unit is its picker. */
                          <div className="pr-manage-edit">
                            {tiered ? (
                              <span className="rate-tiered">
                                <span className="rate-tier-line">
                                  <span className="rate-tier-lbl">1st–4th</span>
                                  <input
                                    className="quiet-input num"
                                    inputMode="decimal"
                                    value={d?.rate ?? ''}
                                    onChange={(e) => patch(j.id, { rate: e.target.value })}
                                    aria-label={`${gradeName(j.grade_id)} tier 1 rate`}
                                  />
                                </span>
                                <span className="rate-tier-line">
                                  <span className="rate-tier-lbl">5th+</span>
                                  <input
                                    className="quiet-input num"
                                    inputMode="decimal"
                                    value={d?.tier2 ?? ''}
                                    onChange={(e) => patch(j.id, { tier2: e.target.value })}
                                    aria-label={`${gradeName(j.grade_id)} tier 2 rate`}
                                  />
                                </span>
                              </span>
                            ) : (
                              <input
                                className="quiet-input num"
                                inputMode="decimal"
                                value={d?.rate ?? ''}
                                onChange={(e) => patch(j.id, { rate: e.target.value })}
                                aria-label={`${gradeName(j.grade_id)} rate`}
                              />
                            )}
                            <UnitPicker
                              allowTiered
                              value={d?.unit ?? j.unit}
                              onChange={(v) => patch(j.id, { unit: v })}
                              ariaLabel={`${gradeName(j.grade_id)} unit`}
                            />
                          </div>
                        ) : (
                          <>
                            <RateCell rate={r} />
                            <div className="muted small">{j.unit}</div>
                          </>
                        )}
                      </td>
                    )
                  })}
                </tr>

                <tr>
                  <th scope="row">Effective date</th>
                  {jobs.map((j) => (
                    <td key={j.id}>
                      {editing ? (
                        <input
                          className="quiet-input date"
                          type="date"
                          value={draft[j.id]?.effectiveFrom ?? ''}
                          onChange={(e) => patch(j.id, { effectiveFrom: e.target.value })}
                          aria-label={`${gradeName(j.grade_id)} effective date`}
                        />
                      ) : (
                        currentRate.get(j.id)?.effective_from ?? <span className="muted">—</span>
                      )}
                    </td>
                  ))}
                </tr>

                <tr>
                  <th scope="row">Show on mobile apps work entry</th>
                  {jobs.map((j) => (
                    <td key={j.id}>
                      {editing ? (
                        <label
                          className="checkbox tickword"
                          style={{ margin: 0 }}
                          title="Untick for an incentive or support rate — paid through payroll, never offered as a record to submit."
                        >
                          <input
                            type="checkbox"
                            checked={draft[j.id]?.onMobile ?? true}
                            onChange={(e) => patch(j.id, { onMobile: e.target.checked })}
                          />{' '}
                          {(draft[j.id]?.onMobile ?? true)
                            ? 'Shown on mobile apps'
                            : 'Not shown on mobile apps'}
                        </label>
                      ) : (j.record_job !== false) ? (
                        <span className="tickmark yes">✓ Shown on mobile apps</span>
                      ) : (
                        <span className="tickmark no">✕ Not shown on mobile apps</span>
                      )}
                    </td>
                  ))}
                </tr>

                <tr>
                  <th scope="row">Show on mill performance</th>
                  {jobs.map((j) => (
                    <td key={j.id}>
                      {editing ? (
                        <label
                          className="checkbox"
                          style={{ margin: 0 }}
                          title="Ticked: this work is counted on the mobile Mill output dashboard."
                        >
                          <input
                            type="checkbox"
                            checked={draft[j.id]?.onMill ?? true}
                            onChange={(e) => patch(j.id, { onMill: e.target.checked })}
                          />
                        </label>
                      ) : (j.show_on_mill !== false) ? (
                        <span className="tickmark yes" aria-label="Yes">✓</span>
                      ) : (
                        <span className="tickmark no" aria-label="No">✕</span>
                      )}
                    </td>
                  ))}
                </tr>

              </tbody>
            </table>
          </div>
        )}

        {editing && (
          <div className="row-form" style={{ justifyContent: 'flex-end' }}>
            <button type="button" className="btn ghost" onClick={cancelEdit}>Cancel</button>
            <button
              type="button"
              className="btn"
              disabled={changes.length === 0}
              onClick={() => setConfirm('save')}
            >
              Save changes
            </button>
          </div>
        )}
      </div>

      {confirm === 'save' && (
        <ConfirmChangesModal
          changes={changes}
          busy={busy}
          onCancel={() => setConfirm(null)}
          onConfirm={save}
        />
      )}

      {confirm === 'archive' && (
        <div className="modal-overlay" onClick={(e) => e.stopPropagation()}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Archive this piece rate?</h2>
            <p className="small muted" style={{ marginTop: 0 }}>
              {jobs[0]?.name} at {stationName} — all {jobs.length} tier
              {jobs.length === 1 ? '' : 's'} come out of the masterlist and out of
              the mobile work entry screen. Nothing is deleted: the rate stays on
              record for the work already paid against it, and it can be restored
              from here at any time.
            </p>
            <label className="field">
              <span>Reason</span>
              <input value={remark} onChange={(e) => setRemark(e.target.value)} autoFocus />
            </label>
            <div className="row-form" style={{ justifyContent: 'flex-end' }}>
              <button type="button" className="btn ghost" onClick={() => setConfirm(null)}>Cancel</button>
              <button type="button" className="btn danger" disabled={busy} onClick={archive}>
                {busy ? 'Archiving…' : 'Archive'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* The double-check before an amendment is written: what each line     */
/* says now, and what it would say. Nothing is saved until this is     */
/* confirmed.                                                          */
/* ------------------------------------------------------------------ */

function ConfirmChangesModal({
  changes,
  busy,
  onCancel,
  onConfirm,
}: {
  changes: Change[]
  busy: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  return (
    <div className="modal-overlay" onClick={(e) => e.stopPropagation()}>
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
        <div className="row-form spread">
          <h2>Confirm changes</h2>
          <button type="button" className="modal-close" onClick={onCancel} aria-label="Close">×</button>
        </div>

        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>What</th>
                <th>Before</th>
                <th>After</th>
              </tr>
            </thead>
            <tbody>
              {changes.map((c, i) => (
                <tr key={i}>
                  <td>{c.what}</td>
                  <td className="muted">{c.before}</td>
                  <td><strong>{c.after}</strong></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p className="small muted" style={{ margin: 0 }}>
          Changing a rate on an approved contract sends it back for verification
          and approval. Every change here is kept in the amendment history.
        </p>

        <div className="row-form" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn ghost" onClick={onCancel}>Back</button>
          <button type="button" className="btn" disabled={busy} onClick={onConfirm}>
            {busy ? 'Saving…' : 'Confirm & save'}
          </button>
        </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Amendment history for one work type. Read straight from the audit  */
/* log, which already records every change to jobs and piece_rates —  */
/* so there is no second copy of the truth to keep in step.           */
/* ------------------------------------------------------------------ */

/** Columns worth showing a person. The rest (ids, timestamps that repeat
 *  a field beside them) only add noise to the line. */
const AUDIT_FIELD: Record<string, string> = {
  name: 'Work description',
  unit: 'Unit',
  rate: 'Piece rate',
  tier2_rate: 'Tier 2 rate',
  effective_from: 'Effective date',
  approval_status: 'Approval',
  active: 'In the masterlist',
  record_job: 'Show on mobile work entry',
  show_on_mill: 'Show on mill performance',
  delete_remark: 'Archive reason',
  verified_by: 'Verified by',
  approved_by: 'Approved by',
}

interface AuditRow {
  id: string
  at: string
  actor: string | null
  action: string
  target: string
  target_id: string | null
  detail: Record<string, unknown> | null
}

function GroupHistory({
  jobs,
  grades,
  onError,
}: {
  jobs: Job[]
  grades: Grade[]
  onError: (m: string | null) => void
}) {
  const [rows, setRows] = useState<AuditRow[] | null>(null)
  const [who, setWho] = useState<Map<string, string>>(new Map())
  // Which tier each rate row belongs to, so a rate change says whose it was.
  const [rateTier, setRateTier] = useState<Map<string, string>>(new Map())

  const jobIds = jobs.map((j) => j.id).join(',')

  useEffect(() => {
    let live = true
    ;(async () => {
      const ids = jobs.map((j) => j.id)
      const tierOfJob = new Map(
        jobs.map((j) => [j.id, grades.find((g) => g.id === j.grade_id)?.name ?? 'No tag']),
      )
      const { data: prs } = await supabase.from('piece_rates').select('id, job_id').in('job_id', ids)
      const rateMap = new Map<string, string>()
      for (const r of prs ?? []) rateMap.set(r.id as string, tierOfJob.get(r.job_id as string) ?? '')

      const { data, error } = await supabase
        .from('audit_log')
        .select('id, at, actor, action, target, target_id, detail')
        .in('target_id', [...ids, ...rateMap.keys()])
        .order('at', { ascending: false })
        .limit(200)
      if (!live) return
      if (error) onError(error.message)
      const list = (data ?? []) as AuditRow[]

      const actorIds = [...new Set(list.map((r) => r.actor).filter((a): a is string => Boolean(a)))]
      const names = new Map<string, string>()
      if (actorIds.length > 0) {
        const { data: people } = await supabase
          .from('access_profiles')
          .select('id, full_name, email')
          .in('id', actorIds)
        for (const p of people ?? []) names.set(p.id as string, profileName(p as never))
      }
      if (!live) return
      setRateTier(rateMap)
      setWho(names)
      setRows(list)
    })()
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobIds])

  if (rows === null) return <p className="muted">Loading…</p>
  if (rows.length === 0) return <p className="muted">No changes recorded for this piece rate yet.</p>

  const describe = (r: AuditRow) => {
    if (r.action === 'insert') return 'Created'
    if (r.action === 'delete') return 'Deleted'
    const d = r.detail ?? {}
    const parts = Object.entries(d)
      .filter(([k]) => k in AUDIT_FIELD)
      .map(([k, v]) => `${AUDIT_FIELD[k]}: ${v === null ? '—' : String(v)}`)
    return parts.length > 0 ? parts.join(' · ') : 'No visible change'
  }

  return (
    <div className="table-scroll">
      <table className="table">
        <thead>
          <tr>
            <th>When</th>
            <th>Tier</th>
            <th>Who</th>
            <th>Change</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td className="nowrap">{new Date(r.at).toLocaleString()}</td>
              <td>{(r.target_id && rateTier.get(r.target_id)) || tierOfRow(r, jobs, grades)}</td>
              {/* A null actor means the change was made in the Supabase
                  dashboard rather than through the app. */}
              <td>{(r.actor && who.get(r.actor)) || <span className="muted">Database</span>}</td>
              <td>{describe(r)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function tierOfRow(r: AuditRow, jobs: Job[], grades: Grade[]) {
  const job = jobs.find((j) => j.id === r.target_id)
  if (!job) return ''
  return grades.find((g) => g.id === job.grade_id)?.name ?? 'No tag'
}

/* ------------------------------------------------------------------ */
/* Piece Rate History — every past rate change for approved contracts, */
/* derived from piece_rates rows (no separate history table). Pivoted */
/* the same way as Master, with one row per distinct effective date   */
/* the group changed on.                                              */
/* ------------------------------------------------------------------ */

interface HistoryRow {
  effectiveFrom: string
  effectiveTo: string | null
  status: 'current' | 'scheduled' | 'inactive'
  rateByKey: Map<string, Rate>
}

type HistoryGroup = JobGroup & { rows: HistoryRow[] }

function buildHistory(jobs: Job[], rates: Rate[]): HistoryGroup[] {
  // Approved work, plus anything archived whatever state it was left in —
  // this page is the only place archived work can still be reached.
  const shown = jobs.filter((j) => j.approval_status === 'approved' || !j.active)
  const groups = groupJobs(shown)

  const ratesByJob = new Map<string, Rate[]>()
  for (const r of rates) {
    if (!ratesByJob.has(r.job_id)) ratesByJob.set(r.job_id, [])
    ratesByJob.get(r.job_id)!.push(r)
  }
  for (const list of ratesByJob.values()) list.sort((a, b) => a.effective_from.localeCompare(b.effective_from))

  const today = todayISO()
  return groups.map((g) => {
    const changeDates = [
      ...new Set(g.jobs.flatMap((j) => (ratesByJob.get(j.id) ?? []).map((r) => r.effective_from))),
    ].sort()

    const rows: HistoryRow[] = changeDates.map((date, i) => {
      const rateByKey = new Map<string, Rate>()
      for (const j of g.jobs) {
        const list = ratesByJob.get(j.id) ?? []
        let found: Rate | undefined
        for (const r of list) {
          if (r.effective_from <= date) found = r
          else break
        }
        if (found) rateByKey.set(j.grade_id ?? NO_TAG, found)
      }
      const nextDate = changeDates[i + 1]
      const effectiveTo = nextDate ? addDays(nextDate, -1) : null
      const status: HistoryRow['status'] = effectiveTo ? 'inactive' : date <= today ? 'current' : 'scheduled'
      return { effectiveFrom: date, effectiveTo, status, rateByKey }
    })

    return { ...g, rows }
  })
}

function HistoryList({
  stations,
  grades,
  jobs,
  rates,
  currentRate,
  canManage,
  canDelete,
  onChanged,
  onError,
}: {
  stations: Station[]
  grades: Grade[]
  jobs: Job[]
  rates: Rate[]
  currentRate: Map<string, Rate>
  canManage: boolean
  canDelete: boolean
  onChanged: () => void
  onError: (m: string | null) => void
}) {
  const [stationFilter, setStationFilter] = useState('')
  const [search, setSearch] = useState('')
  // Archived work no longer shows in the masterlist, so this page is where
  // it is looked at — and where it is restored from.
  const [manageKey, setManageKey] = useState<string | null>(null)
  const manageGroup = manageKey
    ? groupJobs(jobs).find((g) => groupKey(g) === manageKey) ?? null
    : null

  const stationName = (id: string) => stations.find((s) => s.id === id)?.name ?? '?'

  const filteredJobs = jobs
    .filter((j) => (stationFilter ? j.station_id === stationFilter : true))
    .filter((j) => (search.trim() ? j.name.toLowerCase().includes(search.trim().toLowerCase()) : true))

  const groups = buildHistory(filteredJobs, rates).sort(
    (a, b) => stationName(a.station_id).localeCompare(stationName(b.station_id)) || a.name.localeCompare(b.name),
  )
  const tagCols = tagColumns(grades, filteredJobs)
  const colCount = 5 + tagCols.length + 1 + (canManage ? 1 : 0)
  const rowCount = groups.reduce((n, g) => n + g.rows.length, 0)

  return (
    <div className="card stack">
      <div className="row-form spread">
        <h3>Piece Rate History</h3>
        <div className="row-form">
          <Select
            value={stationFilter}
            onChange={setStationFilter}
            options={[{ value: '', label: 'All stations' }, ...stationOptions(stations)]}
            placeholder="All stations"
            ariaLabel="Filter by station"
          />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search work description…"
            style={{ minWidth: '220px' }}
          />
        </div>
      </div>
      <div className="table-scroll">
        <table className="table">
          <thead>
            <tr>
              <th>Station</th>
              <th>Work description</th>
              <th>Unit</th>
              <th>Effective from</th>
              <th>Effective to</th>
              {tagCols.map((c) => (
                <th key={c.key} className="right">{c.label} (RM)</th>
              ))}
              <th>Status</th>
              {canManage && <th className="right">Actions</th>}
            </tr>
          </thead>
          <tbody>
            {rowCount === 0 && (
              <tr>
                <td colSpan={colCount} className="muted">No rate history yet.</td>
              </tr>
            )}
            {groups.flatMap((g) =>
              g.rows.map((row, i) => (
                <tr key={`${groupKey(g)}::${row.effectiveFrom}`}>
                  <td>{i === 0 ? stationName(g.station_id) : ''}</td>
                  <td>{i === 0 ? g.name : ''}</td>
                  <td className="muted">{i === 0 ? g.jobs[0]?.unit : ''}</td>
                  <td className="muted">{row.effectiveFrom}</td>
                  <td className="muted">
                    {row.status === 'current' ? 'Current' : row.status === 'scheduled' ? 'Scheduled' : row.effectiveTo}
                  </td>
                  {tagCols.map((c) => {
                    const rate = row.rateByKey.get(c.key)
                    return (
                      <td key={c.key} className="right">
                        <RateCell rate={rate} />
                      </td>
                    )
                  })}
                  <td>
                    {/* An archived work has no live rate at all, so say so
                        once on its first line instead of calling the newest
                        period "current". */}
                    {g.jobs.every((j) => !j.active) ? (
                      i === 0 && <span className="badge off">Archived</span>
                    ) : (
                      <>
                        {row.status === 'current' && <span className="badge ok">Current</span>}
                        {row.status === 'scheduled' && <span className="badge off">Scheduled</span>}
                        {row.status === 'inactive' && <span className="badge off">Superseded</span>}
                      </>
                    )}
                  </td>
                  {canManage && (
                    <td className="right">
                      {i === 0 && (
                        <button
                          type="button"
                          className="icon-btn"
                          title="Open this piece rate"
                          aria-label={`Open ${g.name}`}
                          onClick={() => setManageKey(groupKey(g))}
                        >
                          <IconPencil />
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              )),
            )}
          </tbody>
        </table>
      </div>
      <p className="muted small">{rowCount} rate change(s) across {groups.length} work item(s).</p>

      {manageGroup && (
        <GroupManageModal
          jobs={manageGroup.jobs}
          stationName={stationName(manageGroup.station_id)}
          grades={grades}
          currentRate={currentRate}
          canEdit={canManage}
          canDelete={canDelete}
          onChanged={onChanged}
          onError={onError}
          onClose={() => setManageKey(null)}
        />
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Shared save pieces                                                 */
/* ------------------------------------------------------------------ */

/** Postgres rejects a repeat of Station + Tier tag + Work description by
 *  index name; say what that actually means in the window. */
function saveMessage(message: string) {
  return message.includes('jobs_station_grade_name_idx')
    ? 'A piece rate already exists for this exact Tier tag + Station tag + work description — edit that one instead (look in Piece Rate History if it has been archived).'
    : message
}

/** The Unit cell: the usual units on the system's own dropdown, with an
 *  "Other…" row that swaps the cell for a free-text box so nothing is
 *  shut out of the list. */
function UnitPicker({
  value,
  onChange,
  ariaLabel,
  allowTiered = false,
}: {
  value: string
  onChange: (v: string) => void
  ariaLabel: string
  /** Offer "Tiered by hour" in the list. Picking it is what turns a rate
   *  into a two-step hourly one, in the create window and in Manage. */
  allowTiered?: boolean
}) {
  const [custom, setCustom] = useState(
    value !== '' && value !== TIERED && !UNIT_SUGGESTIONS.includes(value),
  )

  if (custom) {
    return (
      <div className="pr-rate-cell">
        <input value={value} onChange={(e) => onChange(e.target.value)} aria-label={ariaLabel} />
        <button
          type="button"
          className="pr-tier-toggle"
          onClick={() => {
            setCustom(false)
            onChange('')
          }}
        >
          Pick from the list
        </button>
      </div>
    )
  }
  return (
    <Select
      block
      value={value}
      ariaLabel={ariaLabel}
      placeholder="Choose unit…"
      options={[
        ...UNIT_SUGGESTIONS.map((u) => ({ value: u, label: u })),
        ...(allowTiered ? [{ value: TIERED, label: 'Tiered by hour' }] : []),
        { value: UNIT_OTHER, label: 'Other…' },
      ]}
      onChange={(v) => {
        if (v === UNIT_OTHER) {
          setCustom(true)
          onChange('')
        } else {
          onChange(v)
        }
      }}
    />
  )
}

/* ------------------------------------------------------------------ */
/* Create window — a batch of new piece rates, laid out the way the    */
/* masterlist reads: one line per rate, left to right, and "+ Row" for */
/* the next one. Everything keyed in here is submitted for approval    */
/* together when the window is sent.                                   */
/* ------------------------------------------------------------------ */

interface DraftRow {
  key: number
  /** A rate can pay several tiers, and stand at several stations: the row
   *  is written out once per tier tag × station tag when it is sent. */
  gradeIds: string[]
  stationIds: string[]
  description: string
  unit: string
  rate: string
  tier2: string
  effectiveFrom: string
  /** Marked when this is the row that stopped the batch. */
  bad?: boolean
}

function isBlankRow(r: DraftRow) {
  return (
    r.stationIds.length === 0 && r.gradeIds.length === 0 &&
    !r.description.trim() && !r.unit.trim() && !r.rate.trim()
  )
}

/** Every rate one line stands for — the same work at each tier × station. */
function spread(r: DraftRow) {
  const tiers = r.gradeIds.length ? r.gradeIds : ['']
  const out: { gradeId: string; stationId: string }[] = []
  for (const s of r.stationIds) for (const g of tiers) out.push({ gradeId: g, stationId: s })
  return out
}

function CreateRatesModal({
  stations,
  grades,
  onClose,
  onSaved,
  onReload,
}: {
  stations: Station[]
  grades: Grade[]
  onClose: () => void
  onSaved: (count: number) => void
  onReload: () => void
}) {
  const overlayProps = useOverlayClose(onClose)
  const nextKey = useRef(1)

  // A fresh line carries over the station, unit and date of the one above
  // it — a batch is nearly always the same station on the same day.
  const blank = (from?: DraftRow): DraftRow => ({
    key: nextKey.current++,
    gradeIds: [],
    stationIds: from?.stationIds ?? [],
    description: '',
    unit: from?.unit ?? '',
    rate: '',
    tier2: '',
    effectiveFrom: from?.effectiveFrom ?? todayISO(),
  })

  const [rows, setRows] = useState<DraftRow[]>(() => [blank()])
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const patch = (key: number, fields: Partial<DraftRow>) =>
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...fields, bad: false } : r)))
  const addRow = () => setRows((rs) => [...rs, blank(rs[rs.length - 1])])
  const dropRow = (key: number) =>
    setRows((rs) => (rs.length === 1 ? rs : rs.filter((r) => r.key !== key)))

  const filled = rows.filter((r) => !isBlankRow(r))
  // The two hourly columns belong to the grid, not to one line, so they
  // open as soon as any line is paid by the hour.
  const anyTiered = rows.some((r) => r.unit === TIERED)

  const tierOptions = useMemo(() => tierTagOptions(grades), [grades])
  const stationChoices = useMemo(() => stationOptions(stations), [stations])
  const nameOf = (list: SelectOption[], value: string) =>
    list.find((o) => o.value === value)?.label ?? '—'

  function reject(row: DraftRow, message: string) {
    setRows((rs) => rs.map((r) => ({ ...r, bad: r.key === row.key })))
    setError(message)
  }

  async function submit() {
    setError(null)
    if (filled.length === 0) return setError('Fill in at least one row.')

    // Check the whole batch before writing any of it.
    const seen = new Set<string>()
    for (const r of filled) {
      const n = rows.indexOf(r) + 1
      const tiered = r.unit === TIERED
      if (r.stationIds.length === 0) return reject(r, `Row ${n}: choose a station tag.`)
      if (!r.description.trim()) return reject(r, `Row ${n}: enter the piece rate work description.`)
      if (!r.unit.trim()) return reject(r, `Row ${n}: choose a unit.`)
      const rateValue = Number(r.rate)
      if (r.rate.trim() === '' || Number.isNaN(rateValue) || rateValue < 0) {
        return reject(r, `Row ${n}: enter a valid non-negative ${tiered ? 'Tier 1' : 'piece'} rate.`)
      }
      if (tiered) {
        const t2 = Number(r.tier2)
        if (r.tier2.trim() === '' || Number.isNaN(t2) || t2 < 0) {
          return reject(r, `Row ${n}: enter a valid non-negative Tier 2 rate.`)
        }
      }
      if (!r.effectiveFrom) return reject(r, `Row ${n}: pick an effective date.`)
      for (const at of spread(r)) {
        const key = `${at.stationId}::${at.gradeId}::${r.description.trim().toLowerCase()}`
        if (seen.has(key)) {
          return reject(r, `Row ${n}: same tier tag, station tag and work description as an earlier row.`)
        }
        seen.add(key)
      }
    }

    setSaving(true)
    const savedKeys: number[] = []
    let written = 0
    let failure: { key: number; message: string } | null = null

    for (const r of filled) {
      const n = rows.indexOf(r) + 1
      const tiered = r.unit === TIERED
      let stopped = false
      for (const at of spread(r)) {
        const where =
          `${nameOf(stationChoices, at.stationId)}` +
          (at.gradeId ? ` · ${nameOf(tierOptions, at.gradeId)}` : '')
        // Every new contract waits for verify + approve, admins included.
        const { data, error: jobErr } = await supabase
          .from('jobs')
          .insert({
            station_id: at.stationId,
            grade_id: at.gradeId || null,
            name: r.description.trim(),
            unit: tiered ? '/hour' : r.unit.trim(),
            approval_status: 'pending',
          })
          .select()
          .single()
        if (jobErr || !data) {
          failure = {
            key: r.key,
            message: `Row ${n} (${where}): ${saveMessage(jobErr?.message ?? 'could not be saved.')}`,
          }
          stopped = true
          break
        }
        const { error: rateErr } = await supabase.from('piece_rates').upsert(
          {
            job_id: data.id,
            rate: Number(r.rate),
            tier2_rate: tiered ? Number(r.tier2) : null,
            effective_from: r.effectiveFrom,
          },
          { onConflict: 'job_id,effective_from' },
        )
        if (rateErr) {
          // Take the contract back out, so the row can simply be sent again
          // instead of colliding with a half-made entry.
          await supabase.from('jobs').delete().eq('id', data.id)
          failure = { key: r.key, message: `Row ${n} (${where}): ${rateErr.message}` }
          stopped = true
          break
        }
        written += 1
      }
      if (stopped) break
      savedKeys.push(r.key)
    }

    setSaving(false)
    if (!failure) return onSaved(written)

    // Whatever went in is gone from the grid, so sending again can't
    // double it up; what is left is the row that stopped, and the rest.
    const stopped = failure
    setRows((rs) => {
      const left = rs.filter((r) => !savedKeys.includes(r.key))
      return left.length === 0 ? [blank()] : left.map((r) => ({ ...r, bad: r.key === stopped.key }))
    })
    setError(
      written > 0
        ? `${written} rate(s) submitted, then it stopped. ${stopped.message}`
        : stopped.message,
    )
    if (written > 0) onReload()
  }

  return (
    <div className="modal-overlay" {...overlayProps}>
      <div className={`modal modal-xwide ${anyTiered ? 'tiered' : ''}`}>
        <div className="row-form spread">
          <h2>Create new piece rate</h2>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        {error && <div className="error">{error}</div>}

        <div className={`pr-grid ${anyTiered ? 'tiered' : ''}`}>
          <div className="pr-grid-head">
            <span>Tier Tag</span>
            <span>Station Tag</span>
            <span>Piece Rate Work Description</span>
            <span>Unit</span>
            <span>Piece Rate (RM)</span>
            {anyTiered && <span>Tier 1 — 1st to 4th /hr</span>}
            {anyTiered && <span>Tier 2 — 5th onward /hr</span>}
            <span>Effective date</span>
            <span />
          </div>

          {rows.map((r, i) => {
            const tiered = r.unit === TIERED
            return (
              <div className={`pr-grid-row ${r.bad ? 'bad' : ''}`} key={r.key}>
                <div className="pr-cell">
                  <span className="pr-cell-label">Tier Tag</span>
                  <MultiSelect
                    block
                    values={r.gradeIds}
                    onChange={(v) => patch(r.key, { gradeIds: v })}
                    options={tierOptions}
                    placeholder="All positions"
                    selectAllLabel="All tiers"
                    ariaLabel={`Row ${i + 1} tier tag`}
                  />
                </div>

                <div className="pr-cell">
                  <span className="pr-cell-label">Station Tag</span>
                  <MultiSelect
                    block
                    values={r.stationIds}
                    onChange={(v) => patch(r.key, { stationIds: v })}
                    options={stationChoices}
                    placeholder="Choose station tag"
                    selectAllLabel="All stations"
                    ariaLabel={`Row ${i + 1} station tag`}
                  />
                </div>

                <div className="pr-cell wide">
                  <span className="pr-cell-label">Piece Rate Work Description</span>
                  <input
                    value={r.description}
                    onChange={(e) => patch(r.key, { description: e.target.value })}
                    aria-label={`Row ${i + 1} piece rate work description`}
                  />
                </div>

                <div className="pr-cell">
                  <span className="pr-cell-label">Unit</span>
                  <UnitPicker
                    allowTiered
                    value={r.unit}
                    onChange={(v) => patch(r.key, { unit: v, tier2: v === TIERED ? r.tier2 : '' })}
                    ariaLabel={`Row ${i + 1} unit`}
                  />
                </div>

                <div className="pr-cell">
                  <span className="pr-cell-label">Piece Rate (RM)</span>
                  {tiered ? (
                    <span className="pr-none">—</span>
                  ) : (
                    <input
                      inputMode="decimal"
                      value={r.rate}
                      onChange={(e) => patch(r.key, { rate: e.target.value })}
                      aria-label={`Row ${i + 1} piece rate`}
                    />
                  )}
                </div>

                {anyTiered && (
                  <>
                    <div className="pr-cell">
                      <span className="pr-cell-label">Tier 1 — 1st to 4th /hr</span>
                      {tiered ? (
                        <input
                          inputMode="decimal"
                          value={r.rate}
                          onChange={(e) => patch(r.key, { rate: e.target.value })}
                          aria-label={`Row ${i + 1} tier 1 rate`}
                        />
                      ) : (
                        <span className="pr-none">—</span>
                      )}
                    </div>
                    <div className="pr-cell">
                      <span className="pr-cell-label">Tier 2 — 5th onward /hr</span>
                      {tiered ? (
                        <input
                          inputMode="decimal"
                          value={r.tier2}
                          onChange={(e) => patch(r.key, { tier2: e.target.value })}
                          aria-label={`Row ${i + 1} tier 2 rate`}
                        />
                      ) : (
                        <span className="pr-none">—</span>
                      )}
                    </div>
                  </>
                )}

                <div className="pr-cell">
                  <span className="pr-cell-label">Effective date</span>
                  <input
                    type="date"
                    value={r.effectiveFrom}
                    onChange={(e) => patch(r.key, { effectiveFrom: e.target.value })}
                    aria-label={`Row ${i + 1} effective date`}
                  />
                </div>

                <button
                  type="button"
                  className="pr-row-drop"
                  onClick={() => dropRow(r.key)}
                  disabled={rows.length === 1}
                  title="Remove this row"
                  aria-label={`Remove row ${i + 1}`}
                >
                  ×
                </button>
              </div>
            )
          })}
        </div>

        <div className="row-form spread">
          <button type="button" className="btn ghost" onClick={addRow}>+ Row</button>
          <div className="row-form">
            <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
            <button type="button" className="btn" onClick={submit} disabled={saving}>
              {saving ? 'Submitting…' : 'Submit for approval'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
