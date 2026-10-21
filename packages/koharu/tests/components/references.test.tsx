import { QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ActivityCenter } from '@/components/editor/ActivityCenter'
import { PageRail } from '@/components/editor/PageRail'
import {
  moveReference,
  pairReferences,
  ReferenceFileDialog,
  ReferenceImportDialog,
  shiftReferences,
  type Pairs,
} from '@/components/editor/References'
import { pageKey, pagesKey, projectKey, queryClient } from '@/lib/queries'
import { receiveJob, useKoharuStore } from '@/lib/store'
import {
  commands,
  type PageReferenceSummary,
  type PageSummary,
  type Preferences,
} from '@koharu/bridge/protocol'
import { toast } from '@koharu/ui/components/toast'

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

// The owner's sample: a cover, a title strip, and nine pages, named alike in
// both editions apart from their language prefix.
const sampleMarks = ['', 'P00', ...Array.from({ length: 9 }, (_, index) => `P0${index + 1}`)]
const sampleName = (language: string, mark: string) =>
  `${language}_Pepper-and-Carrot_by-David-Revoy_E33${mark}.jpg`

function labelled(id: string, label: string): PageSummary {
  return { ...page(id), label }
}

/** Each page's reference in page order, `null` where it has none. */
function order(pages: PageSummary[], pairs: Pairs) {
  return pages.map((each) => pairs.get(each.id) ?? null)
}

describe('pairing references', () => {
  const pages = ['one', 'two', 'three'].map((id) => page(id))

  it('pairs references with the pages their file names point to', () => {
    const raw = sampleMarks.map((mark, index) => labelled(`page-${index}`, sampleName('ja', mark)))
    // Staged in another order, so only the names can pair them.
    const names = [...sampleMarks].reverse().map((mark) => sampleName('id', mark))

    expect(order(raw, pairReferences(raw, names))).toEqual([10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0])
    // One reference goes to its own page, not the first one.
    expect(order(raw, pairReferences(raw, [sampleName('id', 'P02')]))[3]).toBe(0)
  })

  it('ignores marks every name shares and leading zeros', () => {
    const raw = [labelled('one', 'ch3_p01.jpg'), labelled('two', 'ch3_p02.jpg')]
    const names = ['ch3_p2_v2.png', 'ch3_p1_v2.png']
    expect(order(raw, pairReferences(raw, names))).toEqual([1, 0])
  })

  it('pairs in order what the names do not settle', () => {
    expect(
      order(pages, pairReferences(pages, ['cover.jpg', 'p1.jpg', 'p2.jpg', 'p3.jpg'])),
    ).toEqual([0, 1, 2])
    // Two references fit page `p1`, so neither is taken by name.
    const raw = [labelled('one', 'p1.jpg'), labelled('two', 'p2.jpg'), labelled('three', 'p3.jpg')]
    expect(order(raw, pairReferences(raw, ['p1.png', 'p1.jpg', 'p3.png']))).toEqual([0, 1, 2])
    expect(order(raw, pairReferences(raw, ['p3.png', 'scan.png']))).toEqual([1, null, 0])
  })

  it('swaps a moved reference with the one on its new page', () => {
    const pairs = new Map([
      ['one', 0],
      ['three', 2],
    ])
    expect(order(pages, moveReference(pairs, 0, 'three'))).toEqual([2, null, 0])
    expect(order(pages, moveReference(pairs, 0, 'two'))).toEqual([null, 0, 2])
    // A reference that was not paired sends the page's one out of the pairs.
    expect(order(pages, moveReference(pairs, 1, 'three'))).toEqual([0, null, 1])
    expect(order(pages, moveReference(pairs, 0, 'one'))).toEqual([0, null, 2])
  })

  it('shifts the references from a page on and counts what moved', () => {
    const pairs = new Map([
      ['one', 0],
      ['two', 1],
      ['three', 2],
    ])
    const shifted = (from: Pairs, at: string, direction: 'up' | 'down') => {
      const result = shiftReferences(pages, from, at, direction, 4)
      return [order(pages, result.pairs), result.shifted]
    }
    // The fourth reference follows the last page's one, so it moves in.
    expect(shifted(pairs, 'one', 'up')).toEqual([[1, 2, 3], 3])
    expect(shifted(pairs, 'three', 'up')).toEqual([[0, 1, 3], 1])
    expect(shifted(pairs, 'two', 'down')).toEqual([[0, null, 1], 2])
    // Shifting the gap back up brings the dropped reference back.
    const gap = shiftReferences(pages, pairs, 'two', 'down', 4).pairs
    expect(shifted(gap, 'two', 'up')).toEqual([[0, 1, 2], 2])
    // A last page without a reference takes none in.
    expect(shifted(new Map([['one', 0]]), 'one', 'up')).toEqual([[null, null, null], 0])
  })
})

