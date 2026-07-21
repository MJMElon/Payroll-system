// ---------------------------------------------------------------------------
// ADD JOB RECORD — dedicated entry form for the Daily Job Record module.
// Kept as its own page (separate from the records list) per the approved
// mockup: pick station + work description, pick who did it, key in the
// quantity, and the rate/amount are pulled from Piece Rate Master and
// calculated automatically. An optional photo/file can be attached.
// ---------------------------------------------------------------------------
import { useEffect, useMemo, useState, type ChangeEvent, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import {
  profileName,
  supabase,
  todayISO,
  type Grade,
  type Job,
  type PieceRate as Rate,
  type Profile,
  type Station,
} from '../lib/supabase'

const SHIFTS = [
  { key: 'a', label: 'Shift A' },
  { key: 'b', label: 'Shift B' },
] as const

const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024

// Camera photos are several MB; shrink to a sensible size before uploading.
async function compressImage(file: File): Promise<Blob> {
  try {
    const MAX = 1600
    const bitmap = await createImageBitmap(file)
    const scale = Math.min(1, MAX / Math.max(bitmap.width, bitmap.height))
    if (scale === 1 && file.size < 800_000) return file
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(bitmap.width * scale)
    canvas.height = Math.round(bitmap.height * scale)
    const ctx = canvas.getContext('2d')
    if (!ctx) return file
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    bitmap.close()
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/jpeg', 0.82))
    return blob && blob.size < file.size ? blob : file
  } catch {
    return file
  }
}

export default function AddJobRecord() {
  const { profile } = useAuth()

  const [stations, setStations] = useState<Station[]>([])
  const [jobs, setJobs] = useState<Job[]>([])
  const [grades, setGrades] = useState<Grade[]>([])
  const [users, setUsers] = useState<Profile[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function load() {
      const [s, j, g, u] = await Promise.all([
        supabase.from('stations').select('id, name, sort_order').order('sort_order'),
        supabase
          .from('jobs')
          .select('id, station_id, grade_id, name, unit, active, approval_status, verified_by, approved_by')
          .eq('active', true)
          .eq('approval_status', 'approved')
          .order('name'),
        supabase.from('grades').select('*').order('sort_order'),
        supabase.from('access_profiles').select('*').order('full_name'),
      ])
      setStations(s.data ?? [])
      setJobs(j.data ?? [])
      setGrades(g.data ?? [])
      setUsers((u.data ?? []) as Profile[])
      setLoading(false)
    }
    load()
  }, [])

  const canManage = profile?.role === 'admin' || profile?.role === 'manager'
  const myStations =
    profile?.station_ids && profile.station_ids.length > 0
      ? profile.station_ids
      : profile?.station_id
        ? [profile.station_id]
        : []
  const visibleStations = useMemo(
    () => (canManage || myStations.length === 0 ? stations : stations.filter((s) => myStations.includes(s.id))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [stations, canManage, profile?.station_id, profile?.station_ids],
  )

  const [workDate, setWorkDate] = useState(todayISO())
  const [stationId, setStationId] = useState('')
  const [jobId, setJobId] = useState('')
  const [employeeId, setEmployeeId] = useState('')
  const [shift, setShift] = useState('')
  const [remarks, setRemarks] = useState('')
  const [quantity, setQuantity] = useState('')
  const [workNotes, setWorkNotes] = useState('')
  const [photo, setPhoto] = useState<File | null>(null)
  const [rate, setRate] = useState<Rate | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  // Auto-pick the station when the user is only tagged to one.
  useEffect(() => {
    if (!stationId && visibleStations.length === 1) setStationId(visibleStations[0].id)
  }, [visibleStations, stationId])

  const stationJobs = useMemo(
    () => jobs.filter((j) => j.station_id === stationId),
    [jobs, stationId],
  )
  const job = jobs.find((j) => j.id === jobId) ?? null

  // Users tagged to this station come first; users with no station tag work
  // anywhere; users tagged elsewhere are excluded (same rule as StationDetail).
  const stationUsers = useMemo(() => {
    return users.filter((u) => {
      const tags = u.station_ids && u.station_ids.length > 0 ? u.station_ids : u.station_id ? [u.station_id] : []
      return tags.length === 0 || (stationId ? tags.includes(stationId) : false)
    })
  }, [users, stationId])
  const employee = users.find((u) => u.id === employeeId) ?? null
  const position = employee ? grades.find((g) => g.id === employee.grade_id)?.name ?? '—' : '—'

  // Pull the job's current rate straight from Piece Rate Master whenever the
  // work description changes.
  useEffect(() => {
    async function loadRate() {
      if (!jobId) return setRate(null)
      const { data } = await supabase
        .from('piece_rates')
        .select('id, job_id, rate, effective_from')
        .eq('job_id', jobId)
        .order('effective_from', { ascending: false })
      const today = todayISO()
      setRate((data ?? []).find((r) => r.effective_from <= today) ?? null)
    }
    loadRate()
  }, [jobId])

  const amount = rate ? Number(rate.rate) * (Number(quantity) || 0) : 0

  function resetForm() {
    setWorkDate(todayISO())
    setStationId(visibleStations.length === 1 ? visibleStations[0].id : '')
    setJobId('')
    setEmployeeId('')
    setShift('')
    setRemarks('')
    setQuantity('')
    setWorkNotes('')
    setPhoto(null)
  }

  function pickPhoto(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    if (file.size > MAX_ATTACHMENT_BYTES) return setError('Attachment must be 5MB or smaller.')
    setError(null)
    setPhoto(file)
  }

  async function save(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setNotice(null)
    const qty = Number(quantity)
    if (!stationId) return setError('Pick a station.')
    if (!jobId) return setError('Pick a work description.')
    if (!employeeId) return setError('Pick an employee.')
    if (!shift) return setError('Pick a shift.')
    if (quantity.trim() === '' || Number.isNaN(qty) || qty <= 0) {
      return setError('Quantity must be a positive number.')
    }
    setSaving(true)
    try {
      const notesParts = [
        remarks.trim() && `Remarks: ${remarks.trim()}`,
        workNotes.trim() && `Work notes: ${workNotes.trim()}`,
      ].filter(Boolean)
      const { data, error: insErr } = await supabase
        .from('production_entries')
        .insert({
          work_date: workDate,
          station_id: stationId,
          job_id: jobId,
          user_id: employeeId,
          quantity: qty,
          notes: notesParts.length ? notesParts.join(' · ') : null,
          shift,
          created_by: profile?.id ?? null,
        })
        .select()
        .single()
      if (insErr) throw new Error(insErr.message)

      if (photo && data) {
        const isImage = photo.type.startsWith('image/')
        const body = isImage ? await compressImage(photo) : photo
        const stamp = new Date().toISOString().replace(/[:.]/g, '-')
        const ext = photo.type === 'application/pdf' ? 'pdf' : 'jpg'
        const path = `${stationId}/entry-${stamp}.${ext}`
        const { error: upErr } = await supabase.storage
          .from('records')
          .upload(path, body, { contentType: photo.type || 'image/jpeg' })
        if (upErr) throw new Error(`Record saved, but the attachment failed to upload: ${upErr.message}`)
        const { error: prErr } = await supabase
          .from('photo_records')
          .insert({ station_id: stationId, photo_path: path, entry_id: data.id })
        if (prErr) throw new Error(`Record saved, but the attachment couldn't be linked: ${prErr.message}`)
      }

      setNotice('Job record saved.')
      resetForm()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <p className="muted">Loading…</p>

  return (
    <div className="stack">
      <div>
        <nav className="breadcrumb">
          <Link to="/daily-job-record">Daily Job Record</Link>
          <span className="sep">›</span>
          <span className="current">Add Job Record</span>
        </nav>
        <h1>Add Job Record</h1>
        <p className="muted">Record the work done by an employee. Piece rate and amount are automatically calculated.</p>
      </div>

      {error && <div className="error">{error}</div>}
      {notice && <div className="notice">{notice}</div>}

      <form className="stack" onSubmit={save}>
        <div className="card stack form-section">
          <h3>1. Job Information</h3>
          <div className="row-form">
            <label className="field inline">
              <span>Work Date *</span>
              <input type="date" value={workDate} onChange={(e) => setWorkDate(e.target.value)} required />
            </label>
            <label className="field inline">
              <span>Station *</span>
              <select
                value={stationId}
                onChange={(e) => { setStationId(e.target.value); setJobId('') }}
                required
              >
                <option value="">Pick…</option>
                {visibleStations.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </label>
            <label className="field inline grow">
              <span>Work Description *</span>
              <select value={jobId} onChange={(e) => setJobId(e.target.value)} required disabled={!stationId}>
                <option value="">Pick…</option>
                {stationJobs.map((j) => (
                  <option key={j.id} value={j.id}>{j.name}</option>
                ))}
              </select>
            </label>
            <label className="field inline">
              <span>Unit</span>
              <input value={job?.unit ?? ''} readOnly />
            </label>
          </div>
        </div>

        <div className="card stack form-section">
          <h3>2. Employee &amp; Position</h3>
          <div className="row-form">
            <label className="field inline">
              <span>Employee *</span>
              <select value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} required>
                <option value="">Pick…</option>
                {stationUsers.map((u) => (
                  <option key={u.id} value={u.id}>
                    {profileName(u)}{u.employee_code ? ` (${u.employee_code})` : ''}
                  </option>
                ))}
              </select>
            </label>
            <label className="field inline">
              <span>Position *</span>
              <input value={position} readOnly />
            </label>
            <label className="field inline">
              <span>Shift *</span>
              <select value={shift} onChange={(e) => setShift(e.target.value)} required>
                <option value="">Pick…</option>
                {SHIFTS.map((s) => (
                  <option key={s.key} value={s.key}>{s.label}</option>
                ))}
              </select>
            </label>
            <label className="field inline grow">
              <span>Remarks (Optional)</span>
              <input value={remarks} onChange={(e) => setRemarks(e.target.value)} placeholder="Enter remarks…" />
            </label>
          </div>
        </div>

        <div className="card stack form-section">
          <h3>3. Work Done</h3>
          <div className="row-form">
            <label className="field inline">
              <span>Quantity *</span>
              <input
                inputMode="decimal"
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
                placeholder="0.00"
                required
              />
            </label>
            <label className="field inline">
              <span>Unit</span>
              <input value={job?.unit ?? ''} readOnly />
            </label>
            <label className="field inline grow">
              <span>Work Notes (Optional)</span>
              <textarea rows={2} value={workNotes} onChange={(e) => setWorkNotes(e.target.value)} placeholder="Enter work notes…" />
            </label>
          </div>

          <div className="info-panel">
            <span className="info-label">Auto-loaded Rate (From Piece Rate Master)</span>
            <div className="info-row">
              <label className="field">
                <span>Rate (RM)</span>
                <input value={rate ? Number(rate.rate).toFixed(2) : '—'} readOnly />
              </label>
              <label className="field">
                <span>Per Unit</span>
                <input value={job?.unit ?? '—'} readOnly />
              </label>
            </div>
            {rate && <p className="small muted" style={{ margin: 0 }}>🔒 Rate effective from {rate.effective_from}</p>}
          </div>
        </div>

        <div className="card stack form-section">
          <h3>4. Calculation (Auto)</h3>
          <div className="calc-row">
            <label className="field">
              <span>Rate (RM)</span>
              <input value={rate ? Number(rate.rate).toFixed(2) : '0.00'} readOnly />
            </label>
            <span className="calc-op">×</span>
            <label className="field">
              <span>Quantity</span>
              <input value={quantity || '0.00'} readOnly />
            </label>
            <span className="calc-op">=</span>
            <label className="field">
              <span>Amount (RM)</span>
              <input className="calc-amount" value={amount.toFixed(2)} readOnly />
            </label>
          </div>
        </div>

        <div className="card stack form-section">
          <h3>Attachment (Optional)</h3>
          <p className="muted small" style={{ margin: 0 }}>Upload supporting documents or photos if required.</p>
          {photo ? (
            <div className="row-form spread">
              <span className="small">{photo.name}</span>
              <button type="button" className="linkbtn danger" onClick={() => setPhoto(null)}>Remove</button>
            </div>
          ) : (
            <div className="row-form">
              <label className="btn ghost">
                📷 Take Photo
                <input type="file" accept="image/*" capture="environment" onChange={pickPhoto} hidden />
              </label>
              <label className="btn ghost">
                ⬆ Upload File
                <input type="file" accept="image/*,.pdf" onChange={pickPhoto} hidden />
              </label>
            </div>
          )}
          <p className="small muted" style={{ margin: 0 }}>JPG, PNG, PDF (Max 5MB)</p>
        </div>

        <div className="row-form" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn ghost" onClick={resetForm}>Reset Form</button>
          <button className="btn" type="submit" disabled={saving}>
            {saving ? 'Saving…' : '💾 Save Record'}
          </button>
        </div>
      </form>
    </div>
  )
}
