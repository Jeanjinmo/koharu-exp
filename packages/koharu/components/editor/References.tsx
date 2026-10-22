'use client'

import { useQuery } from '@tanstack/react-query'
import {
  ArrowRight,
  ArrowUpDown,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Eye,
  FilePlus2,
  FolderOpen,
  ImagePlus,
  LoaderCircle,
  Maximize2,
  Redo2,
  Undo2,
  WandSparkles,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import {
  type ComponentProps,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useTranslation } from 'react-i18next'

import { usePageImage } from '@/components/editor/Compare'
import { ownClick, PageThumbnail } from '@/components/editor/PageRail'
import { DragGhost, type DropTargetProps, usePointerDrag } from '@/components/editor/usePointerDrag'
import { call } from '@/lib/backend'
import { pagesKey, projectKey, refresh, usePages } from '@/lib/queries'
import { useKoharuStore } from '@/lib/store'
import { orderedLanguageChoices } from '@/lib/translation'
import {
  commands,
  type PageImportSource,
  type PageSummary,
  type Preferences,
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

/**
 * The staged references in the dialog, in the order they joined it, and the
 * page each paired one goes to; the others wait in Not paired. `shifted`
 * counts the pairs that the step to this arrangement shifted.
 */
export interface Arrangement {
  files: readonly number[]
  pairs: Pairs
  shifted: number
}

/** The dialog's own undo history, kept apart from the project's. */
interface History {
  past: readonly Arrangement[]
  present: Arrangement
  future: readonly Arrangement[]
}

const emptyHistory: History = {
  past: [],
  present: { files: [], pairs: new Map(), shifted: 0 },
  future: [],
}

// References are taken to be in the target language until told otherwise.
const targetLanguageOf = (state: { preferences: Preferences | null }) =>
  state.preferences?.pipeline.translation.target_language ?? 'en-US'

/** How many characters at the end of a long name stay in view. */
const NAME_TAIL = 12

/** The drop target that takes a reference off its page. */
const NOT_PAIRED = 'not-paired'

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

/** Pairs `pages` with `files`, given by their staged positions, as `pairReferences` does. */
function pairFiles(
  pages: readonly PageSummary[],
  files: readonly number[],
  names: readonly string[],
): Pairs {
  return new Map(
    [
      ...pairReferences(
        pages,
        files.map((file) => names[file]),
      ),
    ].map(([page, at]) => [page, files[at]] as const),
  )
}

/**
 * Adds chosen files to the dialog. Those not in it yet join it and pair, by
 * name and then in order, with the pages that have no reference; the pairs
 * made before stay as they are.
 */
export function addReferences(
  pages: readonly PageSummary[],
  current: Arrangement,
  chosen: readonly number[],
  names: readonly string[],
): Arrangement {
  const joining = chosen.filter((file) => !current.files.includes(file))
  if (joining.length === 0) return current
  const empty = pages.filter((page) => !current.pairs.has(page.id))
  return {
    files: [...current.files, ...joining],
    pairs: new Map([...current.pairs, ...pairFiles(empty, joining, names)]),
    shifted: 0,
  }
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

/** The pairs without the one that holds `reference`. */
function withoutReference(pairs: Pairs, reference: number): Pairs {
  return new Map([...pairs].filter(([, paired]) => paired !== reference))
}

/**
 * Moves every reference from a page on by one page. Up leaves out the page's
 * own reference, and the last page then takes the file that followed its own
 * among `files` unless a page has it. Down leaves the page without one, and
 * the last page's reference drops out. `shifted` counts the references that
 * changed page, apart from one left out.
 */
export function shiftReferences(
  pages: readonly PageSummary[],
  pairs: Pairs,
  page: string,
  direction: ShiftDirection,
  files: readonly number[],
): { pairs: Pairs; shifted: number } {
  const at = pages.findIndex((each) => each.id === page)
  if (at < 0) return { pairs, shifted: 0 }
  const rows = pages.map((each) => pairs.get(each.id) ?? null)
  let next: Array<number | null>
  let left: number | null = null
  if (direction === 'up') {
    left = rows[at]
    const last = rows[rows.length - 1]
    const following =
      last === null
        ? null
        : (files.slice(files.indexOf(last) + 1).find((file) => !rows.includes(file)) ?? null)
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

function sameArrangement(a: Arrangement, b: Arrangement) {
  return (
    a.files.length === b.files.length &&
    a.files.every((file, index) => b.files[index] === file) &&
    a.pairs.size === b.pairs.size &&
    [...a.pairs].every(([page, file]) => b.pairs.get(page) === file)
  )
}

function undone(history: History): History {
  const previous = history.past.at(-1)
  return previous
    ? {
        past: history.past.slice(0, -1),
        present: previous,
        future: [history.present, ...history.future],
      }
    : history
}

function redone(history: History): History {
  const [next, ...future] = history.future
  return next ? { past: [...history.past, history.present], present: next, future } : history
}

/** What the preview shows: a page and its reference, or a reference not paired. */
type Previewed = { page: string } | { file: number }

/** Imports a translated edition of the project and pairs it with the pages. */
export function ReferenceImportDialog() {
  const { t } = useTranslation()
  const open = useKoharuStore((state) => state.referenceImport)
  const setOpen = useKoharuStore((state) => state.setReferenceImport)
  const targetLanguage = useKoharuStore(targetLanguageOf)
  const pages = usePages(open).data ?? emptyPages
  // Until one is chosen, references are taken to be in the target language.
  const [chosenLanguage, setChosenLanguage] = useState<string | null>(null)
  const language = chosenLanguage ?? targetLanguage
  const [trimMargins, setTrimMargins] = useState(false)
  const [reading, setReading] = useState(false)
  const [attaching, setAttaching] = useState(false)
  const [staged, setStaged] = useState<Staged | null>(null)
  const [history, setHistory] = useState(emptyHistory)
  const [preview, setPreview] = useState<Previewed | null>(null)
  const stagings = useRef(0)
  const notPairedLabel = useId()
  const list = useRef<HTMLOListElement>(null)
  const { files, pairs, shifted } = history.present

  const rows = pages.map((page) => ({ page, reference: pairs.get(page.id) ?? null }))
  const chosen = rows.flatMap(({ page, reference }) =>
    reference === null ? [] : [{ page: page.id, reference }],
  )
  const paired = new Set(chosen.map(({ reference }) => reference))
  const unpaired = files.filter((file) => !paired.has(file))
  const names = staged?.candidates.map((candidate) => candidate.name) ?? []
  const busy = reading || attaching

  // Every change to the arrangement is one step of the dialog's history.
  const arrange = (change: (current: Arrangement) => Arrangement) =>
    setHistory((current) => {
      const next = change(current.present)
      return sameArrangement(next, current.present)
        ? current
        : { past: [...current.past, current.present], present: next, future: [] }
    })

  // While the dialog is open, Ctrl+Z and Ctrl+Shift+Z step through its own
  // history, ahead of the editor's shortcuts, and never reach the project's.
  useEffect(() => {
    if (!open) return
    const step = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.key.toLowerCase() !== 'z')
        return
      event.preventDefault()
      event.stopPropagation()
      setHistory(event.shiftKey ? redone : undone)
    }
    window.addEventListener('keydown', step, true)
    return () => window.removeEventListener('keydown', step, true)
  }, [open])

  const move = (reference: number, page: string) =>
    arrange((current) => ({
      ...current,
      pairs: moveReference(current.pairs, reference, page),
      shifted: 0,
    }))

  const unpair = (reference: number) =>
    arrange((current) => ({
      ...current,
      pairs: withoutReference(current.pairs, reference),
      shifted: 0,
    }))

  const remove = (reference: number) =>
    arrange((current) => ({
      files: current.files.filter((file) => file !== reference),
      pairs: withoutReference(current.pairs, reference),
      shifted: 0,
    }))

  const shiftFrom = (page: string, direction: ShiftDirection) =>
    arrange((current) => {
      const result = shiftReferences(pages, current.pairs, page, direction, current.files)
      return { ...current, pairs: result.pairs, shifted: result.shifted }
    })

  const autoPair = () =>
    arrange((current) => ({
      ...current,
      pairs: pairFiles(pages, current.files, names),
      shifted: 0,
    }))

  const unpairAll = () => arrange((current) => ({ ...current, pairs: new Map(), shifted: 0 }))

  const referenceDrag = usePointerDrag<number>({
    scroller: list,
    onDrop: (reference, target) =>
      target.id === NOT_PAIRED ? unpair(reference) : move(reference, target.id),
  })
  const dragging = referenceDrag.dragging

  const reset = () => {
    setHistory(emptyHistory)
    setPreview(null)
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
      .then((result) => {
        if (!result) return
        const listed = result.chosen.filter((file) => files.includes(file)).length
        // Staged references keep their places, so a later choice keeps the
        // thumbnails already shown.
        const generation = staged?.generation ?? (stagings.current += 1)
        setStaged({ generation, candidates: result.candidates })
        const add = (current: Arrangement) =>
          addReferences(
            pages,
            current,
            result.chosen,
            result.candidates.map((candidate) => candidate.name),
          )
        // The first files chosen are where the history starts; starting over
        // is Cancel.
        if (staged) arrange(add)
        else setHistory({ past: [], present: add(emptyHistory.present), future: [] })
        if (listed > 0) {
          toast.add({ type: 'info', title: t('references.alreadyListed', { count: listed }) })
        }
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
      <DialogContent className='grid max-h-[min(760px,calc(100vh-4rem))] grid-rows-[auto_auto_minmax(0,1fr)_auto] sm:max-w-2xl'>
        <DialogHeader>
          <DialogTitle>{t('references.title')}</DialogTitle>
          <DialogDescription>{t('references.description')}</DialogDescription>
        </DialogHeader>

        <div className='grid gap-3 text-[12px] sm:grid-cols-2'>
          <ReferenceLanguage value={language} disabled={busy} onChange={setChosenLanguage} />
          {!staged && (
            <TrimMargins
              checked={trimMargins}
              disabled={busy}
              className='self-start pt-5'
              onChange={setTrimMargins}
            />
          )}
        </div>

        {staged ? (
          <section
            aria-label={t('references.pairs')}
            className='grid min-h-0 grid-rows-[auto_minmax(0,1fr)_auto] gap-2'
          >
            <div className='flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]'>
              <p className='text-muted-foreground' role='status'>
                {t('references.summary', { count: chosen.length, pages: pages.length })}
                {unpaired.length > 0 &&
                  ` · ${t('references.notPaired', { count: unpaired.length })}`}
              </p>
              {shifted > 0 && <p>{t('references.shifted', { count: shifted })}</p>}
              <span className='flex-1' />
              <Button
                type='button'
                size='xs'
                variant='ghost'
                title={t('references.autoPairHint')}
                disabled={busy || files.length === 0}
                onClick={autoPair}
              >
                <WandSparkles /> {t('references.autoPair')}
              </Button>
              <Button
                type='button'
                size='xs'
                variant='ghost'
                title={t('references.unpairAllHint')}
                disabled={busy || pairs.size === 0}
                onClick={unpairAll}
              >
                {t('references.unpairAll')}
              </Button>
              <Button
                type='button'
                size='icon-xs'
                variant='ghost'
                aria-label={t('references.undo')}
                title={t('references.undoHint')}
                disabled={busy || history.past.length === 0}
                onClick={() => setHistory(undone)}
              >
                <Undo2 />
              </Button>
              <Button
                type='button'
                size='icon-xs'
                variant='ghost'
                aria-label={t('references.redo')}
                title={t('references.redoHint')}
                disabled={busy || history.future.length === 0}
                onClick={() => setHistory(redone)}
              >
                <Redo2 />
              </Button>
            </div>
            <ol ref={list} className='min-h-0 overflow-y-auto rounded-lg border border-border/70'>
              {rows.map(({ page, reference }, index) => (
                <PairRow
                  key={page.id}
                  page={page}
                  number={index + 1}
                  reference={reference}
                  staged={staged}
                  pages={pages}
                  disabled={busy}
                  dragged={reference !== null && dragging?.item === reference}
                  over={dragging?.target?.id === page.id}
                  source={reference === null || busy ? {} : referenceDrag.source(reference)}
                  target={referenceDrag.target(page.id)}
                  onPreview={() => setPreview({ page: page.id })}
                  onPair={move}
                  onUnpair={() => reference !== null && unpair(reference)}
                  onShift={(direction) => shiftFrom(page.id, direction)}
                />
              ))}
            </ol>
            <div
              {...referenceDrag.target(NOT_PAIRED)}
              role='group'
              aria-labelledby={notPairedLabel}
              data-over={dragging?.target?.id === NOT_PAIRED}
              className='grid gap-1.5 rounded-lg border border-dashed border-border p-2 text-[11px] data-[over=true]:border-primary data-[over=true]:bg-primary/[0.06]'
            >
              <p className='flex flex-wrap items-baseline gap-x-2'>
                <span id={notPairedLabel} className='font-medium'>
                  {t('references.notPairedTitle')}
                </span>
                <span className='text-muted-foreground'>{t('references.notPairedHint')}</span>
              </p>
              {unpaired.length > 0 && (
                <div className='flex flex-wrap gap-1.5'>
                  {unpaired.map((reference) => (
                    <span
                      key={reference}
                      {...(busy ? {} : referenceDrag.source(reference))}
                      title={t('references.dragHint')}
                      className={cn(
                        'flex max-w-64 cursor-grab items-center gap-1 rounded-md border border-border/70 bg-background py-0.5 pr-0.5 pl-1 select-none active:cursor-grabbing',
                        dragging?.item === reference && 'opacity-50',
                      )}
                      onClick={(event) => {
                        if (ownClick(event)) setPreview({ file: reference })
                      }}
                    >
                      <Peek className='h-8 w-6 rounded-sm'>
                        <StagedThumbnail
                          staged={staged}
                          reference={reference}
                          label={staged.candidates[reference].name}
                        />
                      </Peek>
                      <FileName name={staged.candidates[reference].name} />
                      <PairMenu
                        pages={pages}
                        page={null}
                        disabled={busy}
                        onPair={(page) => move(reference, page)}
                      />
                      <Button
                        type='button'
                        size='icon-xs'
                        variant='ghost'
                        disabled={busy}
                        aria-label={t('references.removeFile', {
                          name: staged.candidates[reference].name,
                        })}
                        title={t('references.removeFileHint')}
                        onClick={() => remove(reference)}
                      >
                        <X />
                      </Button>
                    </span>
                  ))}
                </div>
              )}
            </div>
            {dragging && (
              <DragGhost x={dragging.x} y={dragging.y}>
                <span className='flex max-w-64 items-center gap-1.5 rounded-md border border-border bg-popover p-1 pr-2 text-[11px] shadow-md'>
                  <span className='grid h-8 w-6 shrink-0 place-items-center overflow-hidden rounded-sm bg-[var(--surface-well)]'>
                    <StagedThumbnail
                      staged={staged}
                      reference={dragging.item}
                      label={staged.candidates[dragging.item].name}
                    />
                  </span>
                  <FileName name={staged.candidates[dragging.item].name} />
                </span>
              </DragGhost>
            )}
            {preview && (
              <ReferencePreview
                previewed={preview}
                rows={rows}
                staged={staged}
                onShow={setPreview}
                onClose={() => setPreview(null)}
              />
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
              aria-busy={reading}
              title={t('references.addFilesHint')}
              onClick={() => stage('files')}
            >
              {reading ? <LoaderCircle className='animate-spin' /> : <FilePlus2 />}
              {t('references.addFiles')}
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

/**
 * Attaches one image as the reference of one page, or replaces the one it
 * has, without pairing anything else.
 */
export function ReferenceFileDialog() {
  const { t } = useTranslation()
  const target = useKoharuStore((state) => state.referenceFile)
  const setTarget = useKoharuStore((state) => state.setReferenceFile)
  const targetLanguage = useKoharuStore(targetLanguageOf)
  const pages = usePages(target !== null).data ?? emptyPages
  const index = pages.findIndex((page) => page.id === target)
  const page = index >= 0 ? pages[index] : null
  const [chosenLanguage, setChosenLanguage] = useState<string | null>(null)
  // A replaced reference keeps its language unless another one is chosen.
  const language = chosenLanguage ?? page?.reference?.language ?? targetLanguage
  const [trimMargins, setTrimMargins] = useState(false)
  const [attaching, setAttaching] = useState(false)
  const label = page ? t('references.pageLabel', { number: index + 1, label: page.label }) : ''

  const finish = () => {
    setChosenLanguage(null)
    setTrimMargins(false)
    setTarget(null)
  }

  const choose = () => {
    if (!page) return
    const replacing = page.reference !== null
    setAttaching(true)
    void call(commands.attachReferenceFile, page.id, language, trimMargins)
      .then(async (attached) => {
        // A dismissed file dialog leaves this one open for another try.
        if (!attached) return
        finish()
        await refresh(projectKey, pagesKey)
        toast.add({
          type: 'success',
          title: t(replacing ? 'references.replaced' : 'references.added', { page: label }),
        })
      })
      .catch(() => undefined)
      .finally(() => setAttaching(false))
  }

  return (
    <Dialog
      open={page !== null}
      onOpenChange={(open) => {
        if (!open && !attaching) finish()
      }}
    >
      <DialogContent className='sm:max-w-md'>
        <DialogHeader>
          <DialogTitle>
            {page?.reference ? t('references.replaceTitle') : t('references.addTitle')}
          </DialogTitle>
          <DialogDescription>
            {page?.reference
              ? t('references.replaceDescription', { page: label })
              : t('references.addDescription', { page: label })}
          </DialogDescription>
        </DialogHeader>
        <div className='grid gap-3 text-[12px]'>
          <ReferenceLanguage value={language} disabled={attaching} onChange={setChosenLanguage} />
          <TrimMargins checked={trimMargins} disabled={attaching} onChange={setTrimMargins} />
        </div>
        <DialogFooter>
          <Button type='button' variant='ghost' disabled={attaching} onClick={finish}>
            {t('common.cancel')}
          </Button>
          <Button type='button' disabled={attaching} aria-busy={attaching} onClick={choose}>
            {attaching ? <LoaderCircle className='animate-spin' /> : <ImagePlus />}
            {t('references.chooseImage')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** The language a reference is written in, and what that means for its text. */
function ReferenceLanguage({
  value,
  disabled,
  onChange,
}: {
  value: string
  disabled: boolean
  onChange: (language: string) => void
}) {
  const { t } = useTranslation()
  const choices = useKoharuStore((state) => state.preferences?.languages)
  const targetLanguage = useKoharuStore(targetLanguageOf)
  const languages = useMemo(() => orderedLanguageChoices(choices ?? []), [choices])
  return (
    <div className='grid gap-1'>
      <span className='font-medium'>{t('references.language')}</span>
      <Select
        value={value}
        items={Object.fromEntries(languages.map((choice) => [choice.tag, choice.name]))}
        onValueChange={(next) => next && onChange(next)}
      >
        <SelectTrigger
          aria-label={t('references.language')}
          disabled={disabled}
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
        {value === targetLanguage
          ? t('references.sameLanguageHint')
          : t('references.otherLanguageHint')}
      </span>
    </div>
  )
}

function TrimMargins({
  checked,
  disabled,
  className,
  onChange,
}: {
  checked: boolean
  disabled: boolean
  className?: string
  onChange: (checked: boolean) => void
}) {
  const { t } = useTranslation()
  return (
    <label className={cn('flex items-start gap-2.5', className)}>
      <Checkbox
        checked={checked}
        disabled={disabled}
        className='mt-0.5'
        onCheckedChange={onChange}
      />
      <span className='grid gap-0.5'>
        <span>{t('references.trimMargins')}</span>
        <span className='text-[11px] text-muted-foreground'>{t('references.trimMarginsHint')}</span>
      </span>
    </label>
  )
}

function PairRow({
  page,
  number,
  reference,
  staged,
  pages,
  disabled,
  dragged,
  over,
  source,
  target,
  onPreview,
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
  /** Whether this row's reference is being dragged. */
  dragged: boolean
  /** Whether a dragged reference would be dropped on this row. */
  over: boolean
  /** Makes the row's reference draggable. */
  source: ComponentProps<'div'>
  /** Makes the row a place to drop a reference on. */
  target: DropTargetProps
  onPreview: () => void
  onPair: (reference: number, page: string) => void
  onUnpair: () => void
  onShift: (direction: ShiftDirection) => void
}) {
  const { t } = useTranslation()
  const candidate = reference === null ? null : staged.candidates[reference]
  const label = t('references.pageLabel', { number, label: page.label })
  return (
    <li
      {...target}
      aria-label={label}
      data-over={over}
      className='grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_auto] items-center gap-2 border-b border-border/60 px-2 py-1.5 last:border-b-0 data-[over=true]:bg-primary/[0.09]'
    >
      <div className='flex min-w-0 items-center gap-2'>
        <button
          type='button'
          aria-label={t('references.preview', { label })}
          className='shrink-0 rounded outline-none focus-visible:ring-2 focus-visible:ring-ring/50'
          onClick={onPreview}
        >
          <Peek className='h-12 w-9 rounded'>
            {page.source_asset && (
              <PageThumbnail page={page.id} asset={page.source_asset} label={page.label} />
            )}
          </Peek>
        </button>
        <FileName name={label} className='text-[11px]' />
      </div>
      <ArrowRight className='size-3.5 text-muted-foreground' />
      {candidate && reference !== null ? (
        <div
          {...source}
          title={t('references.dragHint')}
          className={cn(
            'flex min-w-0 cursor-grab items-center gap-2 select-none active:cursor-grabbing',
            dragged && 'opacity-50',
          )}
          // A press that does not move is no drag, so it shows the pair.
          onClick={onPreview}
        >
          <Peek className='h-12 w-9 rounded'>
            <StagedThumbnail staged={staged} reference={reference} label={candidate.name} />
          </Peek>
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

/** A thumbnail that opens the preview, marked by an eye while hovered. */
function Peek({ className, children }: { className: string; children: ReactNode }) {
  return (
    <span
      className={cn(
        'group/peek relative grid shrink-0 place-items-center overflow-hidden bg-[var(--surface-well)]',
        className,
      )}
    >
      {children}
      <Eye
        aria-hidden
        className='absolute top-0.5 right-0.5 size-3 rounded-sm bg-background/85 p-px text-foreground opacity-0 transition-opacity group-hover/peek:opacity-100'
      />
    </span>
  )
}

/** An object URL for `bytes`, revoked once they change or are gone. */
function useObjectUrl(bytes: Uint8Array | undefined, type?: string) {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!bytes) {
      setUrl(null)
      return
    }
    const next = URL.createObjectURL(new Blob([bytes.buffer as ArrayBuffer], { type }))
    setUrl(next)
    return () => URL.revokeObjectURL(next)
  }, [bytes, type])
  return url
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
  const url = useObjectUrl(bytes, 'image/webp')

  return url ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={url} alt={label} draggable={false} className='size-full object-contain' />
  ) : null
}

/** How far the preview is zoomed and moved, in CSS pixels of each pane. */
interface View {
  scale: number
  x: number
  y: number
}

const fitted: View = { scale: 1, x: 0, y: 0 }
/** The preview zooms from fitting each image to this many times larger. */
const MAX_PREVIEW_SCALE = 8

/** `view` zoomed by `factor` around a point of a pane. */
function zoomed(view: View, factor: number, x: number, y: number): View {
  const scale = Math.min(MAX_PREVIEW_SCALE, Math.max(1, view.scale * factor))
  if (scale === 1) return fitted
  const grown = scale / view.scale
  return { scale, x: x - (x - view.x) * grown, y: y - (y - view.y) * grown }
}

/**
 * A page's original artwork beside the reference paired with it, large
 * enough to tell whether they are the same page. Both zoom and move
 * together, and the arrows step through the pages. A reference that is not
 * paired shows alone.
 */
function ReferencePreview({
  previewed,
  rows,
  staged,
  onShow,
  onClose,
}: {
  previewed: Previewed
  rows: ReadonlyArray<{ page: PageSummary; reference: number | null }>
  staged: Staged
  onShow: (previewed: Previewed) => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  const index = 'page' in previewed ? rows.findIndex(({ page }) => page.id === previewed.page) : -1
  const row = index >= 0 ? rows[index] : null
  const reference = row ? row.reference : 'file' in previewed ? previewed.file : null
  const original = usePageImage(row?.page.id ?? '', 'source', row?.page.source_asset ?? null)
  const image = useObjectUrl(
    useQuery({
      queryKey: ['staged-reference-image', staged.generation, reference],
      queryFn: async () => new Uint8Array(await call(commands.getStagedReferenceImage, reference!)),
      enabled: reference !== null,
      staleTime: Number.POSITIVE_INFINITY,
      gcTime: 0,
    }).data,
  )
  const [view, setView] = useState(fitted)
  const panes = useRef<HTMLDivElement>(null)

  // Each pair starts fitted.
  const pageId = row?.page.id
  useEffect(() => setView(fitted), [pageId, reference])

  const go = (step: number) => {
    const next = index >= 0 ? rows[index + step] : undefined
    if (next) onShow({ page: next.page.id })
  }
  // The arrow keys step through the pages wherever the focus is, as the
  // button that had it is disabled on the first or last page.
  useEffect(() => {
    const step = (event: KeyboardEvent) => {
      if (event.key === 'ArrowLeft') go(-1)
      else if (event.key === 'ArrowRight') go(1)
    }
    window.addEventListener('keydown', step)
    return () => window.removeEventListener('keydown', step)
  })
  const zoomBy = (factor: number) => {
    const pane = panes.current?.firstElementChild?.getBoundingClientRect()
    if (pane) setView((current) => zoomed(current, factor, pane.width / 2, pane.height / 2))
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent className='grid h-[min(92vh,1000px)] w-[min(96vw,1400px)] max-w-none grid-rows-[auto_minmax(0,1fr)_auto] sm:max-w-none'>
        <DialogHeader>
          <DialogTitle>{t('references.previewTitle')}</DialogTitle>
          <DialogDescription className='flex min-w-0 items-center gap-2 pr-8'>
            <FileName
              name={
                row
                  ? t('references.pageLabel', { number: index + 1, label: row.page.label })
                  : t('references.notPairedTitle')
              }
            />
            <ArrowRight className='size-3.5 shrink-0' />
            <FileName
              name={reference === null ? t('references.none') : staged.candidates[reference].name}
            />
          </DialogDescription>
        </DialogHeader>
        <div ref={panes} className='grid min-h-0 grid-cols-2 gap-2'>
          <PreviewPane
            label={t('compare.original')}
            url={original}
            empty={row ? t('navigator.noImage') : t('references.notPairedTitle')}
            view={view}
            onView={setView}
          />
          <PreviewPane
            label={t('compare.reference')}
            url={image}
            empty={t('references.none')}
            view={view}
            onView={setView}
          />
        </div>
        <DialogFooter className='items-center sm:justify-between'>
          {row ? (
            <div className='flex items-center gap-1'>
              <Button
                type='button'
                size='icon-sm'
                variant='outline'
                aria-label={t('references.previousPage')}
                disabled={index === 0}
                onClick={() => go(-1)}
              >
                <ChevronLeft />
              </Button>
              <span className='min-w-16 text-center text-[11px] text-muted-foreground tabular-nums'>
                {t('references.previewPosition', { number: index + 1, count: rows.length })}
              </span>
              <Button
                type='button'
                size='icon-sm'
                variant='outline'
                aria-label={t('references.nextPage')}
                disabled={index === rows.length - 1}
                onClick={() => go(1)}
              >
                <ChevronRight />
              </Button>
            </div>
          ) : (
            <span />
          )}
          <p className='text-[11px] text-muted-foreground'>{t('references.previewHint')}</p>
          <div className='flex items-center gap-1'>
            <Button
              type='button'
              size='icon-sm'
              variant='outline'
              aria-label={t('references.zoomOut')}
              disabled={view.scale === 1}
              onClick={() => zoomBy(1 / 1.5)}
            >
              <ZoomOut />
            </Button>
            <Button
              type='button'
              size='icon-sm'
              variant='outline'
              aria-label={t('references.fit')}
              disabled={view.scale === 1}
              onClick={() => setView(fitted)}
            >
              <Maximize2 />
            </Button>
            <Button
              type='button'
              size='icon-sm'
              variant='outline'
              aria-label={t('references.zoomIn')}
              disabled={view.scale === MAX_PREVIEW_SCALE}
              onClick={() => zoomBy(1.5)}
            >
              <ZoomIn />
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** One image of the preview: the wheel zooms around the pointer, dragging moves it. */
function PreviewPane({
  label,
  url,
  empty,
  view,
  onView,
}: {
  label: string
  url: string | null
  empty: string
  view: View
  onView: Dispatch<SetStateAction<View>>
}) {
  const pan = useRef<{ pointer: number; x: number; y: number; view: View } | null>(null)
  return (
    <figure
      className='relative m-0 min-h-0 cursor-grab touch-none overflow-hidden rounded-lg bg-[var(--surface-well)] active:cursor-grabbing'
      onWheel={(event) => {
        const box = event.currentTarget.getBoundingClientRect()
        const factor = Math.exp(-event.deltaY * 0.0015)
        onView((current) =>
          zoomed(current, factor, event.clientX - box.left, event.clientY - box.top),
        )
      }}
      onPointerDown={(event) => {
        if (event.button !== 0) return
        event.currentTarget.setPointerCapture(event.pointerId)
        pan.current = { pointer: event.pointerId, x: event.clientX, y: event.clientY, view }
      }}
      onPointerMove={(event) => {
        const start = pan.current
        if (!start || start.pointer !== event.pointerId || start.view.scale === 1) return
        onView({
          ...start.view,
          x: start.view.x + event.clientX - start.x,
          y: start.view.y + event.clientY - start.y,
        })
      }}
      onPointerUp={(event) => {
        pan.current = null
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId)
        }
      }}
      onPointerCancel={() => (pan.current = null)}
    >
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={url}
          alt={label}
          draggable={false}
          className='absolute inset-0 size-full origin-top-left object-contain select-none'
          style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
        />
      ) : (
        <p className='grid size-full place-items-center p-4 text-center text-[11px] text-muted-foreground'>
          {empty}
        </p>
      )}
      <figcaption className='pointer-events-none absolute top-2 left-2 rounded-md bg-background/85 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground shadow-sm'>
        {label}
      </figcaption>
    </figure>
  )
}
