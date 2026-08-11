import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

// True when both env vars are present. When false the app renders a setup
// screen (see main.tsx) instead of crashing to a blank page — createClient
// throws if given an empty URL, which would abort the whole bundle.
export const isSupabaseConfigured = Boolean(url && anonKey)

if (!isSupabaseConfigured) {
  console.error(
    'Missing Supabase env vars. Copy .env.example to .env and fill in ' +
      'VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.',
  )
}

export const supabase = createClient(
  url || 'https://placeholder.supabase.co',
  anonKey || 'placeholder-anon-key',
)

/**
 * Where an emailed link (password reset, confirmation) should land.
 *
 * Defaults to wherever the request was made from, which is right for both the
 * dev server and GitHub Pages. Set `VITE_SITE_URL` to override it — useful when
 * a reset requested from localhost still has to open on the deployed site.
 *
 * Whatever this returns must also be listed in Supabase under
 * Authentication → URL Configuration → Redirect URLs. Anything not on that
 * list is ignored and the mail falls back to the project's Site URL, which
 * starts life as http://localhost:3000 — a link that cannot open on a phone.
 */
export function siteUrl(): string {
  const configured = import.meta.env.VITE_SITE_URL?.trim()
  if (configured) return configured.replace(/\/+$/, '') + '/'
  return window.location.origin + window.location.pathname
}

// Roles used across the app. Mirrors the check constraint on access_profiles.role.
export type Role = 'admin' | 'manager' | 'engineer' | 'operator' | 'worker'

export interface Profile {
  id: string
  full_name: string | null
  email: string | null
  role: Role
  station_id: string | null
  station_ids: string[] | null
  worker_id: string | null
  grade_id: string | null
  can_approve_rates: boolean
  approval_role: 'verify' | 'approve' | null
  modules?: string[] | null
  tags_confirmed?: boolean
  employee_code?: string | null
  // When the account signed up (drives the Pending Allocation order).
  created_at?: string | null
  // Where this block sits among its row/cell mates on the team chart —
  // set by dragging it onto a teammate; lower comes first, null queues last.
  chart_pos?: number | null
  // Direct upper this user reports to (must be a strictly higher tier).
  supervisor_id?: string | null
  // Per-user grant of the mobile Approvals screen (null = no access).
  mobile_approval?: 'verify' | 'approve' | null
  // Monthly basic salary (RM), edited in Worker Management.
  basic_salary?: number | null
  // Worker profile details (Worker Management; used by payroll later).
  ic_number?: string | null
  phone?: string | null
  bank_name?: string | null
  bank_account?: string | null
  joined_on?: string | null
  // Display name of the team this person LEADS (e.g. "Team A").
  // Legacy: kept so older rows keep reading, superseded by team_id.
  team_name?: string | null
  // The team this person belongs to (Worker Management board).
  team_id?: string | null
  // Selfie shown on the mobile Profile tab — a path into the public
  // `records` bucket. Written only through the set_my_avatar() function,
  // which is the one column a person may change on their own row.
  avatar_path?: string | null
}

/**
 * A team box on the Worker Management board. It is created ON a tier row
 * (grade_id = that tier) and groups people from that tier downward, so a
 * team made by a Station Head also holds that team's assistant station
 * heads and operators one row below. station_id is null for teams created
 * above the station-head tier — those belong to every station.
 */
export interface Team {
  id: string
  name: string
  grade_id: string | null
  station_id: string | null
  created_by: string | null
  sort_order: number
}

// Rows of the work tables (see supabase/setup.sql).
export interface Station {
  id: string
  name: string
  sort_order: number
  // Mobile-view presets (optional: older queries don't select them).
  hourly_count?: boolean
  hourly_target?: number
  hourly_min_prev?: number
  // Preset coordinate (Settings → Station tags) that clock in/out stamps
  // are checked against. geofence_m is the allowed distance in metres.
  latitude?: number | null
  longitude?: number | null
  geofence_m?: number | null
  // Targets, and the "Show on Add new work record" ticks that decide
  // which target dashboards the mobile record screen draws. The hourly
  // number reuses hourly_target above.
  monthly_target?: number | null
  show_hourly_target?: boolean
  show_monthly_target?: boolean
}

