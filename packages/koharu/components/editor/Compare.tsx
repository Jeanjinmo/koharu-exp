'use client'

import { useQuery } from '@tanstack/react-query'
import { ChevronDown, Columns2 } from 'lucide-react'
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { useTranslation } from 'react-i18next'

import { call } from '@/lib/backend'
import { clampCameraTranslation, wheelCamera } from '@/lib/camera'
import type { Camera } from '@/lib/geometry'
import { usePage, usePages } from '@/lib/queries'
import { compareModes, useKoharuStore, type CompareSubject } from '@/lib/store'
import {
  commands,
  type Page,
  type PageImage,
  type PageSize,
  type ReferencePlacement,
} from '@koharu/bridge/protocol'
import { Button } from '@koharu/ui/components/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@koharu/ui/components/dropdown-menu'
import { cn } from '@koharu/ui/lib/utils'

/** One of a page's images at full resolution, as an object URL. */
export function usePageImage(page: string, image: PageImage, asset: string | null) {
  const bytes = useQuery({
    queryKey: ['page-image', page, image, asset],
    queryFn: async () => new Uint8Array(await call(commands.getPageImage, page, image)),
    enabled: asset !== null,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 60 * 1000,
  }).data
  const [url, setUrl] = useState<string | null>(null)

  useEffect(() => {
    if (!bytes) {
      setUrl(null)
      return
    }
    const next = URL.createObjectURL(new Blob([bytes.buffer as ArrayBuffer]))
    setUrl(next)
    return () => URL.revokeObjectURL(next)
  }, [bytes])

  return url
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** Where a reference lies over a page, in page pixels. */
export function placedRect(placement: ReferencePlacement, size: PageSize): Rect {
  return {
    x: placement.x * size.width,
    y: placement.y * size.height,
    width: placement.width * size.width,
    height: placement.height * size.height,
  }
}

/**
 * What Compare shows beside the result: the page's reference when it has one
 * and Compare is set to it, otherwise the original artwork. Both are page
 * assets, so showing them never changes the project or layer visibility.
 * The image loads only while `shown`.
 */
function useComparison(page: Page, shown: boolean) {
  const { t } = useTranslation()
  const summary = usePages().data?.find((candidate) => candidate.id === page.id)
  const subject = useKoharuStore((state) => state.compare.subject)
  const reference = subject === 'reference' ? (summary?.reference ?? null) : null
  const asset = reference ? reference.asset : (summary?.source_asset ?? null)
  const url = usePageImage(page.id, reference ? 'reference' : 'source', shown ? asset : null)
  return reference
    ? {
        reference: true,
        url,
        label: t('compare.reference'),
        rect: placedRect(reference.placement, page.size),
        missing: false,
      }
    : {
        reference: false,
        url,
        label: t('compare.original'),
        rect: { x: 0, y: 0, width: page.size.width, height: page.size.height },
        missing: summary !== undefined && summary.source_asset === null,
      }
}

/** Draws a page image with the editor's camera, so it lines up with the canvas. */
export function PlacedImage({
  url,
  rect,
  camera,
  label,
  opacity,
  blend,
  filter,
}: {
  url: string
  rect: Rect
  camera: Camera
  label: string
  opacity?: number
  blend?: 'difference' | 'multiply'
  filter?: string
}) {
  const dpr = window.devicePixelRatio
  const x = camera.translation[0] + rect.x * camera.zoom
  const y = camera.translation[1] + rect.y * camera.zoom
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={url}
      alt={label}
      draggable={false}
      className='pointer-events-none absolute top-0 left-0 max-w-none origin-top-left select-none'
      style={{
        width: rect.width,
        height: rect.height,
        opacity,
        mixBlendMode: blend,
        filter,
        transform: `translate(${x / dpr}px, ${y / dpr}px) scale(${camera.zoom / dpr})`,
      }}
    />
  )
}

/**
 * The view-only left half of side by side. Wheel and drag move the shared
 * camera, so both halves keep showing the same part of the page.
 */
