'use client'

import { useQuery } from '@tanstack/react-query'
import { ArrowRight, FilePlus2, FolderOpen, LoaderCircle } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@koharu/ui/components/select'
import { toast } from '@koharu/ui/components/toast'

const emptyPages: PageSummary[] = []

interface Staged {
  /** Tells thumbnails of one staging apart from those of the one before. */
  generation: number
  candidates: ReferenceCandidate[]
}

interface Pairing {
  rows: Array<{ page: PageSummary; reference: number | null }>
  leftover: number[]
}

/**
 * Pairs references with pages in order. A skipped reference is left out, and
 * a page marked as a gap gets none, so either shifts the references after it.
 */
export function pairReferences(
  pages: readonly PageSummary[],
  count: number,
  skipped: ReadonlySet<number>,
  gaps: ReadonlySet<string>,
): Pairing {
  let next = 0
  const take = () => {
    while (next < count && skipped.has(next)) next += 1
    return next < count ? next++ : null
  }
  const rows = pages.map((page) => ({ page, reference: gaps.has(page.id) ? null : take() }))
  const leftover: number[] = []
  for (let reference = take(); reference !== null; reference = take()) leftover.push(reference)
  return { rows, leftover }
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
  const [skipped, setSkipped] = useState<ReadonlySet<number>>(new Set())
  const [gaps, setGaps] = useState<ReadonlySet<string>>(new Set())

  const pairing = useMemo(
    () => pairReferences(pages, staged?.candidates.length ?? 0, skipped, gaps),
    [gaps, pages, skipped, staged],
  )
  const pairs = pairing.rows.flatMap(({ page, reference }) =>
    reference === null ? [] : [{ page: page.id, reference }],
  )
  const busy = reading || attaching

  const discard = () => {
    setStaged(null)
    void call(commands.discardStagedReferences).catch(() => undefined)
  }

  const finish = () => {
    setChosenLanguage(null)
    setTrimMargins(false)
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
        setSkipped(new Set())
        setGaps(new Set())
        setStaged((previous) => ({ generation: (previous?.generation ?? 0) + 1, candidates }))
      })
      .catch(() => undefined)
      .finally(() => setReading(false))
  }

  const attach = () => {
    setAttaching(true)
    void call(commands.attachReferences, pairs, language)
      .then(async () => {
        setStaged(null)
        finish()
        await refresh(projectKey, pagesKey)
        toast.add({ type: 'success', title: t('references.attached', { count: pairs.length }) })
      })
      .catch(() => undefined)
      .finally(() => setAttaching(false))
  }

  const toggle = <T,>(values: ReadonlySet<T>, value: T) => {
    const next = new Set(values)
    if (!next.delete(value)) next.add(value)
    return next
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
            <p className='text-[11px] text-muted-foreground' role='status'>
              {t('references.summary', { count: pairs.length, pages: pages.length })}
              {pairing.leftover.length > 0 &&
                ` · ${t('references.leftover', { count: pairing.leftover.length })}`}
            </p>
            <ol className='min-h-0 overflow-y-auto rounded-lg border border-border/70'>
              {pairing.rows.map(({ page, reference }, index) => (
                <PairRow
                  key={page.id}
                  page={page}
                  number={index + 1}
                  reference={reference}
                  staged={staged}
                  gap={gaps.has(page.id)}
                  disabled={busy}
                  onSkip={() => reference !== null && setSkipped(toggle(skipped, reference))}
                  onGap={() => setGaps(toggle(gaps, page.id))}
                />
              ))}
            </ol>
            {skipped.size > 0 && (
              <div className='flex flex-wrap items-center gap-1.5 text-[11px]'>
                <span className='text-muted-foreground'>{t('references.skipped')}</span>
                {[...skipped]
                  .sort((left, right) => left - right)
                  .map((reference) => (
                    <Button
                      key={reference}
                      type='button'
                      size='xs'
                      variant='outline'
                      disabled={busy}
                      title={t('references.restore')}
                      onClick={() => setSkipped(toggle(skipped, reference))}
                    >
                      {staged.candidates[reference]?.name}
                    </Button>
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
            disabled={busy || pairs.length === 0}
            aria-busy={attaching}
            onClick={attach}
          >
            {attaching && <LoaderCircle className='animate-spin' />}
            {t('references.attach', { count: pairs.length })}
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
  gap,
  disabled,
  onSkip,
  onGap,
}: {
  page: PageSummary
  number: number
  reference: number | null
  staged: Staged
  gap: boolean
  disabled: boolean
  onSkip: () => void
  onGap: () => void
}) {
  const { t } = useTranslation()
  const candidate = reference === null ? null : staged.candidates[reference]
  const label = t('references.pageLabel', { number, label: page.label })
  return (
    <li
      aria-label={label}
      className='grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_auto] items-center gap-2 border-b border-border/60 px-2 py-1.5 last:border-b-0'
    >
      <div className='flex min-w-0 items-center gap-2'>
        <div className='grid h-12 w-9 shrink-0 place-items-center overflow-hidden rounded bg-[var(--surface-well)]'>
          {page.source_asset && (
            <PageThumbnail page={page.id} asset={page.source_asset} label={page.label} />
          )}
        </div>
        <span className='min-w-0 truncate text-[11px]'>{label}</span>
      </div>
      <ArrowRight className='size-3.5 text-muted-foreground' />
      <div className='flex min-w-0 items-center gap-2'>
        {candidate && reference !== null ? (
          <>
            <div className='grid h-12 w-9 shrink-0 place-items-center overflow-hidden rounded bg-[var(--surface-well)]'>
              <StagedThumbnail staged={staged} reference={reference} label={candidate.name} />
            </div>
            <span className='grid min-w-0 text-[11px]'>
              <span className='truncate'>{candidate.name}</span>
              {page.reference && (
                <span className='truncate text-[10px] text-muted-foreground'>
                  {t('references.replaces')}
                </span>
              )}
            </span>
          </>
        ) : (
          <span className='text-[11px] text-muted-foreground'>{t('references.none')}</span>
        )}
      </div>
      <div className='flex gap-1'>
        {candidate && (
          <Button
            type='button'
            size='xs'
            variant='ghost'
            disabled={disabled}
            title={t('references.skipHint')}
            onClick={onSkip}
          >
            {t('references.skip')}
          </Button>
        )}
        <Button
          type='button'
          size='xs'
          variant='ghost'
          disabled={disabled}
          title={gap ? undefined : t('references.gapHint')}
          onClick={onGap}
        >
          {gap ? t('references.pairAgain') : t('references.gap')}
        </Button>
      </div>
    </li>
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
