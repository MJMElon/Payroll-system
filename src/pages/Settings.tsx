import { useEffect, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { supabase, type Grade, type Station, type Worker } from '../lib/supabase'

type Tab = 'access' | 'tags'

export default function Settings() {
  const [tab, setTab] = useState<Tab>('access')

  return (
    <div className="stack">
      <div>
        <Link to="/" className="small muted">← Back to main page</Link>
        <h1>Settings</h1>
        <p className="muted">
          User access and tags. Stations and rates live in the{' '}
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
      </div>

      {tab === 'access' && <UserAccessTab />}
      {tab === 'tags' && <TagsTab />}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* User access: every person, with their station tag and grade tag.   */
/* (Login-account linking will be added here later.)                  */
/* ------------------------------------------------------------------ */

function UserAccessTab() {
  const [workers, setWorkers] = useState<Worker[]>([])
  const [stations, setStations] = useState<Station[]>([])
  const [grades, setGrades] = useState<Grade[]>([])
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [stationId, setStationId] = useState('')
  const [gradeId, setGradeId] = useState('')
  const [showInactive, setShowInactive] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  async function load() {
    const [w, s, g] = await Promise.all([
      supabase.from('workers').select('id, full_name, station_id, grade_id, active').order('full_name'),
      supabase.from('stations').select('id, name, sort_order').order('sort_order'),
      supabase.from('grades').select('id, name, sort_order').order('sort_order'),
    ])
    const err = w.error || s.error || g.error
    if (err) setError(err.message)
    setWorkers(w.data ?? [])
    setStations(s.data ?? [])
    setGrades(g.data ?? [])
    setLoading(false)
  }

  useEffect(() => {
    load()
  }, [])

  async function addUser(e: FormEvent) {
    e.preventDefault()
    setError(null)
    const { error } = await supabase.from('workers').insert({
      full_name: name.trim(),
      station_id: stationId || null,
      grade_id: gradeId || null,
    })
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
          <h3>Users</h3>
          <button className="btn" onClick={() => setAdding((v) => !v)}>
            {adding ? 'Cancel' : '+ Add user'}
          </button>
        </div>

        {adding && (
          <form className="row-form" onSubmit={addUser}>
            <label className="field inline grow">
              <span>Full name</span>
              <input value={name} onChange={(e) => setName(e.target.value)} autoFocus required />
            </label>
            <label className="field inline">
              <span>Station tag</span>
              <select value={stationId} onChange={(e) => setStationId(e.target.value)}>
                <option value="">—</option>
                {stations.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </label>
            <label className="field inline">
              <span>Grade tag</span>
              <select value={gradeId} onChange={(e) => setGradeId(e.target.value)}>
                <option value="">—</option>
                {grades.map((g) => (
                  <option key={g.id} value={g.id}>{g.name}</option>
                ))}
              </select>
            </label>
            <button className="btn" type="submit">Save user</button>
          </form>
        )}

        <label className="small muted checkbox">
          <input
            type="checkbox"
            checked={showInactive}
            onChange={(e) => setShowInactive(e.target.checked)}
          />{' '}
          Show inactive users
        </label>

        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Station tag</th>
              <th>Grade tag</th>
              <th>Status</th>
              <th className="right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 && (
              <tr><td colSpan={5} className="muted">No users yet — click “+ Add user”.</td></tr>
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
                  <select
                    value={w.grade_id ?? ''}
                    onChange={(e) => update(w, { grade_id: e.target.value || null })}
                  >
                    <option value="">—</option>
                    {grades.map((g) => (
                      <option key={g.id} value={g.id}>{g.name}</option>
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

/* ------------------------------------------------------------------ */
/* Tags: one comprehensive list with two categories — Station tags    */
/* (backed by the stations table) and Grade tags (grades table).      */
/* ------------------------------------------------------------------ */

type TagRow = { id: string; name: string; category: 'station' | 'grade' }

function TagsTab() {
  const [stations, setStations] = useState<Station[]>([])
  const [grades, setGrades] = useState<Grade[]>([])
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [category, setCategory] = useState<'grade' | 'station'>('grade')
  const [filter, setFilter] = useState<'all' | 'station' | 'grade'>('all')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  async function load() {
    const [s, g] = await Promise.all([
      supabase.from('stations').select('id, name, sort_order').order('sort_order'),
      supabase.from('grades').select('id, name, sort_order').order('sort_order'),
    ])
    const err = s.error || g.error
    if (err) setError(err.message)
    setStations(s.data ?? [])
    setGrades(g.data ?? [])
    setLoading(false)
  }

  useEffect(() => {
    load()
  }, [])

  const table = (cat: 'station' | 'grade') => (cat === 'station' ? 'stations' : 'grades')

  async function addTag(e: FormEvent) {
    e.preventDefault()
    setError(null)
    const rows = category === 'station' ? stations : grades
    const sort = Math.max(0, ...rows.map((r) => r.sort_order)) + 1
    const { error } = await supabase
      .from(table(category))
      .insert({ name: name.trim(), sort_order: sort })
    if (error) return setError(error.message)
    setName('')
    setAdding(false)
    load()
  }

  async function rename(row: TagRow) {
    const next = window.prompt('Tag name', row.name)
    if (!next || next.trim() === row.name) return
    const { error } = await supabase
      .from(table(row.category))
      .update({ name: next.trim() })
      .eq('id', row.id)
    if (error) setError(error.message)
    else load()
  }

  async function remove(row: TagRow) {
    if (!window.confirm(`Delete tag "${row.name}"? This fails if it is in use.`)) return
    const { error } = await supabase.from(table(row.category)).delete().eq('id', row.id)
    if (error) setError(error.message)
    else load()
  }

  if (loading) return <p className="muted">Loading…</p>

  const rows: TagRow[] = [
    ...stations.map((s) => ({ id: s.id, name: s.name, category: 'station' as const })),
    ...grades.map((g) => ({ id: g.id, name: g.name, category: 'grade' as const })),
  ].filter((r) => filter === 'all' || r.category === filter)

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
              <span>Category</span>
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value as 'grade' | 'station')}
              >
                <option value="grade">Grade</option>
                <option value="station">Station</option>
              </select>
            </label>
            <label className="field inline grow">
              <span>Tag name</span>
              <input value={name} onChange={(e) => setName(e.target.value)} autoFocus required />
            </label>
            <button className="btn" type="submit">Save tag</button>
          </form>
        )}

        <div className="row-form">
          <label className="field inline">
            <span>Show</span>
            <select value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)}>
              <option value="all">All categories</option>
              <option value="station">Station tags</option>
              <option value="grade">Grade tags</option>
            </select>
          </label>
        </div>

        <table className="table">
          <thead>
            <tr>
              <th>Tag</th>
              <th>Category</th>
              <th className="right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={3} className="muted">No tags yet — click “+ Add tag”.</td></tr>
            )}
            {rows.map((r) => (
              <tr key={`${r.category}-${r.id}`}>
                <td><span className={`badge ${r.category === 'station' ? 'off' : 'ok'}`}>{r.name}</span></td>
                <td className="muted">{r.category === 'station' ? 'Station' : 'Grade'}</td>
                <td className="right">
                  <button className="linkbtn" onClick={() => rename(r)}>Rename</button>{' '}
                  <button className="linkbtn danger" onClick={() => remove(r)}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted small">
          Station tags are the mill stations (also managed in the Piece Rate module).
          Grade tags mark levels like Operator or Station Head. User access is appointed
          with one of each in the User access tab.
        </p>
      </div>
    </div>
  )
}
