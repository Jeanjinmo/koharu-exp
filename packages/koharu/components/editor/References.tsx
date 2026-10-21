'use client'

import { useQuery } from '@tanstack/react-query'
import {
  ArrowRight,
  ArrowUpDown,
  ChevronDown,
  FilePlus2,
  FolderOpen,
  LoaderCircle,
} from 'lucide-react'
import { useEffect, useId, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { PageThumbnail } from '@/components/editor/PageRail'
import { call } from '@/lib/backend'
import { pagesKey, projectKey, refresh, usePages } from '@/lib/queries'
import { useKoharuStore } from '@/lib/store'
import { orderedLanguageChoices } from '@/lib/translation'
import {
  commands,
  type PageImportSource,
  type PageSummary,
  type ReferenceCandidate,
} from '@koharu/bridge/protocol'
import { Button } from '@koharu/ui/components/button'
import { Checkbox } from '@koharu/ui/components/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@koharu/ui/components/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@koharu/ui/components/dropdown-menu'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@koharu/ui/components/select'
import { toast } from '@koharu/ui/components/toast'
import { cn } from '@koharu/ui/lib/utils'

const emptyPages: PageSummary[] = []

/** Which staged reference each page gets, by its position among the staged images. */
export type Pairs = ReadonlyMap<string, number>

export type ShiftDirection = 'up' | 'down'

const noPairs: Pairs = new Map()

/** How many characters at the end of a long name stay in view. */
const NAME_TAIL = 12

interface Staged {
  /** Tells thumbnails of one staging apart from those of the one before. */
  generation: number
  candidates: ReferenceCandidate[]
}

/**
 * The parts of a file name that hold a number, which usually tell pages
 * apart, without leading zeros so `p01` and `p1` agree.
 */
function nameMarks(name: string): string[] {
  return name
    .replace(/\.[a-z][a-z0-9]{0,4}$/i, '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((part) => /\d/.test(part))
    .map((part) => part.replace(/\d+/g, (digits) => digits.replace(/^0+(?=\d)/, '')))
}

/** Each name's marks without those every name on its side shares, such as an episode number. */
function distinctMarks(marks: readonly string[][]): string[][] {
  if (marks.length < 2) return marks.map((parts) => [...parts])
  const shared = marks.reduce((common, parts) => common.filter((part) => parts.includes(part)))
  return marks.map((parts) => parts.filter((part) => !shared.includes(part)))
}

/**
 * Pairs a page with the reference whose name carries the same page marks,
 * such as `E33P01` in `ja_…_E33P01.jpg` and `id_…_E33P01.jpg`, when that is
 * the only reference that fits the page and it fits no other page. The pages
 * and references left over pair in order.
 */
export function pairReferences(pages: readonly PageSummary[], names: readonly string[]): Pairs {
  const pageMarks = pages.map((page) => nameMarks(page.label))
  const referenceMarks = names.map(nameMarks)
  const pageKeys = distinctMarks(pageMarks)
  const referenceKeys = distinctMarks(referenceMarks)
  const within = (key: string[], marks: string[]) =>
    key.length > 0 && key.every((mark) => marks.includes(mark))
  const fits = pages.map((_, page) =>
    names.flatMap((_, reference) =>
      within(pageKeys[page], referenceMarks[reference]) &&
      within(referenceKeys[reference], pageMarks[page])
        ? [reference]
        : [],
    ),
  )
  const claims = new Map<number, number>()
  for (const reference of fits.flat()) claims.set(reference, (claims.get(reference) ?? 0) + 1)

  const pairs = new Map<string, number>()
  pages.forEach((page, index) => {
    const found = fits[index]
    if (found.length === 1 && claims.get(found[0]) === 1) pairs.set(page.id, found[0])
  })
  const named = new Set(pairs.values())
  const rest = names.map((_, reference) => reference).filter((reference) => !named.has(reference))
  for (const page of pages) {
    if (pairs.has(page.id)) continue
    const reference = rest.shift()
    if (reference === undefined) break
    pairs.set(page.id, reference)
  }
  return pairs
}

/**
 * Puts a reference on a page. The reference that was there takes the place
 * the moved one came from: its page, or the references not paired.
 */
export function moveReference(pairs: Pairs, reference: number, page: string): Pairs {
  const from = [...pairs].find(([, paired]) => paired === reference)?.[0]
  const displaced = pairs.get(page)
  const next = new Map(pairs)
  next.set(page, reference)
  if (from !== undefined && from !== page) {
    if (displaced === undefined) next.delete(from)
    else next.set(from, displaced)
  }
  return next
}

/**
 * Moves every reference from a page on by one page. Up leaves out the page's
 * own reference, and the last page then takes the reference that followed its
 * own in file order unless a page has it. Down leaves the page without one,
 * and the last page's reference drops out. `shifted` counts the references
 * that changed page, apart from one left out.
 */
export function shiftReferences(
  pages: readonly PageSummary[],
  pairs: Pairs,
  page: string,
  direction: ShiftDirection,
  count: number,
): { pairs: Pairs; shifted: number } {
  const at = pages.findIndex((each) => each.id === page)
  if (at < 0) return { pairs, shifted: 0 }
  const rows = pages.map((each) => pairs.get(each.id) ?? null)
  let next: Array<number | null>
  let left: number | null = null
  if (direction === 'up') {
    left = rows[at]
    const last = rows[rows.length - 1]
    let following: number | null = null
    if (last !== null) {
      for (let reference = last + 1; reference < count && following === null; reference += 1) {
        if (!rows.includes(reference)) following = reference
      }
    }
    next = [...rows.slice(0, at), ...rows.slice(at + 1), following]
  } else {
    next = [...rows.slice(0, at), null, ...rows.slice(at, -1)]
  }
  const references = new Set(
    [...rows, ...next].filter(
      (reference): reference is number => reference !== null && reference !== left,
    ),
  )
  return {
    pairs: new Map(
      pages.flatMap((each, row) => {
        const reference = next[row]
        return reference === null ? [] : [[each.id, reference] as const]
      }),
    ),
    shifted: [...references].filter(
      (reference) => rows.indexOf(reference) !== next.indexOf(reference),
    ).length,
  }
}

/** Imports a translated edition of the project and pairs it with the pages. */
export function ReferenceImportDialog() {
  const { t } = useTranslation()
  const open = useKoharuStore((state) => state.referenceImport)
  const setOpen = useKoharuStore((state) => state.setReferenceImport)
  const preferences = useKoharuStore((state) => state.preferences)
  const pages = usePages(open).data ?? emptyPages
  const languages = useMemo(
    () => orderedLanguageChoices(preferences?.languages ?? []),
    [preferences?.languages],
  )
  const targetLanguage = preferences?.pipeline.translation.target_language ?? 'en-US'
  // Until one is chosen, references are taken to be in the target language.
  const [chosenLanguage, setChosenLanguage] = useState<string | null>(null)
  const language = chosenLanguage ?? targetLanguage
  const [trimMargins, setTrimMargins] = useState(false)
  const [reading, setReading] = useState(false)
  const [attaching, setAttaching] = useState(false)
  const [staged, setStaged] = useState<Staged | null>(null)
  const [pairs, setPairs] = useState<Pairs>(noPairs)
  // The last shift, so its notice can take it back.
  const [shift, setShift] = useState<{ shifted: number; before: Pairs } | null>(null)
  const [dragged, setDragged] = useState<number | null>(null)
  const [target, setTarget] = useState<string | null>(null)
  const notPairedLabel = useId()

  const rows = pages.map((page) => ({ page, reference: pairs.get(page.id) ?? null }))
  const chosen = rows.flatMap(({ page, reference }) =>
    reference === null ? [] : [{ page: page.id, reference }],
  )
  const paired = new Set(chosen.map(({ reference }) => reference))
  const unpaired = (staged?.candidates ?? []).flatMap((_, reference) =>
    paired.has(reference) ? [] : [reference],
  )
  const busy = reading || attaching

  const arrange = (next: Pairs) => {
    setPairs(next)
    setShift(null)
  }

  const unpair = (page: string) => {
    const next = new Map(pairs)
    next.delete(page)
    arrange(next)
  }

  const shiftFrom = (page: string, direction: ShiftDirection) => {
    const result = shiftReferences(pages, pairs, page, direction, staged?.candidates.length ?? 0)
    setPairs(result.pairs)
    setShift(result.shifted > 0 ? { shifted: result.shifted, before: pairs } : null)
  }

  const drag = (reference: number | null) => {
    setDragged(reference)
    if (reference === null) setTarget(null)
  }

  const drop = (page: string | null) => {
    if (dragged !== null) {
      if (page !== null) {
        arrange(moveReference(pairs, dragged, page))
      } else {
        const from = [...pairs].find(([, reference]) => reference === dragged)?.[0]
        if (from !== undefined) unpair(from)
      }
    }
    drag(null)
  }

  const reset = () => {
    setPairs(noPairs)
    setShift(null)
  }

  const discard = () => {
    setStaged(null)
    reset()
    void call(commands.discardStagedReferences).catch(() => undefined)
  }

  const finish = () => {
    setChosenLanguage(null)
    setTrimMargins(false)
    reset()
    setOpen(false)
  }

  const close = () => {
    if (busy) return
    if (staged) discard()
    finish()
  }

  const stage = (source: PageImportSource) => {
    setReading(true)
    void call(commands.stageReferences, source, trimMargins)
      .then((candidates) => {
        if (!candidates) return
        setPairs(
          pairReferences(
            pages,
            candidates.map((candidate) => candidate.name),
          ),
        )
        setShift(null)
        setStaged((previous) => ({ generation: (previous?.generation ?? 0) + 1, candidates }))
      })
      .catch(() => undefined)
      .finally(() => setReading(false))
  }

  const attach = () => {
    setAttaching(true)
    void call(commands.attachReferences, chosen, language)
      .then(async () => {
        setStaged(null)
        finish()
        await refresh(projectKey, pagesKey)
        toast.add({ type: 'success', title: t('references.attached', { count: chosen.length }) })
      })
      .catch(() => undefined)
      .finally(() => setAttaching(false))
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close()
      }}
    >
      <DialogContent className='grid max-h-[min(720px,calc(100vh-4rem))] grid-rows-[auto_auto_minmax(0,1fr)_auto] sm:max-w-2xl'>
        <DialogHeader>
          <DialogTitle>{t('references.title')}</DialogTitle>
          <DialogDescription>{t('references.description')}</DialogDescription>
        </DialogHeader>

        <div className='grid gap-3 text-[12px] sm:grid-cols-2'>
          <div className='grid gap-1'>
            <span className='font-medium'>{t('references.language')}</span>
            <Select
              value={language}
              items={Object.fromEntries(languages.map((choice) => [choice.tag, choice.name]))}
              onValueChange={(value) => value && setChosenLanguage(value)}
            >
              <SelectTrigger
                aria-label={t('references.language')}
                disabled={busy}
                className='h-8 w-full text-[11px]'
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {languages.map((choice) => (
                  <SelectItem key={choice.tag} value={choice.tag}>
                    {choice.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span className='text-[11px] text-muted-foreground'>
              {language === targetLanguage
                ? t('references.sameLanguageHint')
                : t('references.otherLanguageHint')}
            </span>
          </div>
          {!staged && (
            <label className='flex items-start gap-2.5 self-start pt-5'>
              <Checkbox
                checked={trimMargins}
                disabled={busy}
                className='mt-0.5'
                onCheckedChange={setTrimMargins}
              />
              <span className='grid gap-0.5'>
                <span>{t('references.trimMargins')}</span>
                <span className='text-[11px] text-muted-foreground'>
                  {t('references.trimMarginsHint')}
                </span>
              </span>
            </label>
          )}
        </div>

        {staged ? (
          <section aria-label={t('references.pairs')} className='grid min-h-0 gap-2'>
            <div className='flex flex-wrap items-center gap-x-2 text-[11px]'>
              <p className='text-muted-foreground' role='status'>
                {t('references.summary', { count: chosen.length, pages: pages.length })}
                {unpaired.length > 0 &&
                  ` · ${t('references.notPaired', { count: unpaired.length })}`}
              </p>
              {shift && (
                <p className='flex items-center gap-1.5'>
                  {t('references.shifted', { count: shift.shifted })}
                  <Button
                    type='button'
                    size='xs'
                    variant='link'
                    className='h-auto px-0 text-[11px]'
                    disabled={busy}
                    onClick={() => {
                      setPairs(shift.before)
                      setShift(null)
                    }}
                  >
                    {t('references.undoShift')}
                  </Button>
                </p>
              )}
            </div>
            <ol className='min-h-0 overflow-y-auto rounded-lg border border-border/70'>
              {rows.map(({ page, reference }, index) => (
                <PairRow
                  key={page.id}
                  page={page}
                  number={index + 1}
                  reference={reference}
                  staged={staged}
                  pages={pages}
                  disabled={busy}
                  dragging={dragged !== null}
                  dropping={dragged !== null && target === page.id}
                  onDrag={drag}
                  onTarget={setTarget}
                  onDrop={() => drop(page.id)}
                  onPair={(moved, to) => arrange(moveReference(pairs, moved, to))}
                  onUnpair={() => unpair(page.id)}
                  onShift={(direction) => shiftFrom(page.id, direction)}
                />
              ))}
            </ol>
            {unpaired.length > 0 && (
              <div
                role='group'
                aria-labelledby={notPairedLabel}
                className={cn(
                  'flex flex-wrap items-center gap-1.5 rounded-lg text-[11px]',
                  dragged !== null && 'outline-1 outline-offset-2 outline-border outline-dashed',
                )}
                onDragOver={(event) => {
                  if (dragged !== null) event.preventDefault()
                }}
                onDrop={(event) => {
                  event.preventDefault()
                  drop(null)
                }}
              >
                <span id={notPairedLabel} className='text-muted-foreground'>
                  {t('references.notPairedList')}
                </span>
                {unpaired.map((reference) => (
                  <span
                    key={reference}
                    draggable={!busy}
                    title={t('references.dragHint')}
                    className='flex max-w-64 cursor-grab items-center gap-1 rounded-md border border-border/70 py-0.5 pr-0.5 pl-1 active:cursor-grabbing'
                    onDragStart={() => drag(reference)}
                    onDragEnd={() => drag(null)}
                  >
                    <span className='grid h-8 w-6 shrink-0 place-items-center overflow-hidden rounded-sm bg-[var(--surface-well)]'>
                      <StagedThumbnail
                        staged={staged}
                        reference={reference}
                        label={staged.candidates[reference].name}
                      />
                    </span>
                    <FileName name={staged.candidates[reference].name} />
                    <PairMenu
                      pages={pages}
                      page={null}
                      disabled={busy}
                      onPair={(page) => arrange(moveReference(pairs, reference, page))}
                    />
                  </span>
                ))}
              </div>
            )}
          </section>
        ) : (
          <div className='grid place-items-center gap-3 rounded-lg border border-dashed border-border py-8'>
            {reading ? (
              <p
                className='flex items-center gap-2 text-[12px] text-muted-foreground'
                role='status'
              >
                <LoaderCircle className='size-4 animate-spin' /> {t('references.reading')}
              </p>
            ) : (
              <div className='flex gap-2'>
                <Button type='button' variant='outline' onClick={() => stage('files')}>
                  <FilePlus2 /> {t('references.chooseFiles')}
                </Button>
                <Button type='button' variant='outline' onClick={() => stage('folder')}>
                  <FolderOpen /> {t('references.chooseFolder')}
                </Button>
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          {staged && (
            <Button
              type='button'
              variant='ghost'
              className='sm:mr-auto'
              disabled={busy}
              onClick={discard}
            >
              {t('references.chooseOther')}
            </Button>
          )}
          <Button type='button' variant='ghost' disabled={busy} onClick={close}>
            {t('common.cancel')}
          </Button>
          <Button
            type='button'
            disabled={busy || chosen.length === 0}
            aria-busy={attaching}
            onClick={attach}
          >
            {attaching && <LoaderCircle className='animate-spin' />}
            {t('references.attach', { count: chosen.length })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function PairRow({
  page,
  number,
  reference,
  staged,
  pages,
  disabled,
  dragging,
  dropping,
  onDrag,
  onTarget,
  onDrop,
  onPair,
  onUnpair,
  onShift,
}: {
  page: PageSummary
  number: number
  reference: number | null
  staged: Staged
  pages: readonly PageSummary[]
  disabled: boolean
  dragging: boolean
  dropping: boolean
  onDrag: (reference: number | null) => void
  onTarget: (page: string | null) => void
  onDrop: () => void
  onPair: (reference: number, page: string) => void
  onUnpair: () => void
  onShift: (direction: ShiftDirection) => void
}) {
  const { t } = useTranslation()
  const candidate = reference === null ? null : staged.candidates[reference]
  const label = t('references.pageLabel', { number, label: page.label })
  return (
    <li
      aria-label={label}
      data-drop={dropping}
      className='grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_auto] items-center gap-2 border-b border-border/60 px-2 py-1.5 last:border-b-0 data-[drop=true]:bg-primary/[0.09]'
      onDragOver={(event) => {
        if (!dragging) return
        event.preventDefault()
        onTarget(page.id)
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) onTarget(null)
      }}
      onDrop={(event) => {
        event.preventDefault()
        onDrop()
      }}
    >
      <div className='flex min-w-0 items-center gap-2'>
        <div className='grid h-12 w-9 shrink-0 place-items-center overflow-hidden rounded bg-[var(--surface-well)]'>
          {page.source_asset && (
            <PageThumbnail page={page.id} asset={page.source_asset} label={page.label} />
          )}
        </div>
        <FileName name={label} className='text-[11px]' />
      </div>
      <ArrowRight className='size-3.5 text-muted-foreground' />
      {candidate && reference !== null ? (
        <div
          draggable={!disabled}
          title={t('references.dragHint')}
          className='flex min-w-0 cursor-grab items-center gap-2 active:cursor-grabbing'
          onDragStart={() => onDrag(reference)}
          onDragEnd={() => onDrag(null)}
        >
          <div className='grid h-12 w-9 shrink-0 place-items-center overflow-hidden rounded bg-[var(--surface-well)]'>
            <StagedThumbnail staged={staged} reference={reference} label={candidate.name} />
          </div>
          <span className='grid min-w-0 text-[11px]'>
            <FileName name={candidate.name} />
            {page.reference && (
              <span className='truncate text-[10px] text-muted-foreground'>
                {t('references.replaces')}
              </span>
            )}
          </span>
        </div>
      ) : (
        <span className='text-[11px] text-muted-foreground'>{t('references.none')}</span>
      )}
      <div className='flex w-36 items-center justify-end gap-1'>
        {reference !== null && (
          <>
            <PairMenu
              pages={pages}
              page={page.id}
              disabled={disabled}
              onPair={(to) => onPair(reference, to)}
            />
            <Button
              type='button'
              size='xs'
              variant='ghost'
              disabled={disabled}
              title={t('references.unpairHint')}
              onClick={onUnpair}
            >
              {t('references.unpair')}
            </Button>
          </>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<Button type='button' size='xs' variant='ghost' disabled={disabled} />}
          >
            {t('references.shift')}
            <ChevronDown />
          </DropdownMenuTrigger>
          <DropdownMenuContent align='end' className='w-64'>
            <DropdownMenuItem className='grid gap-0.5 text-[11px]' onClick={() => onShift('up')}>
              <span>
                {reference === null ? t('references.shiftUp') : t('references.skipShiftUp')}
              </span>
              <span className='text-[10px] text-muted-foreground'>
                {reference === null ? t('references.shiftUpHint') : t('references.skipShiftUpHint')}
              </span>
            </DropdownMenuItem>
            <DropdownMenuItem className='grid gap-0.5 text-[11px]' onClick={() => onShift('down')}>
              <span>{t('references.emptyShiftDown')}</span>
              <span className='text-[10px] text-muted-foreground'>
                {t('references.emptyShiftDownHint')}
              </span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </li>
  )
}

/** Lists the pages, so a reference goes to any of them in one step. */
function PairMenu({
  pages,
  page,
  disabled,
  onPair,
}: {
  pages: readonly PageSummary[]
  page: string | null
  disabled: boolean
  onPair: (page: string) => void
}) {
  const { t } = useTranslation()
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            type='button'
            size='icon-xs'
            variant='ghost'
            disabled={disabled}
            aria-label={t('references.pairWith')}
            title={t('references.pairWith')}
          />
        }
      >
        <ArrowUpDown />
      </DropdownMenuTrigger>
      <DropdownMenuContent align='end' className='w-72'>
        <DropdownMenuRadioGroup value={page} onValueChange={(next) => onPair(next as string)}>
          {pages.map((each, index) => (
            <DropdownMenuRadioItem key={each.id} value={each.id} className='text-[11px]'>
              <FileName
                name={t('references.pageLabel', { number: index + 1, label: each.label })}
              />
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** Keeps the end of a long name in view, where page numbers usually are. */
function FileName({ name, className }: { name: string; className?: string }) {
  return (
    <span title={name} className={cn('flex min-w-0', className)}>
      <span className='overflow-hidden text-ellipsis whitespace-pre'>
        {name.slice(0, -NAME_TAIL)}
      </span>
      <span className='shrink-0 whitespace-pre'>{name.slice(-NAME_TAIL)}</span>
    </span>
  )
}

function StagedThumbnail({
  staged,
  reference,
  label,
}: {
  staged: Staged
  reference: number
  label: string
}) {
  const bytes = useQuery({
    queryKey: ['staged-reference', staged.generation, reference],
    queryFn: async () =>
      new Uint8Array(await call(commands.getStagedReferenceThumbnail, reference)),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 0,
  }).data
  const [url, setUrl] = useState<string | null>(null)

  useEffect(() => {
    if (!bytes) return
    const next = URL.createObjectURL(
      new Blob([bytes.buffer as ArrayBuffer], { type: 'image/webp' }),
    )
    setUrl(next)
    return () => URL.revokeObjectURL(next)
  }, [bytes])

  return url ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={url} alt={label} draggable={false} className='size-full object-contain' />
  ) : null
}
