import { QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { CanvasWorkspace } from '@/components/editor/CanvasWorkspace'
import { pageKey, pagesKey, projectKey, queryClient } from '@/lib/queries'
import { useKoharuStore } from '@/lib/store'
import {
  commands,
  type PageReferenceSummary,
  type PageSummary,
  type ReferencePlacement,
} from '@koharu/bridge/protocol'
import { TooltipProvider } from '@koharu/ui/components/tooltip'

const canvas = vi.hoisted(() => ({
  resize: vi.fn(),
  setView: vi.fn(),
  clear: vi.fn(),
  previewOpacity: vi.fn(),
  cancelTransform: vi.fn(),
  cancelStroke: vi.fn(),
  dispose: vi.fn(),
}))

vi.mock('@/components/editor/useCanvas', () => ({
  useCanvas: () => ({
    canvas,
    error: null,
    generation: 1,
    hasFrame: true,
    retry: vi.fn(),
    status: 'ready',
  }),
}))
vi.mock('@koharu/bridge/canvas', () => ({
  prefetchCanvasPages: vi.fn(async () => []),
  workspaceColor: () => [245, 245, 245],
}))

const shifted: ReferencePlacement = { x: 0.1, y: 0, width: 0.8, height: 1 }

function reference(placement: ReferencePlacement): PageReferenceSummary {
  return { asset: `reference-${placement.x}`, language: 'en-US', placement }
}

function summary(id: string, referenced: PageReferenceSummary | null): PageSummary {
  return {
    id,
    label: id,
    size: { width: 1000, height: 1500 },
    source_asset: `source-${id}`,
    layer_count: 1,
    status: 'not_started',
    reference: referenced,
  }
}

function show(page: string) {
  act(() => {
    queryClient.setQueryData(projectKey, {
      name: 'Book',
      revision: 1,
      active_page: page,
      can_undo: false,
      can_redo: false,
    })
    queryClient.setQueryData(pageKey, {
      id: page,
      label: page,
      size: { width: 1000, height: 1500 },
      layers: [],
      regions: [],
    })
    useKoharuStore.setState({ canvasPage: page })
  })
}

beforeEach(() => {
  queryClient.setQueryData(pagesKey, [
    summary('one', reference(shifted)),
    summary('two', null),
    summary('three', reference({ x: 0, y: 0, width: 1, height: 1 })),
  ])
  useKoharuStore.setState({
    canvasRevision: 1,
    canvasGeneration: 1,
    canvasSize: [1000, 1500],
    tracing: null,
  })
  useKoharuStore.getState().setCompareOpen(false)
  useKoharuStore.getState().setCompareSubject('reference')
  vi.spyOn(commands, 'getPageImage').mockResolvedValue([1, 2, 3])
  vi.spyOn(commands, 'getPages').mockImplementation(
    async () => queryClient.getQueryData<PageSummary[]>(pagesKey) ?? [],
  )
  vi.spyOn(commands, 'getProject').mockResolvedValue(null)
})

function renderEditor() {
  show('one')
  render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <CanvasWorkspace />
      </TooltipProvider>
    </QueryClientProvider>,
  )
  act(() => useKoharuStore.setState({ camera: { zoom: 2, translation: [40, 60], fitted: false } }))
}

describe('references in Compare', () => {
  it('compares with the placed reference and can switch to the original', async () => {
    const user = userEvent.setup()
    useKoharuStore.getState().setCompareMode('side_by_side')
    renderEditor()

    await user.click(screen.getByRole('button', { name: 'Compare' }))
    const shown = await screen.findByRole('img', { name: 'Reference' })
    expect(commands.getPageImage).toHaveBeenCalledWith('one', 'reference')
    expect(shown).toHaveStyle({
      width: '800px',
      transform: 'translate(240px, 60px) scale(2)',
    })

    await user.click(screen.getByRole('button', { name: 'Compare mode' }))
    await user.click(await screen.findByRole('menuitemradio', { name: 'Original' }))
    expect(await screen.findByRole('img', { name: 'Original' })).toBeInTheDocument()
    expect(commands.getPageImage).toHaveBeenCalledWith('one', 'source')
  })

  it('loads no image while Compare is closed', () => {
    renderEditor()
    expect(commands.getPageImage).not.toHaveBeenCalled()
  })
})

describe('aligning a reference', () => {
  it('moves the reference by dragging and nudging, then saves it for the page', async () => {
    const user = userEvent.setup()
    const save = vi.spyOn(commands, 'setReferencePlacement').mockResolvedValue(null)
    renderEditor()

    await user.click(screen.getByRole('button', { name: 'Compare mode' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Align reference…' }))
    const surface = screen.getByRole('application', { name: 'Reference alignment' })
    expect(await screen.findByRole('img', { name: 'Reference' })).toBeInTheDocument()

    fireEvent.pointerDown(surface, { pointerId: 1, button: 0, clientX: 100, clientY: 100 })
    fireEvent.pointerMove(surface, { pointerId: 1, clientX: 120, clientY: 100 })
    fireEvent.pointerUp(surface, { pointerId: 1, clientX: 120, clientY: 100 })
    fireEvent.keyDown(surface, { key: 'ArrowDown', shiftKey: true })

    const moved = useKoharuStore.getState().tracing!.placement!
    expect(moved.x).toBeCloseTo(0.11)
    expect(moved.y).toBeCloseTo(10 / 1500)
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(save).toHaveBeenCalledWith(['one'], moved)
    await waitFor(() => expect(useKoharuStore.getState().tracing).toBeNull())
  })

  it('applies one alignment to the following pages that have a reference', async () => {
    const user = userEvent.setup()
    const save = vi.spyOn(commands, 'setReferencePlacement').mockResolvedValue(null)
    renderEditor()
    act(() => useKoharuStore.getState().startTracing('one', shifted))

    await user.click(await screen.findByRole('button', { name: 'Fit to page' }))
    await user.click(screen.getByRole('button', { name: 'Apply to following pages' }))

    expect(save).toHaveBeenCalledWith(['one', 'three'], { x: 0, y: 0, width: 1, height: 1 })
  })

  it('saves a changed alignment when another page is shown', async () => {
    const save = vi.spyOn(commands, 'setReferencePlacement').mockResolvedValue(null)
    renderEditor()
    act(() => useKoharuStore.getState().startTracing('one', shifted))
    act(() => useKoharuStore.getState().moveTracing({ ...shifted, x: 0.2 }))

    show('three')

    await waitFor(() => expect(save).toHaveBeenCalledWith(['one'], { ...shifted, x: 0.2 }))
    expect(useKoharuStore.getState().tracing).toMatchObject({
      page: 'three',
      placement: { x: 0, y: 0, width: 1, height: 1 },
      changed: false,
    })
  })
})
