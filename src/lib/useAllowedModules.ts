import { useEffect, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { supabase } from './supabase'
import { DEFAULT_MODULES } from './tags'

/**
 * The web modules this account may open: the TIER's ticks from Settings →
 * Tags management are the master switch, and the per-user checkboxes in
 * User access can only narrow that list, never extend it.
 *
 *   undefined — still being read; decide nothing yet.
 *   null      — everything (admins, managers, tier 1).
 *   string[]  — exactly these module keys.
 */
export function useAllowedModules(): string[] | null | undefined {
  const { profile } = useAuth()
  const isManage = profile?.role === 'admin' || profile?.role === 'manager'
  const [allowed, setAllowed] = useState<string[] | null | undefined>(undefined)

  useEffect(() => {
    let alive = true
    async function load() {
      if (isManage) return alive && setAllowed(null)
      if (!profile?.grade_id) {
        return (
          alive &&
          setAllowed(
            profile?.modules && profile.modules.length > 0 ? profile.modules : DEFAULT_MODULES,
          )
        )
      }
      const { data } = await supabase
        .from('shared_grades')
        .select('modules, sort_order')
        .eq('id', profile.grade_id)
        .maybeSingle()
      if (!alive) return
      if (data?.sort_order === 1) return setAllowed(null) // super admin sees everything
      const tierMods = (data?.modules as string[] | undefined) ?? DEFAULT_MODULES
      const userMods = profile?.modules
      setAllowed(
        userMods && userMods.length > 0 ? tierMods.filter((m) => userMods.includes(m)) : tierMods,
      )
    }
    setAllowed(undefined)
    load()
    return () => {
      alive = false
    }
  }, [profile, isManage])

  return allowed
}
