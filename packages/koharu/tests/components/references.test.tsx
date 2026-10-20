import { QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { PageRail } from '@/components/editor/PageRail'
import { pairReferences, ReferenceImportDialog } from '@/components/editor/References'
import { pageKey, pagesKey, projectKey, queryClient } from '@/lib/queries'
import { useKoharuStore } from '@/lib/store'
import {
  commands,
  type PageReferenceSummary,
  type PageSummary,
  type Preferences,
} from '@koharu/bridge/protocol'

function page(id: string, reference: PageReferenceSummary | null = null): PageSummary {
  return {
    id,
    label: id,
    size: { width: 1000, height: 1500 },
    source_asset: null,
    layer_count: 0,
    status: 'not_started',
    reference,
  }
}

const english: PageReferenceSummary = {
  asset: 'reference-blob',
  language: 'en-US',
  placement: { x: 0, y: 0, width: 1, height: 1 },
}

function install(pages: PageSummary[]) {
  queryClient.setQueryData(projectKey, {
    name: 'Book',
    revision: 1,
    active_page: pages[0].id,
    can_undo: false,
    can_redo: false,
  })
  queryClient.setQueryData(pagesKey, pages)
  queryClient.setQueryData(pageKey, {
    id: pages[0].id,
    label: pages[0].label,
    size: pages[0].size,
    layers: [],
    regions: [],
  })
}

beforeEach(() => {
  vi.spyOn(commands, 'getStagedReferenceThumbnail').mockResolvedValue([1, 2, 3])
  vi.spyOn(commands, 'discardStagedReferences').mockResolvedValue(null)
  vi.spyOn(commands, 'getPages').mockResolvedValue([])
  vi.spyOn(commands, 'getProject').mockResolvedValue(null)
})

describe('pairing references', () => {
  const pages = ['one', 'two', 'three'].map((id) => page(id))

  it('pairs in order and shifts the rest around skipped references and gaps', () => {
    const order = (skipped: number[], gaps: string[]) => {
      const pairing = pairReferences(pages, 4, new Set(skipped), new Set(gaps))
      return [pairing.rows.map((row) => row.reference), pairing.leftover]
    }
    expect(order([], [])).toEqual([[0, 1, 2], [3]])
    expect(order([0], [])).toEqual([[1, 2, 3], []])
    expect(order([], ['two'])).toEqual([
      [0, null, 1],
      [2, 3],
    ])
    expect(order([1, 2, 3], [])).toEqual([[0, null, null], []])
  })
})

describe('reference import', () => {
  it('stages references, lets pages be shifted, and attaches the pairs in one call', async () => {
    const user = userEvent.setup()
    install([page('one'), page('two', english), page('three')])
    useKoharuStore.setState({
      referenceImport: true,
      preferences: {
        languages: [
          { tag: 'en-US', name: 'English' },
          { tag: 'id-ID', name: 'Indonesian' },
        ],
        pipeline: { translation: { target_language: 'id-ID' } },
      } as unknown as Preferences,
    })
    vi.spyOn(commands, 'stageReferences').mockResolvedValue([
      { name: 'cover.jpg', width: 800, height: 1200 },
      { name: 'p1.jpg', width: 800, height: 1200 },
      { name: 'p2.jpg', width: 800, height: 1200 },
    ])
    const attach = vi.spyOn(commands, 'attachReferences').mockResolvedValue(null)
    render(
      <QueryClientProvider client={queryClient}>
        <ReferenceImportDialog />
      </QueryClientProvider>,
    )

    await user.click(screen.getByRole('checkbox', { name: /Trim margins/ }))
    await user.click(screen.getByRole('button', { name: 'Choose files…' }))
    expect(commands.stageReferences).toHaveBeenCalledWith('files', true)

    const first = await screen.findByRole('listitem', { name: '1. one' })
    expect(within(first).getByText('cover.jpg')).toBeInTheDocument()
    await user.click(within(first).getByRole('button', { name: 'Skip' }))
    expect(within(first).getByText('p1.jpg')).toBeInTheDocument()

    const third = screen.getByRole('listitem', { name: '3. three' })
    await user.click(within(third).getByRole('button', { name: 'No reference here' }))
    expect(within(third).getByText('No reference')).toBeInTheDocument()
    const second = screen.getByRole('listitem', { name: '2. two' })
    expect(within(second).getByText('Replaces the current reference')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('2 of 3 pages get a reference')

    await user.click(screen.getByRole('button', { name: 'Attach 2 references' }))
    expect(attach).toHaveBeenCalledWith(
      [
        { page: 'one', reference: 1 },
        { page: 'two', reference: 2 },
      ],
      'id-ID',
    )
    await waitFor(() => expect(useKoharuStore.getState().referenceImport).toBe(false))
  })

  it('discards staged references when the dialog is cancelled', async () => {
    const user = userEvent.setup()
    install([page('one')])
    useKoharuStore.setState({ referenceImport: true })
    vi.spyOn(commands, 'stageReferences').mockResolvedValue([
      { name: 'p1.jpg', width: 800, height: 1200 },
    ])
    render(
      <QueryClientProvider client={queryClient}>
        <ReferenceImportDialog />
      </QueryClientProvider>,
    )

    await user.click(screen.getByRole('button', { name: 'Choose folder…' }))
    await screen.findByRole('listitem', { name: '1. one' })
    await user.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(commands.discardStagedReferences).toHaveBeenCalled()
    expect(useKoharuStore.getState().referenceImport).toBe(false)
  })

  it('removes the references of every selected page from one page menu', async () => {
    const user = userEvent.setup()
    install([page('one', english), page('two'), page('three', english)])
    useKoharuStore.setState({ selectedPages: ['one', 'two', 'three'] })
    const detach = vi.spyOn(commands, 'detachReferences').mockResolvedValue(null)
    render(
      <QueryClientProvider client={queryClient}>
        <PageRail />
      </QueryClientProvider>,
    )

    expect(screen.getAllByText('Reference')).toHaveLength(2)
    await user.click(screen.getByRole('button', { name: 'Actions for three' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Remove reference' }))

    await waitFor(() => expect(detach).toHaveBeenCalledWith(['one', 'three']))
  })
})
