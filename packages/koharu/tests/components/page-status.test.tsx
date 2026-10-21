import { QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { PageRail } from '@/components/editor/PageRail'
import { pageKey, pagesKey, projectKey, queryClient } from '@/lib/queries'
import { useKoharuStore } from '@/lib/store'
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
