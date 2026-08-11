import { useEffect, useState } from 'react'
import { Link, Outlet, useLocation } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'
import { useAllowedModules } from '../lib/useAllowedModules'

export default function Layout() {
  const { profile, session, signOut } = useAuth()
  const { pathname } = useLocation()
  // The top bar carries the system name on every page — each page states
  // which module you are in with its own heading.
  // The pivoted Piece Rate tables need more breathing room than the
  // standard page width gives every other page.
  const isWide = pathname.startsWith('/piece-rate')
  const role = profile?.role
  // The tier tag is what the rest of the app goes by, so it is the tag —
  // not the account's role — that belongs next to the email.
  const [tierName, setTierName] = useState<string | null>(null)
  useEffect(() => {
    async function check() {
      if (!profile?.grade_id) return setTierName(null)
      const { data: mine } = await supabase
        .from('shared_grades')
        .select('name')
        .eq('id', profile.grade_id)
        .maybeSingle()
      setTierName(mine?.name ?? null)
    }
    check()
  }, [profile])
  // The gear follows the Settings Module tick exactly as the route does,
  // so nobody is shown a door they cannot open.
  const allowedModules = useAllowedModules()
  const canSettings =
    allowedModules !== undefined &&
    (allowedModules === null || allowedModules.includes('settings'))

  return (
    <div className="app">
      <header className="topbar">
        <Link to="/" className="brand">
          <span className="brand-logo">MJM</span>
          <span className="brand-sep">/</span>
          <span className="brand-title">Piece Rate &amp; Payroll System</span>
        </Link>
        <div className="account">
          <span className="muted small">
            {session?.user.email}
            {tierName ? ` · ${tierName}` : role ? ` · ${role}` : ''}
          </span>
          {canSettings && (
            <Link to="/settings" className="icon-btn" title="Settings" aria-label="Settings">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
            </Link>
          )}
          <button className="btn ghost" onClick={() => signOut()}>
            Sign out
          </button>
        </div>
      </header>
      <main className={`content ${isWide ? 'content-wide' : ''}`}>
        <Outlet />
      </main>
    </div>
  )
}
