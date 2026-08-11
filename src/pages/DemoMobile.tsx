// ---------------------------------------------------------------------------
// DEMO MOBILE VIEW — one mobile app for every station (will move to its own
// repo later). A tier rail on the left lists every tier tag straight from
// the database; picking one previews the phone AS that tier.
//
// COMMON to EVERY tier — same layout, same five tabs, same screens:
//   Performance · My work · [ + ] · Team · Profile
// Only the PERFORMANCE tab changes what it shows per tier, and which of the
// two dashboards it draws — the mill's output or the tier's own KPIs — is a
// setting on the tier tag (Settings → Tags management → Entitled Function).
// My work, Team and Profile are identical for everyone — they just read that
// person's own data.
// ---------------------------------------------------------------------------
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { distanceLabel, stationLocationCheck } from '../lib/geo'
import {
  canViewTier,
  effectiveCapabilities,
  effectiveModules,
  isEntitled,
  tagClass,
  viewableTierIds,
} from '../lib/tags'
import {
  profileName,
  supabase,
  todayISO,
  type Grade,
  type Job,
  hourLadder,
  ladderAmount,
  ladderBreakdownFrom,
  ladderStepsFrom,
  tier1Cap,
  type PhotoRecord,
  type PieceRate,
  type ProductionEntry,
  type Profile,
  type Station,
  type Team,
} from '../lib/supabase'

type Tab = 'performance' | 'mywork' | 'record' | 'team' | 'profile'

// Where the open tab is remembered across refreshes (this browser only).
const MOB_TAB_KEY = 'mjm-mob-tab'

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

/** 1st, 2nd, 3rd, 4th — for rate terms that count off units in an hour. */
function ordinal(n: number) {
  const tens = n % 100
  const suffix =
    tens >= 11 && tens <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'
  return `${n}${suffix}`
}

// "3 × RM3.20" for a flat job or a tiered one still on its first rung;
// "4 × RM3.20 + 2 × RM5.00" once the count climbs the price ladder.
function breakdownFor(
  rateFor: (jobId: string) => number,
  tier2RateFor: (jobId: string) => number | null,
  ladderFor: (jobId: string) => number[],
  jobId: string,
  count: number,
) {
  void rateFor
  void tier2RateFor
  return ladderBreakdownFrom(ladderFor(jobId), count)
    .map((s) => `${Number.isInteger(s.units) ? s.units : s.units.toFixed(1)} × ${RM(s.rate)}`)
    .join(' + ')
}

