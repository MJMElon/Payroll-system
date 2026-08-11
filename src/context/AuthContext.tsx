import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react'
import type { Session, User } from '@supabase/supabase-js'
import { supabase, type Profile } from '../lib/supabase'
import { authLink } from '../lib/authLink'

interface AuthValue {
  session: Session | null
  profile: Profile | null
  loading: boolean
  // True while the user arrived from a password-reset email and must set a
  // new password (cleared once they have).
  passwordRecovery: boolean
  clearPasswordRecovery: () => void
  // Set when an emailed link could not be used (expired, already spent), so
  // the sign-in screen can say so instead of looking like nothing happened.
  linkError: string | null
  clearLinkError: () => void
  signIn: (email: string, password: string) => Promise<{ error: string | null }>
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthValue | undefined>(undefined)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [loading, setLoading] = useState(true)
  const [passwordRecovery, setPasswordRecovery] = useState(false)
  const [linkError, setLinkError] = useState<string | null>(authLink?.error ?? null)

  // Load the access_profiles row (role, station, worker link) for a user.
  async function loadProfile(user: User) {
    // select('*') keeps login working even when the database is one
    // migration behind the frontend (missing columns come back undefined).
    const { data, error } = await supabase
      .from('shared_profiles')
      .select('*')
      .eq('id', user.id)
      .maybeSingle()
    if (data) {
      setProfile(data as Profile)
      return
    }
    if (error) console.error('Failed to load profile:', error.message)
    // Self-heal: the signup trigger may not have created the row (e.g. the
    // database was mid-migration). Create it, then reload.
    const email = user.email ?? null
    // The name they typed at signup, if it is still on the auth user. Never
    // fall back to the email: an email is not a name, and the team chart
    // then has no way to tell an unnamed account from a named one.
    const signupName =
      (user.user_metadata?.full_name as string | undefined)?.trim() || null
    const { data: opGrade } = await supabase
      .from('shared_grades')
      .select('id')
      .eq('name', 'Operator')
      .maybeSingle()
    const { data: created, error: insErr } = await supabase
      .from('shared_profiles')
      .insert({ id: user.id, full_name: signupName, email, role: 'operator', grade_id: opGrade?.id ?? null })
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
    ;(async () => {
      // A password-reset link arrives with its tokens in the URL. authLink
      // took them out of the address bar before the router could clear it,
      // so sign the user in with them here.
      if (authLink?.accessToken && authLink.refreshToken) {
        const { error } = await supabase.auth.setSession({
          access_token: authLink.accessToken,
          refresh_token: authLink.refreshToken,
        })
        if (error) setLinkError(error.message)
        else if (authLink.type === 'recovery') setPasswordRecovery(true)
      }
      const { data } = await supabase.auth.getSession()
      setSession(data.session)
      if (data.session) await loadProfile(data.session.user)
      setLoading(false)
    })()

    // React to sign in / sign out. The callback must NOT await Supabase
    // calls: supabase-js fires it while holding its internal auth lock, and
    // any query made here waits for that same lock — a deadlock that froze
    // the first page load whenever the stored token needed a refresh (the
    // "blank until you reload once" bug). Deferring with setTimeout lets the
    // callback return, the lock release, and only then hits the database.
    const { data: sub } = supabase.auth.onAuthStateChange((_event, next) => {
      if (_event === 'PASSWORD_RECOVERY') setPasswordRecovery(true)
      setSession(next)
      setTimeout(() => {
        if (next) void loadProfile(next.user)
        else setProfile(null)
      }, 0)
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
    <AuthContext.Provider
      value={{
        session,
        profile,
        loading,
        passwordRecovery,
        clearPasswordRecovery: () => setPasswordRecovery(false),
        linkError,
        clearLinkError: () => setLinkError(null),
        signIn,
        signOut,
      }}
    >
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
