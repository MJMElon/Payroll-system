// ---------------------------------------------------------------------------
// DEMO MOBILE VIEW — one mobile app for every station (will move to its own
// repo later). A tier rail on the left lists every tier tag straight from
// the database; picking one previews the phone AS that tier.
//
// COMMON to all tiers: the bottom tab bar —
//   left  = Performance (station status: stamp card, photos, records)
//   middle= Record (big round button: submit a work record → approval flow)
//   right = Profile (the user's profile & earnings dashboard)
// Each tier gets its own version of the screens; the Operator view is built
// first.
// ---------------------------------------------------------------------------
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { effectiveCapabilities } from '../lib/tags'
import {
  profileName,
  supabase,
  todayISO,
  type Grade,
  type Job,
  type PhotoRecord,
  type PieceRate,
  type ProductionEntry,
  type Station,
} from '../lib/supabase'

type Tab = 'performance' | 'record' | 'profile'

const RM = (n: number) => `RM ${n.toFixed(2)}`

// A tiered piece rate (e.g. cage tipping) pays Tier 1 for the first N units
// done in an hour and Tier 2 for the rest — this is that threshold.
const TIER1_UNIT_CAP = 4

// "RM 3.20/cage" for a flat job, "RM 3.20 → 5.00/cage" for a tiered one.
function rateLabelFor(
  rateFor: (jobId: string) => number,
  tier2RateFor: (jobId: string) => number | null,
  jobId: string,
) {
  const tier2 = tier2RateFor(jobId)
  return tier2 == null ? RM(rateFor(jobId)) : `${RM(rateFor(jobId))} → ${tier2.toFixed(2)}`
}

// "3 × RM3.20" for a flat job or a tiered one still within its first tier;
// "4 × RM3.20 + 2 × RM5.00" once the count crosses into the second tier.
function breakdownFor(
  rateFor: (jobId: string) => number,
  tier2RateFor: (jobId: string) => number | null,
  jobId: string,
  count: number,
) {
  const tier2 = tier2RateFor(jobId)
  const rate = rateFor(jobId)
  if (tier2 == null || count <= TIER1_UNIT_CAP) return `${count} × ${RM(rate)}`
  const tier2Count = count - TIER1_UNIT_CAP
  return `${TIER1_UNIT_CAP} × ${RM(rate)} + ${tier2Count} × ${RM(tier2)}`
}

// Status-bar clock that actually ticks (the page itself rarely re-renders).
function StatusClock() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 15_000)
    return () => clearInterval(t)
  }, [])
  return <span>{now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
}

// Camera photos are several MB; shrink to a sensible size before uploading so
// records post fast on mobile data. Falls back to the original on any failure.
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

