// ---------------------------------------------------------------------------
// PIECE RATE MODULE — fully self-contained in this one file.
//
// A piece-rate contract is the mix-and-match of STATION × TAG (grade) × WORK
// DESCRIPTION, each with its own unit and rate. New contracts wait in the
// "New piece rate approval" section until a user with the per-user approval
// permission (Settings → User access) or an admin approves them. Everyone can
// open the listing, but non-managers only see rates for their own grade tier
// and below (tier = the tag's order in Settings). Station and Tag column
// headers are themselves dropdown filters.
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

  if (loading) return <p className="muted">Loading…</p>

  const openApprovals = jobs.filter(
    (j) => j.approval_status === 'pending' || j.approval_status === 'verified',
  )

  // Managers/admins see every contract. Others are scoped two ways:
  // 1. Station — a user with a station tag only sees their own station.
  // 2. Tier — tier 1 is highest; a user sees their tier and every tier
  //    below it (larger tier numbers). Untagged rates are visible to all.
  const tierOf = (gradeId: string | null) =>
    gradeId ? grades.find((g) => g.id === gradeId)?.sort_order ?? 0 : null
  const visibleTo = (j: Job) => {
    if (canManage) return true
    if (profile?.station_id && j.station_id !== profile.station_id) return false
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

      {showApprovals && (
        <ApprovalModal
          items={openApprovals}
          stations={stations}
          grades={grades}
          currentRate={currentRate}
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
          currentRate={modal === 'create' ? null : currentRate.get(modal.id) ?? null}
          autoApprove={isAdmin}
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
                      <strong>{rate ? Number(rate.rate) : '—'}</strong>
                    </div>
                    <div className="small approval-trail">
                      {j.approval_status === 'pending' && <span className="badge off">waiting verification</span>}
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
/* Contract list — Station and Tag column headers are the filters.    */
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
  const [gradeFilter, setGradeFilter] = useState('')
  const [showInactive, setShowInactive] = useState(false)

  const stationName = (id: string) => stations.find((s) => s.id === id)?.name ?? '?'
  const gradeName = (id: string | null) => grades.find((g) => g.id === id)?.name ?? null

  async function setActive(job: Job, active: boolean) {
    const { error } = await supabase.from('jobs').update({ active }).eq('id', job.id)
    if (error) onError(error.message)
    else onChanged()
  }

  const list = jobs
    .filter((j) => (showInactive ? true : j.active))
    .filter((j) => (stationFilter ? j.station_id === stationFilter : true))
    .filter((j) => (gradeFilter ? j.grade_id === gradeFilter : true))
    .sort(
      (a, b) =>
        stationName(a.station_id).localeCompare(stationName(b.station_id)) ||
        a.name.localeCompare(b.name),
    )

  return (
    <div className="card stack">
      <h3>Piece Rate Listing</h3>
      <table className="table">
        <thead>
          <tr>
            <th>
              <select
                className={`th-filter ${stationFilter ? 'active' : ''}`}
                value={stationFilter}
                onChange={(e) => setStationFilter(e.target.value)}
                title="Filter by station"
              >
                <option value="">Station ▾</option>
                {stations.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </th>
            <th>Work description</th>
            <th>
              <select
                className={`th-filter ${gradeFilter ? 'active' : ''}`}
                value={gradeFilter}
                onChange={(e) => setGradeFilter(e.target.value)}
                title="Filter by tag"
              >
                <option value="">Tag ▾</option>
                {grades.map((g) => (
                  <option key={g.id} value={g.id}>{g.name}</option>
                ))}
              </select>
            </th>
            <th>Unit</th>
            <th className="right">Rate</th>
            {canManage && <th className="right">Actions</th>}
          </tr>
        </thead>
        <tbody>
          {list.length === 0 && (
            <tr>
              <td colSpan={6} className="muted">
                No piece rates here — click “Create new piece rate” to add one.
              </td>
            </tr>
          )}
          {list.map((j) => {
            const rate = currentRate.get(j.id)
            const tag = gradeName(j.grade_id)
            return (
              <tr key={j.id} className={j.active ? '' : 'muted'}>
                <td>{stationName(j.station_id)}</td>
                <td>{j.name}{!j.active && ' (inactive)'}</td>
                <td>{tag ? <span className={tagClass(grades.find((g) => g.id === j.grade_id)?.color)}>{tag}</span> : <span className="muted">—</span>}</td>
                <td className="muted">{j.unit}</td>
                <td className="right">
                  {rate ? <strong>{Number(rate.rate)}</strong> : <span className="badge off">no rate</span>}
                </td>
                {canManage && (
                  <td className="right">
                    <button className="linkbtn" onClick={() => onEdit(j)}>Edit</button>{' '}
                    {j.active ? (
                      <button className="linkbtn danger" onClick={() => setActive(j, false)}>Deactivate</button>
                    ) : (
                      <button className="linkbtn" onClick={() => setActive(j, true)}>Reactivate</button>
                    )}
                  </td>
                )}
              </tr>
            )
          })}
        </tbody>
      </table>
      <div className="row-form spread">
        <p className="muted small">{list.length} contract(s) shown.</p>
        <label className="small muted checkbox">
          <input
            type="checkbox"
            checked={showInactive}
            onChange={(e) => setShowInactive(e.target.checked)}
          />{' '}
          Show inactive
        </label>
      </div>
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
  autoApprove,
  onClose,
  onSaved,
}: {
  stations: Station[]
  grades: Grade[]
  job: Job | null
  currentRate: Rate | null
  autoApprove: boolean
  onClose: () => void
  onSaved: (submittedForApproval: boolean) => void
}) {
  const [stationId, setStationId] = useState(job?.station_id ?? '')
  const [gradeId, setGradeId] = useState(job?.grade_id ?? '')
  const [description, setDescription] = useState(job?.name ?? '')
  const [unit, setUnit] = useState(job?.unit ?? '')
  const [rate, setRate] = useState(currentRate ? String(Number(currentRate.rate)) : '')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  async function save(e: FormEvent) {
    e.preventDefault()
    setError(null)
    const rateValue = Number(rate)
    if (rate.trim() === '' || Number.isNaN(rateValue) || rateValue < 0) {
      return setError('Enter a valid non-negative rate.')
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
        // New contracts by approvers go live immediately; others wait.
        const approval_status = autoApprove ? 'approved' : 'pending'
        submitted = !autoApprove
        const { data, error } = await supabase
          .from('jobs')
          .insert({ ...fields, approval_status })
          .select()
          .single()
        if (error) throw new Error(error.message)
        jobId = data.id
      }
      const unchanged = job && currentRate && Number(currentRate.rate) === rateValue
      if (jobId && !unchanged) {
        const { error } = await supabase
          .from('piece_rates')
          .upsert(
            { job_id: jobId, rate: rateValue, effective_from: todayISO() },
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
        {!job && !autoApprove && (
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

        <div className="row-form" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn" type="submit" disabled={saving}>
            {saving ? 'Saving…' : job ? 'Save changes' : autoApprove ? 'Create piece rate' : 'Submit for approval'}
          </button>
        </div>
      </form>
    </div>
  )
}
