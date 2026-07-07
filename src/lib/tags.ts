// Shared tag colour helpers — used by Settings and the Piece Rate module.
export const TAG_COLORS = ['diamond', 'gold', 'silver', 'red', 'yellow', 'blue', 'green', 'grey']

export function tagClass(color: string | undefined | null) {
  return `tagbadge tag-${TAG_COLORS.includes(color ?? '') ? color : 'grey'}`
}
