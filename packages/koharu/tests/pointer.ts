import { fireEvent } from '@testing-library/react'
import { vi } from 'vitest'

/** Gives `element` a layout box, in client coordinates. */
export function place(
  element: Element,
  box: { x: number; y: number; width: number; height: number },
) {
  Object.defineProperty(element, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      ...box,
      left: box.x,
      top: box.y,
      right: box.x + box.width,
      bottom: box.y + box.height,
    }),
  })
}

/**
 * Drags `source` onto `target` as a pointer does. The source captures the
 * press, so the moves, the release, and the click that follows all go to it,
 * while `target` is the element under the pointer. With `after`, the pointer
 * ends over the target's lower half.
 */
export function dragOnto(source: Element, target: Element, { after = false } = {}) {
  place(target, { x: 0, y: 200, width: 240, height: 72 })
  const under = vi.spyOn(document, 'elementFromPoint').mockReturnValue(target)
  const end = { clientX: 40, clientY: after ? 260 : 210 }
  fireEvent.pointerDown(source, { pointerId: 7, button: 0, buttons: 1, clientX: 40, clientY: 30 })
  fireEvent.pointerMove(source, { pointerId: 7, buttons: 1, clientX: 40, clientY: 120 })
  fireEvent.pointerMove(source, { pointerId: 7, buttons: 1, ...end })
  fireEvent.pointerUp(source, { pointerId: 7, button: 0, ...end })
  fireEvent.click(source, end)
  under.mockRestore()
}
