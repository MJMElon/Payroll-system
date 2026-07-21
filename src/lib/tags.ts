// Shared tag colour helpers — used by Settings and the Piece Rate module.
// Colours are ISSUED automatically (no picker): a new tag takes the first
// colour not already used by another tier, in this order.
export const TAG_COLORS = [
  'diamond', 'gold', 'silver', 'red', 'yellow', 'blue',
  'green', 'purple', 'teal', 'orange', 'pink', 'grey',
]

export function tagClass(color: string | undefined | null) {
  return `tagbadge tag-${TAG_COLORS.includes(color ?? '') ? color : 'grey'}`
}

/** First colour not yet used by any tier (cycles if every colour is taken). */
export function nextTagColor(usedColors: (string | null | undefined)[]): string {
  return TAG_COLORS.find((c) => !usedColors.includes(c)) ?? TAG_COLORS[usedColors.length % TAG_COLORS.length]
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
  { key: 'data-entry', label: 'Data entry', group: 'Work entry setting' },
  { key: 'verify', label: "Verify below tiers' work entry", group: 'Work entry setting' },
  { key: 'approve', label: "Approve below tiers' work entry", group: 'Work entry setting' },
  // Piece rates
  { key: 'rate-create', label: 'Create piece rate', group: 'Piece rate setting' },
  { key: 'rate-verify', label: 'Verify piece rate', group: 'Piece rate setting' },
  { key: 'rate-approve', label: 'Approve piece rate', group: 'Piece rate setting' },
  // Tag management — each function grantable on its own
  { key: 'tag-add', label: 'Add new tag', group: 'Tag management setting' },
  { key: 'tag-move', label: 'Move tag tiers', group: 'Tag management setting' },
  { key: 'tag-edit', label: "Edit tags' settings", group: 'Tag management setting' },
  // Users & stations
  { key: 'user-access', label: "Change other users' settings", group: 'User setting' },
  { key: 'station-create', label: 'Create & edit stations', group: 'Station setting' },
  // Views
  { key: 'report-view', label: 'See report module (dashboards)', group: 'View setting' },
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
