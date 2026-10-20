import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { McpPreferences } from '@/components/preferences/McpPreferences'
import { useKoharuStore } from '@/lib/store'
import {
  commands,
  type McpConfig,
  type McpSettings,
  type McpTool,
  type ToolMetadata,
} from '@koharu/bridge/protocol'

function tool(name: string, metadata: Partial<ToolMetadata> = {}): McpTool {
  return {
    name,
    metadata: {
      group: 'read',
      vision: 'none',
      mutates_image: false,
      destructive: false,
      ...metadata,
    },
  }
}

function settings(config: Partial<McpConfig> = {}): McpSettings {
  return {
    config: {
      enabled: true,
      port: 47821,
      disabled_tools: [],
      export_dir: null,
      ...config,
    },
    tools: [
      tool('inspect_page'),
      tool('view_page', { vision: 'required' }),
      tool('delete_pages', { group: 'pages', destructive: true }),
    ],
    export_folder: '/home/reader/Documents/Koharu/exports',
  }
}

describe('MCP tools settings', () => {
  it('shows the live server status and switches the server off', async () => {
    useKoharuStore.setState({
      mcpStatus: { state: 'running', url: 'http://127.0.0.1:47821/mcp', clients: 2 },
    })
    vi.spyOn(commands, 'getMcpSettings').mockResolvedValue(settings())
    const setEnabled = vi
      .spyOn(commands, 'setMcpEnabled')
      .mockResolvedValue(settings({ enabled: false }))
    render(<McpPreferences />)

    expect(await screen.findByText('Running at 127.0.0.1:47821 · 2 clients')).toBeInTheDocument()
    expect(screen.getByText('/home/reader/Documents/Koharu/exports')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('switch', { name: 'MCP server' }))

    await waitFor(() => expect(setEnabled).toHaveBeenCalledWith(false))
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
      .mockResolvedValue(settings({ disabled_tools: ['view_page'] }))
    const view = render(<McpPreferences />)

    fireEvent.click(await screen.findByRole('checkbox', { name: 'view_page' }))
    await waitFor(() => expect(setTools).toHaveBeenCalledWith(['view_page']))
    expect(await screen.findByRole('checkbox', { name: 'view_page' })).not.toBeChecked()
    view.unmount()

    vi.spyOn(commands, 'getMcpSettings').mockResolvedValue(settings({ enabled: false }))
    render(<McpPreferences />)
    for (const checkbox of await screen.findAllByRole('checkbox')) {
      expect(checkbox).toHaveAttribute('aria-disabled', 'true')
    }
  })
})
