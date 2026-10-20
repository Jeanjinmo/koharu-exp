'use client'

import type { TFunction } from 'i18next'
import { HardDrive, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { call } from '@/lib/backend'
import { formatBytes } from '@/lib/format'
import { pageKey, pagesKey, projectKey, refresh, usePages, useProject } from '@/lib/queries'
import { useKoharuStore } from '@/lib/store'
import { commands, type DiskSpace } from '@koharu/bridge/protocol'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from '@koharu/ui/components/alert-dialog'
import { Checkbox } from '@koharu/ui/components/checkbox'
import { toast } from '@koharu/ui/components/toast'

/** The confirmation dialogs for cleaning up the open project, opened from menus. */
export function ProjectCleanupDialogs() {
  const cleanup = useKoharuStore((state) => state.cleanup)
  const setCleanup = useKoharuStore((state) => state.setCleanup)
  const close = () => setCleanup(null)
  return (
    <>
      <ClearProjectDialog open={cleanup === 'clear'} onClose={close} />
      <FreeSpaceDialog open={cleanup === 'free-space'} onClose={close} />
    </>
  )
}

/** Deletes stored content that only earlier versions use. */
export async function freeDiskSpace(t: TFunction) {
  const freed = await call(commands.freeDiskSpace)
  await refresh(projectKey)
  toast.add({
    type: 'success',
    title: t('cleanup.freed', { size: formatBytes(freed.bytes) }),
  })
}

/** Deletes every page in one undoable step; the project itself stays. */
function ClearProjectDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation()
  const project = useProject().data
  const pages = usePages(Boolean(project)).data ?? []
  const selectPages = useKoharuStore((state) => state.selectPages)
  const selectLayers = useKoharuStore((state) => state.selectLayers)
  const [freeSpace, setFreeSpace] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (open) setFreeSpace(false)
  }, [open])

  const clear = async () => {
    await call(
      commands.deletePages,
      pages.map((page) => page.id),
    )
    selectPages([])
    selectLayers([])
    await refresh(projectKey, pagesKey, pageKey)
    if (freeSpace) await freeDiskSpace(t)
  }

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) onClose()
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogMedia className='bg-destructive/10 text-destructive'>
            <Trash2 className='size-5' />
          </AlertDialogMedia>
          <AlertDialogTitle>{t('cleanup.clearTitle')}</AlertDialogTitle>
          <AlertDialogDescription>
            {t('cleanup.clearDescription', { count: pages.length, name: project?.name ?? '' })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <label className='flex items-start gap-2.5 text-[12px]'>
          <Checkbox
            checked={freeSpace}
            disabled={busy}
            className='mt-0.5'
            onCheckedChange={setFreeSpace}
          />
          <span className='grid gap-0.5'>
            <span>{t('cleanup.alsoFreeSpace')}</span>
            <span className='text-[11px] text-muted-foreground'>
              {t('cleanup.alsoFreeSpaceHint')}
            </span>
          </span>
        </label>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>{t('common.cancel')}</AlertDialogCancel>
          <AlertDialogAction
            variant='destructive'
            disabled={busy || pages.length === 0}
            aria-busy={busy}
            onClick={() => {
              setBusy(true)
              void clear()
                .then(onClose)
                .catch(() => undefined)
                .finally(() => setBusy(false))
            }}
          >
            {t('cleanup.clearAction')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

function FreeSpaceDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation()
  const project = useProject().data
  const [estimate, setEstimate] = useState<DiskSpace | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    setEstimate(null)
    void call(commands.getReclaimableSpace)
      .then(setEstimate)
      .catch(() => undefined)
  }, [open])

  const estimateText =
    estimate === null
      ? t('cleanup.measuring')
      : estimate.files === 0
        ? t('cleanup.nothingToFree')
        : t('cleanup.freeSpaceEstimate', { size: formatBytes(estimate.bytes) })

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) onClose()
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogMedia className='bg-destructive/10 text-destructive'>
            <HardDrive className='size-5' />
          </AlertDialogMedia>
          <AlertDialogTitle>{t('cleanup.freeSpaceTitle')}</AlertDialogTitle>
          <AlertDialogDescription>
            {t('cleanup.freeSpaceDescription', { name: project?.name ?? '' })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className='grid gap-1 text-[12px]'>
          <p role='status'>{estimateText}</p>
          <p className='font-medium text-destructive'>{t('cleanup.cannotUndo')}</p>
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>{t('common.cancel')}</AlertDialogCancel>
          <AlertDialogAction
            variant='destructive'
            disabled={busy || estimate === null || estimate.files === 0}
            aria-busy={busy}
            onClick={() => {
              setBusy(true)
              void freeDiskSpace(t)
                .then(onClose)
                .catch(() => undefined)
                .finally(() => setBusy(false))
            }}
          >
            {t('cleanup.freeSpaceAction')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
