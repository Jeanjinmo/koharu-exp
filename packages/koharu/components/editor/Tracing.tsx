'use client'

import { ChevronDown, ChevronUp, GripHorizontal, Minus, Plus, RotateCcw, X } from 'lucide-react'
import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'

import { PlacedImage, placedRect, usePageImage } from '@/components/editor/Compare'
import { useFloatingPanel } from '@/components/editor/useFloatingPanel'
import { call } from '@/lib/backend'
import { pagesKey, projectKey, refresh, usePages } from '@/lib/queries'
import { TRACING_OPACITY, useKoharuStore } from '@/lib/store'
import { commands, type Page, type ReferencePlacement } from '@koharu/bridge/protocol'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@koharu/ui/components/alert-dialog'
import { Button } from '@koharu/ui/components/button'
import { Input } from '@koharu/ui/components/input'
import { toast } from '@koharu/ui/components/toast'
import { cn } from '@koharu/ui/lib/utils'

const FILL: ReferencePlacement = { x: 0, y: 0, width: 1, height: 1 }

/** Scales a placement by `factor` around a point given in page fractions. */
function scaled(placement: ReferencePlacement, factor: number, x: number, y: number) {
  return {
    x: x - (x - placement.x) * factor,
    y: y - (y - placement.y) * factor,
    width: placement.width * factor,
    height: placement.height * factor,
  }
}

async function savePlacement(pages: string[], placement: ReferencePlacement) {
  await call(commands.setReferencePlacement, pages, placement)
  await refresh(projectKey, pagesKey)
}

/**
 * Aligning a reference by hand: the reference, partly transparent, over the
 * page's original artwork. Dragging moves it, Alt+wheel resizes it around the
 * pointer, and the arrow keys nudge it. Other wheel input still moves the
 * camera, so the alignment can be checked up close.
 */
export function TracingOverlay({ page }: { page: Page }) {
  const { t } = useTranslation()
  const tracing = useKoharuStore((state) => state.tracing)
  const camera = useKoharuStore((state) => state.camera)
  const moveTracing = useKoharuStore((state) => state.moveTracing)
  const summary = usePages().data?.find((candidate) => candidate.id === page.id)
  const active = tracing?.page === page.id ? tracing : null
  const source = usePageImage(page.id, 'source', active ? (summary?.source_asset ?? null) : null)
  const reference = usePageImage(
    page.id,
    'reference',
    active ? (summary?.reference?.asset ?? null) : null,
  )
  const drag = useRef<{
    pointer: number
    x: number
    y: number
    placement: ReferencePlacement
    moved: boolean
  } | null>(null)
  // Alt+wheel steps closer together than this are one undo step.
  const lastWheel = useRef(Number.NEGATIVE_INFINITY)
  const surface = useRef<HTMLDivElement>(null)

  // Focus the overlay when aligning starts, so the arrow keys nudge at once.
  const aligning = Boolean(active?.placement)
  useEffect(() => {
    if (aligning) surface.current?.focus()
  }, [active?.page, aligning])

  const placement = active?.placement
  if (!active || !placement) return null

  // Page pixels per CSS pixel along each axis, as fractions of the page.
  const dpr = window.devicePixelRatio
  const perPixel = {
    x: dpr / camera.zoom / page.size.width,
    y: dpr / camera.zoom / page.size.height,
  }

  const nudge = (event: ReactKeyboardEvent) => {
    const step = event.shiftKey ? 10 : 1
    const delta = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    }[event.key]
    if (!delta) return
    event.preventDefault()
    event.stopPropagation()
    moveTracing(
      {
        ...placement,
        x: placement.x + delta[0] / page.size.width,
        y: placement.y + delta[1] / page.size.height,
      },
      !event.repeat,
    )
  }

  return (
    <div
      ref={surface}
      data-canvas-control
      role='application'
      aria-label={t('tracing.surface')}
      tabIndex={0}
      className='absolute inset-0 z-10 cursor-move touch-none outline-none'
      onKeyDown={nudge}
      onPointerDown={(event) => {
        if (event.button !== 0) return
        event.currentTarget.focus()
        event.currentTarget.setPointerCapture(event.pointerId)
        drag.current = {
          pointer: event.pointerId,
          x: event.clientX,
          y: event.clientY,
          placement,
          moved: false,
        }
      }}
      onPointerMove={(event) => {
        const start = drag.current
        if (!start || start.pointer !== event.pointerId) return
        moveTracing(
          {
            ...start.placement,
            x: start.placement.x + (event.clientX - start.x) * perPixel.x,
            y: start.placement.y + (event.clientY - start.y) * perPixel.y,
          },
          !start.moved,
        )
        start.moved = true
      }}
      onPointerUp={(event) => {
        drag.current = null
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId)
        }
      }}
      onPointerCancel={() => {
        drag.current = null
      }}
      onWheel={(event) => {
        if (!event.altKey) return
        event.stopPropagation()
        const bounds = event.currentTarget.getBoundingClientRect()
        const x =
          ((event.clientX - bounds.x) * dpr - camera.translation[0]) / camera.zoom / page.size.width
        const y =
          ((event.clientY - bounds.y) * dpr - camera.translation[1]) /
          camera.zoom /
          page.size.height
        moveTracing(
          scaled(placement, Math.exp(-event.deltaY * 0.0005), x, y),
          event.timeStamp - lastWheel.current > 400,
        )
        lastWheel.current = event.timeStamp
      }}
    >
      {source && (
        <PlacedImage
          url={source}
          rect={{ x: 0, y: 0, width: page.size.width, height: page.size.height }}
          camera={camera}
          label={t('compare.original')}
        />
      )}
      {reference && (
        <PlacedImage
          url={reference}
          rect={placedRect(placement, page.size)}
          camera={camera}
          label={t('compare.reference')}
          opacity={active.opacity}
        />
      )}
    </div>
  )
}

