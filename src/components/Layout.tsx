import { NavLink, Outlet } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import type { Role } from '../lib/supabase'

interface NavItem {
  to: string
  label: string
  roles: Role[]
}

// Which roles see which nav links. Mirrors the RLS policies on the backend —
// this only hides links; the database is the real gate.
const NAV: NavItem[] = [
  { to: '/', label: 'Dashboard', roles: ['admin', 'manager', 'engineer', 'operator', 'worker'] },
  { to: '/production', label: 'Production', roles: ['admin', 'manager', 'operator'] },
  { to: '/payroll', label: 'Payroll', roles: ['admin', 'manager'] },
  { to: '/settings', label: 'Settings', roles: ['admin', 'manager'] },
]

export default function Layout() {
  const { profile, session, signOut } = useAuth()
  const role = profile?.role

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">Piece Rate &amp; Payroll</div>
        <nav className="nav">
          {NAV.filter((i) => role && i.roles.includes(role)).map((i) => (
            <NavLink key={i.to} to={i.to} end={i.to === '/'} className="navlink">
              {i.label}
            </NavLink>
          ))}
        </nav>
        <div className="account">
          <span className="muted small">
            {session?.user.email}
            {role ? ` · ${role}` : ''}
          </span>
          <button className="btn ghost" onClick={() => signOut()}>
            Sign out
          </button>
        </div>
      </header>
      <main className="content">
        <Outlet />
      </main>
    </div>
  )
}
