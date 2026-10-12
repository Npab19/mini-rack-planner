/**
 * My parts (/library): the devices, mounts, panels, shelves and rack frames you added yourself,
 * grouped by kind, with search. Each part can be edited (the "Add a part" editors), duplicated,
 * exported as a catalog entry file, suggested for the shared catalog on GitHub, or deleted (the
 * dialog says which plans use it). The list follows the database live, also changes from other
 * tabs. Results are announced with toasts.
 */
import {
  Copy,
  Ellipsis,
  ExternalLink,
  FileDown,
  Pencil,
  Plus,
  Search,
  Share2,
  ShieldQuestion,
  Trash2,
  TriangleAlert,
} from 'lucide-react'
import { useDeferredValue, useId, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { putLibraryEntry } from '@/db/libraryRepo'
import { errorMessage } from '@/db/errors'
import { duplicateCustomEntry } from '@/domain/customParts'
import type { CatalogEntry } from '@/domain/schema/catalog'
import { useAddPart } from '@/features/custom/addPartStore'
import { takenPartIds } from '@/features/custom/partIds'
import { downloadBlob } from '@/lib/download'
import { useCatalog, useCatalogStore } from '@/state/catalogStore'
import { DeletePartDialog } from './DeletePartDialog'
import {
  canEditPart,
  catalogEntryJson,
  catalogFileName,
  filterLibrary,
  groupLibrary,
  partFacts,
  partName,
} from './libraryModel'
import { SharePartDialog } from './SharePartDialog'

const LINK_CLASS =
  'inline-flex items-center gap-1 rounded-sm text-sm font-medium underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50'

function editRequestKind(entry: CatalogEntry): 'device' | 'item' | 'frame' {
  if (entry.kind === 'device') return 'device'
  if (entry.kind === 'frame') return 'frame'
  return 'item'
}

function openAddPart(): void {
  useAddPart.getState().open({ kind: 'wizard' })
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`
}

interface PartActions {
  edit: (part: CatalogEntry) => void
  duplicate: (part: CatalogEntry) => void
  exportEntry: (part: CatalogEntry) => void
  share: (part: CatalogEntry) => void
  remove: (part: CatalogEntry) => void
}

function PartCard({ part, actions }: { part: CatalogEntry; actions: PartActions }) {
  const titleId = useId()
  const name = partName(part)
  const url = part.source?.url
  const unverified = part.verified?.method === 'unverified'
  return (
    <article
      aria-labelledby={titleId}
      data-testid={`part-${part.id}`}
      className="flex h-full flex-col gap-2 rounded-xl bg-card p-4 text-sm ring-1 ring-foreground/10"
    >
      <div className="flex items-start gap-2">
        <h3 id={titleId} className="min-w-0 flex-1 text-base leading-snug font-medium break-words">
          {name}
        </h3>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`More actions for ${name}`}
                className="-mt-1 -mr-1"
              />
            }
          >
            <Ellipsis aria-hidden />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-64">
            <DropdownMenuItem onClick={() => actions.exportEntry(part)}>
              <FileDown aria-hidden />
              <span className="grid">
                <span>Export as catalog entry</span>
                <span className="text-xs text-muted-foreground">
                  A JSON file to submit on GitHub
                </span>
              </span>
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => actions.share(part)}>
              <Share2 aria-hidden />
              Share with everyone…
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={() => actions.remove(part)}>
              <Trash2 aria-hidden />
              Delete…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <p className="text-muted-foreground">{partFacts(part)}</p>
      {unverified || url !== undefined ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          {unverified ? (
            <Badge
              variant="outline"
              className="border-dashed"
              title="Its sizes are not checked yet: measure before you print or buy."
            >
              <ShieldQuestion aria-hidden />
              Unverified
            </Badge>
          ) : null}
          {url === undefined ? null : (
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`Open page for ${name} (opens in a new tab)`}
              className={LINK_CLASS}
            >
              Open page
              <ExternalLink aria-hidden className="size-3.5" />
            </a>
          )}
        </div>
      ) : null}
      <div className="mt-auto flex flex-wrap gap-2 pt-1">
        {canEditPart(part) ? (
          <Button
            variant="outline"
            size="sm"
            aria-label={`Edit ${name}`}
            onClick={() => actions.edit(part)}
          >
            <Pencil aria-hidden />
            Edit
          </Button>
        ) : null}
        <Button
          variant="outline"
          size="sm"
          aria-label={`Duplicate ${name}`}
          onClick={() => actions.duplicate(part)}
        >
          <Copy aria-hidden />
          Duplicate
        </Button>
      </div>
    </article>
  )
}

function EmptyLibrary() {
  const headingId = useId()
  return (
    <section
      aria-labelledby={headingId}
      className="grid gap-3 rounded-xl border border-dashed p-5 text-sm sm:p-6"
    >
      <h2 id={headingId} className="text-lg font-medium">
        You have no parts of your own yet
      </h2>
      <p>
        When a device, a printed mount or a rack is missing from the shared catalog, add it here:
        its size, how it mounts, what it holds, and the prints and hardware it needs.
      </p>
      <ul className="grid list-disc gap-1 pl-5 text-muted-foreground">
        <li>Your parts show up in the editor’s parts list under “My parts”.</li>
        <li>They count in the bill of materials and the shopping list like any other part.</li>
        <li>
          They are saved in this browser and go with your backups. “Share with everyone” suggests
          one for the shared catalog.
        </li>
      </ul>
      <Button className="w-fit" onClick={openAddPart}>
        <Plus aria-hidden />
        Add a part
      </Button>
    </section>
  )
}

function LoadingLibrary() {
  return (
    <div role="status" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <span className="sr-only">Loading your parts…</span>
      {[0, 1, 2].map((index) => (
        <Skeleton key={index} className="h-36 rounded-xl" />
      ))}
    </div>
  )
}

export function LibraryPage() {
  const { lookup, problems } = useCatalog()
  const library = useCatalogStore((state) => state.library)
  const loaded = useCatalogStore((state) => state.libraryLoaded)
  const [query, setQuery] = useState('')
  const deferredQuery = useDeferredValue(query)
  const [deleting, setDeleting] = useState<CatalogEntry | null>(null)
  const [sharing, setSharing] = useState<CatalogEntry | null>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const searchId = useId()
  // The whole library could not be read (storage unavailable), or single rows could not.
  const loadProblem = problems.find((problem) => problem.path === 'library')
  const rowProblems = problems.filter((problem) => problem.path.startsWith('library/'))

  const matches = useMemo(() => filterLibrary(library, deferredQuery), [library, deferredQuery])
  const groups = useMemo(() => groupLibrary(matches), [matches])

  async function exportEntry(part: CatalogEntry): Promise<void> {
    const fileName = catalogFileName(part)
    try {
      const blob = new Blob([catalogEntryJson(part)], { type: 'application/json' })
      const outcome = await downloadBlob(fileName, blob)
      if (outcome === 'cancelled') return
      toast.success(
        `${outcome === 'saved' ? 'Saved' : 'Downloaded'} ${fileName}. To suggest it for the shared catalog, use Share with everyone, or attach the file to a catalog submission on GitHub.`,
      )
    } catch (error) {
      toast.error(`Could not export “${partName(part)}”: ${errorMessage(error)}`)
    }
  }

  async function duplicate(part: CatalogEntry): Promise<void> {
    try {
      const copy = duplicateCustomEntry(part, await takenPartIds())
      const stored = await putLibraryEntry(copy)
      toast.success(`Duplicated as “${partName(stored)}”.`)
    } catch (error) {
      toast.error(`Could not duplicate “${partName(part)}”: ${errorMessage(error)}`)
    }
  }

  const actions: PartActions = {
    edit: (part) => useAddPart.getState().open({ kind: editRequestKind(part), editId: part.id }),
    duplicate: (part) => void duplicate(part),
    exportEntry: (part) => void exportEntry(part),
    share: setSharing,
    remove: setDeleting,
  }

  const trimmed = deferredQuery.trim()
  const countText =
    trimmed === ''
      ? plural(library.length, 'part')
      : `${matches.length} of ${plural(library.length, 'part')} ${matches.length === 1 ? 'matches' : 'match'} “${trimmed}”`

  let content
  if (!loaded) {
    content = <LoadingLibrary />
  } else if (library.length === 0) {
    content = <EmptyLibrary />
  } else {
    content = (
      <div className="grid gap-6">
        <div className="grid gap-1.5 sm:max-w-sm">
          <label htmlFor={searchId} className="sr-only">
            Search your parts
          </label>
          <div className="relative">
            <Search
              aria-hidden
              className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              id={searchId}
              type="search"
              value={query}
              placeholder="Search your parts…"
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setQuery(event.target.value)}
              className="pl-8"
            />
          </div>
          <p role="status" className="text-xs text-muted-foreground">
            {countText}
          </p>
        </div>
        {groups.length === 0 ? (
          <p className="text-sm text-muted-foreground">No part matches “{trimmed}”.</p>
        ) : (
          groups.map((group) => (
            <section
              key={group.id}
              aria-labelledby={`${searchId}-${group.id}`}
              className="grid gap-3"
            >
              <h2 id={`${searchId}-${group.id}`} className="text-lg font-medium">
                {group.title}{' '}
                <span className="text-sm font-normal text-muted-foreground">
                  ({group.entries.length})
                </span>
              </h2>
              <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {group.entries.map((part) => (
                  <li key={part.id}>
                    <PartCard part={part} actions={actions} />
                  </li>
                ))}
              </ul>
            </section>
          ))
        )}
      </div>
    )
  }

  return (
    <div className="mx-auto flex w-full max-w-screen-lg flex-col gap-6 px-4 py-6 sm:px-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="grid gap-1">
          <h1
            ref={headingRef}
            tabIndex={-1}
            className="text-2xl font-semibold tracking-tight outline-none"
          >
            My parts
          </h1>
          <p className="text-sm text-muted-foreground">
            Devices, mounts and racks you added yourself. Saved in this browser, never uploaded.
          </p>
        </div>
        {loaded && library.length > 0 ? (
          <Button onClick={openAddPart}>
            <Plus aria-hidden />
            Add a part
          </Button>
        ) : null}
      </header>

      {loadProblem === undefined ? null : (
        <Alert variant="destructive">
          <TriangleAlert aria-hidden />
          <AlertTitle>Your parts could not be loaded</AlertTitle>
          <AlertDescription>
            <p>{loadProblem.message}</p>
            <p>
              Your parts are kept in this browser’s storage. A private window or blocked site data
              can make it unavailable.
            </p>
          </AlertDescription>
        </Alert>
      )}
      {rowProblems.length === 0 ? null : (
        <Alert variant="destructive">
          <TriangleAlert aria-hidden />
          <AlertTitle>{plural(rowProblems.length, 'part')} could not be read</AlertTitle>
          <AlertDescription>
            <p>
              They are kept as they are in this browser. A newer version of Mini Rack Planner may
              have saved them.
            </p>
            <ul className="list-disc pl-4">
              {rowProblems.slice(0, 5).map((problem) => (
                <li key={problem.path}>
                  {problem.path.slice('library/'.length)}: {problem.message}
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}

      {content}

      <DeletePartDialog
        part={deleting}
        onClose={() => setDeleting(null)}
        afterDelete={headingRef}
      />
      <SharePartDialog
        part={sharing}
        catalog={lookup}
        onClose={() => setSharing(null)}
        onDownload={(part) => void exportEntry(part)}
      />
    </div>
  )
}
