import type { Camera } from './geometry'

const MIN_ZOOM = 0.02
const MAX_ZOOM = 16

export function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

/** The camera that shows the whole page centered in the viewport. */
export function containCamera(
  viewportWidth: number,
  viewportHeight: number,
  pageWidth: number,
  pageHeight: number,
): Camera {
  if (viewportWidth <= 0 || viewportHeight <= 0 || pageWidth <= 0 || pageHeight <= 0) {
    return { zoom: 1, translation: [0, 0] }
  }
  const zoom = Math.max(
    Number.EPSILON,
    Math.min(viewportWidth / pageWidth, viewportHeight / pageHeight),
  )
  return {
    zoom,
    translation: [
      (viewportWidth - pageWidth * zoom) * 0.5,
      (viewportHeight - pageHeight * zoom) * 0.5,
    ],
  }
}

/** Keeps part of the page in the viewport. All lengths are physical pixels. */
export function clampCameraTranslation(
  translation: [number, number],
  zoom: number,
  pageWidth: number,
  pageHeight: number,
  viewportWidth: number,
  viewportHeight: number,
  dpr: number,
): [number, number] {
  const minOverlap = 100 * dpr
  const minX = minOverlap - pageWidth * zoom
  const minY = minOverlap - pageHeight * zoom
  const maxX = viewportWidth - minOverlap
  const maxY = viewportHeight - minOverlap

  const x =
    minX <= maxX ? clamp(translation[0], minX, maxX) : (viewportWidth - pageWidth * zoom) * 0.5
  const y =
    minY <= maxY ? clamp(translation[1], minY, maxY) : (viewportHeight - pageHeight * zoom) * 0.5
  return [x, y]
}

export interface WheelInput {
  clientX: number
  clientY: number
  deltaX: number
  deltaY: number
  ctrlKey: boolean
  shiftKey: boolean
}

/**
 * The camera after one wheel step over a viewport: Ctrl zooms around the
 * pointer, otherwise the wheel scrolls (Shift scrolls sideways).
 */
export function wheelCamera(
  current: Camera,
  input: WheelInput,
  bounds: DOMRect,
  pageWidth: number,
  pageHeight: number,
): Camera {
  const dpr = window.devicePixelRatio
  let zoom = current.zoom
  let translation = current.translation
  if (input.ctrlKey) {
    const point = { x: (input.clientX - bounds.x) * dpr, y: (input.clientY - bounds.y) * dpr }
    zoom = clamp(current.zoom * Math.exp(-input.deltaY * 0.0015), MIN_ZOOM, MAX_ZOOM)
    const pageX = (point.x - current.translation[0]) / current.zoom
    const pageY = (point.y - current.translation[1]) / current.zoom
    translation = [point.x - pageX * zoom, point.y - pageY * zoom]
  } else {
    let deltaX = input.deltaX
    let deltaY = input.deltaY
    if (input.shiftKey && deltaX === 0) {
      deltaX = deltaY
      deltaY = 0
    }
    translation = [current.translation[0] - deltaX * dpr, current.translation[1] - deltaY * dpr]
  }
  return {
    zoom,
    translation: clampCameraTranslation(
      translation,
      zoom,
      pageWidth,
      pageHeight,
      bounds.width * dpr,
      bounds.height * dpr,
      dpr,
    ),
  }
}

/**
 * The camera that fills a viewport with a box dragged over it, given in CSS
 * pixels from the viewport's top-left corner.
 */
export function boxCamera(
  current: Camera,
  box: { x: number; y: number; width: number; height: number },
  viewport: { width: number; height: number },
  pageWidth: number,
  pageHeight: number,
): Camera {
  const dpr = window.devicePixelRatio
  const zoom = clamp(
    current.zoom * Math.min(viewport.width / box.width, viewport.height / box.height),
    MIN_ZOOM,
    MAX_ZOOM,
  )
  // The page point at the box's center moves to the viewport's center.
  const pageX = ((box.x + box.width / 2) * dpr - current.translation[0]) / current.zoom
  const pageY = ((box.y + box.height / 2) * dpr - current.translation[1]) / current.zoom
  const width = viewport.width * dpr
  const height = viewport.height * dpr
  return {
    zoom,
    translation: clampCameraTranslation(
      [width / 2 - pageX * zoom, height / 2 - pageY * zoom],
      zoom,
      pageWidth,
      pageHeight,
      width,
      height,
      dpr,
    ),
  }
}
