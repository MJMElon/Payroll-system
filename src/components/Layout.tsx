import { useEffect, useState } from 'react'
import { Link, Outlet, useLocation } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'

// The top bar carries the module you are in: the system name on the main
// page, the module's own name once you enter one. Longest path first, so
// "/operation/add" wins over "/operation".
const MODULE_TITLES: [string, string][] = [
  ['/operation/add', 'Add Job Record'],
  ['/workers', 'Worker Management'],
  ['/operation', 'Operation'],
  ['/piece-rate', 'Piece Rate Management'],
  ['/payroll', 'Payroll'],
  ['/settings', 'Settings'],
  ['/demo-mobile', 'Demo Mobile View'],
  ['/station', 'Station status'],
  ['/unauthorized', 'No access'],
]
const SYSTEM_TITLE = 'Piece Rate & Payroll System'

export default function Layout() {
  const { profile, session, signOut } = useAuth()
  const { pathname } = useLocation()
  const moduleTitle = MODULE_TITLES.find(([path]) => pathname.startsWith(path))?.[1] ?? SYSTEM_TITLE
  // The pivoted Piece Rate tables need more breathing room than the
  // standard page width gives every other page.
  const isWide = pathname.startsWith('/piece-rate')
  const role = profile?.role
  // Settings is for admins/managers, plus anyone at least one tier above the
  // bottom (they confirm new signups there).
  const [upperTier, setUpperTier] = useState(false)
  useEffect(() => {
    async function check() {
      if (!profile?.grade_id) return setUpperTier(false)
      const [{ data: mine }, { data: all }] = await Promise.all([
        supabase.from('grades').select('sort_order').eq('id', profile.grade_id).maybeSingle(),
        supabase.from('grades').select('sort_order').order('sort_order', { ascending: false }).limit(1),
      ])
      const bottom = all?.[0]?.sort_order ?? 0
      setUpperTier(mine != null && mine.sort_order < bottom)
    }
    check()
  }, [profile])
  const canSettings = role === 'admin' || role === 'manager' || upperTier

  return (
    <div className="app">
      <header className="topbar">
        <Link to="/" className="brand">
          <span className="brand-logo">MJM</span>
          <span className="brand-sep">/</span>
          <span className="brand-title">{moduleTitle}</span>
        </Link>
        <div className="account">
          <span className="muted small">
            {session?.user.email}
            {role ? ` · ${role}` : ''}
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
