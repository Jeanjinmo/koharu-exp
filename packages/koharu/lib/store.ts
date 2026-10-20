'use client'

import { create } from 'zustand'

import type {
  CanvasState,
  Download,
  EntityId,
  Job,
  McpEvent,
  Model,
  Frame,
  Preferences,
  ServerStatus,
  Stage,
  StartupState,
  ModelResources,
  ToolActivity,
} from '@koharu/bridge/protocol'
import { toast } from '@koharu/ui/components/toast'

export type CanvasTool = 'select' | 'text' | 'draw' | 'eraser' | 'color_picker' | 'remove' | 'pan'
export const MIN_BRUSH_DIAMETER = 1
export const MAX_BRUSH_DIAMETER = 128

export function isBrushTool(tool: CanvasTool): boolean {
  return tool === 'draw' || tool === 'eraser' || tool === 'remove'
}

export interface CanvasBrush {
  diameter: number
  color: string
}
export type InspectorSection = 'copy' | 'type' | 'layers'
export type ShortcutAction = CanvasTool | 'fit' | 'compare'
/** How Compare shows the original beside the editable result. */
export type CompareMode = 'side_by_side' | 'slider' | 'peek'
export const compareModes: readonly CompareMode[] = ['side_by_side', 'slider', 'peek']

export interface Compare {
  open: boolean
  mode: CompareMode
  /** Hold to peek shows the original while the shortcut is held. */
  peeking: boolean
  /** Where the slider divides the page, from 0 (left edge) to 1 (right edge). */
  split: number
}
export type Shortcuts = Record<ShortcutAction, string>
export type PipelineScope = 'page' | 'selected-pages' | 'project'
export type ProjectCleanup = 'clear' | 'free-space'
export const pipelineStages: readonly Stage[] = ['detection', 'ocr', 'translation', 'inpainting']

interface KoharuStore {
  initialized: boolean
  preferences: Preferences | null
  translationModels: Model[]
  resources: ModelResources | null
  jobs: Record<string, Job>
  downloads: Record<string, Download>
  mcpStatus: ServerStatus
  /** Recent MCP tool calls, oldest first, as the backend keeps them. */
  mcpActivity: ToolActivity[]
  camera: { zoom: number; translation: [number, number]; fitted: boolean }
  canvasPage: EntityId | null
  canvasRevision: number | null
  canvasGeneration: number
  canvasSize: [number, number]
  fitCanvasRequest: number
  layerFrames: Record<EntityId, Frame>
  selectedLayers: EntityId[]
  selectedPages: EntityId[]
  tool: CanvasTool
  brush: CanvasBrush
  inspector: InspectorSection
  processingScope: PipelineScope
  processingStages: Stage[]
  settingsOpen: boolean
  cleanup: ProjectCleanup | null
  referenceImport: boolean
  compare: Compare
  shortcuts: Shortcuts
  selectPages: (pages: EntityId[]) => void
  showInspector: (section: InspectorSection) => void
  setProcessingScope: (scope: PipelineScope) => void
  setProcessingStages: (stages: Stage[]) => void
  setSettingsOpen: (open: boolean) => void
  setCleanup: (cleanup: ProjectCleanup | null) => void
  setReferenceImport: (open: boolean) => void
  setCompareOpen: (open: boolean) => void
  setCompareMode: (mode: CompareMode) => void
  setComparePeeking: (peeking: boolean) => void
  setCompareSplit: (split: number) => void
  selectLayers: (layers: EntityId[]) => void
  setTool: (tool: CanvasTool) => void
  setBrush: (brush: CanvasBrush) => void
  setShortcut: (action: ShortcutAction, key: string) => void
  requestCanvasFit: () => void
  dismissJob: (id: string) => void
  dismissDownload: (id: number) => void
}

export const defaultShortcuts: Shortcuts = {
  select: 'v',
  text: 't',
  draw: 'b',
  eraser: 'e',
  color_picker: 'i',
  remove: 'j',
  pan: 'h',
  fit: '0',
  compare: 'c',
}

const compareModeKey = 'koharu.compare.mode'

// The last Compare mode is remembered on this device; storage may be unavailable.
function rememberedCompareMode(): CompareMode {
  try {
    const mode = window.localStorage.getItem(compareModeKey)
    return compareModes.find((candidate) => candidate === mode) ?? 'side_by_side'
  } catch {
    return 'side_by_side'
  }
}

function rememberCompareMode(mode: CompareMode): void {
  try {
    window.localStorage.setItem(compareModeKey, mode)
  } catch {
    // The mode then lasts only for this session.
  }
}

