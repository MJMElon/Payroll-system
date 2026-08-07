import type { Role } from './supabase'

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

// Modules a tag can be allowed to open on the web, each named "… Module"
// so the list reads evenly.
//
// The station status board is NOT here: it is the common dashboard every
// tier needs, so it is granted to all of them (see ALWAYS_MODULES) rather
// than ticked per tag.
export const MODULE_OPTIONS = [
  { key: 'operation', label: 'Operation Module' },
  { key: 'piece-rate', label: 'Piece Rate Module' },
  { key: 'payroll', label: 'Payroll Module' },
  { key: 'worker-management', label: 'Team Manage Module' },
  { key: 'report', label: 'Report Module' },
  { key: 'demo-mobile', label: 'Demo Mobile View Module' },
] as const

/** Open to every tier, with or without a tick. */
export const ALWAYS_MODULES = ['station-status']

export const DEFAULT_MODULES = ['station-status', 'piece-rate']

/** The modules a tier may open: what its tag stores, plus the common ones. */
export function effectiveModules(modules: string[] | null | undefined): string[] {
  return Array.from(new Set([...ALWAYS_MODULES, ...(modules ?? [])]))
}

// Standardized per-tier capabilities ("can do") in their FIXED order —
// they always display in this sequence no matter what order they were
// ticked. Grouped so the tag editor reads like a permission sheet.
export const CAPABILITY_OPTIONS: { key: string; label: string; group: string }[] = [
  // Work entries. The label is the verb alone — the module it sits under
  // already says what is being added or approved. Verify and approve
  // always reach DOWN the tiers and never up, which is the system's rule
  // everywhere rather than something to repeat on each line.
  { key: 'data-entry', label: 'Add New', group: 'Work entry setting' },
  { key: 'edit-entry', label: 'Edit', group: 'Work entry setting' },
  { key: 'delete-entry', label: 'Delete', group: 'Work entry setting' },
  { key: 'verify', label: 'Verify', group: 'Work entry setting' },
  { key: 'approve', label: 'Approve', group: 'Work entry setting' },
  // Piece rates
  { key: 'rate-create', label: 'Add New', group: 'Piece rate setting' },
  { key: 'rate-edit', label: 'Edit', group: 'Piece rate setting' },
  { key: 'rate-delete', label: 'Delete', group: 'Piece rate setting' },
  { key: 'rate-verify', label: 'Verify', group: 'Piece rate setting' },
  { key: 'rate-approve', label: 'Approve', group: 'Piece rate setting' },
  // Tag management — each function grantable on its own
  { key: 'tag-add', label: 'Add new tag', group: 'Tag management setting' },
  { key: 'tag-move', label: 'Move tag tiers', group: 'Tag management setting' },
  { key: 'tag-edit', label: "Edit tags' settings", group: 'Tag management setting' },
  // Users & stations
  { key: 'user-access', label: "Change other users' settings", group: 'User setting' },
  // Team manage. "team-assign" is the mobile Team tab: claim new sign ups
  // into your own team and set their tier — always DOWN the tiers, never
  // at or above your own. Profile and salary are separate grants, so a
  // lower tier can keep details tidy without ever seeing pay.
  { key: 'team-assign', label: 'Claim Sign Ups & Set Tier', group: 'Team manage setting' },
  { key: 'team-create', label: 'Add New Team', group: 'Team manage setting' },
  { key: 'worker-edit', label: 'Edit Profile Details', group: 'Team manage setting' },
  { key: 'worker-salary', label: 'Edit Basic Salary', group: 'Team manage setting' },
  { key: 'station-create', label: 'Create & edit stations', group: 'Station setting' },
]

/**
 * What a tier is ENTITLED to — a separate question from what it may do.
 *
 * "Can do" is about the buttons a person gets. An entitlement is about what
 * the tier IS: a Station Head does piece work and so a piece rate may be
 * written for that tag, while Management runs the mill and never earns one.
 * That is why these are not lumped in with the capabilities, and why tier 1
 * does NOT get them all automatically the way it gets every ability.
 */
export const ENTITLEMENT_OPTIONS: { key: string; label: string; hint: string }[] = [
  {
    key: 'piece-rate',
    label: 'Entitled for piece rate contract',
    hint: 'A piece rate may be written for this tier. Switch it off and the tag stops being offered when a new piece rate is created.',
  },
  // The mobile Performance tab is drawn from these two. Both may be on —
  // the mill reads first, the tier's own numbers follow underneath.
  {
    key: 'mill-dashboard',
    label: 'Mill output dashboard on the Performance tab',
    hint: 'The phone opens on what the whole mill produced: output per station, the week, workforce and payroll cost.',
  },
  {
    key: 'kpi-dashboard',
    label: 'KPI dashboard on the Performance tab',
    hint: "The phone opens on this tier's own numbers instead: work done against target, the week, what is waiting and what came back.",
  },
]

