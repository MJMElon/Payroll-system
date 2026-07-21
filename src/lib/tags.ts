// Shared tag colour helpers — used by Settings and the Piece Rate module.
export const TAG_COLORS = ['diamond', 'gold', 'silver', 'red', 'yellow', 'blue', 'green', 'grey']

export function tagClass(color: string | undefined | null) {
  return `tagbadge tag-${TAG_COLORS.includes(color ?? '') ? color : 'grey'}`
}

// Module keys a tag can be allowed to see on the web.
export const MODULE_OPTIONS = [
  { key: 'station-status', label: 'Station status board' },
  { key: 'daily-job-record', label: 'Daily Job Record' },
  { key: 'piece-rate', label: 'Piece Rate module' },
  { key: 'payroll', label: 'Payroll module' },
  { key: 'demo-mobile', label: 'Demo Mobile View' },
] as const

export const DEFAULT_MODULES = ['station-status', 'piece-rate']

// Standardized per-tier capabilities ("can do") in their FIXED order —
// they always display in this sequence no matter what order they were
// ticked. Grouped so the tag editor reads like a permission sheet.
export const CAPABILITY_OPTIONS: { key: string; label: string; group: string }[] = [
  // Work entries (mobile records)
  { key: 'data-entry', label: 'Data entry', group: 'Work entries' },
  { key: 'verify', label: "Verify below all tiers' work entry", group: 'Work entries' },
  { key: 'approve', label: "Approve below all tiers' work entry", group: 'Work entries' },
  // Piece rates
  { key: 'rate-create', label: 'Create piece rate', group: 'Piece rates' },
  { key: 'rate-verify', label: 'Verify piece rate', group: 'Piece rates' },
  { key: 'rate-approve', label: 'Approve piece rate', group: 'Piece rates' },
  // System administration
  { key: 'station-create', label: 'Create & edit stations', group: 'System' },
  { key: 'tag-edit', label: 'Edit tags management', group: 'System' },
  { key: 'report-view', label: 'See report module (dashboards)', group: 'System' },
]

export const ALL_CAPABILITIES: string[] = CAPABILITY_OPTIONS.map((c) => c.key)
export const CAPABILITY_GROUPS: string[] = Array.from(new Set(CAPABILITY_OPTIONS.map((c) => c.group)))

export function capabilityLabel(key: string) {
  return CAPABILITY_OPTIONS.find((c) => c.key === key)?.label ?? key
}

/** Re-sequence capabilities into the standardized order (never click order). */
export function sortCapabilities(caps: string[]): string[] {
  return [
    ...ALL_CAPABILITIES.filter((k) => caps.includes(k)),
    ...caps.filter((c) => !ALL_CAPABILITIES.includes(c)),
  ]
}

/**
 * Tier 1 (Management) is the SUPER ADMIN: pinned at #1 and always holds
 * every ability, no matter what is stored. Everyone else gets exactly the
 * capabilities ticked on their tag, in standardized order.
 */
export function effectiveCapabilities(
  tier: { sort_order: number; capabilities?: string[] | null } | null | undefined,
): string[] {
  if (!tier) return []
  if (tier.sort_order === 1) return [...ALL_CAPABILITIES]
  return sortCapabilities(tier.capabilities ?? [])
}
