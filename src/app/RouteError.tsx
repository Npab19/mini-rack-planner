import { isRouteErrorResponse, useRouteError } from 'react-router'
import { Button } from '@/components/ui/button'

/** True when a lazy chunk from an older deploy is gone (common right after an update). */
function isStaleChunkError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|MIME type/i.test(
    message,
  )
}

export function RouteError() {
  const error = useRouteError()
  const stale = isStaleChunkError(error)
  const title = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`
    : stale
      ? 'A new version is available'
      : 'Something went wrong'

  return (
    <div role="alert" className="mx-auto flex max-w-lg flex-col gap-4 p-8">
      <h1 className="text-xl font-semibold">{title}</h1>
      <p className="text-sm text-muted-foreground">
        {stale
          ? 'The app was updated while this tab was open. Reload to continue — your plans are stored in this browser and are not lost.'
          : 'This part of the app hit an error. Your saved plans are not affected.'}
      </p>
      {!stale && error instanceof Error ? (
        <pre className="overflow-auto rounded-md bg-muted p-3 text-xs">{error.message}</pre>
      ) : null}
      <div>
        <Button onClick={() => window.location.reload()}>Reload</Button>
      </div>
    </div>
  )
}