export function ComparePane({ page }: { page: Page }) {
  const { t } = useTranslation()
  const camera = useKoharuStore((state) => state.camera)
  const comparison = useComparison(page, true)
  const pan = useRef<{ pointer: number; x: number; y: number; translation: [number, number] }>(null)

  const move = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = pan.current
    if (!start || start.pointer !== event.pointerId) return
    const bounds = event.currentTarget.getBoundingClientRect()
    const dpr = window.devicePixelRatio
    const current = useKoharuStore.getState().camera
    const translation = clampCameraTranslation(
      [
        start.translation[0] + (event.clientX - start.x) * dpr,
        start.translation[1] + (event.clientY - start.y) * dpr,
      ],
      current.zoom,
      page.size.width,
      page.size.height,
      bounds.width * dpr,
      bounds.height * dpr,
      dpr,
    )
    useKoharuStore.setState({ camera: { zoom: current.zoom, translation, fitted: false } })
  }

  return (
    <section
      aria-label={comparison.label}
      className='relative min-h-0 min-w-0 flex-1 cursor-grab touch-none overflow-hidden border-r border-border/80 bg-[var(--surface-canvas)]'
      onWheel={(event) => {
        event.preventDefault()
        const next = wheelCamera(
          useKoharuStore.getState().camera,
          event,
          event.currentTarget.getBoundingClientRect(),
          page.size.width,
          page.size.height,
        )
        useKoharuStore.setState({ camera: { ...next, fitted: false } })
      }}
      onPointerDown={(event) => {
        if (event.button > 1) return
        event.currentTarget.setPointerCapture(event.pointerId)
        pan.current = {
          pointer: event.pointerId,
          x: event.clientX,
          y: event.clientY,
          translation: useKoharuStore.getState().camera.translation,
        }
      }}
      onPointerMove={move}
      onPointerUp={(event) => {
        pan.current = null
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId)
        }
      }}
      onPointerCancel={() => {
        pan.current = null
      }}
    >
      {comparison.url && (
        <PlacedImage
          url={comparison.url}
          rect={comparison.rect}
          camera={camera}
          label={comparison.label}
        />
      )}
      {comparison.missing && (
        <p className='absolute inset-0 grid place-items-center text-[12px] text-muted-foreground'>
          {t('compare.noOriginal')}
        </p>
      )}
      <span className='pointer-events-none absolute top-2 left-2 rounded-md bg-background/85 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground shadow-sm'>
        {comparison.label}
      </span>
    </section>
  )
}

/**
 * Slider and hold to peek draw the original over the editable canvas inside
 * the same surface: the slider left of its line, the peek over everything.
 */