/**
 * Controls for aligning the active page's reference. It follows the active
 * page: switching pages saves a changed alignment and starts from the next
 * page's saved one.
 */
export function TracingPanel({ page }: { page: Page }) {
  const { t } = useTranslation()
  const tracing = useKoharuStore((state) => state.tracing)
  const moveTracing = useKoharuStore((state) => state.moveTracing)
  const setOpacity = useKoharuStore((state) => state.setTracingOpacity)
  const stopTracing = useKoharuStore((state) => state.stopTracing)
  const leaveTracing = useKoharuStore((state) => state.leaveTracing)
  const stayTracing = useKoharuStore((state) => state.stayTracing)
  // The field being typed into; its keystrokes are one undo step.
  const typing = useRef<string | null>(null)
  const floating = useFloatingPanel<HTMLElement>('tracing')
  const name = t('tracing.title')
  const pages = usePages().data
  const index = pages?.findIndex((candidate) => candidate.id === page.id) ?? -1
  const saved = index >= 0 ? (pages?.[index]?.reference?.placement ?? null) : null

  useEffect(() => {
    const current = useKoharuStore.getState().tracing
    if (!current || current.page === page.id || pages === undefined) return
    if (current.changed && current.placement) {
      void savePlacement([current.page], current.placement).catch(() => undefined)
    }
    useKoharuStore.getState().startTracing(page.id, saved)
  }, [page.id, pages, saved])

  if (!tracing || tracing.page !== page.id) return null
  const placement = tracing.placement
  const rect = placement && placedRect(placement, page.size)

  // This page and every later one with a reference, counted before Save is
  // chosen so its label can say how far it reaches.
  const following = (pages ?? [])
    .slice(index)
    .filter((candidate) => candidate.reference)
    .map((candidate) => candidate.id)

  const finish = (targets: string[]) => {
    if (!placement) return
    const close = () => {
      stopTracing()
      toast.add({
        type: 'success',
        title: t('tracing.saved', { count: targets.length, page: page.label }),
      })
    }
    // An unchanged alignment of this page alone is already saved.
    if (!tracing.changed && targets.length === 1) {
      close()
      return
    }
    void savePlacement(targets, placement)
      .then(close)
      .catch(() => undefined)
  }

  // Answers the question asked before leaving with an unsaved alignment.
  const leave = (save: boolean) => {
    const after = tracing.leaving?.after
    const done = () => {
      stopTracing()
      after?.()
    }
    if (!save || !placement) {
      done()
      return
    }
    void savePlacement([page.id], placement)
      .then(done)
      .catch(() => stayTracing())
  }

  const field = (key: 'x' | 'y' | 'width' | 'height') => {
    if (!placement || !rect) return null
    const extent = key === 'x' || key === 'width' ? page.size.width : page.size.height
    return (
      <label className='grid gap-0.5'>
        <span className='text-[10px] text-muted-foreground'>{t(`tracing.${key}`)}</span>
        <Input
          type='number'
          step={1}
          value={Math.round(rect[key] * 10) / 10}
          className='h-6 w-16 px-1.5 text-[11px] md:text-[11px]'
          onChange={(event) => {
            const value = event.currentTarget.valueAsNumber
            if (!Number.isFinite(value)) return
            if ((key === 'width' || key === 'height') && value <= 0) return
            moveTracing({ ...placement, [key]: value / extent }, typing.current !== key)
            typing.current = key
          }}
          onBlur={() => (typing.current = null)}
        />
      </label>
    )
  }

  return (
    <section
      ref={floating.ref}
      data-canvas-control
      aria-label={name}
      style={floating.style}
      className={cn(
        'absolute top-2 left-1/2 z-20 grid -translate-x-1/2 gap-2 rounded-xl border border-border/70 bg-popover/95 p-2.5 text-[11px] shadow-lg backdrop-blur',
        floating.collapsed ? 'w-72 max-w-[calc(100%-1rem)]' : 'w-[min(36rem,calc(100%-1rem))]',
      )}
    >
      <header
        {...floating.handle}
        title={t('panel.move')}
        className='flex cursor-grab touch-none items-center gap-2 active:cursor-grabbing'
      >
        <GripHorizontal className='size-3.5 shrink-0 text-muted-foreground/70' />
        <h2 className='min-w-0 flex-1 truncate text-[12px] font-semibold'>
          {name} · {page.label}
        </h2>
        <Button
          type='button'
          size='icon-xs'
          variant='ghost'
          aria-label={t(floating.collapsed ? 'panel.expand' : 'panel.collapse', { name })}
          onClick={floating.toggle}
        >
          {floating.collapsed ? <ChevronDown /> : <ChevronUp />}
        </Button>
        <Button
          type='button'
          size='icon-xs'
          variant='ghost'
          aria-label={t('tracing.close')}
          onClick={() => leaveTracing()}
        >
          <X />
        </Button>
      </header>
      {floating.collapsed ? null : placement && rect ? (
        <>
          <div className='flex flex-wrap items-end gap-2'>
            <div className='grid gap-0.5'>
              <span className='text-[10px] text-muted-foreground'>{t('tracing.opacity')}</span>
              <div className='flex items-center gap-1'>
                <input
                  type='range'
                  min={10}
                  max={90}
                  aria-label={t('tracing.opacity')}
                  title={t('tracing.opacityHint', { percent: TRACING_OPACITY * 100 })}
                  value={Math.round(tracing.opacity * 100)}
                  className='h-6 w-24 accent-primary'
                  onChange={(event) => setOpacity(event.currentTarget.valueAsNumber / 100)}
                  onDoubleClick={() => setOpacity(TRACING_OPACITY)}
                />
                <span className='w-8 text-right tabular-nums'>
                  {Math.round(tracing.opacity * 100)}%
                </span>
                <Button
                  type='button'
                  size='icon-xs'
                  variant='ghost'
                  aria-label={t('tracing.resetOpacity', { percent: TRACING_OPACITY * 100 })}
                  title={t('tracing.resetOpacity', { percent: TRACING_OPACITY * 100 })}
                  disabled={tracing.opacity === TRACING_OPACITY}
                  onClick={() => setOpacity(TRACING_OPACITY)}
                >
                  <RotateCcw />
                </Button>
              </div>
            </div>
            <div className='grid gap-0.5'>
              <span className='text-[10px] text-muted-foreground'>{t('tracing.size')}</span>
              <div className='flex items-center'>
                <Button
                  type='button'
                  size='icon-xs'
                  variant='outline'
                  aria-label={t('tracing.shrink')}
                  onClick={() =>
                    moveTracing(
                      scaled(
                        placement,
                        1 / 1.01,
                        placement.x + placement.width / 2,
                        placement.y + placement.height / 2,
                      ),
                    )
                  }
                >
                  <Minus />
                </Button>
                <Button
                  type='button'
                  size='icon-xs'
                  variant='outline'
                  aria-label={t('tracing.grow')}
                  onClick={() =>
                    moveTracing(
                      scaled(
                        placement,
                        1.01,
                        placement.x + placement.width / 2,
                        placement.y + placement.height / 2,
                      ),
                    )
                  }
                >
                  <Plus />
                </Button>
              </div>
            </div>
            {field('x')}
            {field('y')}
            {field('width')}
            {field('height')}
          </div>
          <p className='text-[10px] text-muted-foreground'>{t('tracing.hint')}</p>
          <div className='flex flex-wrap gap-1.5'>
            <Button
              type='button'
              size='xs'
              variant='ghost'
              title={t('tracing.resetHint')}
              onClick={() => moveTracing(FILL)}
            >
              {t('tracing.reset')}
            </Button>
            <span className='flex-1' />
            <Button type='button' size='xs' variant='ghost' onClick={stopTracing}>
              {t('common.cancel')}
            </Button>
            {following.length > 1 && (
              <Button type='button' size='xs' variant='outline' onClick={() => finish(following)}>
                {t('tracing.saveFollowing', { count: following.length - 1 })}
              </Button>
            )}
            <Button type='button' size='xs' onClick={() => finish([page.id])}>
              {t('tracing.saveThis')}
            </Button>
          </div>
        </>
      ) : (
        <p className='text-muted-foreground'>{t('tracing.noReference')}</p>
      )}
      <AlertDialog
        open={Boolean(tracing.leaving)}
        onOpenChange={(open) => {
          if (!open) stayTracing()
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('tracing.leaveTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('tracing.leaveDescription', { page: page.label })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('tracing.keepAligning')}</AlertDialogCancel>
            <AlertDialogAction variant='outline' onClick={() => leave(false)}>
              {t('tracing.discard')}
            </AlertDialogAction>
            <AlertDialogAction onClick={() => leave(true)}>{t('tracing.save')}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}
