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
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import Select, { type SelectOption } from '../components/Select'
import { useAuth } from '../context/AuthContext'
import { useOverlayClose } from '../lib/useOverlayClose'
import { effectiveCapabilities, tagClass } from '../lib/tags'
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

// Bucket key for jobs with no tag, so the pivoted tables still give them a column.
const NO_TAG = '__none__'

/** Dropdown rows for the station and tier-tag pickers, shared by the create
 *  window, the edit window and the listing filters. */
function stationOptions(stations: Station[]): SelectOption[] {
  return stations.map((s) => ({ value: s.id, label: s.name }))
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
  const [showApprovals, setShowApprovals] = useState(false)
  // The masterlist is the module's front page; approvals sit behind it.
  const [tab, setTab] = useState<'approval' | 'master' | 'history'>('master')
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  async function load() {
    const [s, g, j, r] = await Promise.all([
      supabase.from('stations').select('id, name, sort_order').order('sort_order'),
      supabase.from('grades').select('*').order('sort_order'),
      supabase
        .from('jobs')
        .select('id, station_id, grade_id, name, unit, active, approval_status, verified_by, approved_by')
        .order('name'),
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
      <header className="module-head">
        <Link to="/" className="btn ghost module-back">← Back to main page</Link>
      </header>
      <h1>Piece Rate Module</h1>

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
          {tab !== 'history' && (canCreate || isApprover) && (
            <div className="row-form" style={{ justifyContent: 'flex-end' }}>
              {isApprover && (
                <button className="btn ghost badge-holder" onClick={() => setShowApprovals(true)}>
                  Approvals
                  {openApprovals.length > 0 && (
                    <span className="count-badge">{openApprovals.length}</span>
                  )}
                </button>
              )}
              {canCreate && (
                <button className="btn" onClick={() => setModal('create')}>+ Create new piece rate</button>
              )}
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
                  canManage={canManage}
                  canResubmit={canManage || canCreate || isApprover}
                  onEdit={(j) => setModal(j)}
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
              canManage={canManage}
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

      {showApprovals && (
        <ApprovalModal
          items={openApprovals}
          stations={stations}
          grades={grades}
          currentRate={latestRate}
          myEmail={profile?.email ?? 'unknown'}
          canVerify={canVerify}
          canFinal={canFinal}
          onClose={() => setShowApprovals(false)}
          onChanged={load}
          onError={setError}
        />
      )}

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
/* Approvals pop-out — two-step flow: a 'verify' approver checks the   */
/* proposal, then an 'approve' approver (management) makes it final.   */
/* ------------------------------------------------------------------ */

function ApprovalModal({
  items,
  stations,
  grades,
  currentRate,
  myEmail,
  canVerify,
  canFinal,
  onClose,
  onChanged,
  onError,
}: {
  items: Job[]
  stations: Station[]
  grades: Grade[]
  currentRate: Map<string, Rate>
  myEmail: string
  canVerify: boolean
  canFinal: boolean
  onClose: () => void
  onChanged: () => void
  onError: (m: string | null) => void
}) {
  const stationName = (id: string) => stations.find((s) => s.id === id)?.name ?? '?'
  const gradeName = (id: string | null) => grades.find((g) => g.id === id)?.name ?? null

  async function act(job: Job, fields: Partial<Job> & { approval_status: Job['approval_status'] }) {
    const { error } = await supabase.from('jobs').update(fields).eq('id', job.id)
    if (error) onError(error.message)
    else onChanged()
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

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
        <div className="row-form spread">
          <h2>New piece rate approval</h2>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>
        <p className="muted small">
          Flow: proposed → <strong>verified</strong> (checker) → <strong>approved</strong> (management).
        </p>

        {items.length === 0 ? (
          <p className="muted">Nothing waiting for approval.</p>
        ) : (
          items.map((j) => {
            const rate = currentRate.get(j.id)
            const tag = gradeName(j.grade_id)
            return (
              <div className="approval-item" key={j.id}>
                <div className="row-form spread">
                  <div>
                    <strong>{j.name}</strong>{' '}
                    {tag && <span className={tagClass(grades.find((g) => g.id === j.grade_id)?.color)}>{tag}</span>}
                    <div className="muted small">
                      {stationName(j.station_id)} · {j.unit} · proposed rate{' '}
                      <RateCell rate={rate} />
                      {rate && <> · effective {rate.effective_from}</>}
                    </div>
                    <div className="small approval-trail">
                      {j.approval_status === 'pending' && <span className="badge warn">waiting verification</span>}
                      {j.approval_status === 'verified' && <span className="badge warn">waiting approval</span>}
                      {j.verified_by && (
                        <span className="badge ok">verified by {j.verified_by}</span>
                      )}
                      {j.approved_by && (
                        <span className="badge ok">approved by {j.approved_by}</span>
                      )}
                    </div>
                  </div>
                  <div className="row-form">
                    {j.approval_status === 'pending' && canVerify && (
                      <button className="btn" onClick={() => verify(j)}>Verify</button>
                    )}
                    {j.approval_status === 'verified' && canFinal && (
                      <button className="btn" onClick={() => approve(j)}>Approve</button>
                    )}
                    {(canVerify || canFinal) && (
                      <button className="btn ghost danger" onClick={() => reject(j)}>Reject</button>
                    )}
                  </div>
                </div>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Pending Approval tracker — every piece rate not yet approved, so   */
/* creators and approvers can see where a submission stands.          */
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
  canManage,
  canResubmit,
  onEdit,
  onChanged,
  onError,
}: {
  stations: Station[]
  grades: Grade[]
  jobs: Job[]
  currentRate: Map<string, Rate>
  pendingCount: number
  canManage: boolean
  canResubmit: boolean
  onEdit: (j: Job) => void
  onChanged: () => void
  onError: (m: string | null) => void
}) {
  const [stationFilter, setStationFilter] = useState('')

  const stationName = (id: string) => stations.find((s) => s.id === id)?.name ?? '?'
  const gradeName = (id: string | null) => grades.find((g) => g.id === id)?.name ?? null

  async function remove(j: Job) {
    if (!window.confirm(`Delete "${j.name}"? This fails if it's already used in production or payroll records.`)) return
    const { error } = await supabase.from('jobs').delete().eq('id', j.id)
    if (error) onError(error.message)
    else onChanged()
  }

  // A rejected proposal goes back into the approval queue from the start.
  async function resubmit(j: Job) {
    const { error } = await supabase
      .from('jobs')
      .update({
        approval_status: 'pending',
        verified_by: null,
        verified_at: null,
        approved_by: null,
        approved_at: null,
      } as never)
      .eq('id', j.id)
    if (error) onError(error.message)
    else onChanged()
  }

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
              <th>Station</th>
              <th>Work description</th>
              <th>Position</th>
              <th>Unit</th>
              <th className="right">Proposed rate</th>
              <th>Effective date</th>
              <th>Status</th>
              {(canManage || canResubmit) && <th className="right">Actions</th>}
            </tr>
          </thead>
          <tbody>
            {list.length === 0 && (
              <tr>
                <td colSpan={canManage || canResubmit ? 8 : 7} className="muted">Nothing waiting for approval.</td>
              </tr>
            )}
            {list.map((j) => {
              const rate = currentRate.get(j.id)
              const tag = gradeName(j.grade_id)
              return (
                <tr key={j.id}>
                  <td>{stationName(j.station_id)}</td>
                  <td>{j.name}</td>
                  <td>{tag ? <span className={tagClass(grades.find((g) => g.id === j.grade_id)?.color)}>{tag}</span> : <span className="muted">—</span>}</td>
                  <td className="muted">{j.unit}</td>
                  <td className="right">
                    {rate ? <RateCell rate={rate} /> : <span className="badge off">no rate</span>}
                  </td>
                  <td className="muted">{rate ? rate.effective_from : '—'}</td>
                  <td><span className={STATUS_CLASS[j.approval_status]}>{STATUS_LABEL[j.approval_status]}</span></td>
                  {(canManage || canResubmit) && (
                    <td className="right">
                      {j.approval_status === 'rejected' && canResubmit && (
                        <>
                          <button className="linkbtn" onClick={() => resubmit(j)}>Resubmit</button>{' '}
                        </>
                      )}
                      {canManage && (
                        <>
                          <button className="linkbtn" onClick={() => onEdit(j)}>Edit</button>{' '}
                          <button className="linkbtn danger" onClick={() => remove(j)}>Delete</button>
                        </>
                      )}
                    </td>
                  )}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <p className="muted small">{list.length} submission(s) shown.</p>
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

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
        <div className="row-form spread">
          <h2>{jobs[0]?.name} — {stationName}</h2>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="stack">
          {jobs.map((j) => {
            const rate = currentRate.get(j.id)
            return (
              <div className="approval-item" key={j.id}>
                <div className="row-form spread">
                  <div>
                    <strong>{gradeName(j.grade_id)}</strong>{' '}
                    {!j.active && <span className="badge off">inactive</span>}
                    <div className="muted small">
                      {j.unit} · rate <RateCell rate={rate} />
                      {rate && <> · effective {rate.effective_from}</>}
                    </div>
                  </div>
                  <div className="row-form">
                    <button className="linkbtn" onClick={() => { onClose(); onEdit(j) }}>Edit</button>
                    {j.active ? (
                      <button className="linkbtn danger" onClick={() => setActive(j, false)}>Deactivate</button>
                    ) : (
                      <button className="linkbtn" onClick={() => setActive(j, true)}>Reactivate</button>
                    )}
                  </div>
                </div>
              </div>
            )
          })}
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
}: {
  value: string
  onChange: (v: string) => void
  ariaLabel: string
}) {
  const [custom, setCustom] = useState(value !== '' && !UNIT_SUGGESTIONS.includes(value))

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
  gradeId: string
  stationId: string
  description: string
  unit: string
  tiered: boolean
  rate: string
  tier2: string
  effectiveFrom: string
  /** Marked when this is the row that stopped the batch. */
  bad?: boolean
}

function isBlankRow(r: DraftRow) {
  return (
    !r.stationId && !r.gradeId && !r.description.trim() && !r.unit.trim() && !r.rate.trim()
  )
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
    gradeId: '',
    stationId: from?.stationId ?? '',
    description: '',
    unit: from?.unit ?? '',
    tiered: false,
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
      if (!r.stationId) return reject(r, `Row ${n}: choose a station tag.`)
      if (!r.description.trim()) return reject(r, `Row ${n}: enter the piece rate work description.`)
      if (!r.unit.trim()) return reject(r, `Row ${n}: choose a unit.`)
      const rateValue = Number(r.rate)
      if (r.rate.trim() === '' || Number.isNaN(rateValue) || rateValue < 0) {
        return reject(r, `Row ${n}: enter a valid non-negative piece rate.`)
      }
      if (r.tiered) {
        const t2 = Number(r.tier2)
        if (r.tier2.trim() === '' || Number.isNaN(t2) || t2 < 0) {
          return reject(r, `Row ${n}: enter a valid non-negative Tier 2 rate.`)
        }
      }
      if (!r.effectiveFrom) return reject(r, `Row ${n}: pick an effective date.`)
      const key = `${r.stationId}::${r.gradeId}::${r.description.trim().toLowerCase()}`
      if (seen.has(key)) {
        return reject(r, `Row ${n}: same tier tag, station tag and work description as an earlier row.`)
      }
      seen.add(key)
    }

    setSaving(true)
    const savedKeys: number[] = []
    let failure: { key: number; message: string } | null = null

    for (const r of filled) {
      const n = rows.indexOf(r) + 1
      // Every new contract waits for verify + approve, admins included.
      const { data, error: jobErr } = await supabase
        .from('jobs')
        .insert({
          station_id: r.stationId,
          grade_id: r.gradeId || null,
          name: r.description.trim(),
          unit: r.unit.trim(),
          approval_status: 'pending',
        })
        .select()
        .single()
      if (jobErr || !data) {
        failure = { key: r.key, message: `Row ${n}: ${saveMessage(jobErr?.message ?? 'could not be saved.')}` }
        break
      }
      const { error: rateErr } = await supabase.from('piece_rates').upsert(
        {
          job_id: data.id,
          rate: Number(r.rate),
          tier2_rate: r.tiered ? Number(r.tier2) : null,
          effective_from: r.effectiveFrom,
        },
        { onConflict: 'job_id,effective_from' },
      )
      if (rateErr) {
        // Take the contract back out, so the row can simply be sent again
        // instead of colliding with a half-made entry.
        await supabase.from('jobs').delete().eq('id', data.id)
        failure = { key: r.key, message: `Row ${n}: ${rateErr.message}` }
        break
      }
      savedKeys.push(r.key)
    }

    setSaving(false)
    if (!failure) return onSaved(filled.length)

    // Whatever went in is gone from the grid, so sending again can't
    // double it up; what is left is the row that stopped, and the rest.
    const stopped = failure
    setRows((rs) => {
      const left = rs.filter((r) => !savedKeys.includes(r.key))
      return left.length === 0 ? [blank()] : left.map((r) => ({ ...r, bad: r.key === stopped.key }))
    })
    setError(
      savedKeys.length > 0
        ? `${savedKeys.length} row(s) submitted, then it stopped. ${stopped.message}`
        : stopped.message,
    )
    if (savedKeys.length > 0) onReload()
  }

  return (
    <div className="modal-overlay" {...overlayProps}>
      <div className="modal modal-xwide">
        <div className="row-form spread">
          <h2>Create new piece rate</h2>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>
        <p className="muted small" style={{ margin: 0 }}>
          One line per rate — add as many as you need with “+ Row”. Every line is
          submitted for approval before it appears in the masterlist.
        </p>

        {error && <div className="error">{error}</div>}

        <div className="pr-grid">
          <div className="pr-grid-head">
            <span>Tier Tag</span>
            <span>Station Tag</span>
            <span>Piece Rate Work Description</span>
            <span>Unit</span>
            <span>Piece Rate (RM)</span>
            <span>Effective date</span>
            <span />
          </div>

          {rows.map((r, i) => (
            <div className={`pr-grid-row ${r.bad ? 'bad' : ''}`} key={r.key}>
              <div className="pr-cell">
                <span className="pr-cell-label">Tier Tag</span>
                <Select
                  block
                  value={r.gradeId}
                  onChange={(v) => patch(r.key, { gradeId: v })}
                  options={[{ value: '', label: 'All positions' }, ...tagOptions(grades)]}
                  placeholder="Choose tier tag…"
                  ariaLabel={`Row ${i + 1} tier tag`}
                />
              </div>

              <div className="pr-cell">
                <span className="pr-cell-label">Station Tag</span>
                <Select
                  block
                  value={r.stationId}
                  onChange={(v) => patch(r.key, { stationId: v })}
                  options={stationOptions(stations)}
                  placeholder="Choose station tag…"
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
                  value={r.unit}
                  onChange={(v) => patch(r.key, { unit: v })}
                  ariaLabel={`Row ${i + 1} unit`}
                />
              </div>

              <div className="pr-cell">
                <span className="pr-cell-label">Piece Rate (RM)</span>
                <div className="pr-rate-cell">
                  {r.tiered ? (
                    <div className="pr-tier-inputs">
                      <label>
                        <span>1st–4th /hr</span>
                        <input
                          inputMode="decimal"
                          value={r.rate}
                          onChange={(e) => patch(r.key, { rate: e.target.value })}
                          aria-label={`Row ${i + 1} tier 1 rate`}
                        />
                      </label>
                      <label>
                        <span>5th+ /hr</span>
                        <input
                          inputMode="decimal"
                          value={r.tier2}
                          onChange={(e) => patch(r.key, { tier2: e.target.value })}
                          aria-label={`Row ${i + 1} tier 2 rate`}
                        />
                      </label>
                    </div>
                  ) : (
                    <input
                      inputMode="decimal"
                      value={r.rate}
                      onChange={(e) => patch(r.key, { rate: e.target.value })}
                      aria-label={`Row ${i + 1} piece rate`}
                    />
                  )}
                  <button
                    type="button"
                    className="pr-tier-toggle"
                    onClick={() => patch(r.key, { tiered: !r.tiered, tier2: '' })}
                  >
                    {r.tiered ? 'Flat rate' : 'Tiered by hour'}
                  </button>
                </div>
              </div>

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
          ))}
        </div>

        <div className="row-form spread">
          <button type="button" className="btn ghost" onClick={addRow}>+ Row</button>
          <div className="row-form">
            <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
            <button type="button" className="btn" onClick={submit} disabled={saving}>
              {saving
                ? 'Submitting…'
                : filled.length > 1
                  ? `Submit ${filled.length} rates for approval`
                  : 'Submit for approval'}
            </button>
          </div>
        </div>

        <p className="small muted" style={{ margin: 0 }}>
          Tiered by hour: every hour resets — the first 4 units done pay Tier 1,
          the 5th unit onward that same hour pays Tier 2. Payroll uses whichever
          rate is effective on the day worked.
        </p>
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
  const [unit, setUnit] = useState(job.unit)
  const [rate, setRate] = useState(currentRate ? String(Number(currentRate.rate)) : '')
  const [tiered, setTiered] = useState(currentRate?.tier2_rate != null)
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
        unit: unit.trim() || 'unit',
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

  return (
    <div className="modal-overlay" {...overlayProps}>
      <form className="modal" onSubmit={save}>
        <div className="row-form spread">
          <h2>Edit piece rate</h2>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        {error && <div className="error">{error}</div>}

        {/* A <label> is not used around these two: they are buttons, and a
            label forwards its own click to the control it wraps, which
            would toggle the dropdown straight back shut. */}
        <div className="field">
          <span>Tier Tag</span>
          <Select
            block
            value={gradeId}
            onChange={setGradeId}
            options={[{ value: '', label: 'All positions' }, ...tagOptions(grades)]}
            placeholder="Choose tier tag…"
            ariaLabel="Tier tag"
          />
        </div>

        <div className="field">
          <span>Station Tag</span>
          <Select
            block
            value={stationId}
            onChange={setStationId}
            options={stationOptions(stations)}
            placeholder="Choose station tag…"
            ariaLabel="Station tag"
          />
        </div>

        <label className="field">
          <span>Piece Rate Work Description</span>
          <input value={description} onChange={(e) => setDescription(e.target.value)} required />
        </label>

        <div className="field">
          <span>Unit</span>
          <UnitPicker value={unit} onChange={setUnit} ariaLabel="Unit" />
        </div>

        <div className="tiered-toggle">
          <button type="button" className={!tiered ? 'active' : ''} onClick={() => setTiered(false)}>
            Flat rate
          </button>
          <button type="button" className={tiered ? 'active' : ''} onClick={() => setTiered(true)}>
            Tiered by hour
          </button>
        </div>

        {tiered ? (
          <div className="row-form">
            <label className="field inline grow">
              <span>Tier 1 — 1st to 4th /hr</span>
              <input
                inputMode="decimal"
                value={rate}
                onChange={(e) => setRate(e.target.value)}
                required
              />
            </label>
            <label className="field inline grow">
              <span>Tier 2 — 5th onward /hr</span>
              <input
                inputMode="decimal"
                value={tier2}
                onChange={(e) => setTier2(e.target.value)}
                required
              />
            </label>
          </div>
        ) : (
          <label className="field">
            <span>Piece Rate (RM)</span>
            <input
              inputMode="decimal"
              value={rate}
              onChange={(e) => setRate(e.target.value)}
              required
            />
          </label>
        )}
        {tiered && (
          <p className="small muted" style={{ margin: 0 }}>
            Every hour resets: the first 4 units done pay Tier 1, the 5th unit
            onward that same hour pays Tier 2 — then it starts over next hour.
          </p>
        )}

        <label className="field">
          <span>Effective date</span>
          <input
            type="date"
            value={effectiveFrom}
            onChange={(e) => setEffectiveFrom(e.target.value)}
            required
          />
          <span className="small">Payroll uses whichever rate is effective on the day worked.</span>
        </label>

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
