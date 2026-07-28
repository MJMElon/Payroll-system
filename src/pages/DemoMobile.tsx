// ---------------------------------------------------------------------------
// DEMO MOBILE VIEW — one mobile app for every station (will move to its own
// repo later). A tier rail on the left lists every tier tag straight from
// the database; picking one previews the phone AS that tier.
//
// COMMON to EVERY tier — same layout, same five tabs, same screens:
//   Performance · My work · [ + ] · Team · Profile
// Only the PERFORMANCE tab changes what it shows per tier (an Operator sees
// their own output; verify/approve tiers also get the management dashboard).
// My work, Team and Profile are identical for everyone — they just read that
// person's own data.
// ---------------------------------------------------------------------------
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import {
  effectiveCapabilities,
  effectiveModules,
  runsWholeMill,
  stationTierOf,
} from '../lib/tags'
import {
  profileName,
  supabase,
  todayISO,
  type Grade,
  type Job,
  type PayrollAdjustment,
  type PayrollLine,
  type PayrollRun,
  type PhotoRecord,
  type PieceRate,
  type ProductionEntry,
  type Profile,
  type Station,
  type Team,
} from '../lib/supabase'

type Tab = 'performance' | 'mywork' | 'record' | 'team' | 'profile'

/**
 * Tier 1 is the super admin — it holds every capability no matter what is
 * ticked (see effectiveCapabilities). That makes it an access level rather
 * than a rung of the operating chart, so charts start below it and it is
 * never treated as a job on the floor.
 */
const ADMIN_TIER_ORDER = 1

/**
 * Nothing in the schema marks a tier as "runs the system, not the floor",
 * and position alone cannot tell when there is more than one such rung. So
 * alongside the structural tests (the super-admin rung, and holding
 * "change other users' settings") these known names are excluded from the
 * team chart. It is a closed list of existing tiers, not a rule new tiers
 * have to be added to — anything else appears on its own.
 */
const ADMIN_TIER_NAMES = /^(admin|administrator|management)$/i

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

