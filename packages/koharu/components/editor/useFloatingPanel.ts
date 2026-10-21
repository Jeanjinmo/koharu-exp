'use client'

import {
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'

interface Position {
  x: number
  y: number
}

interface PanelPlace {
  /** The panel's top-left corner in its parent, in CSS pixels; `null` keeps its default place. */
  position: Position | null
  collapsed: boolean
}

const unplaced: PanelPlace = { position: null, collapsed: false }

const storageKey = (id: string) => `koharu.panel.${id}`

// Each panel's place is remembered on this device; storage may be unavailable.
function remembered(id: string): PanelPlace {
  try {
    const stored: unknown = JSON.parse(window.localStorage.getItem(storageKey(id)) ?? 'null')
    if (typeof stored !== 'object' || stored === null) return unplaced
    const { position, collapsed } = stored as Partial<PanelPlace>
    const placed =
      typeof position === 'object' &&
      position !== null &&
      Number.isFinite(position.x) &&
      Number.isFinite(position.y)
    return { position: placed ? position : null, collapsed: collapsed === true }
  } catch {
    return unplaced
  }
}

function remember(id: string, place: PanelPlace): void {
  try {
    window.localStorage.setItem(storageKey(id), JSON.stringify(place))
  } catch {
    // The place then lasts only for this session.
  }
}

/** Where `x` and `y` put the panel when it may not leave its parent. */
function inside(panel: HTMLElement, x: number, y: number): Position {
  const area = panel.parentElement!.getBoundingClientRect()
  const box = panel.getBoundingClientRect()
  return {
    x: Math.min(Math.max(0, area.width - box.width), Math.max(0, x)),
    y: Math.min(Math.max(0, area.height - box.height), Math.max(0, y)),
  }
}

/**
 * A panel floating over the canvas that can be dragged by a handle and
 * collapsed. Its parent must be the area it floats in, which it never leaves.
 * Double-clicking the handle puts it back in its default place.
 */
export function useFloatingPanel<T extends HTMLElement>(id: string) {
  const panel = useRef<T>(null)
  const [place, setPlace] = useState(() => remembered(id))
  const drag = useRef<{
    pointer: number
    x: number
    y: number
    start: Position
    position: Position | null
  } | null>(null)

  const update = (next: PanelPlace) => {
    setPlace(next)
    remember(id, next)
  }

  // A smaller canvas or a panel opened up may push a moved panel past the
  // edge; it is pulled back in while shown, but its remembered place stays.
  const position = place.position
  useLayoutEffect(() => {
    const element = panel.current
    if (!element?.parentElement || !position) return
    const fit = () => {
      // An area that is not laid out yet has no edge to keep the panel within.
      const area = element.parentElement?.getBoundingClientRect()
      if (!area || (area.width === 0 && area.height === 0)) return
      const next = inside(element, position.x, position.y)
      if (next.x !== position.x || next.y !== position.y) {
        setPlace((current) => ({ ...current, position: next }))
      }
    }
    fit()
    const observer = new ResizeObserver(fit)
    observer.observe(element.parentElement)
    observer.observe(element)
    return () => observer.disconnect()
  }, [position, place.collapsed])

  const handle = {
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => {
      const element = panel.current
      if (event.button !== 0 || !element?.parentElement) return
      // The handle's own buttons keep their clicks.
      if (event.target instanceof Element && event.target.closest('button')) return
      event.preventDefault()
      event.currentTarget.setPointerCapture(event.pointerId)
      const area = element.parentElement.getBoundingClientRect()
      const box = element.getBoundingClientRect()
      drag.current = {
        pointer: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        start: { x: box.left - area.left, y: box.top - area.top },
        position: null,
      }
    },
    onPointerMove: (event: ReactPointerEvent<HTMLElement>) => {
      const current = drag.current
      if (!current || current.pointer !== event.pointerId || !panel.current) return
      const next = inside(
        panel.current,
        current.start.x + event.clientX - current.x,
        current.start.y + event.clientY - current.y,
      )
      current.position = next
      setPlace((previous) => ({ ...previous, position: next }))
    },
    onPointerUp: (event: ReactPointerEvent<HTMLElement>) => {
      const current = drag.current
      if (!current || current.pointer !== event.pointerId) return
      drag.current = null
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId)
      }
      if (current.position) update({ ...place, position: current.position })
    },
    onPointerCancel: () => {
      drag.current = null
    },
    onDoubleClick: (event: ReactMouseEvent<HTMLElement>) => {
      if (event.target instanceof Element && event.target.closest('button')) return
      update({ ...place, position: null })
    },
  }

  const style: CSSProperties | undefined = position
    ? { left: position.x, top: position.y, right: 'auto', translate: 'none' }
    : undefined

  return {
    ref: panel,
    style,
    collapsed: place.collapsed,
    toggle: () => update({ ...place, collapsed: !place.collapsed }),
    handle,
  }
}
