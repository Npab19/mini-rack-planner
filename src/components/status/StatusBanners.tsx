import {
  CopyPlus,
  HardDrive,
  Lock,
  RefreshCw,
  TriangleAlert,
  X,
  type LucideIcon,
} from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router'
import { toast } from 'sonner'
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button, buttonVariants } from '@/components/ui/button'
import { errorMessage } from '@/db/errors'
import { reloadApp } from '@/state/beforeReload'
import { clearDbStatus, useDbStatus } from '@/state/dbStatus'
import { usePlanStore } from '@/state/planStore'

interface BannerProps {
  icon: LucideIcon
  title: string
  /** alert: needs attention now (announced assertively); status: informational. */
  role: 'alert' | 'status'
  tone?: 'default' | 'destructive'
  children?: ReactNode
  actions?: ReactNode
  onDismiss?: () => void
}

function Banner({
  icon: Icon,
  title,
  role,
  tone = 'default',
  children,
  actions,
  onDismiss,
}: BannerProps) {
  return (
    <Alert variant={tone} role={role}>
      <Icon aria-hidden />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>
        {children}
        {actions === undefined ? null : <div className="mt-2 flex flex-wrap gap-2">{actions}</div>}
      </AlertDescription>
      {onDismiss === undefined ? null : (
        <AlertAction>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={`Dismiss: ${title}`}
            onClick={onDismiss}
          >
            <X />
          </Button>
        </AlertAction>
      )}
    </Alert>
  )
}

type BusyAction = 'copy' | 'reload' | 'retry'

/**
 * A banner that closes takes the focused button with it; move focus to the page's main region
 * instead of letting it fall back to <body> (keyboard and screen-reader users keep their place).
 */
function focusMain(): void {
  const main = document.querySelector('main')
  if (!(main instanceof HTMLElement)) return
  if (!main.hasAttribute('tabindex')) main.setAttribute('tabindex', '-1')
  main.focus({ preventScroll: true })
}

/**
 * Storage and sync problems, rendered at the top of the main content: another tab running a newer
 * (or older, blocking) version, the open plan changed or deleted in another tab, a plan opened
 * read-only because a newer version made it, a full disk and failed saves. Every banner says what
 * happened in words (icons and colour only repeat it) and offers the way out.
 */
