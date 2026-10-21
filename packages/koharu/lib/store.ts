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
  ReferencePlacement,
  ServerStatus,
  Stage,
  StartupState,
  ModelResources,
  ToolActivity,
} from '@koharu/bridge/protocol'
import { toast } from '@koharu/ui/components/toast'

import i18next from './i18n'

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

/** What Compare shows on a page that has a reference. */
export type CompareSubject = 'reference' | 'original'

export interface Compare {
  open: boolean
  mode: CompareMode
  subject: CompareSubject
  /** Hold to peek shows the original while the shortcut is held. */
  peeking: boolean
  /** Where the slider divides the page, from 0 (left edge) to 1 (right edge). */
  split: number
}
/** Aligning a page's reference by hand, before the alignment is saved. */
export interface Tracing {
  page: EntityId
  /** `null` while the page has no reference to align. */
  placement: ReferencePlacement | null
  /** Whether `placement` differs from the saved one. */
  changed: boolean
  opacity: number
  /**
   * This session's own history of placements, oldest first. Undo and redo
   * walk it while aligning, so they never reach the project's history.
   */
  undo: ReferencePlacement[]
  redo: ReferencePlacement[]
  /** Set while asking whether to save before leaving; `after` runs once left. */
  leaving: { after: (() => void) | null } | null
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
  tracing: Tracing | null
  /** The text element whose text is being picked from the page's reference. */
  referencePick: EntityId | null
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
  setCompareSubject: (subject: CompareSubject) => void
  /**
   * Starts aligning `page`'s reference from its saved placement. Aligning the
   * page already being aligned keeps the session.
   */
  startTracing: (page: EntityId, placement: ReferencePlacement | null) => void
  /**
   * Moves the reference. `record: false` continues the change recorded last,
   * so one drag or one typed value is one undo step.
   */
  moveTracing: (placement: ReferencePlacement, record?: boolean) => void
  undoTracing: () => void
  redoTracing: () => void
  setTracingOpacity: (opacity: number) => void
  /** Ends aligning at once, dropping an unsaved alignment. */
  stopTracing: () => void
  /**
   * Ends aligning, first asking whether to save an unsaved alignment, then
   * runs `after`. Staying keeps aligning and drops `after`.
   */
  leaveTracing: (after?: () => void) => void
  stayTracing: () => void
  setReferencePick: (layer: EntityId | null) => void
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

/** How many placements one aligning session can undo. */
const TRACING_HISTORY = 100
/** The reference's opacity when aligning starts, and what resetting it returns to. */
export const TRACING_OPACITY = 0.5

export const useKoharuStore = create<KoharuStore>()((set, get) => ({
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
  compare: {
    open: false,
    mode: rememberedCompareMode(),
    subject: 'reference',
    peeking: false,
    split: 0.5,
  },
  tracing: null,
  referencePick: null,
  shortcuts: defaultShortcuts,
  selectPages: (selectedPages) => set({ selectedPages: [...new Set(selectedPages)] }),
  showInspector: (inspector) => set({ inspector }),
  setProcessingScope: (processingScope) => set({ processingScope }),
  setProcessingStages: (processingStages) => set({ processingStages }),
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  setCleanup: (cleanup) => set({ cleanup }),
  setReferenceImport: (referenceImport) => set({ referenceImport }),
  // Compare, aligning a reference, and picking reference text all draw over
  // the canvas, so each closes the others. Aligning is left only after
  // asking about an unsaved alignment.
  setCompareOpen: (open) => {
    const show = () =>
      set((state) => ({
        compare: { ...state.compare, open, peeking: false },
        referencePick: open ? null : state.referencePick,
      }))
    if (open && get().tracing) get().leaveTracing(show)
    else show()
  },
  setCompareMode: (mode) => {
    rememberCompareMode(mode)
    set((state) => ({ compare: { ...state.compare, mode, peeking: false } }))
  },
  setComparePeeking: (peeking) => set((state) => ({ compare: { ...state.compare, peeking } })),
  setCompareSplit: (split) =>
    set((state) => ({ compare: { ...state.compare, split: Math.min(1, Math.max(0, split)) } })),
  setCompareSubject: (subject) => set((state) => ({ compare: { ...state.compare, subject } })),
  startTracing: (page, placement) =>
    set((state) =>
      state.tracing?.page === page
        ? {}
        : {
            compare: { ...state.compare, open: false, peeking: false },
            tracing: {
              page,
              placement,
              changed: false,
              opacity: state.tracing?.opacity ?? TRACING_OPACITY,
              undo: [],
              redo: [],
              leaving: null,
            },
            referencePick: null,
          },
    ),
  moveTracing: (placement, record = true) =>
    set(({ tracing }) => {
      if (!tracing) return {}
      const recorded = record && tracing.placement
      return {
        tracing: {
          ...tracing,
          placement,
          changed: true,
          undo: recorded ? [...tracing.undo, recorded].slice(-TRACING_HISTORY) : tracing.undo,
          redo: record ? [] : tracing.redo,
        },
      }
    }),
  undoTracing: () =>
    set(({ tracing }) => {
      const previous = tracing?.undo.at(-1)
      if (!tracing?.placement || !previous) return {}
      const undo = tracing.undo.slice(0, -1)
      return {
        tracing: {
          ...tracing,
          placement: previous,
          // The oldest placement is the saved one.
          changed: undo.length > 0,
          undo,
          redo: [...tracing.redo, tracing.placement],
        },
      }
    }),
  redoTracing: () =>
    set(({ tracing }) => {
      const next = tracing?.redo.at(-1)
      if (!tracing?.placement || !next) return {}
      return {
        tracing: {
          ...tracing,
          placement: next,
          changed: true,
          undo: [...tracing.undo, tracing.placement],
          redo: tracing.redo.slice(0, -1),
        },
      }
    }),
  setTracingOpacity: (opacity) =>
    set((state) => ({
      tracing: state.tracing && { ...state.tracing, opacity: Math.min(1, Math.max(0, opacity)) },
    })),
  stopTracing: () => set({ tracing: null }),
  leaveTracing: (after) => {
    const tracing = get().tracing
    if (tracing?.changed && tracing.placement) {
      set({ tracing: { ...tracing, leaving: { after: after ?? null } } })
      return
    }
    set({ tracing: null })
    after?.()
  },
  stayTracing: () => set(({ tracing }) => ({ tracing: tracing && { ...tracing, leaving: null } })),
  setReferencePick: (referencePick) => {
    const pick = () =>
      set((state) => ({
        referencePick,
        compare: referencePick ? { ...state.compare, open: false, peeking: false } : state.compare,
      }))
    if (referencePick && get().tracing) get().leaveTracing(pick)
    else pick()
  },
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
  const summary = job.state === 'finished' ? job.summary : null
  if (summary?.kind === 'references') {
    const read = i18next.t('references.readCount', { count: summary.read })
    const unmatched =
      summary.unmatched > 0
        ? i18next.t('references.unmatchedCount', { count: summary.unmatched })
        : ''
    toast.add({
      type: 'success',
      title: i18next.t('references.readTitle'),
      description: [read, unmatched].filter(Boolean).join(' '),
    })
  }
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
