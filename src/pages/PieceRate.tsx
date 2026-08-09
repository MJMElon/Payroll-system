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
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import Select, { MultiSelect, type SelectOption } from '../components/Select'
import { useAuth } from '../context/AuthContext'
import { useOverlayClose } from '../lib/useOverlayClose'
import { effectiveCapabilities, isEntitled, tagClass } from '../lib/tags'
import {
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
  const [modal, setModal] = useState<'closed' | 'create' | Job>('closed')
  // The masterlist is what the module is FOR, so it leads and opens first;
  // approvals and history follow it.
  const [tab, setTab] = useState<'master' | 'approval' | 'history'>('master')
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

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
    <div className="stack">
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
              onEdit={(j) => setModal(j)}
              onChanged={load}
              onError={setError}
            />
          ) : (
            <HistoryList
              stations={stations}
              grades={grades}
              jobs={jobs.filter(visibleTo)}
              rates={rates}
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

      {modal !== 'closed' && modal !== 'create' && (
        <ContractModal
          stations={stations}
          grades={grades}
          job={modal}
          currentRate={latestRate.get(modal.id) ?? null}
          onClose={() => setModal('closed')}
          onSaved={(submitted) => {
            setModal('closed')
            setNotice(submitted ? 'Piece rate submitted — waiting for approval.' : null)
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

// The Master/History pivot only ever shows these three positions, in this
// order — other tags (e.g. Management, Manager, Engineer) are left out.
const MASTER_TAG_ORDER = ['Operator', 'Assistant Station Head', 'Station Head']

/** One pivoted column per tag in MASTER_TAG_ORDER that exists in `grades`,
 *  plus a column for any OTHER tag actually used by the listed jobs (custom
 *  tags, Engineer, …), plus "All positions" when a job carries no tag. */
function tagColumns(grades: Grade[], jobs?: Job[]): { key: string; label: string }[] {
  const byName = new Map(grades.map((g) => [g.name, g]))
  const cols = MASTER_TAG_ORDER
    .map((name) => byName.get(name))
    .filter((g): g is Grade => Boolean(g))
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

/** One question before the pen moves: shows the proposal being acted on
 *  and asks for a yes. Approving and verifying also offer Reject here, so
 *  a checker who spots a wrong rate turns it away in the same window. */
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
  const grade = grades.find((g) => g.id === job.grade_id)
  const tiered = rate?.tier2_rate != null
  const titles = {
    verify: 'Verify this piece rate?',
    approve: 'Approve this piece rate?',
    reject: 'Reject this piece rate?',
  }
  const yes = { verify: 'Yes, verify', approve: 'Yes, approve', reject: 'Yes, reject' }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="row-form spread">
          <h2>{titles[mode]}</h2>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        <div className="stack" style={{ gap: '0.4rem' }}>
          <div className="view-row">
            <span className="view-label">Tier</span>
            <span className="view-value">
              {grade ? <span className={tagClass(grade.color)}>{grade.name}</span> : 'All positions'}
            </span>
          </div>
          <div className="view-row">
            <span className="view-label">Station</span>
            <span className="view-value">{stationName}</span>
          </div>
          <div className="view-row">
            <span className="view-label">Work description</span>
            <span className="view-value">{job.name}</span>
          </div>
          {tiered ? (
            <>
              <div className="view-row">
                <span className="view-label">Tier 1 — 1st to 4th /hr</span>
                <span className="view-value">RM {Number(rate!.rate).toFixed(2)}</span>
              </div>
              <div className="view-row">
                <span className="view-label">Tier 2 — 5th onward /hr</span>
                <span className="view-value">RM {Number(rate!.tier2_rate).toFixed(2)}</span>
              </div>
            </>
          ) : (
            <div className="view-row">
              <span className="view-label">Proposed rate</span>
              <span className="view-value">{rate ? `RM ${Number(rate.rate).toFixed(2)}` : '—'}</span>
            </div>
          )}
          <div className="view-row">
            <span className="view-label">Unit</span>
            <span className="view-value">{job.unit}</span>
          </div>
          <div className="view-row">
            <span className="view-label">Effective date</span>
            <span className="view-value">{rate ? rate.effective_from : '—'}</span>
          </div>
        </div>

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

  const grade = grades.find((g) => g.id === job.grade_id)
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

  const Row = ({ label, children }: { label: string; children: ReactNode }) => (
    <div className="view-row">
      <span className="view-label">{label}</span>
      <span className="view-value">{children}</span>
    </div>
  )

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="row-form spread">
          <h2>Piece rate details</h2>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        <div className="stack" style={{ gap: '0.4rem' }}>
          <Row label="Tier">
            {grade ? <span className={tagClass(grade.color)}>{grade.name}</span> : 'All positions'}
          </Row>
          <Row label="Station">{stationName}</Row>
          <Row label="Work description">{job.name}</Row>
          {tiered ? (
            <>
              <Row label="Tier 1 — 1st to 4th /hr">RM {Number(rate!.rate).toFixed(2)}</Row>
              <Row label="Tier 2 — 5th onward /hr">RM {Number(rate!.tier2_rate).toFixed(2)}</Row>
            </>
          ) : (
            <Row label="Proposed rate">
              {rate ? `RM ${Number(rate.rate).toFixed(2)}` : '—'}
            </Row>
          )}
          <Row label="Unit">{job.unit}</Row>
          <Row label="Effective date">{rate ? rate.effective_from : '—'}</Row>
          <Row label="Status">
            <span className={STATUS_CLASS[job.approval_status]}>{STATUS_LABEL[job.approval_status]}</span>
          </Row>
          {job.verified_by && <Row label="Verified by">{job.verified_by}</Row>}
          {job.approved_by && <Row label="Approved by">{job.approved_by}</Row>}
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
  onEdit,
  onChanged,
  onError,
}: {
  stations: Station[]
  grades: Grade[]
  jobs: Job[]
  currentRate: Map<string, Rate>
  canManage: boolean
  onEdit: (j: Job) => void
  onChanged: () => void
  onError: (m: string | null) => void
}) {
  const [stationFilter, setStationFilter] = useState('')
  const [search, setSearch] = useState('')
  const [showInactive, setShowInactive] = useState(false)
  const [manageGroup, setManageGroup] = useState<JobGroup | null>(null)

  const stationName = (id: string) => stations.find((s) => s.id === id)?.name ?? '?'

  const filtered = jobs
    .filter((j) => (showInactive ? true : j.active))
    .filter((j) => (stationFilter ? j.station_id === stationFilter : true))
    .filter((j) => (search.trim() ? j.name.toLowerCase().includes(search.trim().toLowerCase()) : true))

  const groups = groupJobs(filtered).sort(
    (a, b) => stationName(a.station_id).localeCompare(stationName(b.station_id)) || a.name.localeCompare(b.name),
  )
  const tagCols = tagColumns(grades, filtered)
  const colCount = 3 + tagCols.length + 2 + (canManage ? 1 : 0)

  // Download the visible masterlist as CSV (opens directly in Excel).
  function exportCsv() {
    const esc = (v: string) => `"${v.replace(/"/g, '""')}"`
    const head = ['Station', 'Work description', 'Unit', ...tagCols.map((c) => `${c.label} (RM)`), 'Effective date', 'Status']
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
        g.jobs.some((j) => j.active) ? 'Active' : 'Inactive',
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
              <th>Status</th>
              {canManage && <th className="right">Actions</th>}
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
              const rowActive = g.jobs.some((j) => j.active)
              const dates = g.jobs
                .map((j) => currentRate.get(j.id)?.effective_from)
                .filter((d): d is string => Boolean(d))
                .sort()
              const effectiveDate = dates.length ? dates[dates.length - 1] : null
              return (
                <tr key={groupKey(g)} className={rowActive ? '' : 'muted'}>
                  <td>{stationName(g.station_id)}</td>
                  <td>{g.name}{!rowActive && ' (inactive)'}</td>
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
                  <td>{rowActive ? <span className="badge ok">Active</span> : <span className="badge off">Inactive</span>}</td>
                  {canManage && (
                    <td className="right">
                      <button className="linkbtn" onClick={() => setManageGroup(g)}>Manage</button>
                    </td>
                  )}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <div className="row-form spread">
        <p className="muted small">{groups.length} work item(s) shown.</p>
        <label className="small muted checkbox">
          <input
            type="checkbox"
            checked={showInactive}
            onChange={(e) => setShowInactive(e.target.checked)}
          />{' '}
          Show inactive
        </label>
      </div>

      {manageGroup && (
        <GroupManageModal
          jobs={manageGroup.jobs}
          stationName={stationName(manageGroup.station_id)}
          grades={grades}
          currentRate={currentRate}
          onEdit={onEdit}
          onChanged={onChanged}
          onError={onError}
          onClose={() => setManageGroup(null)}
        />
      )}
    </div>
  )
}

/** Per-tag detail behind a Master row's "Manage" action — same edit/deactivate
 *  controls the listing used to expose per row, one line per tag/position. */
function GroupManageModal({
  jobs,
  stationName,
  grades,
  currentRate,
  onEdit,
  onChanged,
  onError,
  onClose,
}: {
  jobs: Job[]
  stationName: string
  grades: Grade[]
  currentRate: Map<string, Rate>
  onEdit: (j: Job) => void
  onChanged: () => void
  onError: (m: string | null) => void
  onClose: () => void
}) {
  const gradeName = (id: string | null) => grades.find((g) => g.id === id)?.name ?? 'No tag'

  async function setActive(job: Job, active: boolean) {
    const { error } = await supabase.from('jobs').update({ active }).eq('id', job.id)
    if (error) onError(error.message)
    else onChanged()
  }

  /** Tick on: the mobile "Choose job" list offers this contract. Tick off:
   *  an incentive/support rate — priced for payroll, never submitted. */
  async function setRecordJob(job: Job, on: boolean) {
    const { error } = await supabase.from('jobs').update({ record_job: on }).eq('id', job.id)
    if (error) {
      onError(
        /record_job/i.test(error.message)
          ? 'The database is missing the record_job column — run the latest supabase/setup.sql ' +
            '(or just: alter table public.jobs add column record_job boolean not null default true;).'
          : error.message,
      )
    } else onChanged()
  }

  // One column per tier tag that is paid for this work, so the whole
  // contract reads across in one look: the tiers along the top, and what
  // each of them is paid down the rows beneath.
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
        <div className="row-form spread">
          <h2>{stationName} — Job : {jobs[0]?.name}</h2>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        <div className="table-scroll">
          <table className="table pr-manage">
            <thead>
              <tr>
                <th className="pr-manage-corner">{jobs[0]?.name}</th>
                {jobs.map((j) => (
                  <th key={j.id}>
                    <span className={tagClass(grades.find((g) => g.id === j.grade_id)?.color)}>
                      {gradeName(j.grade_id)}
                    </span>
                    {!j.active && <> <span className="badge off">inactive</span></>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row">Rate</th>
                {jobs.map((j) => (
                  <td key={j.id}>
                    <RateCell rate={currentRate.get(j.id)} />
                    <div className="muted small">{j.unit}</div>
                  </td>
                ))}
              </tr>
              <tr>
                <th scope="row">Effective date</th>
                {jobs.map((j) => (
                  <td key={j.id}>
                    {currentRate.get(j.id)?.effective_from ?? <span className="muted">—</span>}
                  </td>
                ))}
              </tr>
              <tr>
                <th scope="row">
                  Job record
                  <div className="muted small">Appears in the mobile “Choose job” list</div>
                </th>
                {jobs.map((j) => (
                  <td key={j.id}>
                    <label
                      className="checkbox"
                      style={{ margin: 0 }}
                      title="Untick for an incentive or support rate — paid through payroll, never submitted as a work record."
                    >
                      <input
                        type="checkbox"
                        checked={j.record_job !== false}
                        onChange={(e) => setRecordJob(j, e.target.checked)}
                      />
                    </label>
                  </td>
                ))}
              </tr>
              <tr>
                <th scope="row" />
                {jobs.map((j) => (
                  <td key={j.id}>
                    <div className="row-form">
                      <button className="linkbtn" onClick={() => { onClose(); onEdit(j) }}>Edit</button>
                      {j.active ? (
                        <button className="linkbtn danger" onClick={() => setActive(j, false)}>Deactivate</button>
                      ) : (
                        <button className="linkbtn" onClick={() => setActive(j, true)}>Reactivate</button>
                      )}
                    </div>
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
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
  const approved = jobs.filter((j) => j.approval_status === 'approved')
  const groups = groupJobs(approved)

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
}: {
  stations: Station[]
  grades: Grade[]
  jobs: Job[]
  rates: Rate[]
}) {
  const [stationFilter, setStationFilter] = useState('')
  const [search, setSearch] = useState('')

  const stationName = (id: string) => stations.find((s) => s.id === id)?.name ?? '?'

  const filteredJobs = jobs
    .filter((j) => (stationFilter ? j.station_id === stationFilter : true))
    .filter((j) => (search.trim() ? j.name.toLowerCase().includes(search.trim().toLowerCase()) : true))

  const groups = buildHistory(filteredJobs, rates).sort(
    (a, b) => stationName(a.station_id).localeCompare(stationName(b.station_id)) || a.name.localeCompare(b.name),
  )
  const tagCols = tagColumns(grades, filteredJobs)
  const colCount = 5 + tagCols.length + 1
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
                    {row.status === 'current' && <span className="badge ok">Current</span>}
                    {row.status === 'scheduled' && <span className="badge off">Scheduled</span>}
                    {row.status === 'inactive' && <span className="badge off">Inactive</span>}
                  </td>
                </tr>
              )),
            )}
          </tbody>
        </table>
      </div>
      <p className="muted small">{rowCount} rate change(s) across {groups.length} work item(s).</p>
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
    ? 'A piece rate already exists for this exact Tier tag + Station tag + work description — edit that one instead (tick "Show inactive" if it might be hidden).'
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
  /** Offer "Tiered by hour" in the list — the create window's two hourly
   *  columns hang off it. The edit window has its own tier switch. */
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

/* ------------------------------------------------------------------ */
/* Edit window — one existing contract at a time                      */
/* ------------------------------------------------------------------ */

function ContractModal({
  stations,
  grades,
  job,
  currentRate,
  onClose,
  onSaved,
}: {
  stations: Station[]
  grades: Grade[]
  job: Job
  currentRate: Rate | null
  onClose: () => void
  onSaved: (submittedForApproval: boolean) => void
}) {
  const overlayProps = useOverlayClose(onClose)
  const [stationId, setStationId] = useState(job.station_id)
  const [gradeId, setGradeId] = useState(job.grade_id ?? '')
  const [description, setDescription] = useState(job.name)
  // Same convention as the create window: paid by the hour is a UNIT choice,
  // not a separate switch, so the two windows are filled in the same way.
  const [unit, setUnit] = useState(currentRate?.tier2_rate != null ? TIERED : job.unit)
  const tiered = unit === TIERED
  const [rate, setRate] = useState(currentRate ? String(Number(currentRate.rate)) : '')
  const [tier2, setTier2] = useState(
    currentRate?.tier2_rate != null ? String(Number(currentRate.tier2_rate)) : '',
  )
  const [effectiveFrom, setEffectiveFrom] = useState(currentRate?.effective_from ?? todayISO())
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  async function save(e: FormEvent) {
    e.preventDefault()
    setError(null)
    if (!stationId) return setError('Choose a station tag.')
    if (!description.trim()) return setError('Enter the piece rate work description.')
    const rateValue = Number(rate)
    if (rate.trim() === '' || Number.isNaN(rateValue) || rateValue < 0) {
      return setError('Enter a valid non-negative rate.')
    }
    const tier2Value = tiered ? Number(tier2) : null
    if (tiered && (tier2.trim() === '' || Number.isNaN(tier2Value) || (tier2Value as number) < 0)) {
      return setError('Enter a valid non-negative Tier 2 rate.')
    }
    if (!effectiveFrom) {
      return setError('Pick an effective date.')
    }
    setSaving(true)
    try {
      let submitted = false
      const fields = {
        station_id: stationId,
        grade_id: gradeId || null,
        name: description.trim(),
        // Tiered work is stored as "/hour" — the tiering itself lives in
        // the rate row's tier2_rate, exactly as the create window writes it.
        unit: tiered ? '/hour' : unit.trim() || 'unit',
      }
      // Only send the identity fields (station/tag/description/unit) when
      // one actually changed — Postgres re-checks the station+tag+name
      // uniqueness constraint against every other row whenever an UPDATE
      // touches those columns, even to the same value, so resaving just
      // the rate on an unrelated field would otherwise fail if some other
      // job happens to share that combination.
      const identityChanged =
        fields.station_id !== job.station_id ||
        fields.grade_id !== job.grade_id ||
        fields.name !== job.name ||
        fields.unit !== job.unit
      if (identityChanged) {
        const { error } = await supabase.from('jobs').update(fields).eq('id', job.id)
        if (error) throw new Error(saveMessage(error.message))
      }
      const unchanged =
        currentRate &&
        Number(currentRate.rate) === rateValue &&
        (currentRate.tier2_rate ?? null) === tier2Value &&
        currentRate.effective_from === effectiveFrom
      if (!unchanged) {
        const { error } = await supabase
          .from('piece_rates')
          .upsert(
            { job_id: job.id, rate: rateValue, tier2_rate: tier2Value, effective_from: effectiveFrom },
            { onConflict: 'job_id,effective_from' },
          )
        if (error) throw new Error(error.message)
        // A price change on an APPROVED contract must go through verify +
        // approve again — otherwise editing the rate would bypass the flow.
        if (job.approval_status === 'approved') {
          submitted = true
          const { error: reErr } = await supabase
            .from('jobs')
            .update({
              approval_status: 'pending',
              verified_by: null,
              verified_at: null,
              approved_by: null,
              approved_at: null,
            } as never)
            .eq('id', job.id)
          if (reErr) throw new Error(reErr.message)
        }
      }
      onSaved(submitted)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  // Laid out as ONE row of the create window's grid, column for column, so
  // editing a rate is filled in the same way it was written.
  return (
    <div className="modal-overlay" {...overlayProps}>
      <form className={`modal modal-xwide ${tiered ? 'tiered' : ''}`} onSubmit={save}>
        <div className="row-form spread">
          <h2>Edit piece rate</h2>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        {error && <div className="error">{error}</div>}

        <div className={`pr-grid ${tiered ? 'tiered' : ''}`}>
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
            <div className="pr-cell">
              <span className="pr-cell-label">Tier Tag</span>
              <Select
                block
                value={gradeId}
                onChange={setGradeId}
                options={[
                  { value: '', label: 'All positions' },
                  ...tierTagOptions(grades, job.grade_id),
                ]}
                placeholder="Choose tier tag"
                ariaLabel="Tier tag"
              />
            </div>

            <div className="pr-cell">
              <span className="pr-cell-label">Station Tag</span>
              <Select
                block
                value={stationId}
                onChange={setStationId}
                options={stationOptions(stations)}
                placeholder="Choose station tag"
                ariaLabel="Station tag"
              />
            </div>

            <div className="pr-cell wide">
              <span className="pr-cell-label">Piece Rate Work Description</span>
              <input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                aria-label="Piece rate work description"
              />
            </div>

            <div className="pr-cell">
              <span className="pr-cell-label">Unit</span>
              <UnitPicker
                allowTiered
                value={unit}
                onChange={(v) => setUnit(v)}
                ariaLabel="Unit"
              />
            </div>

            <div className="pr-cell">
              <span className="pr-cell-label">Piece Rate (RM)</span>
              {tiered ? (
                <span className="pr-none">—</span>
              ) : (
                <input
                  inputMode="decimal"
                  value={rate}
                  onChange={(e) => setRate(e.target.value)}
                  aria-label="Piece rate"
                />
              )}
            </div>

            {tiered && (
              <>
                <div className="pr-cell">
                  <span className="pr-cell-label">Tier 1 — 1st to 4th /hr</span>
                  <input
                    inputMode="decimal"
                    value={rate}
                    onChange={(e) => setRate(e.target.value)}
                    aria-label="Tier 1 rate"
                  />
                </div>
                <div className="pr-cell">
                  <span className="pr-cell-label">Tier 2 — 5th onward /hr</span>
                  <input
                    inputMode="decimal"
                    value={tier2}
                    onChange={(e) => setTier2(e.target.value)}
                    aria-label="Tier 2 rate"
                  />
                </div>
              </>
            )}

            <div className="pr-cell">
              <span className="pr-cell-label">Effective date</span>
              <input
                type="date"
                value={effectiveFrom}
                onChange={(e) => setEffectiveFrom(e.target.value)}
                aria-label="Effective date"
              />
            </div>

            <span />
          </div>
        </div>

        {tiered && (
          <p className="small muted" style={{ margin: 0 }}>
            Every hour resets: the first 4 units done pay Tier 1, the 5th unit
            onward that same hour pays Tier 2 — then it starts over next hour.
          </p>
        )}
        <p className="small muted" style={{ margin: 0 }}>
          Payroll uses whichever rate is effective on the day worked.
        </p>

        <div className="row-form" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn" type="submit" disabled={saving}>
            {saving ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </form>
    </div>
  )
}
