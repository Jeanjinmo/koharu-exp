'use client'

import { useQuery } from '@tanstack/react-query'
import { Pencil, Plus, Search, Trash2 } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'

import { call } from '@/lib/backend'
import { projectKey, refresh, useProject } from '@/lib/queries'
import { commands, type GlossaryEntry } from '@koharu/bridge/protocol'
import { Button } from '@koharu/ui/components/button'
import { Input } from '@koharu/ui/components/input'
import { ScrollArea } from '@koharu/ui/components/scroll-area'

/** The term being added (`previous` null) or the term being changed. */
interface Draft {
  previous: string | null
  term: string
  translation: string
  note: string
}

const blank: Draft = { previous: null, term: '', translation: '', note: '' }

/**
 * The project glossary: terms and names with the translation each keeps.
 * Translation and agents follow it, and agents can add to it, so it is read
 * again whenever the project changes.
 */
export function GlossaryPanel() {
  const { t } = useTranslation()
  const project = useProject().data
  const entries =
    useQuery({
      queryKey: ['glossary', project?.name, project?.revision],
      queryFn: () => call(commands.getGlossary),
      enabled: Boolean(project),
      // Keep showing the list while a newer revision of the project loads.
      placeholderData: (previous, previousQuery) =>
        previousQuery?.queryKey[1] === project?.name ? previous : undefined,
    }).data ?? []
  const [query, setQuery] = useState('')
  const [draft, setDraft] = useState<Draft | null>(null)
  const [saving, setSaving] = useState(false)
  const normalized = query.trim().toLocaleLowerCase()
  const shown = normalized
    ? entries.filter((entry) =>
        [entry.term, entry.translation, entry.note ?? ''].some((field) =>
          field.toLocaleLowerCase().includes(normalized),
        ),
      )
    : entries
  const duplicate =
    draft !== null &&
    draft.term.trim() !== draft.previous &&
    entries.some((entry) => entry.term === draft.term.trim())

  const save = (event: FormEvent) => {
    event.preventDefault()
    if (!draft || duplicate || !draft.term.trim() || !draft.translation.trim()) return
    setSaving(true)
    void call(commands.setGlossaryTerm, draft.previous, {
      term: draft.term,
      translation: draft.translation,
      note: draft.note.trim() ? draft.note : null,
    })
      .then(async () => {
        setDraft(null)
        await refresh(projectKey)
      })
      .catch(() => undefined)
      .finally(() => setSaving(false))
  }

  const remove = (entry: GlossaryEntry) =>
    void call(commands.removeGlossaryTerm, entry.term)
      .then(() => refresh(projectKey))
      .catch(() => undefined)

  return (
    <section aria-label={t('glossary.title')} className='flex h-full min-h-0 flex-col'>
      <header className='flex shrink-0 items-center gap-2 px-2.5 pt-2.5'>
        <h2 className='text-[11px] font-semibold'>{t('glossary.title')}</h2>
        <span className='rounded-full bg-primary/[0.07] px-1.5 py-0.5 text-[9px] text-muted-foreground tabular-nums'>
          {entries.length}
        </span>
        <Button
          type='button'
          size='xs'
          variant='ghost'
          className='ml-auto h-6 gap-1 px-1.5 text-[10px]'
          disabled={!project || draft?.previous === null}
          onClick={() => setDraft(blank)}
        >
          <Plus className='size-3' /> {t('glossary.add')}
        </Button>
      </header>
      <p className='shrink-0 px-2.5 pt-1 text-[10px] leading-4 text-muted-foreground'>
        {t('glossary.description')}
      </p>
      {draft && (
        <form
          aria-label={draft.previous === null ? t('glossary.addTitle') : t('glossary.editTitle')}
          className='mx-2.5 mt-2 grid shrink-0 gap-1.5 rounded-lg border border-border/70 bg-background/60 p-2'
          onSubmit={save}
        >
          <Input
            autoFocus
            value={draft.term}
            aria-label={t('glossary.term')}
            placeholder={t('glossary.term')}
            className='h-7 text-[11px] md:text-[11px]'
            onChange={(event) => setDraft({ ...draft, term: event.currentTarget.value })}
          />
          <Input
            value={draft.translation}
            aria-label={t('glossary.translation')}
            placeholder={t('glossary.translation')}
            className='h-7 text-[11px] md:text-[11px]'
            onChange={(event) => setDraft({ ...draft, translation: event.currentTarget.value })}
          />
          <Input
            value={draft.note}
            aria-label={t('glossary.note')}
            placeholder={t('glossary.notePlaceholder')}
            className='h-7 text-[11px] md:text-[11px]'
            onChange={(event) => setDraft({ ...draft, note: event.currentTarget.value })}
          />
          {duplicate && (
            <p role='alert' className='text-[10px] text-destructive'>
              {t('glossary.duplicate')}
            </p>
          )}
          <div className='flex justify-end gap-1.5'>
            <Button
              type='button'
              size='xs'
              variant='ghost'
              disabled={saving}
              onClick={() => setDraft(null)}
            >
              {t('common.cancel')}
            </Button>
            <Button
              type='submit'
              size='xs'
              disabled={saving || duplicate || !draft.term.trim() || !draft.translation.trim()}
            >
              {t('glossary.save')}
            </Button>
          </div>
        </form>
      )}
      {entries.length > 0 && (
        <label className='mx-2.5 mt-2 flex h-6 shrink-0 items-center gap-1.5 rounded-md border border-input bg-background/70 px-1.5'>
          <Search className='size-3 text-muted-foreground' />
          <Input
            value={query}
            aria-label={t('glossary.filter')}
            placeholder={t('glossary.filter')}
            className='h-5 min-w-0 border-0 bg-transparent p-0 text-[11px] shadow-none focus-visible:ring-0 md:text-[11px]'
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
        </label>
      )}
      {entries.length === 0 ? (
        <p className='px-2.5 pt-4 text-center text-[10px] text-muted-foreground'>
          {t('glossary.empty')}
        </p>
      ) : (
        <ScrollArea className='mt-2 min-h-0 flex-1' viewportClassName='px-2.5 pb-2.5'>
          <ul className='grid gap-1'>
            {shown.map((entry) => (
              <li
                key={entry.term}
                aria-label={entry.term}
                className='group grid grid-cols-[minmax(0,1fr)_auto] items-start gap-1 rounded-lg px-2 py-1.5 hover:bg-foreground/[0.045]'
              >
                <div className='min-w-0 text-[11px]'>
                  <p className='break-words'>
                    <span className='font-medium'>{entry.term}</span>
                    <span className='text-muted-foreground'> → </span>
                    {entry.translation}
                  </p>
                  {entry.note && (
                    <p className='mt-0.5 text-[10px] break-words text-muted-foreground'>
                      {entry.note}
                    </p>
                  )}
                </div>
                <div className='flex opacity-0 group-hover:opacity-100 focus-within:opacity-100'>
                  <Button
                    type='button'
                    size='icon-xs'
                    variant='ghost'
                    aria-label={t('glossary.edit', { term: entry.term })}
                    onClick={() =>
                      setDraft({
                        previous: entry.term,
                        term: entry.term,
                        translation: entry.translation,
                        note: entry.note ?? '',
                      })
                    }
                  >
                    <Pencil />
                  </Button>
                  <Button
                    type='button'
                    size='icon-xs'
                    variant='ghost'
                    aria-label={t('glossary.remove', { term: entry.term })}
                    onClick={() => remove(entry)}
                  >
                    <Trash2 />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </ScrollArea>
      )}
    </section>
  )
}