function openDialog() {
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
  render(
    <QueryClientProvider client={queryClient}>
      <ReferenceImportDialog />
    </QueryClientProvider>,
  )
}

function stage(...names: string[]) {
  vi.spyOn(commands, 'stageReferences').mockResolvedValue(
    names.map((name) => ({ name, width: 800, height: 1200 })),
  )
}

describe('reference import', () => {
  it('pairs the sample by file name and attaches every pair in one call', async () => {
    const user = userEvent.setup()
    const raw = sampleMarks.map((mark, index) => labelled(`page-${index}`, sampleName('ja', mark)))
    install(raw)
    stage(...sampleMarks.map((mark) => sampleName('id', mark)))
    const attach = vi.spyOn(commands, 'attachReferences').mockResolvedValue(null)
    openDialog()

    await user.click(screen.getByRole('checkbox', { name: /Trim margins/ }))
    await user.click(screen.getByRole('button', { name: 'Choose files…' }))
    expect(commands.stageReferences).toHaveBeenCalledWith('files', true)
    expect(await screen.findByRole('status')).toHaveTextContent('11 of 11 pages get a reference')
    // The end of each long name, where its page mark is, is never cut off.
    const third = screen.getByRole('listitem', { name: `3. ${sampleName('ja', 'P01')}` })
    expect(within(third).getAllByText(/E33P01\.jpg$/)).toHaveLength(2)

    await user.click(screen.getByRole('button', { name: 'Attach 11 references' }))
    expect(attach).toHaveBeenCalledWith(
      raw.map((each, index) => ({ page: each.id, reference: index })),
      'id-ID',
    )
    await waitFor(() => expect(useKoharuStore.getState().referenceImport).toBe(false))
  })

  it('puts a reference on any page in one step, from its menu or by dragging it', async () => {
    const user = userEvent.setup()
    install(['one', 'two', 'three', 'four', 'five'].map((id) => page(id)))
    stage('scan.png')
    const attach = vi.spyOn(commands, 'attachReferences').mockResolvedValue(null)
    openDialog()

    await user.click(screen.getByRole('button', { name: 'Choose files…' }))
    const first = await screen.findByRole('listitem', { name: '1. one' })
    expect(within(first).getByText('scan.png')).toBeInTheDocument()
    await user.click(within(first).getByRole('button', { name: 'Pair with page…' }))
    await user.click(await screen.findByRole('menuitemradio', { name: '4. four' }))

    const fourth = screen.getByRole('listitem', { name: '4. four' })
    expect(within(fourth).getByText('scan.png')).toBeInTheDocument()
    expect(within(first).getByText('No reference')).toBeInTheDocument()

    const second = screen.getByRole('listitem', { name: '2. two' })
    const source = within(fourth).getByTitle('Drag onto a page to pair it there')
    fireEvent.dragStart(source)
    fireEvent.dragOver(second)
    expect(second).toHaveAttribute('data-drop', 'true')
    fireEvent.drop(second)
    fireEvent.dragEnd(source)
    expect(within(second).getByText('scan.png')).toBeInTheDocument()
    expect(within(fourth).getByText('No reference')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Attach 1 reference' }))
    expect(attach).toHaveBeenCalledWith([{ page: 'two', reference: 0 }], 'id-ID')
  })

  it('swaps references dragged between pages and unpairs one dropped on Not paired', async () => {
    const user = userEvent.setup()
    install([page('one'), page('two', english), page('three')])
    stage('a.png', 'b.png', 'c.png', 'd.png')
    openDialog()

    await user.click(screen.getByRole('button', { name: 'Choose files…' }))
    const first = await screen.findByRole('listitem', { name: '1. one' })
    const second = screen.getByRole('listitem', { name: '2. two' })
    const third = screen.getByRole('listitem', { name: '3. three' })
    expect(within(second).getByText('Replaces the current reference')).toBeInTheDocument()

    const dragged = within(first).getByTitle('Drag onto a page to pair it there')
    fireEvent.dragStart(dragged)
    fireEvent.dragOver(third)
    fireEvent.drop(third)
    fireEvent.dragEnd(dragged)
    expect(within(first).getByText('c.png')).toBeInTheDocument()
    expect(within(third).getByText('a.png')).toBeInTheDocument()

    const notPaired = screen.getByRole('group', { name: 'Not paired:' })
    expect(within(notPaired).getByText('d.png')).toBeInTheDocument()
    const back = within(second).getByTitle('Drag onto a page to pair it there')
    fireEvent.dragStart(back)
    fireEvent.dragOver(notPaired)
    fireEvent.drop(notPaired)
    fireEvent.dragEnd(back)
    expect(within(second).getByText('No reference')).toBeInTheDocument()
    expect(within(notPaired).getByText('b.png')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent(
      '2 of 3 pages get a reference · 2 references are not paired',
    )
  })

  it('unpairs one page in place and shifts only when asked, telling how many moved', async () => {
    const user = userEvent.setup()
    install([page('one'), page('two'), page('three')])
    stage('cover.jpg', 'p1.jpg', 'p2.jpg', 'p3.jpg')
    openDialog()

    await user.click(screen.getByRole('button', { name: 'Choose files…' }))
    const first = await screen.findByRole('listitem', { name: '1. one' })
    const second = screen.getByRole('listitem', { name: '2. two' })
    const third = screen.getByRole('listitem', { name: '3. three' })
    const references = () =>
      [first, second, third].map((row) => within(row).queryByText(/\.jpg$/)?.textContent ?? 'none')
    expect(references()).toEqual(['cover.jpg', 'p1.jpg', 'p2.jpg'])

    await user.click(within(first).getByRole('button', { name: 'Shift' }))
    await user.click(await screen.findByRole('menuitem', { name: /^Skip and shift up/ }))
    expect(references()).toEqual(['p1.jpg', 'p2.jpg', 'p3.jpg'])
    expect(screen.getByText('3 pairs shifted')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Undo' }))
    expect(references()).toEqual(['cover.jpg', 'p1.jpg', 'p2.jpg'])
    expect(screen.queryByText(/pairs? shifted/)).not.toBeInTheDocument()

    await user.click(within(second).getByRole('button', { name: 'Unpair' }))
    expect(references()).toEqual(['cover.jpg', 'none', 'p2.jpg'])
    expect(screen.queryByText(/pairs? shifted/)).not.toBeInTheDocument()

    await user.click(within(first).getByRole('button', { name: 'Shift' }))
    await user.click(await screen.findByRole('menuitem', { name: /^Empty here and shift down/ }))
    expect(references()).toEqual(['none', 'cover.jpg', 'none'])
    expect(screen.getByText('2 pairs shifted')).toBeInTheDocument()
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

  it('adds or replaces the reference of one page from its menu', async () => {
    const user = userEvent.setup()
    install([page('one'), page('two', english)])
    useKoharuStore.setState({
      preferences: {
        languages: [
          { tag: 'en-US', name: 'English' },
          { tag: 'id-ID', name: 'Indonesian' },
        ],
        pipeline: { translation: { target_language: 'id-ID' } },
      } as unknown as Preferences,
    })
    const attach = vi.spyOn(commands, 'attachReferenceFile').mockResolvedValue(true)
    vi.spyOn(commands, 'getPages').mockResolvedValue([
      page('one', { ...english, language: 'id-ID' }),
      page('two', english),
    ])
    const notice = vi.spyOn(toast, 'add')
    render(
      <QueryClientProvider client={queryClient}>
        <PageRail />
        <ReferenceFileDialog />
      </QueryClientProvider>,
    )

    await user.click(screen.getByRole('button', { name: 'Actions for one' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Add reference…' }))
    let dialog = await screen.findByRole('dialog', { name: 'Add reference' })
    // A new reference is taken to be in the target language.
    expect(within(dialog).getByRole('combobox', { name: 'Reference language' })).toHaveTextContent(
      'Indonesian',
    )
    // Dismissing the file dialog keeps this one open for another try.
    attach.mockResolvedValueOnce(false)
    await user.click(within(dialog).getByRole('button', { name: 'Choose image…' }))
    expect(attach).toHaveBeenLastCalledWith('one', 'id-ID', false)
    expect(screen.getByRole('dialog', { name: 'Add reference' })).toBeInTheDocument()
    await user.click(within(dialog).getByRole('checkbox', { name: /Trim margins/ }))
    await user.click(within(dialog).getByRole('button', { name: 'Choose image…' }))
    expect(attach).toHaveBeenLastCalledWith('one', 'id-ID', true)
    await waitFor(() =>
      expect(notice).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Added a reference to 1. one' }),
      ),
    )
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    // A replaced reference keeps the language of the one it replaces.
    await user.click(screen.getByRole('button', { name: 'Actions for two' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Replace reference…' }))
    dialog = await screen.findByRole('dialog', { name: 'Replace reference' })
    expect(within(dialog).getByRole('combobox', { name: 'Reference language' })).toHaveTextContent(
      'English',
    )
    await user.click(within(dialog).getByRole('button', { name: 'Choose image…' }))
    expect(attach).toHaveBeenLastCalledWith('two', 'en-US', false)
    await waitFor(() =>
      expect(notice).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Replaced the reference of 2. two' }),
      ),
    )
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

  it('extracts text from the references of every selected page that has one', async () => {
    const user = userEvent.setup()
    install([page('one', english), page('two'), page('three', english)])
    useKoharuStore.setState({ selectedPages: ['one', 'two', 'three'] })
    const read = vi.spyOn(commands, 'readReferences').mockResolvedValue('job')
    render(
      <QueryClientProvider client={queryClient}>
        <PageRail />
      </QueryClientProvider>,
    )

    await user.click(screen.getByRole('button', { name: 'Actions for one' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Extract text from reference' }))

    await waitFor(() => expect(read).toHaveBeenCalledWith(['one', 'three']))
  })

  it('names the reading job and reports what it found when it finishes', () => {
    const add = vi.spyOn(toast, 'add')
    install([page('one', english)])
    const job = {
      id: 'job',
      kind: 'references' as const,
      state: 'running' as const,
      completed: 0,
      total: 1,
      page: 'one',
      stage: null,
      model: 'paddleocr-vl-1.6',
      error: null,
      summary: null,
    }
    act(() => receiveJob(job))
    render(
      <QueryClientProvider client={queryClient}>
        <ActivityCenter />
      </QueryClientProvider>,
    )
    expect(screen.getByText('Reading references')).toBeInTheDocument()
    expect(add).not.toHaveBeenCalled()

    act(() =>
      receiveJob({
        ...job,
        state: 'finished',
        completed: 1,
        summary: { kind: 'references', read: 5, unmatched: 1, unused: 0 },
      }),
    )
    expect(add).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Extracted text from references',
        description:
          '5 text areas got text from their reference. 1 found no match; it shows that in the Inspector.',
      }),
    )
  })
})