export function CompareOverlay({ page }: { page: Page }) {
  const { t } = useTranslation()
  const compare = useKoharuStore((state) => state.compare)
  const camera = useKoharuStore((state) => state.camera)
  const shortcut = useKoharuStore((state) => state.shortcuts.compare)
  const setSplit = useKoharuStore((state) => state.setCompareSplit)
  const comparison = useComparison(page, compare.open && compare.mode !== 'side_by_side')
  const dragging = useRef<number | null>(null)

  if (!compare.open || compare.mode === 'side_by_side') return null

  const image = comparison.url && (
    <PlacedImage
      url={comparison.url}
      rect={comparison.rect}
      camera={camera}
      label={comparison.label}
    />
  )

  if (compare.mode === 'peek') {
    return compare.peeking ? (
      image
    ) : (
      <span className='pointer-events-none absolute bottom-2 left-1/2 z-10 -translate-x-1/2 rounded-md bg-background/85 px-2 py-0.5 text-[10px] text-muted-foreground shadow-sm'>
        {t(comparison.reference ? 'compare.peekReferenceHint' : 'compare.peekHint', {
          key: shortcut.toUpperCase(),
        })}
      </span>
    )
  }

  const updateSplit = (event: ReactPointerEvent<HTMLElement>) => {
    const surface = event.currentTarget.parentElement?.getBoundingClientRect()
    if (!surface || surface.width <= 0) return
    setSplit((event.clientX - surface.left) / surface.width)
  }

  return (
    <>
      {/* The clip spans the whole surface, as the divider does, so the two
          meet wherever the page sits in the view. */}
      <div
        data-testid='compare-slider-clip'
        className='pointer-events-none absolute inset-0 overflow-hidden'
        style={{ clipPath: `inset(0 ${(1 - compare.split) * 100}% 0 0)` }}
      >
        {image}
      </div>
      <div
        data-canvas-control
        role='slider'
        aria-label={t('compare.divider')}
        aria-orientation='horizontal'
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(compare.split * 100)}
        tabIndex={0}
        className='absolute inset-y-0 z-10 w-4 -translate-x-1/2 cursor-ew-resize touch-none outline-none focus-visible:[&>span]:bg-ring'
        style={{ left: `${compare.split * 100}%` }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowLeft') setSplit(compare.split - 0.02)
          else if (event.key === 'ArrowRight') setSplit(compare.split + 0.02)
          else return
          event.preventDefault()
          event.stopPropagation()
        }}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId)
          dragging.current = event.pointerId
        }}
        onPointerMove={(event) => {
          if (dragging.current === event.pointerId) updateSplit(event)
        }}
        onPointerUp={(event) => {
          dragging.current = null
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId)
          }
        }}
      >
        <span className='absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 bg-primary shadow-[0_0_0_1px_rgb(0_0_0/0.15)]' />
        <span className='absolute top-1/2 left-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-primary bg-background' />
      </div>
    </>
  )
}

/** Turns Compare on and off and picks how and with what it compares. */
export function CompareButton() {
  const { t } = useTranslation()
  const compare = useKoharuStore((state) => state.compare)
  const setOpen = useKoharuStore((state) => state.setCompareOpen)
  const setMode = useKoharuStore((state) => state.setCompareMode)
  const setSubject = useKoharuStore((state) => state.setCompareSubject)
  const startTracing = useKoharuStore((state) => state.startTracing)
  const active = usePage().data?.id
  const reference = usePages().data?.find((page) => page.id === active)?.reference ?? null
  return (
    <div className='flex items-center'>
      <Button
        type='button'
        variant='ghost'
        size='xs'
        aria-pressed={compare.open}
        data-active={compare.open}
        className='h-5 gap-1 rounded-r-none px-1.5 text-[10px] data-[active=true]:bg-primary/10 data-[active=true]:text-primary'
        onClick={() => setOpen(!compare.open)}
      >
        <Columns2 className='size-3' /> {t('compare.title')}
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              type='button'
              variant='ghost'
              size='xs'
              aria-label={t('compare.modes')}
              className={cn('h-5 rounded-l-none px-0.5', compare.open && 'text-primary')}
            />
          }
        >
          <ChevronDown className='size-3' />
        </DropdownMenuTrigger>
        <DropdownMenuContent align='end' side='top'>
          <DropdownMenuGroup>
            <DropdownMenuLabel>{t('compare.modes')}</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={compare.mode}
              onValueChange={(mode) => {
                setMode(mode as typeof compare.mode)
                setOpen(true)
              }}
            >
              {compareModes.map((mode) => (
                <DropdownMenuRadioItem key={mode} value={mode}>
                  {t(`compare.mode.${mode}`)}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuGroup>
          {active && reference && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuLabel>{t('compare.subject')}</DropdownMenuLabel>
                <DropdownMenuRadioGroup
                  value={compare.subject}
                  onValueChange={(subject) => {
                    setSubject(subject as CompareSubject)
                    setOpen(true)
                  }}
                >
                  <DropdownMenuRadioItem value='reference'>
                    {t('compare.reference')}
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value='original'>
                    {t('compare.original')}
                  </DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => startTracing(active, reference.placement)}>
                {t('tracing.align')}
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
