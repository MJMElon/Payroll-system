import { useLayoutEffect, useState } from 'react'

/**
 * Widens a shell element to fill the real browser window, past the shared
 * index.css content cap (--maxw), on any screen with room to spare — not
 * just above a fixed breakpoint. Reads --maxw live (never redefines it) so
 * it can't go stale if that shared value ever changes. Uses
 * document.documentElement.clientWidth rather than a vw CSS unit, since vw
 * includes the scrollbar gutter on some browsers and can silently
 * introduce page-level horizontal scroll — clientWidth cannot.
 *
 * `gutter` is the breathing room left on each side, in pixels. It defaults
 * to the shared .content side padding so a widened shell lines up with
 * every other page; pass a larger value for a page that reads better with
 * the window edges kept at arm's length.
 *
 * `cap` stops the shell growing past a readable width on a very large
 * screen — beyond it the extra room goes to the margins instead. Without
 * one the shell tracks the window however wide it gets.
 *
 * Returns a style object to spread onto the shell, or undefined when the
 * window is too narrow to be worth widening.
 */
export function useWideShell(gutter = 20, cap = Number.POSITIVE_INFINITY) {
  const [style, setStyle] = useState<{ width: number; marginLeft: number } | undefined>()

  useLayoutEffect(() => {
    function measure() {
      const vw = document.documentElement.clientWidth
      // The offset must center the widened shell against the box it really
      // sits in. Layout gives some routes a WIDER content column
      // (.content-wide, e.g. Piece Rate), so measure the actual box —
      // assuming --maxw there would shove the page off the left edge by
      // half the difference. Fall back to --maxw when no box is mounted.
      const box = document.querySelector<HTMLElement>('main.content')
      let contentInner: number
      if (box) {
        const cs = getComputedStyle(box)
        contentInner =
          box.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0)
      } else {
        const maxw =
          parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--maxw')) || 1080
        contentInner = Math.min(maxw, vw) - 40 // .content's own 1.25rem side padding
      }
      const wide = Math.min(vw - gutter * 2, cap)
      if (wide > contentInner) {
        setStyle({ width: wide, marginLeft: (contentInner - wide) / 2 })
      } else {
        setStyle(undefined)
      }
    }

    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [gutter, cap])

  return style
}
