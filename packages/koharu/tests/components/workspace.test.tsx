import { QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CanvasWorkspace } from '@/components/editor/CanvasWorkspace'
import { pageKey, pagesKey, projectKey, queryClient } from '@/lib/queries'
import { receiveCanvas, useKoharuStore } from '@/lib/store'
import { commands, type Layer } from '@koharu/bridge/protocol'
import { TooltipProvider } from '@koharu/ui/components/tooltip'

const canvas = vi.hoisted(() => ({
  resize: vi.fn(),
  setView: vi.fn(),
  stageManifest: vi.fn(),
  installResource: vi.fn(),
  activateFrame: vi.fn(),
  activatePage: vi.fn(),
  clear: vi.fn(),
  previewOpacity: vi.fn(),
  beginTransform: vi.fn(),
  updateTransform: vi.fn(),
  finishTransform: vi.fn(),
  cancelTransform: vi.fn(),
  beginStroke: vi.fn(),
  extendStroke: vi.fn(),
  finishStroke: vi.fn(),
  cancelStroke: vi.fn(),
  sampleColor: vi.fn(),
  dispose: vi.fn(),
}))

const canvasState = vi.hoisted(() => ({
  canvas,
  error: null as Error | null,
  generation: 1 as number | null,
  hasFrame: true,
  retry: vi.fn(),
  status: 'ready' as 'loading' | 'switching' | 'ready' | 'recovering' | 'error',
}))
const prefetchCanvasPages = vi.hoisted(() => vi.fn(async () => []))

vi.mock('@/components/editor/useCanvas', () => ({
  useCanvas: () => canvasState,
}))
vi.mock('@koharu/bridge/canvas', () => ({
  prefetchCanvasPages,
  workspaceColor: () => [245, 245, 245],
}))

const layer: Layer = {
  type: 'image',
  id: 'element',
  parent: 'page',
  geometry: {
    points: [
      { x: 10, y: 20 },
      { x: 110, y: 20 },
      { x: 110, y: 70 },
      { x: 10, y: 70 },
    ],
  },
  visibility: { visible: true, opacity: 1 },
  image: 'image',
}

const paintLayer: Layer = {
  type: 'raster',
  id: 'paint',
  parent: 'page',
  visibility: { visible: true, opacity: 1 },
  image: 'paint-image',
  name: 'Paint 1',
  kind: 'paint',
}

let nextAnimationFrame = 1
let animationFrames = new Map<number, FrameRequestCallback>()

beforeEach(() => {
  nextAnimationFrame = 1
  animationFrames = new Map()
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const frame = nextAnimationFrame++
    animationFrames.set(frame, callback)
    return frame
  })
  vi.stubGlobal('cancelAnimationFrame', (frame: number) => animationFrames.delete(frame))
  canvasState.error = null
  canvasState.generation = 1
  canvasState.hasFrame = true
  canvasState.status = 'ready'
  prefetchCanvasPages.mockClear()
})

afterEach(() => {
  vi.unstubAllGlobals()
  window.localStorage.clear()
})

/** Lays a floating panel out at its styled place in a 800×600 canvas area. */
function layOut(panel: HTMLElement, width: number, height: number) {
  Object.defineProperty(panel.parentElement!, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({ x: 0, y: 0, left: 0, top: 0, width: 800, height: 600 }),
  })
  Object.defineProperty(panel, 'getBoundingClientRect', {
    configurable: true,
    value: () => {
      const left = Number.parseFloat(panel.style.left) || 12
      const top = Number.parseFloat(panel.style.top) || 12
      return { x: left, y: top, left, top, width, height }
    },
  })
}

function installProject() {
  const page = {
    id: 'page',
    label: 'Page',
    size: { width: 1000, height: 1000 },
    layers: [layer],
    regions: [],
  }
  queryClient.setQueryData(projectKey, {
    name: 'Book',
    revision: 1,
    active_page: 'page',
    can_undo: false,
    can_redo: false,
  })
  queryClient.setQueryData(pagesKey, [])
  queryClient.setQueryData(pageKey, page)
  useKoharuStore.setState({ selectedLayers: [], tool: 'select' })
  useKoharuStore.setState({
    canvasPage: 'page',
    canvasRevision: 1,
    canvasGeneration: 1,
    canvasSize: [1000, 1000],
  })
}

