// ---------------------------------------------------------------------------
// PIECE RATE MODULE — fully self-contained in this one file.
//
// A piece-rate contract is the mix-and-match of STATION × TAG (grade) × WORK
// DESCRIPTION, each with its own unit and rate. Every new contract — admin
// submissions included — waits in the Approvals queue until a 'verify'
// capability holder checks it, then an 'approve' capability holder (or an
// admin, who can do either step) signs off. The page has three sidebar
// sections: Pending Piece Rate Approval (submissions not yet approved),
// Piece Rate Master (approved contracts, pivoted so each tag/position is
// its own column for a station + work description), and Piece Rate History
// (past rate changes for approved contracts, derived from piece_rates rows
// — no separate history table). Everyone can open the listing, but
// non-managers only see rates for their own grade tier and below (tier =
// the tag's order in Settings).
// Tables used: stations, grades, jobs, piece_rates (see supabase/setup.sql).
// ---------------------------------------------------------------------------
import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { tagClass } from '../lib/tags'
import {
  supabase,
  todayISO,
  type Grade,
  type Job,
  type PieceRate as Rate,
  type Station,
} from '../lib/supabase'

const UNIT_SUGGESTIONS = ['/cage tipped', '/job done', '/tonne', '/bunch', '/trip', '/hour']

