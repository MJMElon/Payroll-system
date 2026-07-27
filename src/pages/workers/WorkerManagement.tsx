// ---------------------------------------------------------------------------
// WORKER MANAGEMENT MODULE — the day-to-day team tool (Settings → User
// access stays the SYSTEM setting for engineer tier and above).
//
// Three sections, left to right:
//   1. NEW SIGN UPS  — accounts waiting for a team; drag one into the chart.
//   2. TEAM CHART    — one lane per tier tag (Management excluded), drawn
//                      straight from the grades table, so adding or
//                      removing a tier reshapes the chart automatically.
//                      Blocks show name / tier / station only, and drag &
//                      drop moves someone under a new leader.
//   3. WORKER PANEL  — opens when a block is clicked: monthly basic salary,
//                      the piece-rate contracts that person is entitled to,
//                      and the work they have done (this month for now —
//                      history filters come later).
//
// Access: ANY leader may drag a new sign-up into THEIR OWN team — that
// needs no capability. Editing a profile needs "Edit worker profile &
// salary", and assigning into someone else's team needs "Assign workers to
// ANY team"; both are granted per tier in Settings → Tags management.
// ---------------------------------------------------------------------------
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'
import { effectiveCapabilities, tagClass } from '../../lib/tags'
import { useWideShell } from '../../lib/useWideShell'
import {
  profileName,
  supabase,
  todayISO,
  type Grade,
  type Job,
  type PieceRate,
  type ProductionEntry,
  type Profile,
  type Station,
} from '../../lib/supabase'

const TIER1_UNIT_CAP = 4
const RM = (n: number) => `RM ${n.toFixed(2)}`

