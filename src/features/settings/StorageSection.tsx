import {
  LockOpen,
  ShieldAlert,
  ShieldCheck,
  ShieldOff,
  ShieldQuestionMark,
  type LucideIcon,
} from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  getStorageStatus,
  requestPersist,
  type PersistResult,
  type StorageStatus,
} from '@/lib/storage'
import { formatBytes, formatShare } from './format'
import { SettingsSection } from './SettingsSection'

type PersistRequest =
  { state: 'idle' } | { state: 'asking' } | { state: 'done'; result: PersistResult }

function persistMessage(result: PersistResult): string {
  if (result === 'unsupported') return 'This browser cannot be asked on this address.'
  return result
    ? 'Done: this browser will keep your data.'
    : 'The browser said no for now. It may agree later as you use the app more; until then, export a backup now and then.'
}

function Fact({ icon: Icon, children }: { icon: LucideIcon; children: ReactNode }) {
  return (
    <span className="flex items-start gap-1.5">
      <Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <span>{children}</span>
    </span>
  )
}

/** Plain-HTTP origins lack the API by design; on HTTPS only an old browser does. */
function unavailable(status: StorageStatus): string {
  return status.secureContext ? 'Not available in this browser.' : 'Not available on this address.'
}

function PersistedFact({ status }: { status: StorageStatus }) {
  if (!status.supported) return <Fact icon={ShieldOff}>{unavailable(status)}</Fact>
  if (status.persisted === true) {
    return <Fact icon={ShieldCheck}>Yes. The browser will not clear it to free up space.</Fact>
  }
  if (status.persisted === false) {
    return (
      <Fact icon={ShieldAlert}>
        Not yet. The browser may clear it when space runs low, and Safari after 7 days without a
        visit.
      </Fact>
    )
  }
  return <Fact icon={ShieldQuestionMark}>Unknown: this browser did not say.</Fact>
}

function UsageFact({ status }: { status: StorageStatus }) {
  const { usage, quota } = status
  if (usage === undefined) {
    return <>{status.supported ? 'Unknown.' : unavailable(status)}</>
  }
  if (quota === undefined || quota <= 0) return <>{formatBytes(usage)}</>
  const share = Math.min(1, Math.max(0, usage / quota))
  return (
    <span className="flex flex-col gap-1.5">
      <span>
        {formatBytes(usage)} of {formatBytes(quota)} ({formatShare(usage, quota)})
      </span>
      {/* Decoration only: the text above says the same. */}
      <span aria-hidden="true" className="block h-1.5 w-full max-w-60 rounded-full bg-muted">
        <span
          className="block h-full rounded-full bg-primary"
          style={{ width: `${Math.max(share * 100, share > 0 ? 2 : 0)}%` }}
        />
      </span>
    </span>
  )
}

/**
 * Where the data lives and how safe it is: whether the browser promised to keep it (with "Keep my
 * data"), how much space it uses, and the origin it belongs to. Everything is feature-detected:
 * plain-HTTP LAN origins have no `navigator.storage`, and that is explained rather than hidden.
 */
export function StorageSection() {
  const [status, setStatus] = useState<StorageStatus | undefined>(undefined)
  const [request, setRequest] = useState<PersistRequest>({ state: 'idle' })

  useEffect(() => {
    let active = true
    void getStorageStatus().then((next) => {
      if (active) setStatus(next)
    })
    return () => {
      active = false
    }
  }, [])

  async function keepMyData(): Promise<void> {
    setRequest({ state: 'asking' })
    let result: PersistResult
    try {
      result = await requestPersist()
    } catch {
      result = false
    }
    setRequest({ state: 'done', result })
    const next = await getStorageStatus()
    // The button goes away once the data is kept: move focus to the section instead of <body>.
    if (next.persisted === true) document.getElementById('storage-heading')?.focus()
    setStatus(next)
  }

  const canAsk = status !== undefined && status.supported && status.persisted !== true

  return (
    <SettingsSection
      id="storage"
      title="Storage"
      description="Plans, parts and settings are saved in this browser, for this address only. Nothing is uploaded."
    >
      {status === undefined ? (
        <p className="text-muted-foreground">Checking storage…</p>
      ) : (
        <>
          <dl className="grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-[auto_1fr] sm:gap-y-3">
            <dt className="font-medium">Kept safe</dt>
            <dd className="mb-2 sm:mb-0">
              <PersistedFact status={status} />
            </dd>
            <dt className="font-medium">Space used</dt>
            <dd className="mb-2 sm:mb-0">
              <UsageFact status={status} />
            </dd>
            <dt className="font-medium">This address</dt>
            <dd>
              <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs break-all">
                {status.origin || 'unknown'}
              </code>
            </dd>
          </dl>

          {canAsk ? (
            <div className="flex flex-col gap-2">
              <div>
                {/* Firefox shows a prompt meanwhile: the button keeps focus while it waits. */}
                <Button
                  type="button"
                  variant="outline"
                  disabled={request.state === 'asking'}
                  focusableWhenDisabled
                  aria-busy={request.state === 'asking' || undefined}
                  onClick={() => void keepMyData()}
                >
                  <ShieldCheck aria-hidden="true" />
                  {request.state === 'asking' ? 'Asking the browser…' : 'Keep my data'}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Asks the browser not to clear this site&apos;s data when space runs low. Firefox
                asks you; Chrome, Edge and Safari decide on their own without asking, for example
                from how much you use the site.
              </p>
            </div>
          ) : null}
          {/* Rendered while empty (a live region must exist before its text changes); the
              negative margin cancels the empty row's extra gap without hiding it from screen
              readers the way display:none would. */}
          <p role="status" className="empty:-mt-4">
            {request.state === 'done' ? persistMessage(request.result) : ''}
          </p>

          <p className="text-muted-foreground">
            Each address keeps its own, separate data, even in the same browser: localhost, a LAN
            address such as <span className="whitespace-nowrap">http://192.168.1.20:8080</span>, the
            Azure site and your own domain all start empty. To move plans between them, export a
            backup here and import it there (
            <a
              href="#backup"
              className="rounded-sm underline underline-offset-3 outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              Backup
            </a>
            ).
          </p>

          {status.secureContext ? null : (
            <Alert role="note">
              <LockOpen aria-hidden="true" />
              <AlertTitle>This address uses plain HTTP, so some features are limited</AlertTitle>
              <AlertDescription>
                <ul className="list-disc space-y-1 pl-4">
                  <li>
                    Keep my data and the space estimate are not available, so export a backup
                    regularly.
                  </li>
                  <li>Copy buttons may show the text for you to copy by hand.</li>
                  <li>Files go straight to your downloads instead of a Save dialog.</li>
                  <li>Plans, parts and settings still save as usual.</li>
                </ul>
                <p className="mt-2">Open the app over HTTPS or on localhost for everything.</p>
              </AlertDescription>
            </Alert>
          )}
        </>
      )}
    </SettingsSection>
  )
}
