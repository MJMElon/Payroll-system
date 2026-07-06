import { useEffect, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { supabase, type Station, type Worker } from '../lib/supabase'

type Tab = 'stations' | 'workers'

export default function Settings() {
  const [tab, setTab] = useState<Tab>('stations')

  return (
    <div className="stack">
      <div>
        <h1>Settings</h1>
        <p className="muted">
          Master data: stations and workers. Jobs and rates live in the{' '}
          <Link to="/piece-rate">Piece Rate module</Link>.
        </p>
      </div>

      <div className="tabs">
        <button className={`tab ${tab === 'stations' ? 'active' : ''}`} onClick={() => setTab('stations')}>
          Stations
        </button>
        <button className={`tab ${tab === 'workers' ? 'active' : ''}`} onClick={() => setTab('workers')}>
          Workers
        </button>
      </div>

      {tab === 'stations' && <StationsTab />}
      {tab === 'workers' && <WorkersTab />}
    </div>
  )
}

/* ------------------------------------------------------------------ */

function StationsTab() {
  const [stations, setStations] = useState<Station[]>([])
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  async function load() {
    const { data, error } = await supabase
      .from('stations')
      .select('id, name, sort_order')
      .order('sort_order')
    if (error) setError(error.message)
    else setStations(data ?? [])
    setLoading(false)
  }

  useEffect(() => {
    load()
  }, [])

  async function addStation(e: FormEvent) {
    e.preventDefault()
    setError(null)
    const sort = Math.max(0, ...stations.map((s) => s.sort_order)) + 1
    const { error } = await supabase.from('stations').insert({ name: name.trim(), sort_order: sort })
    if (error) return setError(error.message)
    setName('')
    load()
  }

  async function rename(s: Station) {
    const next = window.prompt('Station name', s.name)
    if (!next || next.trim() === s.name) return
    const { error } = await supabase.from('stations').update({ name: next.trim() }).eq('id', s.id)
    if (error) setError(error.message)
    else load()
  }

  async function remove(s: Station) {
    if (!window.confirm(`Delete station "${s.name}"? This fails if it has jobs, workers or records.`)) return
    const { error } = await supabase.from('stations').delete().eq('id', s.id)
    if (error) setError(error.message)
    else load()
  }

  if (loading) return <p className="muted">Loading…</p>

  return (
    <div className="stack">
      {error && <div className="error">{error}</div>}

      <div className="card">
        <table className="table">
          <thead>
            <tr>
              <th>#</th>
              <th>Station</th>
              <th className="right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {stations.map((s) => (
              <tr key={s.id}>
                <td className="muted">{s.sort_order}</td>
                <td>{s.name}</td>
                <td className="right">
                  <button className="linkbtn" onClick={() => rename(s)}>Rename</button>{' '}
                  <button className="linkbtn danger" onClick={() => remove(s)}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <form className="card row-form" onSubmit={addStation}>
        <label className="field inline">
          <span>New station name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} required />
        </label>
        <button className="btn" type="submit">Add station</button>
      </form>
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
