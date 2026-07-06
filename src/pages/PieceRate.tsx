// ---------------------------------------------------------------------------
// PIECE RATE MODULE — fully self-contained in this one file.
//
// A piece-rate contract is the mix-and-match of STATION × GRADE (tag) × WORK
// DESCRIPTION, each with its own unit ("/cage tipped", "/job done", …) and
// rate. Grades are managed inside the create window. Kept in one file so the
// module can be lifted out to its own repo later; only dependencies are the
// shared Supabase client/types and react-router's Link.
// Tables used: stations, grades, jobs, piece_rates (see supabase/setup.sql).
// ---------------------------------------------------------------------------
import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
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
  const [stations, setStations] = useState<Station[]>([])
  const [grades, setGrades] = useState<Grade[]>([])
  const [jobs, setJobs] = useState<Job[]>([])
  const [rates, setRates] = useState<Rate[]>([])
  const [stationFilter, setStationFilter] = useState('')
  const [gradeFilter, setGradeFilter] = useState('')
  const [showInactive, setShowInactive] = useState(false)
  const [modal, setModal] = useState<'closed' | 'create' | Job>('closed')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  async function load() {
    const [s, g, j, r] = await Promise.all([
      supabase.from('stations').select('id, name, sort_order').order('sort_order'),
      supabase.from('grades').select('id, name, sort_order').order('sort_order'),
      supabase.from('jobs').select('id, station_id, grade_id, name, unit, active').order('name'),
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

  const stationName = (id: string) => stations.find((s) => s.id === id)?.name ?? '?'
  const gradeName = (id: string | null) => grades.find((g) => g.id === id)?.name ?? null

  // Rates come sorted newest-first; the first one effective today or earlier
  // is the current rate for a contract.
  const currentRate = useMemo(() => {
    const m = new Map<string, Rate>()
    const today = todayISO()
    for (const r of rates) {
      if (r.effective_from <= today && !m.has(r.job_id)) m.set(r.job_id, r)
    }
    return m
  }, [rates])

  async function setActive(job: Job, active: boolean) {
    const { error } = await supabase.from('jobs').update({ active }).eq('id', job.id)
    if (error) setError(error.message)
    else load()
  }

  if (loading) return <p className="muted">Loading…</p>

  const list = jobs
    .filter((j) => (showInactive ? true : j.active))
    .filter((j) => (stationFilter ? j.station_id === stationFilter : true))
    .filter((j) => (gradeFilter ? j.grade_id === gradeFilter : true))
    .sort((a, b) => stationName(a.station_id).localeCompare(stationName(b.station_id)) || a.name.localeCompare(b.name))

  return (
    <div className="stack">
      <div className="row-form spread">
        <div>
          <Link to="/" className="small muted">← Overall status</Link>
          <h1>Piece Rate</h1>
          <p className="muted">
            All piece-rate contracts: station × tag × work, each with its own unit and rate.
          </p>
        </div>
        <button className="btn" onClick={() => setModal('create')}>+ Create new piece rate</button>
      </div>

      {error && <div className="error">{error}</div>}

      <div className="card stack">
        <div className="row-form">
          <label className="field inline">
            <span>Station</span>
            <select value={stationFilter} onChange={(e) => setStationFilter(e.target.value)}>
              <option value="">All stations</option>
              {stations.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </label>
          <label className="field inline">
            <span>Tag</span>
            <select value={gradeFilter} onChange={(e) => setGradeFilter(e.target.value)}>
              <option value="">All tags</option>
              {grades.map((g) => (
                <option key={g.id} value={g.id}>{g.name}</option>
              ))}
            </select>
          </label>
          <label className="small muted checkbox" style={{ alignSelf: 'flex-end' }}>
            <input
              type="checkbox"
              checked={showInactive}
              onChange={(e) => setShowInactive(e.target.checked)}
            />{' '}
            Show inactive
          </label>
        </div>

        <table className="table">
          <thead>
            <tr>
              <th>Station</th>
              <th>Work description</th>
              <th>Tag</th>
              <th>Unit</th>
              <th className="right">Rate</th>
              <th className="right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {list.length === 0 && (
              <tr>
                <td colSpan={6} className="muted">
                  No piece rates yet — click “Create new piece rate” to add the first one.
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
                  <td>{tag ? <span className="badge ok">{tag}</span> : <span className="muted">—</span>}</td>
                  <td className="muted">{j.unit}</td>
                  <td className="right">
                    {rate ? <strong>{Number(rate.rate)}</strong> : <span className="badge off">no rate</span>}
                  </td>
                  <td className="right">
                    <button className="linkbtn" onClick={() => setModal(j)}>Edit</button>{' '}
                    {j.active ? (
                      <button className="linkbtn danger" onClick={() => setActive(j, false)}>Deactivate</button>
                    ) : (
                      <button className="linkbtn" onClick={() => setActive(j, true)}>Reactivate</button>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        <p className="muted small">{list.length} contract(s) shown.</p>
      </div>

      {modal !== 'closed' && (
        <ContractModal
          stations={stations}
          grades={grades}
          job={modal === 'create' ? null : modal}
          currentRate={modal === 'create' ? null : currentRate.get(modal.id) ?? null}
          onClose={() => setModal('closed')}
          onSaved={() => {
            setModal('closed')
            load()
          }}
          onGradesChanged={load}
        />
      )}
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
  onGradesChanged,
}: {
  stations: Station[]
  grades: Grade[]
  job: Job | null
  currentRate: Rate | null
  onClose: () => void
  onSaved: () => void
  onGradesChanged: () => void
}) {
  const [stationId, setStationId] = useState(job?.station_id ?? '')
  const [gradeId, setGradeId] = useState(job?.grade_id ?? '')
  const [description, setDescription] = useState(job?.name ?? '')
  const [unit, setUnit] = useState(job?.unit ?? '')
  const [rate, setRate] = useState(currentRate ? String(Number(currentRate.rate)) : '')
  const [manageTags, setManageTags] = useState(false)
  const [newGrade, setNewGrade] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  async function addGrade() {
    const name = newGrade.trim()
    if (!name) return
    const sort = Math.max(0, ...grades.map((g) => g.sort_order)) + 1
    const { data, error } = await supabase
      .from('grades')
      .insert({ name, sort_order: sort })
      .select()
      .single()
    if (error) return setError(error.message)
    setNewGrade('')
    setGradeId(data.id)
    onGradesChanged()
  }

  async function renameGrade(g: Grade) {
    const next = window.prompt('Tag name', g.name)
    if (!next || next.trim() === g.name) return
    const { error } = await supabase.from('grades').update({ name: next.trim() }).eq('id', g.id)
    if (error) setError(error.message)
    else onGradesChanged()
  }

  async function deleteGrade(g: Grade) {
    if (!window.confirm(`Delete tag "${g.name}"? This fails if any piece rate uses it.`)) return
    const { error } = await supabase.from('grades').delete().eq('id', g.id)
    if (error) setError(error.message)
    else {
      if (gradeId === g.id) setGradeId('')
      onGradesChanged()
    }
  }

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
      if (job) {
        const { error } = await supabase
          .from('jobs')
          .update({
            station_id: stationId,
            grade_id: gradeId || null,
            name: description.trim(),
            unit: unit.trim() || 'unit',
          })
          .eq('id', job.id)
        if (error) throw new Error(error.message)
      } else {
        const { data, error } = await supabase
          .from('jobs')
          .insert({
            station_id: stationId,
            grade_id: gradeId || null,
            name: description.trim(),
            unit: unit.trim() || 'unit',
          })
          .select()
          .single()
        if (error) throw new Error(error.message)
        jobId = data.id
      }
      // Record the rate (today) unless editing and the rate is unchanged.
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
      onSaved()
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
          <span>Grade (tag — who this rate belongs to)</span>
          <div className="row-form">
            <select
              value={gradeId}
              onChange={(e) => setGradeId(e.target.value)}
              style={{ flex: 1 }}
            >
              <option value="">No tag</option>
              {grades.map((g) => (
                <option key={g.id} value={g.id}>{g.name}</option>
              ))}
            </select>
            <button
              type="button"
              className="btn ghost"
              onClick={() => setManageTags((v) => !v)}
            >
              {manageTags ? 'Done' : 'Manage tags'}
            </button>
          </div>
        </label>

        {manageTags && (
          <div className="tag-manager">
            {grades.map((g) => (
              <div className="mob-row" key={g.id}>
                <span>{g.name}</span>
                <span>
                  <button type="button" className="linkbtn" onClick={() => renameGrade(g)}>Rename</button>{' '}
                  <button type="button" className="linkbtn danger" onClick={() => deleteGrade(g)}>Delete</button>
                </span>
              </div>
            ))}
            <div className="row-form">
              <input
                placeholder="New tag name"
                value={newGrade}
                onChange={(e) => setNewGrade(e.target.value)}
                style={{ flex: 1 }}
              />
              <button type="button" className="btn ghost" onClick={addGrade}>Add tag</button>
            </div>
          </div>
        )}

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
            {saving ? 'Saving…' : job ? 'Save changes' : 'Create piece rate'}
          </button>
        </div>
      </form>
    </div>
  )
}
