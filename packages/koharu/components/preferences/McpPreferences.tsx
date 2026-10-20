'use client'

import type { TFunction } from 'i18next'
import { FolderOpen, RotateCcw } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  PreferencePage,
  PreferenceRow,
  PreferenceSection,
} from '@/components/preferences/PreferenceFields'
import { call } from '@/lib/backend'
import { useKoharuStore } from '@/lib/store'
import {
  commands,
  type McpSettings,
  type ServerStatus,
  type ToolGroup,
} from '@koharu/bridge/protocol'
import { Button } from '@koharu/ui/components/button'
import { Checkbox } from '@koharu/ui/components/checkbox'
import { Switch } from '@koharu/ui/components/switch'

const groups: readonly ToolGroup[] = ['read', 'pages', 'text', 'image', 'pipeline', 'output']

export function McpPreferences() {
  const { t } = useTranslation()
  const status = useKoharuStore((state) => state.mcpStatus)
  const [settings, setSettings] = useState<McpSettings | null>(null)

  useEffect(() => {
    void call(commands.getMcpSettings)
      .then(setSettings)
      .catch(() => undefined)
  }, [])

  if (!settings) {
    return <p className='py-10 text-[12px] text-muted-foreground'>{t('settings.loading')}</p>
  }

  const apply = (request: Promise<McpSettings>) =>
    void request.then(setSettings).catch(() => undefined)
  // Starting and stopping run one at a time, so the switch waits for each.
  const transitioning = status.state === 'starting' || status.state === 'stopping'
  const serving = status.state === 'starting' || status.state === 'running'
  const disabled = new Set(settings.config.disabled_tools)
  const toggleTool = (name: string, enabled: boolean) => {
    const next = new Set(disabled)
    if (enabled) next.delete(name)
    else next.add(name)
    apply(call(commands.setMcpTools, [...next]))
  }

  return (
    <PreferencePage title={t('settings.mcp.title')} description={t('settings.mcp.description')}>
      <PreferenceSection
        title={t('settings.mcp.server')}
        description={t('settings.mcp.serverDescription')}
      >
        <PreferenceRow title={t('settings.mcp.enable')} description={statusText(status, t)}>
          <div className='flex h-8 items-center justify-end gap-2'>
            {status.state === 'stopping' && (
              <Button
                type='button'
                size='sm'
                variant='outline'
                onClick={() => void call(commands.stopMcpNow).catch(() => undefined)}
              >
                {t('settings.mcp.stopNow')}
              </Button>
            )}
            {status.state === 'failed' && (
              <Button
                type='button'
                size='sm'
                variant='outline'
                onClick={() => apply(call(commands.setMcpEnabled, true))}
              >
                {t('settings.mcp.retry')}
              </Button>
            )}
            <Switch
              aria-label={t('settings.mcp.enable')}
              checked={serving}
              disabled={transitioning}
              onCheckedChange={(enabled) => apply(call(commands.setMcpEnabled, enabled))}
            />
          </div>
        </PreferenceRow>
        <PreferenceRow
          title={t('settings.mcp.exportFolder')}
          description={t('settings.mcp.exportFolderDescription')}
        >
          <div className='flex min-w-0 items-center justify-end gap-1.5'>
            <span
              className='min-w-0 truncate text-[11px] text-muted-foreground'
              title={settings.export_folder}
            >
              {settings.export_folder}
            </span>
            <Button
              type='button'
              size='sm'
              variant='outline'
              onClick={() => apply(call(commands.chooseMcpExportFolder))}
            >
              <FolderOpen /> {t('settings.mcp.chooseFolder')}
            </Button>
            {settings.config.export_dir !== null && (
              <Button
                type='button'
                size='icon-sm'
                variant='ghost'
                aria-label={t('settings.mcp.defaultFolder')}
                title={t('settings.mcp.defaultFolder')}
                onClick={() => apply(call(commands.resetMcpExportFolder))}
              >
                <RotateCcw />
              </Button>
            )}
          </div>
        </PreferenceRow>
      </PreferenceSection>

      <PreferenceSection
        title={t('settings.mcp.tools')}
        description={t('settings.mcp.toolsDescription')}
      >
        {groups.map((group) => {
          const tools = settings.tools.filter((tool) => tool.metadata.group === group)
          if (tools.length === 0) return null
          return (
            <div key={group} className='py-3'>
              <p className='mb-2 text-[10px] font-semibold tracking-[0.12em] text-muted-foreground uppercase'>
                {t(`settings.mcp.groups.${group}`)}
              </p>
              <ul className='grid gap-2'>
                {tools.map((tool) => (
                  <li key={tool.name}>
                    <label className='flex w-fit items-center gap-2.5 text-[12px]'>
                      <Checkbox
                        checked={!disabled.has(tool.name)}
                        disabled={!settings.config.enabled}
                        onCheckedChange={(enabled) => toggleTool(tool.name, enabled)}
                      />
                      <span className='font-mono text-[11px]'>{tool.name}</span>
                    </label>
                  </li>
                ))}
              </ul>
            </div>
          )
        })}
      </PreferenceSection>
    </PreferencePage>
  )
}

function statusText(status: ServerStatus, t: TFunction): string {
  switch (status.state) {
    case 'off':
      return t('settings.mcp.status.off')
    case 'starting':
      return t('settings.mcp.status.starting')
    case 'running': {
      const address = new URL(status.url).host
      return status.clients > 0
        ? t('settings.mcp.status.runningWithClients', { address, count: status.clients })
        : t('settings.mcp.status.running', { address })
    }
    case 'stopping':
      return t('settings.mcp.status.stopping', { count: status.tasks })
    case 'failed':
      return t('settings.mcp.status.failed', { message: status.message })
  }
}
