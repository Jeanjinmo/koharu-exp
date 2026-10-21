import { QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { CanvasWorkspace } from '@/components/editor/CanvasWorkspace'
import { pageKey, pagesKey, projectKey, queryClient } from '@/lib/queries'
import { useKoharuStore } from '@/lib/store'
import { commands } from '@koharu/bridge/protocol'
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

const camera = { zoom: 2, translation: [40, 60] as [number, number], fitted: false }

beforeEach(() => {
  queryClient.setQueryData(projectKey, {
    name: 'Book',
    revision: 1,
    active_page: 'page',
    can_undo: false,
    can_redo: false,
  })
  queryClient.setQueryData(pagesKey, [
    {
      id: 'page',
      label: 'Page',
      size: { width: 1000, height: 1500 },
      source_asset: 'source-blob',
      layer_count: 1,
      status: 'not_started',
      reference: null,
    },
  ])
  queryClient.setQueryData(pageKey, {
    id: 'page',
    label: 'Page',
    size: { width: 1000, height: 1500 },
    layers: [],
    regions: [],
  })
  useKoharuStore.setState({
    canvasPage: 'page',
    canvasRevision: 1,
    canvasGeneration: 1,
    canvasSize: [1000, 1500],
  })
  vi.spyOn(commands, 'getPageImage').mockResolvedValue([1, 2, 3])
})

function renderWorkspace() {
  render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <CanvasWorkspace />
      </TooltipProvider>
    </QueryClientProvider>,
  )
  // The workspace fits the page when it mounts, so a manual camera comes after.
  act(() => useKoharuStore.setState({ camera }))
}

function pressCompare(type: 'keyDown' | 'keyUp' = 'keyDown') {
  act(() => {
    fireEvent[type](window, { key: 'c' })
  })
}

describe('compare', () => {
  it('shows the original beside the canvas with the same camera and restores the view', async () => {
    renderWorkspace()
    pressCompare()

    const original = await screen.findByRole('img', { name: 'Original' })
    expect(commands.getPageImage).toHaveBeenCalledWith('page', 'source')
    expect(original).toHaveStyle({
      width: '1000px',
      transform: 'translate(40px, 60px) scale(2)',
    })

    const pane = screen.getByRole('region', { name: 'Original' })
    Object.defineProperty(pane, 'getBoundingClientRect', {
      value: () => ({ x: 0, y: 0, width: 400, height: 600 }),
    })
    fireEvent.wheel(pane, { clientX: 100, clientY: 100, deltaY: 40 })
    const moved = useKoharuStore.getState().camera
    expect(moved.translation).not.toEqual(camera.translation)
    expect(original).toHaveStyle({
      transform: `translate(${moved.translation[0]}px, ${moved.translation[1]}px) scale(2)`,
    })

    pressCompare()
    expect(screen.queryByRole('region', { name: 'Original' })).not.toBeInTheDocument()
    expect(useKoharuStore.getState().camera).toEqual(camera)
  })

  it('zooms both halves to a box drawn with Ctrl+drag over the original', async () => {
    renderWorkspace()
    pressCompare()
    await screen.findByRole('img', { name: 'Original' })
    const pane = screen.getByRole('region', { name: 'Original' })
    Object.defineProperty(pane, 'getBoundingClientRect', {
      value: () => ({ x: 0, y: 0, width: 400, height: 600 }),
    })

    fireEvent.pointerDown(pane, {
      button: 0,
      ctrlKey: true,
      pointerId: 1,
      clientX: 50,
      clientY: 50,
    })
    fireEvent.pointerMove(pane, { ctrlKey: true, pointerId: 1, clientX: 150, clientY: 200 })
    expect(screen.getByTestId('zoom-box')).toHaveStyle({ width: '100px', height: '150px' })
    fireEvent.pointerUp(pane, { ctrlKey: true, pointerId: 1, clientX: 150, clientY: 200 })

    // Page (30, 32.5), the box's center, lands in the middle of the pane.
    expect(useKoharuStore.getState().camera).toEqual({
      zoom: 8,
      translation: [-40, 40],
      fitted: false,
    })
  })

  it('peeks at the original only while the shortcut is held and remembers the mode', async () => {
    useKoharuStore.getState().setCompareMode('peek')
    expect(window.localStorage.getItem('koharu.compare.mode')).toBe('peek')
    renderWorkspace()

    pressCompare()
    expect(await screen.findByRole('img', { name: 'Original' })).toBeInTheDocument()
    pressCompare('keyUp')
    expect(screen.queryByRole('img', { name: 'Original' })).not.toBeInTheDocument()
    expect(screen.getByText('Hold C to see the original')).toBeInTheDocument()
  })

  it('divides one page between the original and the result with a slider', async () => {
    useKoharuStore.getState().setCompareMode('slider')
    useKoharuStore.getState().setCompareOpen(true)
    renderWorkspace()

    const original = await screen.findByRole('img', { name: 'Original' })
    const clip = screen.getByTestId('compare-slider-clip')
    expect(clip).toContainElement(original)
    expect(clip).toHaveStyle({ clipPath: 'inset(0 50% 0 0)' })
    fireEvent.keyDown(screen.getByRole('slider', { name: 'Comparison divider' }), {
      key: 'ArrowRight',
    })
    await waitFor(() => expect(clip).toHaveStyle({ clipPath: 'inset(0 48% 0 0)' }))
  })

  it('turns on from the status bar and picks a mode there', async () => {
    const user = userEvent.setup()
    useKoharuStore.getState().setCompareMode('side_by_side')
    renderWorkspace()

    await user.click(screen.getByRole('button', { name: 'Compare' }))
    expect(useKoharuStore.getState().compare.open).toBe(true)
    await user.click(screen.getByRole('button', { name: 'Compare mode' }))
    await user.click(await screen.findByRole('menuitemradio', { name: 'Slider' }))

    expect(useKoharuStore.getState().compare).toMatchObject({ open: true, mode: 'slider' })
  })
})
