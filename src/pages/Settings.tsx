import { useEffect, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { supabase, type Grade, type Station, type Worker } from '../lib/supabase'

type Tab = 'workers' | 'tags'

export default function Settings() {
  const [tab, setTab] = useState<Tab>('workers')

  return (
    <div className="stack">
      <div>
        <Link to="/" className="small muted">← Overall status</Link>
        <h1>Settings</h1>
        <p className="muted">
          Workers and tags. Stations and rates live in the{' '}
          <Link to="/piece-rate">Piece Rate module</Link>.
        </p>
      </div>

      <div className="tabs">
        <button className={`tab ${tab === 'workers' ? 'active' : ''}`} onClick={() => setTab('workers')}>
          Workers
        </button>
        <button className={`tab ${tab === 'tags' ? 'active' : ''}`} onClick={() => setTab('tags')}>
          Tags
        </button>
      </div>

      {tab === 'workers' && <WorkersTab />}
      {tab === 'tags' && <TagsTab />}
    </div>
  )
}

/* ------------------------------------------------------------------ */

function WorkersTab() {
  const [workers, setWorkers] = useState<Worker[]>([])
  const [stations, setStations] = useState<Station[]>([])
  const [name, setName] = useState('')
  const [stationId, setStationId] = useState('')
  const [showInactive, setShowInactive] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  async function load() {
    const [w, s] = await Promise.all([
      supabase.from('workers').select('id, full_name, station_id, active').order('full_name'),
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
    load()
  }

  async function setActive(w: Worker, active: boolean) {
    const { error } = await supabase.from('workers').update({ active }).eq('id', w.id)
    if (error) setError(error.message)
    else load()
  }

  async function moveStation(w: Worker, station_id: string) {
    const { error } = await supabase
      .from('workers')
      .update({ station_id: station_id || null })
      .eq('id', w.id)
    if (error) setError(error.message)
    else load()
  }

  if (loading) return <p className="muted">Loading…</p>

  const visible = workers.filter((w) => showInactive || w.active)

  return (
    <div className="stack">
      {error && <div className="error">{error}</div>}

      <div className="card">
        <label className="small muted checkbox">
          <input
            type="checkbox"
            checked={showInactive}
            onChange={(e) => setShowInactive(e.target.checked)}
          />{' '}
          Show inactive workers
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
              <tr><td colSpan={4} className="muted">No workers yet — add the first one below.</td></tr>
            )}
            {visible.map((w) => (
              <tr key={w.id}>
                <td>{w.full_name}</td>
                <td>
                  <select value={w.station_id ?? ''} onChange={(e) => moveStation(w, e.target.value)}>
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
                    <button className="linkbtn danger" onClick={() => setActive(w, false)}>Deactivate</button>
                  ) : (
                    <button className="linkbtn" onClick={() => setActive(w, true)}>Reactivate</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <form className="card row-form" onSubmit={addWorker}>
        <label className="field inline">
          <span>Full name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} required />
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
        <button className="btn" type="submit">Add worker</button>
      </form>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Tags (grades). Piece rates are tagged with these; later, user      */
/* access will be appointed per tag here too.                         */
/* ------------------------------------------------------------------ */

function TagsTab() {
  const [grades, setGrades] = useState<Grade[]>([])
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  async function load() {
    const { data, error } = await supabase
      .from('grades')
      .select('id, name, sort_order')
      .order('sort_order')
    if (error) setError(error.message)
    else setGrades(data ?? [])
    setLoading(false)
  }

  useEffect(() => {
    load()
  }, [])

  async function addTag(e: FormEvent) {
    e.preventDefault()
    setError(null)
    const sort = Math.max(0, ...grades.map((g) => g.sort_order)) + 1
    const { error } = await supabase.from('grades').insert({ name: name.trim(), sort_order: sort })
    if (error) return setError(error.message)
    setName('')
    load()
  }

  async function rename(g: Grade) {
    const next = window.prompt('Tag name', g.name)
    if (!next || next.trim() === g.name) return
    const { error } = await supabase.from('grades').update({ name: next.trim() }).eq('id', g.id)
    if (error) setError(error.message)
    else load()
  }

  async function remove(g: Grade) {
    if (!window.confirm(`Delete tag "${g.name}"? This fails if any piece rate uses it.`)) return
    const { error } = await supabase.from('grades').delete().eq('id', g.id)
    if (error) setError(error.message)
    else load()
  }

  if (loading) return <p className="muted">Loading…</p>

  return (
    <div className="stack">
      {error && <div className="error">{error}</div>}

      <div className="card">
        <p className="muted small">
          Tags mark who a piece rate belongs to (Operator, Station Head, …). User access
          will be appointed per tag here later.
        </p>
        <table className="table">
          <thead>
            <tr>
              <th>Tag</th>
              <th className="right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {grades.length === 0 && (
              <tr><td colSpan={2} className="muted">No tags yet — add the first one below.</td></tr>
            )}
            {grades.map((g) => (
              <tr key={g.id}>
                <td><span className="badge ok">{g.name}</span></td>
                <td className="right">
                  <button className="linkbtn" onClick={() => rename(g)}>Rename</button>{' '}
                  <button className="linkbtn danger" onClick={() => remove(g)}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <form className="card row-form" onSubmit={addTag}>
        <label className="field inline">
          <span>New tag name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} required />
        </label>
        <button className="btn" type="submit">Add tag</button>
      </form>
    </div>
  )
}
