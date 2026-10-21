import { describe, expect, it, vi } from 'vitest'

import { receiveCanvas, receiveDownload, receiveJob, useKoharuStore } from '@/lib/store'
import type { Job } from '@koharu/bridge/protocol'
import { toast } from '@koharu/ui/components/toast'

describe('editor state', () => {
  it('retains failed downloads until they are dismissed', () => {
    useKoharuStore.setState({ downloads: {} })
    receiveDownload({
      state: 'failed',
      id: 9,
      name: 'weights.bin',
      completed: 0,
      total: 0,
      error: 'network unavailable',
    })
    expect(useKoharuStore.getState().downloads[9]).toMatchObject({
      state: 'failed',
      name: 'weights.bin',
    })

    useKoharuStore.getState().dismissDownload(9)
    expect(useKoharuStore.getState().downloads[9]).toBeUndefined()
  })

  it('defaults paint brush color to pure white (#FFFFFF)', () => {
    expect(useKoharuStore.getState().brush.color).toBe('#FFFFFF')
  })

  it('keeps the texts of the shown page that do not fit, by element', () => {
    receiveCanvas({
      page: 'page',
      revision: 3,
      generation: 2,
      size: [1000, 1500],
      element_frames: [],
      unfit_texts: [{ element: 'bubble', overflows: true, below_readable_size: false }],
    })
    expect(useKoharuStore.getState().unfitTexts).toEqual({
      bubble: { element: 'bubble', overflows: true, below_readable_size: false },
    })
  })

  it('says how many translated texts do not fit, and nothing when all fit', () => {
    const add = vi.spyOn(toast, 'add')
    const job = (unfit: number): Job => ({
      id: `job-${unfit}`,
      kind: 'pipeline',
      state: 'finished',
      completed: 2,
      total: 2,
      page: null,
      stage: null,
      model: null,
      error: null,
      summary: { kind: 'translation', unfit },
    })

    receiveJob(job(0))
    expect(add).not.toHaveBeenCalled()
    receiveJob(job(3))
    expect(add).toHaveBeenCalledWith({
      type: 'warning',
      title: '3 texts do not fit their frames.',
      description: 'They are framed in red on the canvas and marked in Layers.',
    })
  })
})
