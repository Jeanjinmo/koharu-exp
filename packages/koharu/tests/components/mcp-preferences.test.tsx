import { QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render as testingRender, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { McpPreferences } from '@/components/preferences/McpPreferences'
import { pagesKey, projectKey, queryClient } from '@/lib/queries'
import { useKoharuStore } from '@/lib/store'
import {
  commands,
  type McpConfig,
  type McpSettings,
  type McpTool,
  type ToolMetadata,
} from '@koharu/bridge/protocol'
import { TooltipProvider } from '@koharu/ui/components/tooltip'

function tool(name: string, metadata: Partial<ToolMetadata> = {}, enabled = true): McpTool {
  return {
    name,
    metadata: {
      group: 'read',
      vision: 'none',
      mutates_image: false,
      destructive: false,
      ...metadata,
    },
    enabled,
  }
}

function settings(config: Partial<McpConfig> = {}): McpSettings {
  return {
    config: {
      enabled: true,
      port: 47821,
      profile: 'vision',
      disabled_tools: [],
      follow_agent: true,
      export_dir: null,
      ...config,
    },
    tools: [
      tool('inspect_page'),
      tool('view_page', { vision: 'required' }, !config.disabled_tools?.includes('view_page')),
      tool('delete_pages', { group: 'pages', destructive: true }),
    ],
    export_folder: '/home/reader/Documents/Koharu/exports',
  }
}

function render(ui: ReactNode) {
  return testingRender(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>)
}

describe('MCP tools settings', () => {
  it('shows the live server status and switches the server and following off', async () => {
    useKoharuStore.setState({
      mcpStatus: { state: 'running', url: 'http://127.0.0.1:47821/mcp', clients: 2 },
    })
    vi.spyOn(commands, 'getMcpSettings').mockResolvedValue(settings())
    const setEnabled = vi
      .spyOn(commands, 'setMcpEnabled')
      .mockResolvedValue(settings({ enabled: false }))
    const setFollow = vi
      .spyOn(commands, 'setMcpFollowAgent')
      .mockResolvedValue(settings({ follow_agent: false }))
    render(<McpPreferences />)

    expect(await screen.findByText('Running at 127.0.0.1:47821 · 2 clients')).toBeInTheDocument()
    expect(screen.getByText('/home/reader/Documents/Koharu/exports')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('switch', { name: 'MCP server' }))
    await waitFor(() => expect(setEnabled).toHaveBeenCalledWith(false))

    fireEvent.click(screen.getByRole('switch', { name: 'Follow agent' }))
    await waitFor(() => expect(setFollow).toHaveBeenCalledWith(false))
    expect(await screen.findByRole('switch', { name: 'Follow agent' })).not.toBeChecked()
  })

  it('locks the switch while stopping and can stop at once', async () => {
    useKoharuStore.setState({ mcpStatus: { state: 'stopping', tasks: 1 } })
    vi.spyOn(commands, 'getMcpSettings').mockResolvedValue(settings({ enabled: false }))
    const stopNow = vi.spyOn(commands, 'stopMcpNow').mockResolvedValue(null)
    render(<McpPreferences />)

    expect(await screen.findByText('Stopping… (waiting for 1 task)')).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: 'MCP server' })).toHaveAttribute(
      'aria-disabled',
      'true',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Stop now' }))

    await waitFor(() => expect(stopNow).toHaveBeenCalled())
  })

  it('reports a failed start and retries it', async () => {
    useKoharuStore.setState({
      mcpStatus: { state: 'failed', message: 'failed to listen on 127.0.0.1:47821' },
    })
    vi.spyOn(commands, 'getMcpSettings').mockResolvedValue(settings())
    const setEnabled = vi.spyOn(commands, 'setMcpEnabled').mockResolvedValue(settings())
    render(<McpPreferences />)

    expect(
      await screen.findByText('Error: failed to listen on 127.0.0.1:47821'),
    ).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: 'MCP server' })).not.toBeChecked()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

    await waitFor(() => expect(setEnabled).toHaveBeenCalledWith(true))
  })

  it('disables a tool and greys out every tool while the server is off', async () => {
    useKoharuStore.setState({ mcpStatus: { state: 'off' } })
    vi.spyOn(commands, 'getMcpSettings').mockResolvedValue(settings())
    const setTools = vi
      .spyOn(commands, 'setMcpTools')
      .mockResolvedValue(settings({ profile: 'custom', disabled_tools: ['view_page'] }))
    const view = render(<McpPreferences />)

    fireEvent.click(await screen.findByRole('checkbox', { name: 'view_page' }))
    await waitFor(() => expect(setTools).toHaveBeenCalledWith('custom', ['view_page']))
    expect(await screen.findByRole('checkbox', { name: 'view_page' })).not.toBeChecked()
    view.unmount()

    vi.spyOn(commands, 'getMcpSettings').mockResolvedValue(settings({ enabled: false }))
    render(<McpPreferences />)
    for (const checkbox of await screen.findAllByRole('checkbox')) {
      expect(checkbox).toHaveAttribute('aria-disabled', 'true')
    }
    expect(screen.getByRole('button', { name: 'Text-only model' })).toBeDisabled()
  })

  it('applies a profile and labels and explains every tool', async () => {
    useKoharuStore.setState({ mcpStatus: { state: 'off' } })
    vi.spyOn(commands, 'getMcpSettings').mockResolvedValue(settings())
    const setTools = vi
      .spyOn(commands, 'setMcpTools')
      .mockResolvedValue(settings({ profile: 'text' }))
    render(
      <TooltipProvider delay={0}>
        <McpPreferences />
      </TooltipProvider>,
    )

    expect(await screen.findByRole('button', { name: 'Vision model' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(screen.getByText('needs vision')).toBeInTheDocument()
    expect(screen.getByText('deletes')).toBeInTheDocument()
    expect(screen.getByText('See a page as an image')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'About view_page' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Text-only model' }))
    await waitFor(() => expect(setTools).toHaveBeenCalledWith('text', []))
    expect(await screen.findByText('Tools that need to see images are off.')).toBeInTheDocument()
  })

  it('lists recent tool calls with their pages and clears them', async () => {
    queryClient.setQueryData(projectKey, {
      name: 'Book',
      revision: 1,
      active_page: 'page-2',
      can_undo: false,
      can_redo: false,
    })
    queryClient.setQueryData(pagesKey, [
      {
        id: 'page-1',
        label: '001.png',
        size: { width: 1, height: 1 },
        source_asset: null,
        layer_count: 0,
      },
      {
        id: 'page-2',
        label: '002.png',
        size: { width: 1, height: 1 },
        source_asset: null,
        layer_count: 0,
      },
    ])
    useKoharuStore.setState({
      mcpStatus: { state: 'off' },
      mcpActivity: [
        {
          finished_at: Date.UTC(2026, 9, 20, 8, 0, 0),
          tool: 'set_translations',
          page: 'page-2',
          ok: true,
          changed: true,
          error: null,
          elapsed_ms: 1250,
        },
        {
          finished_at: Date.UTC(2026, 9, 20, 8, 0, 5),
          tool: 'view_page',
          page: null,
          ok: false,
          changed: false,
          error: 'Tool `view_page` is disabled in Koharu settings',
          elapsed_ms: 0,
        },
      ],
    })
    vi.spyOn(commands, 'getMcpSettings').mockResolvedValue(settings())
    const clear = vi.spyOn(commands, 'clearMcpActivity').mockResolvedValue(null)
    render(<McpPreferences />)

    const log = await screen.findByRole('list', { name: 'Activity' })
    const rows = log.querySelectorAll('li')
    expect(rows[0]).toHaveTextContent('view_page')
    expect(rows[0]).toHaveTextContent('Tool `view_page` is disabled in Koharu settings')
    expect(rows[1]).toHaveTextContent('set_translations')
    expect(rows[1]).toHaveTextContent('Page 2 · 002.png')
    expect(rows[1]).toHaveTextContent('1.3 s')

    fireEvent.click(screen.getByRole('button', { name: 'Clear' }))
    await waitFor(() => expect(clear).toHaveBeenCalled())
  })
})
