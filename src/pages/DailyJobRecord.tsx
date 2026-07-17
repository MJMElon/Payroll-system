import { useEffect, useState } from 'react'
import { Link, Navigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { supabase, type Station } from '../lib/supabase'

// Landing page for the "Daily Job Record" module tile — for Operators,
// Assistant Station Heads and Station Heads to key in today's production.
// The actual entry form already lives on StationDetail (reached from the
// Overall Status board too), so this page just routes a user straight to
// their own station, or lets them pick one if they're tagged to more than
// one (or are a manager/admin looking at any station).
export default function DailyJobRecord() {
  const { profile } = useAuth()
  const [stations, setStations] = useState<Station[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function load() {
      const { data } = await supabase.from('stations').select('id, name, sort_order').order('sort_order')
      setStations(data ?? [])
      setLoading(false)
    }
    load()
  }, [])

  if (loading) return <p className="muted">Loading…</p>

  const canManage = profile?.role === 'admin' || profile?.role === 'manager'
  const myStations =
    profile?.station_ids && profile.station_ids.length > 0
      ? profile.station_ids
      : profile?.station_id
        ? [profile.station_id]
        : []
  const visible =
    canManage || myStations.length === 0 ? stations : stations.filter((s) => myStations.includes(s.id))

  if (!canManage && visible.length === 1) {
    return <Navigate to={`/station/${visible[0].id}`} replace />
  }

  return (
    <div className="stack">
      <div>
        <Link to="/" className="small muted backlink">← Back to main page</Link>
        <h1>Daily Job Record</h1>
        <p className="muted">Pick a station to key in today's job output.</p>
      </div>

      {visible.length === 0 ? (
        <p className="muted">
          No station is tagged to your account yet — ask an admin to set it in Settings → User access.
        </p>
      ) : (
        <div className="module-grid">
          {visible.map((s) => (
            <Link key={s.id} to={`/station/${s.id}`} className="module-tile static">
              <span className="tile-icon" aria-hidden="true">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                  strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 21h18" />
                  <path d="M5 21V7l7-4 7 4v14" />
                  <path d="M9 21v-6h6v6" />
                </svg>
              </span>
              <div>
                <h2>{s.name}</h2>
                <p className="muted small">Record today's job output</p>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
