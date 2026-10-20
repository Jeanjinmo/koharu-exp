import { QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { ProjectCleanupDialogs } from '@/components/editor/ProjectCleanup'
import { projectKey, queryClient } from '@/lib/queries'
import { useKoharuStore } from '@/lib/store'
import { commands } from '@koharu/bridge/protocol'

function open(cleanup: 'free-space') {
  queryClient.setQueryData(projectKey, {
    name: 'Book',
    revision: 4,
    active_page: null,
    can_undo: true,
    can_redo: false,
  })
  useKoharuStore.setState({ cleanup })
  return render(
    <QueryClientProvider client={queryClient}>
      <ProjectCleanupDialogs />
    </QueryClientProvider>,
  )
}

describe('project cleanup', () => {
  it('estimates the space before freeing it and warns that it cannot be undone', async () => {
    const user = userEvent.setup()
    vi.spyOn(commands, 'getReclaimableSpace').mockResolvedValue({ files: 3, bytes: 1572864 })
    const free = vi.spyOn(commands, 'freeDiskSpace').mockResolvedValue({ files: 3, bytes: 1572864 })
    vi.spyOn(commands, 'getProject').mockResolvedValue(null)
    open('free-space')

    expect(await screen.findByText('Up to 1.5 MB can be freed.')).toBeInTheDocument()
    expect(
      screen.getByText('This cannot be undone, and the undo history is cleared.'),
    ).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Free up space' }))

    await waitFor(() => expect(free).toHaveBeenCalled())
    await waitFor(() => expect(useKoharuStore.getState().cleanup).toBeNull())
  })

  it('has nothing to do when no earlier version holds extra content', async () => {
    vi.spyOn(commands, 'getReclaimableSpace').mockResolvedValue({ files: 0, bytes: 0 })
    open('free-space')

    expect(await screen.findByText('There is nothing to free right now.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Free up space' })).toBeDisabled()
  })
})
