import { QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { PageRail } from '@/components/editor/PageRail'
import { pageKey, pagesKey, projectKey, queryClient } from '@/lib/queries'
import { useKoharuStore } from '@/lib/store'
import { dragOnto, place } from '@/tests/pointer'
import { commands, type PageStatus, type PageSummary } from '@koharu/bridge/protocol'

// Clicking a page shows it on the canvas, which finishes a frame later.
vi.mock('@koharu/bridge/canvas', () => ({
  showCanvasPage: () => true,
  prefetchCanvasPages: vi.fn(async () => []),
}))

function page(id: string, label: string, status: PageStatus): PageSummary {
  return {
    id,
    label,
    size: { width: 1000, height: 1500 },
    source_asset: null,
    layer_count: 0,
    status,
    reference: null,
  }
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

describe('page status', () => {
  it('shows a badge for pages that have started', () => {
    install([
      page('page-1', 'Page 1', 'not_started'),
      page('page-2', 'Page 2', 'translated_by_agent'),
      page('page-3', 'Page 3', 'done'),
    ])
    render(
      <QueryClientProvider client={queryClient}>
        <PageRail />
      </QueryClientProvider>,
    )

    expect(screen.queryByText('Not started')).not.toBeInTheDocument()
    expect(screen.getByText('Translated by agent')).toBeInTheDocument()
    expect(screen.getByText('Done')).toBeInTheDocument()
  })

  it('sets the status of every selected page from one page menu', async () => {
    const user = userEvent.setup()
    install([page('page-1', 'Page 1', 'not_started'), page('page-2', 'Page 2', 'not_started')])
    useKoharuStore.setState({ selectedPages: ['page-1', 'page-2'] })
    const setStatus = vi.spyOn(commands, 'setPageStatus').mockResolvedValue(null)
    vi.spyOn(commands, 'getPages').mockResolvedValue([])
    vi.spyOn(commands, 'getProject').mockResolvedValue(null)
    render(
      <QueryClientProvider client={queryClient}>
        <PageRail />
      </QueryClientProvider>,
    )

    await user.click(screen.getByRole('button', { name: 'Actions for Page 2' }))
    await user.click(await screen.findByRole('menuitemradio', { name: 'Needs review' }))

    await waitFor(() =>
      expect(setStatus).toHaveBeenCalledWith(['page-1', 'page-2'], 'needs_review'),
    )
  })

  it('keeps every Ctrl+clicked page selected and sets their status in one step (#16)', async () => {
    const user = userEvent.setup()
    const pages = [
      page('page-1', 'Page 1', 'not_started'),
      page('page-2', 'Page 2', 'done'),
      page('page-3', 'Page 3', 'not_started'),
    ]
    install(pages)
    useKoharuStore.setState({ selectedPages: ['page-1'] })
    const setStatus = vi.spyOn(commands, 'setPageStatus').mockResolvedValue(null)
    vi.spyOn(commands, 'getPages').mockResolvedValue(pages)
    vi.spyOn(commands, 'getProject').mockResolvedValue(null)
    const selectPage = vi.spyOn(commands, 'selectPage').mockImplementation(
      async (id) =>
        ({
          project: {
            name: 'Book',
            revision: 1,
            active_page: id,
            can_undo: false,
            can_redo: false,
          },
          page: { id, label: id, size: pages[0].size, layers: [], regions: [] },
        }) as never,
    )
    render(
      <QueryClientProvider client={queryClient}>
        <PageRail />
      </QueryClientProvider>,
    )

    // Two Ctrl+clicks before the first page has been shown.
    fireEvent.click(screen.getByText('Page 2'), { ctrlKey: true })
    fireEvent.click(screen.getByText('Page 3'), { ctrlKey: true })
    expect(useKoharuStore.getState().selectedPages).toEqual(['page-1', 'page-2', 'page-3'])
    await waitFor(() => expect(selectPage).toHaveBeenCalledWith('page-3'))

    await user.click(screen.getByRole('button', { name: 'Actions for Page 2' }))
    await user.click(await screen.findByRole('menuitemradio', { name: 'Needs review' }))
    await waitFor(() =>
      expect(setStatus).toHaveBeenCalledExactlyOnceWith(
        ['page-1', 'page-2', 'page-3'],
        'needs_review',
      ),
    )
    // Choosing in a page's menu is not a click on the page.
    expect(useKoharuStore.getState().selectedPages).toEqual(['page-1', 'page-2', 'page-3'])

    // Ctrl+clicking a selected page takes it out without showing it.
    selectPage.mockClear()
    act(() => {
      fireEvent.click(screen.getByText('Page 2'), { ctrlKey: true })
    })
    expect(useKoharuStore.getState().selectedPages).toEqual(['page-1', 'page-3'])
    expect(selectPage).not.toHaveBeenCalled()
  })
})

describe('reordering pages', () => {
  const pages = [1, 2, 3, 4, 5].map((number) =>
    page(`page-${number}`, `Page ${number}`, 'not_started'),
  )

  function renderRail() {
    install(pages)
    vi.spyOn(commands, 'getPages').mockResolvedValue(pages)
    vi.spyOn(commands, 'getProject').mockResolvedValue(null)
    render(
      <QueryClientProvider client={queryClient}>
        <PageRail />
      </QueryClientProvider>,
    )
  }

  const card = (label: string) => screen.getByText(label).closest('article')!

  it('moves a page dropped below or above another in one step each', async () => {
    const move = vi.spyOn(commands, 'movePage').mockResolvedValue(null)
    renderRail()

    dragOnto(card('Page 3'), card('Page 4'), { after: true })
    expect(move).toHaveBeenCalledExactlyOnceWith('page-3', 3)
    // The release that ends a drag is no click on the page.
    expect(useKoharuStore.getState().selectedPages).toEqual([])

    move.mockClear()
    dragOnto(card('Page 3'), card('Page 2'))
    expect(move).toHaveBeenCalledExactlyOnceWith('page-3', 1)

    // Just above the page below, or just below the one above, is where it is.
    move.mockClear()
    dragOnto(card('Page 3'), card('Page 4'))
    dragOnto(card('Page 3'), card('Page 2'), { after: true })
    expect(move).not.toHaveBeenCalled()
    await waitFor(() => expect(commands.getPages).toHaveBeenCalled())
  })

  it('shows where the page would go, and a press that does not move still selects', () => {
    const move = vi.spyOn(commands, 'movePage').mockResolvedValue(null)
    renderRail()
    const third = card('Page 3')
    const fifth = card('Page 5')
    place(fifth, { x: 0, y: 200, width: 240, height: 72 })
    vi.spyOn(document, 'elementFromPoint').mockReturnValue(fifth)

    fireEvent.pointerDown(third, { pointerId: 1, button: 0, clientX: 40, clientY: 30 })
    fireEvent.pointerMove(third, { pointerId: 1, clientX: 42, clientY: 32 })
    expect(screen.queryByTestId('page-drop-line')).not.toBeInTheDocument()
    fireEvent.pointerMove(third, { pointerId: 1, clientX: 40, clientY: 250 })
    expect(fifth).toContainElement(screen.getByTestId('page-drop-line'))
    expect(third).toHaveClass('opacity-50')
    fireEvent.pointerCancel(third, { pointerId: 1 })
    expect(screen.queryByTestId('page-drop-line')).not.toBeInTheDocument()

    fireEvent.pointerDown(third, { pointerId: 2, button: 0, clientX: 40, clientY: 30 })
    fireEvent.pointerMove(third, { pointerId: 2, clientX: 42, clientY: 31 })
    fireEvent.pointerUp(third, { pointerId: 2, button: 0, clientX: 42, clientY: 31 })
    fireEvent.click(third, { clientX: 42, clientY: 31 })
    fireEvent.pointerDown(fifth, { pointerId: 3, button: 0, clientX: 40, clientY: 230 })
    fireEvent.pointerUp(fifth, { pointerId: 3, button: 0, clientX: 40, clientY: 230 })
    fireEvent.click(fifth, { ctrlKey: true, clientX: 40, clientY: 230 })
    expect(useKoharuStore.getState().selectedPages).toEqual(['page-3', 'page-5'])
    expect(move).not.toHaveBeenCalled()
  })

  it('scrolls the list while a page is held near its bottom edge', async () => {
    renderRail()
    const viewport = document.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]')!
    place(viewport, { x: 0, y: 0, width: 240, height: 600 })
    const third = card('Page 3')

    fireEvent.pointerDown(third, { pointerId: 1, button: 0, clientX: 40, clientY: 200 })
    fireEvent.pointerMove(third, { pointerId: 1, clientX: 40, clientY: 590 })
    await waitFor(() => expect(viewport.scrollTop).toBeGreaterThan(0))
    fireEvent.pointerUp(third, { pointerId: 1, button: 0, clientX: 40, clientY: 590 })
    const stopped = viewport.scrollTop
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(viewport.scrollTop).toBe(stopped)
  })
})
