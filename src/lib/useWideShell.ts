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
 * Returns a style object to spread onto the shell, or undefined when the
 * window is too narrow to be worth widening.
 */
export function useWideShell() {
  const [style, setStyle] = useState<{ width: number; marginLeft: number } | undefined>()

  useLayoutEffect(() => {
    const GUTTER = 20 // matches the shared .content side padding (1.25rem)

    function measure() {
      const vw = document.documentElement.clientWidth
      const maxw =
        parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--maxw')) || 1080
      const contentInner = maxw - 40 // .content's own 1.25rem left+right padding
      const wide = vw - GUTTER * 2
      if (wide > contentInner) {
        setStyle({ width: wide, marginLeft: (contentInner - wide) / 2 })
      } else {
        setStyle(undefined)
      }
    }

    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [])

  return style
}