export function StatusBanners() {
  const db = useDbStatus()
  const planReady = usePlanStore((state) => state.status === 'ready')
  const conflict = usePlanStore((state) => state.conflict)
  const readOnly = usePlanStore((state) => state.readOnly)
  const saveState = usePlanStore((state) => state.saveState)
  const navigate = useNavigate()
  const [busy, setBusy] = useState<BusyAction | null>(null)

  async function run(action: BusyAction, work: () => Promise<void>): Promise<void> {
    setBusy(action)
    try {
      await work()
    } finally {
      setBusy(null)
    }
  }

  const saveCopy = () =>
    run('copy', async () => {
      try {
        const id = await usePlanStore.getState().saveAsCopy()
        toast.success('Saved as a new plan. You are now editing the copy.')
        await navigate(`/plan/${id}`)
        focusMain()
      } catch (error) {
        toast.error(`Could not save a copy: ${errorMessage(error)}`)
      }
    })

  const reloadPlan = () =>
    run('reload', async () => {
      await usePlanStore.getState().reloadFromDb()
      toast.info('Reloaded the latest saved version.')
      focusMain()
    })

  const retrySave = () =>
    run('retry', async () => {
      if (await usePlanStore.getState().flushSave()) {
        clearDbStatus('write-error')
        toast.success('Your changes are saved.')
        focusMain()
      } else {
        toast.error('Still could not save. Export a backup to keep your work safe.')
      }
    })

  const dismiss = (kind: 'storage-full' | 'write-error') => {
    clearDbStatus(kind)
    focusMain()
  }

  const showConflict = planReady && conflict !== null
  const deleted = conflict?.theirRev === null
  const localChanges = saveState !== 'saved'
  const banners: ReactNode[] = []

  if (db.versionChange) {
    banners.push(
      <Banner
        key="version-change"
        icon={RefreshCw}
        role="alert"
        title="A newer version of the app is open in another tab"
        actions={
          <Button size="sm" onClick={() => void reloadApp()}>
            <RefreshCw aria-hidden />
            Reload
          </Button>
        }
      >
        <p>Reload this tab to keep working with the newer version. Saved plans are kept.</p>
      </Banner>,
    )
  } else if (db.blocked) {
    banners.push(
      <Banner
        key="blocked"
        icon={RefreshCw}
        role="alert"
        title="Another tab is still running an older version"
        actions={
          <Button size="sm" onClick={() => void reloadApp()}>
            <RefreshCw aria-hidden />
            Reload
          </Button>
        }
      >
        <p>Close or reload the other Mini Rack Planner tabs so this one can finish updating.</p>
      </Banner>,
    )
  }

  if (showConflict) {
    banners.push(
      <Banner
        key="conflict"
        icon={TriangleAlert}
        role="alert"
        tone="destructive"
        title={
          deleted ? 'This plan was deleted in another tab' : 'This plan changed in another tab'
        }
        actions={
          <>
            {deleted ? (
              <Link to="/" className={buttonVariants({ size: 'sm', variant: 'outline' })}>
                Back to plans
              </Link>
            ) : (
              <Button size="sm" disabled={busy !== null} onClick={() => void reloadPlan()}>
                <RefreshCw aria-hidden />
                {busy === 'reload' ? 'Reloading…' : 'Reload'}
              </Button>
            )}
            <Button
              size="sm"
              variant={deleted ? 'default' : 'outline'}
              disabled={busy !== null}
              onClick={() => void saveCopy()}
            >
              <CopyPlus aria-hidden />
              {busy === 'copy' ? 'Saving…' : 'Save as a copy'}
            </Button>
          </>
        }
      >
        <p>
          {deleted
            ? 'Save it as a copy to keep it; otherwise it is gone when you leave this page.'
            : localChanges
              ? 'Your latest changes here are not saved. Reload shows the other version; Save as a copy keeps yours as a new plan.'
              : 'Reload to see the latest version.'}
        </p>
      </Banner>,
    )
  }

  if (planReady && readOnly && !showConflict) {
    banners.push(
      <Banner
        key="read-only"
        icon={Lock}
        role="status"
        title="Made with a newer version of Mini Rack Planner, so it opened read-only"
        actions={
          <Button
            size="sm"
            variant="outline"
            disabled={busy !== null}
            onClick={() => void saveCopy()}
          >
            <CopyPlus aria-hidden />
            {busy === 'copy' ? 'Saving…' : 'Save an editable copy'}
          </Button>
        }
      >
        <p>
          Changes cannot be saved here. Open it in the newer version, or save an editable copy
          (details this version does not know about are left out).
        </p>
      </Banner>,
    )
  }

  if (db.storageFull) {
    banners.push(
      <Banner
        key="storage-full"
        icon={HardDrive}
        role="alert"
        tone="destructive"
        title="Browser storage is full"
        onDismiss={() => dismiss('storage-full')}
        actions={
          // Navigation stays a real link (Base UI's Button would give it role="button").
          <Link
            to="/settings#storage"
            className={buttonVariants({ size: 'sm', variant: 'outline' })}
          >
            <HardDrive aria-hidden />
            Settings &gt; Storage
          </Link>
        }
      >
        <p>
          Your latest changes may not be saved. Free up space in Settings &gt; Storage, or export a
          backup.
        </p>
      </Banner>,
    )
  }

  if (db.writeError !== null) {
    const canRetry = planReady && !readOnly && conflict === null && saveState === 'error'
    banners.push(
      <Banner
        key="write-error"
        icon={TriangleAlert}
        role="alert"
        tone="destructive"
        title="Could not save your changes"
        onDismiss={() => dismiss('write-error')}
        actions={
          canRetry ? (
            <Button size="sm" disabled={busy !== null} onClick={() => void retrySave()}>
              <RefreshCw aria-hidden />
              {busy === 'retry' ? 'Saving…' : 'Try again'}
            </Button>
          ) : undefined
        }
      >
        <p>{db.writeError}</p>
      </Banner>,
    )
  }

  if (banners.length === 0) return null
  return (
    <div className="mx-auto flex w-full max-w-screen-2xl flex-col gap-2 px-4 pt-3">{banners}</div>
  )
}
