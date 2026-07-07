import { useEffect, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import {
  supabase,
  type Grade,
  type Profile,
  type Role,
  type Station,
  type Worker,
} from '../lib/supabase'
import { TAG_COLORS, tagClass } from '../lib/tags'

type Tab = 'access' | 'tags' | 'workers'

const ROLES: Role[] = ['admin', 'manager', 'engineer', 'operator', 'worker']

export default function Settings() {
  const [tab, setTab] = useState<Tab>('access')

  return (
    <div className="stack">
      <div>
        <Link to="/" className="small muted backlink">← Back to main page</Link>
        <h1>Settings</h1>
        <p className="muted">
          User access and tags. Stations live in the{' '}
          <Link to="/piece-rate">Piece Rate module</Link>.
        </p>
      </div>

      <div className="tabs">
        <button className={`tab ${tab === 'access' ? 'active' : ''}`} onClick={() => setTab('access')}>
          User access
        </button>
        <button className={`tab ${tab === 'tags' ? 'active' : ''}`} onClick={() => setTab('tags')}>
          Tags
        </button>
        <button className={`tab ${tab === 'workers' ? 'active' : ''}`} onClick={() => setTab('workers')}>
          Workers (payroll)
        </button>
      </div>

      {tab === 'access' && <UserAccessTab />}
      {tab === 'tags' && <TagsTab />}
      {tab === 'workers' && <WorkersTab />}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* User access: every signed-up email, what they can see and do.      */
/* Admin-only — RLS also enforces this on the backend.                */
/* ------------------------------------------------------------------ */

function UserAccessTab() {
  const { profile } = useAuth()
  const isAdmin = profile?.role === 'admin'
  const [profiles, setProfiles] = useState<Profile[]>([])
  const [stations, setStations] = useState<Station[]>([])
  const [grades, setGrades] = useState<Grade[]>([])
  const [approverToAdd, setApproverToAdd] = useState('')
  const [tagInfo, setTagInfo] = useState<Grade | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  async function load() {
    const [p, s, g] = await Promise.all([
      supabase.from('access_profiles').select('*').order('email'),
      supabase.from('stations').select('id, name, sort_order').order('sort_order'),
      supabase.from('grades').select('*').order('sort_order', { ascending: false }),
    ])
    const err = p.error || s.error || g.error
    if (err) setError(err.message)
    setProfiles((p.data ?? []) as Profile[])
    setStations(s.data ?? [])
    setGrades((g.data ?? []) as Grade[])
    setLoading(false)
  }

  useEffect(() => {
    load()
  }, [])

  async function update(p: Profile, fields: Partial<Profile>) {
    const { error } = await supabase.from('access_profiles').update(fields).eq('id', p.id)
    if (error) setError(error.message)
    else load()
  }

  if (!isAdmin) {
    return (
      <div className="card">
        <p className="muted">Only admins can manage user access.</p>
      </div>
    )
  }
  if (loading) return <p className="muted">Loading…</p>

  const approvers = profiles.filter((p) => p.can_approve_rates)
  const nonApprovers = profiles.filter((p) => !p.can_approve_rates)
  const label = (p: Profile) => p.email ?? p.full_name ?? p.id.slice(0, 8)

  return (
    <div className="stack">
      {error && <div className="error">{error}</div>}

      <div className="grid-2">
        {/* 1 — who can approve piece rates, and their step in the flow */}
        <div className="card stack approval-card">
          <h3>Piece rate approval</h3>
          <p className="muted small">
            These emails act on new piece rates: <strong>Verify</strong> checks the
            proposal, <strong>Approval</strong> gives the final decision.
          </p>
          {approvers.length === 0 && <p className="muted small">No approvers yet.</p>}
          {approvers.map((p) => (
            <div className="row-form spread approver-row" key={p.id}>
              <span className="small">{label(p)}</span>
              <span className="row-form" style={{ gap: '0.5rem' }}>
                <select
                  value={p.approval_role ?? 'verify'}
                  onChange={(e) => update(p, { approval_role: e.target.value as Profile['approval_role'] })}
                >
                  <option value="verify">Verify</option>
                  <option value="approve">Approval</option>
                </select>
                <button className="linkbtn danger" onClick={() => update(p, { can_approve_rates: false })}>
                  Remove
                </button>
              </span>
            </div>
          ))}
          <div className="row-form">
            <select value={approverToAdd} onChange={(e) => setApproverToAdd(e.target.value)} style={{ flex: 1 }}>
              <option value="">Pick an email to allow…</option>
              {nonApprovers.map((p) => (
                <option key={p.id} value={p.id}>{label(p)}</option>
              ))}
            </select>
            <button
              className="btn"
              disabled={!approverToAdd}
              onClick={() => {
                const p = profiles.find((x) => x.id === approverToAdd)
                if (p) update(p, { can_approve_rates: true, approval_role: p.approval_role ?? 'verify' })
                setApproverToAdd('')
              }}
            >
              Allow
            </button>
          </div>
        </div>

        {/* 2 — the tags; click one to see what it can see and do */}
        <div className="card stack">
          <h3>Tags</h3>
          <p className="muted small">Click a tag to see its access. Manage them in the Tags tab.</p>
          <div className="tag-list">
            {grades.map((g) => (
              <button className="tag-row" key={g.id} onClick={() => setTagInfo(g)}>
                <span className={`tag-dot dot-${g.color}`} aria-hidden="true" />
                <span>{g.name}</span>
              </button>
            ))}
          </div>
        </div>
      </div>

      {tagInfo && (
        <div className="modal-overlay" onClick={() => setTagInfo(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="row-form spread">
              <h2><span className={tagClass(tagInfo.color)}>{tagInfo.name}</span></h2>
              <button type="button" className="modal-close" onClick={() => setTagInfo(null)} aria-label="Close">×</button>
            </div>
            <p className="muted small">Tier {tagInfo.sort_order} — sees its own tier and every tier below.</p>
            <div className="field">
              <span>Can see / do</span>
              <p style={{ margin: 0 }}>{tagInfo.ability ?? 'Not described yet — set it in the Tags tab.'}</p>
            </div>
          </div>
        </div>
      )}

      {/* 3 — every signed-up account */}
      <div className="card stack">
        <h3>Users</h3>
        <p className="muted small">
          Accounts appear here when someone signs up on the login page. Appoint each
          email's role and tags; the tags decide which piece rates they see.
        </p>
        <table className="table">
          <thead>
            <tr>
              <th>Email</th>
              <th>Role</th>
              <th>Station tag</th>
              <th>Grade tag</th>
            </tr>
          </thead>
          <tbody>
            {profiles.length === 0 && (
              <tr><td colSpan={4} className="muted">No sign-ups yet.</td></tr>
            )}
            {profiles.map((p) => (
              <tr key={p.id}>
                <td>{label(p)}</td>
                <td>
                  <select value={p.role} onChange={(e) => update(p, { role: e.target.value as Role })}>
                    {ROLES.map((r) => (
                      <option key={r} value={r}>{r}</option>
                    ))}
                  </select>
                </td>
                <td>
                  <select
                    value={p.station_id ?? ''}
                    onChange={(e) => update(p, { station_id: e.target.value || null })}
                  >
                    <option value="">—</option>
                    {stations.map((s) => (
                      <option key={s.id} value={s.id}>{s.name}</option>
                    ))}
                  </select>
                </td>
                <td>
                  <select
                    value={p.grade_id ?? ''}
                    onChange={(e) => update(p, { grade_id: e.target.value || null })}
                  >
                    <option value="">—</option>
                    {grades.map((g) => (
                      <option key={g.id} value={g.id}>{g.name}</option>
                    ))}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Tags: grade tags with colour + ability (the access legend).        */
/* ------------------------------------------------------------------ */

function TagsTab() {
  const [grades, setGrades] = useState<Grade[]>([])
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [color, setColor] = useState('blue')
  const [ability, setAbility] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  async function load() {
    const { data, error } = await supabase
      .from('grades')
      .select('*')
      .order('sort_order', { ascending: false })
    if (error) setError(error.message)
    else setGrades((data ?? []) as Grade[])
    setLoading(false)
  }

  useEffect(() => {
    load()
  }, [])

  async function addTag(e: FormEvent) {
    e.preventDefault()
    setError(null)
    const sort = Math.max(0, ...grades.map((g) => g.sort_order)) + 1
    const { error } = await supabase
      .from('grades')
      .insert({ name: name.trim(), sort_order: sort, color, ability: ability.trim() || null })
    if (error) return setError(error.message)
    setName('')
    setAbility('')
    setAdding(false)
    load()
  }

  async function update(g: Grade, fields: Partial<Grade>) {
    const { error } = await supabase.from('grades').update(fields).eq('id', g.id)
    if (error) setError(error.message)
    else load()
  }

  async function rename(g: Grade) {
    const next = window.prompt('Tag name', g.name)
    if (next && next.trim() !== g.name) update(g, { name: next.trim() })
  }

  async function editAbility(g: Grade) {
    const next = window.prompt('What can this tag see / do?', g.ability ?? '')
    if (next !== null) update(g, { ability: next.trim() || null })
  }

  async function remove(g: Grade) {
    if (!window.confirm(`Delete tag "${g.name}"? This fails if it is in use.`)) return
    const { error } = await supabase.from('grades').delete().eq('id', g.id)
    if (error) setError(error.message)
    else load()
  }

  if (loading) return <p className="muted">Loading…</p>

  return (
    <div className="stack">
      {error && <div className="error">{error}</div>}

      <div className="card stack">
        <div className="row-form spread">
          <h3>Tags</h3>
          <button className="btn" onClick={() => setAdding((v) => !v)}>
            {adding ? 'Cancel' : '+ Add tag'}
          </button>
        </div>

        {adding && (
          <form className="row-form" onSubmit={addTag}>
            <label className="field inline">
              <span>Tag name</span>
              <input value={name} onChange={(e) => setName(e.target.value)} autoFocus required />
            </label>
            <label className="field inline">
              <span>Colour</span>
              <select value={color} onChange={(e) => setColor(e.target.value)}>
                {TAG_COLORS.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </label>
            <label className="field inline grow">
              <span>Can see / do</span>
              <input value={ability} onChange={(e) => setAbility(e.target.value)} />
            </label>
            <button className="btn" type="submit">Save tag</button>
          </form>
        )}

        <table className="table">
          <thead>
            <tr>
              <th>Tag</th>
              <th>Tier</th>
              <th>Colour</th>
              <th>Can see / do</th>
              <th className="right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {grades.length === 0 && (
              <tr><td colSpan={5} className="muted">No tags yet — click “+ Add tag”.</td></tr>
            )}
            {grades.map((g) => (
              <tr key={g.id}>
                <td><span className={tagClass(g.color)}>{g.name}</span></td>
                <td className="muted">{g.sort_order}</td>
                <td>
                  <select value={g.color} onChange={(e) => update(g, { color: e.target.value })}>
                    {TAG_COLORS.map((c) => (
                      <option key={c} value={c}>{c}</option>
                    ))}
                  </select>
                </td>
                <td className="muted">{g.ability ?? '—'}</td>
                <td className="right">
                  <button className="linkbtn" onClick={() => rename(g)}>Rename</button>{' '}
                  <button className="linkbtn" onClick={() => editAbility(g)}>Edit ability</button>{' '}
                  <button className="linkbtn danger" onClick={() => remove(g)}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted small">
          Higher tier sees more: a user sees piece rates of their tier and every tier below.
        </p>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Workers: the payroll name list (who gets paid). Kept separate from */
/* User access, which is about login accounts.                        */
/* ------------------------------------------------------------------ */

function WorkersTab() {
  const [workers, setWorkers] = useState<Worker[]>([])
  const [stations, setStations] = useState<Station[]>([])
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [stationId, setStationId] = useState('')
  const [showInactive, setShowInactive] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  async function load() {
    const [w, s] = await Promise.all([
      supabase.from('workers').select('id, full_name, station_id, grade_id, can_approve_rates, active').order('full_name'),
      supabase.from('stations').select('id, name, sort_order').order('sort_order'),
    ])
    if (w.error) setError(w.error.message)
    else setWorkers(w.data ?? [])
    if (s.error) setError(s.error.message)
    else setStations(s.data ?? [])
    setLoading(false)
  }

  useEffect(() => {
    load()
  }, [])

  async function addWorker(e: FormEvent) {
    e.preventDefault()
    setError(null)
    const { error } = await supabase
      .from('workers')
      .insert({ full_name: name.trim(), station_id: stationId || null })
    if (error) return setError(error.message)
    setName('')
    setAdding(false)
    load()
  }

  async function update(w: Worker, fields: Partial<Worker>) {
    const { error } = await supabase.from('workers').update(fields).eq('id', w.id)
    if (error) setError(error.message)
    else load()
  }

  if (loading) return <p className="muted">Loading…</p>

  const visible = workers.filter((w) => showInactive || w.active)

  return (
    <div className="stack">
      {error && <div className="error">{error}</div>}

      <div className="card stack">
        <div className="row-form spread">
          <h3>Workers</h3>
          <button className="btn" onClick={() => setAdding((v) => !v)}>
            {adding ? 'Cancel' : '+ Add worker'}
          </button>
        </div>
        <p className="muted small">
          The payroll name list — production entries and payslips are per worker. Not
          every worker needs a login.
        </p>

        {adding && (
          <form className="row-form" onSubmit={addWorker}>
            <label className="field inline grow">
              <span>Full name</span>
              <input value={name} onChange={(e) => setName(e.target.value)} autoFocus required />
            </label>
            <label className="field inline">
              <span>Station</span>
              <select value={stationId} onChange={(e) => setStationId(e.target.value)}>
                <option value="">—</option>
                {stations.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </label>
            <button className="btn" type="submit">Save worker</button>
          </form>
        )}

        <label className="small muted checkbox">
          <input
            type="checkbox"
            checked={showInactive}
            onChange={(e) => setShowInactive(e.target.checked)}
          />{' '}
          Show inactive
        </label>

        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Station</th>
              <th>Status</th>
              <th className="right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 && (
              <tr><td colSpan={4} className="muted">No workers yet — click “+ Add worker”.</td></tr>
            )}
            {visible.map((w) => (
              <tr key={w.id}>
                <td>{w.full_name}</td>
                <td>
                  <select
                    value={w.station_id ?? ''}
                    onChange={(e) => update(w, { station_id: e.target.value || null })}
                  >
                    <option value="">—</option>
                    {stations.map((s) => (
                      <option key={s.id} value={s.id}>{s.name}</option>
                    ))}
                  </select>
                </td>
                <td>
                  <span className={`badge ${w.active ? 'ok' : 'off'}`}>{w.active ? 'active' : 'inactive'}</span>
                </td>
                <td className="right">
                  {w.active ? (
                    <button className="linkbtn danger" onClick={() => update(w, { active: false })}>Deactivate</button>
                  ) : (
                    <button className="linkbtn" onClick={() => update(w, { active: true })}>Reactivate</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
