import { useRef, type MouseEvent } from 'react'

/**
 * Props for a modal backdrop that closes the window when you click OUTSIDE
 * it — but only when the click both started and finished on the backdrop.
 *
 * A plain onClick is not enough: selecting text inside the window and
 * releasing the mouse past its edge still lands a click on the backdrop
 * (the click fires on their common ancestor), which would shut the window
 * in the middle of a selection or a drag.
 *
 * Spread the result onto the overlay element.
 */
export function useOverlayClose(onClose: () => void) {
  const startedOnBackdrop = useRef(false)

  return {
    onMouseDown: (e: MouseEvent) => {
      startedOnBackdrop.current = e.target === e.currentTarget
    },
    onClick: (e: MouseEvent) => {
      const outside = e.target === e.currentTarget && startedOnBackdrop.current
      startedOnBackdrop.current = false
      if (outside) onClose()
    },
  }
}
