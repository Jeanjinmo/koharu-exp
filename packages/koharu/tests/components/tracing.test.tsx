import { QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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
import { toast } from '@koharu/ui/components/toast'
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
  window.localStorage.clear()
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
    referencePick: null,
    tool: 'select',
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
    await user.click(screen.getByRole('button', { name: 'Save (this page)' }))

    expect(save).toHaveBeenCalledWith(['one'], moved)
    await waitFor(() => expect(useKoharuStore.getState().tracing).toBeNull())
  })

  it('names how far each save reaches and always reports it', async () => {
    const user = userEvent.setup()
    const save = vi.spyOn(commands, 'setReferencePlacement').mockResolvedValue(null)
    const notice = vi.spyOn(toast, 'add')
    renderEditor()
    act(() => useKoharuStore.getState().startTracing('one', shifted))

    // Saving an unchanged alignment has nothing to write, but still says so.
    await user.click(await screen.findByRole('button', { name: 'Save (this page)' }))
    expect(save).not.toHaveBeenCalled()
    expect(notice).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Alignment saved for one' }),
    )

    // Page two has no reference, so only page three follows.
    act(() => useKoharuStore.getState().startTracing('one', shifted))
    const fit = await screen.findByRole('button', { name: 'Fit to page' })
    expect(fit).toHaveAttribute('title', 'Reset to the page size and position')
    await user.click(fit)
    await user.click(screen.getByRole('button', { name: 'Save for this and 1 following page' }))

    expect(save).toHaveBeenCalledWith(['one', 'three'], { x: 0, y: 0, width: 1, height: 1 })
    await waitFor(() =>
      expect(notice).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Alignment saved for 2 pages' }),
      ),
    )
  })

  it('shows the reference opacity and resets it to half', async () => {
    const user = userEvent.setup()
    renderEditor()
    act(() => useKoharuStore.getState().startTracing('one', shifted))
    const opacity = await screen.findByRole('slider', { name: 'Reference opacity' })
    const reset = screen.getByRole('button', { name: 'Reset opacity to 50%' })
    expect(screen.getByText('50%')).toBeInTheDocument()
    expect(reset).toBeDisabled()

    fireEvent.change(opacity, { target: { value: '70' } })
    expect(screen.getByText('70%')).toBeInTheDocument()
    await user.click(reset)
    expect(useKoharuStore.getState().tracing!.opacity).toBe(0.5)

    fireEvent.change(opacity, { target: { value: '30' } })
    fireEvent.doubleClick(opacity)
    expect(useKoharuStore.getState().tracing!.opacity).toBe(0.5)
    expect(screen.getByText('50%')).toBeInTheDocument()
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

describe('aligning safely', () => {
  it('keeps aligning through tool keys, toolbar clicks, and deleting, and undoes its own moves', async () => {
    const undo = vi.spyOn(commands, 'undo').mockResolvedValue(null)
    const redo = vi.spyOn(commands, 'redo').mockResolvedValue(null)
    const deleteLayers = vi.spyOn(commands, 'deleteLayers').mockResolvedValue(null)
    renderEditor()
    act(() => {
      useKoharuStore.setState({ tool: 'select', selectedLayers: ['element'] })
      useKoharuStore.getState().startTracing('one', shifted)
    })
    const surface = await screen.findByRole('application', { name: 'Reference alignment' })

    // One drag, however many moves it takes, then one nudge.
    fireEvent.pointerDown(surface, { pointerId: 1, button: 0, clientX: 100, clientY: 100 })
    fireEvent.pointerMove(surface, { pointerId: 1, clientX: 110, clientY: 100 })
    fireEvent.pointerMove(surface, { pointerId: 1, clientX: 120, clientY: 100 })
    fireEvent.pointerUp(surface, { pointerId: 1, clientX: 120, clientY: 100 })
    const dragged = useKoharuStore.getState().tracing!.placement!
    fireEvent.keyDown(surface, { key: 'ArrowDown' })

    fireEvent.keyDown(surface, { key: 't' })
    fireEvent.keyDown(surface, { key: 'Delete' })
    const text = screen.getByRole('button', { name: 'Text' })
    expect(text).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(text)
    expect(useKoharuStore.getState().tool).toBe('select')
    expect(deleteLayers).not.toHaveBeenCalled()

    fireEvent.keyDown(surface, { key: 'z', ctrlKey: true })
    expect(useKoharuStore.getState().tracing!.placement).toEqual(dragged)
    fireEvent.keyDown(surface, { key: 'z', ctrlKey: true })
    expect(useKoharuStore.getState().tracing).toMatchObject({ placement: shifted, changed: false })
    fireEvent.keyDown(surface, { key: 'z', ctrlKey: true, shiftKey: true })
    expect(useKoharuStore.getState().tracing).toMatchObject({ placement: dragged, changed: true })
    expect(undo).not.toHaveBeenCalled()
    expect(redo).not.toHaveBeenCalled()
  })

  it('counts typing one value into a field as one undo step', async () => {
    renderEditor()
    act(() => useKoharuStore.getState().startTracing('one', shifted))
    const x = await screen.findByRole('spinbutton', { name: 'X' })
    fireEvent.change(x, { target: { value: '1' } })
    fireEvent.change(x, { target: { value: '12' } })
    fireEvent.change(x, { target: { value: '120' } })
    fireEvent.blur(x)
    expect(useKoharuStore.getState().tracing!.placement!.x).toBeCloseTo(0.12)
    expect(useKoharuStore.getState().tool).toBe('select')

    act(() => useKoharuStore.getState().undoTracing())
    expect(useKoharuStore.getState().tracing!.placement).toEqual(shifted)
  })

  it('asks whether to save before Escape, Close, or Compare end an unsaved alignment', async () => {
    const user = userEvent.setup()
    const save = vi.spyOn(commands, 'setReferencePlacement').mockResolvedValue(null)
    renderEditor()
    act(() => {
      useKoharuStore.getState().startTracing('one', shifted)
      useKoharuStore.getState().moveTracing({ ...shifted, x: 0.2 })
    })
    const surface = await screen.findByRole('application', { name: 'Reference alignment' })

    fireEvent.keyDown(surface, { key: 'Escape' })
    let asked = await screen.findByRole('alertdialog', { name: 'Save this alignment?' })
    await user.click(within(asked).getByRole('button', { name: 'Keep aligning' }))
    expect(useKoharuStore.getState().tracing).toMatchObject({ placement: { x: 0.2 } })

    await user.click(screen.getByRole('button', { name: 'Compare' }))
    asked = await screen.findByRole('alertdialog', { name: 'Save this alignment?' })
    expect(useKoharuStore.getState().compare.open).toBe(false)
    await user.click(within(asked).getByRole('button', { name: 'Save' }))
    expect(save).toHaveBeenCalledWith(['one'], { ...shifted, x: 0.2 })
    await waitFor(() => expect(useKoharuStore.getState().compare.open).toBe(true))
    expect(useKoharuStore.getState().tracing).toBeNull()
  })

  it('discards when told to, and leaves an unchanged alignment without asking', async () => {
    const user = userEvent.setup()
    const save = vi.spyOn(commands, 'setReferencePlacement').mockResolvedValue(null)
    renderEditor()
    act(() => {
      useKoharuStore.getState().startTracing('one', shifted)
      useKoharuStore.getState().moveTracing({ ...shifted, x: 0.2 })
    })

    await user.click(await screen.findByRole('button', { name: 'Close alignment' }))
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Discard' }),
    )
    expect(useKoharuStore.getState().tracing).toBeNull()

    act(() => useKoharuStore.getState().startTracing('one', shifted))
    await user.click(await screen.findByRole('button', { name: 'Close alignment' }))
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(useKoharuStore.getState().tracing).toBeNull()
    expect(save).not.toHaveBeenCalled()
  })

  it('folds the panel to its title bar and moves it by the title, keeping the alignment', async () => {
    const user = userEvent.setup()
    renderEditor()
    act(() => {
      useKoharuStore.getState().startTracing('one', shifted)
      useKoharuStore.getState().moveTracing({ ...shifted, x: 0.2 })
    })
    const panel = await screen.findByRole('region', { name: 'Align reference' })

    await user.click(within(panel).getByRole('button', { name: 'Collapse Align reference' }))
    expect(within(panel).queryByRole('spinbutton', { name: 'X' })).not.toBeInTheDocument()
    await user.click(within(panel).getByRole('button', { name: 'Expand Align reference' }))
    expect(within(panel).getByRole('spinbutton', { name: 'X' })).toBeInTheDocument()

    Object.defineProperty(panel.parentElement!, 'getBoundingClientRect', {
      value: () => ({ x: 0, y: 0, left: 0, top: 0, width: 800, height: 600 }),
    })
    Object.defineProperty(panel, 'getBoundingClientRect', {
      value: () => ({ x: 112, y: 8, left: 112, top: 8, width: 576, height: 180 }),
    })
    const title = within(panel).getByRole('heading', { name: /^Align reference/ })
    fireEvent.pointerDown(title, { button: 0, pointerId: 3, clientX: 300, clientY: 20 })
    fireEvent.pointerMove(title, { pointerId: 3, clientX: 250, clientY: 320 })
    fireEvent.pointerUp(title, { pointerId: 3, clientX: 250, clientY: 320 })
    expect(panel).toHaveStyle({ left: '62px', top: '308px' })
    expect(useKoharuStore.getState().tracing).toMatchObject({
      placement: { x: 0.2 },
      changed: true,
    })
  })

  it('outlines the reference and shows it plainly, as a difference, or in color', async () => {
    const user = userEvent.setup()
    renderEditor()
    act(() => useKoharuStore.getState().startTracing('one', shifted))
    const reference = await screen.findByRole('img', { name: 'Reference' })
    const original = screen.getByRole('img', { name: 'Original' })

    // The camera is zoomed twice and moved by (40, 60) device pixels.
    const outline = screen.getByTestId('reference-outline')
    expect(outline).toHaveStyle({ left: '240px', top: '60px', width: '1600px', height: '3000px' })
    expect(outline).toHaveTextContent('Reference')
    expect(reference).toHaveStyle({ opacity: '0.5' })

    const panel = screen.getByRole('region', { name: 'Align reference' })
    await user.click(within(panel).getByRole('button', { name: 'Difference' }))
    expect(reference).toHaveStyle({ mixBlendMode: 'difference', opacity: '1' })
    expect(within(panel).getByRole('slider', { name: 'Reference opacity' })).toBeDisabled()

    await user.click(within(panel).getByRole('button', { name: 'Tint' }))
    expect(reference).toHaveStyle({ mixBlendMode: 'multiply', opacity: '1' })
    expect(reference.style.filter).toMatch(/-reference/)
    expect(original.style.filter).toMatch(/-original/)
    expect(within(panel).getByRole('button', { name: 'Tint' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
  })

  it('blinks between the original and the reference while the Compare key is held', async () => {
    renderEditor()
    act(() => useKoharuStore.getState().startTracing('one', shifted))
    const surface = await screen.findByRole('application', { name: 'Reference alignment' })
    await screen.findByRole('img', { name: 'Reference' })
    vi.useFakeTimers()
    try {
      fireEvent.keyDown(surface, { key: 'c' })
      expect(screen.getByRole('img', { name: 'Reference' })).toHaveStyle({ opacity: '1' })
      act(() => vi.advanceTimersByTime(350))
      expect(screen.queryByRole('img', { name: 'Reference' })).not.toBeInTheDocument()
      expect(screen.getByRole('img', { name: 'Original' })).toBeInTheDocument()
      act(() => vi.advanceTimersByTime(350))
      expect(screen.getByRole('img', { name: 'Reference' })).toBeInTheDocument()

      fireEvent.keyUp(surface, { key: 'c' })
      act(() => vi.advanceTimersByTime(700))
      expect(screen.getByRole('img', { name: 'Reference' })).toHaveStyle({ opacity: '0.5' })
      // The Compare key blinks instead of leaving the alignment.
      expect(useKoharuStore.getState().tracing).toMatchObject({ page: 'one', blinking: false })
    } finally {
      vi.useRealTimers()
    }
  })

  it('zooms to a box drawn with Ctrl+drag while a plain drag still moves the reference', async () => {
    renderEditor()
    act(() => useKoharuStore.getState().startTracing('one', shifted))
    const surface = await screen.findByRole('application', { name: 'Reference alignment' })
    Object.defineProperty(surface, 'getBoundingClientRect', {
      value: () => ({ x: 0, y: 0, width: 800, height: 600 }),
    })

    fireEvent.pointerDown(surface, {
      button: 0,
      ctrlKey: true,
      pointerId: 1,
      clientX: 100,
      clientY: 100,
    })
    fireEvent.pointerMove(surface, { ctrlKey: true, pointerId: 1, clientX: 300, clientY: 250 })
    fireEvent.pointerUp(surface, { ctrlKey: true, pointerId: 1, clientX: 300, clientY: 250 })

    // Zoom 2 at (40, 60) becomes 8, with page (80, 57.5) in the middle.
    expect(useKoharuStore.getState().camera).toEqual({
      zoom: 8,
      translation: [-240, -160],
      fitted: false,
    })
    expect(useKoharuStore.getState().tracing).toMatchObject({ placement: shifted, changed: false })
  })

  it('keeps the session when Align reference is chosen again', async () => {
    const user = userEvent.setup()
    renderEditor()
    act(() => {
      useKoharuStore.getState().startTracing('one', shifted)
      useKoharuStore.getState().moveTracing({ ...shifted, x: 0.2 })
    })
    await user.click(screen.getByRole('button', { name: 'Compare mode' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Align reference…' }))
    expect(useKoharuStore.getState().tracing).toMatchObject({
      placement: { x: 0.2 },
      changed: true,
    })
  })
})

describe('reading text from a picked area of the reference', () => {
  it('reads the box dragged over the reference into the element, in page pixels', async () => {
    const read = vi.spyOn(commands, 'readReferenceArea').mockResolvedValue(null)
    renderEditor()
    act(() => {
      queryClient.setQueryData(pageKey, {
        id: 'one',
        label: 'one',
        size: { width: 1000, height: 1500 },
        layers: [
          {
            type: 'raster',
            id: 'element',
            parent: null,
            visibility: { visible: true, opacity: 1 },
            image: null,
            name: 'Text',
            kind: 'cleanup',
          },
        ],
        regions: [],
      })
      useKoharuStore.getState().setReferencePick('element')
    })

    const surface = await screen.findByRole('application', { name: 'Reference text picker' })
    expect(await screen.findByRole('img', { name: 'Reference' })).toBeInTheDocument()
    fireEvent.pointerDown(surface, { pointerId: 1, button: 0, clientX: 100, clientY: 100 })
    fireEvent.pointerMove(surface, { pointerId: 1, clientX: 200, clientY: 160 })
    expect(screen.getByTestId('reference-pick-box')).toHaveStyle({ width: '100px', height: '60px' })
    fireEvent.pointerUp(surface, { pointerId: 1, clientX: 200, clientY: 160 })

    // The camera is zoomed twice and moved by (40, 60) device pixels.
    expect(read).toHaveBeenCalledWith('element', { x: 30, y: 20, width: 50, height: 30 })
    await waitFor(() => expect(useKoharuStore.getState().referencePick).toBeNull())
  })

  it('ignores stray clicks and closes with Escape', async () => {
    const read = vi.spyOn(commands, 'readReferenceArea').mockResolvedValue(null)
    renderEditor()
    act(() => {
      queryClient.setQueryData(pageKey, {
        id: 'one',
        label: 'one',
        size: { width: 1000, height: 1500 },
        layers: [
          {
            type: 'raster',
            id: 'element',
            parent: null,
            visibility: { visible: true, opacity: 1 },
            image: null,
            name: 'Text',
            kind: 'cleanup',
          },
        ],
        regions: [],
      })
      useKoharuStore.getState().setReferencePick('element')
    })

    const surface = await screen.findByRole('application', { name: 'Reference text picker' })
    fireEvent.pointerDown(surface, { pointerId: 1, button: 0, clientX: 100, clientY: 100 })
    fireEvent.pointerUp(surface, { pointerId: 1, clientX: 102, clientY: 101 })
    expect(read).not.toHaveBeenCalled()
    fireEvent.keyDown(surface, { key: 'Escape' })
    expect(useKoharuStore.getState().referencePick).toBeNull()
  })
})