// Once an hour has fully elapsed, that hour's photos (taken by this user at
// this station) convert into a pending production entry — quantity = photo
// count, priced at read-time via rateFor/amountFor. Never touches the still-
// running hour. Shared by the per-station screen (for a snappy refresh while
// it's open) and a app-wide check (so conversion isn't stuck waiting for that
// specific screen to be reopened after the hour ends).
async function autoSubmitElapsedHoursForStation(stationId: string, profileId: string) {
  const { data, error } = await supabase
    .from('operation_photos')
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
      .from('operation_entries')
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
    await supabase.from('operation_photos').update({ entry_id: entry.id }).in('id', ids)
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

/** One attendance stamp: clocked in at, and clocked out at once it ends. */
interface Shift {
  id: string
  clock_in: string
  clock_out: string | null
  // The day the shift belongs to, sent by the phone rather than read off
  // the timestamp — a shift starting at 23:40 is still that day's work.
  work_date?: string
}

/** Stand-in id for a shift the database refused — preview only, never saved. */
const LOCAL_SHIFT = 'not-saved'

/** Time of day as the phone would show it, e.g. "07:45". */
function clockTime(iso: string) {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/**
 * The one failure worth spelling out: the attendance table does not exist
 * yet, which is a migration to run rather than anything the user did wrong.
 */
function clockHelp(message: string) {
  return /attendance/i.test(message) && /(does not exist|schema cache|relation)/i.test(message)
    ? 'Clock in/out has nowhere to save yet — run supabase/setup.sql to create the attendance table.'
    : `Clock in/out failed: ${message}`
}

export default function DemoMobile({ real = false }: { real?: boolean }) {
  const { profile } = useAuth()
  const [grades, setGrades] = useState<Grade[]>([])
  const [tier, setTier] = useState<Grade | null>(null)
  const [stations, setStations] = useState<Station[]>([])
  const [jobs, setJobs] = useState<Job[]>([])
  const [rates, setRates] = useState<PieceRate[]>([])
  // The open tab survives a refresh: reloading the page mid-shift should
  // land back on the same screen, not walk everyone home to Performance.
  const [tab, setTab] = useState<Tab>(() => {
    const saved = localStorage.getItem(MOB_TAB_KEY)
    return saved === 'performance' || saved === 'mywork' || saved === 'record' ||
      saved === 'team' || saved === 'profile'
      ? (saved as Tab)
      : 'performance'
  })
  useEffect(() => {
    localStorage.setItem(MOB_TAB_KEY, tab)
  }, [tab])
  // Pressing a tab means "take me to that tab's main page" — including the
  // tab you are already on, which is how you get back out of a screen you
  // drilled into. Bumping this remounts the tab, so every screen it was
  // holding open falls away with it.
  const [tabPress, setTabPress] = useState(0)
  // Which bucket My work opens on when something else sends you there.
  // Pressing the tab itself always means "Pending", the tab's own front
  // door; only a card that named a bucket changes it.
  const [workFilter, setWorkFilter] = useState<WorkFilter>('pending')
  const goTab = (t: Tab) => {
    setTab(t)
    if (t === 'mywork') setWorkFilter('pending')
    setTabPress((n) => n + 1)
  }
  /** Open My work on a named bucket — from the Performance tab's cards. */
  const goMyWork = (f: WorkFilter = 'pending') => {
    setWorkFilter(f)
    setTab('mywork')
    setTabPress((n) => n + 1)
  }
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
      .from('operation_photos')
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
        supabase.from('shared_grades').select('*').order('sort_order'),
        supabase.from('shared_stations').select('*').order('sort_order'),
        supabase.from('piece_rate_jobs').select('*').eq('active', true),
        supabase.from('piece_rates').select('*'),
      ])
      const err = g.error || s.error || j.error || r.error
      if (err) setError(err.message)
      setGrades(g.data ?? [])
      setStations(s.data ?? [])
      setJobs(j.data ?? [])
      setRates(r.data ?? [])
      if (!real && g.data && g.data.length > 0) setTier((prev) => prev ?? g.data[0])
      setLoading(false)
    }
    load()
  }, [])

  // REAL mode (#/mobile): the phone is not previewing a tier — it IS the
  // signed-in account. The tier is the account's own tag, and an account
  // not yet placed on the chart gets the new-sign-up welcome.
  useEffect(() => {
    if (!real) return
    const mine = grades.find((g) => g.id === profile?.grade_id) ?? null
    setTier(mine)
    setSignupPreview(!profile?.tags_confirmed || !mine)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [real, grades, profile?.grade_id, profile?.tags_confirmed])

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
  // The rate's full price ladder — element i pays the (i+1)th record of
  // the hour, the last element every record after.
  const ladderFor = useMemo(
    () => (jobId: string) => hourLadder(bestRate.get(jobId)),
    [bestRate],
  )
  const amountFor = useMemo(
    () => (jobId: string, quantity: number) => ladderAmount(bestRate.get(jobId), quantity),
    [bestRate],
  )

  // The preview obeys the SELECTED tier's capabilities — only tiers with
  // the data-entry capability may submit records.
  const tierCaps = effectiveCapabilities(tier)
  const canEntry = tierCaps.includes('data-entry')
  /**
   * Who reads the WHOLE mill rather than their own station tags.
   *
   * Ticking the Mill dashboard is the plainest way of saying so, and it
   * comes first: a tier given the mill's output, workforce, wages and
   * cost trend is being asked to read the mill, and a "mill" drawn over
   * the one station that tier happens to be tagged to is not that.
   *
   * The rest are older, looser signals kept so nothing that reached every
   * station before starts reaching fewer.
   */
  const readsWholeMill =
    isEntitled(tier, 'mill-dashboard', grades) ||
    effectiveModules(tier?.modules).includes('report') ||
    tierCaps.includes('verify') ||
    tierCaps.includes('approve')
  const myStationIds = profile?.station_ids ?? []
  const scopedStations =
    readsWholeMill || myStationIds.length === 0
      ? stations
      : stations.filter((s) => myStationIds.includes(s.id))

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

  const screenBody = (
    <>
              <div className="mob-content" key={`${tab}-${tabPress}`}>
                {loading ? (
                  <div className="mob-body"><p className="muted small">Loading…</p></div>
                ) : signupPreview ? (
                  <SignupWelcome myName={profileName(profile)} />
                ) : tab === 'performance' ? (
                  <PerformanceTab
                    stations={scopedStations}
                    tier={tier}
                    grades={grades}
                    jobs={jobs}
                    rateFor={rateFor}
                    amountFor={amountFor}
                    tier2RateFor={tier2RateFor}
                  ladderFor={ladderFor}
                    profile={profile}
                    profileId={profile?.id ?? null}
                    myStationIds={myStationIds}
                    jobColumnReady={jobColumnReady}
                    onMyWork={goMyWork}
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
                  ladderFor={ladderFor}
                    myEmail={profile?.email ?? 'unknown'}
                    initialFilter={workFilter}
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
                  ladderFor={ladderFor}
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
                    onError={setError}
                  />
                )}
              </div>

              {!signupPreview && (
                <TabBar
                  tab={tab}
                  onTab={goTab}
                />
              )}
    </>
  )

  // REAL mode: no rail, no demo frame — the phone itself is the frame.
  if (real) {
    return (
      <div className="mob-real">
        {error && <div className="error" style={{ margin: '0.5rem 0.9rem 0' }}>{error}</div>}
        {screenBody}
      </div>
    )
  }

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

              {screenBody}
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
}: {
  tab: Tab
  onTab: (t: Tab) => void
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
        aria-label="New work record"
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

/**
 * Every screen reached FROM a tab wears the same row, directly under the
 * MJM brand: a back arrow hard left, the page's name in the middle.
 *
 * It used to be a worded link — "‹ Approvals", "‹ Stations", "‹ Record" —
 * sharing the brand's row, so the arrow moved about, said something
 * different on each screen, and the page's own name sat somewhere else
 * again. One arrow, one title, one place.
 */
/* ------------------------------------------------------------------ */
/* A filter behind one button, rather than a row of chips across the    */
/* screen. Picking is ADDITIVE — tap a tier to tick it, tap another to  */
/* read both side by side, tap again to untick. An empty set is ALL,    */
/* not none: that is what the list does before anybody touches it, so   */
/* "All" needs no state of its own.                                     */
/* ------------------------------------------------------------------ */

function FilterMenu({
  title,
  allLabel,
  options,
  picked,
  onToggle,
  onAll,
}: {
  title: string
  allLabel: string
  options: { key: string; name: string; color?: string | null }[]
  picked: Set<string>
  onToggle: (key: string) => void
  onAll: () => void
}) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement | null>(null)
  // The box the list scrolls in, and what it looked like when the menu
  // was opened: how far it was scrolled, its natural bottom padding, and
  // how tall it was.
  const box = useRef<HTMLElement | null>(null)
  const keep = useRef<number | null>(null)
  const basePad = useRef(0)
  const reserve = useRef<number | null>(null)
  const extraPad = useRef(0)
  const narrowed = picked.size > 0

  function scrollBox(): HTMLElement | null {
    let node: HTMLElement | null = root.current?.parentElement ?? null
    while (node) {
      const oy = getComputedStyle(node).overflowY
      if (oy === 'auto' || oy === 'scroll') return node
      node = node.parentElement
    }
    return null
  }

  /**
   * Hold the list still while it is being filtered.
   *
   * Two things move it. Ticking a tier re-renders the list, and the scroll
   * box settles somewhere else. Unticking makes the list SHORTER, and if
   * you were near the bottom there is no longer anywhere to be scrolled
   * to — the browser clamps, and the block you are working slides.
   *
   * So while the menu is open the box keeps the height it had when the
   * menu opened, held there by padding underneath the list. Nothing can
   * clamp, so nothing moves; the block grows and shrinks above padding
   * that gives way in step with it. Closing the menu hands the space
   * back.
   */
  function hold(change: () => void) {
    box.current = scrollBox()
    keep.current = box.current ? box.current.scrollTop : null
    change()
  }

  function openMenu() {
    const node = scrollBox()
    box.current = node
    if (node) {
      basePad.current = parseFloat(getComputedStyle(node).paddingBottom) || 0
      extraPad.current = 0
      reserve.current = node.scrollHeight
      keep.current = node.scrollTop
    }
    setOpen(true)
  }

  function closeMenu() {
    const node = box.current
    if (node) {
      node.style.paddingBottom = ''
      const top = Math.min(node.scrollTop, Math.max(0, node.scrollHeight - node.clientHeight))
      node.scrollTop = top
    }
    reserve.current = null
    extraPad.current = 0
    keep.current = null
    setOpen(false)
  }

  useLayoutEffect(() => {
    const node = box.current
    if (!node) return
    if (open && reserve.current != null) {
      // What the list would measure with the reserved space taken out.
      const natural = node.scrollHeight - extraPad.current
      const extra = Math.max(0, reserve.current - natural)
      extraPad.current = extra
      node.style.paddingBottom = `${basePad.current + extra}px`
    }
    const top = keep.current
    keep.current = null
    if (top != null) {
      node.scrollTop = Math.min(top, Math.max(0, node.scrollHeight - node.clientHeight))
    }
  })

  // Leaving the tab with the menu still open must not leave the reserved
  // space behind on a box the next screen will use.
  useEffect(() => () => {
    if (box.current) box.current.style.paddingBottom = ''
  }, [])

  return (
    <div className="mob-filter" ref={root}>
      <button
        type="button"
        className={`mob-filter-btn ${narrowed ? 'on' : ''}`}
        onClick={() => (open ? closeMenu() : openMenu())}
        aria-label={title}
        aria-expanded={open}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 5h18l-7 8v6l-4 2v-8Z" />
        </svg>
        {narrowed && <span className="mob-filter-count">{picked.size}</span>}
      </button>

      {open && (
        <>
          {/* Anywhere else closes it — a filter should not need its own
              close button to get out of the way. */}
          <button type="button" className="mob-filter-scrim" aria-label="Close filter" onClick={closeMenu} />
          <div className="mob-filter-menu" role="menu">
            <div className="mob-filter-title">{title}</div>
            <button
              type="button"
              className={`mob-filter-row ${picked.size === 0 ? 'on' : ''}`}
              onClick={() => hold(onAll)}
            >
              <span className="mob-filter-tick">{picked.size === 0 ? '✓' : ''}</span>
              <span>{allLabel}</span>
            </button>
            {options.map((o) => (
              <button
                type="button"
                key={o.key}
                className={`mob-filter-row ${picked.has(o.key) ? 'on' : ''}`}
                onClick={() => hold(() => onToggle(o.key))}
              >
                <span className="mob-filter-tick">{picked.has(o.key) ? '✓' : ''}</span>
                {o.color && <span className={`tag-dot dot-${o.color}`} aria-hidden="true" />}
                <span>{o.name}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

/** Today / 7 days / 30 days — the windows every record screen offers. */
const DAY_RANGES = [
  { key: 'today', label: 'Today', days: 0 },
  { key: '7d', label: '7 days', days: 6 },
  { key: '30d', label: '30 days', days: 29 },
] as const

type DayRange = (typeof DAY_RANGES)[number]['key']

/**
 * The Work Record History's windows. Calendar periods, not rolling days:
 * "this week" is the week you are in, so the number stops moving under
 * you as the days pass, and it is the same week your leader means.
 *
 * A key that is none of these is a month — "2026-07" — one of the three
 * before this one, reached from the history icon.
 */
const HISTORY_RANGES = [
  { key: 'today', label: 'Today' },
  { key: 'week', label: 'This week' },
  { key: 'month', label: 'This month' },
] as const

type HistoryRange = (typeof HISTORY_RANGES)[number]['key'] | string

/** The first and last day a window covers, both inclusive. */
function historyWindow(key: HistoryRange): { from: string; to: string } {
  const today = todayISO()
  if (key === 'today') return { from: today, to: today }
  if (key === 'week') {
    const monday = new Date()
    monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7))
    return { from: dayISO(monday), to: today }
  }
  if (key === 'month') return { from: today.slice(0, 8) + '01', to: today }
  // A whole month that has already finished.
  const [y, m] = key.split('-').map(Number)
  return { from: dayISO(new Date(y, m - 1, 1)), to: dayISO(new Date(y, m, 0)) }
}

/** The three months before this one, newest first. */
function recentMonths(): { key: string; label: string }[] {
  const now = new Date()
  return [1, 2, 3].map((back) => {
    const m = new Date(now.getFullYear(), now.getMonth() - back, 1)
    return {
      key: `${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, '0')}`,
      label: m.toLocaleDateString(undefined, { month: 'short', year: 'numeric' }),
    }
  })
}

/** The Output record's windows, said in this screen's words. */
const RANGE_FROM_OUTPUT: Record<DayRange, HistoryRange> = {
  today: 'today',
  '7d': 'week',
  '30d': 'month',
}

function MobSubHeader({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <div className="mob-subhead">
      <button className="mob-back" onClick={onBack} aria-label="Back">‹</button>
      <span className="mob-pagetitle">{title}</span>
    </div>
  )
}

function dayISO(d: Date) {
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10)
}

function hourLabel(h: number) {
  const h24 = ((h % 24) + 24) % 24
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12
  return `${h12}${h24 >= 12 ? 'PM' : 'AM'}`
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
  tier,
  grades,
  jobs,
  rateFor,
  amountFor,
  tier2RateFor,
  ladderFor,
  profile,
  profileId,
  myStationIds,
  jobColumnReady,
  onMyWork,
  onError,
}: {
  stations: Station[]
  tier: Grade | null
  grades: Grade[]
  jobs: Job[]
  rateFor: (jobId: string) => number
  amountFor: (jobId: string, quantity: number) => number
  tier2RateFor: (jobId: string) => number | null
  ladderFor: (jobId: string) => number[]
  profile: Profile | null
  profileId: string | null
  myStationIds: string[]
  jobColumnReady: boolean
  /** Send the viewer to My work, optionally straight to one bucket. */
  onMyWork: (filter?: WorkFilter) => void
  onError: (m: string | null) => void
}) {
  const [station, setStation] = useState<Station | null>(null)
  // The screens this tab drills into: the work record behind "My work
  // done", and the two queues behind the cards under it.
  const [sub, setSub] = useState<null | 'history' | 'output'>(null)
  // Set by the › beside a station on the Output record: the history that
  // opens is that station's, and Back returns to the Output record.
  const [historyStation, setHistoryStation] = useState<Station | null>(null)
  // Which window that history opens on — carried over from the Output
  // record, so clicking through from "30 days" stays on 30 days.
  const [historyRange, setHistoryRange] = useState<DayRange>('today')
  const [detail, setDetail] = useState<ProductionEntry | null>(null)
  const [entries, setEntries] = useState<ProductionEntry[]>([])
  const tierCaps = effectiveCapabilities(tier)
  const canEntry = tierCaps.includes('data-entry')
  const monthStart = todayISO().slice(0, 8) + '01'

  // Six months back covers the management dashboard's trend chart; the
  // month-to-date subset (mtd, below) feeds everything else.
  function loadEntries() {
    const now = new Date()
    const from = new Date(now.getFullYear(), now.getMonth() - 5, 1)
    supabase
      .from('operation_entries')
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
        .from('operation_entries')
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

  // This week's daily quantity (Mon–Sun), split by where each unit stands
  // in approval — the bar carries all of it, coloured by status, so the
  // chart and the scorecard read as one picture.
  const myWeek: { label: string; iso: string; appr: number; rej: number; wait: number }[] = []
  const todayDate = new Date()
  const monday = new Date(todayDate)
  monday.setDate(todayDate.getDate() - ((todayDate.getDay() + 6) % 7))
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday)
    d.setDate(monday.getDate() + i)
    myWeek.push({
      label: d.toLocaleDateString(undefined, { weekday: 'short' }),
      iso: dayISO(d),
      appr: 0,
      rej: 0,
      wait: 0,
    })
  }
  for (const e of myEntries) {
    const slot = myWeek.find((w) => w.iso === e.work_date)
    if (!slot) continue
    const st = e.approval_status ?? 'approved'
    if (st === 'approved') slot.appr += e.quantity
    else if (st === 'rejected') slot.rej += e.quantity
    else slot.wait += e.quantity
  }
  const myQty = (w: (typeof myWeek)[number]) => w.appr + w.rej + w.wait
  const myMaxQty = Math.max(1, ...myWeek.map(myQty))

  const todayIso = todayISO()



  if (station) {
    return (
      <StationScreen
        station={station}
        tier={tier}
        grades={grades}
        jobs={jobs}
        rateFor={rateFor}
        amountFor={amountFor}
        ladderFor={ladderFor}
        profileId={profileId}
        jobColumnReady={jobColumnReady}
        canEntry={canEntry}
        onBack={() => setStation(null)}
        onError={onError}
      />
    )
  }

  if (detail) {
    return (
      <EntryDetail
        entry={detail}
        myName={profileName(profile)}
        tier={tier}
        stations={stations}
        jobs={jobs}
        rateFor={rateFor}
        amountFor={amountFor}
        tier2RateFor={tier2RateFor}
                  ladderFor={ladderFor}
        onBack={() => setDetail(null)}
      />
    )
  }

  if (sub === 'history') {
    return (
      <RecordHistory
        profileId={profileId}
        stations={stations}
        jobs={jobs}
        amountFor={amountFor}
        canEdit={tierCaps.includes('edit-entry')}
        station={historyStation}
        myStations={stations.filter((s) => myStationIds.includes(s.id))}
        initialRange={historyRange}
        onOpen={setDetail}
        onBack={() => {
          // A station's history was entered from the Output record, so
          // Back returns there; your own history goes back to the tab.
          setSub(historyStation ? 'output' : null)
          setHistoryStation(null)
        }}
      />
    )
  }

  if (sub === 'output') {
    return (
      <OutputRecordScreen
        stations={stations}
        jobs={jobs}
        entries={entries}
        onStation={(st, range) => {
          setHistoryStation(st)
          setHistoryRange(range)
          setSub('history')
        }}
        onBack={() => setSub(null)}
      />
    )
  }

  const outputRecord = buildOutputRecord(stations, jobs, mtd)

  // My own scorecard, against a target of everything I submit ending up
  // approved.
  const myThisWeek = scoreOver(myEntries.filter((e) => e.work_date >= dayISO(monday)))
  const shortMonth = new Date().toLocaleDateString(undefined, { month: 'short', year: '2-digit' })
  const fmtQty = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1))

  // WHICH dashboard this tab shows is set per tier, in Settings → Tags
  // management → Entitled Function. Both may be on: the mill reads first
  // and the tier's own numbers follow underneath. A tag nobody has set
  // keeps the old answer — the tiers above the station head read the mill,
  // everyone else reads their own KPIs.
  const showMill = isEntitled(tier, 'mill-dashboard', grades)
  // Somebody with no tier tag at all has no setting to read, so they keep
  // the plain face they have always had rather than an empty tab.
  const showKpi = tier == null || isEntitled(tier, 'kpi-dashboard', grades)

  return (
    <>
      <div className="mob-header">
        <span className="mob-brand">MJM</span>
      </div>
      <div className="mob-body">
        <div className="mob-pagehead">
          {/* The title names the dashboard this tier was given (Settings →
              Tags management → Entitled Function). The mill reads first
              when both are on. */}
          <div className="mob-role">
            {showMill ? 'Mill Dashboard' : showKpi ? 'KPI Dashboard' : 'Performance dashboard'}
          </div>
        </div>

        {/* Both dashboards can be switched off, and a blank tab would look
            broken rather than configured. Say which setting emptied it. */}
        {!showMill && !showKpi && (
          <div className="mob-card">
            <div className="mob-card-label">No dashboard switched on</div>
            <div className="mob-sub">
              This tier has neither the mill output nor the KPI dashboard ticked under
              Settings → Tags management → Entitled Function.
            </div>
          </div>
        )}

        {/* Admin tier and above read the mill first: the output record —
            every work set to show here, under its station — then who is on,
            then what it costs. */}
        {showMill && (
          <>
            {/* The whole card opens the record over today, 7 days and 30
                days — for the stations this tier may see, which is the
                list it was handed. */}
            <button className="mob-card mob-card-tap" onClick={() => setSub('output')}>
              {/* The same head as the KPI dashboard's cards: the label
                  small and grey, the caret on the right. */}
              <div className="mob-cardhead">
                <span className="mob-card-label">{shortMonth} Work recorded</span>
                <span className="mob-caret" aria-hidden="true">›</span>
              </div>
              {outputRecord.length === 0 ? (
                <div className="mob-sub">
                  No work is set to show here yet — tick “Show on mill performance”
                  on a piece rate.
                </div>
              ) : (
                outputRecord.map((r) => (
                  <div key={r.station.id}>
                    <div className="mob-breakrow station">{r.station.name}</div>
                    {r.works.map((w) => (
                      <div className="mob-breakrow indent" key={w.name}>
                        <span>{w.name}</span>
                        <span className="mob-entry-amt">{fmtQty(w.qty)}</span>
                      </div>
                    ))}
                  </div>
                ))
              )}
            </button>

          </>
        )}


        {/* 2 — my own scorecard: everything I submit should end up approved.
            Above the station tiers this reads as review, not as my own
            work, so it moves to My work with the rest of the review. */}
        {/* My work done — the whole week in one card. One bar per day,
            Mon to Sun, carrying EVERYTHING recorded that day coloured by
            where it stands (approved / rejected / waiting), and under the
            Sunday bar the week's percentage — the same colours adding
            themselves up. */}
        {canEntry && showKpi && (
          <div
            className="mob-card tapcard block"
            role="button"
            tabIndex={0}
            onClick={() => {
              setHistoryStation(null)
              setHistoryRange('today')
              setSub('history')
            }}
            onKeyDown={(ev) => {
              if (ev.key !== 'Enter' && ev.key !== ' ') return
              setHistoryStation(null)
              setHistoryRange('today')
              setSub('history')
            }}
          >
            <div className="mob-cardhead">
              <span className="mob-card-label">My work done</span>
              <span className="mob-caret" aria-hidden="true">›</span>
            </div>
            <div className="mob-bars">
              {myWeek.map((w) => {
                const total = myQty(w)
                return (
                  <div className={`mob-barrow ${w.iso === todayIso ? 'today' : ''}`} key={w.iso}>
                    <span className="lbl">{w.label}{w.iso === todayIso ? ' •' : ''}</span>
                    <span className="mob-bartrack split">
                      {w.appr > 0 && <div className="done" style={{ width: `${(w.appr / myMaxQty) * 100}%` }} />}
                      {w.rej > 0 && <div className="bad" style={{ width: `${(w.rej / myMaxQty) * 100}%` }} />}
                      {w.wait > 0 && <div className="wait" style={{ width: `${(w.wait / myMaxQty) * 100}%` }} />}
                    </span>
                    <span className="val">{total > 0 ? fmtQty(total) : '·'}</span>
                  </div>
                )
              })}
            </div>
            <ScoreMeter label="This week" score={myThisWeek} />
            <div className="mob-scorekey">
              <span><i className="dot done" />Work done</span>
              <span><i className="dot bad" />Rejected</span>
              <span><i className="dot wait" />Waiting approval</span>
            </div>
          </div>
        )}

        {canEntry && needsFix > 0 && (
          <button className="mob-alert" onClick={() => onMyWork('rejected')}>
            ⚠ {needsFix} entr{needsFix === 1 ? 'y' : 'ies'} rejected — tap to fix & resubmit →
          </button>
        )}


        {/* 4 — what the work paid. This month's own numbers, the payslips
            they add up to, and the rates behind both. They used to live on
            the Profile tab, which made Profile a pay screen and left the
            KPI dashboard as a chart with no money on it. They belong to the
            KPI dashboard, so they follow the same setting as the rest of
            it rather than a rung test of their own. */}
        {showKpi && (
          <>
            <MyNumbersSection
              profileId={profileId}
              amountFor={amountFor}
              onOpen={() => {
                setHistoryStation(null)
                setHistoryRange('30d')
                setSub('history')
              }}
            />
            <ContractSection
              tier={tier}
              grades={grades}
              jobs={jobs}
              stations={stations}
              myStationIds={myStationIds}
              rateFor={rateFor}
              tier2RateFor={tier2RateFor}
                  ladderFor={ladderFor}
            />
          </>
        )}

      </div>
    </>
  )
}

