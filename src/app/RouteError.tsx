import { RefreshCw } from 'lucide-react'
import { useEffect } from 'react'
import { isRouteErrorResponse, useRouteError } from 'react-router'
import { CopyDiagnosticsButton } from '@/components/common/ErrorBoundary'
import { Button } from '@/components/ui/button'
import * as diagnostics from '@/lib/diagnostics'
import { isStaleChunkError, isUpdatePending, notifyNewVersion, reloadApp } from './updatePrompt'

/** Root route error page: replaces the whole layout when a route fails to load or render. */
export function RouteError() {
  const error = useRouteError()
  const response = isRouteErrorResponse(error)
  // Once a chunk failed to preload, Vite resolves that import to undefined, so the route fails
  // with a TypeError instead: any route error after that is the stale build.
  const stale = !response && (isStaleChunkError(error) || isUpdatePending())

  useEffect(() => {
    if (stale) notifyNewVersion({ source: 'route', error })
    else if (isRouteErrorResponse(error)) {
      diagnostics.record({
        kind: 'warning',
        message: `Route error response ${error.status} ${error.statusText}`,
        source: 'route',
      })
    } else diagnostics.recordError(error, { source: 'route' })
  }, [error, stale])

  const title = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`
    : stale
      ? 'A new version is available'
      : 'Something went wrong'

  return (
    <main className="mx-auto flex w-full max-w-lg flex-col gap-4 p-6 sm:p-8">
      <div role="alert" className="flex flex-col gap-2">
        <h1 className="text-xl font-semibold">{title}</h1>
        <p className="text-sm text-muted-foreground">
          {stale
            ? 'The app was updated while this tab was open. Reload to continue — your plans are stored in this browser and are not lost.'
            : 'This part of the app hit an error. Your saved plans are not affected.'}
        </p>
      </div>
      {!stale && error instanceof Error ? (
        <pre className="overflow-auto rounded-md bg-muted p-3 text-xs break-words whitespace-pre-wrap">
          {error.message}
        </pre>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" onClick={() => void reloadApp()}>
          <RefreshCw aria-hidden="true" />
          Reload
        </Button>
        <CopyDiagnosticsButton />
      </div>
    </main>
  )
}
