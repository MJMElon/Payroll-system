import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import {
  supabase,
  profileName,
  type Grade,
  type Profile,
  type Role,
  type Station,
} from '../lib/supabase'
import {
  ALL_CAPABILITIES,
  CAPABILITY_OPTIONS,
  DEFAULT_MODULES,
  MODULE_OPTIONS,
  capabilityLabel,
  effectiveCapabilities,
  nextTagColor,
  sortCapabilities,
  tagClass,
} from '../lib/tags'

type Tab = 'access' | 'tags'

// Role (route access) follows the tier tag so the panel only needs tags.
function roleForTier(tier: number | null, name?: string): Role {
  if (tier === null) return 'operator'
  if (tier <= 2) return 'manager'
  if (tier === 3 || (name ?? '').toLowerCase().includes('engineer')) return 'engineer'
  return 'operator'
}

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
          Tags management
        </button>
      </div>

      {tab === 'access' && <UserAccessTab />}
      {tab === 'tags' && <TagsTab />}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* User access: every signed-up email, what they can see and do.      */
/* Admin-only — RLS also enforces this on the backend.                */
/* ------------------------------------------------------------------ */

function UserAccessTab() {
  const { profile } = useAuth()
  const [profiles, setProfiles] = useState<Profile[]>([])
  const [stations, setStations] = useState<Station[]>([])
  const [grades, setGrades] = useState<Grade[]>([])
  const [accessUser, setAccessUser] = useState<Profile | null>(null)
  const [openTiers, setOpenTiers] = useState<Record<string, boolean>>({})
  const [panelView, setPanelView] = useState<'structure' | 'tier'>('structure')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const isAdmin = profile?.role === 'admin'

  async function load() {
    const [p, s, g] = await Promise.all([
      supabase.from('access_profiles').select('*').order('email'),
      supabase.from('stations').select('*').order('sort_order'),
      supabase.from('grades').select('*').order('sort_order'),
    ])
    const err = p.error || s.error || g.error
    if (err) setError(err.message)
    setProfiles((p.data ?? []) as Profile[])
    setStations(s.data ?? [])
    setGrades(((g.data ?? []) as Grade[]).sort((a, b) => a.sort_order - b.sort_order))
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

  const tierOf = (p: Profile) =>
    p.grade_id ? grades.find((g) => g.id === p.grade_id)?.sort_order ?? null : null
  const bottomTier = Math.max(0, ...grades.map((g) => g.sort_order))
  const myTier = profile?.grade_id
    ? grades.find((g) => g.id === profile.grade_id)?.sort_order ?? null
    : null
  // Anyone at least one tier above the bottom can see + confirm new signups.
  const canConfirm = isAdmin || (myTier !== null && myTier < bottomTier)
  // Non-admins may only hand out tiers strictly below their own.
  const assignableGrades = isAdmin
    ? grades
    : grades.filter((g) => myTier !== null && g.sort_order > myTier)
  // The full control panel opens for admins, tier 1, and tiers granted the
  // "Change other users' settings" capability — who may only edit users of
  // a LOWER tier than their own.
  const myCaps = effectiveCapabilities(
    profile?.grade_id ? grades.find((g) => g.id === profile.grade_id) : null,
  )
  const canManageUsers = isAdmin || myTier === 1 || myCaps.includes('user-access')
  const userEditable = (p: Profile) =>
    isAdmin || myTier === 1 || (myTier !== null && (tierOf(p) === null || tierOf(p)! > myTier))

  if (!canConfirm) {
    return (
      <div className="card">
        <p className="muted">Only upper tiers or admins can manage user access.</p>
      </div>
    )
  }
  if (loading) return <p className="muted">Loading…</p>

  const label = (p: Profile) => profileName(p)
  const capsOf = (p: Profile) =>
    effectiveCapabilities(p.grade_id ? grades.find((g) => g.id === p.grade_id) : null)
  const approvalUsers = profiles.filter((p) => capsOf(p).includes('rate-approve'))
  const verifyUsers = profiles.filter((p) => capsOf(p).includes('rate-verify'))
  const stationLabel = (p: Profile) => {
    const ids = p.station_ids && p.station_ids.length > 0
      ? p.station_ids
      : p.station_id
        ? [p.station_id]
        : []
    if (ids.length === 0) return 'All stations'
    return ids
      .map((id) => stations.find((st) => st.id === id)?.name ?? '?')
      .join(', ')
  }

  const pending = profiles.filter((p) => !p.tags_confirmed)
  const confirmed = profiles
    .filter((p) => p.tags_confirmed)
    .sort((a, b) => (tierOf(a) ?? 99) - (tierOf(b) ?? 99) || (a.email ?? '').localeCompare(b.email ?? ''))

  // Sync route access with the tier when a tag is handed out.
  function tierFields(gradeId: string | null, p: Profile): Partial<Profile> {
    const g = grades.find((x) => x.id === gradeId)
    const fields: Partial<Profile> = { grade_id: gradeId }
    if (p.role !== 'admin') fields.role = roleForTier(g?.sort_order ?? null, g?.name)
    return fields
  }

  return (
    <div className="stack">
      {error && <div className="error">{error}</div>}

      {canManageUsers && (
        <div className="card stack compact approval-card">
          <h3>Piece rate approval</h3>
          <div className="field">
            <span>Verify by</span>
            {verifyUsers.length === 0
              ? <p className="muted small" style={{ margin: 0 }}>No one yet — assign a tag with the verify capability.</p>
              : verifyUsers.map((p) => <div className="small" key={p.id}>{label(p)}</div>)}
          </div>
          <div className="field">
            <span>Approval by</span>
            {approvalUsers.length === 0
              ? <p className="muted small" style={{ margin: 0 }}>No one yet — assign a tag with the approve capability.</p>
              : approvalUsers.map((p) => <div className="small" key={p.id}>{label(p)}</div>)}
          </div>
        </div>
      )}

      {/* 1 — new signups waiting for their tags to be confirmed */}
      <div className="card stack approval-card">
        <div className="row-form spread">
          <h3>New sign ups — pending tag confirmation</h3>
          {pending.length > 0 && <span className="count-badge static">{pending.length}</span>}
        </div>
        {pending.length === 0 && <p className="muted small">No new sign ups waiting.</p>}
        {pending.length > 0 && (
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Tier tag</th>
                <th>Station tag</th>
                <th className="right">Confirm</th>
              </tr>
            </thead>
            <tbody>
              {pending.map((p) => (
                <tr key={p.id}>
                  <td>{p.full_name ?? '—'} <span className="badge new">new</span></td>
                  <td className="muted small">{p.email}</td>
                  <td>
                    <select
                      value={p.grade_id ?? ''}
                      onChange={(e) => update(p, tierFields(e.target.value || null, p))}
                    >
                      <option value="">—</option>
                      {assignableGrades.map((g) => (
                        <option key={g.id} value={g.id}>{g.name}</option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <StationMultiSelect
                      stations={stations}
                      value={p.station_ids ?? (p.station_id ? [p.station_id] : [])}
                      onChange={(ids) => update(p, { station_ids: ids, station_id: ids[0] ?? null })}
                    />
                  </td>
                  <td className="right">
                    <button
                      className="btn"
                      disabled={!p.grade_id}
                      title={p.grade_id ? 'Confirm this user' : 'Set a tier tag first'}
                      onClick={() => update(p, { tags_confirmed: true })}
                    >
                      Confirm
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="muted small">
          Sign ups default to Operator with all modules visible. Set their station and
          tier, then confirm to move them into the user list.
        </p>
      </div>

      {/* 2 — confirmed users: team-structure tree or tier groups */}
      {canManageUsers && (
        <div className="card stack">
          <div className="row-form spread">
            <h3>User access control panel</h3>
            <div className="view-toggle">
              <button
                type="button"
                className={panelView === 'structure' ? 'active' : ''}
                onClick={() => setPanelView('structure')}
              >
                Team structure
              </button>
              <button
                type="button"
                className={panelView === 'tier' ? 'active' : ''}
                onClick={() => setPanelView('tier')}
              >
                By tier
              </button>
            </div>
          </div>
          {confirmed.length === 0 && <p className="muted small">No confirmed users yet.</p>}

          {panelView === 'structure' && confirmed.length > 0 && (
            <StructureTree
              users={confirmed}
              grades={grades}
              stationLabel={stationLabel}
              userEditable={userEditable}
              onEdit={setAccessUser}
            />
          )}

          {panelView === 'tier' && [
            ...grades.map((g) => ({
              key: g.id,
              grade: g as Grade | null,
              users: confirmed.filter((p) => p.grade_id === g.id),
            })),
            {
              key: 'untagged',
              grade: null as Grade | null,
              users: confirmed.filter(
                (p) => !p.grade_id || !grades.some((g) => g.id === p.grade_id),
              ),
            },
          ]
            .filter((grp) => grp.users.length > 0)
            .map((grp) => {
              const open = openTiers[grp.key] ?? false
              return (
                <div key={grp.key} className="tier-group">
                  <button
                    type="button"
                    className="tier-group-header"
                    onClick={() => setOpenTiers((s) => ({ ...s, [grp.key]: !open }))}
                  >
                    <span className="chev">{open ? '▾' : '▸'}</span>
                    {grp.grade ? (
                      <span className={tagClass(grp.grade.color)}>{grp.grade.name}</span>
                    ) : (
                      <span className="tagbadge tag-grey">No tier tag</span>
                    )}
                    <span className="muted small">
                      {grp.users.length} user{grp.users.length === 1 ? '' : 's'}
                    </span>
                  </button>
                  {open && (
                    <table className="table">
                      <thead>
                        <tr>
                          <th>Employee code</th>
                          <th>Name</th>
                          <th>Email</th>
                          <th>Station</th>
                          <th className="right">Access</th>
                        </tr>
                      </thead>
                      <tbody>
                        {grp.users.map((p) => (
                          <tr key={p.id}>
                            <td className="muted small">{p.employee_code ?? '—'}</td>
                            <td>{p.full_name ?? '—'}</td>
                            <td className="muted small">{p.email}</td>
                            <td className="muted small">{stationLabel(p)}</td>
                            <td className="right">
                              {userEditable(p) && (
                                <button
                                  className="icon-btn sm"
                                  title="Manage access"
                                  aria-label={`Set access for ${label(p)}`}
                                  onClick={() => setAccessUser(p)}
                                >
                                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                                    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <circle cx="12" cy="8" r="4" />
                                    <path d="M4 21v-1a7 7 0 0 1 10.6-6" />
                                    <circle cx="18" cy="18" r="3" />
                                    <path d="M18 14.5v1M18 20.5v1M21.5 18h-1M15.5 18h-1" />
                                  </svg>
                                </button>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              )
            })}
        </div>
      )}

      {accessUser && (
        <UserAccessModal
          user={accessUser}
          stations={stations}
          grades={isAdmin || myTier === 1 ? grades : assignableGrades}
          allGrades={grades}
          profiles={profiles.filter((p) => p.tags_confirmed)}
          onClose={() => setAccessUser(null)}
          onSaved={() => {
            setAccessUser(null)
            load()
          }}
        />
      )}

    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Team structure tree: everyone hangs under the direct upper they    */
/* report to ("Reports to" in Manage access) — so it's obvious who    */
/* verifies/approves whose work. Users without an upper sit at the    */
/* root, sorted by tier.                                              */
/* ------------------------------------------------------------------ */

function StructureTree({
  users,
  grades,
  stationLabel,
  userEditable,
  onEdit,
}: {
  users: Profile[]
  grades: Grade[]
  stationLabel: (p: Profile) => string
  userEditable: (p: Profile) => boolean
  onEdit: (p: Profile) => void
}) {
  const gradeOf = (p: Profile) => grades.find((g) => g.id === p.grade_id)
  const tierOf = (p: Profile) => gradeOf(p)?.sort_order ?? 99
  const byTierName = (a: Profile, b: Profile) =>
    tierOf(a) - tierOf(b) || profileName(a).localeCompare(profileName(b))

  const childrenOf = (id: string) =>
    users.filter((p) => p.supervisor_id === id).sort(byTierName)
  // Roots: no supervisor, or the supervisor isn't in the confirmed list.
  const roots = users
    .filter((p) => !p.supervisor_id || !users.some((x) => x.id === p.supervisor_id))
    .sort(byTierName)
  const unlinked = users.filter((p) => !p.supervisor_id).length

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
          {userEditable(p) && (
            <button
              className="icon-btn sm tree-gear"
              title="Manage access"
              aria-label={`Set access for ${profileName(p)}`}
              onClick={() => onEdit(p)}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="8" r="4" />
                <path d="M4 21v-1a7 7 0 0 1 10.6-6" />
                <circle cx="18" cy="18" r="3" />
                <path d="M18 14.5v1M18 20.5v1M21.5 18h-1M15.5 18h-1" />
              </svg>
            </button>
          )}
        </div>
        {kids.map((c) => renderNode(c, depth + 1))}
      </div>
    )
  }

  return (
    <div className="stack" style={{ gap: '0.1rem' }}>
      {roots.map((p) => renderNode(p, 0))}
      {unlinked > 1 && (
        <p className="muted small" style={{ marginTop: '0.6rem' }}>
          Set each user's "Reports to" in Manage access to hang them under
          their direct upper — e.g. operators under an assistant head,
          assistant heads under the station head.
        </p>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Per-user access pop-out. Its job is ONLY assigning tags: station   */
/* tag(s) + tier tag. What a tier can see and do lives in Tags        */
/* management. Employee code is set here too (its only home).         */
/* ------------------------------------------------------------------ */

function UserAccessModal({
  user,
  stations,
  grades,
  allGrades,
  profiles,
  onClose,
  onSaved,
}: {
  user: Profile
  stations: Station[]
  grades: Grade[]
  allGrades: Grade[]
  profiles: Profile[]
  onClose: () => void
  onSaved: () => void
}) {
  const [employeeCode, setEmployeeCode] = useState(user.employee_code ?? '')
  const [stationIds, setStationIds] = useState<string[]>(
    user.station_ids ?? (user.station_id ? [user.station_id] : []),
  )
  const [gradeId, setGradeId] = useState(user.grade_id ?? '')
  const [supervisorId, setSupervisorId] = useState(user.supervisor_id ?? '')
  const [approvalScreen, setApprovalScreen] = useState(user.mobile_approval ?? '')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  // "Reports to" candidates: confirmed accounts of a STRICTLY higher tier
  // than this user's (selected) tier — which keeps the chain loop-free.
  const tierOfP = (p: Profile) =>
    p.grade_id ? allGrades.find((g) => g.id === p.grade_id)?.sort_order ?? null : null
  const selTier = gradeId ? allGrades.find((g) => g.id === gradeId)?.sort_order ?? null : null
  const supervisors = profiles
    .filter((p) => {
      if (p.id === user.id) return false
      const t = tierOfP(p)
      return t !== null && (selTier === null || t < selTier)
    })
    .sort((a, b) => (tierOfP(a)! - tierOfP(b)!) || profileName(a).localeCompare(profileName(b)))
  const supGradeName = (p: Profile) =>
    allGrades.find((g) => g.id === p.grade_id)?.name ?? '—'

  async function save(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setSaving(true)
    const g = grades.find((x) => x.id === gradeId)
    const validSupervisor = supervisors.some((p) => p.id === supervisorId)
    const fields: Partial<Profile> = {
      employee_code: employeeCode.trim() || null,
      station_ids: stationIds,
      station_id: stationIds[0] ?? null,
      grade_id: gradeId || null,
      supervisor_id: validSupervisor ? supervisorId : null,
      mobile_approval: (approvalScreen || null) as Profile['mobile_approval'],
    }
    if (user.role !== 'admin') fields.role = roleForTier(g?.sort_order ?? null, g?.name)
    const { error } = await supabase.from('access_profiles').update(fields).eq('id', user.id)
    setSaving(false)
    if (error) return setError(error.message)
    onSaved()
  }

  const initials = profileName(user).split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase()

  return (
    <div className="modal-overlay" onClick={onClose}>
      <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={save}>
        <div className="row-form spread">
          <h2>Manage access</h2>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        {error && <div className="error">{error}</div>}

        {/* Who this is — identity from sign up, not edited here. */}
        <div className="user-id-card">
          <span className="user-id-avatar">{initials}</span>
          <span className="user-id-main">
            <span className="user-id-name">{profileName(user)}</span>
            <span className="muted small">{user.email ?? '—'}</span>
          </span>
          <label className="field user-id-code">
            <span>Employee code</span>
            <input
              value={employeeCode}
              onChange={(e) => setEmployeeCode(e.target.value)}
              placeholder="EMP001"
            />
          </label>
        </div>

        <div className="tag-section">
          <div className="tag-section-title">Tier tag</div>
          <select value={gradeId} onChange={(e) => setGradeId(e.target.value)}>
            <option value="">—</option>
            {grades.map((g) => (
              <option key={g.id} value={g.id}>{g.sort_order}. {g.name}</option>
            ))}
          </select>
          <p className="tag-section-hint">
            What the tier can see and do is set in Settings → Tags management.
          </p>
        </div>

        <div className="tag-section">
          <div className="tag-section-title">Station tag</div>
          <StationMultiSelect stations={stations} value={stationIds} onChange={setStationIds} />
          <p className="tag-section-hint">No station selected = sees all stations.</p>
        </div>

        <div className="tag-section">
          <div className="tag-section-title">Reports to (direct upper)</div>
          <select value={supervisorId} onChange={(e) => setSupervisorId(e.target.value)}>
            <option value="">— no one yet —</option>
            {supervisors.map((p) => (
              <option key={p.id} value={p.id}>
                {profileName(p)} · {supGradeName(p)}
              </option>
            ))}
          </select>
          <p className="tag-section-hint">
            Only higher tiers can be chosen. This builds the team structure tree
            — e.g. 4 operators under 1 assistant head, 2 assistant heads under 1
            station head.
          </p>
        </div>

        <div className="tag-section">
          <div className="tag-section-title">Work approval screen (mobile)</div>
          <select value={approvalScreen} onChange={(e) => setApprovalScreen(e.target.value)}>
            <option value="">Not allowed — no Approvals page</option>
            <option value="verify">Verification — can verify submitted work</option>
            <option value="approve">Final approval — can verify and approve</option>
          </select>
          <p className="tag-section-hint">
            Opens the Approvals page in the mobile app for THIS user only — it
            is granted per person here, not fixed to any tier.
          </p>
        </div>

        <div className="row-form" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn" type="submit" disabled={saving}>
            {saving ? 'Saving…' : 'Save access'}
          </button>
        </div>
      </form>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Pick any number of station tags for a user (none = all stations).  */
/* ------------------------------------------------------------------ */

function StationMultiSelect({
  stations,
  value,
  onChange,
}: {
  stations: Station[]
  value: string[]
  onChange: (ids: string[]) => void
}) {
  const [open, setOpen] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)

  // Close on a click outside the panel (moving the mouse out keeps it open).
  useEffect(() => {
    if (!open) return
    function onDocClick(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [open])
  const label =
    value.length === 0
      ? 'All stations'
      : value.length === 1
        ? stations.find((s) => s.id === value[0])?.name ?? '1 station'
        : `${value.length} stations`

  function toggle(id: string) {
    onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id])
  }

  return (
    <div className="multi-select" ref={boxRef}>
      <button type="button" className="btn ghost multi-toggle" onClick={() => setOpen((v) => !v)}>
        {label} ▾
      </button>
      {open && (
        <div className="multi-panel">
          <label className="checkbox small" style={{ margin: 0 }}>
            <input
              type="checkbox"
              checked={value.length === 0}
              onChange={() => onChange([])}
            />{' '}
            All stations
          </label>
          {stations.map((s) => (
            <label className="checkbox small" key={s.id} style={{ margin: 0 }}>
              <input
                type="checkbox"
                checked={value.includes(s.id)}
                onChange={() => toggle(s.id)}
              />{' '}
              {s.name}
            </label>
          ))}
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */

function TagsTab() {
  const { profile } = useAuth()
  const [grades, setGrades] = useState<Grade[]>([])
  const [stations, setStations] = useState<Station[]>([])
  const [dragId, setDragId] = useState<string | null>(null)
  const [editor, setEditor] = useState<'closed' | 'new' | Grade>('closed')
  const [addingStation, setAddingStation] = useState(false)
  const [stationName, setStationName] = useState('')
  const [dragStation, setDragStation] = useState<string | null>(null)
  const [stationEditor, setStationEditor] = useState<Station | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  async function load() {
    const [g, st] = await Promise.all([
      supabase.from('grades').select('*').order('sort_order'),
      supabase.from('stations').select('*').order('sort_order'),
    ])
    const err = g.error || st.error
    if (err) setError(err.message)
    setGrades(((g.data ?? []) as Grade[]).sort((a, b) => a.sort_order - b.sort_order))
    setStations(st.data ?? [])
    setLoading(false)
  }

  useEffect(() => {
    load()
  }, [])

  // Each admin function is granted separately per tier by the super admin
  // (tier 1): add new tag, move tag tiers, edit tags' settings, manage
  // stations. Admins and tier 1 always have everything.
  const myGrade = profile?.grade_id ? grades.find((g) => g.id === profile.grade_id) ?? null : null
  const myTier = myGrade?.sort_order ?? null
  const myCaps = effectiveCapabilities(myGrade)
  const isSuperUser = profile?.role === 'admin' || myTier === 1
  const canAddTag = isSuperUser || myCaps.includes('tag-add')
  const canMoveTags = isSuperUser || myCaps.includes('tag-move')
  const canEditTags = isSuperUser || myCaps.includes('tag-edit')
  // A granted (non-super) user may only touch tags BELOW their own tier —
  // they can never promote themselves or change their superiors.
  const rowEditable = (g: Grade) =>
    g.sort_order !== 1 && (isSuperUser || (myTier !== null && g.sort_order > myTier))
  const canManageStations =
    profile?.role === 'admin' || profile?.role === 'manager' ||
    myTier === 1 || myCaps.includes('station-create')

  // Drop a dragged tag onto another: reorder locally, then renumber every
  // tier 1..n so tier numbers always run top-down with no gaps.
  async function dropOnTag(targetId: string) {
    if (!dragId || dragId === targetId) return
    const dragged = grades.find((g) => g.id === dragId)!
    const target = grades.find((g) => g.id === targetId)
    // The tier-1 tag is the super admin — pinned at #1: it can't be moved
    // and nothing can be dropped above it. Granted users may only move
    // tags below their own tier.
    if (!target || !rowEditable(dragged) || !rowEditable(target)) {
      setDragId(null)
      return
    }
    const movingDown = grades.findIndex((g) => g.id === dragId) < grades.findIndex((g) => g.id === targetId)
    const next = grades.filter((g) => g.id !== dragId)
    next.splice(next.findIndex((g) => g.id === targetId) + (movingDown ? 1 : 0), 0, dragged)
    setDragId(null)
    setGrades(next.map((g, i) => ({ ...g, sort_order: i + 1 })))
    const results = await Promise.all(
      next.map((g, i) => supabase.from('grades').update({ sort_order: i + 1 }).eq('id', g.id)),
    )
    const err = results.find((r) => r.error)
    if (err?.error) setError(err.error.message)
    load()
  }

  async function removeTag(g: Grade) {
    if (!window.confirm(`Delete tag "${g.name}"? This fails if it is in use.`)) return
    const { error } = await supabase.from('grades').delete().eq('id', g.id)
    if (error) setError(error.message)
    else load()
  }

  async function addStation(e: FormEvent) {
    e.preventDefault()
    setError(null)
    const sort = Math.max(0, ...stations.map((x) => x.sort_order)) + 1
    const { error } = await supabase
      .from('stations')
      .insert({ name: stationName.trim(), sort_order: sort })
    if (error) return setError(error.message)
    setStationName('')
    setAddingStation(false)
    load()
  }

  // Reorder the station list by dragging (display sequence only).
  async function dropOnStation(targetId: string) {
    if (!dragStation || dragStation === targetId) return
    const movingDown =
      stations.findIndex((x) => x.id === dragStation) < stations.findIndex((x) => x.id === targetId)
    const next = stations.filter((x) => x.id !== dragStation)
    const dragged = stations.find((x) => x.id === dragStation)!
    next.splice(next.findIndex((x) => x.id === targetId) + (movingDown ? 1 : 0), 0, dragged)
    setDragStation(null)
    setStations(next.map((x, i) => ({ ...x, sort_order: i + 1 })))
    const results = await Promise.all(
      next.map((x, i) => supabase.from('stations').update({ sort_order: i + 1 }).eq('id', x.id)),
    )
    const err = results.find((r) => r.error)
    if (err?.error) setError(err.error.message)
    load()
  }

  async function removeStation(st: Station) {
    if (!window.confirm(`Delete station "${st.name}"? This fails if it is in use.`)) return
    const { error } = await supabase.from('stations').delete().eq('id', st.id)
    if (error) setError(error.message)
    else load()
  }

  if (loading) return <p className="muted">Loading…</p>

  return (
    <div className="stack">
      {error && <div className="error">{error}</div>}

      {/* Section 1 — tier tags */}
      <div className="card stack">
        <div className="row-form spread">
          <h3>Tier tags</h3>
          {canAddTag && (
            <button className="btn" onClick={() => setEditor('new')}>+ Add tag</button>
          )}
        </div>

        <table className="table">
          <thead>
            <tr>
              {canMoveTags && <th></th>}
              <th>Tier</th>
              <th>Tag</th>
              <th>Can do</th>
              {canEditTags && <th className="right">Actions</th>}
            </tr>
          </thead>
          <tbody>
            {grades.length === 0 && (
              <tr><td colSpan={6} className="muted">No tags yet.</td></tr>
            )}
            {grades.map((g) => {
              const isSuper = g.sort_order === 1
              const movable = canMoveTags && rowEditable(g)
              const editable = canEditTags && (isSuper ? isSuperUser : rowEditable(g))
              return (
                <tr
                  key={g.id}
                  className={`${movable ? 'drag-row' : ''} ${dragId === g.id ? 'dragging' : ''}`}
                  draggable={movable}
                  onDragStart={() => movable && setDragId(g.id)}
                  onDragEnd={() => setDragId(null)}
                  onDragOver={(e) => canMoveTags && e.preventDefault()}
                  onDrop={(e) => {
                    if (!canMoveTags) return
                    e.preventDefault()
                    dropOnTag(g.id)
                  }}
                  title={isSuper ? 'Super admin — always tier 1' : movable ? 'Drag to change tier' : undefined}
                >
                  {canMoveTags && (
                    <td className="drag-handle" aria-hidden="true">{isSuper ? '📌' : movable ? '⠿' : ''}</td>
                  )}
                  <td className="muted">{g.sort_order}</td>
                  <td><span className={tagClass(g.color)}>{g.name}</span></td>
                  <td className="muted small">
                    {isSuper ? (
                      <span className="badge off">Super admin — every ability</span>
                    ) : sortCapabilities(g.capabilities ?? []).length > 0 ? (
                      sortCapabilities(g.capabilities ?? []).map((c) => (
                        <span key={c} className="badge off" style={{ marginRight: '0.3rem' }}>
                          {capabilityLabel(c)}
                        </span>
                      ))
                    ) : (
                      '—'
                    )}
                  </td>
                  {canEditTags && (
                    <td className="right">
                      {editable && (
                        <>
                          <button className="linkbtn" onClick={() => setEditor(g)}>Edit</button>
                          {!isSuper && (
                            <>
                              {' '}
                              <button className="linkbtn danger" onClick={() => removeTag(g)}>Delete</button>
                            </>
                          )}
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

      {/* Section 2 — station tags */}
      <div className="card stack">
        <div className="row-form spread">
          <h3>Station tags</h3>
          {canManageStations && (
            <button
              className="btn"
              onClick={() => {
                setStationName('')
                setAddingStation((v) => !v)
              }}
            >
              {addingStation ? 'Cancel' : '+ Add station'}
            </button>
          )}
        </div>

        {addingStation && (
          <form className="row-form" onSubmit={addStation}>
            <label className="field inline grow">
              <span>New station name</span>
              <input value={stationName} onChange={(e) => setStationName(e.target.value)} autoFocus required />
            </label>
            <button className="btn" type="submit">Save station</button>
          </form>
        )}

        <table className="table">
          <thead>
            <tr>
              {canManageStations && <th></th>}
              <th>#</th>
              <th>Station</th>
              <th>Requirement</th>
              {canManageStations && <th className="right">Actions</th>}
            </tr>
          </thead>
          <tbody>
            {stations.map((st, i) => (
              <tr
                key={st.id}
                className={`${canManageStations ? 'drag-row' : ''} ${dragStation === st.id ? 'dragging' : ''}`}
                draggable={canManageStations}
                onDragStart={() => canManageStations && setDragStation(st.id)}
                onDragEnd={() => setDragStation(null)}
                onDragOver={(e) => canManageStations && e.preventDefault()}
                onDrop={(e) => {
                  if (!canManageStations) return
                  e.preventDefault()
                  dropOnStation(st.id)
                }}
                title={canManageStations ? 'Drag to reorder' : undefined}
              >
                {canManageStations && <td className="drag-handle" aria-hidden="true">⠿</td>}
                <td className="muted">{i + 1}</td>
                <td>{st.name}</td>
                <td className="muted small">
                  {st.hourly_count
                    ? `Hourly · min ${st.hourly_min_prev ?? 0} prev hr · max ${st.hourly_target ?? 6}/hr`
                    : '—'}
                </td>
                {canManageStations && (
                  <td className="right">
                    <button
                      className="icon-btn sm"
                      title="Edit station"
                      aria-label={`Edit ${st.name}`}
                      onClick={() => setStationEditor(st)}
                    >
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                        strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
                      </svg>
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {stationEditor && (
        <StationEditModal
          station={stationEditor}
          onClose={() => setStationEditor(null)}
          onSaved={() => {
            setStationEditor(null)
            load()
          }}
          onDelete={async () => {
            await removeStation(stationEditor)
            setStationEditor(null)
          }}
        />
      )}

      {editor !== 'closed' && (
        <TagEditModal
          grade={editor === 'new' ? null : editor}
          nextTier={Math.max(0, ...grades.map((g) => g.sort_order)) + 1}
          usedColors={grades.map((g) => g.color)}
          onClose={() => setEditor('closed')}
          onSaved={() => {
            setEditor('closed')
            load()
          }}
        />
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Station edit pop-out: name + the work requirement preset shown in  */
/* the mobile view (hourly stamp card).                               */
/* ------------------------------------------------------------------ */

function StationEditModal({
  station,
  onClose,
  onSaved,
  onDelete,
}: {
  station: Station
  onClose: () => void
  onSaved: () => void
  onDelete: () => void
}) {
  const [name, setName] = useState(station.name)
  const [hourly, setHourly] = useState(Boolean(station.hourly_count))
  const [minPrevInput, setMinPrevInput] = useState(String(station.hourly_min_prev ?? 0))
  const [targetInput, setTargetInput] = useState(String(station.hourly_target ?? 6))
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  async function save(e: FormEvent) {
    e.preventDefault()
    setError(null)
    const target = Number(targetInput)
    const minPrev = Number(minPrevInput)
    if (hourly && (!Number.isInteger(target) || target < 1 || target > 60)) {
      return setError('Max work done this hour must be a whole number between 1 and 60.')
    }
    if (hourly && (!Number.isInteger(minPrev) || minPrev < 0 || minPrev > 60)) {
      return setError('Min work done from previous hour must be a whole number between 0 and 60.')
    }
    setSaving(true)
    const { error } = await supabase
      .from('stations')
      .update({
        name: name.trim(),
        hourly_count: hourly,
        hourly_target: hourly ? target : station.hourly_target ?? 6,
        hourly_min_prev: hourly ? minPrev : station.hourly_min_prev ?? 0,
      })
      .eq('id', station.id)
    setSaving(false)
    if (error) return setError(error.message)
    onSaved()
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={save}>
        <div className="row-form spread">
          <h2>Edit station</h2>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        {error && <div className="error">{error}</div>}

        <label className="field">
          <span>Station name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} autoFocus required />
        </label>

        <div className="field">
          <span>Work requirement (shown in the mobile view)</span>
          <label className="checkbox small" style={{ margin: 0 }}>
            <input type="checkbox" checked={hourly} onChange={(e) => setHourly(e.target.checked)} />{' '}
            Hourly count — records are counted per hour (stamp card)
          </label>
        </div>

        {hourly && (
          <div className="row-form">
            <label className="field inline grow">
              <span>1. Min work done from previous hour</span>
              <input
                inputMode="numeric"
                value={minPrevInput}
                onChange={(e) => setMinPrevInput(e.target.value)}
                placeholder="0"
                required
              />
            </label>
            <label className="field inline grow">
              <span>2. Work done in this hour (max)</span>
              <input
                inputMode="numeric"
                value={targetInput}
                onChange={(e) => setTargetInput(e.target.value)}
                placeholder="6"
                required
              />
            </label>
          </div>
        )}
        {hourly && (
          <p className="muted small" style={{ margin: 0 }}>
            When the previous hour reaches its minimum, this hour's stamps become
            bonus reward stamps.
          </p>
        )}

        <div className="row-form spread">
          <button
            type="button"
            className="btn ghost danger"
            onClick={onDelete}
          >
            Delete station
          </button>
          <span className="row-form">
            <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
            <button className="btn" type="submit" disabled={saving}>
              {saving ? 'Saving…' : 'Save station'}
            </button>
          </span>
        </div>
      </form>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Tag edit pop-out: name, colour plate, what it can see, what it can */
/* do.                                                                */
/* ------------------------------------------------------------------ */

function TagEditModal({
  grade,
  nextTier,
  usedColors,
  onClose,
  onSaved,
}: {
  grade: Grade | null
  nextTier: number
  usedColors: string[]
  onClose: () => void
  onSaved: () => void
}) {
  // Tier 1 is the super admin: every ability, always — the checkboxes are
  // shown ticked and locked.
  const isSuper = grade?.sort_order === 1
  const [name, setName] = useState(grade?.name ?? '')
  // Colours are issued automatically and stay unique across tiers — an
  // existing tag keeps its colour, a new tag takes the next free one.
  const color = grade?.color ?? nextTagColor(usedColors)
  // Which web modules this TIER can see — the master switch. The per-user
  // checkboxes in User access can only narrow it further for one person.
  const [modules, setModules] = useState<string[]>(
    isSuper ? MODULE_OPTIONS.map((m) => m.key) : grade?.modules ?? [...DEFAULT_MODULES],
  )
  const [capabilities, setCapabilities] = useState<string[]>(
    isSuper ? [...ALL_CAPABILITIES] : sortCapabilities(grade?.capabilities ?? ['data-entry']),
  )
  const ability = grade?.ability ?? ''
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  function toggleCapability(key: string) {
    if (isSuper) return
    setCapabilities((c) => (c.includes(key) ? c.filter((k) => k !== key) : [...c, key]))
  }

  function toggleModule(key: string) {
    if (isSuper) return
    setModules((m) => (m.includes(key) ? m.filter((k) => k !== key) : [...m, key]))
  }

  async function save(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setSaving(true)
    // Saved in the standardized order so "Can do" always reads the same,
    // no matter what sequence the boxes were ticked in.
    const caps = isSuper ? [...ALL_CAPABILITIES] : sortCapabilities(capabilities)
    const mods = isSuper
      ? MODULE_OPTIONS.map((m) => m.key)
      : MODULE_OPTIONS.map((m) => m.key).filter((k) => modules.includes(k))
    const fields = { name: name.trim(), color, modules: mods, capabilities: caps, ability: ability || null }
    const { error } = grade
      ? await supabase.from('grades').update(fields).eq('id', grade.id)
      : await supabase.from('grades').insert({ ...fields, sort_order: nextTier })
    setSaving(false)
    if (error) return setError(error.message)
    onSaved()
  }

  // One checkbox row per capability of a group — shared by every section.
  const capBoxes = (group: string) =>
    CAPABILITY_OPTIONS.filter((c) => c.group === group).map((c) => (
      <label key={c.key} className="checkbox small" style={{ margin: 0 }}>
        <input
          type="checkbox"
          checked={capabilities.includes(c.key)}
          disabled={isSuper}
          onChange={() => toggleCapability(c.key)}
        />{' '}
        {c.label}
      </label>
    ))

  return (
    <div className="modal-overlay" onClick={onClose}>
      <form className="modal modal-wide" onClick={(e) => e.stopPropagation()} onSubmit={save}>
        <div className="row-form spread">
          <h2>{grade ? 'Edit tag' : 'New tag'}</h2>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        {error && <div className="error">{error}</div>}
        {isSuper && (
          <p className="muted small" style={{ margin: 0 }}>
            This tag is the super admin — it always has every ability, sees every
            module, and stays at tier 1.
          </p>
        )}

        <div className="row-form">
          <label className="field grow">
            <span>Tag name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} autoFocus required />
          </label>
          <div className="field">
            <span>Colour (auto-issued)</span>
            <span className={tagClass(color)} style={{ alignSelf: 'flex-start' }}>
              {name.trim() || 'preview'}
            </span>
          </div>
        </div>

        {/* Right below the tag name, as requested: who this tier may manage. */}
        <div className="tag-section">
          <div className="tag-section-title">User setting</div>
          {capBoxes('User setting')}
          <p className="tag-section-hint">
            Opens the User access panel to set lower-tier users' station, tier and modules.
          </p>
        </div>

        <div className="tag-section">
          <div className="tag-section-title">Can see</div>
          <p className="tag-section-hint">
            Data always follows the fixed rule: this tier and every tier below it;
            station tags narrow it to those stations. Tick the web modules this
            tier sees — per-user boxes in User access can only narrow further.
          </p>
          <div className="cap-cols">
            {MODULE_OPTIONS.map((m) => (
              <label key={m.key} className="checkbox small" style={{ margin: 0 }}>
                <input
                  type="checkbox"
                  checked={modules.includes(m.key)}
                  disabled={isSuper}
                  onChange={() => toggleModule(m.key)}
                />{' '}
                {m.label}
              </label>
            ))}
            {capBoxes('View setting')}
          </div>
        </div>

        <div className="tag-cols">
          <div className="tag-section">
            <div className="tag-section-title">Work entry setting</div>
            {capBoxes('Work entry setting')}
          </div>
          <div className="tag-section">
            <div className="tag-section-title">Piece rate setting</div>
            {capBoxes('Piece rate setting')}
          </div>
        </div>

        <div className="tag-cols">
          <div className="tag-section">
            <div className="tag-section-title">Tag management setting</div>
            {capBoxes('Tag management setting')}
          </div>
          <div className="tag-section">
            <div className="tag-section-title">Station setting</div>
            {capBoxes('Station setting')}
            <p className="tag-section-hint">
              Only tags and users below this tier can be added, moved or edited.
            </p>
          </div>
        </div>

        <div className="row-form" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn" type="submit" disabled={saving}>
            {saving ? 'Saving…' : grade ? 'Save tag' : 'Create tag'}
          </button>
        </div>
      </form>
    </div>
  )
}