function renderWorkspace() {
  render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <CanvasWorkspace />
      </TooltipProvider>
    </QueryClientProvider>,
  )
  const surface = screen.getByLabelText('Koharu canvas')
  Object.defineProperty(surface, 'getBoundingClientRect', {
    value: () => ({ x: 10, y: 20, width: 800, height: 600 }),
  })
  return surface
}

describe('canvas interaction adapter', () => {
  it('prefetches only after the authoritative canvas page and generation are active', async () => {
    installProject()
    queryClient.setQueryData(pagesKey, [
      {
        id: 'page',
        label: 'Page',
        size: { width: 1000, height: 1000 },
        source_asset: null,
        layer_count: 1,
        status: 'not_started',
        reference: null,
      },
      {
        id: 'next',
        label: 'Next',
        size: { width: 1000, height: 1000 },
        source_asset: null,
        layer_count: 1,
        status: 'not_started',
        reference: null,
      },
    ])
    useKoharuStore.setState({ canvasPage: 'previous' })
    renderWorkspace()

    await Promise.resolve()
    expect(prefetchCanvasPages).not.toHaveBeenCalled()

    act(() => useKoharuStore.setState({ canvasPage: 'page' }))
    await waitFor(() => expect(prefetchCanvasPages).toHaveBeenCalledWith(['next']))
  })

  it('renders an accessible browser canvas and keeps camera updates local', async () => {
    installProject()
    const surface = renderWorkspace()
    expect(screen.getByTestId('webgpu-canvas')).toBeInstanceOf(HTMLCanvasElement)

    fireEvent.wheel(surface, { clientX: 100, clientY: 100, deltaY: 4 })
    fireEvent.wheel(surface, { clientX: 100, clientY: 100, deltaY: 6 })

    await waitFor(() => expect(canvas.setView).toHaveBeenLastCalledWith(1, [0, -10]))
  })

  it('preserves a manual camera when a newer canvas generation becomes ready', () => {
    installProject()
    renderWorkspace()
    const camera = { zoom: 2, translation: [-120, -80] as [number, number], fitted: false }

    act(() => useKoharuStore.setState({ camera }))
    act(() => {
      canvasState.status = 'switching'
      useKoharuStore.setState({ canvasGeneration: 2 })
    })
    act(() => {
      canvasState.status = 'ready'
      canvasState.generation = 2
      useKoharuStore.setState({ canvasRevision: 2 })
    })

    expect(useKoharuStore.getState().camera).toEqual(camera)
  })

  it('suppresses Alt browser handling while an editor input retains focus', () => {
    installProject()
    renderWorkspace()
    const input = document.createElement('input')
    document.body.append(input)
    input.focus()

    const event = new KeyboardEvent('keydown', { key: 'Alt', bubbles: true, cancelable: true })
    input.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(true)
    input.remove()
  })

  it('steps through project history from the keyboard only while there is some', async () => {
    installProject()
    const undo = vi.spyOn(commands, 'undo').mockResolvedValue(null)
    const redo = vi.spyOn(commands, 'redo').mockResolvedValue(null)
    const project = vi.spyOn(commands, 'getProject')
    vi.spyOn(commands, 'getPages').mockResolvedValue([])
    vi.spyOn(commands, 'getPage').mockImplementation(async () => queryClient.getQueryData(pageKey)!)
    renderWorkspace()

    // An empty history, as after Free up disk space, keeps the keys quiet.
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true })
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true, shiftKey: true })
    await act(async () => undefined)
    expect(undo).not.toHaveBeenCalled()
    expect(redo).not.toHaveBeenCalled()

    // A second press made before the first step's refresh reads the history
    // that step left, so one remaining step is undone once.
    const info = { name: 'Book', revision: 2, active_page: 'page' }
    queryClient.setQueryData(projectKey, { ...info, can_undo: true, can_redo: false })
    project.mockResolvedValue({ ...info, can_undo: false, can_redo: true })
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true })
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true })
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true, shiftKey: true })
    await waitFor(() => expect(redo).toHaveBeenCalledOnce())
    expect(undo).toHaveBeenCalledOnce()
  })

  it('moves and collapses the tools, remembers both, and puts them back on double-click', () => {
    installProject()
    const view = render(
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <CanvasWorkspace />
        </TooltipProvider>
      </QueryClientProvider>,
    )
    let tools = screen.getByRole('complementary', { name: 'Tools' })
    layOut(tools, 44, 300)
    const grip = within(tools).getByTitle('Drag to move. Double-click to put it back.')

    fireEvent.pointerDown(grip, { button: 0, pointerId: 1, clientX: 30, clientY: 15 })
    fireEvent.pointerMove(grip, { pointerId: 1, clientX: 230, clientY: 115 })
    fireEvent.pointerUp(grip, { pointerId: 1, clientX: 230, clientY: 115 })
    expect(tools).toHaveStyle({ left: '212px', top: '112px' })

    // The tools stop at the edge of the canvas area.
    fireEvent.pointerDown(grip, { button: 0, pointerId: 2, clientX: 230, clientY: 115 })
    fireEvent.pointerMove(grip, { pointerId: 2, clientX: 2000, clientY: 2000 })
    fireEvent.pointerUp(grip, { pointerId: 2, clientX: 2000, clientY: 2000 })
    expect(tools).toHaveStyle({ left: '756px', top: '300px' })

    fireEvent.click(within(tools).getByRole('button', { name: 'Collapse Tools' }))
    expect(within(tools).queryByRole('button', { name: 'Text' })).not.toBeInTheDocument()

    view.unmount()
    renderWorkspace()
    tools = screen.getByRole('complementary', { name: 'Tools' })
    expect(tools).toHaveStyle({ left: '756px', top: '300px' })
    expect(within(tools).queryByRole('button', { name: 'Text' })).not.toBeInTheDocument()
    fireEvent.click(within(tools).getByRole('button', { name: 'Expand Tools' }))
    expect(within(tools).getByRole('button', { name: 'Text' })).toBeInTheDocument()

    fireEvent.doubleClick(within(tools).getByTitle('Drag to move. Double-click to put it back.'))
    expect(tools.style.left).toBe('')
    expect(JSON.parse(window.localStorage.getItem('koharu.panel.tools')!)).toEqual({
      position: null,
      collapsed: false,
    })
  })

  it('keeps the tools over the canvas they work on when Compare shows a page beside it', () => {
    installProject()
    renderWorkspace()
    const tools = screen.getByRole('complementary', { name: 'Tools' })
    const area = tools.parentElement!
    expect(area).toContainElement(screen.getByLabelText('Koharu canvas'))

    act(() => {
      useKoharuStore.getState().setCompareMode('side_by_side')
      useKoharuStore.getState().setCompareOpen(true)
    })
    const compared = screen.getByRole('region', { name: 'Original' })
    // The tools are placed and kept within the canvas half alone.
    expect(tools.parentElement).toBe(area)
    expect(area).not.toContainElement(compared)
    expect(area.parentElement).toContainElement(compared)
  })

  it('zooms to a box drawn with Ctrl+drag and keeps Ctrl+click for the selection', () => {
    installProject()
    const commit = vi.spyOn(commands, 'commitTransform').mockResolvedValue(2)
    const surface = renderWorkspace()
    act(() => useKoharuStore.setState({ camera: { zoom: 1, translation: [0, 0], fitted: false } }))

    // The surface starts at (10, 20); the box spans (100, 100) to (300, 250).
    fireEvent.pointerDown(surface, {
      button: 0,
      ctrlKey: true,
      pointerId: 1,
      clientX: 110,
      clientY: 120,
    })
    fireEvent.pointerMove(surface, { ctrlKey: true, pointerId: 1, clientX: 310, clientY: 270 })
    expect(screen.getByTestId('zoom-box')).toHaveStyle({
      left: '100px',
      top: '100px',
      width: '200px',
      height: '150px',
    })
    fireEvent.pointerUp(surface, { ctrlKey: true, pointerId: 1, clientX: 310, clientY: 270 })

    expect(screen.queryByTestId('zoom-box')).not.toBeInTheDocument()
    expect(useKoharuStore.getState().camera).toEqual({
      zoom: 4,
      translation: [-400, -400],
      fitted: false,
    })

    // Back at zoom 1, over the image layer at page (10, 20)–(110, 70).
    act(() => useKoharuStore.setState({ camera: { zoom: 1, translation: [0, 0], fitted: false } }))
    fireEvent.pointerDown(surface, {
      button: 0,
      ctrlKey: true,
      pointerId: 2,
      clientX: 60,
      clientY: 60,
    })
    fireEvent.pointerUp(surface, { ctrlKey: true, pointerId: 2, clientX: 61, clientY: 60 })
    expect(useKoharuStore.getState().selectedLayers).toEqual(['element'])
    fireEvent.pointerDown(surface, {
      button: 0,
      ctrlKey: true,
      pointerId: 3,
      clientX: 60,
      clientY: 60,
    })
    fireEvent.pointerUp(surface, { ctrlKey: true, pointerId: 3, clientX: 60, clientY: 60 })
    expect(useKoharuStore.getState().selectedLayers).toEqual([])
    expect(useKoharuStore.getState().camera.zoom).toBe(1)
    expect(commit).not.toHaveBeenCalled()
  })

  it('frames in red the texts the canvas could not fit', () => {
    installProject()
    renderWorkspace()
    act(() =>
      receiveCanvas({
        page: 'page',
        revision: 1,
        generation: 1,
        size: [1000, 1000],
        element_frames: [
          { element: 'element', frame: { x: 10, y: 20, width: 100, height: 50, angle_degrees: 0 } },
        ],
        unfit_texts: [{ element: 'element', overflows: true, below_readable_size: false }],
      }),
    )

    const frame = screen.getByTestId('canvas-overlay').querySelector('[data-element="element"]')
    expect(frame).toHaveAttribute('data-unfit', 'true')
    expect((frame as HTMLElement).style.outline).toMatch(/solid/)
  })

  it('announces WebGPU startup failures and offers recovery', () => {
    installProject()
    canvasState.status = 'error'
    canvasState.error = new Error('No compatible WebGPU adapter was found.')
    renderWorkspace()
    expect(screen.getByRole('alert')).toHaveTextContent('WebGPU canvas unavailable')
    expect(screen.getByRole('alert')).toHaveTextContent('No compatible WebGPU adapter was found.')
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(canvasState.retry).toHaveBeenCalledOnce()
  })

  it('previews brush input locally and sends only the durable paint commit to Rust', async () => {
    installProject()
    useKoharuStore.setState({ tool: 'draw', brush: { diameter: 48, color: '#FFFFFF' } })
    const commit = vi
      .spyOn(commands, 'commitPaint')
      .mockResolvedValue({ revision: 2, layer: 'paint' })
    const surface = renderWorkspace()
    expect(surface).toHaveStyle({ cursor: 'none' })

    fireEvent.pointerDown(surface, { button: 0, pointerId: 7, clientX: 30, clientY: 40 })
    fireEvent.pointerMove(surface, { pointerId: 7, clientX: 55, clientY: 65 })
    fireEvent.pointerUp(surface, { pointerId: 7, clientX: 58, clientY: 70 })

    await waitFor(() => expect(commit).toHaveBeenCalledOnce())
    expect(canvas.beginStroke).toHaveBeenCalledWith({
      kind: 'paint',
      layer: null,
      point: { x: 20, y: 20 },
      diameter: 48,
      color: [255, 255, 255, 255],
    })
    expect(canvas.extendStroke).toHaveBeenCalledWith(expect.arrayContaining([{ x: 45, y: 45 }]))
    expect(canvas.finishStroke).toHaveBeenCalledOnce()
    expect(commit).toHaveBeenCalledWith(1, null, expect.arrayContaining([{ x: 45, y: 45 }]), {
      diameter: 48,
      color: [255, 255, 255, 255],
    })
  })

  it.each([
    ['revision', { canvasRevision: 2 }],
    ['generation', { canvasGeneration: 2 }],
  ])('cancels an active gesture when the canvas %s changes', async (_name, update) => {
    installProject()
    useKoharuStore.setState({ tool: 'draw', brush: { diameter: 48, color: '#FFFFFF' } })
    const commit = vi
      .spyOn(commands, 'commitPaint')
      .mockResolvedValue({ revision: 2, layer: 'paint' })
    const surface = renderWorkspace()

    fireEvent.pointerDown(surface, { button: 0, pointerId: 8, clientX: 30, clientY: 40 })
    expect(canvas.beginStroke).toHaveBeenCalledOnce()

    act(() => {
      useKoharuStore.setState(update)
    })

    await waitFor(() => expect(canvas.cancelStroke).toHaveBeenCalledOnce())
    fireEvent.pointerUp(surface, { pointerId: 8, clientX: 30, clientY: 40 })
    expect(canvas.finishStroke).not.toHaveBeenCalled()
    expect(commit).not.toHaveBeenCalled()
  })

  it('uses rendered text bounds for hit testing and semantic transforms', async () => {
    installProject()
    queryClient.setQueryData(pageKey, (page: { layers: Layer[] }) => ({
      ...page,
      layers: [
        {
          type: 'text',
          id: 'element',
          parent: 'page',
          geometry: layer.geometry,
          angle_degrees: 0,
          visibility: { visible: true, opacity: 1 },
          content: {
            id: 'content',
            source: { text: 'Source', language: 'en' },
            translation: { text: 'Rendered', language: null },
            role: null,
            source_region: null,
          },
          typography: null,
          layout: 'paragraph',
          automatic_region: null,
        },
      ],
    }))
    useKoharuStore.setState({
      layerFrames: {
        element: { x: 30, y: 40, width: 50, height: 20, angle_degrees: 0 },
      },
    })
    const commit = vi.spyOn(commands, 'commitTransform').mockResolvedValue(2)
    const surface = renderWorkspace()

    fireEvent.pointerDown(surface, { button: 0, pointerId: 9, clientX: 50, clientY: 60 })
    fireEvent.pointerMove(surface, { pointerId: 9, clientX: 70, clientY: 80 })
    fireEvent.pointerUp(surface, { pointerId: 9, clientX: 70, clientY: 80 })

    await waitFor(() => expect(commit).toHaveBeenCalledOnce())
    expect(useKoharuStore.getState().selectedLayers).toEqual(['element'])
    expect(canvas.beginTransform).toHaveBeenCalledWith([
      {
        element: 'element',
        frame: { x: 30, y: 40, width: 50, height: 20, angle_degrees: 0 },
      },
    ])
    expect(canvas.updateTransform).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          element: 'element',
          frame: expect.objectContaining({ x: 50, y: 60 }),
        }),
      ]),
    )
    expect(canvas.finishTransform).toHaveBeenCalledOnce()
    expect(commit).toHaveBeenCalledWith(
      1,
      expect.arrayContaining([
        expect.objectContaining({
          element: 'element',
          frame: expect.objectContaining({ x: 50, y: 60 }),
        }),
      ]),
    )
  })

  it('resizes a selected layer through Koharu selection controls', async () => {
    installProject()
    useKoharuStore.setState({ selectedLayers: ['element'] })
    const commit = vi.spyOn(commands, 'commitTransform').mockResolvedValue(2)
    renderWorkspace()
    Object.defineProperty(screen.getByTestId('canvas-overlay'), 'getBoundingClientRect', {
      value: () => ({ x: 10, y: 20, width: 800, height: 600 }),
    })
    const handle = document.querySelector<HTMLElement>('[data-resize-handle="e"]')!

    fireEvent.pointerDown(handle, { button: 0, pointerId: 10, clientX: 120, clientY: 65 })
    fireEvent.pointerMove(handle, { pointerId: 10, clientX: 140, clientY: 65 })
    fireEvent.pointerUp(handle, { pointerId: 10, clientX: 140, clientY: 65 })

    await waitFor(() => expect(commit).toHaveBeenCalledOnce())
    expect(canvas.beginTransform).toHaveBeenCalledWith([
      { element: 'element', frame: { x: 10, y: 20, width: 100, height: 50, angle_degrees: 0 } },
    ])
    expect(canvas.updateTransform).toHaveBeenCalledWith(
      expect.arrayContaining([
        {
          element: 'element',
          frame: { x: 10, y: 20, width: 120, height: 50, angle_degrees: 0 },
        },
      ]),
    )
    expect(commit).toHaveBeenCalledWith(
      1,
      expect.arrayContaining([
        {
          element: 'element',
          frame: { x: 10, y: 20, width: 120, height: 50, angle_degrees: 0 },
        },
      ]),
    )
  })

  it('shows the automatic region behind the selected text controls', () => {
    installProject()
    queryClient.setQueryData(pageKey, (page: { layers: Layer[] }) => ({
      ...page,
      layers: [
        {
          type: 'text',
          id: 'element',
          parent: 'page',
          geometry: null,
          angle_degrees: null,
          visibility: { visible: true, opacity: 1 },
          content: {
            id: 'content',
            source: { text: 'Source', language: 'en' },
            translation: { text: 'Rendered', language: null },
            role: null,
            source_region: null,
          },
          typography: null,
          layout: 'paragraph',
          automatic_region: 'bubble',
        },
      ],
      regions: [
        {
          id: 'bubble',
          parent: 'page',
          geometry: {
            points: [
              { x: 20, y: 30 },
              { x: 100, y: 30 },
              { x: 100, y: 90 },
              { x: 20, y: 90 },
            ],
          },
          kind: 'bubble',
          label: null,
        },
      ],
    }))
    useKoharuStore.setState({
      selectedLayers: ['element'],
      layerFrames: {
        element: { x: 30, y: 40, width: 50, height: 20, angle_degrees: 0 },
      },
    })

    renderWorkspace()

    expect(screen.getByTestId('text-fit-region').querySelector('polygon')).toHaveAttribute(
      'points',
      '20,30 100,30 100,90 20,90',
    )
  })

  it('targets the selected raster layer with the eraser', async () => {
    installProject()
    queryClient.setQueryData(pageKey, (page: { layers: Layer[] }) => ({
      ...page,
      layers: [...page.layers, paintLayer],
    }))
    useKoharuStore.setState({ tool: 'eraser', selectedLayers: ['paint'] })
    const commit = vi
      .spyOn(commands, 'commitErase')
      .mockResolvedValue({ revision: 2, layer: 'paint' })
    const surface = renderWorkspace()

    fireEvent.pointerDown(surface, { button: 0, pointerId: 11, clientX: 30, clientY: 40 })
    fireEvent.pointerUp(surface, { pointerId: 11, clientX: 30, clientY: 40 })

    await waitFor(() => expect(commit).toHaveBeenCalledOnce())
    expect(canvas.beginStroke).toHaveBeenCalledWith({
      kind: 'erase',
      layer: 'paint',
      point: { x: 20, y: 20 },
      diameter: 48,
    })
    expect(commit).toHaveBeenCalledWith(1, 'paint', expect.arrayContaining([{ x: 20, y: 20 }]), 48)
  })

  it('maps the Remove tool to an inpainting mask gesture', async () => {
    installProject()
    useKoharuStore.setState({ tool: 'remove' })
    const commit = vi.spyOn(commands, 'commitInpaint').mockResolvedValue('job')
    const surface = renderWorkspace()

    fireEvent.pointerDown(surface, { button: 0, pointerId: 12, clientX: 30, clientY: 40 })
    fireEvent.pointerUp(surface, { pointerId: 12, clientX: 30, clientY: 40 })

    await waitFor(() => expect(commit).toHaveBeenCalledOnce())
    expect(canvas.beginStroke).toHaveBeenCalledWith({
      kind: 'inpaint',
      layer: null,
      point: { x: 20, y: 20 },
      diameter: 48,
    })
    expect(commit).toHaveBeenCalledWith(1, expect.arrayContaining([{ x: 20, y: 20 }]), 48)
  })

  it('creates point text on click and paragraph text on drag', async () => {
    installProject()
    useKoharuStore.setState({ tool: 'text' })
    const point = vi
      .spyOn(commands, 'addPointText')
      .mockResolvedValue({ revision: 2, layer: 'point-text' })
    const box = vi
      .spyOn(commands, 'addTextBox')
      .mockResolvedValue({ revision: 3, layer: 'box-text' })
    const surface = renderWorkspace()

    fireEvent.pointerDown(surface, { button: 0, pointerId: 13, clientX: 30, clientY: 40 })
    fireEvent.pointerUp(surface, { pointerId: 13, clientX: 30, clientY: 40 })
    await waitFor(() => expect(point).toHaveBeenCalledWith({ x: 20, y: 20 }))

    fireEvent.pointerDown(surface, { button: 0, pointerId: 14, clientX: 40, clientY: 50 })
    fireEvent.pointerMove(surface, { pointerId: 14, clientX: 140, clientY: 110 })
    fireEvent.pointerUp(surface, { pointerId: 14, clientX: 140, clientY: 110 })
    await waitFor(() => expect(box).toHaveBeenCalledOnce())
    expect(box).toHaveBeenCalledWith({
      x: 30,
      y: 30,
      width: 100,
      height: 60,
      angle_degrees: 0,
    })
  })
})