/**
 * One entry per work name.
 *
 * A work type is priced once per tier tag, so a Station Head — who may
 * record their own tier's work and everything below it — would otherwise be
 * offered "FFB Cages Tipped" three times over with nothing to tell the
 * lines apart. Keep the contract closest to the person's own rank: their
 * own tier when it is priced, then the tier below it, and a contract with
 * no tag at all only when nothing else fits.
 */
function onePerWork(list: Job[], tier: Grade | null, grades: Grade[]): Job[] {
  const rank = (j: Job) => {
    if (!j.grade_id) return 1000
    const g = grades.find((x) => x.id === j.grade_id)
    if (!g) return 999
    // Distance DOWN from the viewer's own rank — their own tier scores 0.
    return tier ? g.sort_order - tier.sort_order : g.sort_order
  }
  const best = new Map<string, Job>()
  for (const j of list) {
    const seen = best.get(j.name)
    if (!seen || rank(j) < rank(seen)) best.set(j.name, j)
  }
  return [...best.values()]
}

/* ------------------------------------------------------------------ */
/* Output record — the same sheet as the dashboard card, over a window  */
/* you choose. The station list handed in is already what this tier may */
/* see, so a station-scoped tier reads its own station here and a       */
/* mill-wide one reads every station, with no extra filtering.          */
/* ------------------------------------------------------------------ */

function OutputRecordScreen({
  stations,
  jobs,
  entries,
  onStation,
  onBack,
}: {
  stations: Station[]
  jobs: Job[]
  entries: ProductionEntry[]
  /** The station, and the window it was being read over. */
  onStation: (s: Station, range: DayRange) => void
  onBack: () => void
}) {
  const [range, setRange] = useState<(typeof DAY_RANGES)[number]['key']>('today')
  const chosen = DAY_RANGES.find((r) => r.key === range) ?? DAY_RANGES[0]

  const from = new Date()
  from.setDate(from.getDate() - chosen.days)
  const fromISO = dayISO(from)
  const rows = entries.filter((e) => e.work_date >= fromISO)
  const record = buildOutputRecord(stations, jobs, rows)
  const fmtQty = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1))

  return (
    <>
      <div className="mob-header">
        <span className="mob-brand">MJM</span>
      </div>

      <div className="mob-body">
        <MobSubHeader title="Work recorded history" onBack={onBack} />
        <div className="mob-queue-chips">
          {DAY_RANGES.map((r) => (
            <button key={r.key} className={range === r.key ? 'on' : ''} onClick={() => setRange(r.key)}>
              {r.label}
            </button>
          ))}
        </div>

        {record.length === 0 ? (
          <div className="mob-card">
            <div className="mob-sub">Nothing set to show on the mill dashboard yet.</div>
          </div>
        ) : (
          record.map((r) => (
            <div className="mob-card" key={r.station.id}>
              <button className="mob-cardhead" onClick={() => onStation(r.station, range)}>
                <span className="mob-card-label">{r.station.name}</span>
                <span className="mob-caret" aria-hidden="true">›</span>
              </button>
              {r.works.map((w) => (
                <div className="mob-breakrow" key={w.name}>
                  <span>{w.name}</span>
                  <span className="mob-entry-amt">{fmtQty(w.qty)}</span>
                </div>
              ))}
            </div>
          ))
        )}
      </div>
    </>
  )
}

/** One station's line on the Output record, and the works under it. */
interface OutputRow {
  station: Station
  works: { name: string; qty: number }[]
}

/**
 * The Output record: every work set to "Show on mill performance", under
 * the station it belongs to, with what was APPROVED against it over the
 * rows given.
 *
 * Summed by work NAME rather than by contract, since the same work is
 * priced once per tier tag and the mill does not care which tier tipped
 * the cage. A work with nothing recorded still shows, at zero — a station
 * that produced nothing is the thing a dashboard is for.
 *
 * `stations` is already the list this tier may see, so a station-scoped
 * tier gets its own station and a mill-wide one gets them all, with no
 * further filtering here.
 */
function buildOutputRecord(stations: Station[], jobs: Job[], rows: ProductionEntry[]): OutputRow[] {
  const millJobs = jobs.filter((j) => j.show_on_mill !== false)
  const jobById = new Map(millJobs.map((j) => [j.id, j]))
  const byStation = new Map(stations.map((s) => [s.id, new Map<string, number>()]))
  for (const j of millJobs) {
    const m = byStation.get(j.station_id)
    if (m && !m.has(j.name)) m.set(j.name, 0)
  }
  for (const e of rows) {
    if ((e.approval_status ?? 'approved') !== 'approved') continue
    const j = jobById.get(e.job_id)
    const m = byStation.get(e.station_id)
    if (!j || !m) continue
    m.set(j.name, (m.get(j.name) ?? 0) + e.quantity)
  }
  return stations
    .map((s) => ({
      station: s,
      works: [...(byStation.get(s.id) ?? new Map<string, number>())]
        .map(([name, qty]) => ({ name, qty }))
        .sort((a, b) => b.qty - a.qty || a.name.localeCompare(b.name)),
    }))
    .filter((r) => r.works.length > 0)
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
  ladderFor,
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
  ladderFor: (jobId: string) => number[]
  profileId: string | null
  jobColumnReady: boolean
  canEntry: boolean
  onBack: () => void
  onError: (m: string | null) => void
}) {
  return (
    <>
      <div className="mob-header">
        <span className="mob-brand">MJM</span>
      </div>

      <div className="mob-body">
        <MobSubHeader title={station.name} onBack={onBack} />
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
            ladderFor={ladderFor}
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
/**
 * The target dashboards the station's "Show on Add new work record" ticks
 * switch on (Settings → Station tags → pin action). Draft faces — to be
 * refined once real use shapes them.
 *
 * Per hour: one badge per unit of the hour's target, ticked as YOUR
 * records land this hour. From the badge past the base-rate cap the
 * colour changes — that work is already earning the second-tier rate.
 * Per month: the station's work done this month against its target.
 */
function StationTargetCards({
  station,
  profileId,
}: {
  station: Station
  profileId: string | null
}) {
  // The rate's own tier threshold decides where the badges turn blue; a
  // station without a tiered rate keeps the default cap.
  const capBadge = tier1Cap(null)
  const showHour = station.show_hourly_target === true && (station.hourly_target ?? 0) > 0
  const showMonth = station.show_monthly_target === true && (station.monthly_target ?? 0) > 0
  const [hourCount, setHourCount] = useState(0)
  const [monthQty, setMonthQty] = useState(0)

  useEffect(() => {
    if (!showHour && !showMonth) return
    let alive = true
    async function load() {
      if (showHour && profileId) {
        const hourStart = new Date()
        hourStart.setMinutes(0, 0, 0)
        const { data } = await supabase
          .from('operation_entries')
          .select('id')
          .eq('station_id', station.id)
          .eq('user_id', profileId)
          .gte('created_at', hourStart.toISOString())
        if (alive) setHourCount((data ?? []).length)
      }
      if (showMonth) {
        const monthStart = todayISO().slice(0, 8) + '01'
        const { data } = await supabase
          .from('operation_entries')
          .select('quantity')
          .eq('station_id', station.id)
          .gte('work_date', monthStart)
        if (alive) {
          setMonthQty((data ?? []).reduce((t, r) => t + Number((r as { quantity: number }).quantity ?? 0), 0))
        }
      }
    }
    load()
    const t = setInterval(load, 60_000)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [station.id, profileId, showHour, showMonth])

  if (!showHour && !showMonth) return null
  const hourTarget = station.hourly_target ?? 0
  const monthTarget = station.monthly_target ?? 0
  const pct = monthTarget > 0 ? Math.min(100, Math.round((monthQty / monthTarget) * 100)) : 0

  return (
    <>
      {showHour && (
        <div className="mob-card mob-highlight">
          <div className="mob-card-label">Target per hour</div>
          <div className="stamp-row">
            {Array.from({ length: hourTarget }, (_, i) => (
              <span
                key={i}
                className={`stamp ${i >= capBadge ? 'tier2' : ''} ${i < hourCount ? 'done' : ''}`}
              >
                ✓
              </span>
            ))}
            {hourCount > hourTarget && (
              <span className="stamp extra">+{hourCount - hourTarget}</span>
            )}
          </div>
          <div className="mob-sub">
            {hourCount} of {hourTarget} this hour
            {hourTarget > capBadge
              ? ` · blue from no. ${capBadge + 1}: the second-tier rate`
              : ''}
          </div>
        </div>
      )}
      {showMonth && (
        <div className="mob-card">
          <div className="mob-card-label">Target per month</div>
          <div className="mob-breakrow">
            <span>Work done this month</span>
            <span className="mob-entry-amt">{Number.isInteger(monthQty) ? monthQty : monthQty.toFixed(1)} / {monthTarget}</span>
          </div>
          <div className="mob-bartrack">
            <div style={{ width: `${pct}%` }} />
          </div>
          <div className="mob-sub">{pct}% of this month's target</div>
        </div>
      )}
    </>
  )
}

function StationWorkPanel({
  station,
  tier,
  grades,
  jobs,
  rateFor,
  amountFor,
  ladderFor,
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
  ladderFor: (jobId: string) => number[]
  profileId: string | null
  jobColumnReady: boolean
  canEntry: boolean
  onError: (m: string | null) => void
}) {
  const [viewDate, setViewDate] = useState(() => new Date())
  const [records, setRecords] = useState<PhotoRecord[]>([])
  const [uploading, setUploading] = useState(false)
  // Today's hours, behind the "i" beside the hour being worked.
  const [showHours, setShowHours] = useState(false)
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

  // Jobs this tier may record at this station, priced at an APPROVED rate
  // only, and ticked as a JOB RECORD — incentives and other support rates
  // are paid but never offered as a record to submit.
  const tierOf = (gid: string | null) => grades.find((g) => g.id === gid)?.sort_order
  const approvedJobs = onePerWork(
    jobs.filter(
      (j) =>
        j.station_id === station.id &&
        j.approval_status === 'approved' &&
        j.active &&
        j.record_job !== false &&
        (!j.grade_id || tier == null || (tierOf(j.grade_id) ?? 99) >= tier.sort_order),
    ),
    tier,
    grades,
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
      .from('operation_photos')
      .select<string, PhotoRecord>(cols)
      .eq('station_id', station.id)
      .gte('taken_at', start.toISOString())
      .lt('taken_at', end.toISOString())
      .order('taken_at', { ascending: false })
    if (error) onError(error.message)
    else setRecords(data ?? [])

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
        .from('operation_photos')
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



  /**
   * Today's hours, priced. A tiered rate counts within the hour — that is
   * what the tier threshold means — so each hour is priced on its own and
   * the day is their sum. Empty hours are left out; the hour being worked
   * is kept whether or not it holds anything yet.
   */
  const hourRows = (() => {
    if (!isToday) return [] as { hour: number; count: number; breakdown: string; amount: number; current: boolean }[]
    const nowHour = new Date().getHours()
    const counts = new Map<number, number>()
    for (const r of records) {
      if (jobId && r.job_id !== jobId) continue
      const h = new Date(r.taken_at).getHours()
      counts.set(h, (counts.get(h) ?? 0) + 1)
    }
    const hours = [...new Set([...counts.keys(), nowHour])].sort((a, b) => a - b)
    return hours.map((hour) => {
      const count = counts.get(hour) ?? 0
      return {
        hour,
        count,
        breakdown: jobId
          ? ladderBreakdownFrom(ladderFor(jobId), count)
              .map((step) => `${step.units} × ${RM(step.rate)}`)
              .join(' + ')
          : `${count}`,
        amount: jobId ? amountFor(jobId, count) : 0,
        current: hour === nowHour,
      }
    })
  })()
  const hoursTotal = hourRows.reduce((n, h) => n + h.amount, 0)

  // Kept on the props so every screen taking a price ladder takes the same
  // set; the hour sheet reads the ladder itself.
  void rateFor

  // What the station asks for each hour. Null means it asks for nothing in
  // particular, so there is no row of stamps to draw against.
  const hourlyTarget = station.hourly_target ?? null


  return (
    <>
        <StationTargetCards station={station} profileId={profileId} />

        {/* 1 — the day and the hour in one block: what has been recorded
               today, then the hour being worked right now. */}
        <div className="mob-card mob-highlight">
          <div className="mob-card-label">Work done today</div>
          <WorkDoneCard bare profileId={profileId} station={station} reloadKey={records.length} />
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
                ) : approvedJobs.length === 1 ? null : (
                  <>
                    <div className="mob-field-label">Job</div>
                    <select className="mob-select" value={jobId} onChange={(e) => setJobId(e.target.value)}>
                      <option value="">Choose job…</option>
                      {approvedJobs.map((j) => (
                        <option key={j.id} value={j.id}>{j.name}</option>
                      ))}
                    </select>
                  </>
                )
              )}
              <div className="mob-zone-row">
                <span className="mob-title mob-zone-title">{hourZone}</span>
                <button
                  type="button"
                  className="mob-info-btn"
                  onClick={() => setShowHours(true)}
                  aria-label="Today's hours"
                  title="Today's hours"
                >
                  i
                </button>
              </div>
              {/* One stamp per unit the station asks for this hour, filled
                  as records come in. A station with no hourly target has
                  nothing to draw a row of stamps against, so it counts. */}
              {hourlyTarget == null ? (
                <div className="mob-sub">
                  {stampsThisHour} recorded this hour · {minutesLeft} min left
                  {rewardActive && ' · bonus hour ✨'}
                </div>
              ) : (
                <>
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
                </>
              )}
              {minPrev > 0 && (
                <div className="mob-sub">
                  {nextHourBonus
                    ? `Minimum met (${stampsThisHour}/${minPrev}) — next hour is a bonus hour ✨`
                    : `${minPrev - stampsThisHour} more this hour to make ${hourLabel(now.getHours() + 1)} a bonus hour`}
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

        {showHours && (
          <div className="mob-modal-wrap" role="dialog" aria-modal="true">
            <div className="mob-modal">
              <div className="mob-card-label">
                <span>Today's hours</span>
                <button className="mob-icon-btn corner" onClick={() => setShowHours(false)} aria-label="Close">×</button>
              </div>
              {/* Midnight to midnight, every hour listed whether or not
                  anything was recorded in it — a blank hour is an answer. */}
              {/* Only the hours that hold something, plus the one being
                  worked — a fixed run of twenty-four rows is mostly empty
                  and pushes the total off the screen. */}
              <div className="mob-hourlist">
                {hourRows.length === 0 && (
                  <div className="mob-sub">Nothing recorded yet today.</div>
                )}
                {hourRows.map((h) => (
                  <div className={`mob-hourrow ${h.current ? 'now' : ''}`} key={h.hour}>
                    <span className="mob-hourrow-when">
                      {hourLabel(h.hour)} – {hourLabel(h.hour + 1)}
                      {h.current && <span className="mob-chip">now</span>}
                    </span>
                    <span className="mob-hourrow-sum">
                      {h.count === 0 ? (
                        <span className="muted">·</span>
                      ) : (
                        <>
                          <span className="mob-station-meta">{h.breakdown}</span>
                          <span className="mob-entry-amt">{RM(h.amount)}</span>
                        </>
                      )}
                    </span>
                  </div>
                ))}
                <div className="mob-breakrow total">
                  <span>Today total · {hourRows.reduce((n, h) => n + h.count, 0)} recorded</span>
                  <span className="mob-entry-amt">{RM(hoursTotal)}</span>
                </div>
                            </div>
            </div>
          </div>
        )}

    </>
  )
}

/* ------------------------------------------------------------------ */
/* Today's attendance, at the head of the Record tab. Clocking in is    */
/* the first thing done on a shift and the record screen is where the   */
/* day's work is entered, so the two belong on one page.                */
/*                                                                      */
/* Clocking IN is witnessed: the camera opens on the front lens, the    */
/* phone is asked where it is, and the time is the one stamped on that  */
/* photo — so a stamp is a selfie at a place at a moment, not a tap.    */
/* Confirming is a separate press, because the shot that opens          */
/* automatically is rarely the one worth keeping.                       */
/*                                                                      */
/* Clocking OUT is one tap. The selfie is there to prove somebody       */
/* arrived; nobody fakes leaving.                                       */
/*                                                                      */
/* Once the day is stamped the card folds down to a clock chip, with    */
/* the week's ticks behind the history button beside it — the Record    */
/* tab is for recording work, and attendance has had its moment.        */
/* ------------------------------------------------------------------ */

/**
 * A stamp waiting on its confirm press: the photo, where, and when.
 *
 * Both ends of a shift go through this. Clocking out is as much a claim
 * about being somewhere as clocking in — the hours between them are what
 * gets paid — so it is witnessed the same way.
 */
interface PendingStamp {
  /** Which end of the shift this is. */
  kind: 'in' | 'out'
  /** The shift being closed; only set when clocking out. */
  shiftId?: string
  file: File
  preview: string
  at: string
  coords: { lat: number; lng: number; accuracy: number } | null
  locating: boolean
  locationError: string | null
}

/** Ask the phone where it is. Never rejects — refusing is an answer. */
function getCoords(): Promise<{ lat: number; lng: number; accuracy: number } | null> {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null)
    navigator.geolocation.getCurrentPosition(
      (p) =>
        resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 30_000 },
    )
  })
}

