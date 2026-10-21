'use client'

import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'

import { boxCamera } from '@/lib/camera'
import { useKoharuStore } from '@/lib/store'

interface Box {
  x: number
  y: number
  width: number
  height: number
}

/** A Ctrl+drag that moves less than this, in CSS pixels, is a Ctrl+click. */
const CLICK_DISTANCE = 4

/**
 * Ctrl+drag over a view of the page draws a box, and the view zooms to it.
 * The handlers say whether they took the event, so each view keeps its own
 * plain dragging; render `box` inside the view while one is drawn.
 */
export function useMarqueeZoom(page: { width: number; height: number } | null) {
  const [box, setBox] = useState<Box | null>(null)
  const drag = useRef<{ pointer: number; x: number; y: number; bounds: DOMRect } | null>(null)

  const boxTo = (event: ReactPointerEvent<HTMLElement>): Box => {
    const start = drag.current!
    const x = event.clientX - start.bounds.x
    const y = event.clientY - start.bounds.y
    return {
      x: Math.min(start.x, x),
      y: Math.min(start.y, y),
      width: Math.abs(x - start.x),
      height: Math.abs(y - start.y),
    }
  }

  return {
    start(event: ReactPointerEvent<HTMLElement>): boolean {
      if (event.button !== 0 || !(event.ctrlKey || event.metaKey) || !page) return false
      event.preventDefault()
      event.currentTarget.setPointerCapture(event.pointerId)
      const bounds = event.currentTarget.getBoundingClientRect()
      drag.current = {
        pointer: event.pointerId,
        x: event.clientX - bounds.x,
        y: event.clientY - bounds.y,
        bounds,
      }
      return true
    },
    move(event: ReactPointerEvent<HTMLElement>): boolean {
      if (drag.current?.pointer !== event.pointerId) return false
      setBox(boxTo(event))
      return true
    },
    /** Zooms to the box drawn, or reports a click when the pointer barely moved. */
    end(event: ReactPointerEvent<HTMLElement>): 'zoom' | 'click' | null {
      const start = drag.current
      if (!start || start.pointer !== event.pointerId || !page) return null
      const drawn = boxTo(event)
      drag.current = null
      setBox(null)
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId)
      }
      if (drawn.width < CLICK_DISTANCE && drawn.height < CLICK_DISTANCE) return 'click'
      const camera = boxCamera(
        useKoharuStore.getState().camera,
        drawn,
        start.bounds,
        page.width,
        page.height,
      )
      useKoharuStore.setState({ camera: { ...camera, fitted: false } })
      return 'zoom'
    },
    cancel() {
      drag.current = null
      setBox(null)
    },
    box: box && (
      <div
        data-testid='zoom-box'
        className='pointer-events-none absolute z-30 border border-dashed border-primary bg-primary/10'
        style={{ left: box.x, top: box.y, width: box.width, height: box.height }}
      />
    ),
  }
}
