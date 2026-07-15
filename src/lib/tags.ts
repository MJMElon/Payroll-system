// Shared tag colour helpers — used by Settings and the Piece Rate module.
export const TAG_COLORS = ['diamond', 'gold', 'silver', 'red', 'yellow', 'blue', 'green', 'grey']

export function tagClass(color: string | undefined | null) {
  return `tagbadge tag-${TAG_COLORS.includes(color ?? '') ? color : 'grey'}`
}

// Module keys a tag can be allowed to see on the web.
export const MODULE_OPTIONS = [
  { key: 'station-status', label: 'Station status board' },
  { key: 'piece-rate', label: 'Piece Rate module' },
  { key: 'payroll', label: 'Payroll module' },
  { key: 'demo-mobile', label: 'Demo Mobile View' },
] as const

export const DEFAULT_MODULES = ['station-status', 'piece-rate']

// Standardized per-tier capabilities ("can do").
export const CAPABILITY_OPTIONS = [
  { key: 'data-entry', label: 'Data entry' },
  { key: 'verify', label: "Verify below all tiers' work entry" },
  { key: 'approve', label: "Approve below all tiers' work entry" },
] as const

export function capabilityLabel(key: string) {
  return CAPABILITY_OPTIONS.find((c) => c.key === key)?.label ?? key
}