/** "4h 22m" — a shift length as it would be said out loud. */
function spanLabel(fromISO: string, toISO: string) {
  const mins = Math.max(0, Math.round((new Date(toISO).getTime() - new Date(fromISO).getTime()) / 60_000))
  const h = Math.floor(mins / 60)
  return h > 0 ? `${h}h ${mins % 60}m` : `${mins}m`
}

function ClockCard({
  profileId,
  station,
  onError,
}: {
  profileId: string | null
  station: Station | null
  onError: (m: string | null) => void
}) {
  const stationId = station?.id ?? null
  // Every stamp of the last seven days, so today's card and the week
  // strip read from one load.
  const [shifts, setShifts] = useState<Shift[]>([])
  const [busy, setBusy] = useState(false)
  const [pending, setPending] = useState<PendingStamp | null>(null)
  // Which end of the shift the camera was opened for — the file comes
  // back from the input with no memory of why it was asked for.
  const aiming = useRef<{ kind: 'in' | 'out'; shiftId?: string }>({ kind: 'in' })
  // Folded down once the day has been stamped, and opened again by the
  // clock chip when it is time to clock out.
  const [open, setOpen] = useState(false)
  const [showWeek, setShowWeek] = useState(false)
  // The day tapped on the week strip — its float shows the ins and outs.
  const [dayInfo, setDayInfo] = useState<string | null>(null)
  const camera = useRef<HTMLInputElement>(null)

  const today = todayISO()
  const weekAgo = useMemo(() => {
    const d = new Date()
    d.setDate(d.getDate() - 6)
    return dayISO(d)
  }, [])

  useEffect(() => {
    if (!profileId) return
    let cancelled = false
    supabase
      .from('operation_attendance')
      .select('id, work_date, clock_in, clock_out')
      .eq('user_id', profileId)
      .gte('work_date', weekAgo)
      .order('clock_in')
      .then(({ data }) => {
        if (!cancelled && data) setShifts(data as Shift[])
      })
    return () => {
      cancelled = true
    }
  }, [profileId, weekAgo])

  const todays = shifts.filter((s) => (s.work_date ?? today) === today)
  // The shift still running, if any. Its absence is what makes the button
  // read "Clock in" rather than "Clock out".
  const running = todays.find((s) => s.clock_out == null) ?? null
  const closed = todays.filter((s) => s.clock_out != null)
  const hoursToday = closed.reduce(
    (t, s) => t + (new Date(s.clock_out!).getTime() - new Date(s.clock_in).getTime()) / 3_600_000,
    0,
  )
  // Nothing stamped yet is the one state that has to stay open — there is
  // no chip worth folding down to.
  const expanded = open || todays.length === 0 || pending != null

  /* -- the week strip: one column per day, ticked once it is stamped -- */
  const week = useMemo(() => {
    const days: { label: string; iso: string }[] = []
    const monday = new Date()
    monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7))
    for (let i = 0; i < 7; i++) {
      const d = new Date(monday)
      d.setDate(monday.getDate() + i)
      days.push({ label: d.toLocaleDateString(undefined, { weekday: 'narrow' }), iso: dayISO(d) })
    }
    return days.map((d) => {
      const rows = shifts.filter((s) => (s.work_date ?? '') === d.iso)
      const mins = rows.reduce(
        (t, s) =>
          t +
          (s.clock_out
            ? (new Date(s.clock_out).getTime() - new Date(s.clock_in).getTime()) / 60_000
            : 0),
        0,
      )
      const worked = rows.some((s) => s.clock_out != null)
      const h = Math.floor(mins / 60)
      return {
        ...d,
        stamped: rows.length > 0,
        running: rows.some((s) => s.clock_out == null),
        // The time worked is the answer once both ends are stamped; until
        // then the day is ticked but still open.
        span: worked ? (h > 0 ? `${h}h ${Math.round(mins % 60)}m` : `${Math.round(mins)}m`) : null,
      }
    })
  }, [shifts, today])

  /* --------------------------- clocking ---------------------------- */

  // The camera comes back with a file; where and when are settled at the
  // same moment, so the confirm screen can show all three together.
  function openCamera(kind: 'in' | 'out', shiftId?: string) {
    aiming.current = { kind, shiftId }
    camera.current?.click()
  }

  async function tookSelfie(file: File | undefined) {
    if (!file) return
    onError(null)
    const at = new Date().toISOString()
    setPending({
      ...aiming.current,
      file,
      preview: URL.createObjectURL(file),
      at,
      coords: null,
      locating: true,
      locationError: null,
    })
    const coords = await getCoords()
    setPending((p) =>
      p == null
        ? p
        : {
            ...p,
            coords,
            locating: false,
            locationError: coords ? null : 'Location unavailable — stamping without it.',
          },
    )
  }

  function discard() {
    if (pending) URL.revokeObjectURL(pending.preview)
    setPending(null)
    if (camera.current) camera.current.value = ''
  }

  /** Both ends land the same way: photo up first, then the stamp. */
  async function confirmStamp() {
    if (!profileId || !pending || busy) return
    setBusy(true)
    onError(null)
    // The photo is uploaded first: a stamp with no selfie behind it is
    // exactly what the selfie is there to prevent.
    let photoPath: string | null = null
    try {
      const photo = await compressImage(pending.file)
      const stamp = pending.at.replace(/[:.]/g, '-')
      const path = `attendance/${profileId}-${pending.kind}-${stamp}.jpg`
      const { error: upErr } = await supabase.storage
        .from('records')
        .upload(path, photo, { contentType: 'image/jpeg' })
      if (upErr) throw new Error(upErr.message)
      photoPath = path
    } catch (e) {
      onError(`Selfie did not upload: ${(e as Error).message}`)
    }
    const where = {
      latitude: pending.coords?.lat ?? null,
      longitude: pending.coords?.lng ?? null,
      accuracy_m: pending.coords?.accuracy ?? null,
    }

    if (pending.kind === 'out') {
      const id = pending.shiftId
      // A stamp the database never took has no row to close, so it is
      // closed where it lives — on screen.
      if (id && !id.startsWith(LOCAL_SHIFT)) {
        const { error } = await supabase
          .from('operation_attendance')
          .update({
            clock_out: pending.at,
            out_photo_path: photoPath,
            out_latitude: where.latitude,
            out_longitude: where.longitude,
            out_accuracy_m: where.accuracy_m,
          })
          .eq('id', id)
        if (error) onError(clockHelp(error.message))
      }
      setShifts((rows) => rows.map((r) => (r.id === id ? { ...r, clock_out: pending.at } : r)))
    } else {
      const { data, error } = await supabase
        .from('operation_attendance')
        .insert({
          user_id: profileId,
          station_id: stationId,
          work_date: today,
          clock_in: pending.at,
          photo_path: photoPath,
          ...where,
        })
        .select('id, work_date, clock_in, clock_out')
        .single()
      // Not saved is still worth showing: the card stamps so the screen
      // can be walked through, and the message says exactly why.
      if (error) {
        onError(clockHelp(error.message))
        setShifts((rows) => [
          ...rows,
          { id: `${LOCAL_SHIFT}-${rows.length}`, work_date: today, clock_in: pending.at, clock_out: null },
        ])
      } else {
        setShifts((rows) => [...rows, data as Shift])
      }
    }
    discard()
    setBusy(false)
    setOpen(false)
  }

  /* ---------------------------- drawing ---------------------------- */

  const blank = <span className="t empty">--:--</span>
  const clockIcon = (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  )

  /**
   * A tapped day, told in full — every in and out it holds, in order.
   *
   * A day is not one pair. Somebody who goes home for lunch and comes
   * back has stamped twice, and showing only the first in and the last
   * out would quietly pay them for the gap. Each pair is listed, and the
   * hours are the pairs added up.
   */
  function dayDetail(iso: string) {
    const rows = shifts
      .filter((s) => (s.work_date ?? '') === iso)
      .sort((a, b) => a.clock_in.localeCompare(b.clock_in))
    const mins = rows.reduce(
      (t, s) =>
        t + (s.clock_out ? (new Date(s.clock_out).getTime() - new Date(s.clock_in).getTime()) / 60_000 : 0),
      0,
    )
    const h = Math.floor(mins / 60)
    return {
      rows,
      span: mins > 0 ? (h > 0 ? `${h}h ${Math.round(mins % 60)}m` : `${Math.round(mins)}m`) : null,
    }
  }

  const weekStrip = (
    <div className="mob-weekwrap">
      <div className="mob-weekstrip">
        {week.map((d) => (
          <button
            type="button"
            className={`mob-weekday ${d.iso === today ? 'today' : ''} ${dayInfo === d.iso ? 'picked' : ''}`}
            key={d.iso}
            onClick={() => setDayInfo((cur) => (cur === d.iso ? null : d.iso))}
          >
            <span className="d">{d.label}</span>
            <span className={`mark ${d.stamped ? (d.running ? 'running' : 'ok') : ''}`}>
              {d.stamped ? (d.running ? '•' : '✓') : '·'}
            </span>
            <span className="h">{d.span ?? (d.running ? 'in' : '')}</span>
          </button>
        ))}
      </div>
      {dayInfo && (() => {
        const d = dayDetail(dayInfo)
        return (
          <div className="mob-dayfloat">
            <div className="mob-dayfloat-head">
              <span className="mob-dayfloat-date">
                {new Date(dayInfo + 'T00:00:00').toLocaleDateString(undefined, {
                  weekday: 'long', day: 'numeric', month: 'short',
                })}
              </span>
              <button
                type="button"
                className="mob-dayfloat-x"
                onClick={() => setDayInfo(null)}
                aria-label="Close"
              >
                ✕
              </button>
            </div>
            {d.rows.length === 0 ? (
              <div className="mob-row">
                <span className="mob-field-label">Clock in</span>
                <span>—</span>
              </div>
            ) : (
              d.rows.map((r, i) => (
                <div className="mob-row" key={r.id}>
                  {/* The number is only worth printing when there is more
                      than one pair to tell apart. */}
                  <span className="mob-field-label">
                    {d.rows.length > 1 ? `${i + 1}. ` : ''}In · out
                  </span>
                  <span>
                    {clockTime(r.clock_in)} –{' '}
                    {r.clock_out ? clockTime(r.clock_out) : 'still in'}
                  </span>
                </div>
              ))
            )}
            <div className="mob-row">
              <span className="mob-field-label">Work hours</span>
              <span>{d.span ?? '—'}</span>
            </div>
          </div>
        )
      })()}
    </div>
  )

  /* The confirm screen: the shot, where it was taken, and when — then
     one press to turn all three into a stamp. */
  if (pending) {
    return (
      <div className="mob-card">
        <div className="mob-card-label">
          {pending.kind === 'out' ? 'Confirm clock out' : 'Confirm clock in'}
        </div>
        <img className="mob-selfie" src={pending.preview} alt="Attendance selfie" />
        <div className="mob-row">
          <span className="mob-field-label">Time</span>
          <span>{clockTime(pending.at)} · {new Date(pending.at).toLocaleDateString()}</span>
        </div>
        <div className="mob-row">
          <span className="mob-field-label">Location</span>
          <span>
            {pending.locating
              ? 'Finding…'
              : pending.coords
                ? `${pending.coords.lat.toFixed(5)}, ${pending.coords.lng.toFixed(5)}`
                : '—'}
          </span>
        </div>
        {pending.coords && (
          <div className="mob-row">
            <span className="mob-field-label">Accuracy</span>
            <span>±{Math.round(pending.coords.accuracy)} m</span>
          </div>
        )}
        {/* The stamp against the station's preset coordinate (set in
            Settings → Station tags). Advisory: an away stamp still lands,
            marked as away — refusing it only teaches people to switch
            location off. */}
        {(() => {
          const check = stationLocationCheck(station, pending.coords)
          if (!check) return null
          return (
            <div className="mob-row">
              <span className="mob-field-label">Station check</span>
              <span style={{ color: check.ok ? '#15803d' : '#b45309', fontWeight: 700 }}>
                {check.ok
                  ? `✓ At ${station!.name} (${distanceLabel(check.distance)} away)`
                  : `⚠ ${distanceLabel(check.distance)} from ${station!.name}`}
              </span>
            </div>
          )
        })()}
        {pending.locationError && <div className="mob-sub">{pending.locationError}</div>}
        <div className="mob-actions">
          <button className="mob-mini ghost" onClick={discard} disabled={busy}>Retake</button>
          <button className="mob-mini go" onClick={confirmStamp} disabled={busy || pending.locating}>
            {busy ? 'Saving…' : pending.kind === 'out' ? 'Confirm clock out' : 'Confirm clock in'}
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="mob-card">
      <input
        ref={camera}
        type="file"
        accept="image/*"
        capture="user"
        hidden
        onChange={(e) => tookSelfie(e.target.files?.[0])}
      />

      {/* Folded down: the clock chip says where the day stands, and the
          history button beside it opens the week. */}
      {!expanded ? (
        <div className="mob-clockmini">
          {running ? (
            <>
              {/* The stamp already made, and the one still to make — the
                  out is a button because it is the next thing done. */}
              <button className="mob-clockpair" onClick={() => setOpen(true)} title="Open today's attendance">
                <span className="mob-field-label">Clock in :</span>
                <span className="t">{clockTime(running.clock_in)}</span>
              </button>
              <span className="mob-clockpair as-row">
                <span className="mob-field-label">Clock out :</span>
                <button
                  className="mob-clockoutmini"
                  onClick={() => openCamera('out', running.id)}
                  disabled={busy || !profileId}
                >
                  {busy ? 'Saving…' : 'Clock out'}
                </button>
              </span>
            </>
          ) : (
            <button className="mob-clockchip" onClick={() => setOpen(true)}>
              {clockIcon}
              <span>{hoursToday.toFixed(2)} h today</span>
            </button>
          )}
          <button
            className={`mob-icon-btn week-toggle ${showWeek ? 'on' : ''}`}
            onClick={() => {
              setShowWeek((v) => !v)
              setDayInfo(null)
            }}
            title="This week's attendance"
            aria-label="This week's attendance"
            aria-expanded={showWeek}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 9l7 6 7-6" />
            </svg>
          </button>
        </div>
      ) : (
        <>
          <div className="mob-card-label">Today's attendance</div>
          <div className="mob-sub">
            {new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' })}
          </div>

          {todays.length === 0 ? (
            <div className="mob-clockrow">
              <div className="mob-clockcell">
                <span className="mob-field-label">Clock in</span>
                {blank}
              </div>
              <div className="mob-clockcell">
                <span className="mob-field-label">Clock out</span>
                {blank}
              </div>
            </div>
          ) : (
            todays.map((s, i) => (
              <div className={`mob-clockrow ${s.clock_out ? '' : 'open'}`} key={s.id}>
                <div className="mob-clockcell">
                  <span className="mob-field-label">
                    {todays.length > 1 ? `${i + 1}. ` : ''}Clock in
                  </span>
                  <span className="t">{clockTime(s.clock_in)}</span>
                </div>
                <div className="mob-clockcell">
                  <span className="mob-field-label">
                    Clock out
                    {s.clock_out && <em> · {spanLabel(s.clock_in, s.clock_out)}</em>}
                  </span>
                  {s.clock_out ? <span className="t">{clockTime(s.clock_out)}</span> : blank}
                </div>
              </div>
            ))
          )}

          <button
            className={`mob-clockbtn ${running ? 'out' : ''}`}
            onClick={() => (running ? openCamera('out', running.id) : openCamera('in'))}
            disabled={busy || !profileId}
          >
            {clockIcon}
            {busy ? 'Saving…' : running ? 'Clock out — take a selfie' : 'Clock in — take a selfie'}
          </button>

          {closed.length > 0 && (
            <div className="mob-breakrow total">
              <span>Hours today</span>
              <span className="mob-entry-amt">{hoursToday.toFixed(2)} h</span>
            </div>
          )}

          {todays.length > 0 && (
            <button className="mob-linkrow" onClick={() => setOpen(false)}>Hide</button>
          )}
        </>
      )}

      {/* The week reads the same either way — always under the open card,
          and behind the history button when it is folded down. */}
      {(expanded || showWeek) && weekStrip}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* WORK DONE TODAY — the run of ticks under the clock card.            */
/*                                                                      */
/* One tick per work record submitted today at this station, filling    */
/* left to right against the station's daily target (Settings → Station */
/* tags → Daily target). A record counts the moment it is submitted,    */
/* approved or not: this says how much work has been DONE, and waiting  */
/* on somebody else's verification is not a reason to have done less.   */
/*                                                                      */
/* No target set is a fair answer too — then it simply counts, with     */
/* nothing to fill up.                                                  */
/* ------------------------------------------------------------------ */

/** Past this many, a row of ticks stops reading as a count. */
const TICK_LIMIT = 12

function WorkDoneCard({
  bare = false,
  profileId,
  station,
  reloadKey,
}: {
  /** Render the figures alone, to sit inside another card. */
  bare?: boolean
  profileId: string | null
  station: Station | null
  reloadKey: number
}) {
  const [done, setDone] = useState(0)

  useEffect(() => {
    if (!profileId || !station) return
    let cancelled = false
    const load = () =>
      supabase
        .from('operation_entries')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', profileId)
        .eq('station_id', station.id)
        .eq('work_date', todayISO())
        .then(({ count }) => {
          if (!cancelled) setDone(count ?? 0)
        })
    load()
    // An hourly station's records are not written when the photo is taken
    // — they are made when the hour closes, by the sweep running at the
    // top of this view. Nothing tells this card when that happens, so it
    // asks again rather than sitting on a stale count.
    const t = setInterval(load, 30_000)
    return () => {
      cancelled = true
      clearInterval(t)
    }
  }, [profileId, station?.id, reloadKey])

  if (!station) return null
  const target = station.daily_target ?? null
  const pct = target ? Math.min(100, (done / target) * 100) : 0
  const met = target != null && done >= target

  const body = (
    <>
      {target == null ? (
        <div className="mob-stat">{done}</div>
      ) : target <= TICK_LIMIT ? (
        <div className="stamp-row light">
          {Array.from({ length: target }, (_, i) => (
            <span className={`stamp ${i < done ? 'done' : ''}`} key={i}>✓</span>
          ))}
          {done > target && <span className="stamp extra">+{done - target}</span>}
        </div>
      ) : (
        /* Forty ticks is a wall, not a count — the same number said as a
           bar instead. */
        <div className="mob-bartrack">
          <div className={met ? 'best' : ''} style={{ width: `${pct}%` }} />
        </div>
      )}

      {/* With no target there is nothing to say that the figure above
          does not already say. */}
      {target != null && (
        <div className="mob-sub">
          {met ? `${done} of ${target} — target met ✨` : `${done} of ${target} recorded today`}
        </div>
      )}
    </>
  )

  if (bare) return body
  return (
    <div className="mob-card">
      <div className="mob-card-label">Work done today</div>
      {body}
    </div>
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
  ladderFor,
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
  ladderFor: (jobId: string) => number[]
  canEntry: boolean
  jobColumnReady: boolean
  onError: (m: string | null) => void
}) {
  const [myStationId, setMyStationId] = useState('')
  const [detail, setDetail] = useState<ProductionEntry | null>(null)
  // The screen behind the clock button: everything already submitted,
  // by range. The form itself stays clean.
  const [view, setView] = useState<'form' | 'history'>('form')
  const [stationId, setStationId] = useState('')
  const [jobId, setJobId] = useState('')
  const [qty, setQty] = useState('')
  // Photos ARE the record now: one entry, one photo per unit of work, so
  // there is nothing to type.
  const [photos, setPhotos] = useState<File[]>([])
  const [submitting, setSubmitting] = useState(false)
  // Bumped by anything that lands a record, so the tick card counts again
  // without the whole tab being rebuilt around a shared list.
  const [recorded, setRecorded] = useState(0)
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

  // Nothing to choose at station level — the form is already on the right
  // station before it is opened.
  useEffect(() => {
    if (atStationLevel && ownStation && stationId !== ownStation.id) setStationId(ownStation.id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [atStationLevel, ownStation?.id])

  // Jobs at the chosen station this TIER may record — own tier and below
  // (a job with no tag is open to everyone). Only contracts ticked as a
  // JOB RECORD are offered: incentives and other support rates are priced
  // for payroll but are not a record anyone submits.
  const tierOf = (gid: string | null) => grades.find((g) => g.id === gid)?.sort_order
  const stationJobs = onePerWork(
    jobs.filter(
      (j) =>
        j.station_id === stationId &&
        j.active &&
        j.record_job !== false &&
        (!j.grade_id || tier == null || (tierOf(j.grade_id) ?? 99) >= tier.sort_order),
    ),
    tier,
    grades,
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
      .from('operation_entries')
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
        .from('operation_entries')
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
              .from('operation_photos')
              .insert({ station_id: stationId, photo_path: path, entry_id: data.id })
          }
        }
      }
      setJobId('')
      setQty('')
      setDutyShift('')
      setPhotos([])
      setRecorded((n) => n + 1)
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
                  ladderFor={ladderFor}
        onBack={() => setDetail(null)}
      />
    )
  }

  // Operators record work by taking photos at their own station, merged
  // directly into this tab — no manual station/job/quantity form.
  const isOperator = tier?.name === 'Operator'
  const myStation = myStations.find((s) => s.id === myStationId) ?? myStations[0] ?? null

  if (view === 'history') {
    return (
      <RecordHistory
        profileId={profileId}
        stations={stations}
        jobs={jobs}
        amountFor={amountFor}
        canEdit={effectiveCapabilities(tier).includes('edit-entry')}
        myStations={myStations}
        onOpen={setDetail}
        onBack={() => setView('form')}
      />
    )
  }

  if (isOperator) {
    return (
      <>
        <div className="mob-header">
          <span className="mob-brand">MJM</span>
        </div>

        <div className="mob-body">
          <div className="mob-rolebar">
            <div>
              <div className="mob-role">New Work Record</div>
              {myStation && <div className="mob-sub">{myStation.name}</div>}
            </div>
            <button
              className="mob-icon-btn"
              onClick={() => setView('history')}
              title="Work record history"
              aria-label="Work record history"
            >
              <IconHistory />
            </button>
          </div>

          {isEntitled(tier, 'clock-in-out', grades) && (
            <ClockCard
              profileId={profileId}
              station={myStation ?? null}
              onError={onError}
            />
          )}

          {/* "Work done today" now heads the work panel itself, so it is
              only drawn here when there is no panel to head. */}
          {(!canEntry || myStations.length === 0) && (
            <WorkDoneCard profileId={profileId} station={myStation} reloadKey={recorded} />
          )}

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
                  ladderFor={ladderFor}
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
      </div>

      <div className="mob-body">
        <div className="mob-rolebar">
          <div className="mob-role">New Work Record</div>
          <button
            className="mob-icon-btn"
            onClick={() => setView('history')}
            title="Work record history"
            aria-label="Work record history"
          >
            <IconHistory />
          </button>
        </div>

        {isEntitled(tier, 'clock-in-out', grades) && (
          <ClockCard
            profileId={profileId}
            station={ownStation ?? null}
            onError={onError}
          />
        )}

{/* The target dashboards this station's ticks switch on — the
            plain record form gets them just like the hourly panel. */}
        {ownStation && <StationTargetCards station={ownStation} profileId={profileId} />}

        <WorkDoneCard
          profileId={profileId}
          station={stations.find((x) => x.id === stationId) ?? ownStation}
          reloadKey={recorded}
        />

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
              {/* The list is the job names alone — the rate arithmetic
                  belongs to the breakdown below, not to the choosing. */}
              {stationJobs.map((j) => (
                <option key={j.id} value={j.id}>{j.name}</option>
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
                        : breakdownFor(rateFor, tier2RateFor, ladderFor, jobId, pulledQty)}
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
                          : breakdownFor(rateFor, tier2RateFor, ladderFor, jobId, Number(qty))}
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
                    <span>{breakdownFor(rateFor, tier2RateFor, ladderFor, jobId, photos.length)}{job.unit}</span>
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

      </div>
    </>
  )
}

/* ------------------------------------------------------------------ */
/* Work record history — behind the clock button beside the New Work   */
/* Record title. Opens on today's submissions; the ranges widen from   */
/* there. Tapping a row opens the full submitted record.               */
/* ------------------------------------------------------------------ */

function RecordHistory({
  profileId,
  stations,
  jobs,
  amountFor,
  canEdit,
  station = null,
  myStations = [],
  initialRange = 'today',
  onOpen,
  onBack,
}: {
  profileId: string | null
  stations: Station[]
  jobs: Job[]
  amountFor: (jobId: string, quantity: number) => number
  /** The tier's Edit tick (Work entry setting) — without it, no pencil. */
  canEdit: boolean
  /**
   * Whose history this is. Without a station it is YOUR records, reached
   * from "My work done". With one — the › beside a station on the Output
   * record — it is everything recorded AT that station, whoever did it,
   * and the screen is headed with the station's name.
   */
  station?: Station | null
  /**
   * The viewer's OWN station tags, for when the records cannot say where
   * they were done — a day with nothing submitted has no station in it,
   * and that is exactly the day the question gets asked.
   */
  myStations?: Station[]
  /**
   * The window to open on. Coming from the Output record it is the one
   * that was being read there — clicking through from "30 days" and
   * landing on "Today" throws the question away and makes the numbers
   * look wrong.
   */
  initialRange?: DayRange
  onOpen: (e: ProductionEntry) => void
  onBack: () => void
}) {
  const [rangeKey, setRangeKey] = useState<HistoryRange>(
    RANGE_FROM_OUTPUT[initialRange] ?? 'today',
  )
  // The earlier-months list, folded away behind the history icon.
  const [showMonths, setShowMonths] = useState(false)
  const months = useMemo(recentMonths, [])
  const pickedMonth = months.find((m) => m.key === rangeKey) ?? null
  const [rows, setRows] = useState<ProductionEntry[]>([])
  const [loading, setLoading] = useState(true)
  // The entry whose pencil was tapped, and the number being retyped.
  const [editing, setEditing] = useState<ProductionEntry | null>(null)
  const [editQty, setEditQty] = useState('')
  const [editErr, setEditErr] = useState<string | null>(null)
  const [savingEdit, setSavingEdit] = useState(false)

  // Only work still in (or thrown out of) the queue may be reworked —
  // an approved number is settled.
  const editable = (e: ProductionEntry) =>
    canEdit && ['pending', 'rejected', undefined].includes(e.approval_status as never)

  async function saveEdit() {
    if (!editing) return
    const qty = Number(editQty)
    if (editQty.trim() === '' || !Number.isFinite(qty) || qty <= 0) {
      return setEditErr('Work done must be a positive number.')
    }
    setSavingEdit(true)
    setEditErr(null)
    // A fixed entry goes back through verify and approve.
    const { data, error } = await supabase
      .from('operation_entries')
      .update({
        quantity: qty,
        approval_status: 'pending',
        verified_by: null,
        verified_at: null,
        approved_by: null,
        approved_at: null,
      } as never)
      .eq('id', editing.id)
      .select('id')
    setSavingEdit(false)
    if (error) return setEditErr(error.message)
    if (!data || data.length === 0) {
      return setEditErr('The database would not let you edit this entry.')
    }
    setRows((rs) =>
      rs.map((r) =>
        r.id === editing.id
          ? { ...r, quantity: qty, approval_status: 'pending', verified_by: null, approved_by: null }
          : r,
      ),
    )
    setEditing(null)
  }

  useEffect(() => {
    if (!station && !profileId) return
    // A finished month has an end as well as a start, so the window is
    // read as a pair rather than as "everything since".
    const { from, to } = historyWindow(rangeKey)
    setLoading(true)
    let q = supabase
      .from('operation_entries')
      .select('*')
      .gte('work_date', from)
      .lte('work_date', to)
    // Station mode reads the whole station; personal mode reads your rows.
    q = station ? q.eq('station_id', station.id) : q.eq('user_id', profileId!)
    q.order('created_at', { ascending: false })
      .limit(200)
      .then(({ data }) => {
        setRows(data ?? [])
        setLoading(false)
      })
  }, [profileId, rangeKey, station])

  const stationName = (id: string) => stations.find((s) => s.id === id)?.name ?? '?'
  const jobName = (id: string) => jobs.find((j) => j.id === id)?.name ?? 'Work'

  /**
   * Which station these records are from. A station's own history knows
   * already; YOUR history did not say at all, and "Work Record History"
   * over a list of jobs left the question hanging — so it is read off the
   * records themselves. Most people work one station and get its name;
   * anyone who does not gets the count, which is the honest answer.
   */
  const spanned = [...new Set(rows.map((e) => e.station_id))]
  const named = (n: number, one: () => string) =>
    n === 1 ? one() : n > 1 ? `${n} stations` : null
  const headStation = station
    ? station.name
    : // The records first — they are what is on the screen. An empty
      // range says nothing about where you work, so the station tags
      // answer instead, and only a person with no tag at all gets silence.
      named(spanned.length, () => stationName(spanned[0])) ??
      named(myStations.length, () => myStations[0].name) ??
      // Nobody tagged to a station is not scoped to one, which the
      // Profile tab already words this way.
      'All Stations'

  return (
    <>
      <div className="mob-header">
        <span className="mob-brand">MJM</span>
      </div>

      <div className="mob-body">
        <MobSubHeader title="Work Record History" onBack={onBack} />
        {/* The station, with the way back through earlier months beside
            it — three columns, so the name stays centred on the screen
            rather than on the space left over next to the button. */}
        <div className="mob-histhead">
          <span className="mob-card-label centred">{headStation}</span>
          <button
            className={`mob-icon-btn ${showMonths ? 'on' : ''}`}
            onClick={() => setShowMonths((v) => !v)}
            title="Earlier months"
            aria-label="Earlier months"
            aria-expanded={showMonths}
          >
            <IconHistory />
          </button>
        </div>

        {/* The same picker as the Output record — one window question,
            asked the same way wherever it is asked. */}
        <div className="mob-queue-chips" role="tablist">
          {HISTORY_RANGES.map((r) => (
            <button
              key={r.key}
              role="tab"
              aria-selected={rangeKey === r.key}
              className={rangeKey === r.key ? 'on' : ''}
              onClick={() => {
                setRangeKey(r.key)
                setShowMonths(false)
              }}
            >
              {r.label}
            </button>
          ))}
        </div>

        {/* Opened by the icon, or held open by the month being read — a
            picked month with its own list folded away would leave the
            three chips all dark and nothing saying why. */}
        {(showMonths || pickedMonth) && (
          <div className="mob-queue-chips">
            {months.map((m) => (
              <button
                key={m.key}
                className={rangeKey === m.key ? 'on' : ''}
                onClick={() => {
                  setRangeKey(m.key)
                  setShowMonths(false)
                }}
              >
                {m.label}
              </button>
            ))}
          </div>
        )}

        <div className="mob-card">
          {loading ? (
            <div className="mob-sub">Loading…</div>
          ) : rows.length === 0 ? (
            <div className="mob-empty">Nothing in list</div>
          ) : (
            rows.map((e) =>
              editing?.id === e.id ? (
                <div className="mob-entry-edit" key={e.id}>
                  <span className="mob-entry-name">{jobName(e.job_id)}</span>
                  {editErr && <div className="error">{editErr}</div>}
                  <div className="mob-entry-edit-row">
                    <input
                      className="mob-input"
                      inputMode="decimal"
                      value={editQty}
                      onChange={(ev) => setEditQty(ev.target.value)}
                      aria-label="Work done"
                      autoFocus
                    />
                    <button className="mob-mini ghost" onClick={() => setEditing(null)}>Cancel</button>
                    <button className="mob-mini go" disabled={savingEdit} onClick={saveEdit}>
                      {savingEdit ? 'Saving…' : 'Save'}
                    </button>
                  </div>
                  <div className="mob-station-meta">Saving sends it for verification again.</div>
                </div>
              ) : (
                <div className="mob-entry-wrap" key={e.id}>
                  <button className="mob-entry" onClick={() => onOpen(e)}>
                    <span className="mob-entry-main">
                      <span className="mob-entry-name">{jobName(e.job_id)}</span>
                      {/* The station is named once, over the list. Saying
                          it again on every row only squeezes the job. */}
                      <span className="mob-station-meta">
                        {spanned.length > 1 ? `${stationName(e.station_id)} · ` : ''}
                        {new Date(e.work_date + 'T00:00:00').toLocaleDateString(undefined, {
                          day: '2-digit', month: 'short',
                        })}
                      </span>
                    </span>
                    <span className="mob-entry-side">
                      <span className="mob-entry-amt">{amountFor(e.job_id, e.quantity).toFixed(2)}</span>
                      {statusChip(e.approval_status)}
                    </span>
                  </button>
                  {editable(e) && (
                    <button
                      className="mob-entry-pen"
                      title="Edit this record"
                      aria-label={`Edit ${jobName(e.job_id)}`}
                      onClick={() => {
                        setEditing(e)
                        setEditQty(String(Number(e.quantity)))
                        setEditErr(null)
                      }}
                    >
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                        strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
                      </svg>
                    </button>
                  )}
                </div>
              ),
            )
          )}
        </div>
      </div>
    </>
  )
}

/** The history mark: a clock face swept by a turning-back arrow. */
function IconHistory() {
  return (
    <svg
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 12a9 9 0 1 0 2.6-6.4" />
      <path d="M3 4v4h4" />
      <path d="M12 8v4l3 2" />
    </svg>
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
  ladderFor,
  onBack,
  workerTier,
  decide,
}: {
  entry: ProductionEntry
  myName: string
  tier: Grade | null
  stations: Station[]
  jobs: Job[]
  rateFor: (jobId: string) => number
  amountFor: (jobId: string, quantity: number) => number
  tier2RateFor: (jobId: string) => number | null
  ladderFor: (jobId: string) => number[]
  onBack: () => void
  /** The tier tag of whoever submitted it — the viewer's own by default. */
  workerTier?: Grade | null
  /** Shown only when the viewer's tag grants the step this record is at. */
  decide?: { canVerify: boolean; canApprove: boolean; busy: boolean; act: (next: 'verified' | 'approved' | 'rejected') => void }
}) {
  const [photos, setPhotos] = useState<PhotoRecord[]>([])
  useEffect(() => {
    supabase
      .from('operation_photos')
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

  const workerTag = workerTier === undefined ? tier : workerTier
  const submittedAt = new Date(entry.created_at)
  const verified = Boolean(entry.verified_by) || status === 'approved'
  const approved = status === 'approved'
  const fmtQty = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1))
  const hhmm = (d: Date) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const rate1 = rateFor(entry.job_id)
  const rate2 = tier2RateFor(entry.job_id)
  const L = ladderFor(entry.job_id)

  // One row per photo where the work was stamped hour by hour, otherwise
  // the entry is the single row. The rate on a row is the tier that unit
  // actually earned.
  const rateAt = (index: number) =>
    rate2 != null ? L[Math.min(index, L.length - 1)] : rate1
  const rows =
    photos.length > 0
      ? photos
          .slice()
          .sort((a, b) => a.taken_at.localeCompare(b.taken_at))
          .map((ph, i) => ({
            key: ph.id,
            time: hhmm(new Date(ph.taken_at)),
            qty: 1,
            rate: rateAt(i),
            url: photoUrl(ph.photo_path),
          }))
      : [{
          key: entry.id,
          time: hhmm(submittedAt),
          qty: entry.quantity,
          rate: rate1,
          url: null as string | null,
        }]

  // The sum, said the way it was worked out: each rate against the units
  // that earned it.
  const calcLines =
    rate2 == null
      ? [{ label: `${fmtQty(entry.quantity)} × ${RM(rate1)}`, value: entry.quantity * rate1 }]
      : ladderBreakdownFrom(L, entry.quantity).map((s) => ({
          label: `${fmtQty(s.units)} × ${RM(s.rate)}`,
          value: s.units * s.rate,
        }))

  return (
    <>
      <div className="mob-header">
        <span className="mob-brand">MJM</span>
      </div>

      <div className="mob-body">
        <MobSubHeader title="Submitted work record" onBack={onBack} />

        {/* Whose record this is and what it is for. No money here — the
            rate belongs with the parameters it was applied to, and the
            total with the sum that produced it. */}
        <div className="mob-card">
          <div className="mob-entry-name">{station?.name ?? '?'}</div>
          <div className="mob-station-meta">
            {new Date(entry.work_date + 'T00:00:00').toLocaleDateString(undefined, {
              day: 'numeric', month: 'long', year: 'numeric',
            })}
          </div>
          <div className="mob-field-label" style={{ marginTop: '0.35rem' }}>Work by</div>
          <div className="mob-workby">
            <span className="mob-person-name">{myName}</span>
            {workerTag && <span className={`${tagClass(workerTag.color)} sm`}>{workerTag.name}</span>}
          </div>
          <div className="mob-row" style={{ marginTop: '0.2rem' }}>
            <span>{job?.name ?? 'Work'}</span>
            {statusChip(status)}
          </div>
        </div>

        {/* What was actually submitted. Hourly work arrives a photo at a
            time, so each stamp is its own row with the rate it earned —
            the first few in an hour pay the higher tier. The evidence sits
            beside the row it belongs to rather than in a gallery of its
            own. */}
        <div className="mob-card">
          <div className="mob-title">Submitted Work Record</div>
          <div className="mob-paramrows">
            {rows.map((r, i) => (
              <div className="mob-paramrow" key={r.key}>
                <span className="mob-paramrow-time">{r.time}</span>
                <span className="mob-paramrow-qty">
                  {fmtQty(r.qty)} {job ? job.unit.replace('/', '') : ''}
                </span>
                <span className="mob-paramrow-rate">{RM(r.rate)}{job?.unit ?? ''}</span>
                <span className="mob-paramrow-photo">
                  {r.url ? (
                    <a href={r.url} target="_blank" rel="noreferrer">
                      <img className="mob-photo sm" src={r.url} alt={`evidence ${i + 1}`} />
                    </a>
                  ) : (
                    <span className="mob-chip">no photo</span>
                  )}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* The decision sits with the rows it is made on — the quantities,
            the rates and the photo for each one are the evidence, and
            scrolling away from them to act made the two feel unrelated.
            Which button shows follows the viewer's tag and the step this
            record is actually at, never both at once. */}
        {/* An absent button is indistinguishable from a broken one, so the
            reason is stated: your own work, a tag without the permission,
            or a record already past the step you hold. */}
        {decide && (decide.canVerify || decide.canApprove) && (
          <>
            <div className="row-form" style={{ gap: '0.5rem' }}>
              {decide.canVerify && status === 'pending' && (
                <button className="mob-btn approve" style={{ flex: 1 }} disabled={decide.busy}
                  onClick={() => decide.act('verified')}>✓ Verify</button>
              )}
              {decide.canApprove && status === 'verified' && (
                <button className="mob-btn approve" style={{ flex: 1 }} disabled={decide.busy}
                  onClick={() => decide.act('approved')}>✓ Approve</button>
              )}
              {['pending', 'verified'].includes(status) && (
                <button className="mob-btn reject" style={{ flex: 1 }} disabled={decide.busy}
                  onClick={() => decide.act('rejected')}>✗ Reject</button>
              )}
            </div>
          </>
        )}

        <div className="mob-card">
          <div className="mob-title">Calculation</div>
          {calcLines.map((l) => (
            <div className="mob-breakrow" key={l.label}>
              <span>{l.label}</span>
              <span>{l.value.toFixed(2)}</span>
            </div>
          ))}
          <div className="mob-breakrow total">
            <span>Total amount</span>
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
                  {entry.verified_by ? entry.verified_by : status === 'rejected' ? 'Rejected' : verified ? 'Done' : 'Pending'}
                </div>
              </span>
            </div>
            <div className="mob-step">
              <span className={`mob-step-dot ${approved ? 'done' : ''}`} />
              <span>
                <div className="mob-step-name">Final approval</div>
                <div className="mob-station-meta">
                  {entry.approved_by ? entry.approved_by : approved ? 'Done' : 'Waiting'}
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
      .from('operation_photos')
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

/** How far back the approved / rejected history reaches. */
type DateMode = 'today' | 'month' | 'range'

const DATE_MODES: { key: DateMode; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: 'month', label: 'This month' },
  { key: 'range', label: 'Date range' },
]


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
      .from('operation_entries')
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
      {/* Block titles wear the KPI dashboard's card label — small, grey,
          tracked out — so the two tabs read as one family. */}
      {stationPct.length > 0 && (
        <div className="mob-card">
          <div className="mob-card-label">Approval completion by station</div>
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
        <div className="mob-card-label">Exception flags</div>
        {flags.length === 0 && <div className="mob-sub">No exceptions this week.</div>}
        {flags.map((f, i) => (
          <div className={`mob-flag ${f.kind}`} key={i}>
            <div className="mob-flag-title">{f.title}</div>
            <div>{f.text}</div>
          </div>
        ))}
      </div>

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
  ladderFor,
  myEmail,
  initialFilter = 'pending',
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
  ladderFor: (jobId: string) => number[]
  myEmail: string
  /** The bucket to open on, when the Performance tab named one. */
  initialFilter?: WorkFilter
  onError: (m: string | null) => void
}) {
  const [entries, setEntries] = useState<ProductionEntry[]>([])
  // Other people's work waiting on MY action — only loaded for tiers whose
  // tag grants verify or approve.
  const [queue, setQueue] = useState<ProductionEntry[]>([])
  const [names, setNames] = useState<Map<string, string>>(new Map())
  // The submitter's own row, for the tier and station tags on a waiting card.
  const [submitters, setSubmitters] = useState<Map<string, Profile>>(new Map())
  const [photoCount, setPhotoCount] = useState<Map<string, number>>(new Map())
  const [viewPhotos, setViewPhotos] = useState<ProductionEntry | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [filter, setFilter] = useState<WorkFilter>(initialFilter)
  const [detail, setDetail] = useState<ProductionEntry | null>(null)
  // Narrow the list by the submitter's tier — only worth offering when
  // this tier may look at more than its own. Empty is ALL, not none.
  const [tierFilter, setTierFilter] = useState<Set<string>>(new Set())
  // Which station blocks are open. Collapsed is the default: a station
  // head with six stations wants the shape first, the records second.
  const [openStations, setOpenStations] = useState<Set<string>>(new Set())
  // Approved and rejected are a history, so they open on today and widen
  // from there. Pending is a queue and always shows all of it.
  const [dateMode, setDateMode] = useState<DateMode>('today')
  const [fromDate, setFromDate] = useState(todayISO())
  const [toDate, setToDate] = useState(todayISO())

  // Which buttons show is decided by the tag, not the rung: tick verify on
  // a tier and that tier verifies; tick approve and it approves. A tier
  // holding both sees both.
  const caps = effectiveCapabilities(tier)
  // A tier whose Performance tab is given over to the mill dashboard reads
  // the review here instead — the same entitlement, read the other way, so
  // the review can never land on both tabs or on neither.
  const showMill = isEntitled(tier, 'mill-dashboard', grades)
  const canVerify = caps.includes('verify')
  const canApprove = caps.includes('approve')
  // Whose work this tier may look at: the ticks under Operation Module →
  // "View work record of" (Settings → Tier Tag Access Manage). One tier —
  // its own — means there is nothing to filter between.
  const viewableIds = viewableTierIds(tier, grades, 'entry')
  const viewableTiers = grades.filter((g) => viewableIds.includes(g.id))

  async function load() {
    if (!profileId) return
    const mine = await supabase
      .from('operation_entries')
      .select('*')
      .eq('user_id', profileId)
      .order('created_at', { ascending: false })
      .limit(120)
    if (mine.error) onError(mine.error.message)
    const own = (mine.data ?? []) as ProductionEntry[]
    setEntries(own)
    // The signed-in person submitted these, so place them on the ladder
    // too — otherwise their own records fall through the rung test.
    if (profileId) {
      const { data: me } = await supabase
        .from('shared_profiles')
        .select('id, full_name, email, grade_id, station_id, station_ids')
        .eq('id', profileId)
        .maybeSingle()
      if (me) setSubmitters((prev) => new Map(prev).set(profileId, me as Profile))
    }

    // Never your own work — nobody verifies themselves.
    let waiting: ProductionEntry[] = []
    if (canVerify || canApprove) {
      const { data } = await supabase
        .from('operation_entries')
        .select('*')
        .in('approval_status', ['pending', 'verified'])
        .order('created_at', { ascending: true })
      // Whose work this tier may act on is decided by the LADDER: verify
      // and approve reach down the tiers and never sideways or up. Reading
      // it off the account instead meant that previewing a tier could
      // never review anything the previewer had submitted — which, on a
      // demo driven from one login, is most of the records there are.
      const all = (data ?? []) as ProductionEntry[]
      const submitterIds = [...new Set(all.map((e) => e.user_id).filter(Boolean))] as string[]
      let byId = new Map<string, Profile>()
      if (submitterIds.length > 0) {
        const { data: p } = await supabase
          .from('shared_profiles')
          .select('id, full_name, email, grade_id, station_id, station_ids')
          .in('id', submitterIds)
        byId = new Map(((p ?? []) as Profile[]).map((x) => [x.id, x]))
      }
      /**
       * Whose work this tier may look at is one setting, read in one place:
       * Operation Module → "View work record of".
       *
       * There is no exception for the signed-in account's own records. The
       * queue used to let those through whatever tier they came from, so
       * that a demo driven from one login always had something to review —
       * but that put work from ABOVE the previewed tier into its queue,
       * which is the one thing the ladder is there to prevent. A quiet
       * queue is the correct answer when nothing below has been submitted.
       */
      const below = (e: ProductionEntry) => {
        if (tier == null) return false
        const who = e.user_id ? byId.get(e.user_id) : undefined
        return canViewTier(tier, grades, 'entry', who?.grade_id ?? null)
      }
      waiting = all.filter(
        (e) =>
          below(e) &&
          ((canVerify && e.approval_status === 'pending') ||
            (canApprove && e.approval_status === 'verified')),
      )
      setQueue(waiting)
      // Keep EVERY submitter seen, not just the ones still in the queue —
      // the rung test runs against your own records too, and a map that
      // only covers the queue leaves those unplaceable.
      setSubmitters(byId)
      setNames(new Map([...byId.values()].map((x) => [x.id, profileName(x)])))
    }

    // How many photos back each entry, so a row can say so without opening.
    const entryIds = [...own, ...waiting].map((e) => e.id)
    if (entryIds.length > 0) {
      const { data: ph } = await supabase
        .from('operation_photos')
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
      .from('operation_entries')
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
        rejected_by: myEmail,
        verified_by: null,
        verified_at: null,
        approved_by: null,
        approved_at: null,
      })
    }
    const { error } = await supabase.from('operation_entries').update(fields).eq('id', e.id)
    setBusy(null)
    if (error) return onError(error.message)
    load()
  }

  /**
   * May this tier act on that record? Verify and approve reach DOWN the
   * ladder, so the test is the submitter's rung against the reader's —
   * never the account, which on a demo driven from one login excluded
   * nearly everything.
   */
  const reviewable = (e: ProductionEntry) => {
    if (tier == null) return false
    // This page is a preview: one login standing in for every tier. The
    // records to hand were nearly all made by that login, and its own tag
    // may sit anywhere on the ladder — tagged Management, as here, and
    // NOTHING is reviewable from any rung. So while previewing, your own
    // records are open to whichever tier you are standing in. Everyone
    // else's follow the real rule.
    if (e.user_id === profileId) return true
    const who = e.user_id ? submitters.get(e.user_id) : undefined
    const order = who?.grade_id ? grades.find((g) => g.id === who.grade_id)?.sort_order : null
    // An untagged submitter cannot be placed on the ladder; let the tag's
    // permission decide rather than refuse on a missing field.
    if (order == null) return true
    return order > tier.sort_order
  }

  const jobName = (id: string) => jobs.find((j) => j.id === id)?.name ?? 'Work'
  const stationName = (id: string) => stations.find((st) => st.id === id)?.name ?? '?'
  const stat = (e: ProductionEntry) => e.approval_status ?? 'approved'
  // "Pending approval" covers both legs of the flow — waiting for a verify
  // AND verified but waiting for the final approval.
  const inBucket = (e: ProductionEntry, k: WorkFilter) =>
    k === 'pending' ? ['pending', 'verified'].includes(stat(e)) : stat(e) === k
  /** The tier tag of whoever submitted a record. */
  const tierIdOf = (e: ProductionEntry) =>
    (e.user_id ? submitters.get(e.user_id)?.grade_id : null) ?? null
  const matchesTier = (e: ProductionEntry) => {
    if (tierFilter.size === 0) return true
    const id = tierIdOf(e)
    return id != null && tierFilter.has(id)
  }

  // Pending is a queue — all of it, always. Approved and rejected are a
  // history, so they open on today and widen only when asked.
  const dateFrom =
    filter === 'pending' ? null
      : dateMode === 'today' ? todayISO()
        : dateMode === 'month' ? todayISO().slice(0, 8) + '01'
          : fromDate
  const dateTo = filter === 'pending' || dateMode !== 'range' ? todayISO() : toDate
  const inDates = (e: ProductionEntry) =>
    dateFrom === null || (e.work_date >= dateFrom && e.work_date <= dateTo)

  const keep = (e: ProductionEntry) => matchesTier(e) && inDates(e)
  // The chips count what their tab would show, date window included, so a
  // number on a chip and the list behind it can never disagree.
  const count = (k: WorkFilter) => {
    const mine = entries.filter((e) => inBucket(e, k)).filter((x) => matchesTier(x) && (k === 'pending' || inDates(x)))
    // Work waiting on YOU is listed under Pending too, so it is counted
    // there — a chip reading (0) above a card that is plainly pending is
    // the sort of thing that makes a screen untrustworthy.
    return mine.length + (k === 'pending' ? queue.filter(matchesTier).length : 0)
  }
  const shown = entries.filter((e) => inBucket(e, filter)).filter(keep)
  // Someone else's work only ever sits in the pending view — once acted on
  // it leaves the queue entirely.
  const queueShown = filter === 'pending' ? queue.filter(matchesTier) : []

  /**
   * The list, gathered under the station each record belongs to. Somebody
   * standing at one station has no grouping to do, so their records are
   * listed flat; more than one and each station folds, showing its name
   * and how many records are under it until it is opened.
   */
  const stationsInList = [...new Set([...shown, ...queueShown].map((e) => e.station_id))]
  const grouped = stationsInList.length > 1
  const stationBlocks = stations
    .filter((st) => stationsInList.includes(st.id))
    .map((st) => ({
      station: st,
      mine: shown.filter((e) => e.station_id === st.id),
      queue: queueShown.filter((e) => e.station_id === st.id),
    }))

  /** This person's own records. */
  const MyRecordCards = ({ list }: { list: ProductionEntry[] }) => (
    <>
            {list.map((e) => (
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
    </>
  )

  /** Somebody else's work, waiting on this person to verify or approve. */
  const ReviewQueueCards = ({ list }: { list: ProductionEntry[] }) => (
    <>
            {list.map((e) => {
              const who = e.user_id ? submitters.get(e.user_id) : undefined
              const grade = who?.grade_id ? grades.find((g) => g.id === who.grade_id) : undefined
              const tags = who
                ? who.station_ids && who.station_ids.length > 0
                  ? who.station_ids
                  : who.station_id
                    ? [who.station_id]
                    : []
                : []
              return (
                <button type="button" className="mob-review" key={e.id} onClick={() => setDetail(e)}>
                  <span className="mob-review-tags">
                    {tags.length === 0 ? (
                      <span className="tagbadge tag-grey">All stations</span>
                    ) : (
                      tags.map((id) => (
                        <span className="tagbadge tag-grey" key={id}>{stationName(id)}</span>
                      ))
                    )}
                    {grade && <span className={tagClass(grade.color)}>{grade.name}</span>}
                  </span>
                  <span className="mob-review-name">{names.get(e.user_id ?? '') ?? 'Unknown'}</span>
                  <span className="mob-review-line">
                    <span className="mob-station-meta">
                      {new Date(e.work_date + 'T00:00:00').toLocaleDateString(undefined, { day: '2-digit', month: '2-digit' })}
                      {' · '}{jobName(e.job_id)} · {e.quantity}
                    </span>
                    {statusChip(e.approval_status)}
                  </span>
                  <span className="mob-review-go">
                    {(e.approval_status ?? 'pending') === 'pending' ? 'To verify' : 'To approve'} ›
                  </span>
                </button>
              )
            })}
    </>
  )

  if (detail) {
    return (
      <EntryDetail
        entry={detail}
        myName={names.get(detail.user_id ?? '') ?? myName}
        tier={tier}
        stations={stations}
        jobs={jobs}
        rateFor={rateFor}
        amountFor={amountFor}
        tier2RateFor={tier2RateFor}
                  ladderFor={ladderFor}
        onBack={() => setDetail(null)}
        // The submitter's OWN tag, always — showing the previewed tier
        // here made a record look as though it came from the rung doing
        // the looking.
        workerTier={
          grades.find((g) => g.id === submitters.get(detail.user_id ?? '')?.grade_id) ?? null
        }
        decide={
          reviewable(detail) && (canVerify || canApprove)
            ? {
                canVerify,
                canApprove,
                busy: busy === detail.id,
                act: (next) => {
                  const e = detail
                  setDetail(null)
                  act(e, next)
                },
              }
            : undefined
        }
      />
    )
  }

  return (
    <>
      <div className="mob-header">
        <span className="mob-brand">MJM</span>
      </div>

      <div className="mob-body">
        {/* Same head as the KPI dashboard: the title alone, no strapline. */}
        <div className="mob-pagehead">
          <div className="mob-role">My Work Done</div>
        </div>

        {showMill && (
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
          {/* Only worth offering when this tier may look past its own rank
              — one tier means nothing to choose between. */}
          {viewableTiers.length > 1 && (
            <FilterMenu
              title="Tier"
              allLabel="All tiers"
              options={viewableTiers.map((g) => ({ key: g.id, name: g.name, color: g.color }))}
              picked={tierFilter}
              onToggle={(key) =>
                setTierFilter((cur) => {
                  const next = new Set(cur)
                  if (!next.delete(key)) next.add(key)
                  return next
                })
              }
              onAll={() => setTierFilter(new Set())}
            />
          )}
        </div>

        {/* Approved and rejected are a history and open on today. Pending
            is a queue — every item in it is waiting now, so a date window
            would only hide work somebody is waiting on. */}
        {filter !== 'pending' && (
          <>
            <div className="mob-queue-chips wrap">
              {DATE_MODES.map((m) => (
                <button
                  key={m.key}
                  className={dateMode === m.key ? 'on' : ''}
                  onClick={() => setDateMode(m.key)}
                >
                  {m.label}
                </button>
              ))}
            </div>
            {dateMode === 'range' && (
              <div className="mob-daterange">
                <label>
                  <span className="mob-field-label">From</span>
                  <input
                    className="mob-input"
                    type="date"
                    value={fromDate}
                    max={toDate}
                    onChange={(e) => setFromDate(e.target.value)}
                  />
                </label>
                <label>
                  <span className="mob-field-label">To</span>
                  <input
                    className="mob-input"
                    type="date"
                    value={toDate}
                    min={fromDate}
                    onChange={(e) => setToDate(e.target.value)}
                  />
                </label>
              </div>
            )}
          </>
        )}

        {loading ? (
          <p className="muted small">Loading…</p>
        ) : shown.length === 0 && queueShown.length === 0 ? (
          <div className="mob-card"><div className="mob-empty">Nothing in list</div></div>
        ) : grouped ? (
          stationBlocks.map((b) => {
            const total = b.mine.length + b.queue.length
            if (total === 0) return null
            const open = openStations.has(b.station.id)
            return (
              <div className="mob-stationgroup" key={b.station.id}>
                <button
                  type="button"
                  className="mob-stationgroup-head"
                  onClick={() =>
                    setOpenStations((prev) => {
                      const next = new Set(prev)
                      if (next.has(b.station.id)) next.delete(b.station.id)
                      else next.add(b.station.id)
                      return next
                    })
                  }
                >
                  <span className="mob-caret">{open ? '⌄' : '›'}</span>
                  <span className="mob-entry-name">{b.station.name}</span>
                  <span className="mob-entry-amt">{total}</span>
                </button>
                {open && (
                  <>
                    <MyRecordCards list={b.mine} />
                    <ReviewQueueCards list={b.queue} />
                  </>
                )}
              </div>
            )
          })
        ) : (
          <>
            <MyRecordCards list={shown} />
            <ReviewQueueCards list={queueShown} />
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
/* TAB 5 — PROFILE. Who you are, and nothing else. Same layout for     */
/* every tier, top to bottom:                                          */
/*   1  selfie (uploadable), name, tier, station                      */
/*   2  personal details — collapsed until asked for                  */
/*                                                                     */
/* This month's numbers, the payslips and the rate contract used to    */
/* sit under them. They are pay, not identity, and they now make up    */
/* the KPI dashboard on the Performance tab.                           */
/* ------------------------------------------------------------------ */

function ProfileTab({
  profile,
  tier,
  grades,
  stations,
  onError,
}: {
  profile: Profile | null
  tier: Grade | null
  grades: Grade[]
  stations: Station[]
  onError: (m: string | null) => void
}) {
  const [showDetails, setShowDetails] = useState(false)
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState({ employee_code: '', phone: '' })
  // The Worker ID is the payroll key: retyping it — even your own — takes
  // the "Edit Worker ID" tick on the tier tag. Without it the row stays a
  // plain value while the phone stays editable.
  const canEditWorkerId = effectiveCapabilities(tier).includes('worker-id-edit')
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
                {editing && canEditWorkerId ? (
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
      .from('shared_profiles')
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
  onOpen,
}: {
  profileId: string | null
  amountFor: (jobId: string, quantity: number) => number
  /** Opens the 30-day work record history behind the earnings figure. */
  onOpen: () => void
}) {
  const [entries, setEntries] = useState<ProductionEntry[]>([])

  useEffect(() => {
    if (!profileId) return
    const from = new Date()
    from.setDate(from.getDate() - 40) // this month, plus a little carry-over
    supabase
      .from('operation_entries')
      .select('*')
      .eq('user_id', profileId)
      .gte('work_date', dayISO(from))
      .then(({ data }) => setEntries(data ?? []))
  }, [profileId])

  const monthStart = todayISO().slice(0, 8) + '01'
  const paid = entries.filter((e) => e.work_date >= monthStart && e.approval_status !== 'rejected')
  const total = paid.reduce((s, e) => s + amountFor(e.job_id, e.quantity), 0)

  // One figure, one door: the month's earnings, opening the 30-day work
  // record history behind it. (The day-by-day / per-entry earnings view
  // will grow out of that screen later.)
  return (
    <>
      <div className="mob-sectionhead">Payout Record</div>
      <button className="mob-card tapcard block" onClick={onOpen}>
        <div className="mob-cardhead">
          <span className="mob-card-label">This month earned</span>
          <span className="mob-caret" aria-hidden="true">›</span>
        </div>
        <div className="mob-stat">{RM(total)}</div>
      </button>
    </>
  )
}

/** Stands in for a grade id in the contract filter: rates tagged to none. */
const UNTAGGED_KEY = 'untagged'

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
  ladderFor,
}: {
  tier: Grade | null
  grades: Grade[]
  jobs: Job[]
  stations: Station[]
  myStationIds: string[]
  rateFor: (jobId: string) => number
  tier2RateFor: (jobId: string) => number | null
  ladderFor: (jobId: string) => number[]
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
   * Which rungs are showing. Empty is ALL — not "none" — because that is
   * what the block does before anybody touches it, and it means the All
   * chip needs no state of its own: it is simply the empty set.
   *
   * Picking is additive, so two rungs can be read side by side. Picking
   * the last one off falls back to All rather than leaving a blank card.
   */
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const toggle = (key: string) =>
    setPicked((cur) => {
      const next = new Set(cur)
      if (!next.delete(key)) next.add(key)
      return next
    })
  const showing = (key: string) => picked.size === 0 || picked.has(key)
  const shownGroups = groups.filter((g) => showing(g.grade.id))
  const showUntagged = untagged.length > 0 && showing(UNTAGGED_KEY)

  /**
   * One job's terms. A tiered rate is two prices depending on how much is
   * done inside the hour, so it is two lines — but each line is as short
   * as the thing it says: "1st – 4th/hr", not a sentence about it.
   */
  const JobRow = ({ job }: { job: Job }) => {
    const unit = job.unit.replace('/', '')
    const tier2 = tier2RateFor(job.id)
    const steps = ladderStepsFrom(ladderFor(job.id))
    return (
      <div className="mob-contract-job">
        <div className="mob-contract-name">
          <span className="mob-person-name">{job.name}</span>
          {manyStations && <span className="mob-station-meta">{stationName(job.station_id)}</span>}
        </div>
        {tier2 == null && steps.length < 2 ? (
          <div className="mob-contract-term">
            <span>Every {unit}</span>
            <span className="mob-entry-amt">{RM(rateFor(job.id))}{job.unit}</span>
          </div>
        ) : (
          <>
            {steps.map((step) => (
              <div className="mob-contract-term" key={step.from}>
                <span>
                  {step.to == null
                    ? `${ordinal(step.from)} onward/hr`
                    : step.from === step.to
                      ? `${ordinal(step.from)}/hr`
                      : `${ordinal(step.from)} – ${ordinal(step.to)}/hr`}
                </span>
                <span className="mob-entry-amt">{RM(step.rate)}{job.unit}</span>
              </div>
            ))}
            <div className="mob-contract-note">Resets every hour.</div>
          </>
        )}
      </div>
    )
  }

  return (
    <>
      <div className="mob-sectionhead">Piece Rate</div>
      <div className="mob-card">
      {/* The filter sits in the block's own heading rather than as a row
          of chips beneath it — only the rungs actually here are offered,
          so it never filters to nothing. */}
      <div className="mob-card-label spread">
        <span>Piece rate contract</span>
        {groups.length + (untagged.length > 0 ? 1 : 0) > 1 && (
          <FilterMenu
            title="Tier"
            allLabel="All tiers"
            options={[
              ...groups.map(({ grade }) => ({ key: grade.id, name: grade.name, color: grade.color })),
              ...(untagged.length > 0 ? [{ key: UNTAGGED_KEY, name: 'Any tier' }] : []),
            ]}
            picked={picked}
            onToggle={toggle}
            onAll={() => setPicked(new Set())}
          />
        )}
      </div>

      {groups.length === 0 && untagged.length === 0 && (
        <div className="mob-sub">No approved piece rate at your station yet.</div>
      )}
      {shownGroups.map(({ grade, rows }) => (
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
      {showUntagged && (
        <div>
          <div className="mob-contract-tier">
            <span className="tag-dot dot-grey" aria-hidden="true" />
            <span>Any tier</span>
          </div>
          {untagged.map((j) => <JobRow key={j.id} job={j} />)}
        </div>
      )}
      </div>
    </>
  )
}

/* ------------------------------------------------------------------ */
/* MY PAYSLIP: the last three FINALIZED payrolls, newest first — one   */
/* row per month showing what was earned, opening onto the basic       */
/* salary, piece-work lines and adjustments behind it. RLS only lets   */
/* people see their own lines, so this is safe for every tier.         */


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
  // While a held name hovers near the strip's edge, the strip slides
  // itself toward the next team — the finger is busy holding the name,
  // so the scrolling has to be done for it.
  const slideDir = useRef(0)
  const slideTimer = useRef<number | null>(null)
  function setSlide(dir: number) {
    slideDir.current = dir
    if (dir === 0) {
      if (slideTimer.current != null) {
        window.clearInterval(slideTimer.current)
        slideTimer.current = null
      }
    } else if (slideTimer.current == null) {
      slideTimer.current = window.setInterval(() => {
        scrollRef.current?.scrollBy({ left: slideDir.current * 14 })
      }, 24)
    }
  }
  useEffect(() => () => setSlide(0), [])
  // Moving is a MODE, entered from the move button beside +. Inside it a
  // name drags straight away and nothing is written until Save, so a
  // reshuffle is one decision rather than a write per drag.
  const [moveMode, setMoveMode] = useState(false)
  const [staged, setStaged] = useState<Map<string, { gradeId: string; teamId: string | null }>>(new Map())
  const [overGrade, setOverGrade] = useState<string | null>(null)

  async function load() {
    const [p, t] = await Promise.all([
      supabase.from('shared_profiles').select('*'),
      supabase.from('shared_teams').select('*').order('sort_order'),
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
      .from('shared_profiles')
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
      .from('shared_profiles')
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
    const { error: err } = await supabase.from('shared_teams').insert({
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
        .from('shared_profiles')
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
                setSlide(0)
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
          <div
            /* Snap is released while a name is held — mandatory snapping
               would pull the strip straight back mid-slide. It returns on
               drop, settling the strip on the nearest column. */
            className={`mob-teamscroll ${dragId ? 'free' : ''}`}
            ref={scrollRef}
            onDragOver={(e) => {
              // Lanes preventDefault and let the event bubble here, so the
              // edge check runs wherever the name is held.
              const el = scrollRef.current
              if (!el) return
              const r = el.getBoundingClientRect()
              const EDGE = 56
              setSlide(e.clientX < r.left + EDGE ? -1 : e.clientX > r.right - EDGE ? 1 : 0)
            }}
            onDragLeave={() => setSlide(0)}
            onDrop={() => setSlide(0)}
          >
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
      </div>

      <div className="mob-body">
        <div className="mob-pagehead">
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
