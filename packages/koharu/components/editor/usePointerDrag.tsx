'use client'

import {
  useEffect,
  useId,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from 'react'
import { createPortal } from 'react-dom'

/** A press that moves less than this, in CSS pixels, stays a click. */
const DRAG_DISTANCE = 4
/** How near a list's top or bottom edge, in CSS pixels, a drag scrolls it. */
const SCROLL_EDGE = 40
/** The fastest edge scrolling, in CSS pixels per frame. */
const SCROLL_STEP = 14

/** The drop target under the pointer, marked by `target()`. */
export interface DropTarget {
  id: string
  /** Whether the pointer is over the target's lower half. */
  after: boolean
}

/** Props that make an element a place to drop on. */
export type DropTargetProps = Readonly<Record<'data-drag-target' | 'data-drag-scope', string>>

export interface Dragging<T> {
  item: T
  /** Where the pointer is, in client coordinates. */
  x: number
  y: number
  target: DropTarget | null
}

function targetAt(scope: string, x: number, y: number): DropTarget | null {
  const element = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-drag-target]')
  if (!element || element.dataset.dragScope !== scope) return null
  const box = element.getBoundingClientRect()
  return { id: element.dataset.dragTarget!, after: y > box.top + box.height / 2 }
}

/**
 * Dragging with pointer events, which the desktop webview delivers where it
 * never completes an HTML drag and drop: pressing a source and moving a few
 * pixels picks up its item, the target is whichever element marked by
 * `target()` is under the pointer, and releasing drops the item there. A press
 * that does not move stays a click. Holding the pointer near the top or bottom
 * of `scroller` scrolls it.
 *
 * The source holds the pointer for the whole drag, so it must stay mounted
 * until the drag ends.
 */
export function usePointerDrag<T>({
  onDrop,
  scroller,
}: {
  onDrop: (item: T, target: DropTarget) => void
  scroller?: RefObject<HTMLElement | null>
}) {
  const scope = useId()
  const [dragging, setDragging] = useState<Dragging<T> | null>(null)
  const press = useRef<{ pointer: number; x: number; y: number; item: T; moved: boolean }>(null)
  const pointer = useRef({ x: 0, y: 0 })
  // The click that ends a drag is not a click on what was dragged.
  const dropped = useRef(false)
  const drop = useRef(onDrop)
  useEffect(() => {
    drop.current = onDrop
  })

  const active = dragging !== null
  useEffect(() => {
    const list = scroller?.current
    if (!active || !list) return
    let frame = requestAnimationFrame(function step() {
      const box = list.getBoundingClientRect()
      const { x, y } = pointer.current
      const reach =
        x < box.left || x > box.right
          ? 0
          : y < box.top + SCROLL_EDGE
            ? y - box.top - SCROLL_EDGE
            : y > box.bottom - SCROLL_EDGE
              ? y - box.bottom + SCROLL_EDGE
              : 0
      if (reach !== 0) {
        const speed = Math.min(
          SCROLL_STEP,
          Math.ceil((Math.abs(reach) / SCROLL_EDGE) * SCROLL_STEP),
        )
        list.scrollTop += Math.sign(reach) * speed
        setDragging((current) => current && { ...current, target: targetAt(scope, x, y) })
      }
      frame = requestAnimationFrame(step)
    })
    return () => cancelAnimationFrame(frame)
  }, [active, scope, scroller])

  const end = () => {
    press.current = null
    setDragging(null)
  }

  return {
    dragging,
    /** Props for an element that can be dragged, carrying `item`. */
    source: (item: T) => ({
      onPointerDown: (event: ReactPointerEvent<HTMLElement>) => {
        const target = event.target as Element
        // Its buttons keep their presses, as do menus that React passes up
        // from elsewhere in the page.
        if (event.button !== 0 || !event.currentTarget.contains(target) || target.closest('button'))
          return
        dropped.current = false
        event.currentTarget.setPointerCapture(event.pointerId)
        press.current = {
          pointer: event.pointerId,
          x: event.clientX,
          y: event.clientY,
          item,
          moved: false,
        }
      },
      onPointerMove: (event: ReactPointerEvent<HTMLElement>) => {
        const current = press.current
        if (!current || current.pointer !== event.pointerId) return
        const distance = Math.hypot(event.clientX - current.x, event.clientY - current.y)
        if (!current.moved && distance < DRAG_DISTANCE) return
        current.moved = true
        pointer.current = { x: event.clientX, y: event.clientY }
        setDragging({
          item: current.item,
          x: event.clientX,
          y: event.clientY,
          target: targetAt(scope, event.clientX, event.clientY),
        })
      },
      onPointerUp: (event: ReactPointerEvent<HTMLElement>) => {
        const current = press.current
        if (!current || current.pointer !== event.pointerId) return
        end()
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId)
        }
        if (!current.moved) return
        dropped.current = true
        const target = targetAt(scope, event.clientX, event.clientY)
        if (target) drop.current(current.item, target)
      },
      onPointerCancel: end,
      onLostPointerCapture: end,
      onClickCapture: (event: ReactMouseEvent<HTMLElement>) => {
        if (!dropped.current) return
        dropped.current = false
        event.preventDefault()
        event.stopPropagation()
      },
    }),
    /** Props that make an element a place to drop on, known by `id`. */
    target: (id: string): DropTargetProps => ({ 'data-drag-target': id, 'data-drag-scope': scope }),
  }
}

/** What is being dragged, drawn beside the pointer above everything else. */
export function DragGhost({ x, y, children }: { x: number; y: number; children: ReactNode }) {
  return createPortal(
    <div
      aria-hidden
      className='pointer-events-none fixed top-0 left-0 z-[100]'
      style={{ transform: `translate(${x + 12}px, ${y + 8}px)` }}
    >
      {children}
    </div>,
    document.body,
  )
}
