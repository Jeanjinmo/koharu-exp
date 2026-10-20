import { QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { PageRail } from '@/components/editor/PageRail'
import { pageKey, pagesKey, projectKey, queryClient } from '@/lib/queries'
import { useKoharuStore } from '@/lib/store'
import { commands, type PageStatus, type PageSummary } from '@koharu/bridge/protocol'

function page(id: string, label: string, status: PageStatus): PageSummary {
  return {
    id,
    label,
    size: { width: 1000, height: 1500 },
    source_asset: null,
    layer_count: 0,
    status,
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
})
