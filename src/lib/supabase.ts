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
}

// Rows of the work tables (see supabase/setup.sql).
export interface Station {
  id: string
  name: string
  sort_order: number
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
}

export interface PieceRate {
  id: string
  job_id: string
  rate: number
  effective_from: string
}

export interface ProductionEntry {
  id: string
  work_date: string
  station_id: string
  job_id: string
  worker_id: string
  quantity: number
  notes: string | null
  created_by: string | null
  created_at: string
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
  worker_id: string
  job_id: string
  quantity: number
  rate: number
  amount: number
}

export interface PayrollAdjustment {
  id: string
  run_id: string
  worker_id: string
  amount: number
  reason: string
}

/** Today as a YYYY-MM-DD string in local time (what date inputs expect). */
export function todayISO(): string {
  const d = new Date()
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10)
}
