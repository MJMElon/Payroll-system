// ---------------------------------------------------------------------------
// DEMO MOBILE VIEW — one mobile app for every station (will move to its own
// repo later). Landing = station selection; tapping a station opens its
// record-taking page: a stamp-card status block (photos this hour vs the
// station's hourly target, minutes left), an Add record camera button, and a
// day-by-day list of photo records. Photos upload to the 'records' storage
// bucket; rows land in photo_records.
// ---------------------------------------------------------------------------
import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase, type PhotoRecord, type Station } from '../lib/supabase'

export default function DemoMobile() {
  const [stations, setStations] = useState<Station[]>([])
  const [station, setStation] = useState<Station | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function load() {
      const { data, error } = await supabase.from('stations').select('*').order('sort_order')
      if (error) setError(error.message)
      setStations(data ?? [])
      setLoading(false)
    }
    load()
  }, [])

  return (
    <div className="stack">
      <div>
        <Link to="/" className="small muted backlink">← Back to main page</Link>
        <h1>Demo Mobile View</h1>
        <p className="muted">
          One app for all stations — pick a station, collect stamps, snap records.
          Station requirements are preset in Settings → Tags management.
        </p>
      </div>

      {error && <div className="error">{error}</div>}

      <div className="phone-wrap">
        <div className="phone">
          <div className="phone-screen">
            <div className="mob-status">
              <span>{new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
              <span>▮▮▮</span>
            </div>

            {loading ? (
              <div className="mob-body"><p className="muted small">Loading…</p></div>
            ) : station ? (
              <StationScreen station={station} onBack={() => setStation(null)} onError={setError} />
            ) : (
              <StationPicker stations={stations} onPick={setStation} />
            )}
          </div>
        </div>
        <p className="muted small">
          Live demo — photos really upload. On a phone the camera opens directly.
        </p>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Landing: choose your station                                       */
/* ------------------------------------------------------------------ */

function StationPicker({
  stations,
  onPick,
}: {
  stations: Station[]
  onPick: (s: Station) => void
}) {
  return (
    <>
      <div className="mob-header">
        <span className="mob-brand">MJM</span>
        <div className="mob-avatar">A</div>
      </div>
      <div className="mob-body">
        <div className="mob-sub" style={{ padding: '0 0.2rem' }}>Stations</div>
        {stations.length === 0 && (
          <p className="muted small">No stations yet — create them in Settings.</p>
        )}
        {stations.map((s) => (
          <button className="mob-station" key={s.id} onClick={() => onPick(s)}>
            <span>{s.name}</span>
            <span className="mob-station-meta">
              {s.hourly_count ? `hourly · ${s.hourly_target ?? 6}/hr` : 'daily'} ›
            </span>
          </button>
        ))}
      </div>
    </>
  )
}

/* ------------------------------------------------------------------ */
/* Station record page: stamp card, camera, day-by-day records        */
/* ------------------------------------------------------------------ */

function dayISO(d: Date) {
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10)
}

function StationScreen({
  station,
  onBack,
  onError,
}: {
  station: Station
  onBack: () => void
  onError: (m: string | null) => void
}) {
  const [viewDate, setViewDate] = useState(() => new Date())
  const [records, setRecords] = useState<PhotoRecord[]>([])
  const [uploading, setUploading] = useState(false)
  const [, forceTick] = useState(0)
  const fileRef = useRef<HTMLInputElement>(null)

  const isToday = dayISO(viewDate) === dayISO(new Date())
  const target = station.hourly_target ?? 6

  async function loadRecords() {
    const start = new Date(viewDate)
    start.setHours(0, 0, 0, 0)
    const end = new Date(start.getTime() + 24 * 3_600_000)
    const { data, error } = await supabase
      .from('photo_records')
      .select('id, station_id, photo_path, taken_at')
      .eq('station_id', station.id)
      .gte('taken_at', start.toISOString())
      .lt('taken_at', end.toISOString())
      .order('taken_at', { ascending: false })
    if (error) onError(error.message)
    else setRecords(data ?? [])
  }

  useEffect(() => {
    loadRecords()
    const t = setInterval(() => {
      forceTick((x) => x + 1) // refresh the minutes-left countdown
      if (dayISO(viewDate) === dayISO(new Date())) loadRecords()
    }, 30_000)
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [station.id, viewDate])

  const now = new Date()
  const stampsThisHour = records.filter((r) => {
    const t = new Date(r.taken_at)
    return isToday && t.getHours() === now.getHours()
  }).length
  const minutesLeft = 59 - now.getMinutes()
  const hourLabel = (h: number) => {
    const h24 = ((h % 24) + 24) % 24
    const h12 = h24 % 12 === 0 ? 12 : h24 % 12
    return `${h12}${h24 >= 12 ? 'PM' : 'AM'}`
  }
  const hourZone = `${hourLabel(now.getHours())} – ${hourLabel(now.getHours() + 1)}`

  async function handleFile(file: File | undefined) {
    if (!file) return
    setUploading(true)
    onError(null)
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const path = `${station.id}/${stamp}-${Math.random().toString(36).slice(2, 7)}.jpg`
      const { error: upErr } = await supabase.storage.from('records').upload(path, file)
      if (upErr) throw new Error(upErr.message)
      const { error: insErr } = await supabase
        .from('photo_records')
        .insert({ station_id: station.id, photo_path: path })
      if (insErr) throw new Error(insErr.message)
      setViewDate(new Date())
      await loadRecords()
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err))
    } finally {
      setUploading(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  function shiftDay(delta: number) {
    const next = new Date(viewDate)
    next.setDate(next.getDate() + delta)
    if (dayISO(next) > dayISO(new Date())) return // no future days
    setViewDate(next)
  }

  const photoUrl = (path: string | null) =>
    path ? supabase.storage.from('records').getPublicUrl(path).data.publicUrl : null

  return (
    <>
      <div className="mob-header">
        <button className="mob-back" onClick={onBack}>‹ Stations</button>
        <span className="mob-brand">MJM</span>
        <div className="mob-avatar">A</div>
      </div>

      <div className="mob-body">
        <div className="mob-role" style={{ padding: '0 0.2rem' }}>{station.name}</div>
        {/* 1 — status stamp card */}
        <div className="mob-card mob-highlight">
          {station.hourly_count ? (
            <>
              <div className="row-form spread" style={{ alignItems: 'center' }}>
                <div className="mob-title">This hour</div>
                <div className="mob-zone">{hourZone}</div>
              </div>
              <div className="stamp-row">
                {Array.from({ length: target }, (_, i) => (
                  <span key={i} className={`stamp ${i < stampsThisHour ? 'filled' : ''}`}>
                    {i < stampsThisHour ? 'DONE' : ''}
                  </span>
                ))}
              </div>
              <div className="mob-sub">
                {Math.min(stampsThisHour, target)} of {target} stamped · {minutesLeft} min left this hour
              </div>
            </>
          ) : (
            <>
              <div className="mob-big">{records.length}</div>
              <div className="mob-sub">records {isToday ? 'today' : 'this day'}</div>
            </>
          )}
        </div>

        {/* 2 — add record (camera) */}
        <div className="mob-card">
          <div className="mob-title">Add record</div>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            capture="environment"
            style={{ display: 'none' }}
            onChange={(e) => handleFile(e.target.files?.[0])}
          />
          <button
            className="mob-btn"
            disabled={uploading}
            onClick={() => fileRef.current?.click()}
          >
            {uploading ? 'Uploading…' : '📷 Take photo'}
          </button>
        </div>

        {/* 3 — records with day navigation */}
        <div className="mob-card">
          <div className="mob-daynav">
            <button className="mob-mini" onClick={() => shiftDay(-1)}>‹</button>
            <span className="mob-title">
              {isToday
                ? "Today's records"
                : viewDate.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}
            </span>
            <button className="mob-mini" onClick={() => shiftDay(1)} disabled={isToday}>›</button>
          </div>
          {records.length === 0 && <div className="mob-sub">No records this day.</div>}
          {records.map((r) => {
            const url = photoUrl(r.photo_path)
            const t = new Date(r.taken_at)
            return (
              <div className="mob-row" key={r.id}>
                <span>
                  {t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  <span className="mob-station-meta">
                    {' '}· {t.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                  </span>
                </span>
                {url ? (
                  <a href={url} target="_blank" rel="noreferrer">
                    <img className="mob-thumb" src={url} alt="record" />
                  </a>
                ) : (
                  <span className="mob-chip">no photo</span>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </>
  )
}