export default function WorkerManagement() {
  const { profile } = useAuth()
  const wideStyle = useWideShell()
  const [profiles, setProfiles] = useState<Profile[]>([])
  const [grades, setGrades] = useState<Grade[]>([])
  const [stations, setStations] = useState<Station[]>([])
  const [jobs, setJobs] = useState<Job[]>([])
  const [rates, setRates] = useState<PieceRate[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [editWorker, setEditWorker] = useState<Profile | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropTargetId, setDropTargetId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  async function load() {
    const [p, g, s, j, r] = await Promise.all([
      supabase.from('access_profiles').select('*').order('full_name'),
      supabase.from('grades').select('*').order('sort_order'),
      supabase.from('stations').select('*').order('sort_order'),
      supabase
        .from('jobs')
        .select('id, station_id, grade_id, name, unit, active, approval_status, verified_by, approved_by'),
      supabase.from('piece_rates').select('id, job_id, rate, effective_from, tier2_rate'),
    ])
    const err = p.error || g.error || s.error
    if (err) setError(err.message)
    setProfiles((p.data ?? []) as Profile[])
    setGrades(((g.data ?? []) as Grade[]).sort((a, b) => a.sort_order - b.sort_order))
    setStations(s.data ?? [])
    setJobs((j.data ?? []) as Job[])
    setRates(r.data ?? [])
    setLoading(false)
  }
  useEffect(() => {
    load()
  }, [])

  const isAdmin = profile?.role === 'admin'
  const myGrade = profile?.grade_id ? grades.find((g) => g.id === profile.grade_id) ?? null : null
  const myTier = myGrade?.sort_order ?? null
  const myCaps = effectiveCapabilities(myGrade)
  const bottomTier = Math.max(0, ...grades.map((g) => g.sort_order))

  // Who sees every team vs. only their own subtree.
  const seesAll = isAdmin || myTier === 1 || myCaps.includes('user-access')
  const isLeader = seesAll || (myTier !== null && myTier < bottomTier)
  // Granted functions. Claiming into your OWN team is always allowed.
  const canEditProfile = isAdmin || myTier === 1 || myCaps.includes('worker-edit')
  const canAssignAnywhere =
    isAdmin || myTier === 1 || myCaps.includes('user-access') || myCaps.includes('worker-assign-any')

  const tierOf = (p: Profile) =>
    p.grade_id ? grades.find((g) => g.id === p.grade_id)?.sort_order ?? null : null
  const gradeOf = (p: Profile) => grades.find((g) => g.id === p.grade_id)
  const stationLabel = (p: Profile) => {
    const ids =
      p.station_ids && p.station_ids.length > 0 ? p.station_ids : p.station_id ? [p.station_id] : []
    if (ids.length === 0) return 'All stations'
    return ids.map((id) => stations.find((st) => st.id === id)?.name ?? '?').join(', ')
  }

  const confirmed = profiles.filter((p) => p.tags_confirmed)
  const pending = profiles.filter((p) => !p.tags_confirmed)

  // My subtree: me + everyone whose reporting chain reaches me.
  const inMyTeam = (p: Profile): boolean => {
    let cur: Profile | undefined = p
    for (let hops = 0; cur && hops < 20; hops++) {
      if (cur.id === profile?.id) return true
      cur = profiles.find((x) => x.id === cur?.supervisor_id)
    }
    return false
  }
  const visible = seesAll ? confirmed : confirmed.filter(inMyTeam)

  // May I move this person into a different team?
  const canMove = (p: Profile) =>
    p.id !== profile?.id &&
    (canAssignAnywhere || p.supervisor_id === profile?.id || inMyTeam(p))
  // May a dragged person be dropped onto this block? Default is your own
  // block only — "upper picks lower", into your own team.
  const canDropOn = (target: Profile) => canAssignAnywhere || target.id === profile?.id

  const selected = selectedId ? profiles.find((p) => p.id === selectedId) ?? null : null

  /* ---------------- assignment actions ---------------- */

  async function assignTo(person: Profile, leader: Profile) {
    if (person.id === leader.id) return
    const pt = tierOf(person)
    const lt = tierOf(leader)
    if (pt !== null && lt !== null && lt >= pt) {
      return setError('A worker can only be placed under a strictly higher tier.')
    }
    setError(null)
    const { error } = await supabase
      .from('access_profiles')
      .update({
        supervisor_id: leader.id,
        station_ids: leader.station_ids ?? [],
        station_id: leader.station_ids?.[0] ?? leader.station_id ?? null,
        tags_confirmed: true,
      })
      .eq('id', person.id)
    if (error) return setError(error.message)
    const teamName =
      leader.id === profile?.id
        ? 'your team'
        : leader.team_name ?? `${profileName(leader)}'s team`
    setNotice(`${profileName(person)} added to ${teamName}.`)
    load()
  }

  // The dragged id travels in the DataTransfer as well as in state: on a
  // real drag both agree, but the payload is what the drop event actually
  // carries, so it stays correct even if React has not re-rendered yet.
  function handleDrop(target: Profile, e: React.DragEvent) {
    const carried = e.dataTransfer.getData('text/plain')
    const dragged = profiles.find((p) => p.id === (carried || dragId))
    setDragId(null)
    setDropTargetId(null)
    if (!dragged) return
    if (!canDropOn(target)) {
      return setError(
        'You can only add workers to your own team. The "Assign workers to ANY team" function opens this up.',
      )
    }
    if (dragged.tags_confirmed && !canMove(dragged)) {
      return setError('You can only move workers who are already in your team.')
    }
    assignTo(dragged, target)
  }

  /* ---------------- chart model ---------------- */

  // One lane per tier tag, Management (tier 1) excluded, straight from the
  // grades table — add or remove a tier and the chart follows.
  const lanes = useMemo(() => {
    const list = grades
      .filter((g) => g.sort_order !== 1)
      .map((g) => ({
        grade: g as Grade | null,
        people: visible.filter((p) => p.grade_id === g.id),
      }))
    const untagged = visible.filter((p) => !p.grade_id)
    if (untagged.length > 0) list.push({ grade: null, people: untagged })
    // A full-chart viewer keeps empty lanes (they show the tier exists);
    // someone scoped to their own team would just see noise.
    return seesAll ? list : list.filter((l) => l.people.length > 0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [grades, visible, seesAll])

  const leaderName = (p: Profile) => {
    const sup = p.supervisor_id ? profiles.find((x) => x.id === p.supervisor_id) : null
    return sup ? profileName(sup) : null
  }
  const reportCount = (id: string) => profiles.filter((p) => p.supervisor_id === id).length

  if (loading) return <p className="muted">Loading…</p>

  if (!isLeader) {
    return (
      <div className="stack">
        <div>
          <Link to="/" className="small muted backlink">← Back to main page</Link>
          <h1>Worker Management</h1>
        </div>
        <div className="card"><p className="muted">Only team leaders (upper tiers) can manage workers.</p></div>
      </div>
    )
  }

  return (
    <div className="stack">
      <div>
        <Link to="/" className="small muted backlink">← Back to main page</Link>
        <h1>Worker Management</h1>
        <p className="muted">
          Drag a new sign-up into the chart to add them to a team. Click anyone
          to open their details.
        </p>
      </div>

      {error && <div className="error">{error}</div>}
      {notice && <div className="notice">{notice}</div>}

      <div className="wm-layout" style={wideStyle}>
        {/* ---------- 1. New sign ups ---------- */}
        <aside className="wm-col wm-signups">
          <div className="wm-col-head">
            <h3>New sign ups</h3>
            {pending.length > 0 && <span className="count-badge static">{pending.length}</span>}
          </div>
          {pending.length === 0 ? (
            <p className="muted small">No new sign ups waiting.</p>
          ) : (
            <>
              <p className="muted small" style={{ margin: 0 }}>
                Drag a card onto {canAssignAnywhere ? 'any leader' : 'your own block'} in the chart.
              </p>
              {pending.map((p) => (
                <div
                  key={p.id}
                  className={`wm-signup-card ${dragId === p.id ? 'dragging' : ''}`}
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData('text/plain', p.id)
                    e.dataTransfer.effectAllowed = 'move'
                    setDragId(p.id)
                  }}
                  onDragEnd={() => {
                    setDragId(null)
                    setDropTargetId(null)
                  }}
                >
                  <div className="wm-signup-top">
                    <span className="wm-block-name">{profileName(p)}</span>
                    <span className="badge new">new</span>
                  </div>
                  <div className="wm-block-meta">{gradeOf(p)?.name ?? 'No tier yet'}</div>
                  {profile && (
                    <button className="btn sm" onClick={() => assignTo(p, profile)}>
                      + Add to my team
                    </button>
                  )}
                </div>
              ))}
            </>
          )}
        </aside>

        {/* ---------- 2. Team chart ---------- */}
        <section className="wm-col wm-chart">
          <div className="wm-col-head">
            <h3>{seesAll ? 'Team structure' : 'My team structure'}</h3>
            <span className="muted small">{visible.length} people</span>
          </div>

          {lanes.every((l) => l.people.length === 0) && (
            <p className="muted small">No team members yet.</p>
          )}

          {lanes.map((lane) => (
            <div className="wm-lane" key={lane.grade?.id ?? 'untagged'}>
              <div className="wm-lane-head">
                <span className={`tag-dot dot-${lane.grade?.color ?? 'grey'}`} aria-hidden="true" />
                <span className="wm-lane-title">{lane.grade?.name ?? 'No tier tag'}</span>
                <span className="wm-lane-count">{lane.people.length}</span>
              </div>
              <div className="wm-lane-body">
                {lane.people.length === 0 ? (
                  <span className="muted small wm-lane-empty">—</span>
                ) : (
                  lane.people.map((p) => {
                    const under = reportCount(p.id)
                    const lead = leaderName(p)
                    const isMe = p.id === profile?.id
                    return (
                      <div
                        key={p.id}
                        className={[
                          'wm-block',
                          selectedId === p.id ? 'selected' : '',
                          dragId === p.id ? 'dragging' : '',
                          dropTargetId === p.id ? 'droppable' : '',
                          isMe ? 'me' : '',
                        ].join(' ')}
                        draggable={canMove(p)}
                        onDragStart={(e) => {
                          if (!canMove(p)) return
                          e.dataTransfer.setData('text/plain', p.id)
                          e.dataTransfer.effectAllowed = 'move'
                          setDragId(p.id)
                        }}
                        onDragEnd={() => {
                          setDragId(null)
                          setDropTargetId(null)
                        }}
                        onDragOver={(e) => {
                          if (dragId === p.id) return
                          e.preventDefault()
                          e.dataTransfer.dropEffect = 'move'
                          setDropTargetId(p.id)
                        }}
                        onDragLeave={() => setDropTargetId((cur) => (cur === p.id ? null : cur))}
                        onDrop={(e) => {
                          e.preventDefault()
                          handleDrop(p, e)
                        }}
                        onClick={() => setSelectedId(p.id)}
                      >
                        <div className="wm-block-name">
                          {profileName(p)}
                          {isMe && <span className="you-chip">you</span>}
                        </div>
                        <div className="wm-block-meta">{stationLabel(p)}</div>
                        <div className="wm-block-foot">
                          {lead ? <span title="Reports to">▲ {lead}</span> : <span className="muted">no leader</span>}
                          {under > 0 && <span className="wm-under">{under} under</span>}
                        </div>
                      </div>
                    )
                  })
                )}
              </div>
            </div>
          ))}

          <p className="muted small">
            Drag a block onto a leader to move that person into their team — the
            target must be a strictly higher tier.
            {!canAssignAnywhere && ' You can add into your own team only.'}
          </p>
        </section>

        {/* ---------- 3. Worker panel ---------- */}
        <aside className="wm-col wm-detail">
          {selected ? (
            <WorkerPanel
              person={selected}
              grade={gradeOf(selected) ?? null}
              stationText={stationLabel(selected)}
              leader={leaderName(selected)}
              jobs={jobs}
              rates={rates}
              stations={stations}
              canEditProfile={canEditProfile}
              onEdit={() => setEditWorker(selected)}
              onClose={() => setSelectedId(null)}
            />
          ) : (
            <div className="wm-col-head">
              <h3>Worker details</h3>
            </div>
          )}
          {!selected && (
            <p className="muted small">
              Click anyone in the chart to see their basic salary, the piece-rate
              contracts they are entitled to, and the work they have done.
            </p>
          )}
        </aside>
      </div>

      {editWorker && (
        <WorkerProfileModal
          worker={editWorker}
          onClose={() => setEditWorker(null)}
          onSaved={() => {
            setEditWorker(null)
            load()
          }}
        />
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Worker panel — everything about ONE person, opened by clicking     */
/* their block in the chart.                                          */
/* ------------------------------------------------------------------ */

function WorkerPanel({
  person,
  grade,
  stationText,
  leader,
  jobs,
  rates,
  stations,
  canEditProfile,
  onEdit,
  onClose,
}: {
  person: Profile
  grade: Grade | null
  stationText: string
  leader: string | null
  jobs: Job[]
  rates: PieceRate[]
  stations: Station[]
  canEditProfile: boolean
  onEdit: () => void
  onClose: () => void
}) {
  const [entries, setEntries] = useState<ProductionEntry[]>([])
  const [loading, setLoading] = useState(true)

  const month = todayISO().slice(0, 7)
  const monthLabel = new Date(`${month}-01T00:00:00`).toLocaleDateString(undefined, {
    month: 'long',
    year: 'numeric',
  })

  useEffect(() => {
    setLoading(true)
    const start = `${month}-01`
    const end = todayISO()
    supabase
      .from('production_entries')
      .select('*')
      .eq('user_id', person.id)
      .gte('work_date', start)
      .lte('work_date', end)
      .order('work_date', { ascending: false })
      .then(({ data }) => {
        setEntries((data ?? []) as ProductionEntry[])
        setLoading(false)
      })
  }, [person.id, month])

  // The rate in force today for a job.
  const currentRate = useMemo(() => {
    const today = todayISO()
    const best = new Map<string, PieceRate>()
    for (const r of rates) {
      if (r.effective_from > today) continue
      const cur = best.get(r.job_id)
      if (!cur || r.effective_from > cur.effective_from) best.set(r.job_id, r)
    }
    return best
  }, [rates])

  const amountOf = (jobId: string, qty: number) => {
    const r = currentRate.get(jobId)
    if (!r) return 0
    const t1 = Number(r.rate)
    if (r.tier2_rate == null) return qty * t1
    return Math.min(qty, TIER1_UNIT_CAP) * t1 + Math.max(0, qty - TIER1_UNIT_CAP) * Number(r.tier2_rate)
  }

  // Contracts this person may be paid for: approved + active work at one of
  // their stations, tagged to their tier (or open to every position).
  const myStations =
    person.station_ids && person.station_ids.length > 0
      ? person.station_ids
      : person.station_id
        ? [person.station_id]
        : []
  const contracts = jobs
    .filter((j) => j.active && j.approval_status === 'approved')
    .filter((j) => myStations.length === 0 || myStations.includes(j.station_id))
    .filter((j) => j.grade_id === null || j.grade_id === person.grade_id)
    .sort((a, b) => a.name.localeCompare(b.name))

  const stationName = (id: string) => stations.find((s) => s.id === id)?.name ?? '?'
  const jobName = (id: string) => jobs.find((j) => j.id === id)?.name ?? 'Work'
  const monthTotal = entries
    .filter((e) => (e.approval_status ?? 'approved') !== 'rejected')
    .reduce((s, e) => s + amountOf(e.job_id, Number(e.quantity)), 0)

  const statusChip = (s: string) => {
    const cls = s === 'approved' ? 'ok' : s === 'rejected' ? 'bad' : s === 'verified' ? 'mid' : 'warn'
    const label =
      s === 'approved' ? 'Approved'
        : s === 'rejected' ? 'Rejected'
          : s === 'verified' ? 'Pending approve'
            : 'Pending verify'
    return <span className={`mob-chip ${cls}`}>{label}</span>
  }

  return (
    <>
      <div className="wm-col-head">
        <h3>Worker details</h3>
        <button className="modal-close" onClick={onClose} aria-label="Close details">×</button>
      </div>

      <div className="wm-detail-id">
        <div className="wm-block-name" style={{ fontSize: '1.05rem' }}>{profileName(person)}</div>
        <div className="row-form" style={{ gap: '0.4rem', flexWrap: 'wrap' }}>
          {grade && <span className={tagClass(grade.color)}>{grade.name}</span>}
          {person.team_name && <span className="badge off">{person.team_name}</span>}
        </div>
        <div className="wm-block-meta">{stationText}</div>
        {leader && <div className="wm-block-meta">Reports to {leader}</div>}
      </div>

      <div className="wm-stat">
        <span className="wm-stat-label">Monthly basic salary</span>
        <span className="wm-stat-value">
          {person.basic_salary != null ? RM(Number(person.basic_salary)) : '—'}
        </span>
      </div>

      <div className="wm-detail-block">
        <div className="wm-detail-title">Entitled piece-rate contracts ({contracts.length})</div>
        {contracts.length === 0 ? (
          <p className="muted small" style={{ margin: 0 }}>
            No approved contracts match this person's tier and station.
          </p>
        ) : (
          contracts.map((j) => {
            const r = currentRate.get(j.id)
            return (
              <div className="wm-line" key={j.id}>
                <span>
                  {j.name}
                  <span className="wm-block-meta"> {stationName(j.station_id)} · {j.unit}</span>
                </span>
                <span className="wm-line-amt">
                  {r
                    ? r.tier2_rate != null
                      ? `${Number(r.rate).toFixed(2)} → ${Number(r.tier2_rate).toFixed(2)}`
                      : Number(r.rate).toFixed(2)
                    : '—'}
                </span>
              </div>
            )
          })
        )}
      </div>

      <div className="wm-detail-block">
        <div className="wm-detail-title">Work done — {monthLabel}</div>
        {loading ? (
          <p className="muted small" style={{ margin: 0 }}>Loading…</p>
        ) : entries.length === 0 ? (
          <p className="muted small" style={{ margin: 0 }}>No work recorded this month.</p>
        ) : (
          <>
            {entries.map((e) => (
              <div className="wm-line" key={e.id}>
                <span>
                  <span className="wm-line-date">
                    {new Date(e.work_date + 'T00:00:00').toLocaleDateString(undefined, {
                      day: '2-digit', month: 'short',
                    })}
                  </span>{' '}
                  {jobName(e.job_id)} × {Number(e.quantity)}
                  <div>{statusChip(e.approval_status ?? 'approved')}</div>
                </span>
                <span className="wm-line-amt">{amountOf(e.job_id, Number(e.quantity)).toFixed(2)}</span>
              </div>
            ))}
            <div className="wm-line total">
              <span>Month to date (excludes rejected)</span>
              <span className="wm-line-amt">{RM(monthTotal)}</span>
            </div>
          </>
        )}
        <p className="muted small" style={{ margin: 0 }}>
          This month only — date filters for older history come later.
        </p>
      </div>

      {canEditProfile ? (
        <button className="btn" onClick={onEdit}>✎ Edit worker profile</button>
      ) : (
        <p className="muted small">
          Editing a worker profile needs the "Edit worker profile &amp; salary"
          function, granted per tier in Settings → Tags management.
        </p>
      )}
    </>
  )
}

/* ------------------------------------------------------------------ */
/* Worker profile pop-out: personal + payroll details for one worker. */
/* Tags/tier/access stay in Settings -> User access.                  */
/* ------------------------------------------------------------------ */

function WorkerProfileModal({
  worker,
  onClose,
  onSaved,
}: {
  worker: Profile
  onClose: () => void
  onSaved: () => void
}) {
  const [name, setName] = useState(worker.full_name ?? '')
  const [code, setCode] = useState(worker.employee_code ?? '')
  const [ic, setIc] = useState(worker.ic_number ?? '')
  const [phone, setPhone] = useState(worker.phone ?? '')
  const [bankName, setBankName] = useState(worker.bank_name ?? '')
  const [bankAccount, setBankAccount] = useState(worker.bank_account ?? '')
  const [joinedOn, setJoinedOn] = useState(worker.joined_on ?? '')
  const [teamName, setTeamName] = useState(worker.team_name ?? '')
  const [salary, setSalary] = useState(worker.basic_salary != null ? String(worker.basic_salary) : '')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  async function save(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    const salaryValue = salary.trim() === '' ? null : Number(salary)
    if (salaryValue !== null && (!Number.isFinite(salaryValue) || salaryValue < 0)) {
      return setError('Basic salary must be a positive number.')
    }
    setSaving(true)
    const { error } = await supabase
      .from('access_profiles')
      .update({
        full_name: name.trim() || null,
        employee_code: code.trim() || null,
        ic_number: ic.trim() || null,
        phone: phone.trim() || null,
        bank_name: bankName.trim() || null,
        bank_account: bankAccount.trim() || null,
        joined_on: joinedOn || null,
        team_name: teamName.trim() || null,
        basic_salary: salaryValue,
      })
      .eq('id', worker.id)
    setSaving(false)
    if (error) return setError(error.message)
    onSaved()
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={save}>
        <div className="row-form spread">
          <h2>Worker profile</h2>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>
        {error && <div className="error">{error}</div>}

        <div className="row-form">
          <label className="field grow">
            <span>Full name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} required />
          </label>
          <label className="field">
            <span>Employee code</span>
            <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="EMP001" />
          </label>
        </div>

        <div className="row-form">
          <label className="field grow">
            <span>IC / passport number</span>
            <input value={ic} onChange={(e) => setIc(e.target.value)} />
          </label>
          <label className="field grow">
            <span>Phone</span>
            <input value={phone} onChange={(e) => setPhone(e.target.value)} />
          </label>
        </div>

        <div className="row-form">
          <label className="field grow">
            <span>Bank</span>
            <input value={bankName} onChange={(e) => setBankName(e.target.value)} />
          </label>
          <label className="field grow">
            <span>Bank account no.</span>
            <input value={bankAccount} onChange={(e) => setBankAccount(e.target.value)} />
          </label>
        </div>

        <label className="field">
          <span>Team name (shown when this person leads a team)</span>
          <input value={teamName} onChange={(e) => setTeamName(e.target.value)} placeholder="e.g. Team A" />
        </label>

        <div className="row-form">
          <label className="field">
            <span>Joined on</span>
            <input type="date" value={joinedOn} onChange={(e) => setJoinedOn(e.target.value)} />
          </label>
          <label className="field grow">
            <span>Monthly basic salary (RM)</span>
            <input
              type="number"
              min="0"
              step="50"
              value={salary}
              onChange={(e) => setSalary(e.target.value)}
              placeholder="—"
            />
          </label>
        </div>

        <p className="muted small" style={{ margin: 0 }}>
          Tier tag, station tag and access settings stay in Settings → User access.
        </p>

        <div className="row-form" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn" type="submit" disabled={saving}>
            {saving ? 'Saving…' : 'Save profile'}
          </button>
        </div>
      </form>
    </div>
  )
}
