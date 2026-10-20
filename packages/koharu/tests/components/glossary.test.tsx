import { QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { GlossaryPanel } from '@/components/editor/GlossaryPanel'
import { projectKey, queryClient } from '@/lib/queries'
import { commands, type GlossaryEntry } from '@koharu/bridge/protocol'

const project = {
  name: 'Book',
  revision: 1,
  active_page: null,
  can_undo: false,
  can_redo: false,
}

const entries: GlossaryEntry[] = [
  { term: '神様', translation: 'Sang Dewa', note: 'Always capitalized.' },
  { term: 'ハル', translation: 'Haru', note: null },
]

beforeEach(() => {
  queryClient.setQueryData(projectKey, project)
  vi.spyOn(commands, 'getGlossary').mockResolvedValue(entries)
  vi.spyOn(commands, 'getProject').mockResolvedValue({ ...project, revision: 2 })
})

function renderPanel() {
  render(
    <QueryClientProvider client={queryClient}>
      <GlossaryPanel />
    </QueryClientProvider>,
  )
}

describe('glossary', () => {
  it('lists the terms with their translations and notes and filters them', async () => {
    const user = userEvent.setup()
    renderPanel()

    const god = await screen.findByRole('listitem', { name: '神様' })
    expect(god).toHaveTextContent('神様 → Sang Dewa')
    expect(god).toHaveTextContent('Always capitalized.')
    await user.type(screen.getByRole('textbox', { name: 'Search the glossary' }), 'haru')
    expect(screen.queryByRole('listitem', { name: '神様' })).not.toBeInTheDocument()
    expect(screen.getByRole('listitem', { name: 'ハル' })).toBeInTheDocument()
  })

  it('adds a term and refuses one the glossary already has', async () => {
    const user = userEvent.setup()
    const save = vi.spyOn(commands, 'setGlossaryTerm').mockResolvedValue(null)
    renderPanel()
    await screen.findByRole('listitem', { name: '神様' })

    await user.click(screen.getByRole('button', { name: 'Add' }))
    const form = screen.getByRole('form', { name: 'Add a term' })
    await user.type(within(form).getByRole('textbox', { name: 'Term' }), 'ハル')
    expect(within(form).getByRole('alert')).toHaveTextContent('already in the glossary')
    expect(within(form).getByRole('button', { name: 'Save' })).toBeDisabled()

    await user.type(within(form).getByRole('textbox', { name: 'Term' }), 'ちゃん')
    await user.type(within(form).getByRole('textbox', { name: 'Translation' }), 'Haru-chan')
    await user.click(within(form).getByRole('button', { name: 'Save' }))

    expect(save).toHaveBeenCalledWith(null, {
      term: 'ハルちゃん',
      translation: 'Haru-chan',
      note: null,
    })
    await waitFor(() => expect(screen.queryByRole('form')).not.toBeInTheDocument())
  })

  it('changes a term in place and removes another', async () => {
    const user = userEvent.setup()
    const save = vi.spyOn(commands, 'setGlossaryTerm').mockResolvedValue(null)
    const remove = vi.spyOn(commands, 'removeGlossaryTerm').mockResolvedValue(null)
    renderPanel()
    await screen.findByRole('listitem', { name: '神様' })

    await user.click(screen.getByRole('button', { name: 'Change 神様' }))
    const form = screen.getByRole('form', { name: 'Change a term' })
    const translation = within(form).getByRole('textbox', { name: 'Translation' })
    await user.clear(translation)
    await user.type(translation, 'Dewa')
    await user.click(within(form).getByRole('button', { name: 'Save' }))
    expect(save).toHaveBeenCalledWith('神様', {
      term: '神様',
      translation: 'Dewa',
      note: 'Always capitalized.',
    })

    await user.click(screen.getByRole('button', { name: 'Remove ハル' }))
    expect(remove).toHaveBeenCalledWith('ハル')
  })
})