// Once an hour has fully elapsed, that hour's photos (taken by this user at
// this station) convert into a pending production entry — quantity = photo
// count, priced at read-time via rateFor/amountFor. Never touches the still-
// running hour. Shared by the per-station screen (for a snappy refresh while
// it's open) and a app-wide check (so conversion isn't stuck waiting for that
// specific screen to be reopened after the hour ends).
async function autoSubmitElapsedHoursForStation(stationId: string, profileId: string) {
  const { data, error } = await supabase
    .from('photo_records')
    .select('id, taken_at, job_id')
    .eq('station_id', stationId)
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
        station_id: stationId,
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
  const [signupPreview, setSignupPreview] = useState(false)
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
  const isUpper =
    effectiveModules(tier?.modules).includes('report') ||
    tierCaps.includes('verify') ||
    tierCaps.includes('approve')
  const myStationIds = profile?.station_ids ?? []
  const scopedStations =
    isUpper || myStationIds.length === 0
      ? stations
      : stations.filter((s) => myStationIds.includes(s.id))

  // The Approvals PAGE is granted PER USER in Settings -> User access
  // ("Work approval screen") — not tied to any tier. Admins and the
  // tier-1 super admin always have final-approval access.
  const myOwnGrade = profile?.grade_id ? grades.find((g) => g.id === profile.grade_id) ?? null : null
  const realApprovalLevel: 'verify' | 'approve' | null =
    profile?.role === 'admin' || myOwnGrade?.sort_order === 1
      ? 'approve'
      : profile?.mobile_approval ?? null
  // In THIS demo the phone follows the previewed tier, so you can see each
  // version of the one design. In the real app there is no selector — the
  // Approvals page shows only for accounts granted the per-user
  // "Work approval screen" in Settings -> User access.
  const approvalLevel: 'verify' | 'approve' | null = signupPreview
    ? null
    : tier
      ? tierCaps.includes('approve')
        ? 'approve'
        : tierCaps.includes('verify')
          ? 'verify'
          : null
      : realApprovalLevel

  // Badge on the Approvals tab: how many entries wait for MY action.
  const [approvalsCount, setApprovalsCount] = useState(0)
  useEffect(() => {
    if (!approvalLevel || !profile?.id) return
    let cancelled = false
    async function count() {
      const { data } = await supabase
        .from('production_entries')
        .select('id, user_id, approval_status')
        .in('approval_status', ['pending', 'verified'])
      if (cancelled) return
      const rows = (data ?? []).filter(
        (e) =>
          e.user_id !== profile?.id &&
          ['pending', 'verified'].includes(e.approval_status ?? '') &&
          (approvalLevel === 'approve' || e.approval_status === 'pending'),
      )
      setApprovalsCount(rows.length)
    }
    count()
    const t = setInterval(count, 60_000)
    return () => {
      cancelled = true
      clearInterval(t)
    }
  }, [approvalLevel, profile?.id, tab])

  // Elapsed-hour photo → entry conversion used to only run while the
  // Record tab (or Performance's station drill-in) happened to be open —
  // so it never fired if you took a photo, then left before the hour
  // ended. Running it here means it checks regardless of which tab is
  // active, as long as the mobile view itself is open.
  const hourlyStationIds = scopedStations.filter((s) => s.hourly_count).map((s) => s.id).join(',')
  useEffect(() => {
    if (!profile?.id || !jobColumnReady || !hourlyStationIds) return
    const ids = hourlyStationIds.split(',')
    const run = () => {
      for (const id of ids) autoSubmitElapsedHoursForStation(id, profile.id)
    }
    run()
    const t = setInterval(run, 30_000)
    return () => clearInterval(t)
  }, [profile?.id, jobColumnReady, hourlyStationIds])

  return (
    <div className="stack">
      <header className="module-bar">
        <Link to="/" className="btn ghost backlink-btn">← Back to main page</Link>
      </header>
      <h1 className="module-banner">Demo Mobile View</h1>

      {error && <div className="error">{error}</div>}

      <div className="demo-layout">
        {/* Tier rail — mirrors the tier tags in Tags management. */}
        <div className="card tier-rail">
          <h3>View as</h3>
          <div className="tag-list">
            <button
              className={`tag-row ${signupPreview ? 'active' : ''}`}
              onClick={() => setSignupPreview(true)}
            >
              <span className="tag-dot dot-grey" />
              <span>New sign up (just registered)</span>
            </button>
            {grades.map((g) => (
              <button
                key={g.id}
                className={`tag-row ${!signupPreview && tier?.id === g.id ? 'active' : ''}`}
                onClick={() => {
                  setTier(g)
                  setSignupPreview(false)
                }}
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

              {signupPreview ? (
                <div className="mob-tier-ribbon">
                  <span className="tag-dot dot-grey" />
                  <span>New sign up view</span>
                </div>
              ) : tier && (
                <div className="mob-tier-ribbon">
                  <span className={`tag-dot dot-${tier.color}`} />
                  <span>{tier.name} view</span>
                </div>
              )}

              <div className="mob-content">
                {loading ? (
                  <div className="mob-body"><p className="muted small">Loading…</p></div>
                ) : signupPreview ? (
                  <SignupWelcome myName={profileName(profile)} />
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
                    myEmail={profile?.email ?? 'unknown'}
                    jobColumnReady={jobColumnReady}
                    onRecord={() => setTab('record')}
                    onMyWork={() => setTab('mywork')}
                    onError={setError}
                  />
                ) : tab === 'mywork' ? (
                  <MyWorkTab
                    profileId={profile?.id ?? null}
                    myName={profileName(profile)}
                    tier={tier}
                    grades={grades}
                    stations={stations}
                    jobs={jobs}
                    rateFor={rateFor}
                    amountFor={amountFor}
                    tier2RateFor={tier2RateFor}
                    myEmail={profile?.email ?? 'unknown'}
                    onError={setError}
                  />
                ) : tab === 'team' ? (
                  <TeamTab
                    profile={profile}
                    tier={tier}
                    grades={grades}
                    stations={stations}
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
                ) : (
                  <ProfileTab
                    profile={profile}
                    tier={tier}
                    grades={grades}
                    stations={stations}
                    jobs={jobs}
                    rateFor={rateFor}
                    amountFor={amountFor}
                    tier2RateFor={tier2RateFor}
                    onError={setError}
                  />
                )}
              </div>

              {!signupPreview && (
                <TabBar
                  tab={tab}
                  onTab={setTab}
                  badge={approvalLevel ? approvalsCount : 0}
                />
              )}
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

function TabBar({
  tab,
  onTab,
  badge,
}: {
  tab: Tab
  onTab: (t: Tab) => void
  badge: number
}) {
  // Five slots, identical for every tier: the "+" (add a new entry) sits
  // EXACTLY in the centre with two tabs flexing on each side —
  // Performance · My work · [ + ] · Team · Profile.
  return (
    <div className="mob-tabbar centered">
      <div className="mob-tab-side">
        <button className={`mob-tab ${tab === 'performance' ? 'active' : ''}`} onClick={() => onTab('performance')}>
          <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2.2" strokeLinecap="round">
            <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
          </svg>
          <span>Performance</span>
          {badge > 0 && <span className="mob-tab-badge">{badge > 99 ? '99+' : badge}</span>}
        </button>
        <button className={`mob-tab ${tab === 'mywork' ? 'active' : ''}`} onClick={() => onTab('mywork')}>
          <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 11l3 3 8-8" />
            <path d="M20 12v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h9" />
          </svg>
          <span>My work</span>
        </button>
      </div>
      <button
        className={`mob-tab-main ${tab === 'record' ? 'active' : ''}`}
        onClick={() => onTab('record')}
        aria-label="Add new entry"
      >
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="2.6" strokeLinecap="round">
          <path d="M12 5v14M5 12h14" />
        </svg>
      </button>
      <div className="mob-tab-side">
        <button className={`mob-tab ${tab === 'team' ? 'active' : ''}`} onClick={() => onTab('team')}>
          <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="9" cy="8" r="3.4" />
            <path d="M2.5 20c0-3.3 2.9-5 6.5-5s6.5 1.7 6.5 5" />
            <path d="M17 4.6a3.4 3.4 0 0 1 0 6.8M18.5 14.4c2 .7 3 2.3 3 4.6" />
          </svg>
          <span>Team</span>
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

/**
 * One period of the "work done" target, read like a usage meter: the window
 * and the headline percentage on top, a single 100% track filled by what was
 * approved and then by what was rejected, and the counts underneath. The
 * empty remainder IS the waiting slice — no third segment needed.
 */

/* ------------------------------------------------------------------ */
/* Review figures. Both the Performance tab and My work show these —   */
/* the Performance tab for tiers that work a station, My work for the  */
/* tiers above, who read the mill first and the review second. The     */
/* derivations live here so the two can never disagree.                */
/* ------------------------------------------------------------------ */

type Score = {
  total: number; done: number; rejected: number; waiting: number
  donePct: number; rejectedPct: number; waitingPct: number
}

/** How a set of records is going: done, rejected, still waiting. */
function scoreOver(rows: ProductionEntry[]): Score {
  const count = (k: string) => rows.filter((e) => (e.approval_status ?? 'approved') === k).length
  const done = count('approved')
  const rejected = count('rejected')
  const pct = (n: number) => (rows.length > 0 ? Math.round((n / rows.length) * 100) : 0)
  const donePct = pct(done)
  const rejectedPct = pct(rejected)
  return {
    total: rows.length, done, rejected,
    waiting: rows.length - done - rejected,
    donePct, rejectedPct,
    waitingPct: Math.max(0, 100 - donePct - rejectedPct),
  }
}

const statusOf = (e: ProductionEntry) => e.approval_status ?? 'approved'

/** Approval completion per station, this month. Stations with no records drop out. */
function approvalByStation(mtd: ProductionEntry[], stations: Station[]) {
  return stations
    .map((s) => {
      const rows = mtd.filter((e) => e.station_id === s.id)
      return {
        id: s.id,
        name: s.name,
        pct: rows.length > 0
          ? Math.round((rows.filter((e) => statusOf(e) === 'approved').length / rows.length) * 100)
          : null,
      }
    })
    .filter((r) => r.pct != null)
}

/** Only the exceptions that actually trigger: aging approvals first. */
function exceptionFlags(
  entries: ProductionEntry[],
  mtd: ProductionEntry[],
  stations: Station[],
  weekStart: string,
): { kind: 'red' | 'amber'; title: string; text: string }[] {
  const flags: { kind: 'red' | 'amber'; title: string; text: string }[] = []
  const stationName = (id: string) => stations.find((s) => s.id === id)?.name ?? 'Station'
  const threeDaysAgo = new Date(Date.now() - 3 * 24 * 3_600_000)
  const aging = entries.filter(
    (e) => ['pending', 'verified'].includes(statusOf(e)) && new Date(e.created_at) < threeDaysAgo,
  )
  if (aging.length > 0) {
    flags.push({
      kind: 'red',
      title: 'Aging approval',
      text: `${aging.length} record${aging.length === 1 ? '' : 's'} pending > 3 days`,
    })
  }
  const rejectedWk = entries.filter((e) => statusOf(e) === 'rejected' && e.work_date >= weekStart)
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
    const rowsAvg = rows.reduce((sum, e) => sum + e.quantity, 0) / rows.length
    const spike = rows.find((e) => e.work_date >= weekStart && e.quantity > 2 * rowsAvg)
    if (spike) {
      flags.push({
        kind: 'amber',
        title: 'High entry',
        text: `${s.name}: ${spike.quantity} logged — above normal range`,
      })
      break
    }
  }
  return flags
}

function ScoreMeter({
  label,
  score,
}: {
  label: string
  score: {
    total: number
    done: number
    rejected: number
    waiting: number
    donePct: number
    rejectedPct: number
    waitingPct: number
  }
}) {
  return (
    <div className="mob-meter">
      <div className="mob-meter-head">
        <span className="mob-meter-label">{label}</span>
        <span className="mob-meter-pct">{score.donePct}%</span>
      </div>
      <div
        className="mob-scorebar"
        role="img"
        aria-label={`${label}: ${score.donePct}% done, ${score.rejectedPct}% rejected, ${score.waitingPct}% waiting`}
      >
        <div className="done" style={{ width: `${score.donePct}%` }} />
        <div className="bad" style={{ width: `${score.rejectedPct}%` }} />
      </div>
      <div className="mob-meter-foot">
        {score.total === 0
          ? 'Nothing recorded yet'
          : `${score.total} record${score.total === 1 ? '' : 's'} · ${score.done} done · ${score.rejected} rejected · ${score.waiting} waiting`}
      </div>
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
/* TAB 1 — PERFORMANCE: the ONLY tab whose content changes per tier.  */
/* Every tier gets the same shell; a data-entry tier sees its own     */
/* output, a verify/approve tier also gets the management dashboard.  */
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
  myEmail,
  jobColumnReady,
  onRecord,
  onMyWork,
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
  myEmail: string
  jobColumnReady: boolean
  onRecord: () => void
  onMyWork: () => void
  onError: (m: string | null) => void
}) {
  const [station, setStation] = useState<Station | null>(null)
  const [showApprovals, setShowApprovals] = useState(false)
  const [entries, setEntries] = useState<ProductionEntry[]>([])
  const tierCaps = effectiveCapabilities(tier)
  const canEntry = tierCaps.includes('data-entry')
  const canVerify = tierCaps.includes('verify')
  const canFinal = tierCaps.includes('approve')
  const monthStart = todayISO().slice(0, 8) + '01'

  // Six months back covers the management dashboard's trend chart; the
  // month-to-date subset (mtd, below) feeds everything else.
  function loadEntries() {
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
  }
  useEffect(() => {
    loadEntries()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const mtd = entries.filter((e) => e.work_date >= monthStart)

  // This person's own records, for the weekly output chart and the
  // rejected-work nudge. The money totals they used to feed (earned, days
  // worked, average per day, waiting on approval) now live on the Profile
  // tab — the one place that answers "how did I do".
  const [myEntries, setMyEntries] = useState<ProductionEntry[]>([])

  useEffect(() => {
    if (!canEntry || !profileId) return
    const from = new Date()
    from.setDate(from.getDate() - 40) // covers this month + this week
    function load() {
      supabase
        .from('production_entries')
        .select('*')
        .eq('user_id', profileId)
        .gte('work_date', dayISO(from))
        .order('created_at', { ascending: false })
        .then(({ data }) => setMyEntries(data ?? []))
    }
    load()
    // Elapsed-hour photos can convert into entries while this page is open
    // (see the app-wide check in DemoMobile) — poll so the total updates
    // without needing to leave and come back.
    const t = setInterval(load, 30_000)
    return () => clearInterval(t)
  }, [canEntry, profileId])

  const needsFix = myEntries.filter((e) => e.approval_status === 'rejected').length

  // This week's daily quantity (Mon–Sun).
  const myWeek: { label: string; iso: string; qty: number }[] = []
  const todayDate = new Date()
  const monday = new Date(todayDate)
  monday.setDate(todayDate.getDate() - ((todayDate.getDay() + 6) % 7))
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday)
    d.setDate(monday.getDate() + i)
    myWeek.push({
      label: d.toLocaleDateString(undefined, { weekday: 'short' }),
      iso: dayISO(d),
      qty: 0,
    })
  }
  for (const e of myEntries) {
    const slot = myWeek.find((w) => w.iso === e.work_date)
    if (slot) slot.qty += e.quantity
  }
  const myMaxQty = Math.max(1, ...myWeek.map((w) => w.qty))
  const myBestIso = myWeek.reduce((a, b) => (b.qty > a.qty ? b : a), myWeek[0])?.iso

  const amountOf = (e: ProductionEntry) => amountFor(e.job_id, e.quantity)
  const status = (e: ProductionEntry) => e.approval_status ?? 'approved'
  const weekMonday = new Date()
  weekMonday.setDate(weekMonday.getDate() - ((weekMonday.getDay() + 6) % 7))
  const weekStart = dayISO(weekMonday)

  // Management dashboard — verify/approve-capable tiers only.
  const payable = mtd.filter((e) => status(e) !== 'rejected')
  const cost = payable.reduce((s, e) => s + amountOf(e), 0)
  const mgmtWorkers = new Set(payable.map((e) => e.user_id ?? e.created_by ?? e.worker_id)).size
  const activeStations = new Set(payable.map((e) => e.station_id)).size
  // Never your own work — the same self-exclusion as the Approvals tab.
  const needsMe = (e: ProductionEntry) =>
    e.user_id !== profileId &&
    ((canVerify && status(e) === 'pending') || (canFinal && status(e) === 'verified'))
  const awaiting = mtd.filter(needsMe)
  const rejectedWk = entries.filter((e) => status(e) === 'rejected' && e.work_date >= weekStart)
  const fmtMoney = (v: number) => (v >= 1000 ? `RM ${Math.round(v).toLocaleString()}` : RM(v))

  const stationPct = approvalByStation(mtd, stations)

  // Payroll cost trend — last 6 months.
  const trend: { label: string; total: number }[] = []
  for (let i = 5; i >= 0; i--) {
    const d = new Date()
    const m = new Date(d.getFullYear(), d.getMonth() - i, 1)
    const prefix = dayISO(m).slice(0, 7)
    const trendTotal = entries
      .filter((e) => e.work_date.startsWith(prefix) && status(e) !== 'rejected')
      .reduce((s, e) => s + amountOf(e), 0)
    trend.push({ label: m.toLocaleDateString(undefined, { month: 'short' }), total: trendTotal })
  }
  const maxTrend = Math.max(1, ...trend.map((t) => t.total))
  const fmtK = (v: number) => (v >= 1000 ? `${Math.round(v / 1000)}k` : Math.round(v).toString())

  const flags = exceptionFlags(entries, mtd, stations, weekStart)

  // Workforce (today).
  const today = todayISO()
  const todayRows = entries.filter((e) => e.work_date === today)
  const activeToday = new Set(todayRows.map((e) => e.user_id ?? e.created_by ?? e.worker_id)).size
  const coveredToday = new Set(todayRows.map((e) => e.station_id)).size

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

  if (showApprovals) {
    return (
      <ApprovalsScreen
        profileId={profileId}
        myEmail={myEmail}
        level={canFinal ? 'approve' : 'verify'}
        tier={tier}
        stations={stations}
        jobs={jobs}
        amountFor={amountFor}
        onBack={() => {
          setShowApprovals(false)
          loadEntries()
        }}
        onError={onError}
      />
    )
  }

  const statFor = (sid: string) => {
    const rows = mtd.filter((e) => e.station_id === sid)
    const workers = new Set(rows.map((e) => e.user_id ?? e.created_by ?? e.worker_id)).size
    const output = rows.reduce((s, e) => s + e.quantity, 0)
    const done = rows.filter((e) => (e.approval_status ?? 'approved') === 'approved').length
    const pct = rows.length > 0 ? Math.round((done / rows.length) * 100) : null
    return { workers, output, pct }
  }
  const totalOutput = stations.reduce((s, st) => s + statFor(st.id).output, 0)

  // TODAY, per station. There is no daily target to measure against (a
  // station's target is per hour, and how many hours it ran is not known
  // here), so the bar compares the stations with each other and the number
  // beside it is the real output.
  const todayStatFor = (sid: string) => {
    const rows = entries.filter((e) => e.station_id === sid && e.work_date === todayISO())
    return {
      workers: new Set(rows.map((e) => e.user_id ?? e.created_by ?? e.worker_id)).size,
      output: rows.reduce((s, e) => s + e.quantity, 0),
    }
  }
  const todayByStation = stations.map((s) => ({ station: s, ...todayStatFor(s.id) }))
  const busiestToday = Math.max(1, ...todayByStation.map((s) => s.output))
  const outputToday = todayByStation.reduce((s, x) => s + x.output, 0)

  // My own scorecard, against a target of everything I submit ending up
  // approved. Read as a meter over two windows: today first, then the week
  // it sits in. Today is mostly "waiting" by nature — work recorded this
  // morning has not been through approval yet — which is exactly what the
  // waiting slice is there to show.
  const myToday = scoreOver(myEntries.filter((e) => e.work_date === todayISO()))
  const myThisWeek = scoreOver(myEntries.filter((e) => e.work_date >= dayISO(monday)))
  const scopedRows = mtd.filter((e) => stations.some((s) => s.id === e.station_id))
  const doneAll = scopedRows.filter((e) => (e.approval_status ?? 'approved') === 'approved').length
  const compliance = scopedRows.length > 0 ? Math.round((doneAll / scopedRows.length) * 100) : null
  const monthLabel = new Date().toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
  const fmtQty = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1))

  // "Admin tier and above" is the tiers that run the WHOLE mill — above
  // the station-head tier — so the same line Settings draws, read from the
  // tag names rather than named here.
  const millWide = tier != null && runsWholeMill(tier.sort_order, stationTierOf(grades))

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

        {/* Admin tier and above read the mill first: what each station has
            put out this month, then the week, then who is on, then what it
            costs. The same cards appear once only — they are skipped in
            their old places below. */}
        {millWide && (
          <>
            <div className="mob-card">
              <div className="mob-card-label">Mill performance · {monthLabel}</div>
              {stations.length === 0 ? (
                <div className="mob-sub">No stations for your tags yet.</div>
              ) : (
                <>
                  {stations.map((s) => (
                    <button className="mob-lineitem" key={s.id} onClick={() => setStation(s)}>
                      <span className="mob-entry-name">{s.name}</span>
                      <span className="mob-entry-side">
                        <span className="mob-entry-amt">{fmtQty(statFor(s.id).output)}</span>
                        <span className="mob-caret">›</span>
                      </span>
                    </button>
                  ))}
                  <div className="mob-breakrow total">
                    <span>Total output</span>
                    <span className="mob-entry-amt">{fmtQty(totalOutput)}</span>
                  </div>
                </>
              )}
            </div>

            <div className="mob-card">
              <div className="mob-title">Daily quantity — this week</div>
              <div className="mob-bars">
                {myWeek.map((w) => (
                  <div className="mob-barrow" key={w.iso}>
                    <span className="lbl">{w.label}</span>
                    <span className="mob-bartrack">
                      <div
                        className={w.iso === myBestIso && w.qty > 0 ? 'best' : ''}
                        style={{ width: `${(w.qty / myMaxQty) * 100}%` }}
                      />
                    </span>
                    <span className="val">{w.qty > 0 ? w.qty : '·'}</span>
                  </div>
                ))}
              </div>
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
          </>
        )}

        {/* 1 — how the floor is running TODAY. Tap a station for its records. */}
        <div className="mob-card">
          <div className="mob-card-label">Station performance · today</div>
          <div className="mob-sub">
            {fmtQty(outputToday)} output across {todayByStation.filter((s) => s.output > 0).length} of{' '}
            {stations.length} station{stations.length === 1 ? '' : 's'}
          </div>
          {stations.length === 0 && (
            <div className="mob-sub">No stations for your tags yet — set station tags in Settings.</div>
          )}
          <div className="mob-bars">
            {todayByStation.map(({ station: s, output }) => (
              <button className="mob-barrow tappable" key={s.id} onClick={() => setStation(s)}>
                <span className="lbl station">{s.name}</span>
                <span className="mob-bartrack">
                  <div
                    className={output > 0 && output === busiestToday ? 'best' : ''}
                    style={{ width: `${(output / busiestToday) * 100}%` }}
                  />
                </span>
                <span className="val qty">{output > 0 ? fmtQty(output) : '·'}</span>
              </button>
            ))}
          </div>
          {todayByStation.some((s) => s.workers > 0) && (
            <div className="mob-sub">
              {todayByStation.reduce((n, s) => n + s.workers, 0)} working today
            </div>
          )}
        </div>

        {/* 2 — my own scorecard: everything I submit should end up approved.
            Above the station tiers this reads as review, not as my own
            work, so it moves to My work with the rest of the review. */}
        {canEntry && !millWide && (
          <div className="mob-card">
            <div className="mob-card-label">My work done</div>
            <div className="mob-sub">Target 100% approved</div>
            <ScoreMeter label="Today" score={myToday} />
            <ScoreMeter label="This week" score={myThisWeek} />
            <div className="mob-scorekey">
              <span><i className="dot done" />Work done</span>
              <span><i className="dot bad" />Rejected</span>
              <span><i className="dot wait" />Waiting approval</span>
            </div>
          </div>
        )}

        {canEntry && (
          <>
            {needsFix > 0 && (
              <button className="mob-alert" onClick={onMyWork}>
                ⚠ {needsFix} entr{needsFix === 1 ? 'y' : 'ies'} rejected — tap to fix & resubmit →
              </button>
            )}

            <button className="mob-btn" onClick={onRecord}>+ Add new work entry</button>

            {!millWide && (
              <div className="mob-card">
                <div className="mob-title">Daily quantity — this week</div>
                <div className="mob-bars">
                  {myWeek.map((w) => (
                    <div className="mob-barrow" key={w.iso}>
                      <span className="lbl">{w.label}</span>
                      <span className="mob-bartrack">
                        <div
                          className={w.iso === myBestIso && w.qty > 0 ? 'best' : ''}
                          style={{ width: `${(w.qty / myMaxQty) * 100}%` }}
                        />
                      </span>
                      <span className="val">{w.qty > 0 ? w.qty : '·'}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <button className="mob-btn ghost" onClick={onMyWork}>
              Every record & its status → My work
            </button>
          </>
        )}

        {(canVerify || canFinal) && (
          <>
            <div className="mob-sub" style={{ padding: '0 0.2rem' }}>Management dashboard</div>

            <div className="mob-card mob-highlight">
              <div className="mob-field-label" style={{ color: '#aeb8c4' }}>Payroll cost MTD</div>
              <div className="mob-big">{fmtMoney(cost)}</div>
              <div className="mob-sub">
                {mgmtWorkers} active worker{mgmtWorkers === 1 ? '' : 's'} across {activeStations} station{activeStations === 1 ? '' : 's'}
              </div>
            </div>

            <div className="mob-grid2">
              <div className="mob-card">
                <div className="mob-field-label">{canFinal ? 'Pending final' : 'Pending verify'}</div>
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
                <div className="mob-stat">{mgmtWorkers > 0 ? fmtMoney(cost / mgmtWorkers) : '—'}</div>
              </div>
              <div className="mob-card">
                <div className="mob-field-label">Compliance %</div>
                <div className="mob-stat">{compliance == null ? '—' : `${compliance}%`}</div>
              </div>
            </div>

            {awaiting.length > 0 && (
              <button className="mob-alert" onClick={() => setShowApprovals(true)}>
                ⚠ {awaiting.length} record{awaiting.length === 1 ? '' : 's'} awaiting {canFinal ? 'final approval' : 'verification'} — tap to review →
              </button>
            )}

            {stationPct.length > 0 && !millWide && (
              <div className="mob-card">
                <div className="mob-title">Approval completion by station</div>
                <div className="mob-bars">
                  {stationPct.map((s) => (
                    <div className="mob-barrow" key={s.id}>
                      <span className="lbl station">{s.name}</span>
                      <span className="mob-bartrack">
                        <div className={s.pct! < 80 ? 'best' : ''} style={{ width: `${s.pct}%` }} />
                      </span>
                      <span className="val">{s.pct}%</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {!millWide && (
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
            )}

            {!millWide && (
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
            )}

            {!millWide && (
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
            )}
          </>
        )}

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

        {/* Month-to-date per station, below the day's picture. Above the
            station tiers this is the Mill performance card at the top. */}
        {!millWide && (
        <div className="mob-card">
          <div className="mob-card-label">Station output · this month</div>
          {stations.map((s) => {
            const st = statFor(s.id)
            return (
              <button className="mob-lineitem" key={s.id} onClick={() => setStation(s)}>
                <span>
                  <span className="mob-entry-name">{s.name}</span>
                  <span className="mob-station-meta" style={{ display: 'block' }}>
                    {st.workers > 0 ? `${st.workers} worker${st.workers === 1 ? '' : 's'} · ` : ''}
                    {st.pct == null ? 'no records' : `${st.pct}% approved`}
                  </span>
                </span>
                <span className="mob-entry-side">
                  <span className="mob-entry-amt">{fmtQty(st.output)}</span>
                  <span className="mob-caret">›</span>
                </span>
              </button>
            )
          })}
        </div>
        )}
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
        {/* The admin tier is an access level, not a job on the floor. */}
        {tier?.sort_order === ADMIN_TIER_ORDER ? (
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

  // Runs the shared conversion for just this station, then refreshes the
  // screen immediately — the app-wide check (in DemoMobile) covers other
  // tabs/screens so this isn't the only place it can happen.
  async function autoSubmitElapsedHours() {
    if (!hourlyPieceWork || !profileId) return
    await autoSubmitElapsedHoursForStation(station.id, profileId)
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
  // Photos ARE the record now: one entry, one photo per unit of work, so
  // there is nothing to type.
  const [photos, setPhotos] = useState<File[]>([])
  const [submitting, setSubmitting] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  // Assistant Station Head is paid on the shift's actual output, not a
  // manually typed quantity: pick the date + shift they supervised, and the
  // cage count comes straight from the Operators' Daily Job Record entries
  // for that station/date/shift.
  const isASH = tier?.name === 'Assistant Station Head'
  // At station level and below there is one station — yours — and the work
  // is counted from the photos, so neither is asked for. Counted off the
  // rungs beneath the tier rather than named, the same as the Team tab.
  const rungsBelow = tier
    ? grades.filter((g) => g.sort_order > tier.sort_order && g.sort_order > 1).length
    : 0
  const atStationLevel = tier != null && rungsBelow <= 2
  const ownStation = myStations[0] ?? null
  const [dutyDate, setDutyDate] = useState(todayISO())
  const [dutyShift, setDutyShift] = useState('')
  const [pulledQty, setPulledQty] = useState(0)
  const [pulling, setPulling] = useState(false)

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

  // Nothing to choose at station level — the form is already on the right
  // station before it is opened.
  useEffect(() => {
    if (atStationLevel && ownStation && stationId !== ownStation.id) setStationId(ownStation.id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [atStationLevel, ownStation?.id])

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

  // The same job at the same station, tagged to the tier DIRECTLY BELOW
  // this one — that is whose Daily Job Record entries are the cages
  // actually tipped. Found by position, not by tier name, so inserting a
  // tier in between moves the pull to it without a code change.
  const tierBelow = tier
    ? grades
        .filter((g) => g.sort_order > tier.sort_order)
        .sort((a, b) => a.sort_order - b.sort_order)[0] ?? null
    : null
  const operatorJob = job && tierBelow
    ? jobs.find(
        (j) =>
          j.station_id === job.station_id &&
          j.name === job.name &&
          j.grade_id === tierBelow.id,
      )
    : undefined
  const ashAmount = isASH && jobId ? amountFor(jobId, pulledQty) : 0

  useEffect(() => {
    if (!isASH || !operatorJob || !dutyDate || !dutyShift) {
      setPulledQty(0)
      return
    }
    setPulling(true)
    supabase
      .from('production_entries')
      .select('quantity, approval_status')
      .eq('job_id', operatorJob.id)
      .eq('work_date', dutyDate)
      .eq('shift', dutyShift)
      .then(({ data, error }) => {
        setPulling(false)
        if (error) return onError(error.message)
        const total = (data ?? [])
          .filter((e) => e.approval_status !== 'rejected')
          .reduce((s, e) => s + Number(e.quantity), 0)
        setPulledQty(total)
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isASH, operatorJob?.id, dutyDate, dutyShift])

  async function submit() {
    if (isASH) {
      if (!profileId || !stationId || !jobId || !dutyDate || !dutyShift || !pulledQty) return
    } else if (atStationLevel) {
      if (!profileId || !stationId || !jobId || photos.length === 0) return
    } else if (!profileId || !stationId || !jobId || !Number(qty)) {
      return
    }
    // At station level the photos ARE the count — one per unit of work.
    const n = isASH ? pulledQty : atStationLevel ? photos.length : Number(qty)
    if (n <= 0) return onError('Quantity must be a positive number.')
    // Guard against fat-finger quantities (e.g. 400 instead of 40).
    if (n > 200 && !window.confirm(`Quantity ${n} looks unusually large. Submit anyway?`)) return
    setSubmitting(true)
    onError(null)
    try {
      const { data, error } = await supabase
        .from('production_entries')
        .insert({
          work_date: isASH ? dutyDate : todayISO(),
          station_id: stationId,
          job_id: jobId,
          user_id: profileId,
          quantity: n,
          shift: isASH ? dutyShift : null,
          created_by: profileId,
          approval_status: 'pending',
        })
        .select()
        .single()
      if (error) throw new Error(error.message)
      if (data) {
        for (const [i, file] of photos.entries()) {
          const compressed = await compressImage(file)
          const stamp = new Date().toISOString().replace(/[:.]/g, '-')
          const path = `${stationId}/entry-${stamp}-${i}.jpg`
          const { error: upErr } = await supabase.storage
            .from('records')
            .upload(path, compressed, { contentType: 'image/jpeg' })
          if (!upErr) {
            await supabase
              .from('photo_records')
              .insert({ station_id: stationId, photo_path: path, entry_id: data.id })
          }
        }
      }
      setJobId('')
      setQty('')
      setDutyShift('')
      setPhotos([])
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
            <div className="mob-role">Add new entry</div>
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
        <div className="mob-role" style={{ padding: '0 0.2rem' }}>Add new entry</div>

        {!canEntry ? (
          <div className="mob-card">
            <div className="mob-sub">
              {tier ? `The ${tier.name} tier has no data entry permission.` : 'No data entry permission.'}
            </div>
          </div>
        ) : (
          <div className="mob-card">
            {/* At station level you work one station — your own — so it is
                stated, not asked. */}
            {atStationLevel && ownStation ? (
              <>
                <div className="mob-field-label">Station</div>
                <div className="mob-param">{ownStation.name}</div>
              </>
            ) : (
              <>
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
              </>
            )}

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

            {isASH ? (
              <>
                <div className="mob-field-label">Date on duty</div>
                <input
                  className="mob-input"
                  type="date"
                  value={dutyDate}
                  onChange={(e) => setDutyDate(e.target.value)}
                />

                <div className="mob-field-label">Shift</div>
                <select className="mob-select" value={dutyShift} onChange={(e) => setDutyShift(e.target.value)}>
                  <option value="">Choose shift…</option>
                  <option value="a">Shift A</option>
                  <option value="b">Shift B</option>
                </select>

                {jobId && dutyDate && dutyShift && (
                  <div className="mob-sub">
                    {pulling
                      ? 'Pulling cages tipped from Daily Job Record…'
                      : !operatorJob
                        ? 'No matching Operator job found at this station.'
                        : `${pulledQty} cage${pulledQty === 1 ? '' : 's'} tipped (from Daily Job Record)`}
                  </div>
                )}

                {job && pulledQty > 0 && (
                  <div className="mob-breakrow total">
                    <span>
                      {tier2Rate == null
                        ? `${pulledQty} × ${RM(rate)}${job.unit}`
                        : breakdownFor(rateFor, tier2RateFor, jobId, pulledQty)}
                    </span>
                    <span>{RM(ashAmount)}</span>
                  </div>
                )}
              </>
            ) : (
              !atStationLevel && (
                <>
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
                </>
              )
            )}

            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              capture="environment"
              style={{ display: 'none' }}
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) setPhotos((prev) => [...prev, f])
                if (fileRef.current) fileRef.current.value = ''
              }}
            />

            {/* Each photo is one unit of work, so they are shown back before
                anything is sent — a miscount is obvious here and nowhere
                later. */}
            {photos.length > 0 && (
              <>
                <div className="mob-field-label">
                  {photos.length} photo{photos.length === 1 ? '' : 's'}
                  {atStationLevel && job ? ` · ${photos.length}${job.unit}` : ''}
                </div>
                <div className="mob-photo-grid">
                  {photos.map((f, i) => (
                    <span className="mob-photo-slot" key={`${f.name}-${i}`}>
                      <img className="mob-photo" src={URL.createObjectURL(f)} alt={`photo ${i + 1}`} />
                      <button
                        className="mob-photo-x"
                        onClick={() => setPhotos((prev) => prev.filter((_, x) => x !== i))}
                        aria-label={`Remove photo ${i + 1}`}
                      >
                        ✕
                      </button>
                    </span>
                  ))}
                </div>
                {atStationLevel && job && (
                  <div className="mob-breakrow total">
                    <span>{breakdownFor(rateFor, tier2RateFor, jobId, photos.length)}{job.unit}</span>
                    <span>{RM(amountFor(jobId, photos.length))}</span>
                  </div>
                )}
              </>
            )}

            <button className="mob-btn ghost" onClick={() => fileRef.current?.click()}>
              {photos.length > 0 ? '📷 Add photo' : '📷 Take photo'}
            </button>

            <button
              className="mob-btn"
              disabled={
                submitting ||
                !stationId ||
                !jobId ||
                (isASH
                  ? !dutyDate || !dutyShift || !pulledQty
                  : atStationLevel
                    ? photos.length === 0
                    : !Number(qty))
              }
              onClick={submit}
            >
              {submitting ? 'Submitting…' : 'Submit for approval'}
            </button>
          </div>
        )}

        {/* Just-submitted confirmation — the full history lives in My work. */}
        <div className="mob-card">
          <div className="mob-title">Recently submitted</div>
          {entries.length === 0 && <div className="mob-sub">Nothing submitted yet.</div>}
          {entries.slice(0, 5).map((e) => (
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

/**
 * How many photos back an entry, and a way to look at them. Zero photos
 * still says so — an entry with none is worth noticing.
 */
function PhotoChip({ n, onOpen }: { n: number; onOpen: () => void }) {
  return (
    <button className={`mob-photochip ${n === 0 ? 'none' : ''}`} onClick={onOpen} disabled={n === 0}>
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 8h3.2l1.6-2.4h8.4L18.8 8H21v11H3z" />
        <circle cx="12" cy="13" r="3.4" />
      </svg>
      <span>{n === 0 ? 'no photo' : n}</span>
    </button>
  )
}

/** The photos behind one entry, fetched when it is opened. */
function PhotoSheet({ entry, onClose }: { entry: ProductionEntry; onClose: () => void }) {
  const [rows, setRows] = useState<PhotoRecord[]>([])
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    supabase
      .from('photo_records')
      .select('*')
      .eq('entry_id', entry.id)
      .order('taken_at', { ascending: true })
      .then(({ data }) => {
        setRows((data ?? []) as PhotoRecord[])
        setLoading(false)
      })
  }, [entry.id])
  const url = (path: string | null) =>
    path ? supabase.storage.from('records').getPublicUrl(path).data.publicUrl : null
  return (
    <div className="mob-modal-wrap" role="dialog" aria-modal="true">
      <div className="mob-modal">
        <div className="mob-card-label">
          <span>Photos</span>
          <button className="mob-icon-btn corner close" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="mob-sub">
          {new Date(entry.work_date + 'T00:00:00').toLocaleDateString(undefined, {
            day: 'numeric', month: 'long',
          })}
        </div>
        {loading ? (
          <div className="mob-sub">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="mob-sub">No photos attached.</div>
        ) : (
          <div className="mob-photo-grid">
            {rows.map((r) => {
              const u = url(r.photo_path)
              return u ? (
                <a key={r.id} href={u} target="_blank" rel="noreferrer">
                  <img className="mob-photo" src={u} alt="" />
                </a>
              ) : (
                <span key={r.id} className="mob-chip">missing</span>
              )
            })}
          </div>
        )}
        <button className="mob-btn ghost" onClick={onClose}>Close</button>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* TAB 2 — MY WORK: the SAME screen for every tier — everything this  */
/* person recorded, split into what is waiting for approval, what was */
/* approved and what came back rejected. Rejected entries can be      */
/* fixed and pushed back into the queue; tapping any entry opens its  */
/* detail with the full verify → approve trail.                       */
/* ------------------------------------------------------------------ */

type WorkFilter = 'pending' | 'approved' | 'rejected'


/* ------------------------------------------------------------------ */
/* The review, for the tiers that run the whole mill. Their Performance */
/* tab reads the mill — output, the week, who is on, what it costs — so */
/* the checking half lives here under My work: what is approved, what   */
/* is going wrong, and how their own records are doing.                 */
/* ------------------------------------------------------------------ */

function ReviewSections({
  stations,
  profileId,
  onError,
}: {
  stations: Station[]
  profileId: string | null
  onError: (m: string | null) => void
}) {
  const [entries, setEntries] = useState<ProductionEntry[]>([])
  const [mine, setMine] = useState<ProductionEntry[]>([])

  useEffect(() => {
    const from = new Date()
    from.setDate(from.getDate() - 40) // this month and this week, both covered
    supabase
      .from('production_entries')
      .select('*')
      .gte('work_date', dayISO(from))
      .then(({ data, error }) => {
        if (error) return onError(error.message)
        const rows = data ?? []
        setEntries(rows)
        setMine(profileId ? rows.filter((e) => e.user_id === profileId) : [])
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileId])

  const monthStart = todayISO().slice(0, 8) + '01'
  const mtd = entries.filter((e) => e.work_date >= monthStart)
  const monday = new Date()
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7))
  const weekStart = dayISO(monday)

  const stationPct = approvalByStation(mtd, stations)
  const flags = exceptionFlags(entries, mtd, stations, weekStart)
  const myToday = scoreOver(mine.filter((e) => e.work_date === todayISO()))
  const myThisWeek = scoreOver(mine.filter((e) => e.work_date >= weekStart))

  return (
    <>
      {stationPct.length > 0 && (
        <div className="mob-card">
          <div className="mob-title">Approval completion by station</div>
          <div className="mob-bars">
            {stationPct.map((s) => (
              <div className="mob-barrow" key={s.id}>
                <span className="lbl station">{s.name}</span>
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
        <div className="mob-title">My work done</div>
        <div className="mob-sub">Target 100% approved</div>
        <ScoreMeter label="Today" score={myToday} />
        <ScoreMeter label="This week" score={myThisWeek} />
        <div className="mob-scorekey">
          <span><i className="dot done" />Work done</span>
          <span><i className="dot bad" />Rejected</span>
          <span><i className="dot wait" />Waiting approval</span>
        </div>
      </div>
    </>
  )
}

function MyWorkTab({
  profileId,
  myName,
  tier,
  grades,
  stations,
  jobs,
  rateFor,
  amountFor,
  tier2RateFor,
  myEmail,
  onError,
}: {
  profileId: string | null
  myName: string
  tier: Grade | null
  grades: Grade[]
  stations: Station[]
  jobs: Job[]
  rateFor: (jobId: string) => number
  amountFor: (jobId: string, quantity: number) => number
  tier2RateFor: (jobId: string) => number | null
  myEmail: string
  onError: (m: string | null) => void
}) {
  const [entries, setEntries] = useState<ProductionEntry[]>([])
  // Other people's work waiting on MY action — only loaded for tiers whose
  // tag grants verify or approve.
  const [queue, setQueue] = useState<ProductionEntry[]>([])
  const [names, setNames] = useState<Map<string, string>>(new Map())
  const [photoCount, setPhotoCount] = useState<Map<string, number>>(new Map())
  const [todayPhotos, setTodayPhotos] = useState(0)
  const [viewPhotos, setViewPhotos] = useState<ProductionEntry | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [filter, setFilter] = useState<WorkFilter>('pending')
  const [detail, setDetail] = useState<ProductionEntry | null>(null)

  // Which buttons show is decided by the tag, not the rung: tick verify on
  // a tier and that tier verifies; tick approve and it approves. A tier
  // holding both sees both.
  const caps = effectiveCapabilities(tier)
  // The tiers above the station-head tier read the review here, since
  // their Performance tab is given over to the mill.
  const millWide = tier != null && runsWholeMill(tier.sort_order, stationTierOf(grades))
  const canVerify = caps.includes('verify')
  const canApprove = caps.includes('approve')

  async function load() {
    if (!profileId) return
    const mine = await supabase
      .from('production_entries')
      .select('*')
      .eq('user_id', profileId)
      .order('created_at', { ascending: false })
      .limit(120)
    if (mine.error) onError(mine.error.message)
    const own = (mine.data ?? []) as ProductionEntry[]
    setEntries(own)

    // Never your own work — nobody verifies themselves.
    let waiting: ProductionEntry[] = []
    if (canVerify || canApprove) {
      const { data } = await supabase
        .from('production_entries')
        .select('*')
        .in('approval_status', ['pending', 'verified'])
        .order('created_at', { ascending: true })
      waiting = ((data ?? []) as ProductionEntry[]).filter(
        (e) =>
          e.user_id !== profileId &&
          ((canVerify && e.approval_status === 'pending') ||
            (canApprove && e.approval_status === 'verified')),
      )
      setQueue(waiting)
      const ids = [...new Set(waiting.map((e) => e.user_id).filter(Boolean))] as string[]
      if (ids.length > 0) {
        const { data: p } = await supabase
          .from('access_profiles')
          .select('id, full_name, email')
          .in('id', ids)
        setNames(new Map(((p ?? []) as Profile[]).map((x) => [x.id, profileName(x)])))
      }
    }

    // How many photos back each entry, so a row can say so without opening.
    const entryIds = [...own, ...waiting].map((e) => e.id)
    if (entryIds.length > 0) {
      const { data: ph } = await supabase
        .from('photo_records')
        .select('id, entry_id')
        .in('entry_id', entryIds)
      const m = new Map<string, number>()
      for (const r of ph ?? []) {
        if (r.entry_id) m.set(r.entry_id, (m.get(r.entry_id) ?? 0) + 1)
      }
      setPhotoCount(m)
    }

    // Today's running total of photos this person has taken.
    const start = new Date()
    start.setHours(0, 0, 0, 0)
    const { data: mineToday } = await supabase
      .from('photo_records')
      .select('id')
      .eq('created_by', profileId)
      .gte('taken_at', start.toISOString())
    setTodayPhotos((mineToday ?? []).length)
    setLoading(false)
  }
  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileId])

  // A rejected entry can be fixed and sent back into the approval queue.
  async function fixResubmit(e: ProductionEntry) {
    const raw = window.prompt('Corrected quantity:', String(e.quantity))
    if (raw === null) return
    const qty = Number(raw)
    if (!Number.isFinite(qty) || qty <= 0) return onError('Quantity must be a positive number.')
    setBusy(e.id)
    onError(null)
    const { error } = await supabase
      .from('production_entries')
      .update({
        quantity: qty,
        approval_status: 'pending',
        rejected_reason: null,
        verified_by: null,
        verified_at: null,
        approved_by: null,
        approved_at: null,
      })
      .eq('id', e.id)
    setBusy(null)
    if (error) return onError(error.message)
    load()
  }

  /** Move someone else's entry along the flow, or send it back. */
  async function act(e: ProductionEntry, next: 'verified' | 'approved' | 'rejected') {
    let reason: string | null = null
    if (next === 'rejected') {
      reason = window.prompt('Reason for rejecting (shown to the worker):') ?? null
      if (reason === null) return
    }
    setBusy(e.id)
    onError(null)
    const now = new Date().toISOString()
    const fields: Record<string, unknown> = { approval_status: next }
    if (next === 'verified') Object.assign(fields, { verified_by: myEmail, verified_at: now })
    if (next === 'approved') Object.assign(fields, { approved_by: myEmail, approved_at: now })
    if (next === 'rejected') {
      Object.assign(fields, {
        rejected_reason: reason || null,
        verified_by: null,
        verified_at: null,
        approved_by: null,
        approved_at: null,
      })
    }
    const { error } = await supabase.from('production_entries').update(fields).eq('id', e.id)
    setBusy(null)
    if (error) return onError(error.message)
    load()
  }

  const jobName = (id: string) => jobs.find((j) => j.id === id)?.name ?? 'Work'
  const stationName = (id: string) => stations.find((st) => st.id === id)?.name ?? '?'
  const stat = (e: ProductionEntry) => e.approval_status ?? 'approved'
  // "Pending approval" covers both legs of the flow — waiting for a verify
  // AND verified but waiting for the final approval.
  const inBucket = (e: ProductionEntry, k: WorkFilter) =>
    k === 'pending' ? ['pending', 'verified'].includes(stat(e)) : stat(e) === k
  const count = (k: WorkFilter) => entries.filter((e) => inBucket(e, k)).length
  const shown = entries.filter((e) => inBucket(e, filter))
  // Someone else's work only ever sits in the pending view — once acted on
  // it leaves the queue entirely.
  const queueShown = filter === 'pending' ? queue : []
  const total = shown.reduce((s, e) => s + amountFor(e.job_id, e.quantity), 0)

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

  const emptyText: Record<WorkFilter, string> = {
    pending: 'Nothing waiting for approval right now.',
    approved: 'No approved work yet.',
    rejected: 'Nothing rejected — good work ✅',
  }

  return (
    <>
      <div className="mob-header">
        <span className="mob-brand">MJM</span>
        <TierBadge tier={tier} />
      </div>

      <div className="mob-body">
        <div style={{ padding: '0 0.2rem' }}>
          <div className="mob-role">My work</div>
          <div className="mob-sub">Everything you recorded and where it stands</div>
        </div>

        {millWide && (
          <ReviewSections stations={stations} profileId={profileId} onError={onError} />
        )}

        <div className="mob-queue-chips">
          <button className={filter === 'pending' ? 'on' : ''} onClick={() => setFilter('pending')}>
            Pending ({count('pending')})
          </button>
          <button className={filter === 'approved' ? 'on' : ''} onClick={() => setFilter('approved')}>
            Approved ({count('approved')})
          </button>
          <button className={filter === 'rejected' ? 'on' : ''} onClick={() => setFilter('rejected')}>
            Rejected ({count('rejected')})
          </button>
        </div>

        {loading ? (
          <p className="muted small">Loading…</p>
        ) : (
          <>
            <div className="mob-card">
              <div className="mob-field-label">
                {filter === 'pending' ? 'Waiting for approval' : filter === 'approved' ? 'Approved' : 'Rejected'}
                {' '}· {shown.length} record{shown.length === 1 ? '' : 's'}
              </div>
              <div className="mob-stat">{RM(total)}</div>
              {filter === 'pending' && (
                <div className="mob-sub">{todayPhotos} photo{todayPhotos === 1 ? '' : 's'} taken today</div>
              )}
            </div>

            {shown.length === 0 && queueShown.length === 0 && (
              <div className="mob-card"><div className="mob-sub">{emptyText[filter]}</div></div>
            )}

            {shown.map((e) => (
              <div className="mob-station perf" key={e.id} style={{ cursor: 'default' }}>
                <button type="button" className="mob-plainbtn" onClick={() => setDetail(e)}>
                  <span className="perf-top">
                    <span>{jobName(e.job_id)}</span>
                    <span className="mob-entry-amt">{amountFor(e.job_id, e.quantity).toFixed(2)}</span>
                  </span>
                  <span className="perf-top">
                    <span className="mob-station-meta">
                      {new Date(e.work_date + 'T00:00:00').toLocaleDateString(undefined, { day: '2-digit', month: '2-digit' })}
                      {' · '}{stationName(e.station_id)} · {e.quantity}
                    </span>
                    {statusChip(e.approval_status)}
                  </span>
                </button>
                <span className="perf-top">
                  <PhotoChip n={photoCount.get(e.id) ?? 0} onOpen={() => setViewPhotos(e)} />
                </span>
                {stat(e) === 'rejected' && e.rejected_reason && (
                  <span className="mob-station-meta" style={{ color: '#b91c1c' }}>
                    Rejected: {e.rejected_reason}
                  </span>
                )}
                {stat(e) === 'rejected' && (
                  <button
                    type="button"
                    className="mob-mini"
                    style={{ alignSelf: 'flex-start' }}
                    disabled={busy === e.id}
                    onClick={() => fixResubmit(e)}
                  >
                    ✎ Fix &amp; resubmit
                  </button>
                )}
              </div>
            ))}

            {/* Other people's work that is waiting on me. Which buttons
                appear is the tag's doing, not the rung's. */}
            {queueShown.length > 0 && (
              <div className="mob-card-label" style={{ padding: '0 0.2rem' }}>
                Waiting on you <span className="mob-chip warn">{queueShown.length}</span>
              </div>
            )}
            {queueShown.map((e) => {
              const verifyNow = canVerify && (e.approval_status ?? 'pending') === 'pending'
              const approveNow = canApprove && e.approval_status === 'verified'
              return (
                <div className="mob-station perf" key={e.id} style={{ cursor: 'default' }}>
                  <span className="perf-top">
                    <span>{jobName(e.job_id)}</span>
                    <span className="mob-entry-amt">{amountFor(e.job_id, e.quantity).toFixed(2)}</span>
                  </span>
                  <span className="perf-top">
                    <span className="mob-station-meta">
                      {new Date(e.work_date + 'T00:00:00').toLocaleDateString(undefined, { day: '2-digit', month: '2-digit' })}
                      {' · '}{names.get(e.user_id ?? '') ?? 'Unknown'} · {e.quantity}
                    </span>
                    {statusChip(e.approval_status)}
                  </span>
                  <span className="perf-top">
                    <PhotoChip n={photoCount.get(e.id) ?? 0} onOpen={() => setViewPhotos(e)} />
                  </span>
                  <span className="row-form">
                    {verifyNow && (
                      <button className="mob-btn approve" style={{ flex: 1 }} disabled={busy === e.id}
                        onClick={() => act(e, 'verified')}>✓ Verify</button>
                    )}
                    {approveNow && (
                      <button className="mob-btn approve" style={{ flex: 1 }} disabled={busy === e.id}
                        onClick={() => act(e, 'approved')}>✓ Approve</button>
                    )}
                    <button className="mob-btn reject" style={{ flex: 1 }} disabled={busy === e.id}
                      onClick={() => act(e, 'rejected')}>✗ Reject</button>
                  </span>
                </div>
              )
            })}
          </>
        )}
      </div>

      {viewPhotos && <PhotoSheet entry={viewPhotos} onClose={() => setViewPhotos(null)} />}
    </>
  )
}

/* ------------------------------------------------------------------ */
/* NEW SIGN UP — what the app looks like right after registering,     */
/* before a station head adds the person to a team.                   */
/* ------------------------------------------------------------------ */

function SignupWelcome({ myName }: { myName: string }) {
  return (
    <>
      <div className="mob-header">
        <span className="mob-brand">MJM</span>
      </div>
      <div className="mob-body">
        <div className="mob-card" style={{ alignItems: 'center', textAlign: 'center' }}>
          <span className="signup-check" aria-hidden="true">✓</span>
          <div className="mob-role">Welcome, {myName}!</div>
          <div className="mob-sub">Your account is created.</div>
        </div>

        <div className="mob-card">
          <div className="mob-title">Your starting access</div>
          <div className="mob-row"><span className="mob-field-label">Tag</span><span>Operator (default)</span></div>
          <div className="mob-row"><span className="mob-field-label">Team</span><span>Waiting for a leader</span></div>
          <div className="mob-row"><span className="mob-field-label">Station</span><span>Not assigned yet</span></div>
        </div>

        <div className="mob-card">
          <div className="mob-title">What happens next</div>
          <div className="mob-flow">
            <div className="mob-step">
              <span className="mob-step-dot done" />
              <span>
                <div className="mob-step-name">Account created</div>
                <div className="mob-station-meta">You are on the new sign-up list</div>
              </span>
            </div>
            <div className="mob-step">
              <span className="mob-step-dot" />
              <span>
                <div className="mob-step-name">Your station head adds you to their team</div>
                <div className="mob-station-meta">That assigns your station and leader</div>
              </span>
            </div>
            <div className="mob-step">
              <span className="mob-step-dot" />
              <span>
                <div className="mob-step-name">The app unlocks</div>
                <div className="mob-station-meta">Record work, see your rates and earnings</div>
              </span>
            </div>
          </div>
        </div>

        <div className="mob-sub" style={{ textAlign: 'center' }}>
          Nothing else to do — this screen unlocks by itself once you are added.
        </div>
      </div>
    </>
  )
}

/* ------------------------------------------------------------------ */
/* APPROVALS — a sub-screen of Performance, reached from the "awaiting */
/* review" alert. It is NOT a bottom tab: the tab bar is the same five */
/* buttons for every tier. 'verify' level works the To-verify queue;   */
/* 'approve' level gets both queues. Own submissions are never queued  */
/* back to the person who submitted them.                              */
/* ------------------------------------------------------------------ */

function ApprovalsScreen({
  profileId,
  myEmail,
  level,
  tier,
  stations,
  jobs,
  amountFor,
  onBack,
  onError,
}: {
  profileId: string | null
  myEmail: string
  level: 'verify' | 'approve'
  tier: Grade | null
  stations: Station[]
  jobs: Job[]
  amountFor: (jobId: string, quantity: number) => number
  onBack: () => void
  onError: (m: string | null) => void
}) {
  const [entries, setEntries] = useState<ProductionEntry[]>([])
  const [people, setPeople] = useState<Map<string, string>>(new Map())
  const [queue, setQueue] = useState<'verify' | 'approve'>('verify')
  const [detail, setDetail] = useState<ProductionEntry | null>(null)
  const [loading, setLoading] = useState(true)

  async function load() {
    const [e, p] = await Promise.all([
      supabase
        .from('production_entries')
        .select('*')
        .in('approval_status', ['pending', 'verified'])
        .order('created_at', { ascending: true }),
      supabase.from('access_profiles').select('id, full_name, email'),
    ])
    if (e.error) onError(e.error.message)
    // Never queue someone's own submissions to themselves.
    setEntries(
      ((e.data ?? []) as ProductionEntry[]).filter(
        (x) =>
          x.user_id !== profileId &&
          ['pending', 'verified'].includes(x.approval_status ?? ''),
      ),
    )
    setPeople(
      new Map(
        ((p.data ?? []) as Profile[]).map((x) => [x.id, x.full_name ?? x.email ?? '?']),
      ),
    )
    setLoading(false)
  }
  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileId])

  const jobName = (id: string) => jobs.find((j) => j.id === id)?.name ?? 'Work'
  const stationName = (id: string) => stations.find((s) => s.id === id)?.name ?? '?'
  const submitterName = (e: ProductionEntry) => people.get(e.user_id ?? '') ?? '?'

  const pendingList = entries.filter((e) => e.approval_status === 'pending')
  const verifiedList = entries.filter((e) => e.approval_status === 'verified')
  const list = level === 'approve' && queue === 'approve' ? verifiedList : pendingList

  if (detail) {
    return (
      <ApprovalDetail
        entry={detail}
        submitter={submitterName(detail)}
        level={level}
        myEmail={myEmail}
        tier={tier}
        stations={stations}
        jobs={jobs}
        amountFor={amountFor}
        onBack={() => setDetail(null)}
        onDone={() => {
          setDetail(null)
          load()
        }}
        onError={onError}
      />
    )
  }

  return (
    <>
      <div className="mob-header">
        <button className="mob-back" onClick={onBack}>‹ Performance</button>
        <span className="mob-brand">MJM</span>
        <TierBadge tier={tier} />
      </div>

      <div className="mob-body">
        <div style={{ padding: '0 0.2rem' }}>
          <div className="mob-role">Approvals</div>
          <div className="mob-sub">
            {level === 'approve' ? 'Verification & final approval' : 'Work verification'}
          </div>
        </div>

        {level === 'approve' && (
          <div className="mob-queue-chips">
            <button className={queue === 'verify' ? 'on' : ''} onClick={() => setQueue('verify')}>
              To verify ({pendingList.length})
            </button>
            <button className={queue === 'approve' ? 'on' : ''} onClick={() => setQueue('approve')}>
              To approve ({verifiedList.length})
            </button>
          </div>
        )}

        {loading ? (
          <p className="muted small">Loading…</p>
        ) : list.length === 0 ? (
          <div className="mob-card">
            <div className="mob-sub">Nothing waiting — all caught up ✅</div>
          </div>
        ) : (
          list.map((e) => (
            <button className="mob-station perf" key={e.id} onClick={() => setDetail(e)}>
              <span className="perf-top">
                <span>{submitterName(e)}</span>
                <span className="mob-entry-amt">{amountFor(e.job_id, e.quantity).toFixed(2)}</span>
              </span>
              <span className="perf-top">
                <span className="mob-station-meta">
                  {jobName(e.job_id)} · {stationName(e.station_id)} ·{' '}
                  {new Date(e.work_date + 'T00:00:00').toLocaleDateString(undefined, { day: '2-digit', month: '2-digit' })}
                </span>
                {statusChip(e.approval_status)}
              </span>
            </button>
          ))
        )}
      </div>
    </>
  )
}

/* One entry under review: parameters, photo evidence, then the action. */
function ApprovalDetail({
  entry,
  submitter,
  level,
  myEmail,
  tier,
  stations,
  jobs,
  amountFor,
  onBack,
  onDone,
  onError,
}: {
  entry: ProductionEntry
  submitter: string
  level: 'verify' | 'approve'
  myEmail: string
  tier: Grade | null
  stations: Station[]
  jobs: Job[]
  amountFor: (jobId: string, quantity: number) => number
  onBack: () => void
  onDone: () => void
  onError: (m: string | null) => void
}) {
  const [photos, setPhotos] = useState<PhotoRecord[]>([])
  const [busy, setBusy] = useState(false)

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
  const status = entry.approval_status ?? 'pending'
  const canVerifyNow = status === 'pending'
  const canApproveNow = status === 'verified' && level === 'approve'
  const photoUrl = (path: string | null) =>
    path ? supabase.storage.from('records').getPublicUrl(path).data.publicUrl : null

  async function act(next: 'verified' | 'approved' | 'rejected') {
    let reason: string | null = null
    if (next === 'rejected') {
      reason = window.prompt('Reason for rejecting (shown to the worker):') ?? null
      if (reason === null) return // cancelled
    }
    setBusy(true)
    onError(null)
    const now = new Date().toISOString()
    const fields: Partial<ProductionEntry> & Record<string, unknown> = { approval_status: next }
    if (next === 'verified') {
      fields.verified_by = myEmail
      fields.verified_at = now
    }
    if (next === 'approved') {
      fields.approved_by = myEmail
      fields.approved_at = now
    }
    if (next === 'rejected') fields.rejected_reason = reason || null
    const { error } = await supabase.from('production_entries').update(fields).eq('id', entry.id)
    setBusy(false)
    if (error) return onError(error.message)
    onDone()
  }

  return (
    <>
      <div className="mob-header">
        <button className="mob-back" onClick={onBack}>‹ Approvals</button>
        <span className="mob-brand">MJM</span>
        <TierBadge tier={tier} />
      </div>

      <div className="mob-body">
        <div className="mob-role" style={{ padding: '0 0.2rem' }}>Review work entry</div>

        <div className="mob-card">
          <div className="mob-row">
            <span>
              <div className="mob-entry-name">{submitter}</div>
              <div className="mob-station-meta">
                {job?.name ?? 'Work'} · {station?.name ?? '?'} ·{' '}
                {new Date(entry.work_date + 'T00:00:00').toLocaleDateString(undefined, {
                  day: 'numeric', month: 'long',
                })}
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
              <div className="mob-field-label">Amount</div>
              <div className="mob-param">{RM(total)}</div>
            </div>
          </div>
          {entry.verified_by && (
            <div className="mob-sub">Verified by {entry.verified_by}</div>
          )}
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
          <div className="mob-title">
            {canApproveNow ? 'Final approval' : canVerifyNow ? 'Verification' : 'Review'}
          </div>
          {canVerifyNow && (
            <button className="mob-btn approve" disabled={busy} onClick={() => act('verified')}>
              ✓ Verify this work
            </button>
          )}
          {canApproveNow && (
            <button className="mob-btn approve" disabled={busy} onClick={() => act('approved')}>
              ✓ Approve — final
            </button>
          )}
          {(canVerifyNow || canApproveNow) && (
            <button className="mob-btn reject" disabled={busy} onClick={() => act('rejected')}>
              ✗ Reject…
            </button>
          )}
          {!canVerifyNow && !canApproveNow && (
            <div className="mob-sub">
              Waiting for a final approver — your access level covers verification only.
            </div>
          )}
        </div>
      </div>
    </>
  )
}

/* ------------------------------------------------------------------ */
/* TAB 5 — PROFILE. Same layout for every tier, top to bottom:        */
/*   1  selfie (uploadable), name, tier, station                      */
/*   2  personal details — collapsed until asked for                  */
/*   3  this month's own numbers                                      */
/*   4  the last three months of payslips                             */
/*   5  the piece-rate contract: your tier, then the tiers below      */
/* ------------------------------------------------------------------ */

function ProfileTab({
  profile,
  tier,
  grades,
  stations,
  jobs,
  rateFor,
  amountFor,
  tier2RateFor,
  onError,
}: {
  profile: Profile | null
  tier: Grade | null
  grades: Grade[]
  stations: Station[]
  jobs: Job[]
  rateFor: (jobId: string) => number
  amountFor: (jobId: string, quantity: number) => number
  tier2RateFor: (jobId: string) => number | null
  onError: (m: string | null) => void
}) {
  const [showDetails, setShowDetails] = useState(false)
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState({ employee_code: '', phone: '' })
  // What was just saved, so the card shows the new value without waiting
  // for the whole app's profile to be reloaded.
  const [saved, setSaved] = useState<{ employee_code: string; phone: string } | null>(null)

  /**
   * Your own Worker ID and phone, edited by you. It goes through the same
   * narrow door as the avatar: access_profiles has no "update your own
   * row" policy, and adding one would let anyone rewrite their own tier or
   * salary, so a function that touches these two columns and nothing else
   * does the writing.
   */
  async function saveDetails() {
    if (!profile?.id) return
    setSaving(true)
    onError(null)
    const { error } = await supabase.rpc('set_my_details', {
      code: form.employee_code.trim() || null,
      phone_no: form.phone.trim() || null,
    })
    setSaving(false)
    if (error) {
      return onError(
        /function .*set_my_details.* does not exist/i.test(error.message)
          ? 'Editing your details needs a pending database update — run supabase/setup.sql.'
          : error.message,
      )
    }
    setSaved({ employee_code: form.employee_code.trim(), phone: form.phone.trim() })
    setEditing(false)
  }

  const myName = profileName(profile)

  const myStationIds =
    profile?.station_ids && profile.station_ids.length > 0
      ? profile.station_ids
      : profile?.station_id
        ? [profile.station_id]
        : []
  /**
   * Above station level nobody is paid by the piece: no month of piece
   * work, no payslip built from it, no rate contract to read. Those
   * sections belong to the station head's rung and below, found by
   * counting the rungs beneath the tier rather than naming one — the same
   * test the Team tab and the entry form use.
   */
  const rungsBelow = tier
    ? grades.filter((g) => g.sort_order > tier.sort_order && g.sort_order > 1).length
    : 0
  const isPaidByPiece = tier != null && rungsBelow <= 2

  const stationNames =
    !isPaidByPiece || myStationIds.length === 0
      ? 'All Stations'
      : myStationIds.map((id) => stations.find((s) => s.id === id)?.name ?? '?').join(', ')


  return (
    <>
      <div className="mob-header">
        <span className="mob-brand">MJM</span>
        <TierBadge tier={tier} />
      </div>

      <div className="mob-body">
        {/* 1 — who you are. */}
        <div className="mob-card" style={{ alignItems: 'center', textAlign: 'center' }}>
          <AvatarPicker profile={profile} myName={myName} onError={onError} />
          <div className="mob-role">{myName}</div>
          <div className="mob-sub">{tier?.name ?? '—'}</div>
          <div className="mob-chart-station">{stationNames}</div>
        </div>

        {/* 2 — everything else about you, out of the way until asked for. */}
        <div className="mob-card">
          <div className="mob-disclosure-row">
            <button
              className="mob-disclosure"
              aria-expanded={showDetails}
              onClick={() => setShowDetails((v) => !v)}
            >
              <span className="mob-card-label">My details</span>
              <span className={`mob-caret ${showDetails ? 'open' : ''}`} aria-hidden="true">›</span>
            </button>
            {showDetails && !editing && (
              <button
                className="mob-icon-btn corner"
                onClick={() => {
                  setForm({
                    employee_code: saved?.employee_code ?? profile?.employee_code ?? '',
                    phone: saved?.phone ?? profile?.phone ?? '',
                  })
                  setEditing(true)
                }}
                title="Edit my details"
                aria-label="Edit my details"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                  strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 20h9" />
                  <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
                </svg>
              </button>
            )}
          </div>
          {/* Editing keeps the very same rows — label left, value right —
              so turning it on swaps a value for a field and changes
              nothing else about the card's shape. */}
          {showDetails && (
            <>
              <div className="mob-row">
                <span className="mob-field-label">Worker ID</span>
                {editing ? (
                  <input
                    className="mob-row-input"
                    value={form.employee_code}
                    onChange={(e) => setForm({ ...form, employee_code: e.target.value })}
                  />
                ) : (
                  <span>{saved?.employee_code || profile?.employee_code || '—'}</span>
                )}
              </div>
              <div className="mob-row">
                <span className="mob-field-label">Email</span>
                <span>{profile?.email ?? '—'}</span>
              </div>
              <div className="mob-row">
                <span className="mob-field-label">Phone number</span>
                {editing ? (
                  <input
                    className="mob-row-input"
                    type="tel"
                    value={form.phone}
                    onChange={(e) => setForm({ ...form, phone: e.target.value })}
                  />
                ) : (
                  <span>{saved?.phone || profile?.phone || '—'}</span>
                )}
              </div>
              {editing && (
                <div className="mob-actions">
                  <button className="mob-mini ghost" onClick={() => setEditing(false)}>Cancel</button>
                  <button className="mob-mini go" disabled={saving} onClick={saveDetails}>
                    {saving ? 'Saving…' : 'Save'}
                  </button>
                </div>
              )}
            </>
          )}
        </div>

        {/* 3, 4, 5 — this month, the payslips it feeds, and the rates
            behind both. All three are about being paid by the piece, so
            they are absent for the tiers that are not. */}
        {isPaidByPiece && (
          <>
            <MyNumbersSection profileId={profile?.id ?? null} amountFor={amountFor} />
            <PayslipSection profile={profile} />
            <ContractSection
              tier={tier}
              grades={grades}
              jobs={jobs}
              stations={stations}
              myStationIds={myStationIds}
              rateFor={rateFor}
              tier2RateFor={tier2RateFor}
            />
          </>
        )}
      </div>
    </>
  )
}

/* ------------------------------------------------------------------ */
/* The selfie. The photo goes into the same public `records` bucket as  */
/* the work photos; the path is written back through set_my_avatar(),   */
/* which is the ONE column a person may change on their own row. Until  */
/* that migration is applied the initials stand in and the camera says  */
/* why it cannot save.                                                  */
/* ------------------------------------------------------------------ */

function AvatarPicker({
  profile,
  myName,
  onError,
}: {
  profile: Profile | null
  myName: string
  onError: (m: string | null) => void
}) {
  const [path, setPath] = useState<string | null>(null)
  const [ready, setReady] = useState(false)
  const [uploading, setUploading] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  // Read the stored path straight from the row rather than trusting the
  // cached auth profile — this tab remounts on every visit, so a photo
  // taken a moment ago is already there.
  useEffect(() => {
    if (!profile?.id) return
    let cancelled = false
    supabase
      .from('access_profiles')
      .select('avatar_path')
      .eq('id', profile.id)
      .maybeSingle()
      .then(({ data, error }) => {
        if (cancelled) return
        setReady(!error)
        setPath((data as { avatar_path?: string | null } | null)?.avatar_path ?? null)
      })
    return () => {
      cancelled = true
    }
  }, [profile?.id])

  const initials = myName.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase()
  const url = path ? supabase.storage.from('records').getPublicUrl(path).data.publicUrl : null

  async function handleFile(file: File | undefined) {
    if (!file || !profile?.id) return
    setUploading(true)
    onError(null)
    try {
      const photo = await compressImage(file)
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const next = `avatars/${profile.id}-${stamp}.jpg`
      const { error: upErr } = await supabase.storage
        .from('records')
        .upload(next, photo, { contentType: 'image/jpeg' })
      if (upErr) throw new Error(upErr.message)
      const { error: rpcErr } = await supabase.rpc('set_my_avatar', { path: next })
      if (rpcErr) throw new Error(`Photo uploaded but not saved: ${rpcErr.message}`)
      setPath(next)
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err))
    } finally {
      setUploading(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  return (
    <>
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        capture="user"
        style={{ display: 'none' }}
        onChange={(e) => handleFile(e.target.files?.[0])}
      />
      <button
        className="mob-avatar-btn"
        disabled={uploading || !profile?.id}
        onClick={() => fileRef.current?.click()}
        aria-label={path ? 'Change your photo' : 'Add your photo'}
      >
        {url ? (
          <img className="mob-avatar-img" src={url} alt="" />
        ) : (
          <span className="mob-avatar-initials">{initials}</span>
        )}
        <span className="mob-avatar-cam" aria-hidden="true">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 8h3.2l1.6-2.4h8.4L18.8 8H21v11H3z" />
            <circle cx="12" cy="13" r="3.4" />
          </svg>
        </span>
      </button>
      {/* Only speak up when there is something to say — the camera badge
          already reads as "tap me", so a caption in the quiet case just
          pushes the name away from the face. */}
      {(uploading || !ready) && (
        <div className="mob-sub">
          {uploading ? 'Saving photo…' : 'Photo needs a pending database update.'}
        </div>
      )}
    </>
  )
}

/* ------------------------------------------------------------------ */
/* This month's own numbers — the same four the Performance tab keeps, */
/* here because "how did I do" is a question about yourself.           */
/* ------------------------------------------------------------------ */

function MyNumbersSection({
  profileId,
  amountFor,
}: {
  profileId: string | null
  amountFor: (jobId: string, quantity: number) => number
}) {
  const [entries, setEntries] = useState<ProductionEntry[]>([])

  useEffect(() => {
    if (!profileId) return
    const from = new Date()
    from.setDate(from.getDate() - 40) // this month, plus a little carry-over
    supabase
      .from('production_entries')
      .select('*')
      .eq('user_id', profileId)
      .gte('work_date', dayISO(from))
      .then(({ data }) => setEntries(data ?? []))
  }, [profileId])

  const monthStart = todayISO().slice(0, 8) + '01'
  const paid = entries.filter((e) => e.work_date >= monthStart && e.approval_status !== 'rejected')
  const total = paid.reduce((s, e) => s + amountFor(e.job_id, e.quantity), 0)
  const days = new Set(paid.map((e) => e.work_date)).size
  const avg = days > 0 ? total / days : 0
  const waiting = entries.filter((e) =>
    ['pending', 'verified'].includes(e.approval_status ?? ''),
  ).length

  return (
    <>
      <div className="mob-card-label" style={{ padding: '0 0.2rem' }}>
        This month
      </div>
      <div className="mob-grid2">
        <div className="mob-card">
          <div className="mob-field-label">Earned</div>
          <div className="mob-stat">{RM(total)}</div>
        </div>
        <div className="mob-card">
          <div className="mob-field-label">Days worked</div>
          <div className="mob-stat">{days}</div>
        </div>
      </div>
      <div className="mob-grid2">
        <div className="mob-card">
          <div className="mob-field-label">Avg / day</div>
          <div className="mob-stat">{RM(avg)}</div>
        </div>
        <div className="mob-card">
          <div className="mob-field-label">Pending approval</div>
          <div className="mob-stat">{waiting}</div>
        </div>
      </div>
    </>
  )
}

/* ------------------------------------------------------------------ */
/* PIECE-RATE CONTRACT: what each job pays, YOUR tier first and then   */
/* every tier below it, so a leader can see what the people under them */
/* earn. Scoped to your own station(s), approved rates only.           */
/* ------------------------------------------------------------------ */

function ContractSection({
  tier,
  grades,
  jobs,
  stations,
  myStationIds,
  rateFor,
  tier2RateFor,
}: {
  tier: Grade | null
  grades: Grade[]
  jobs: Job[]
  stations: Station[]
  myStationIds: string[]
  rateFor: (jobId: string) => number
  tier2RateFor: (jobId: string) => number | null
}) {
  const scoped =
    myStationIds.length === 0 ? jobs : jobs.filter((j) => myStationIds.includes(j.station_id))
  const approved = scoped.filter((j) => j.approval_status === 'approved')
  const stationName = (id: string) => stations.find((s) => s.id === id)?.name ?? '?'
  const manyStations = myStationIds.length !== 1

  // Your tier, then everything below it — a tier ABOVE yours is not part
  // of your contract and is not shown.
  const shownTiers = tier
    ? grades.filter((g) => g.sort_order >= tier.sort_order).sort((a, b) => a.sort_order - b.sort_order)
    : []
  // A job with no tier tag is open to anyone, so it belongs to no single
  // rung — it gets its own group at the end.
  const untagged = approved.filter((j) => !j.grade_id)

  // Your own rung is always listed, with or without rates on it — "no
  // contract yet" is an answer, and leaving the heading out entirely made
  // the rungs below look like yours.
  const groups = shownTiers
    .map((g) => ({ grade: g, rows: approved.filter((j) => j.grade_id === g.id) }))
    .filter((x) => x.rows.length > 0 || x.grade.id === tier?.id)

  /**
   * One job's terms, spelled out. A tiered rate is two different prices
   * depending on how much is done inside the hour, so it is written as the
   * two conditions it is rather than squeezed into one arrow.
   */
  const JobRow = ({ job }: { job: Job }) => {
    const unit = job.unit.replace('/', '')
    const tier2 = tier2RateFor(job.id)
    return (
      <div className="mob-contract-job">
        <div className="mob-contract-name">
          <span className="mob-person-name">{job.name}</span>
          {manyStations && <span className="mob-station-meta">{stationName(job.station_id)}</span>}
        </div>
        {tier2 == null ? (
          <div className="mob-contract-term">
            <span>Every {unit}</span>
            <span className="mob-entry-amt">{RM(rateFor(job.id))}{job.unit}</span>
          </div>
        ) : (
          <>
            <div className="mob-contract-term">
              <span>First {TIER1_UNIT_CAP} {unit}s in an hour</span>
              <span className="mob-entry-amt">{RM(rateFor(job.id))}{job.unit}</span>
            </div>
            <div className="mob-contract-term">
              <span>{TIER1_UNIT_CAP + 1}th onward, same hour</span>
              <span className="mob-entry-amt">{RM(tier2)}{job.unit}</span>
            </div>
            <div className="mob-contract-note">Counts back to the first rate each new hour.</div>
          </>
        )}
      </div>
    )
  }

  return (
    <div className="mob-card">
      <div className="mob-card-label">Piece rate contract</div>
      {groups.length === 0 && untagged.length === 0 && (
        <div className="mob-sub">No approved piece rate at your station yet.</div>
      )}
      {groups.map(({ grade, rows }) => (
        <div key={grade.id}>
          <div className="mob-contract-tier">
            <span className={`tag-dot dot-${grade.color}`} aria-hidden="true" />
            <span>{grade.name}</span>
            {tier?.id === grade.id && <span className="mob-chip ok">You</span>}
          </div>
          {rows.length === 0 ? (
            <div className="mob-sub">No piece rate set for this tier yet.</div>
          ) : (
            rows.map((j) => <JobRow key={j.id} job={j} />)
          )}
        </div>
      ))}
      {untagged.length > 0 && (
        <div>
          <div className="mob-contract-tier">
            <span className="tag-dot dot-grey" aria-hidden="true" />
            <span>Any tier</span>
          </div>
          {untagged.map((j) => <JobRow key={j.id} job={j} />)}
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* MY PAYSLIP: the last three FINALIZED payrolls, newest first — one   */
/* row per month showing what was earned, opening onto the basic       */
/* salary, piece-work lines and adjustments behind it. RLS only lets   */
/* people see their own lines, so this is safe for every tier.         */
/* ------------------------------------------------------------------ */

const PAYSLIP_MONTHS = 3

function PayslipSection({ profile }: { profile: Profile | null }) {
  const [runs, setRuns] = useState<PayrollRun[]>([])
  const [lines, setLines] = useState<PayrollLine[]>([])
  const [adjs, setAdjs] = useState<PayrollAdjustment[]>([])
  const [jobNames, setJobNames] = useState<Map<string, string>>(new Map())
  const [open, setOpen] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!profile?.id) return
    ;(async () => {
      const [{ data: runRows }, { data: l }, { data: a }] = await Promise.all([
        supabase
          .from('payroll_runs')
          .select('id, period_start, period_end, status, created_at, finalized_at')
          .eq('status', 'finalized')
          .order('period_end', { ascending: false })
          .limit(12),
        supabase.from('payroll_lines').select('*').eq('user_id', profile.id),
        supabase.from('payroll_adjustments').select('*').eq('user_id', profile.id),
      ])
      const finalized = (runRows ?? []) as PayrollRun[]
      // A run is "mine" when it carries my lines or adjustments. Someone on
      // a flat basic salary has neither, so for them every finalized run
      // still counts — that salary is what they were paid.
      const hasMine = (r: PayrollRun) =>
        (l ?? []).some((x) => x.run_id === r.id) || (a ?? []).some((x) => x.run_id === r.id)
      const onBasic = Number(profile.basic_salary ?? 0) > 0
      const mine = finalized.filter((r) => hasMine(r) || onBasic).slice(0, PAYSLIP_MONTHS)
      setRuns(mine)
      setOpen(mine[0]?.id ?? null) // the newest opens on arrival
      setLines((l ?? []) as PayrollLine[])
      setAdjs((a ?? []) as PayrollAdjustment[])
      const jobIds = [...new Set((l ?? []).map((x) => x.job_id))]
      if (jobIds.length > 0) {
        const { data: j } = await supabase.from('jobs').select('id, name').in('id', jobIds)
        setJobNames(new Map((j ?? []).map((x) => [x.id as string, x.name as string])))
      }
      setLoading(false)
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile?.id])

  const basic = Number(profile?.basic_salary ?? 0)
  const linesOf = (runId: string) => lines.filter((x) => x.run_id === runId)
  const adjsOf = (runId: string) => adjs.filter((x) => x.run_id === runId)
  const totalOf = (runId: string) =>
    basic +
    linesOf(runId).reduce((s, x) => s + Number(x.amount), 0) +
    adjsOf(runId).reduce((s, x) => s + Number(x.amount), 0)
  // A payroll period is named by the month it ends in.
  const monthOf = (r: PayrollRun) =>
    new Date(r.period_end + 'T00:00:00').toLocaleDateString(undefined, {
      month: 'long',
      year: 'numeric',
    })

  return (
    <div className="mob-card">
      <div className="mob-card-label">Payslip</div>
      {loading ? (
        <div className="mob-sub">Loading…</div>
      ) : runs.length === 0 ? (
        <div className="mob-sub">No finalized payroll yet.</div>
      ) : (
        runs.map((r) => {
          const isOpen = open === r.id
          return (
            <div className="mob-payslip" key={r.id}>
              <button
                className="mob-disclosure"
                aria-expanded={isOpen}
                onClick={() => setOpen(isOpen ? null : r.id)}
              >
                <span>
                  <span className="mob-entry-name">{monthOf(r)}</span>
                  <span className="mob-station-meta" style={{ display: 'block' }}>
                    {r.period_start} → {r.period_end}
                  </span>
                </span>
                <span className="mob-entry-side">
                  <span className="mob-entry-amt">{RM(totalOf(r.id))}</span>
                  <span className={`mob-caret ${isOpen ? 'open' : ''}`} aria-hidden="true">›</span>
                </span>
              </button>
              {isOpen && (
                <>
                  {basic > 0 && (
                    <div className="mob-breakrow">
                      <span>Basic salary (monthly)</span>
                      <span>{basic.toFixed(2)}</span>
                    </div>
                  )}
                  {linesOf(r.id).map((x) => (
                    <div className="mob-breakrow" key={x.id}>
                      <span>
                        {jobNames.get(x.job_id) ?? 'Piece work'} × {Number(x.quantity)}
                      </span>
                      <span>{Number(x.amount).toFixed(2)}</span>
                    </div>
                  ))}
                  {adjsOf(r.id).map((x) => (
                    <div className="mob-breakrow" key={x.id}>
                      <span>Adjustment — {x.reason}</span>
                      <span>{Number(x.amount).toFixed(2)}</span>
                    </div>
                  ))}
                  <div className="mob-breakrow total">
                    <span>Total pay</span>
                    <span>{RM(totalOf(r.id))}</span>
                  </div>
                </>
              )}
            </div>
          )
        })
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* TAB 4 — TEAM                                                        */
/*                                                                     */
/* 1. Pending Allocation — name only, one icon to pull them into your  */
/*    team, keeping the tier they signed up on.                        */
/* 2. My Team — the chart for YOUR station and team. It starts one     */
/*    rung under the admin tier and walks down to you: name and tier,  */
/*    nothing else, since every rung is your own station anyway.       */
/* 3. Team members — one lane per tier. Drag a member onto the lane    */
/*    matches what they actually do. A leader may hand out any tier    */
/*    BELOW their own; their own tier and anything above it is locked, */
/*    and dropping there explains the ceiling instead of failing       */
/*    silently.                                                        */
/*                                                                     */
/* Every rule here is read off sort_order, never off a tier's NAME —   */
/* add or rename a tier in Tags management and these screens follow it */
/* with no code change.                                                */
/* ------------------------------------------------------------------ */



function TeamTab({
  profile,
  tier,
  grades,
  stations,
}: {
  profile: Profile | null
  tier: Grade | null
  grades: Grade[]
  stations: Station[]
}) {
  const [people, setPeople] = useState<Profile[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // The "you can only set tier up to …" pop-out.
  const [notice, setNotice] = useState<string | null>(null)
  // The sign up waiting on a yes/no before they are pulled into the team.
  const [confirmAdd, setConfirmAdd] = useState<Profile | null>(null)
  // A team being named. It exists only on screen until Save writes it.
  const [draftName, setDraftName] = useState<string | null>(null)
  // Which lane the "Add name" popup is filling: its tier and its team.
  const [adding, setAdding] = useState<{ grade: Grade; teamId: string | null } | null>(null)
  const [teams, setTeams] = useState<Team[]>([])
  // Above station level you cover several stations, so the tab opens on the
  // list of them and one is picked to look at.
  const [pickedStation, setPickedStation] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  // Moving is a MODE, entered from the move button beside +. Inside it a
  // name drags straight away and nothing is written until Save, so a
  // reshuffle is one decision rather than a write per drag.
  const [moveMode, setMoveMode] = useState(false)
  const [staged, setStaged] = useState<Map<string, { gradeId: string; teamId: string | null }>>(new Map())
  const [overGrade, setOverGrade] = useState<string | null>(null)

  async function load() {
    const [p, t] = await Promise.all([
      supabase.from('access_profiles').select('*'),
      supabase.from('teams').select('*').order('sort_order'),
    ])
    if (p.error) setError(p.error.message)
    else setPeople((p.data ?? []) as Profile[])
    // A missing teams table is not fatal — the board just has no columns
    // until setup.sql has been run.
    setTeams((t.data ?? []) as Team[])
    setLoading(false)
  }
  useEffect(() => {
    load()
  }, [])

  const stationLabel = (p: Profile | null) => {
    if (!p) return '—'
    const ids = p.station_ids && p.station_ids.length > 0
      ? p.station_ids
      : p.station_id ? [p.station_id] : []
    if (ids.length === 0) return 'All stations'
    return ids.map((id) => stations.find((st) => st.id === id)?.name ?? '?').join(', ')
  }

  // The real reporting chain (supervisor → their supervisor → …), keyed by
  // the tier each person holds, so a rung of the chart can carry the actual
  // name instead of just a tier label. Capped so a bad supervisor loop in
  // the data can never spin forever.
  const chainByGrade = new Map<string, Profile>()
  {
    let cursor = profile?.supervisor_id ?? null
    const seen = new Set<string>()
    while (cursor && !seen.has(cursor) && seen.size < grades.length + 2) {
      seen.add(cursor)
      const person: Profile | undefined = people.find((p) => p.id === cursor)
      if (!person) break
      if (person.grade_id && !chainByGrade.has(person.grade_id)) chainByGrade.set(person.grade_id, person)
      cursor = person.supervisor_id ?? null
    }
  }

  // Exactly one confirmed person holds this tier → they ARE the upper, even
  // when nobody has wired up a supervisor link yet.
  function holderOf(g: Grade): Profile | null {
    const fromChain = chainByGrade.get(g.id)
    if (fromChain) return fromChain
    const holders = people.filter((p) => p.grade_id === g.id && p.tags_confirmed)
    return holders.length === 1 ? holders[0] : null
  }

  // A tier that ADMINISTERS the system is not a rung of an operating team,
  // so it never appears on this tab at all — not above you, not as a lane,
  // not as somewhere a person can be put. Two things mark one: the super
  // admin rung, and holding "change other users' settings", which the tag
  // editor only ever hands to management-level tags.
  const isAdminTier = (g: Grade) =>
    g.sort_order === ADMIN_TIER_ORDER ||
    (g.capabilities ?? []).includes('user-access') ||
    ADMIN_TIER_NAMES.test(g.name.trim())
  const operatingTiers = grades
    .filter((g) => !isAdminTier(g))
    .sort((a, b) => a.sort_order - b.sort_order)

  // Tier 1 is the highest, so "up" means a SMALLER sort_order.
  const upperTiers = tier
    ? operatingTiers
        .filter((g) => g.sort_order < tier.sort_order)
        .sort((a, b) => b.sort_order - a.sort_order) // nearest upper first
    : []
  // Below you — the rungs your own people sit on, and the only ones that
  // can take a drop.
  const lowerTiers = tier ? operatingTiers.filter((g) => g.sort_order > tier.sort_order) : []

  const bottomTier = Math.max(0, ...grades.map((g) => g.sort_order))
  // Who may work a team is a SETTING, not a position on the ladder. Sitting
  // above the bottom tier no longer implies it — the tag has to grant
  // "Claim Sign Ups & Set Tier" (Settings → Tags management). Everyone
  // still sees the chart; only the two working sections are gated.
  const canManageTeam = effectiveCapabilities(tier).includes('team-assign')

  // The highest tier this leader may hand out — exactly one rung below their
  // own. Everything at or above their own tier is off limits.
  const nextBelow = tier
    ? grades
        .filter((g) => g.sort_order > tier.sort_order)
        .sort((a, b) => a.sort_order - b.sort_order)[0] ?? null
    : null
  const mayAssign = (g: Grade) => tier != null && g.sort_order > tier.sort_order

  const pending = people.filter((p) => !p.tags_confirmed)
  const myTeam = people.filter((p) => p.supervisor_id === profile?.id)

  // The chart is scoped to one station and one team, so both are named
  // once at the top instead of on every rung. A member with no team of
  // their own inherits the label from the leader they report to.
  const myStationName = stationLabel(profile)
  const myStationIds =
    profile?.station_ids && profile.station_ids.length > 0
      ? profile.station_ids
      : profile?.station_id ? [profile.station_id] : []
  const myLeader = profile?.supervisor_id
    ? people.find((p) => p.id === profile.supervisor_id) ?? null
    : null
  const NO_TEAM_NAME = 'No team name is assigned'
  const myTeamName = profile?.team_name ?? myLeader?.team_name ?? NO_TEAM_NAME

  /**
   * A Station Head does not supervise a flat list — they run TEAMS, one per
   * person on the rung directly under them, each of those leading their own
   * people further down. So when there is more than one rung below, the
   * board splits into a column per team that swipes sideways: the team
   * name, its leader, then that leader's people.
   *
   * With only one rung below (nothing can lead anything) it stays a plain
   * set of lanes. All read off position — no tier is named in code.
   */
  /**
   * A station's shape is a property of the STATION, not of whoever happens
   * to be looking at it: the rung that heads it, the rung that leads its
   * teams, and the rungs those teams are made of. Reading it off the
   * viewer's own position was wrong — it put a Manager rung and an
   * Executive rung inside a station's board when management looked at one.
   *
   * The rung that owns a station is the highest operating one with anyone
   * actually tagged to a station: heads, their leaders and their people
   * carry station tags; the tiers above cover the floor rather than stand
   * on it, so they do not. Falling back to two rungs above the bottom
   * keeps the shape sensible on an empty database.
   */
  const taggedOrders = people
    .filter((p) => (p.station_ids?.length ?? 0) > 0 || p.station_id)
    .map((p) => grades.find((g) => g.id === p.grade_id)?.sort_order)
    .filter((n): n is number => n != null && operatingTiers.some((g) => g.sort_order === n))
  const stationTierOrder =
    taggedOrders.length > 0
      ? Math.min(...taggedOrders)
      : operatingTiers[Math.max(0, operatingTiers.length - 3)]?.sort_order ??
        operatingTiers[0]?.sort_order ??
        0
  const stationTier = operatingTiers.find((g) => g.sort_order === stationTierOrder) ?? null
  // Above the rung that owns a station you oversee stations rather than
  // work in one, so the tab is the list of them and a board only opens
  // when one is picked.
  const hasHeadRow = tier != null && tier.sort_order < stationTierOrder
  const headTier = hasHeadRow ? stationTier : null
  const belowStationTier = operatingTiers.filter((g) => g.sort_order > stationTierOrder)
  const teamLeaderTier = hasHeadRow ? belowStationTier[0] ?? null : lowerTiers[0] ?? null
  // Running teams is a grant too — the same tag setting that allows making
  // one. Without it the board is the flat set of lanes.
  const canCreateTeam = effectiveCapabilities(tier).includes('team-create')
  // Seeing the team structure is not the same as changing it — only the
  // + button and the moves are gated.
  const runsTeams = lowerTiers.length > 1 && teamLeaderTier != null

  // The stations this person covers. With exactly one you go straight to
  // its board; with several the tab opens on the list.
  const myStations =
    myStationIds.length > 0 ? stations.filter((st) => myStationIds.includes(st.id)) : stations
  const activeStation =
    myStations.length === 1
      ? myStations[0]
      : myStations.find((st) => st.id === pickedStation) ?? null
  const atStation = (p: Profile) => {
    if (!activeStation) return false
    const ids = p.station_ids && p.station_ids.length > 0
      ? p.station_ids
      : p.station_id ? [p.station_id] : []
    return ids.includes(activeStation.id)
  }
  // Whoever heads the station being looked at — only shown when that is
  // somebody other than the reader.
  /** Where a person sits once the staged moves are taken into account. */
  const placedGrade = (p: Profile) => staged.get(p.id)?.gradeId ?? p.grade_id

  const stationHeads =
    stationTier && activeStation
      ? people.filter((p) => atStation(p) && placedGrade(p) === stationTier.id)
      : []

  // Every rung from the team leader down shows in every column, empty or
  // not, so there is always somewhere to put the next person.
  const memberTiers = teamLeaderTier
    ? lowerTiers.filter((g) => g.sort_order >= teamLeaderTier.sort_order)
    : lowerTiers

  // Teams are real rows now, so a team exists the moment it is named —
  // before anybody is in it.
  const myTeams = teams
    .filter((t) => (activeStation ? t.station_id === activeStation.id : false))
    .sort((x, y) => x.sort_order - y.sort_order)
  const teamColumns = runsTeams
    ? myTeams.map((t) => ({
        key: t.id,
        team: t,
        name: t.name || NO_TEAM_NAME,
        members: people.filter((p) => p.team_id === t.id && atStation(p)),
      }))
    : []
  /**
   * Everyone at the station in view who sits on a rung below the reader.
   * This is what "my people" means on a shared floor: the station and the
   * rung place somebody, not a single supervisor field.
   */
  const stationPeople = people.filter((p) => {
    if (!atStation(p)) return false
    const order = grades.find((g) => g.id === placedGrade(p))?.sort_order
    return order != null && tier != null && order > tier.sort_order
  })

  // At this station, under me, and in no team — a freshly claimed sign up,
  // most often.
  const looseMembers = runsTeams
    ? people.filter((p) => {
        if (p.team_id || !atStation(p)) return false
        const order = grades.find((g) => g.id === p.grade_id)?.sort_order
        // Only the rungs a team is actually made of — a station head with
        // no team is not "loose", they head the station.
        return order != null && memberTiers.some((g) => g.sort_order === order)
      })
    : myTeam
  // Every rung from the team leader down shows in every column, empty or
  // not, so there is always somewhere to put the next person.
  /**
   * Pull a new sign up into my team. They keep the tier they signed up on,
   * which is already the lowest one — the leader then drags them up to what
   * they actually do. Only if that tier is somehow NOT below the leader
   * (a hand-edited row, a tier inserted since) do they drop to the bottom
   * rung, so the board can always move them.
   */
  async function claim(p: Profile) {
    if (!profile) return
    const signupGrade = grades.find((g) => g.id === p.grade_id) ?? null
    const placeable = signupGrade != null && mayAssign(signupGrade)
    const floor = grades.find((g) => g.sort_order === bottomTier) ?? null
    setBusy(p.id)
    setError(null)
    const { error: err } = await supabase
      .from('access_profiles')
      .update({
        supervisor_id: profile.id,
        grade_id: placeable ? p.grade_id : floor?.id ?? p.grade_id,
        station_ids: profile.station_ids ?? [],
        station_id: profile.station_ids?.[0] ?? profile.station_id ?? null,
        tags_confirmed: true,
      })
      .eq('id', p.id)
    setBusy(null)
    if (err) return setError(err.message)
    load()
  }

  /**
   * Move a team member onto another tier. When the drop lands inside a team
   * column, they also join that team — the column IS the team, so dropping
   * into it and not joining it would be a lie.
   */
  /** Put a claimed sign up straight onto the rung that asked for them. */
  async function addToLane(p: Profile) {
    if (!adding || !profile) return
    const target = adding
    setAdding(null)
    const team = target.teamId ? myTeams.find((t) => t.id === target.teamId) ?? null : null
    setBusy(p.id)
    setError(null)
    const { error: err } = await supabase
      .from('access_profiles')
      .update({
        supervisor_id: profile.id,
        grade_id: target.grade.id,
        team_id: team?.id ?? null,
        // The station being looked at, not the reader's own — above
        // station level those are not the same place.
        station_ids: activeStation ? [activeStation.id] : profile.station_ids ?? [],
        station_id: activeStation?.id ?? profile.station_ids?.[0] ?? profile.station_id ?? null,
        tags_confirmed: true,
      })
      .eq('id', p.id)
    setBusy(null)
    if (err) return setError(err.message)
    load()
  }

  /** Step the team scroller one column left or right. */
  function stepTeams(dir: -1 | 1) {
    const el = scrollRef.current
    if (!el) return
    const col = el.querySelector('.mob-teamcol') as HTMLElement | null
    const step = col ? col.offsetWidth + 8 : el.clientWidth
    el.scrollBy({ left: dir * step, behavior: 'smooth' })
  }

  // A drop target is identified by tier AND, inside a team column, by the
  // team it belongs to — the same tier appears once per column.
  const dropKey = (g: Grade, teamId?: string | null) => `${teamId ?? 'self'}:${g.id}`

  /**
   * A team is written only when it is named and saved — the column does not
   * exist until then. It is created ON the rung that leads it, at the
   * station being looked at.
   */
  async function saveTeam() {
    const name = (draftName ?? '').trim()
    if (!name || !teamLeaderTier) return
    const clash = myTeams.some((t) => t.name.trim().toLowerCase() === name.toLowerCase())
    if (clash) return setError(`This station already has a team called "${name}".`)
    setBusy('new-team')
    setError(null)
    const { error: err } = await supabase.from('teams').insert({
      name,
      grade_id: teamLeaderTier.id,
      station_id: activeStation?.id ?? myStationIds[0] ?? null,
      created_by: profile?.id ?? null,
      sort_order: myTeams.length,
    })
    setBusy(null)
    if (err) {
      return setError(
        /relation .*teams.* does not exist/i.test(err.message)
          ? 'The teams table is not set up yet — run supabase/setup.sql.'
          : err.message,
      )
    }
    setDraftName(null)
    load()
  }

  /** Write every staged move in one go, then leave the mode. */
  async function saveMoves() {
    if (staged.size === 0) return
    setBusy('save-moves')
    setError(null)
    for (const [id, to] of staged) {
      const { error: err } = await supabase
        .from('access_profiles')
        .update({ grade_id: to.gradeId, team_id: to.teamId })
        .eq('id', id)
      if (err) {
        setBusy(null)
        return setError(err.message)
      }
    }
    setBusy(null)
    setStaged(new Map())
    setMoveMode(false)
    load()
  }


  function dropOn(g: Grade, team?: Team | null) {
    // The dragged person may report to me OR sit in one of my teams, so
    // look across everyone I can reach, not just my direct reports.
    const reachable = people.filter(
      (p) => p.supervisor_id === profile?.id || myTeams.some((t) => t.id === p.team_id),
    )
    const person = reachable.find((p) => p.id === dragId)
    setDragId(null)
    setOverGrade(null)
    if (!person) return
    if (!mayAssign(g)) {
      setNotice(
        nextBelow
          ? `You can only set a tier up to ${nextBelow.name}. Tier above requires a higher permission to do so.`
          : `There is no tier below ${tier?.name ?? 'yours'}. Tier above requires a higher permission to do so.`,
      )
      return
    }
    // Nothing is written mid-reshuffle — the move is remembered and shown,
    // and Save commits the lot.
    setStaged((prev) => {
      const next = new Map(prev)
      next.set(person.id, {
        gradeId: g.id,
        teamId: team === undefined ? person.team_id ?? null : team?.id ?? null,
      })
      return next
    })
  }

  /**
   * One rung inside the board: the tier's name, then the people on it.
   * `leader` says which team the rung belongs to — a Profile for a team
   * column, null for the loose column (they answer to me), and undefined
   * for the flat layout, where a drop changes the tier and leaves the
   * reporting line alone.
   */
  const Lane = ({
    grade,
    team,
    members,
  }: {
    grade: Grade
    team?: Team | null
    members: Profile[]
  }) => {
    const key = dropKey(grade, team === undefined ? undefined : team?.id ?? null)
    return (
      <div
        className={`mob-lane ${overGrade === key ? 'over' : ''}`}
        onDragOver={(e) => {
          e.preventDefault()
          setOverGrade(key)
        }}
        onDragLeave={() => setOverGrade((cur) => (cur === key ? null : cur))}
        onDrop={(e) => {
          e.preventDefault()
          dropOn(grade, team)
        }}
      >
        <div className="mob-lane-head">
          <span className={`tag-dot dot-${grade.color}`} aria-hidden="true" />
          <span className="mob-lane-name">{grade.name}</span>
        </div>
        {members.length === 0 ? (
          canManageTeam ? (
            <button
              className="mob-lane-add"
              onClick={() => setAdding({ grade, teamId: team === undefined ? null : team?.id ?? null })}
            >
              + Add name
            </button>
          ) : (
            <div className="mob-lane-empty">—</div>
          )
        ) : (
          members.map((p) => (
            <div
              className={`mob-member ${dragId === p.id ? 'dragging' : ''} ${moveMode ? 'movable' : ''} ${staged.has(p.id) ? 'staged' : ''}`}
              key={p.id}
              draggable={moveMode && !busy}
              onDragStart={(e) => {
                setDragId(p.id)
                e.dataTransfer.effectAllowed = 'move'
                e.dataTransfer.setData('text/plain', p.id)
              }}
              onDragEnd={() => {
                setDragId(null)
                setOverGrade(null)
              }}
            >
              {moveMode && <span className="mob-member-grip" aria-hidden="true">⋮⋮</span>}
              <span className="mob-person-name">{profileName(p)}</span>
            </div>
          ))
        )}
      </div>
    )
  }

  // Every rung of this chart is the reader's own station, so the node
  // carries the name and the tier only — repeating the station would be
  // the same word all the way down.
  const Node = ({
    grade,
    label,
    me,
    onDropHere,
  }: {
    grade: Grade | null
    label: string
    me?: boolean
    // A rung at or above your own can still be dropped on — it just
    // answers with the ceiling instead of moving anyone.
    onDropHere?: () => void
  }) => (
    <div
      className={`mob-org-node ${me ? 'me' : ''} ${grade && overGrade === dropKey(grade) ? 'over' : ''}`}
      onDragOver={(e) => {
        if (!onDropHere || !grade) return
        e.preventDefault()
        setOverGrade(dropKey(grade))
      }}
      onDragLeave={() =>
        setOverGrade((cur) => (grade && cur === dropKey(grade) ? null : cur))
      }
      onDrop={(e) => {
        if (!onDropHere) return
        e.preventDefault()
        onDropHere()
      }}
    >
      <span className={`tag-dot dot-${grade?.color ?? 'grey'}`} aria-hidden="true" />
      <span className="mob-org-text">
        <span className="mob-person-name">{label}</span>
        <span className="mob-station-meta">{grade?.name ?? '—'}</span>
      </span>
      {me && <span className="mob-chip ok">You</span>}
    </div>
  )

  /**
   * The structure under a station: who heads it, then a column per team
   * with that team's leader and people, and a column for anyone at the
   * station not yet in one. Built once and rendered either inline under a
   * station button (from above) or straight out (at station level).
   */
  /** The move toggle — a hand, because what it does is pick people up. */
  const MoveButton = () => (
    <button
      className={`mob-icon-btn corner ${moveMode ? 'on' : ''}`}
      onClick={() => {
        setMoveMode((v) => !v)
        setStaged(new Map())
      }}
      title={moveMode ? 'Done moving' : 'Move people between tiers'}
      aria-label={moveMode ? 'Done moving' : 'Move people between tiers'}
    >
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
        <path d="M9 11.5V6a1.5 1.5 0 0 1 3 0v5" />
        <path d="M12 11V4.6a1.5 1.5 0 0 1 3 0V11" />
        <path d="M15 11V6.8a1.5 1.5 0 0 1 3 0V13" />
        <path d="M9 11.5v-1.8a1.5 1.5 0 0 0-3 0v4.6c0 3.6 2.6 6.2 6.2 6.2h.6a5.2 5.2 0 0 0 5.2-5.2V13" />
      </svg>
    </button>
  )

  const board = (
    <>
      {moveMode && (
        <div className="mob-movebar on">
          <span className="mob-sub">
            {staged.size === 0
              ? 'Drag a name onto another tier'
              : `${staged.size} move${staged.size === 1 ? '' : 's'} ready`}
          </span>
          <button
            className="mob-mini ghost"
            onClick={() => {
              setStaged(new Map())
              setMoveMode(false)
            }}
          >
            Cancel
          </button>
          <button className="mob-mini go" disabled={staged.size === 0 || busy === 'save-moves'} onClick={saveMoves}>
            Save
          </button>
        </div>
      )}

      {/* The head is a rung like any other: it can be picked up and moved
          down into a team, and somebody can be moved up onto it. It was
          drawn as a plain caption before, which is why it would not
          budge. */}
      {headTier && <Lane grade={headTier} team={null} members={stationHeads} />}

      {runsTeams ? (
        <>
          <div className="mob-teamscroll" ref={scrollRef}>
            {teamColumns.map((col) => (
              <div className="mob-teamcol" key={col.key}>
                <div className="mob-teamcol-name">{col.name}</div>
                {memberTiers.map((g) => (
                  <Lane
                    key={g.id}
                    grade={g}
                    team={col.team}
                    members={col.members.filter((p) => placedGrade(p) === g.id)}
                  />
                ))}
              </div>
            ))}

            {/* Naming the new team happens in its own column, where the
                team itself will be. */}
            {draftName != null && (
              <div className="mob-teamcol draft">
                <div className="mob-teamcol-name">New team</div>
                <input
                  className="mob-input"
                  autoFocus
                  placeholder="New Team's Name"
                  value={draftName}
                  onChange={(e) => setDraftName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') saveTeam()
                    if (e.key === 'Escape') setDraftName(null)
                  }}
                />
                <div className="mob-actions">
                  <button className="mob-mini ghost" onClick={() => setDraftName(null)}>Cancel</button>
                  <button
                    className="mob-mini go"
                    disabled={!draftName.trim() || busy === 'new-team'}
                    onClick={saveTeam}
                  >
                    Save
                  </button>
                </div>
              </div>
            )}

            {/* A thin column at the end of the row: the place a new team
                would go, shaped like one. */}
            {canCreateTeam && canManageTeam && draftName == null && (
              <button className="mob-teamcol add" onClick={() => setDraftName('')} aria-label="Add new team">
                <span aria-hidden="true">+</span>
              </button>
            )}

            {looseMembers.length > 0 && (
              <div className="mob-teamcol loose">
                <div className="mob-teamcol-name">Not in a team yet</div>
                {memberTiers.map((g) => (
                  <Lane
                    key={g.id}
                    grade={g}
                    team={null}
                    members={looseMembers.filter((p) => placedGrade(p) === g.id)}
                  />
                ))}
              </div>
            )}
          </div>

          {teamColumns.length > 1 && (
            <div className="mob-teamnav">
              <button className="mob-mini" aria-label="Previous team" onClick={() => stepTeams(-1)}>‹</button>
              <span className="mob-sub">{teamColumns.length} teams</span>
              <button className="mob-mini" aria-label="Next team" onClick={() => stepTeams(1)}>›</button>
            </div>
          )}
        </>
      ) : (
        memberTiers.map((g) => {
          // The people at this station on this rung — not only those whose
          // supervisor row happens to point at you. An assistant station
          // head saw nothing because the operators beside them were tied to
          // the station and to a team, not to that one field.
          const members = stationPeople.filter((p) => placedGrade(p) === g.id)
          if (!canManageTeam && members.length === 0) return null
          return <Lane key={g.id} grade={g} team={undefined} members={members} />
        })
      )}
    </>
  )

  return (
    <>
      <div className="mob-header">
        <span className="mob-brand">MJM</span>
        <TierBadge tier={tier} />
      </div>

      <div className="mob-body">
        <div style={{ padding: '0 0.2rem' }}>
          <div className="mob-role">My team</div>
        </div>

        {error && <div className="mob-card"><div className="mob-sub" style={{ color: '#b91c1c' }}>{error}</div></div>}

        {/* 1 — Pending Allocation: the name, and one icon to claim them.
            The section label is deliberately a small caps rule so it never
            reads as one of the names underneath it. */}
        {canManageTeam && (!hasHeadRow || activeStation) && (
          <div className="mob-card">
            <div className="mob-card-label">
              Pending Allocation{' '}
              {pending.length > 0 && <span className="mob-chip warn">{pending.length}</span>}
            </div>
            {loading ? (
              <div className="mob-sub">Loading…</div>
            ) : pending.length === 0 ? (
              <div className="mob-sub">Nobody waiting for a team.</div>
            ) : (
              pending.map((p) => (
                <div className="mob-row" key={p.id}>
                  <span className="mob-person-name">{profileName(p)}</span>
                  <button
                    className="mob-icon-btn"
                    disabled={busy === p.id}
                    onClick={() => setConfirmAdd(p)}
                    title="Add to my team"
                    aria-label={`Add ${profileName(p)} to my team`}
                  >
                    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                      strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="9" cy="8" r="3.6" />
                      <path d="M2.5 20c0-3.4 2.9-5.2 6.5-5.2 1.2 0 2.3.2 3.2.6" />
                      <path d="M18 14v6M15 17h6" />
                    </svg>
                  </button>
                </div>
              ))
            )}
          </div>
        )}

        {/* 2 — the board. Above station level it is a list of stations
            that open in place: tap one and its structure unfolds under
            the button, the other stations still listed above and below.
            At station level and below it is your own line and your own
            people, as before. */}
        <div className="mob-card">
          <div className={`mob-card-label ${hasHeadRow ? 'centred' : ''}`}>
            <span>{hasHeadRow ? 'Stations' : 'My Team'}</span>
            {!hasHeadRow && canManageTeam && <MoveButton />}
          </div>

          {loading ? (
            <div className="mob-sub">Loading…</div>
          ) : hasHeadRow ? (
            <>
              {myStations.length === 0 && (
                <div className="mob-sub">No stations yet.</div>
              )}
              {myStations.map((st) => {
                const open = pickedStation === st.id
                return (
                  <div key={st.id}>
                    <div className={`mob-stationrow ${open ? 'open' : ''}`}>
                      <button
                        className="mob-lineitem"
                        onClick={() => setPickedStation(open ? null : st.id)}
                      >
                        <span className="mob-person-name">{st.name}</span>
                        <span className={`mob-caret ${open ? 'open' : ''}`}>›</span>
                      </button>
                      {open && canManageTeam && <MoveButton />}
                    </div>
                    {open && <div className="mob-expand">{board}</div>}
                  </div>
                )
              })}
            </>
          ) : (
            <>
              <div className="mob-chart-where">
                <span className="mob-chart-station">{myStationName}</span>
                <span className="mob-station-meta">{myTeamName}</span>
              </div>
              <div className="mob-org">
                {[...upperTiers].reverse().map((g) => {
                  const person = holderOf(g)
                  return (
                    <Node
                      key={g.id}
                      grade={g}
                      label={person ? profileName(person) : 'Not assigned yet'}
                      onDropHere={() => dropOn(g)}
                    />
                  )
                })}
                {tier && (
                  <Node grade={tier} label={profileName(profile)} me onDropHere={() => dropOn(tier)} />
                )}
              </div>
              {board}
            </>
          )}
        </div>
      </div>

      {/* The ceiling pop-out — says exactly how high this leader may go. */}
      {/* "+ Add name" on an empty rung opens Pending Allocation right there,
          so the person lands on that rung and in that team. */}
      {adding && (
        <div className="mob-modal-wrap" role="dialog" aria-modal="true">
          <div className="mob-modal">
            <div className="mob-card-label">
              <span>Pending Allocation</span>
              <button
                className="mob-icon-btn corner close"
                onClick={() => setAdding(null)}
                title="Close"
                aria-label="Close"
              >
                ✕
              </button>
            </div>
            <div className="mob-sub">Add to {adding.grade.name}</div>
            {pending.length === 0 ? (
              <div className="mob-sub">Nobody is waiting for a team.</div>
            ) : (
              pending.map((p) => (
                <div className="mob-row" key={p.id}>
                  <span className="mob-person-name">{profileName(p)}</span>
                  <button
                    className="mob-icon-btn"
                    disabled={busy === p.id}
                    onClick={() => addToLane(p)}
                    aria-label={`Add ${profileName(p)}`}
                  >
                    +
                  </button>
                </div>
              ))
            )}
            <button className="mob-btn ghost" onClick={() => setAdding(null)}>Close</button>
          </div>
        </div>
      )}

      {/* Adding someone to your team is a real change to their account, so
          it asks first and names who it is about. */}
      {confirmAdd && (
        <div className="mob-modal-wrap" role="dialog" aria-modal="true">
          <div className="mob-modal">
            <div className="mob-card-label">Add to my team</div>
            <div className="mob-person-name">{profileName(confirmAdd)}</div>
            <div className="mob-sub">Confirm add this user to your team?</div>
            <button
              className="mob-btn"
              disabled={busy === confirmAdd.id}
              onClick={() => {
                const who = confirmAdd
                setConfirmAdd(null)
                claim(who)
              }}
            >
              Yes, add to my team
            </button>
            <button className="mob-btn ghost" onClick={() => setConfirmAdd(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {notice && (
        <div className="mob-modal-wrap" role="dialog" aria-modal="true">
          <div className="mob-modal">
            <div className="mob-title">Exceed permission</div>
            <div className="mob-sub">{notice}</div>
            <button className="mob-btn" onClick={() => setNotice(null)}>Got it</button>
          </div>
        </div>
      )}
    </>
  )
}
