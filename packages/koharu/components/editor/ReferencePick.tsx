'use client'

import { LoaderCircle } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { PlacedImage, placedRect, usePageImage } from '@/components/editor/Compare'
import { call } from '@/lib/backend'
import { pagePoint } from '@/lib/geometry'
import { pageKey, pagesKey, projectKey, refresh, usePages } from '@/lib/queries'
import { useKoharuStore } from '@/lib/store'
import { commands, type Page, type Point } from '@koharu/bridge/protocol'
import { Button } from '@koharu/ui/components/button'

/** Boxes smaller than this, in page pixels, are taken as stray clicks. */
const MIN_PICK = 4

/**
 * Picking where a text element's text is in the page's reference, for text
 * that the automatic pairing missed: the reference is shown over the page,
 * and the box dragged over it is read into the element.
 */
export function ReferencePickOverlay({ page }: { page: Page }) {
  const { t } = useTranslation()
  const layer = useKoharuStore((state) => state.referencePick)
  const camera = useKoharuStore((state) => state.camera)
  const setPick = useKoharuStore((state) => state.setReferencePick)
  const summary = usePages().data?.find((candidate) => candidate.id === page.id)
  const reference = summary?.reference ?? null
  const picking = Boolean(
    layer && reference && page.layers.some((candidate) => candidate.id === layer),
  )
  const source = usePageImage(page.id, 'source', picking ? (summary?.source_asset ?? null) : null)
  const image = usePageImage(page.id, 'reference', picking ? (reference?.asset ?? null) : null)
  const [drag, setDrag] = useState<{ pointer: number; start: Point; end: Point } | null>(null)
  const [reading, setReading] = useState(false)
  const surface = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (picking) surface.current?.focus()
  }, [picking])

  if (!picking || !layer || !reference) return null

  const dpr = window.devicePixelRatio
  const box = drag && {
    x: Math.min(drag.start.x, drag.end.x),
    y: Math.min(drag.start.y, drag.end.y),
    width: Math.abs(drag.end.x - drag.start.x),
    height: Math.abs(drag.end.y - drag.start.y),
  }
  const point = (event: { clientX: number; clientY: number }) =>
    pagePoint(
      event.clientX,
      event.clientY,
      surface.current!.getBoundingClientRect(),
      useKoharuStore.getState().camera,
    )

  return (
    <div
      ref={surface}
      data-canvas-control
      role='application'
      aria-label={t('references.pickSurface')}
      aria-busy={reading}
      tabIndex={0}
      className='absolute inset-0 z-10 cursor-crosshair touch-none outline-none'
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return
        event.preventDefault()
        event.stopPropagation()
        setPick(null)
      }}
      onPointerDown={(event) => {
        if (event.button !== 0 || reading) return
        event.currentTarget.setPointerCapture(event.pointerId)
        const start = point(event)
        setDrag({ pointer: event.pointerId, start, end: start })
      }}
      onPointerMove={(event) => {
        if (drag?.pointer === event.pointerId) setDrag({ ...drag, end: point(event) })
      }}
      onPointerUp={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId)
        }
        if (!drag || drag.pointer !== event.pointerId) return
        const end = point(event)
        const area = {
          x: Math.min(drag.start.x, end.x),
          y: Math.min(drag.start.y, end.y),
          width: Math.abs(end.x - drag.start.x),
          height: Math.abs(end.y - drag.start.y),
        }
        setDrag(null)
        if (area.width < MIN_PICK || area.height < MIN_PICK) return
        setReading(true)
        void call(commands.readReferenceArea, layer, area)
          .then(async () => {
            setPick(null)
            await refresh(projectKey, pagesKey, pageKey)
          })
          .catch(() => undefined)
          .finally(() => setReading(false))
      }}
      onPointerCancel={() => setDrag(null)}
    >
      {source && (
        <PlacedImage
          url={source}
          rect={{ x: 0, y: 0, width: page.size.width, height: page.size.height }}
          camera={camera}
          label={t('compare.original')}
        />
      )}
      {image && (
        <PlacedImage
          url={image}
          rect={placedRect(reference.placement, page.size)}
          camera={camera}
          label={t('compare.reference')}
        />
      )}
      {box && (
        <div
          data-testid='reference-pick-box'
          className='pointer-events-none absolute border-2 border-primary bg-primary/10'
          style={{
            left: (camera.translation[0] + box.x * camera.zoom) / dpr,
            top: (camera.translation[1] + box.y * camera.zoom) / dpr,
            width: (box.width * camera.zoom) / dpr,
            height: (box.height * camera.zoom) / dpr,
          }}
        />
      )}
      <div
        role='status'
        className='absolute top-2 left-1/2 z-20 flex -translate-x-1/2 items-center gap-2 rounded-lg border border-border/70 bg-popover/95 px-2.5 py-1.5 text-[11px] shadow-md'
      >
        {reading && <LoaderCircle className='size-3.5 animate-spin' />}
        {reading ? t('references.pickReading') : t('references.pickHint')}
        <Button
          type='button'
          size='xs'
          variant='ghost'
          disabled={reading}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => setPick(null)}
        >
          {t('common.cancel')}
        </Button>
      </div>
    </div>
  )
}
