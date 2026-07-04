import { Navigate, Outlet } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import type { Role } from '../lib/supabase'

// Guards a group of routes. Optionally restricts to specific roles.
export default function ProtectedRoute({ allowedRoles }: { allowedRoles?: Role[] }) {
  const { session, profile, loading } = useAuth()

  if (loading) {
    return <div className="center muted">Loading…</div>
  }

  if (!session) {
    return <Navigate to="/login" replace />
  }

  if (allowedRoles && profile && !allowedRoles.includes(profile.role)) {
    return <Navigate to="/unauthorized" replace />
  }

  return <Outlet />
}