export interface PhotoRecord {
  id: string
  station_id: string
  photo_path: string | null
  taken_at: string
  entry_id?: string | null
  job_id?: string | null
}

export interface Worker {
  id: string
  full_name: string
  station_id: string | null
  grade_id: string | null
  can_approve_rates: boolean
  active: boolean
}

export interface Grade {
  id: string
  name: string
  sort_order: number
  color: string
  ability: string | null
  modules: string[]
  capabilities: string[]
  // What this tier is entitled to (see ENTITLEMENT_OPTIONS in lib/tags).
  // Null on a tag saved before the setting existed — read it through
  // effectiveEntitlements(), which fills in the old name-based answer.
  entitlements?: string[] | null
  // Whose piece rate contracts / work records this tier may view, as grade
  // ids. Null on a tag saved before the setting existed — read them through
  // viewableTierIds(), which fills in the old own-rank-and-below answer.
  view_rate_tiers?: string[] | null
  view_entry_tiers?: string[] | null
}

export interface Job {
  id: string
  station_id: string
  grade_id: string | null
  name: string
  unit: string
  active: boolean
  approval_status: 'pending' | 'verified' | 'approved' | 'rejected'
  verified_by: string | null
  approved_by: string | null
  // Ticked (default): the mobile "Choose job" list offers this contract as
  // a record to submit. Unticked: an incentive/support rate — priced for
  // payroll, never submitted as a job record. Optional: absent until the
  // column migration has run, and older queries don't select it.
  record_job?: boolean | null
  // Ticked (default): this work is counted on the mobile Mill output
  // dashboard. Optional: absent until the column migration has run.
  show_on_mill?: boolean | null
}

export interface PieceRate {
  id: string
  job_id: string
  rate: number
  effective_from: string
  // Tiered hourly rate (e.g. cage-tipping): tier1 = `rate`, applied to the
  // first 4 units that hour; tier2_rate applies to the 5th unit onward,
  // resetting every hour. Null/undefined means a flat rate — no tiering.
  tier2_rate?: number | null
}

export interface ProductionEntry {
  id: string
  work_date: string
  station_id: string
  job_id: string
  worker_id: string | null
  user_id: string | null
  quantity: number
  notes: string | null
  shift: 'a' | 'b' | null
  created_by: string | null
  created_at: string
  // Mobile work-entry approval flow (older queries don't select these).
  approval_status?: 'pending' | 'verified' | 'approved' | 'rejected'
  verified_by?: string | null
  verified_at?: string | null
  approved_by?: string | null
  approved_at?: string | null
  rejected_reason?: string | null
  // Who sent it back, by email — the same shape as verified_by /
  // approved_by, so "work I sent back" is answerable.
  rejected_by?: string | null
}

export interface PayrollRun {
  id: string
  period_start: string
  period_end: string
  status: 'draft' | 'finalized'
  created_at: string
  finalized_at: string | null
}

export interface PayrollLine {
  id: string
  run_id: string
  worker_id: string | null
  user_id: string | null
  job_id: string
  quantity: number
  rate: number
  amount: number
}

export interface PayrollAdjustment {
  id: string
  run_id: string
  worker_id: string | null
  user_id: string | null
  amount: number
  reason: string
}

/** Display name for an account: full name, else email, else short id. */
export function profileName(p: Pick<Profile, 'full_name' | 'email' | 'id'> | undefined | null) {
  return p ? p.full_name ?? p.email ?? p.id.slice(0, 8) : '?'
}

/** Today as a YYYY-MM-DD string in local time (what date inputs expect). */
export function todayISO(): string {
  const d = new Date()
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10)
}
