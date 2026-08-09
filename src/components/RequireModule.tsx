import { Navigate, Outlet } from 'react-router-dom'
import { ALWAYS_MODULES } from '../lib/tags'
import { useAllowedModules } from '../lib/useAllowedModules'

/**
 * A route only opens when the signed-in tier's tag ticks the module in
 * Settings → Tags management. The dashboard already hides the tile, but a
 * tile is not a lock — without this, the module was one typed URL away.
 */
export default function RequireModule({ moduleKey }: { moduleKey: string }) {
  const allowed = useAllowedModules()
  if (allowed === undefined) return null // still reading the tag — decide nothing yet
  const ok = allowed === null || ALWAYS_MODULES.includes(moduleKey) || allowed.includes(moduleKey)
  return ok ? <Outlet /> : <Navigate to="/unauthorized" replace />
}
