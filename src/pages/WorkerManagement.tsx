// ---------------------------------------------------------------------------
// WORKER MANAGEMENT MODULE — the day-to-day team tool (Settings → User
// access stays the SYSTEM setting for engineer tier and above).
//
// 1. New sign-ups (default Operator) appear here; a station head or
//    assistant station head claims one straight into their own team —
//    that sets "reports to" = them, copies their station tags and
//    confirms the account.
// 2. The team chart shows who works under whom.
// 3. The worker list shows every registered worker with an editable
//    monthly basic salary (more profile fields will live here later).
// ---------------------------------------------------------------------------
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { effectiveCapabilities, tagClass } from '../lib/tags'
import {
  profileName,
  supabase,
  type Grade,
  type Profile,
  type Station,
} from '../lib/supabase'

export default function WorkerManagement() {
  const { profile } = useAuth()
  const [profiles, setProfiles] = useState<Profile[]>([])
  const [grades, setGrades] = useState<Grade[]>([])
  const [stations, setStations] = useState<Station[]>([])
  const [salaryDraft, setSalaryDraft] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  async function load() {
    const [p, g, s] = await Promise.all([
      supabase.from('access_profiles').select('*').order('email'),
      supabase.from('grades').select('*').order('sort_order'),
      supabase.from('stations').select('*').order('sort_order'),
    ])
    const err = p.error || g.error || s.error
    if (err) setError(err.message)
    setProfiles((p.data ?? []) as Profile[])
    setGrades(((g.data ?? []) as Grade[]).sort((a, b) => a.sort_order - b.sort_order))
    setStations(s.data ?? [])
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
  // Full view: admins, tier 1 and user-access holders. Team view: any
  // upper tier (they lead people below them).
  const seesAll = isAdmin || myTier === 1 || myCaps.includes('user-access')
  const isLeader = seesAll || (myTier !== null && myTier < bottomTier)

  const tierOf = (p: Profile) =>
    p.grade_id ? grades.find((g) => g.id === p.grade_id)?.sort_order ?? null : null
  const gradeOf = (p: Profile) => grades.find((g) => g.id === p.grade_id)
  const stationLabel = (p: Profile) => {
    const ids = p.station_ids && p.station_ids.length > 0
      ? p.station_ids
      : p.station_id ? [p.station_id] : []
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

  // May I edit this person? Full access, or they are my direct report.
  const canEdit = (p: Profile) =>
    (seesAll && (isAdmin || myTier === 1 || (tierOf(p) ?? 99) > (myTier ?? 0))) ||
    p.supervisor_id === profile?.id

  async function claim(p: Profile) {
    if (!profile) return
    setError(null)
    const { error } = await supabase
      .from('access_profiles')
      .update({
        supervisor_id: profile.id,
        station_ids: profile.station_ids ?? [],
        station_id: profile.station_ids?.[0] ?? profile.station_id ?? null,
        tags_confirmed: true,
      })
      .eq('id', p.id)
    if (error) return setError(error.message)
    setNotice(`${profileName(p)} added to your team.`)
    load()
  }

  async function saveSalary(p: Profile) {
    const raw = salaryDraft[p.id]
    if (raw === undefined) return
    const value = raw.trim() === '' ? null : Number(raw)
    if (value !== null && (!Number.isFinite(value) || value < 0)) {
      return setError('Basic salary must be a positive number.')
    }
    if (value === (p.basic_salary ?? null)) return
    setError(null)
    const { error } = await supabase
      .from('access_profiles')
      .update({ basic_salary: value })
      .eq('id', p.id)
    if (error) return setError(error.message)
    load()
  }

  /* Team chart node (same idea as the Settings tree). */
  const childrenOf = (id: string) =>
    visible
      .filter((p) => p.supervisor_id === id)
      .sort((a, b) => (tierOf(a) ?? 99) - (tierOf(b) ?? 99) || profileName(a).localeCompare(profileName(b)))
  const roots = seesAll
    ? visible
        .filter((p) => !p.supervisor_id || !visible.some((x) => x.id === p.supervisor_id))
        .sort((a, b) => (tierOf(a) ?? 99) - (tierOf(b) ?? 99) || profileName(a).localeCompare(profileName(b)))
    : visible.filter((p) => p.id === profile?.id)

  const renderNode = (p: Profile, depth: number): JSX.Element => {
    const g = gradeOf(p)
    const kids = childrenOf(p.id)
    return (
      <div key={p.id}>
        <div className="tree-row" style={{ marginLeft: depth * 26 }}>
          {depth > 0 && <span className="tree-elbow" aria-hidden="true">└</span>}
          <span className={`tag-dot dot-${g?.color ?? 'grey'}`} aria-hidden="true" />
          <span className="tree-name">{p.full_name ?? p.email ?? '—'}</span>
          {g && <span className={tagClass(g.color)}>{g.name}</span>}
          <span className="tree-meta">
            {p.employee_code ? `${p.employee_code} · ` : ''}{stationLabel(p)}
            {kids.length > 0 && ` · ${kids.length} under`}
          </span>
        </div>
        {kids.map((c) => renderNode(c, depth + 1))}
      </div>
    )
  }

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
          Claim new sign-ups into your team, see the team chart, and manage
          worker details. System access settings stay in Settings → User access.
        </p>
      </div>

      {error && <div className="error">{error}</div>}
      {notice && <div className="notice">{notice}</div>}

      {/* 1 — new sign-ups to claim */}
      <div className="card stack approval-card">
        <div className="row-form spread">
          <h3>New sign ups — waiting for a team</h3>
          {pending.length > 0 && <span className="count-badge static">{pending.length}</span>}
        </div>
        {pending.length === 0 && <p className="muted small">No new sign ups waiting.</p>}
        {pending.map((p) => (
          <div className="row-form spread signup-row" key={p.id}>
            <span>
              <strong>{p.full_name ?? '—'}</strong> <span className="badge new">new</span>
              <span className="muted small"> · {p.email}</span>
            </span>
            <button className="btn" onClick={() => claim(p)}>+ Add to my team</button>
          </div>
        ))}
        {pending.length > 0 && (
          <p className="muted small">
            Claiming sets you as their direct upper, copies your station tags and
            confirms the account (they stay Operator — tiers are changed in Settings).
          </p>
        )}
      </div>

      {/* 2 — team chart */}
      <div className="card stack">
        <h3>{seesAll ? 'Team chart — all teams' : 'My team chart'}</h3>
        {roots.length === 0 && <p className="muted small">No team members yet.</p>}
        <div className="stack" style={{ gap: '0.1rem' }}>
          {roots.map((p) => renderNode(p, 0))}
        </div>
      </div>

      {/* 3 — registered workers + basic salary */}
      <div className="card stack">
        <h3>Registered workers</h3>
        <table className="table">
          <thead>
            <tr>
              <th>Code</th>
              <th>Name</th>
              <th>Email</th>
              <th>Tier</th>
              <th>Station</th>
              <th className="right">Monthly basic salary (RM)</th>
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 && (
              <tr><td colSpan={6} className="muted">No workers yet.</td></tr>
            )}
            {visible
              .slice()
              .sort((a, b) => (tierOf(a) ?? 99) - (tierOf(b) ?? 99) || profileName(a).localeCompare(profileName(b)))
              .map((p) => {
                const g = gradeOf(p)
                const editable = canEdit(p)
                return (
                  <tr key={p.id}>
                    <td className="muted small">{p.employee_code ?? '—'}</td>
                    <td>{p.full_name ?? '—'}</td>
                    <td className="muted small">{p.email}</td>
                    <td>{g ? <span className={tagClass(g.color)}>{g.name}</span> : '—'}</td>
                    <td className="muted small">{stationLabel(p)}</td>
                    <td className="right">
                      {editable ? (
                        <input
                          className="salary-input"
                          type="number"
                          min="0"
                          step="50"
                          placeholder="—"
                          value={salaryDraft[p.id] ?? (p.basic_salary != null ? String(p.basic_salary) : '')}
                          onChange={(e) =>
                            setSalaryDraft((d) => ({ ...d, [p.id]: e.target.value }))
                          }
                          onBlur={() => saveSalary(p)}
                        />
                      ) : (
                        <span className="muted small">
                          {p.basic_salary != null ? p.basic_salary.toLocaleString() : '—'}
                        </span>
                      )}
                    </td>
                  </tr>
                )
              })}
          </tbody>
        </table>
        <p className="muted small">
          Salary saves when you click away from the box. More profile fields will
          be editable here in the future.
        </p>
      </div>
    </div>
  )
}
