'use client'

import type { TFunction } from 'i18next'
import { Check, FolderOpen, Info, RotateCcw, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  PreferencePage,
  PreferenceRow,
  PreferenceSection,
} from '@/components/preferences/PreferenceFields'
import { call } from '@/lib/backend'
import { usePages, useProject } from '@/lib/queries'
import { useKoharuStore } from '@/lib/store'
import {
  commands,
  type McpSettings,
  type McpTool,
  type PageSummary,
  type ServerStatus,
  type ToolActivity,
  type ToolGroup,
  type ToolProfile,
} from '@koharu/bridge/protocol'
import { Badge } from '@koharu/ui/components/badge'
import { Button } from '@koharu/ui/components/button'
import { Checkbox } from '@koharu/ui/components/checkbox'
import { Switch } from '@koharu/ui/components/switch'
import { Tooltip, TooltipContent, TooltipTrigger } from '@koharu/ui/components/tooltip'

const groups: readonly ToolGroup[] = ['read', 'pages', 'text', 'image', 'pipeline', 'output']
const profiles: readonly ToolProfile[] = ['vision', 'text', 'read', 'custom']
type ToolLabel = 'needsVision' | 'betterWithVision' | 'editsImage' | 'deletes'

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
  const { enabled, profile } = settings.config
  // Changing one tool keeps every other tool as it is and makes the selection custom.
  const toggleTool = (name: string, on: boolean) => {
    const off = new Set(settings.tools.filter((tool) => !tool.enabled).map((tool) => tool.name))
    if (on) off.delete(name)
    else off.add(name)
    apply(call(commands.setMcpTools, 'custom', [...off]))
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
              onCheckedChange={(on) => apply(call(commands.setMcpEnabled, on))}
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
        <PreferenceRow
          title={t('settings.mcp.profile')}
          description={t('settings.mcp.profileDescription')}
          align='start'
        >
          <div className='grid gap-1.5'>
            <div className='grid grid-cols-2 gap-0.5 rounded-xl border border-input bg-background p-0.5'>
              {profiles.map((choice) => (
                <Button
                  key={choice}
                  type='button'
                  variant='ghost'
                  size='sm'
                  disabled={!enabled}
                  aria-pressed={profile === choice}
                  data-active={profile === choice}
                  className='h-8 text-[10px] text-muted-foreground hover:text-foreground data-[active=true]:bg-primary data-[active=true]:text-primary-foreground data-[active=true]:hover:bg-primary/90 data-[active=true]:hover:text-primary-foreground'
                  onClick={() =>
                    apply(call(commands.setMcpTools, choice, settings.config.disabled_tools))
                  }
                >
                  {t(`settings.mcp.profiles.${choice}`)}
                </Button>
              ))}
            </div>
            <p className='text-[10px] leading-4 text-muted-foreground'>
              {t(`settings.mcp.profileHints.${profile}`)}
            </p>
          </div>
        </PreferenceRow>
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
                  <ToolRow
                    key={tool.name}
                    tool={tool}
                    disabled={!enabled}
                    onToggle={(on) => toggleTool(tool.name, on)}
                  />
                ))}
              </ul>
            </div>
          )
        })}
      </PreferenceSection>

      <ActivityLog />
    </PreferencePage>
  )
}

function ActivityLog() {
  const { t } = useTranslation()
  const activity = useKoharuStore((state) => state.mcpActivity)
  const project = useProject().data
  const pages = usePages(Boolean(project)).data ?? []
  return (
    <PreferenceSection
      title={t('settings.mcp.activity')}
      description={t('settings.mcp.activityDescription')}
      action={
        <Button
          type='button'
          size='sm'
          variant='outline'
          disabled={activity.length === 0}
          onClick={() => void call(commands.clearMcpActivity).catch(() => undefined)}
        >
          {t('settings.mcp.clearActivity')}
        </Button>
      }
    >
      {activity.length === 0 ? (
        <p className='py-4 text-[11px] text-muted-foreground'>{t('settings.mcp.noActivity')}</p>
      ) : (
        <ol aria-label={t('settings.mcp.activity')} className='max-h-80 overflow-y-auto py-2'>
          {activity
            .map((entry, index) => (
              <ActivityRow key={`${entry.finished_at}-${index}`} entry={entry} pages={pages} />
            ))
            .reverse()}
        </ol>
      )}
    </PreferenceSection>
  )
}