export default function DemoMobile() {
  const { profile } = useAuth()
  const [grades, setGrades] = useState<Grade[]>([])
  const [tier, setTier] = useState<Grade | null>(null)
  const [stations, setStations] = useState<Station[]>([])
  const [jobs, setJobs] = useState<Job[]>([])
  const [rates, setRates] = useState<PieceRate[]>([])
  const [tab, setTab] = useState<Tab>('performance')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  // photo_records.job_id only exists once the hourly piece-work migration has
  // been run — probe once so the mobile view can fall back to the plain
  // stamp card (no job/rate) instead of erroring when it hasn't been applied.
  const [jobColumnReady, setJobColumnReady] = useState(false)

  useEffect(() => {
    let cancelled = false
    supabase
      .from('photo_records')
      .select('job_id')
      .limit(1)
      .then(({ error: probeErr }) => {
        if (!cancelled) setJobColumnReady(!probeErr)
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    async function load() {
      const [g, s, j, r] = await Promise.all([
        supabase.from('grades').select('*').order('sort_order'),
        supabase.from('stations').select('*').order('sort_order'),
        supabase.from('jobs').select('*').eq('active', true),
        supabase.from('piece_rates').select('*'),
      ])
      const err = g.error || s.error || j.error || r.error
      if (err) setError(err.message)
      setGrades(g.data ?? [])
      setStations(s.data ?? [])
      setJobs(j.data ?? [])
      setRates(r.data ?? [])
      if (g.data && g.data.length > 0) setTier((prev) => prev ?? g.data[0])
      setLoading(false)
    }
    load()
  }, [])

  // Latest rate in force per job (effective_from <= today). A tiered rate
  // (e.g. cage tipping) pays tier2Rate from the 5th unit onward, resetting
  // every hour — amountFor is the one place that math happens.
  const bestRate = useMemo(() => {
    const today = todayISO()
    const best = new Map<string, PieceRate>()
    for (const r of rates) {
      if (r.effective_from > today) continue
      const cur = best.get(r.job_id)
      if (!cur || r.effective_from > cur.effective_from) best.set(r.job_id, r)
    }
    return best
  }, [rates])
  const rateFor = useMemo(() => (jobId: string) => bestRate.get(jobId)?.rate ?? 0, [bestRate])
  const tier2RateFor = useMemo(
    () => (jobId: string) => bestRate.get(jobId)?.tier2_rate ?? null,
    [bestRate],
  )
  const amountFor = useMemo(
    () => (jobId: string, quantity: number) => {
      const tier2 = tier2RateFor(jobId)
      const rate = rateFor(jobId)
      if (tier2 == null) return rate * quantity
      const tier1Qty = Math.min(quantity, TIER1_UNIT_CAP)
      const tier2Qty = Math.max(0, quantity - TIER1_UNIT_CAP)
      return tier1Qty * rate + tier2Qty * tier2
    },
    [rateFor, tier2RateFor],
  )

  // The preview obeys the SELECTED tier's capabilities — only tiers with
  // the data-entry capability may submit records. Tiers holding verify or
  // approve (Engineer / Manager / Management) get the management dashboards
  // and see ALL stations; lower tiers see only their own station tags.
  const tierCaps = effectiveCapabilities(tier)
  const canEntry = tierCaps.includes('data-entry')
  const isUpper = tierCaps.includes('report-view')
  const myStationIds = profile?.station_ids ?? []
  const scopedStations =
    isUpper || myStationIds.length === 0
      ? stations
      : stations.filter((s) => myStationIds.includes(s.id))

  return (
    <div className="stack">
      <div>
        <Link to="/" className="small muted backlink">← Back to main page</Link>
        <h1>Demo Mobile View</h1>
        <p className="muted">
          Pick a tier on the left to preview that tier's version of the app.
          Station requirements are preset in Settings → Tags management.
        </p>
      </div>

      {error && <div className="error">{error}</div>}

      <div className="demo-layout">
        {/* Tier rail — mirrors the tier tags in Tags management. */}
        <div className="card tier-rail">
          <h3>Tier version</h3>
          <p className="muted small">Loaded from Tags management — new tiers show up here automatically.</p>
          <div className="tag-list">
            {grades.map((g) => (
              <button
                key={g.id}
                className={`tag-row ${tier?.id === g.id ? 'active' : ''}`}
                onClick={() => setTier(g)}
              >
                <span className={`tag-dot dot-${g.color}`} />
                <span>{g.sort_order}. {g.name}</span>
              </button>
            ))}
            {!loading && grades.length === 0 && (
              <p className="muted small">No tier tags yet — create them in Settings.</p>
            )}
          </div>
        </div>

        <div className="phone-wrap">
          <div className="phone">
            <div className="phone-screen">
              <div className="mob-status">
                <StatusClock />
                <span>▮▮▮</span>
              </div>

              {tier && (
                <div className="mob-tier-ribbon">
                  <span className={`tag-dot dot-${tier.color}`} />
                  <span>{tier.name} view</span>
                </div>
              )}

              <div className="mob-content">
                {loading ? (
                  <div className="mob-body"><p className="muted small">Loading…</p></div>
                ) : tab === 'performance' ? (
                  <PerformanceTab
                    stations={scopedStations}
                    scoped={scopedStations.length !== stations.length}
                    tier={tier}
                    grades={grades}
                    jobs={jobs}
                    rateFor={rateFor}
                    amountFor={amountFor}
                    tier2RateFor={tier2RateFor}
                    profileId={profile?.id ?? null}
                    jobColumnReady={jobColumnReady}
                    onError={setError}
                  />
                ) : tab === 'record' ? (
                  <RecordTab
                    profileId={profile?.id ?? null}
                    myName={profileName(profile)}
                    tier={tier}
                    grades={grades}
                    stations={stations}
                    myStations={scopedStations}
                    jobs={jobs}
                    rateFor={rateFor}
                    amountFor={amountFor}
                    tier2RateFor={tier2RateFor}
                    canEntry={canEntry}
                    jobColumnReady={jobColumnReady}
                    onError={setError}
                  />
                ) : isUpper ? (
                  <ManagerProfileTab
                    myName={profileName(profile)}
                    tier={tier}
                    stations={stations}
                    amountFor={amountFor}
                    onError={setError}
                  />
                ) : (
                  <ProfileTab
                    profileId={profile?.id ?? null}
                    myName={profileName(profile)}
                    tier={tier}
                    stations={stations}
                    jobs={jobs}
                    amountFor={amountFor}
                    onRecord={() => setTab('record')}
                  />
                )}
              </div>

              <TabBar tab={tab} onTab={setTab} />
            </div>
          </div>
          <p className="muted small">
            Live demo — records and photos really save. On a phone the camera opens directly.
          </p>
        </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Bottom tab bar — COMMON to every tier's version                    */
/* ------------------------------------------------------------------ */

function TabBar({ tab, onTab }: { tab: Tab; onTab: (t: Tab) => void }) {
  return (
    <div className="mob-tabbar">
      <button className={`mob-tab ${tab === 'performance' ? 'active' : ''}`} onClick={() => onTab('performance')}>
        <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="2.2" strokeLinecap="round">
          <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
        </svg>
        <span>Performance</span>
      </button>
      <button
        className={`mob-tab-main ${tab === 'record' ? 'active' : ''}`}
        onClick={() => onTab('record')}
        aria-label="Record"
      >
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 20h9" />
          <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
        </svg>
      </button>
      <button className={`mob-tab ${tab === 'profile' ? 'active' : ''}`} onClick={() => onTab('profile')}>
        <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="8" r="4" />
          <path d="M4 21c0-4 3.6-6 8-6s8 2 8 6" />
        </svg>
        <span>Profile</span>
      </button>
    </div>
  )
}

/** Top-bar badge: the previewed tier's name spelled out in full. */
function TierBadge({ tier }: { tier: Grade | null }) {
  return <span className="mob-tier">{tier?.name ?? '—'}</span>
}

function dayISO(d: Date) {
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10)
}

function hourLabel(h: number) {
  const h24 = ((h % 24) + 24) % 24
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12
  return `${h12}${h24 >= 12 ? 'PM' : 'AM'}`
}

// Records arrive newest-first; keep that order and bucket them per hour zone
// (and per job, so switching jobs mid-hour never merges two jobs' counts).
function groupByHour(records: PhotoRecord[]): Array<[number, string | null, PhotoRecord[]]> {
  const groups: Array<[number, string | null, PhotoRecord[]]> = []
  for (const r of records) {
    const h = new Date(r.taken_at).getHours()
    const jid = r.job_id ?? null
    const last = groups[groups.length - 1]
    if (last && last[0] === h && last[1] === jid) last[2].push(r)
    else groups.push([h, jid, [r]])
  }
  return groups
}

function RecordRow({ record, url }: { record: PhotoRecord; url: string | null }) {
  const t = new Date(record.taken_at)
  return (
    <div className="mob-row">
      <span>
        {t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        <span className="mob-station-meta">
          {' '}· {t.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
        </span>
      </span>
      {url ? (
        <a href={url} target="_blank" rel="noreferrer">
          <img className="mob-thumb" src={url} alt="record" loading="lazy" />
        </a>
      ) : (
        <span className="mob-chip">no photo</span>
      )}
    </div>
  )
}

function statusChip(status: string | undefined) {
  const s = status ?? 'approved'
  const cls = s === 'approved' ? 'ok' : s === 'rejected' ? 'bad' : s === 'verified' ? 'mid' : 'warn'
  const label = s === 'approved' ? 'Approved' : s === 'rejected' ? 'Rejected' : s === 'verified' ? 'Verified' : 'Pending'
  return <span className={`mob-chip ${cls}`}>{label}</span>
}

/* ------------------------------------------------------------------ */
/* TAB 1 — PERFORMANCE: station dashboard → stamp card & records      */
/* Operators see their own station tags; verify/approve tiers see all */
/* stations. Tapping a station opens its stamp-card detail.           */
/* ------------------------------------------------------------------ */

function PerformanceTab({
  stations,
  scoped,
  tier,
  grades,
  jobs,
  rateFor,
  amountFor,
  tier2RateFor,
  profileId,
  jobColumnReady,
  onError,
}: {
  stations: Station[]
  scoped: boolean
  tier: Grade | null
  grades: Grade[]
  jobs: Job[]
  rateFor: (jobId: string) => number
  amountFor: (jobId: string, quantity: number) => number
  tier2RateFor: (jobId: string) => number | null
  profileId: string | null
  jobColumnReady: boolean
  onError: (m: string | null) => void
}) {
  const [station, setStation] = useState<Station | null>(null)
  const [entries, setEntries] = useState<ProductionEntry[]>([])
  const canEntry = effectiveCapabilities(tier).includes('data-entry')
  const monthStart = todayISO().slice(0, 8) + '01'

  useEffect(() => {
    supabase
      .from('production_entries')
      .select('*')
      .gte('work_date', monthStart)
      .then(({ data, error }) => {
        if (error) onError(error.message)
        else setEntries(data ?? [])
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (station) {
    return (
      <StationScreen
        station={station}
        tier={tier}
        grades={grades}
        jobs={jobs}
        rateFor={rateFor}
        amountFor={amountFor}
        tier2RateFor={tier2RateFor}
        profileId={profileId}
        jobColumnReady={jobColumnReady}
        canEntry={canEntry}
        onBack={() => setStation(null)}
        onError={onError}
      />
    )
  }

  const statFor = (sid: string) => {
    const rows = entries.filter((e) => e.station_id === sid)
    const workers = new Set(rows.map((e) => e.user_id ?? e.created_by ?? e.worker_id)).size
    const output = rows.reduce((s, e) => s + e.quantity, 0)
    const done = rows.filter((e) => (e.approval_status ?? 'approved') === 'approved').length
    const pct = rows.length > 0 ? Math.round((done / rows.length) * 100) : null
    return { workers, output, pct }
  }
  const totalOutput = stations.reduce((s, st) => s + statFor(st.id).output, 0)
  const scopedRows = entries.filter((e) => stations.some((s) => s.id === e.station_id))
  const doneAll = scopedRows.filter((e) => (e.approval_status ?? 'approved') === 'approved').length
  const compliance = scopedRows.length > 0 ? Math.round((doneAll / scopedRows.length) * 100) : null
  const monthLabel = new Date().toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
  const fmtQty = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1))

  return (
    <>
      <div className="mob-header">
        <span className="mob-brand">MJM</span>
        <TierBadge tier={tier} />
      </div>
      <div className="mob-body">
        <div style={{ padding: '0 0.2rem' }}>
          <div className="mob-role">Performance dashboard</div>
          <div className="mob-sub">{monthLabel} · {scoped ? 'your stations' : 'all stations'}</div>
        </div>

        <div className="mob-grid2">
          <div className="mob-card">
            <div className="mob-field-label">Output this month</div>
            <div className="mob-stat">{fmtQty(totalOutput)}</div>
          </div>
          <div className="mob-card">
            <div className="mob-field-label">Approval %</div>
            <div className="mob-stat">{compliance == null ? '—' : `${compliance}%`}</div>
          </div>
        </div>

        <div className="mob-sub" style={{ padding: '0 0.2rem' }}>Station performance — tap to open records</div>
        {stations.length === 0 && (
          <p className="muted small">No stations for your tags yet — set station tags in Settings.</p>
        )}
        {stations.map((s) => {
          const st = statFor(s.id)
          return (
            <button className="mob-station perf" key={s.id} onClick={() => setStation(s)}>
              <span className="perf-top">
                <span>{s.name}</span>
                <span className="mob-station-meta">
                  {st.workers > 0 ? `${st.workers} worker${st.workers === 1 ? '' : 's'} · ` : ''}
                  {fmtQty(st.output)} output ›
                </span>
              </span>
              <span className="perf-bar-row">
                <span className="mob-bartrack">
                  <div
                    className={st.pct != null && st.pct < 80 ? 'best' : ''}
                    style={{ width: `${st.pct ?? 0}%` }}
                  />
                </span>
                <span className="val">{st.pct == null ? '—' : `${st.pct}%`}</span>
              </span>
            </button>
          )
        })}
      </div>
    </>
  )
}

// Hard cap on hourly piece-work photos — a station's hourly_target is a
// visual goal and may be lower, but no more than this converts to pay.
const HOURLY_PHOTO_CAP = 8

function StationScreen({
  station,
  tier,
  grades,
  jobs,
  rateFor,
  amountFor,
  tier2RateFor,
  profileId,
  jobColumnReady,
  canEntry,
  onBack,
  onError,
}: {
  station: Station
  tier: Grade | null
  grades: Grade[]
  jobs: Job[]
  rateFor: (jobId: string) => number
  amountFor: (jobId: string, quantity: number) => number
  tier2RateFor: (jobId: string) => number | null
  profileId: string | null
  jobColumnReady: boolean
  canEntry: boolean
  onBack: () => void
  onError: (m: string | null) => void
}) {
  return (
    <>
      <div className="mob-header">
        <button className="mob-back" onClick={onBack}>‹ Stations</button>
        <span className="mob-brand">MJM</span>
        <TierBadge tier={tier} />
      </div>

      <div className="mob-body">
        {tier?.name === 'Management' ? (
          <div className="mob-card">
            <div className="mob-sub">We can't work under {station.name}.</div>
          </div>
        ) : (
          <StationWorkPanel
            station={station}
            tier={tier}
            grades={grades}
            jobs={jobs}
            rateFor={rateFor}
            amountFor={amountFor}
            tier2RateFor={tier2RateFor}
            profileId={profileId}
            jobColumnReady={jobColumnReady}
            canEntry={canEntry}
            onError={onError}
          />
        )}
      </div>
    </>
  )
}

/* Job picker + stamp card + photo capture + hour-grouped records — shared
   between the Performance tab's station drill-in and the Operator's merged
   Record tab. */
function StationWorkPanel({
  station,
  tier,
  grades,
  jobs,
  rateFor,
  amountFor,
  tier2RateFor,
  profileId,
  jobColumnReady,
  canEntry,
  onError,
}: {
  station: Station
  tier: Grade | null
  grades: Grade[]
  jobs: Job[]
  rateFor: (jobId: string) => number
  amountFor: (jobId: string, quantity: number) => number
  tier2RateFor: (jobId: string) => number | null
  profileId: string | null
  jobColumnReady: boolean
  canEntry: boolean
  onError: (m: string | null) => void
}) {
  const [viewDate, setViewDate] = useState(() => new Date())
  const [records, setRecords] = useState<PhotoRecord[]>([])
  const [stationEntries, setStationEntries] = useState<ProductionEntry[]>([])
  const [uploading, setUploading] = useState(false)
  const [jobId, setJobId] = useState('')
  const [, forceTick] = useState(0)
  const fileRef = useRef<HTMLInputElement>(null)

  // The piece-rate photo flow (job picker, 8/hour cap, auto-conversion to a
  // production entry) only applies once the job_id column migration has run;
  // until then this behaves as the plain compliance-only stamp card.
  const hourlyPieceWork = station.hourly_count && jobColumnReady
  const isToday = dayISO(viewDate) === dayISO(new Date())
  const target = hourlyPieceWork
    ? Math.min(station.hourly_target ?? 6, HOURLY_PHOTO_CAP)
    : station.hourly_target ?? 6

  // Jobs this tier may record at this station, priced at an APPROVED rate only.
  const tierOf = (gid: string | null) => grades.find((g) => g.id === gid)?.sort_order
  const approvedJobs = jobs.filter(
    (j) =>
      j.station_id === station.id &&
      j.approval_status === 'approved' &&
      (!j.grade_id || tier == null || (tierOf(j.grade_id) ?? 99) >= tier.sort_order),
  )

  // Auto-pick the job when there's only one option; otherwise wait for a choice.
  useEffect(() => {
    if (!hourlyPieceWork) return
    setJobId((prev) =>
      approvedJobs.length === 1
        ? approvedJobs[0].id
        : approvedJobs.some((j) => j.id === prev) ? prev : '',
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [station.id, hourlyPieceWork, approvedJobs.length])

  async function loadRecords() {
    const start = new Date(viewDate)
    start.setHours(0, 0, 0, 0)
    const end = new Date(start.getTime() + 24 * 3_600_000)
    const cols: string = jobColumnReady
      ? 'id, station_id, photo_path, taken_at, job_id, entry_id'
      : 'id, station_id, photo_path, taken_at, entry_id'
    const { data, error } = await supabase
      .from('photo_records')
      .select<string, PhotoRecord>(cols)
      .eq('station_id', station.id)
      .gte('taken_at', start.toISOString())
      .lt('taken_at', end.toISOString())
      .order('taken_at', { ascending: false })
    if (error) onError(error.message)
    else setRecords(data ?? [])

    if (hourlyPieceWork) {
      const { data: entryRows, error: entryErr } = await supabase
        .from('production_entries')
        .select('*')
        .eq('station_id', station.id)
        .eq('work_date', dayISO(viewDate))
      if (entryErr) onError(entryErr.message)
      else setStationEntries(entryRows ?? [])
    }
  }

  // Once an hour has fully elapsed, its photo count converts into a pending
  // production entry (quantity = photo count, priced via rateFor at read
  // time from the approved piece rate) — never the still-running hour.
  async function autoSubmitElapsedHours() {
    if (!hourlyPieceWork || !profileId) return
    const { data, error } = await supabase
      .from('photo_records')
      .select('id, taken_at, job_id')
      .eq('station_id', station.id)
      .eq('created_by', profileId)
      .is('entry_id', null)
      .not('job_id', 'is', null)
      .order('taken_at', { ascending: true })
    if (error || !data || data.length === 0) return

    const currentHourStart = new Date()
    currentHourStart.setMinutes(0, 0, 0)

    const groups = new Map<string, { jobId: string; workDate: string; ids: string[] }>()
    for (const r of data) {
      const bucketStart = new Date(r.taken_at)
      bucketStart.setMinutes(0, 0, 0)
      if (bucketStart >= currentHourStart || !r.job_id) continue // still live — leave it
      const key = `${r.job_id}-${bucketStart.toISOString()}`
      const g = groups.get(key)
      if (g) g.ids.push(r.id)
      else groups.set(key, { jobId: r.job_id, workDate: dayISO(bucketStart), ids: [r.id] })
    }
    if (groups.size === 0) return

    for (const { jobId: jid, workDate, ids } of groups.values()) {
      const { data: entry, error: insErr } = await supabase
        .from('production_entries')
        .insert({
          work_date: workDate,
          station_id: station.id,
          job_id: jid,
          user_id: profileId,
          created_by: profileId,
          quantity: ids.length,
          approval_status: 'pending',
        })
        .select()
        .single()
      if (insErr || !entry) continue
      await supabase.from('photo_records').update({ entry_id: entry.id }).in('id', ids)
    }
    await loadRecords()
  }

  useEffect(() => {
    loadRecords()
    autoSubmitElapsedHours()
    const t = setInterval(() => {
      forceTick((x) => x + 1) // refresh the minutes-left countdown
      autoSubmitElapsedHours()
      if (dayISO(viewDate) === dayISO(new Date())) loadRecords()
    }, 30_000)
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [station.id, viewDate, jobColumnReady])

  const now = new Date()
  const stampsThisHour = records.filter((r) => {
    const t = new Date(r.taken_at)
    return isToday && t.getHours() === now.getHours()
  }).length
  const minutesLeft = 59 - now.getMinutes()
  const hourZone = `${hourLabel(now.getHours())} – ${hourLabel(now.getHours() + 1)}`
  // Bonus: hitting the preset minimum in the PREVIOUS hour turns this hour's
  // stamps into reward stamps.
  const minPrev = station.hourly_min_prev ?? 0
  const prevHourCount = records.filter((r) => {
    const t = new Date(r.taken_at)
    return isToday && t.getHours() === now.getHours() - 1
  }).length
  const rewardActive = minPrev > 0 && prevHourCount >= minPrev
  // ...and this hour's count decides whether the NEXT hour is a bonus hour.
  const nextHourBonus = minPrev > 0 && stampsThisHour >= minPrev

  async function handleFile(file: File | undefined) {
    if (!file) return
    if (hourlyPieceWork && (!jobId || stampsThisHour >= HOURLY_PHOTO_CAP)) return
    setUploading(true)
    onError(null)
    try {
      const photo = await compressImage(file)
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const path = `${station.id}/${stamp}-${Math.random().toString(36).slice(2, 7)}.jpg`
      const { error: upErr } = await supabase.storage
        .from('records')
        .upload(path, photo, { contentType: 'image/jpeg' })
      if (upErr) throw new Error(upErr.message)
      const { error: insErr } = await supabase
        .from('photo_records')
        .insert({
          station_id: station.id,
          photo_path: path,
          ...(hourlyPieceWork ? { job_id: jobId } : {}),
        })
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

  const rateLabel = (jobId: string) => rateLabelFor(rateFor, tier2RateFor, jobId)
  const hourBreakdown = (jobId: string, count: number) => breakdownFor(rateFor, tier2RateFor, jobId, count)

  return (
    <>
        {/* 1 — status stamp card */}
        <div className="mob-card mob-highlight">
          {station.hourly_count ? (
            <>
              {!jobColumnReady && (
                <div className="mob-sub">
                  Piece-rate photo entries need a pending database update — ask your admin to
                  apply it. Photos are recording normally for now.
                </div>
              )}
              {hourlyPieceWork && canEntry && (
                approvedJobs.length === 0 ? (
                  <div className="mob-sub">
                    {tier
                      ? `No approved piece rate for the ${tier.name} tier at this station yet.`
                      : 'No approved piece rate at this station yet.'}
                  </div>
                ) : approvedJobs.length === 1 ? (
                  <div className="mob-field-label">
                    Job: {approvedJobs[0].name} · {rateLabel(approvedJobs[0].id)}{approvedJobs[0].unit}
                  </div>
                ) : (
                  <>
                    <div className="mob-field-label">Job</div>
                    <select className="mob-select" value={jobId} onChange={(e) => setJobId(e.target.value)}>
                      <option value="">Choose job…</option>
                      {approvedJobs.map((j) => (
                        <option key={j.id} value={j.id}>{j.name} · {rateLabel(j.id)}{j.unit}</option>
                      ))}
                    </select>
                  </>
                )
              )}
              <div className="mob-title mob-zone-title">{hourZone}</div>
              <div className="stamp-row">
                {Array.from({ length: target }, (_, i) => (
                  <span
                    key={i}
                    className={`stamp ${i < stampsThisHour ? (rewardActive ? 'done reward' : 'done') : ''}`}
                  >
                    ✓
                  </span>
                ))}
                {stampsThisHour > target && (
                  <span className={`stamp extra ${rewardActive ? 'reward' : ''}`}>
                    +{stampsThisHour - target}
                  </span>
                )}
              </div>
              <div className="mob-sub">
                {Math.min(stampsThisHour, target)} of {target} stamped · {minutesLeft} min left this hour
                {rewardActive && ' · bonus hour ✨'}
              </div>
              {minPrev > 0 && (
                <div className="mob-sub">
                  {nextHourBonus
                    ? `Minimum met (${stampsThisHour}/${minPrev}) — next hour is a bonus hour ✨`
                    : `${minPrev - stampsThisHour} more this hour to make ${hourLabel(now.getHours() + 1)} a bonus hour`}
                </div>
              )}
              {hourlyPieceWork && jobId && (
                <div className="mob-sub">
                  {hourBreakdown(jobId, stampsThisHour)} ={' '}
                  <strong>{RM(amountFor(jobId, stampsThisHour))}</strong> so far this hour · pending approval
                </div>
              )}
            </>
          ) : (
            <>
              <div className="mob-big">{records.length}</div>
              <div className="mob-sub">records {isToday ? 'today' : 'this day'}</div>
            </>
          )}
        </div>

        {/* 2 — add photo (camera), only for tiers with data-entry */}
        <div className="mob-card">
          <div className="mob-title">Add photo record</div>
          {!canEntry && (
            <div className="mob-sub">
              {tier ? `The ${tier.name} tier has no data entry permission.` : 'No data entry permission.'}
            </div>
          )}
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            capture="environment"
            style={{ display: 'none' }}
            onChange={(e) => handleFile(e.target.files?.[0])}
          />
          {canEntry && (!hourlyPieceWork || jobId) && (
            <button
              className="mob-btn"
              disabled={uploading || (hourlyPieceWork && stampsThisHour >= HOURLY_PHOTO_CAP)}
              onClick={() => fileRef.current?.click()}
            >
              {uploading
                ? 'Uploading…'
                : hourlyPieceWork && stampsThisHour >= HOURLY_PHOTO_CAP
                  ? `Max ${HOURLY_PHOTO_CAP} reached this hour`
                  : '📷 Take photo'}
            </button>
          )}
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
          {station.hourly_count ? (
            groupByHour(records).map(([hour, jid, rows]) => {
              const entryId = rows[0]?.entry_id
              const entry = entryId ? stationEntries.find((e) => e.id === entryId) : undefined
              const jobName = jid ? jobs.find((j) => j.id === jid)?.name : undefined
              return (
                <div key={`${hour}-${jid ?? 'x'}`}>
                  <div className="mob-hour-head">
                    <span>
                      {hourLabel(hour)} – {hourLabel(hour + 1)}{jobName ? ` · ${jobName}` : ''}
                    </span>
                    {entry ? (
                      <span className="mob-entry-side">
                        <span className="mob-entry-amt">{RM(amountFor(entry.job_id, entry.quantity))}</span>
                        {statusChip(entry.approval_status)}
                      </span>
                    ) : (
                      <span className={`mob-chip ${rows.length >= target ? 'ok' : ''}`}>
                        {rows.length >= target ? `${rows.length} of ${target} ✓` : `${rows.length} of ${target}`}
                      </span>
                    )}
                  </div>
                  {rows.map((r) => (
                    <RecordRow key={r.id} record={r} url={photoUrl(r.photo_path)} />
                  ))}
                </div>
              )
            })
          ) : (
            records.map((r) => <RecordRow key={r.id} record={r} url={photoUrl(r.photo_path)} />)
          )}
        </div>
    </>
  )
}

/* ------------------------------------------------------------------ */
/* TAB 2 — RECORD: submit a work record → pending → verify → approve  */
/* ------------------------------------------------------------------ */

function RecordTab({
  profileId,
  myName,
  tier,
  grades,
  stations,
  myStations,
  jobs,
  rateFor,
  amountFor,
  tier2RateFor,
  canEntry,
  jobColumnReady,
  onError,
}: {
  profileId: string | null
  myName: string
  tier: Grade | null
  grades: Grade[]
  stations: Station[]
  myStations: Station[]
  jobs: Job[]
  rateFor: (jobId: string) => number
  amountFor: (jobId: string, quantity: number) => number
  tier2RateFor: (jobId: string) => number | null
  canEntry: boolean
  jobColumnReady: boolean
  onError: (m: string | null) => void
}) {
  const [myStationId, setMyStationId] = useState('')
  const [entries, setEntries] = useState<ProductionEntry[]>([])
  const [detail, setDetail] = useState<ProductionEntry | null>(null)
  const [stationId, setStationId] = useState('')
  const [jobId, setJobId] = useState('')
  const [qty, setQty] = useState('')
  const [photo, setPhoto] = useState<File | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  async function loadEntries() {
    if (!profileId) return
    const { data, error } = await supabase
      .from('production_entries')
      .select('*')
      .eq('user_id', profileId)
      .order('created_at', { ascending: false })
      .limit(12)
    if (error) onError(error.message)
    else setEntries(data ?? [])
  }
  useEffect(() => {
    loadEntries()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileId])

  // Jobs at the chosen station this TIER may record — own tier and below
  // (a job with no tag is open to everyone).
  const tierOf = (gid: string | null) => grades.find((g) => g.id === gid)?.sort_order
  const stationJobs = jobs.filter(
    (j) =>
      j.station_id === stationId &&
      (!j.grade_id || tier == null || (tierOf(j.grade_id) ?? 99) >= tier.sort_order),
  )
  const job = jobs.find((j) => j.id === jobId)
  const rate = jobId ? rateFor(jobId) : 0
  const tier2Rate = jobId ? tier2RateFor(jobId) : null
  const amount = jobId ? amountFor(jobId, Number(qty) || 0) : 0

  async function submit() {
    if (!profileId || !stationId || !jobId || !Number(qty)) return
    setSubmitting(true)
    onError(null)
    try {
      const { data, error } = await supabase
        .from('production_entries')
        .insert({
          work_date: todayISO(),
          station_id: stationId,
          job_id: jobId,
          user_id: profileId,
          quantity: Number(qty),
          created_by: profileId,
          approval_status: 'pending',
        })
        .select()
        .single()
      if (error) throw new Error(error.message)
      if (photo && data) {
        const compressed = await compressImage(photo)
        const stamp = new Date().toISOString().replace(/[:.]/g, '-')
        const path = `${stationId}/entry-${stamp}.jpg`
        const { error: upErr } = await supabase.storage
          .from('records')
          .upload(path, compressed, { contentType: 'image/jpeg' })
        if (!upErr) {
          await supabase
            .from('photo_records')
            .insert({ station_id: stationId, photo_path: path, entry_id: data.id })
        }
      }
      setJobId('')
      setQty('')
      setPhoto(null)
      await loadEntries()
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  if (detail) {
    return (
      <EntryDetail
        entry={detail}
        myName={myName}
        tier={tier}
        stations={stations}
        jobs={jobs}
        rateFor={rateFor}
        amountFor={amountFor}
        tier2RateFor={tier2RateFor}
        onBack={() => setDetail(null)}
      />
    )
  }

  const stationName = (id: string) => stations.find((s) => s.id === id)?.name ?? '?'
  const jobName = (id: string) => jobs.find((j) => j.id === id)?.name ?? 'Work'

  // Operators record work by taking photos at their own station, merged
  // directly into this tab — no manual station/job/quantity form.
  const isOperator = tier?.name === 'Operator'
  const myStation = myStations.find((s) => s.id === myStationId) ?? myStations[0] ?? null

  if (isOperator) {
    return (
      <>
        <div className="mob-header">
          <span className="mob-brand">MJM</span>
          <TierBadge tier={tier} />
        </div>

        <div className="mob-body">
          <div style={{ padding: '0 0.2rem' }}>
            <div className="mob-role">Record work</div>
            {myStation && <div className="mob-sub">{myStation.name}</div>}
          </div>

          {!canEntry ? (
            <div className="mob-card">
              <div className="mob-sub">
                {tier ? `The ${tier.name} tier has no data entry permission.` : 'No data entry permission.'}
              </div>
            </div>
          ) : myStations.length === 0 ? (
            <div className="mob-card">
              <div className="mob-sub">No station assigned yet — set your station tag in Settings.</div>
            </div>
          ) : (
            <>
              {myStations.length > 1 && (
                <div className="mob-card">
                  <div className="mob-field-label">Station</div>
                  <select
                    className="mob-select"
                    value={myStation?.id ?? ''}
                    onChange={(e) => setMyStationId(e.target.value)}
                  >
                    {myStations.map((s) => (
                      <option key={s.id} value={s.id}>{s.name}</option>
                    ))}
                  </select>
                </div>
              )}
              {myStation && (
                <StationWorkPanel
                  station={myStation}
                  tier={tier}
                  grades={grades}
                  jobs={jobs}
                  rateFor={rateFor}
                  amountFor={amountFor}
                  tier2RateFor={tier2RateFor}
                  profileId={profileId}
                  jobColumnReady={jobColumnReady}
                  canEntry={canEntry}
                  onError={onError}
                />
              )}
            </>
          )}
        </div>
      </>
    )
  }

  return (
    <>
      <div className="mob-header">
        <span className="mob-brand">MJM</span>
        <TierBadge tier={tier} />
      </div>

      <div className="mob-body">
        <div className="mob-role" style={{ padding: '0 0.2rem' }}>Record work</div>

        {!canEntry ? (
          <div className="mob-card">
            <div className="mob-sub">
              {tier ? `The ${tier.name} tier has no data entry permission.` : 'No data entry permission.'}
            </div>
          </div>
        ) : (
          <div className="mob-card">
            <div className="mob-field-label">Station</div>
            <select
              className="mob-select"
              value={stationId}
              onChange={(e) => {
                setStationId(e.target.value)
                setJobId('')
              }}
            >
              <option value="">Choose station…</option>
              {stations.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>

            <div className="mob-field-label">Job</div>
            <select
              className="mob-select"
              value={jobId}
              onChange={(e) => setJobId(e.target.value)}
              disabled={!stationId}
            >
              <option value="">{stationId ? 'Choose job…' : 'Pick a station first'}</option>
              {stationJobs.map((j) => (
                <option key={j.id} value={j.id}>
                  {j.name} · {rateLabelFor(rateFor, tier2RateFor, j.id)}{j.unit}
                </option>
              ))}
            </select>

            <div className="mob-field-label">Quantity{job ? ` (${job.unit.replace('/', '')})` : ''}</div>
            <input
              className="mob-input"
              type="number"
              min="0"
              step="any"
              placeholder="0"
              value={qty}
              onChange={(e) => setQty(e.target.value)}
            />

            {job && Number(qty) > 0 && (
              <div className="mob-breakrow total">
                <span>
                  {tier2Rate == null
                    ? `${qty} × ${RM(rate)}${job.unit}`
                    : breakdownFor(rateFor, tier2RateFor, jobId, Number(qty))}
                </span>
                <span>{RM(amount)}</span>
              </div>
            )}

            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              capture="environment"
              style={{ display: 'none' }}
              onChange={(e) => setPhoto(e.target.files?.[0] ?? null)}
            />
            <button className="mob-btn ghost" onClick={() => fileRef.current?.click()}>
              {photo ? '✓ Photo attached' : '📷 Attach photo evidence'}
            </button>

            <button
              className="mob-btn"
              disabled={submitting || !stationId || !jobId || !Number(qty)}
              onClick={submit}
            >
              {submitting ? 'Submitting…' : 'Submit for approval'}
            </button>
          </div>
        )}

        {/* My submitted records */}
        <div className="mob-card">
          <div className="mob-title">My records</div>
          {entries.length === 0 && <div className="mob-sub">Nothing submitted yet.</div>}
          {entries.map((e) => (
            <button className="mob-entry" key={e.id} onClick={() => setDetail(e)}>
              <span className="mob-entry-main">
                <span className="mob-entry-name">{jobName(e.job_id)}</span>
                <span className="mob-station-meta">
                  {stationName(e.station_id)} · {new Date(e.work_date + 'T00:00:00').toLocaleDateString(undefined, { day: '2-digit', month: '2-digit' })}
                </span>
              </span>
              <span className="mob-entry-side">
                <span className="mob-entry-amt">{amountFor(e.job_id, e.quantity).toFixed(2)}</span>
                {statusChip(e.approval_status)}
              </span>
            </button>
          ))}
        </div>
      </div>
    </>
  )
}

/* Entry detail — parameters, photo evidence, earnings, approval flow. */
function EntryDetail({
  entry,
  myName,
  tier,
  stations,
  jobs,
  rateFor,
  amountFor,
  tier2RateFor,
  onBack,
}: {
  entry: ProductionEntry
  myName: string
  tier: Grade | null
  stations: Station[]
  jobs: Job[]
  rateFor: (jobId: string) => number
  amountFor: (jobId: string, quantity: number) => number
  tier2RateFor: (jobId: string) => number | null
  onBack: () => void
}) {
  const [photos, setPhotos] = useState<PhotoRecord[]>([])
  useEffect(() => {
    supabase
      .from('photo_records')
      .select('*')
      .eq('entry_id', entry.id)
      .then(({ data }) => setPhotos(data ?? []))
  }, [entry.id])

  const job = jobs.find((j) => j.id === entry.job_id)
  const station = stations.find((s) => s.id === entry.station_id)
  const total = amountFor(entry.job_id, entry.quantity)
  const status = entry.approval_status ?? 'approved'
  const photoUrl = (path: string | null) =>
    path ? supabase.storage.from('records').getPublicUrl(path).data.publicUrl : null

  const submittedAt = new Date(entry.created_at)
  const verified = Boolean(entry.verified_by) || status === 'approved'
  const approved = status === 'approved'

  return (
    <>
      <div className="mob-header">
        <button className="mob-back" onClick={onBack}>‹ Records</button>
        <span className="mob-brand">MJM</span>
        <TierBadge tier={tier} />
      </div>

      <div className="mob-body">
        <div className="mob-role" style={{ padding: '0 0.2rem' }}>Entry detail</div>

        <div className="mob-card">
          <div className="mob-row">
            <span>
              <div className="mob-entry-name">{job?.name ?? 'Work'} · {station?.name ?? '?'}</div>
              <div className="mob-station-meta">
                {new Date(entry.work_date + 'T00:00:00').toLocaleDateString(undefined, {
                  day: 'numeric', month: 'long', year: 'numeric',
                })} · {myName}
              </div>
            </span>
            <span className="mob-detail-amt">{RM(total)}</span>
          </div>
          {statusChip(status)}
        </div>

        <div className="mob-card">
          <div className="mob-title">Submitted parameters</div>
          <div className="mob-grid2">
            <div>
              <div className="mob-field-label">Quantity</div>
              <div className="mob-param">{entry.quantity} {job ? job.unit.replace('/', '') : ''}</div>
            </div>
            <div>
              <div className="mob-field-label">Rate</div>
              <div className="mob-param">{rateLabelFor(rateFor, tier2RateFor, entry.job_id)}{job?.unit ?? ''}</div>
            </div>
          </div>
        </div>

        <div className="mob-card">
          <div className="mob-title">
            Photo evidence{' '}
            <span className="mob-chip">{photos.length} photo{photos.length === 1 ? '' : 's'}</span>
          </div>
          {photos.length === 0 && <div className="mob-sub">No photos attached.</div>}
          <div className="mob-photo-grid">
            {photos.map((p) => {
              const url = photoUrl(p.photo_path)
              return url ? (
                <a key={p.id} href={url} target="_blank" rel="noreferrer">
                  <img className="mob-photo" src={url} alt="evidence" />
                </a>
              ) : (
                <span key={p.id} className="mob-chip">no photo</span>
              )
            })}
          </div>
        </div>

        <div className="mob-card">
          <div className="mob-title">Earnings breakdown</div>
          <div className="mob-breakrow">
            <span>
              Base ({breakdownFor(rateFor, tier2RateFor, entry.job_id, entry.quantity)}
              {job?.unit ?? ''})
            </span>
            <span>{total.toFixed(2)}</span>
          </div>
          <div className="mob-breakrow total">
            <span>Total</span>
            <span>{RM(total)}</span>
          </div>
        </div>

        <div className="mob-card">
          <div className="mob-title">Approval flow</div>
          <div className="mob-flow">
            <div className="mob-step">
              <span className="mob-step-dot done" />
              <span>
                <div className="mob-step-name">Submitted</div>
                <div className="mob-station-meta">
                  {submittedAt.toLocaleDateString(undefined, { day: '2-digit', month: '2-digit' })}{' '}
                  {submittedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · {myName}
                </div>
              </span>
            </div>
            <div className="mob-step">
              <span className={`mob-step-dot ${verified ? 'done' : ''}`} />
              <span>
                <div className="mob-step-name">Verification</div>
                <div className="mob-station-meta">
                  {entry.verified_by ? entry.verified_by : status === 'rejected' ? 'Rejected' : verified ? 'Done' : 'Pending · verify tier'}
                </div>
              </span>
            </div>
            <div className="mob-step">
              <span className={`mob-step-dot ${approved ? 'done' : ''}`} />
              <span>
                <div className="mob-step-name">Final approval</div>
                <div className="mob-station-meta">
                  {entry.approved_by ? entry.approved_by : approved ? 'Done' : 'Waiting · approve tier'}
                </div>
              </span>
            </div>
          </div>
        </div>
      </div>
    </>
  )
}

/* ------------------------------------------------------------------ */
/* TAB 3a — PROFILE for verify/approve tiers (Engineer / Manager /    */
/* Management): mill-wide performance dashboard — payroll cost MTD,   */
/* pending approvals, compliance, 6-month trend and exception flags.  */
/* ------------------------------------------------------------------ */

function ManagerProfileTab({
  myName,
  tier,
  stations,
  amountFor,
  onError,
}: {
  myName: string
  tier: Grade | null
  stations: Station[]
  amountFor: (jobId: string, quantity: number) => number
  onError: (m: string | null) => void
}) {
  const [entries, setEntries] = useState<ProductionEntry[]>([])

  useEffect(() => {
    // Six months of entries feed the trend chart; everything else derives
    // from the same rows client-side.
    const now = new Date()
    const from = new Date(now.getFullYear(), now.getMonth() - 5, 1)
    supabase
      .from('production_entries')
      .select('*')
      .gte('work_date', dayISO(from))
      .then(({ data, error }) => {
        if (error) onError(error.message)
        else setEntries(data ?? [])
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const isApprover = effectiveCapabilities(tier).includes('approve')
  const amountOf = (e: ProductionEntry) => amountFor(e.job_id, e.quantity)
  const status = (e: ProductionEntry) => e.approval_status ?? 'approved'
  const stationName = (id: string) => stations.find((s) => s.id === id)?.name ?? '?'

  const today = todayISO()
  const monthStart = today.slice(0, 8) + '01'
  const monday = new Date()
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7))
  const weekStart = dayISO(monday)

  const mtd = entries.filter((e) => e.work_date >= monthStart)
  const payable = mtd.filter((e) => status(e) !== 'rejected')
  const cost = payable.reduce((s, e) => s + amountOf(e), 0)
  const workers = new Set(payable.map((e) => e.user_id ?? e.created_by ?? e.worker_id)).size
  const activeStations = new Set(payable.map((e) => e.station_id)).size
  const awaiting = mtd.filter((e) => (isApprover ? status(e) === 'verified' : status(e) === 'pending'))
  const rejectedWk = entries.filter((e) => status(e) === 'rejected' && e.work_date >= weekStart)
  const compliance = mtd.length > 0
    ? Math.round((mtd.filter((e) => status(e) === 'approved').length / mtd.length) * 100)
    : null

  const fmtMoney = (v: number) =>
    v >= 1000 ? `RM ${Math.round(v).toLocaleString()}` : RM(v)

  // Approval completion per station (this month).
  const stationPct = stations
    .map((s) => {
      const rows = mtd.filter((e) => e.station_id === s.id)
      return {
        id: s.id,
        name: s.name,
        pct: rows.length > 0
          ? Math.round((rows.filter((e) => status(e) === 'approved').length / rows.length) * 100)
          : null,
      }
    })
    .filter((r) => r.pct != null)

  // Payroll cost trend — last 6 months.
  const trend: { label: string; total: number }[] = []
  for (let i = 5; i >= 0; i--) {
    const d = new Date()
    const m = new Date(d.getFullYear(), d.getMonth() - i, 1)
    const prefix = dayISO(m).slice(0, 7)
    const total = entries
      .filter((e) => e.work_date.startsWith(prefix) && status(e) !== 'rejected')
      .reduce((s, e) => s + amountOf(e), 0)
    trend.push({ label: m.toLocaleDateString(undefined, { month: 'short' }), total })
  }
  const maxTrend = Math.max(1, ...trend.map((t) => t.total))
  const fmtK = (v: number) => (v >= 1000 ? `${Math.round(v / 1000)}k` : Math.round(v).toString())

  // Exception flags — only the ones that actually trigger.
  const flags: { kind: 'red' | 'amber'; title: string; text: string }[] = []
  const threeDaysAgo = new Date(Date.now() - 3 * 24 * 3_600_000)
  const aging = entries.filter(
    (e) => ['pending', 'verified'].includes(status(e)) && new Date(e.created_at) < threeDaysAgo,
  )
  if (aging.length > 0) {
    flags.push({
      kind: 'red',
      title: 'Aging approval',
      text: `${aging.length} record${aging.length === 1 ? '' : 's'} pending > 3 days`,
    })
  }
  const rejByStation = new Map<string, number>()
  for (const e of rejectedWk) rejByStation.set(e.station_id, (rejByStation.get(e.station_id) ?? 0) + 1)
  for (const [sid, n] of rejByStation) {
    if (n >= 3) flags.push({
      kind: 'amber',
      title: 'Rejection spike',
      text: `${stationName(sid)}: ${n} rejections this week`,
    })
  }
  for (const s of stations) {
    const rows = mtd.filter((e) => e.station_id === s.id)
    if (rows.length < 5) continue
    const avg = rows.reduce((sum, e) => sum + e.quantity, 0) / rows.length
    const spike = rows.find((e) => e.work_date >= weekStart && e.quantity > 2 * avg)
    if (spike) {
      flags.push({
        kind: 'amber',
        title: 'High entry',
        text: `${s.name}: ${spike.quantity} logged — above normal range`,
      })
      break
    }
  }

  // Workforce (today).
  const todayRows = entries.filter((e) => e.work_date === today)
  const activeToday = new Set(todayRows.map((e) => e.user_id ?? e.created_by ?? e.worker_id)).size
  const coveredToday = new Set(todayRows.map((e) => e.station_id)).size

  return (
    <>
      <div className="mob-header">
        <span className="mob-brand">MJM</span>
        <TierBadge tier={tier} />
      </div>

      <div className="mob-body">
        <div style={{ padding: '0 0.2rem' }}>
          <div className="mob-role">Performance dashboard</div>
          <div className="mob-sub">{myName} · {tier?.name ?? '—'} · All stations</div>
        </div>

        <div className="mob-card mob-highlight">
          <div className="mob-field-label" style={{ color: '#aeb8c4' }}>Payroll cost MTD</div>
          <div className="mob-big">{fmtMoney(cost)}</div>
          <div className="mob-sub">
            {workers} active worker{workers === 1 ? '' : 's'} across {activeStations} station{activeStations === 1 ? '' : 's'}
          </div>
        </div>

        <div className="mob-grid2">
          <div className="mob-card">
            <div className="mob-field-label">{isApprover ? 'Pending final' : 'Pending verify'}</div>
            <div className="mob-stat">{awaiting.length}</div>
          </div>
          <div className="mob-card">
            <div className="mob-field-label">Rejected this wk</div>
            <div className="mob-stat">{rejectedWk.length}</div>
          </div>
        </div>
        <div className="mob-grid2">
          <div className="mob-card">
            <div className="mob-field-label">Avg wage / worker</div>
            <div className="mob-stat">{workers > 0 ? fmtMoney(cost / workers) : '—'}</div>
          </div>
          <div className="mob-card">
            <div className="mob-field-label">Compliance %</div>
            <div className="mob-stat">{compliance == null ? '—' : `${compliance}%`}</div>
          </div>
        </div>

        {awaiting.length > 0 && (
          <div className="mob-alert">
            ⚠ {awaiting.length} record{awaiting.length === 1 ? '' : 's'} awaiting {isApprover ? 'final approval' : 'verification'} — approvals screen coming next →
          </div>
        )}

        {stationPct.length > 0 && (
          <div className="mob-card">
            <div className="mob-title">Approval completion by station</div>
            <div className="mob-bars">
              {stationPct.map((s) => (
                <div className="mob-barrow" key={s.id}>
                  <span className="lbl wide">{s.name}</span>
                  <span className="mob-bartrack">
                    <div className={s.pct! < 80 ? 'best' : ''} style={{ width: `${s.pct}%` }} />
                  </span>
                  <span className="val">{s.pct}%</span>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="mob-card">
          <div className="mob-title">Payroll cost trend (6 months)</div>
          <div className="mob-bars">
            {trend.map((t) => (
              <div className="mob-barrow" key={t.label}>
                <span className="lbl">{t.label}</span>
                <span className="mob-bartrack">
                  <div style={{ width: `${(t.total / maxTrend) * 100}%` }} />
                </span>
                <span className="val">{fmtK(t.total)}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="mob-card">
          <div className="mob-title">Exception flags</div>
          {flags.length === 0 && <div className="mob-sub">No exceptions this week.</div>}
          {flags.map((f, i) => (
            <div className={`mob-flag ${f.kind}`} key={i}>
              <div className="mob-flag-title">{f.title}</div>
              <div>{f.text}</div>
            </div>
          ))}
        </div>

        <div className="mob-card">
          <div className="mob-title">Workforce</div>
          <div className="mob-breakrow">
            <span>Active workers today</span>
            <span className="mob-entry-amt">{activeToday}</span>
          </div>
          <div className="mob-breakrow">
            <span>Records submitted today</span>
            <span className="mob-entry-amt">{todayRows.length}</span>
          </div>
          <div className="mob-breakrow">
            <span>Stations at full coverage</span>
            <span className="mob-entry-amt">{coveredToday} / {stations.length}</span>
          </div>
        </div>
      </div>
    </>
  )
}

/* ------------------------------------------------------------------ */
/* TAB 3 — PROFILE: the user's profile & earnings dashboard           */
/* ------------------------------------------------------------------ */

function ProfileTab({
  profileId,
  myName,
  tier,
  stations,
  jobs,
  amountFor,
  onRecord,
}: {
  profileId: string | null
  myName: string
  tier: Grade | null
  stations: Station[]
  jobs: Job[]
  amountFor: (jobId: string, quantity: number) => number
  onRecord: () => void
}) {
  const [entries, setEntries] = useState<ProductionEntry[]>([])

  useEffect(() => {
    if (!profileId) return
    const from = new Date()
    from.setDate(from.getDate() - 40) // covers this month + this week
    supabase
      .from('production_entries')
      .select('*')
      .eq('user_id', profileId)
      .gte('work_date', dayISO(from))
      .order('created_at', { ascending: false })
      .then(({ data }) => setEntries(data ?? []))
  }, [profileId])

  const amountOf = (e: ProductionEntry) => amountFor(e.job_id, e.quantity)
  const monthStart = todayISO().slice(0, 8) + '01'
  const monthEntries = entries.filter(
    (e) => e.work_date >= monthStart && e.approval_status !== 'rejected',
  )
  const total = monthEntries.reduce((s, e) => s + amountOf(e), 0)
  const days = new Set(monthEntries.map((e) => e.work_date)).size
  const avg = days > 0 ? total / days : 0
  const needsFix = entries.filter((e) => e.approval_status === 'rejected').length

  // This week's daily quantity (Mon–Sun).
  const week: { label: string; iso: string; qty: number }[] = []
  const today = new Date()
  const monday = new Date(today)
  monday.setDate(today.getDate() - ((today.getDay() + 6) % 7))
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday)
    d.setDate(monday.getDate() + i)
    week.push({
      label: d.toLocaleDateString(undefined, { weekday: 'short' }),
      iso: dayISO(d),
      qty: 0,
    })
  }
  for (const e of entries) {
    const slot = week.find((w) => w.iso === e.work_date)
    if (slot) slot.qty += e.quantity
  }
  const maxQty = Math.max(1, ...week.map((w) => w.qty))
  const bestIso = week.reduce((a, b) => (b.qty > a.qty ? b : a), week[0])?.iso

  const stationName = (id: string) => stations.find((s) => s.id === id)?.name ?? '?'
  const jobName = (id: string) => jobs.find((j) => j.id === id)?.name ?? 'Work'
  const initials = myName.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase()

  return (
    <>
      <div className="mob-header">
        <span className="mob-brand">MJM</span>
        <TierBadge tier={tier} />
      </div>

      <div className="mob-body">
        <div style={{ padding: '0 0.2rem' }}>
          <div className="mob-role">{myName}</div>
          <div className="mob-sub">{tier?.name ?? '—'}</div>
        </div>

        {/* This month */}
        <div className="mob-card mob-highlight">
          <div className="mob-field-label" style={{ color: '#aeb8c4' }}>This month so far</div>
          <div className="mob-big">{RM(total)}</div>
          <div className="mob-sub">{monthEntries.length} records · pending amounts included</div>
        </div>

        <div className="mob-grid2">
          <div className="mob-card">
            <div className="mob-field-label">Days worked</div>
            <div className="mob-stat">{days}</div>
          </div>
          <div className="mob-card">
            <div className="mob-field-label">Avg / day</div>
            <div className="mob-stat">{RM(avg)}</div>
          </div>
        </div>

        {needsFix > 0 && (
          <button className="mob-alert" onClick={onRecord}>
            ⚠ {needsFix} entr{needsFix === 1 ? 'y' : 'ies'} rejected — tap to fix & resubmit →
          </button>
        )}

        <button className="mob-btn" onClick={onRecord}>✎ Enter today's work record</button>

        {/* Weekly productivity */}
        <div className="mob-card">
          <div className="mob-title">Daily quantity — this week</div>
          <div className="mob-bars">
            {week.map((w) => (
              <div className="mob-barrow" key={w.iso}>
                <span className="lbl">{w.label}</span>
                <span className="mob-bartrack">
                  <div
                    className={w.iso === bestIso && w.qty > 0 ? 'best' : ''}
                    style={{ width: `${(w.qty / maxQty) * 100}%` }}
                  />
                </span>
                <span className="val">{w.qty > 0 ? w.qty : '·'}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Recent records */}
        <div className="mob-card">
          <div className="mob-title">Recent records</div>
          {entries.length === 0 && <div className="mob-sub">No records yet.</div>}
          {entries.slice(0, 5).map((e) => (
            <div className="mob-entry static" key={e.id}>
              <span className="mob-entry-main">
                <span className="mob-recent-avatar">{initials}</span>
                <span>
                  <span className="mob-entry-name">{jobName(e.job_id)}</span>
                  <span className="mob-station-meta" style={{ display: 'block' }}>
                    {stationName(e.station_id)} · {new Date(e.work_date + 'T00:00:00').toLocaleDateString(undefined, { day: '2-digit', month: '2-digit' })}
                  </span>
                </span>
              </span>
              <span className="mob-entry-side">
                <span className="mob-entry-amt">{amountOf(e).toFixed(2)}</span>
                {statusChip(e.approval_status)}
              </span>
            </div>
          ))}
        </div>
      </div>
    </>
  )
}
