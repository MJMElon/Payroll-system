import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase, type Profile } from '../lib/supabase'

interface AuthValue {
  session: Session | null
  profile: Profile | null
  loading: boolean
  signIn: (email: string, password: string) => Promise<{ error: string | null }>
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthValue | undefined>(undefined)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [loading, setLoading] = useState(true)

  // Load the access_profiles row (role, station, worker link) for a user id.
  async function loadProfile(userId: string) {
    // select('*') keeps login working even when the database is one
    // migration behind the frontend (missing columns come back undefined).
    const { data, error } = await supabase
      .from('access_profiles')
      .select('*')
      .eq('id', userId)
      .maybeSingle()
    if (data) {
      setProfile(data as Profile)
      return
    }
    if (error) console.error('Failed to load profile:', error.message)
    // Self-heal: the signup trigger may not have created the row (e.g. the
    // database was mid-migration). Create it, then reload.
    const { data: session } = await supabase.auth.getSession()
    const email = session.session?.user.email ?? null
    const { data: opGrade } = await supabase
      .from('grades')
      .select('id')
      .eq('name', 'Operator')
      .maybeSingle()
    const { data: created, error: insErr } = await supabase
      .from('access_profiles')
      .insert({ id: userId, full_name: email, email, role: 'operator', grade_id: opGrade?.id ?? null })
      .select()
      .single()
    if (insErr) {
      console.error('Failed to create profile:', insErr.message)
      setProfile(null)
    } else {
      setProfile(created as Profile)
    }
  }

  useEffect(() => {
    // Get the current session on first load.
    supabase.auth.getSession().then(async ({ data }) => {
      setSession(data.session)
      if (data.session) await loadProfile(data.session.user.id)
      setLoading(false)
    })

    // React to sign in / sign out.
    const { data: sub } = supabase.auth.onAuthStateChange(async (_event, next) => {
      setSession(next)
      if (next) {
        await loadProfile(next.user.id)
      } else {
        setProfile(null)
      }
    })

    return () => sub.subscription.unsubscribe()
  }, [])

  async function signIn(email: string, password: string) {
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    return { error: error ? error.message : null }
  }

  async function signOut() {
    await supabase.auth.signOut()
  }

  return (
    <AuthContext.Provider value={{ session, profile, loading, signIn, signOut }}>
      {children}
    </AuthContext.Provider>
  )
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>')
  return ctx
}