export const ALL_ENTITLEMENTS: string[] = ENTITLEMENT_OPTIONS.map((e) => e.key)

/**
 * What a tag that has never been asked is entitled to.
 *
 * Before this setting existed, both answers were worked out from the tag
 * NAMES: the station tier and everything below it does the piece work and
 * reads its own KPIs, while the tiers above run the whole mill and read the
 * mill dashboard. Tags saved before the setting arrived keep exactly that,
 * so switching this on changes nothing until somebody unticks a box.
 */
export function defaultEntitlements(
  sortOrder: number,
  allGrades: { name: string; sort_order: number }[],
): string[] {
  const floor = stationTierOf(allGrades)
  return [
    ...(floor === null || sortOrder >= floor ? ['piece-rate'] : []),
    ...(runsWholeMill(sortOrder, floor) ? ['mill-dashboard'] : ['kpi-dashboard']),
  ]
}

/** What this tier is entitled to, falling back to the name-based default. */
export function effectiveEntitlements(
  grade: { sort_order: number; entitlements?: string[] | null } | null | undefined,
  allGrades: { name: string; sort_order: number }[],
): string[] {
  if (!grade) return []
  // Null is "never asked", which is not the same as "entitled to nothing".
  if (grade.entitlements == null) return defaultEntitlements(grade.sort_order, allGrades)
  return ALL_ENTITLEMENTS.filter((k) => grade.entitlements!.includes(k))
}

export function isEntitled(
  grade: { sort_order: number; entitlements?: string[] | null } | null | undefined,
  key: string,
  allGrades: { name: string; sort_order: number }[],
): boolean {
  return effectiveEntitlements(grade, allGrades).includes(key)
}

export const ALL_CAPABILITIES: string[] = CAPABILITY_OPTIONS.map((c) => c.key)
export const CAPABILITY_GROUPS: string[] = Array.from(new Set(CAPABILITY_OPTIONS.map((c) => c.group)))

/**
 * Which module each capability group belongs to. A group is only worth
 * setting when the tier can open the module it governs, so the tag editor
 * shows a group only once its module is ticked under "Access to module".
 * A group missing from here has no owning web module and always shows.
 */
export const GROUP_MODULE: Record<string, string> = {
  'Work entry setting': 'operation',
  'Piece rate setting': 'piece-rate',
  'Team manage setting': 'worker-management',
}

/** The same link read the other way: module key → the group it opens. */
export const MODULE_GROUP: Record<string, string> = Object.fromEntries(
  Object.entries(GROUP_MODULE).map(([group, module]) => [module, group]),
)

/**
 * Groups that are NOT handed out per tier at all: creating tier tags and
 * station tags, and changing other users' settings, belong to Management
 * (tier 1) alone. They stay in CAPABILITY_OPTIONS because stored tags and
 * the database policies still name these keys — they simply have no
 * checkbox in the tag editor any more.
 */
export const MANAGEMENT_ONLY_GROUPS = ['User setting', 'Tag management setting', 'Station setting']

/**
 * The first tier that belongs to ONE station. Everything from there down
 * works at a station and is drawn per station in Team Manage; the tiers
 * ABOVE it run the whole mill, so they sit on every station.
 *
 * Read from the tag names — "Station Head", "Assistant Station Head".
 * Null when no tag names a station, which means the split cannot be told
 * and every tier counts as running the mill.
 */
export function stationTierOf(grades: { name: string; sort_order: number }[]): number | null {
  const named = grades
    .filter((g) => /station/i.test(g.name))
    .sort((a, b) => a.sort_order - b.sort_order)[0]
  return named ? named.sort_order : null
}

/** Do the tiers above the station tier hold this one — mill-wide, not per station? */
export function runsWholeMill(sortOrder: number, stationTier: number | null): boolean {
  return stationTier === null || sortOrder < stationTier
}

/**
 * Which tiers a viewer may hand out. Everyone reaches strictly downward —
 * except the top tier, which has nothing above it, so it is the one tier
 * that may also fill its own rank.
 */
export function canGiveTier(myTier: number | null, target: number): boolean {
  if (myTier === null) return false
  if (myTier === 1) return target >= 1
  return target > myTier
}

/**
 * Route access follows the tier tag, so handing out a tier also settles
 * which pages that person may open. Admin accounts are never demoted by a
 * tag. Shared by Team Manage and Settings so the two cannot disagree.
 */
export function roleForTier(tier: number | null, name?: string): Role {
  if (tier === null) return 'operator'
  if (tier <= 2) return 'manager'
  if (tier === 3 || (name ?? '').toLowerCase().includes('engineer')) return 'engineer'
  return 'operator'
}

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
