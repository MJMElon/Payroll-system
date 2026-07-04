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
  role: Role
  station_id: string | null
  worker_id: string | null
}
