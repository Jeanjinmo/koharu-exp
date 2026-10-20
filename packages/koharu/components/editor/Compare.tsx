'use client'

import { useQuery } from '@tanstack/react-query'
import { ChevronDown, Columns2 } from 'lucide-react'
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { useTranslation } from 'react-i18next'

import { call } from '@/lib/backend'
import { clampCameraTranslation, wheelCamera } from '@/lib/camera'
import type { Camera } from '@/lib/geometry'
import { usePages } from '@/lib/queries'
import { compareModes, useKoharuStore } from '@/lib/store'
import { commands, type Page } from '@koharu/bridge/protocol'
import { Button } from '@koharu/ui/components/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@koharu/ui/components/dropdown-menu'
import { cn } from '@koharu/ui/lib/utils'

/**
 * The page's original artwork as an image URL. It is the page's source asset,
 * so showing it never changes the project or its layer visibility.
 */
function useOriginal(page: string | undefined) {
  const pages = usePages(page !== undefined).data
  const asset = pages?.find((candidate) => candidate.id === page)?.source_asset ?? null
  const bytes = useQuery({
    queryKey: ['page-image', page, 'source', asset],
    queryFn: async () => new Uint8Array(await call(commands.getPageImage, page!, 'source')),
    enabled: page !== undefined && asset !== null,
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

  return { url, missing: pages !== undefined && asset === null }
}

/** Draws the original with the editor's camera, so it lines up with the canvas. */
function Original({ page, url, camera }: { page: Page; url: string; camera: Camera }) {
  const { t } = useTranslation()
  const dpr = window.devicePixelRatio
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={url}
      alt={t('compare.original')}
      draggable={false}
      className='pointer-events-none absolute top-0 left-0 max-w-none origin-top-left select-none'
      style={{
        width: page.size.width,
        height: page.size.height,
        transform: `translate(${camera.translation[0] / dpr}px, ${camera.translation[1] / dpr}px) scale(${camera.zoom / dpr})`,
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
  const { url, missing } = useOriginal(page.id)
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
      aria-label={t('compare.original')}
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
      {url && <Original page={page} url={url} camera={camera} />}
      {missing && (
        <p className='absolute inset-0 grid place-items-center text-[12px] text-muted-foreground'>
          {t('compare.noOriginal')}
        </p>
      )}
      <span className='pointer-events-none absolute top-2 left-2 rounded-md bg-background/85 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground shadow-sm'>
        {t('compare.original')}
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
  const { url } = useOriginal(page.id)
  const dragging = useRef<number | null>(null)

  if (!compare.open || compare.mode === 'side_by_side') return null

  if (compare.mode === 'peek') {
    return compare.peeking ? (
      url && <Original page={page} url={url} camera={camera} />
    ) : (
      <span className='pointer-events-none absolute bottom-2 left-1/2 z-10 -translate-x-1/2 rounded-md bg-background/85 px-2 py-0.5 text-[10px] text-muted-foreground shadow-sm'>
        {t('compare.peekHint', { key: shortcut.toUpperCase() })}
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
        {url && <Original page={page} url={url} camera={camera} />}
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

/** Turns Compare on and off and picks how it shows the original. */
export function CompareButton() {
  const { t } = useTranslation()
  const compare = useKoharuStore((state) => state.compare)
  const setOpen = useKoharuStore((state) => state.setCompareOpen)
  const setMode = useKoharuStore((state) => state.setCompareMode)
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
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