// Bucket key for jobs with no tag, so the pivoted tables still give them a column.
const NO_TAG = '__none__'

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
  const [tab, setTab] = useState<'approval' | 'master' | 'history'>('approval')
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
        .select('id, job_id, rate, effective_from')
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

  // Approval rights follow the tag's standardized capabilities (Settings →
  // Tags management). Admins can do both.
  const myCaps = (profile?.grade_id
    ? grades.find((g) => g.id === profile.grade_id)?.capabilities
    : null) ?? []
  const canVerify = isAdmin || myCaps.includes('verify')
  const canFinal = isAdmin || myCaps.includes('approve')
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
      <div>
        <Link to="/" className="small muted backlink">← Back to main page</Link>
        <h1>Piece Rate Management</h1>
      </div>

      {error && <div className="error">{error}</div>}
      {notice && <div className="notice">{notice}</div>}

      <div className="sidebar-layout">
        <nav className="sidebar-nav">
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
            className={`sidebar-link ${tab === 'master' ? 'active' : ''}`}
            onClick={() => setTab('master')}
          >
            <IconMaster />
            <span>Piece Rate Masterlist</span>
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
          {tab === 'approval' ? (
            <>
              <div className="row-form" style={{ justifyContent: 'flex-end' }}>
                {isApprover && (
                  <button className="btn ghost badge-holder" onClick={() => setShowApprovals(true)}>
                    Approvals
                    {openApprovals.length > 0 && (
                      <span className="count-badge">{openApprovals.length}</span>
                    )}
                  </button>
                )}
                {canManage && (
                  <button className="btn" onClick={() => setModal('create')}>+ Create new piece rate</button>
                )}
              </div>

              {canManage || isApprover ? (
                <SubmissionsList
                  stations={stations}
                  grades={grades}
                  jobs={notYetApproved}
                  currentRate={latestRate}
                  pendingCount={openApprovals.length}
                  canManage={canManage}
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

      {modal !== 'closed' && (
        <ContractModal
          stations={stations}
          grades={grades}
          job={modal === 'create' ? null : modal}
          currentRate={modal === 'create' ? null : latestRate.get(modal.id) ?? null}
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
/* Grouping helpers — shared by Piece Rate Master and History, which  */
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

/** One pivoted column per tag present in `jobs`, plus a "No tag" column if needed. */
function tagColumns(grades: Grade[], jobs: Job[]): { key: string; label: string }[] {
  const cols = grades.map((g) => ({ key: g.id, label: g.name }))
  if (jobs.some((j) => j.grade_id === null)) cols.push({ key: NO_TAG, label: 'No tag' })
  return cols
}

function addDays(dateStr: string, delta: number) {
  const d = new Date(`${dateStr}T00:00:00`)
  d.setDate(d.getDate() + delta)
  return d.toISOString().slice(0, 10)
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
  const reject = (j: Job) => act(j, { approval_status: 'rejected' })

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
                      <strong>{rate ? Number(rate.rate).toFixed(2) : '—'}</strong>
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
        <select
          className="filter-select"
          value={stationFilter}
          onChange={(e) => setStationFilter(e.target.value)}
          title="Filter by station"
        >
          <option value="">All stations</option>
          {stations.map((s) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>
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
              {canManage && <th className="right">Actions</th>}
            </tr>
          </thead>
          <tbody>
            {list.length === 0 && (
              <tr>
                <td colSpan={canManage ? 8 : 7} className="muted">Nothing waiting for approval.</td>
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
                    {rate ? <strong>{Number(rate.rate).toFixed(2)}</strong> : <span className="badge off">no rate</span>}
                  </td>
                  <td className="muted">{rate ? rate.effective_from : '—'}</td>
                  <td><span className={STATUS_CLASS[j.approval_status]}>{STATUS_LABEL[j.approval_status]}</span></td>
                  {canManage && (
                    <td className="right">
                      <button className="linkbtn" onClick={() => onEdit(j)}>Edit</button>{' '}
                      <button className="linkbtn danger" onClick={() => remove(j)}>Delete</button>
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
/* Piece Rate Master — approved contracts, pivoted so each tag/        */
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

  return (
    <div className="card stack">
      <div className="row-form spread">
        <h3>Piece Rate Master</h3>
        <div className="row-form">
          <select
            className="filter-select"
            value={stationFilter}
            onChange={(e) => setStationFilter(e.target.value)}
            title="Filter by station"
          >
            <option value="">All stations</option>
            {stations.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
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
                        {rate ? <strong>{Number(rate.rate).toFixed(2)}</strong> : <span className="muted">—</span>}
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
                      {j.unit} · rate <strong>{rate ? Number(rate.rate).toFixed(2) : '—'}</strong>
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
          <select
            className="filter-select"
            value={stationFilter}
            onChange={(e) => setStationFilter(e.target.value)}
            title="Filter by station"
          >
            <option value="">All stations</option>
            {stations.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
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
                        {rate ? <strong>{Number(rate.rate).toFixed(2)}</strong> : <span className="muted">—</span>}
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
/* Floating create/edit window                                        */
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
  job: Job | null
  currentRate: Rate | null
  onClose: () => void
  onSaved: (submittedForApproval: boolean) => void
}) {
  const [stationId, setStationId] = useState(job?.station_id ?? '')
  const [gradeId, setGradeId] = useState(job?.grade_id ?? '')
  const [description, setDescription] = useState(job?.name ?? '')
  const [unit, setUnit] = useState(job?.unit ?? '')
  const [rate, setRate] = useState(currentRate ? String(Number(currentRate.rate)) : '')
  const [effectiveFrom, setEffectiveFrom] = useState(currentRate?.effective_from ?? todayISO())
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  async function save(e: FormEvent) {
    e.preventDefault()
    setError(null)
    const rateValue = Number(rate)
    if (rate.trim() === '' || Number.isNaN(rateValue) || rateValue < 0) {
      return setError('Enter a valid non-negative rate.')
    }
    if (!effectiveFrom) {
      return setError('Pick an effective date.')
    }
    setSaving(true)
    try {
      let jobId = job?.id
      let submitted = false
      const fields = {
        station_id: stationId,
        grade_id: gradeId || null,
        name: description.trim(),
        unit: unit.trim() || 'unit',
      }
      if (job) {
        const { error } = await supabase.from('jobs').update(fields).eq('id', job.id)
        if (error) throw new Error(error.message)
      } else {
        // Every new contract waits for verify + approve, admins included.
        submitted = true
        const { data, error } = await supabase
          .from('jobs')
          .insert({ ...fields, approval_status: 'pending' })
          .select()
          .single()
        if (error) throw new Error(error.message)
        jobId = data.id
      }
      const unchanged =
        job && currentRate && Number(currentRate.rate) === rateValue && currentRate.effective_from === effectiveFrom
      if (jobId && !unchanged) {
        const { error } = await supabase
          .from('piece_rates')
          .upsert(
            { job_id: jobId, rate: rateValue, effective_from: effectiveFrom },
            { onConflict: 'job_id,effective_from' },
          )
        if (error) throw new Error(error.message)
      }
      onSaved(submitted)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={save}>
        <div className="row-form spread">
          <h2>{job ? 'Edit piece rate' : 'Create new piece rate'}</h2>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        {error && <div className="error">{error}</div>}
        {!job && (
          <p className="muted small">
            New piece rates are submitted for approval before they appear in the list.
          </p>
        )}

        <label className="field">
          <span>Station</span>
          <select value={stationId} onChange={(e) => setStationId(e.target.value)} required>
            <option value="">Pick a station…</option>
            {stations.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        </label>

        <label className="field">
          <span>Tag (who this rate belongs to)</span>
          <select value={gradeId} onChange={(e) => setGradeId(e.target.value)}>
            <option value="">No tag</option>
            {grades.map((g) => (
              <option key={g.id} value={g.id}>{g.name}</option>
            ))}
          </select>
          <span className="small">Tags are managed in Settings → Tags.</span>
        </label>

        <label className="field">
          <span>Work description</span>
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="e.g. Tipping sterilizer cage"
            required
          />
        </label>

        <label className="field">
          <span>Unit</span>
          <input
            list="unit-suggestions"
            value={unit}
            onChange={(e) => setUnit(e.target.value)}
            placeholder="e.g. /cage tipped, /job done"
            required
          />
          <datalist id="unit-suggestions">
            {UNIT_SUGGESTIONS.map((u) => (
              <option key={u} value={u} />
            ))}
          </datalist>
        </label>

        <label className="field">
          <span>Rate</span>
          <input
            inputMode="decimal"
            value={rate}
            onChange={(e) => setRate(e.target.value)}
            placeholder="0.00"
            required
          />
        </label>

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
            {saving ? 'Saving…' : job ? 'Save changes' : 'Submit for approval'}
          </button>
        </div>
      </form>
    </div>
  )
}
