/**
 * "Share with everyone": suggests a part for the shared catalog through GitHub's catalog
 * submission form, opened in a new tab (a plain link: the app sends nothing itself). Says first
 * what the catalog's reviewers will ask for, and when the entry is too long for the link, offers
 * the file to attach instead.
 */
import { Download, ExternalLink, Info, TriangleAlert } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Button, buttonVariants } from '@/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import type { CatalogEntry, CatalogLookup } from '@/domain/schema/catalog'
import { partName, shareLink, shareReport } from './libraryModel'

function ShareBody({
  part,
  catalog,
  onDownload,
}: {
  part: CatalogEntry
  catalog: CatalogLookup
  onDownload: (part: CatalogEntry) => void
}) {
  const link = useMemo(() => shareLink(part), [part])
  const report = useMemo(() => shareReport(part, catalog), [part, catalog])
  const ownNames = report.ownRefs.map((id) => {
    const own = catalog.hardware(id) ?? catalog.device(id) ?? catalog.frame(id) ?? catalog.item(id)
    return own === undefined ? id : partName(own)
  })
  return (
    <>
      <DialogHeader>
        <DialogTitle>Share “{partName(part)}” with everyone</DialogTitle>
        <DialogDescription>
          Suggest it for the shared catalog so others can use it too. GitHub opens in a new tab with
          a catalog submission form; you need a GitHub account. People check the facts before it is
          added.
        </DialogDescription>
      </DialogHeader>
      <div className="grid gap-3 text-sm">
        <p className="text-muted-foreground">
          The catalog keeps facts and links only: no pictures, no copied descriptions and no model
          files.
        </p>
        {report.needed.length === 0 ? null : (
          <div className="grid gap-1 rounded-lg border border-warning-border bg-warning-soft p-2.5">
            <h3 className="flex items-center gap-1.5 font-medium text-warning">
              <TriangleAlert aria-hidden className="size-4 shrink-0" />
              Before it can be added, it needs:
            </h3>
            <ul className="list-disc pl-5">
              {report.needed.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          </div>
        )}
        {report.suggested.length === 0 ? null : (
          <div className="grid gap-1 rounded-lg border border-info-border bg-info-soft p-2.5">
            <h3 className="flex items-center gap-1.5 font-medium text-info">
              <Info aria-hidden className="size-4 shrink-0" />
              Good to add:
            </h3>
            <ul className="list-disc pl-5">
              {report.suggested.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          </div>
        )}
        {ownNames.length === 0 ? null : (
          <p>
            It uses other parts of yours: {ownNames.join(', ')}. Share those as well, or switch to
            parts from the shared catalog.
          </p>
        )}
        {link.prefilled ? (
          <p>The form opens with this part’s facts filled in.</p>
        ) : (
          <div className="grid gap-2 rounded-lg border bg-muted/50 p-2.5">
            <p>
              This part is too long to fill in the form by itself. Download it, then paste the
              file’s contents into the form’s “Catalog entry (JSON)” field, or attach the file.
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="w-fit"
              onClick={() => onDownload(part)}
            >
              <Download aria-hidden />
              Download the catalog entry
            </Button>
          </div>
        )}
      </div>
      <DialogFooter>
        <DialogClose render={<Button type="button" variant="outline" />}>Not now</DialogClose>
        <a
          href={link.url}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Open the form on GitHub (opens in a new tab)"
          className={buttonVariants({ variant: 'default' })}
          data-testid="share-part-link"
        >
          Open the form on GitHub
          <ExternalLink aria-hidden />
        </a>
      </DialogFooter>
    </>
  )
}

export function SharePartDialog({
  part,
  catalog,
  onClose,
  onDownload,
}: {
  part: CatalogEntry | null
  catalog: CatalogLookup
  onClose: () => void
  onDownload: (part: CatalogEntry) => void
}) {
  const [shown, setShown] = useState(part)
  if (part !== null && part !== shown) setShown(part)
  return (
    <Dialog open={part !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        {shown === null ? null : (
          <ShareBody part={shown} catalog={catalog} onDownload={onDownload} />
        )}
      </DialogContent>
    </Dialog>
  )
}