export const useKoharuStore = create<KoharuStore>()((set) => ({
  initialized: false,
  preferences: null,
  translationModels: [],
  resources: null,
  jobs: {},
  downloads: {},
  mcpStatus: { state: 'off' },
  mcpActivity: [],
  camera: { zoom: 1, translation: [0, 0], fitted: true },
  canvasPage: null,
  canvasRevision: null,
  canvasGeneration: 0,
  canvasSize: [0, 0],
  fitCanvasRequest: 0,
  layerFrames: {},
  selectedLayers: [],
  selectedPages: [],
  tool: 'select',
  brush: { diameter: 48, color: '#FFFFFF' },
  inspector: 'copy',
  processingScope: 'selected-pages',
  processingStages: [...pipelineStages],
  settingsOpen: false,
  cleanup: null,
  referenceImport: false,
  compare: { open: false, mode: rememberedCompareMode(), peeking: false, split: 0.5 },
  shortcuts: defaultShortcuts,
  selectPages: (selectedPages) => set({ selectedPages: [...new Set(selectedPages)] }),
  showInspector: (inspector) => set({ inspector }),
  setProcessingScope: (processingScope) => set({ processingScope }),
  setProcessingStages: (processingStages) => set({ processingStages }),
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  setCleanup: (cleanup) => set({ cleanup }),
  setReferenceImport: (referenceImport) => set({ referenceImport }),
  setCompareOpen: (open) =>
    set((state) => ({ compare: { ...state.compare, open, peeking: false } })),
  setCompareMode: (mode) => {
    rememberCompareMode(mode)
    set((state) => ({ compare: { ...state.compare, mode, peeking: false } }))
  },
  setComparePeeking: (peeking) => set((state) => ({ compare: { ...state.compare, peeking } })),
  setCompareSplit: (split) =>
    set((state) => ({ compare: { ...state.compare, split: Math.min(1, Math.max(0, split)) } })),
  selectLayers: (selectedLayers) => set({ selectedLayers: [...new Set(selectedLayers)] }),
  setTool: (tool) => set({ tool }),
  setBrush: (brush) => set({ brush }),
  setShortcut: (action, key) =>
    set((state) => ({
      shortcuts: { ...state.shortcuts, [action]: key.toLowerCase().slice(0, 1) },
    })),
  requestCanvasFit: () => set((state) => ({ fitCanvasRequest: state.fitCanvasRequest + 1 })),
  dismissJob: (id) =>
    set((state) => {
      const jobs = { ...state.jobs }
      delete jobs[id]
      return { jobs }
    }),
  dismissDownload: (id) =>
    set((state) => {
      const downloads = { ...state.downloads }
      delete downloads[String(id)]
      return { downloads }
    }),
}))

export function receiveStartupState(state: StartupState): void {
  useKoharuStore.setState({
    initialized: true,
    preferences: state.preferences,
    jobs: byId(state.jobs),
    mcpStatus: state.mcp.status,
    mcpActivity: state.mcp.activity,
    ...canvasSnapshot(state.canvas),
  })
}

const MCP_ACTIVITY_LIMIT = 100

export function receiveMcpEvent(event: McpEvent): void {
  switch (event.type) {
    case 'status':
      useKoharuStore.setState({ mcpStatus: event.status })
      break
    case 'activity':
      useKoharuStore.setState((state) => ({
        mcpActivity: [...state.mcpActivity, event.activity].slice(-MCP_ACTIVITY_LIMIT),
      }))
      break
    case 'activity_cleared':
      useKoharuStore.setState({ mcpActivity: [] })
      break
    case 'followed':
      useKoharuStore.setState({ selectedPages: [event.page], selectedLayers: [] })
      break
  }
}

export function receiveCanvas(canvas: CanvasState): void {
  useKoharuStore.setState(canvasSnapshot(canvas))
}

export function receiveJob(job: Job): void {
  useKoharuStore.setState((state) => ({ jobs: { ...state.jobs, [job.id]: job } }))
}

export function receiveDownload(download: Download): void {
  useKoharuStore.setState((state) => {
    const downloads = { ...state.downloads }
    if (download.state === 'finished') delete downloads[String(download.id)]
    else downloads[String(download.id)] = download
    return { downloads }
  })
}

export function receivePreferences(preferences: Preferences): void {
  useKoharuStore.setState({ preferences })
}

export function receiveTranslationModels(translationModels: Model[]): void {
  useKoharuStore.setState({ translationModels })
}

export function receiveResources(resources: ModelResources): void {
  useKoharuStore.setState({ resources })
}

export function receiveError(message: string): void {
  toast.add({ type: 'error', title: 'Could not complete that action', description: message })
}

function canvasSnapshot(canvas: CanvasState) {
  return {
    canvasPage: canvas.page,
    canvasRevision: canvas.revision,
    canvasGeneration: canvas.generation,
    canvasSize: canvas.size,
    layerFrames: Object.fromEntries(
      canvas.element_frames.map(({ element, frame }) => [element, frame]),
    ),
  }
}

function byId<T extends { id: string | number }>(items: T[]): Record<string, T> {
  return Object.fromEntries(items.map((item) => [String(item.id), item]))
}