function ActivityRow({ entry, pages }: { entry: ToolActivity; pages: PageSummary[] }) {
  const { t } = useTranslation()
  const finished = new Date(entry.finished_at)
  const index = pages.findIndex((page) => page.id === entry.page)
  const page =
    index >= 0
      ? t('settings.mcp.page', { number: index + 1, label: pages[index].label })
      : entry.page?.slice(0, 8)
  return (
    <li className='grid grid-cols-[4.5rem_minmax(0,1fr)] gap-x-3 py-1.5 text-[11px]'>
      <time dateTime={finished.toISOString()} className='text-muted-foreground tabular-nums'>
        {finished.toLocaleTimeString()}
      </time>
      <div className='min-w-0'>
        <div className='flex flex-wrap items-center gap-x-2'>
          {entry.ok ? (
            <Check aria-hidden='true' className='size-3.5 text-primary' />
          ) : (
            <X aria-hidden='true' className='size-3.5 text-destructive' />
          )}
          <span className='sr-only'>
            {entry.ok ? t('settings.mcp.succeeded') : t('settings.mcp.failed')}
          </span>
          <span className='font-mono'>{entry.tool}</span>
          {page && <span className='text-muted-foreground'>{page}</span>}
          <span className='text-muted-foreground tabular-nums'>
            {t('settings.mcp.seconds', { value: (entry.elapsed_ms / 1000).toFixed(1) })}
          </span>
        </div>
        {entry.error && <p className='mt-0.5 break-words text-destructive'>{entry.error}</p>}
      </div>
    </li>
  )
}

function ToolRow({
  tool,
  disabled,
  onToggle,
}: {
  tool: McpTool
  disabled: boolean
  onToggle: (on: boolean) => void
}) {
  const { t } = useTranslation()
  const info = t(`settings.mcp.toolInfo.${tool.name}`, { defaultValue: '' })
  return (
    <li className='flex flex-wrap items-center gap-x-2 gap-y-1'>
      <label className='flex items-center gap-2.5'>
        <Checkbox checked={tool.enabled} disabled={disabled} onCheckedChange={onToggle} />
        <span className='font-mono text-[11px]'>{tool.name}</span>
      </label>
      {info && (
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type='button'
                aria-label={t('settings.mcp.aboutTool', { tool: tool.name })}
                className='grid size-4 place-items-center rounded-full text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none'
              />
            }
          >
            <Info className='size-3.5' />
          </TooltipTrigger>
          <TooltipContent className='max-w-72 text-[11px] leading-4'>{info}</TooltipContent>
        </Tooltip>
      )}
      <span className='text-[11px] text-muted-foreground'>
        {t(`settings.mcp.toolSummary.${tool.name}`, { defaultValue: '' })}
      </span>
      {toolLabels(tool).map((label) => (
        <Tooltip key={label}>
          <TooltipTrigger
            render={<Badge variant='outline' className='h-4.5 px-1.5 text-[9px] font-normal' />}
          >
            {t(`settings.mcp.labels.${label}`)}
          </TooltipTrigger>
          <TooltipContent className='max-w-64 text-[11px] leading-4'>
            {t(`settings.mcp.labelInfo.${label}`)}
          </TooltipContent>
        </Tooltip>
      ))}
    </li>
  )
}

function toolLabels({ metadata }: McpTool): ToolLabel[] {
  const labels: ToolLabel[] = []
  if (metadata.vision === 'required') labels.push('needsVision')
  if (metadata.vision === 'better') labels.push('betterWithVision')
  if (metadata.mutates_image) labels.push('editsImage')
  if (metadata.destructive) labels.push('deletes')
  return labels
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
