/**
 * "Add a part": the manual wizard (where is it from → what is it → its details) and the plain-
 * language editors for your own devices, mounts/panels/shelves and rack frames. It renders the
 * request in `useAddPart` (see addPartStore.ts); `AddPartHost` shows it app-wide.
 *
 * Saving stores the part in My parts (this browser), and as the request asks also in the open
 * plan and on to placing it (savePart.ts). Links are kept, never fetched; model files come later
 * (3D) and are never uploaded.
 *
 * Focus: the dialog opens on its first field; a new step focuses its heading; a failed save
 * focuses the first field with a problem, whose message is tied to it. After "Save and place"
 * focus goes to the rack drawing, where the arrow keys move the part.
 *
 * Colour follows the New plan wizard: the step indicator and the chosen kind card in the primary
 * colour with the accent tint, problems in the destructive tone (always with an icon and words)
 * and the "never uploaded" note as info.
 */
import { Check, ChevronLeft, ChevronRight, CircleAlert, FileBox, TriangleAlert } from 'lucide-react'
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
  type Ref,
} from 'react'
import { toast } from 'sonner'
import { LiveRegion, useAnnouncer } from '@/components/common/LiveRegion'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { getLibraryEntry } from '@/db/libraryRepo'
import { errorMessage, LibraryEntryError } from '@/db/errors'
import {
  customAdvancedDetails,
  customDeviceInputOf,
  customFrameInputOf,
  customItemInputOf,
  CustomPartError,
  editCustomDevice,
  editCustomFrame,
  editCustomItem,
  isOnePieceCustomFrame,
  newCustomDevice,
  newCustomFrame,
  newCustomItem,
  parseSourceLink,
  type SourceLink,
} from '@/domain/customParts'
import type { CatalogEntry, Device, Frame, Item } from '@/domain/schema/catalog'
import { focusRackDrawing } from '@/features/editor/layout/shellStore'
import { localDateStamp } from '@/lib/date'
import { cn } from '@/lib/utils'
import { useCatalog, useCatalogStore } from '@/state/catalogStore'
import { useAddPart, type AddPartRequest, type AddPartTarget } from './addPartStore'
import { useFirstSlot } from './dialogSlot'
import { DeviceFields } from './DeviceFields'
import { CHOICE_CARD } from './fields'
import { FrameFields } from './FrameFields'
import { focusField, useFormView } from './formView'
import { ItemFields } from './ItemFields'
import {
  checkDeviceForm,
  checkFrameForm,
  checkItemForm,
  deviceForm,
  frameForm,
  itemForm,
  withHolds,
  type DeviceForm,
  type FormCheck,
  type FrameForm,
  type ItemForm,
} from './partForms'
import { partName, savedMessage, savePart, type SaveResult } from './savePart'
import { linkSummary } from './SourceFields'

type Request = AddPartRequest & AddPartTarget
export type PartKind = 'device' | 'item' | 'frame'
type Step = 'link' | 'kind' | 'details'

const WIZARD_STEPS: ReadonlyArray<{ step: Step; title: string }> = [
  { step: 'link', title: 'Where it is from' },
  { step: 'kind', title: 'What it is' },
  { step: 'details', title: 'Details' },
]

const KIND_CHOICES: ReadonlyArray<{ value: PartKind; label: string; description: string }> = [
  {
    value: 'item',
    label: 'A mount, panel or shelf',
    description: 'Something printed that goes on the rails, and may hold a device.',
  },
  {
    value: 'device',
    label: 'A device',
    description: 'Equipment such as a mini PC, a switch, a NAS or a power strip.',
  },
  {
    value: 'frame',
    label: 'A rack frame',
    description: 'A 10-inch rack you bought or designed yourself.',
  },
]

const NEW_TITLES: Readonly<Record<PartKind, string>> = {
  device: 'Add a device',
  item: 'Add a mount, panel or shelf',
  frame: 'Add a rack frame',
}

const DETAILS_HEADINGS: Readonly<Record<PartKind, string>> = {
  device: 'About the device',
  item: 'About the mount, panel or shelf',
  frame: 'About the rack frame',
}

const MODEL_FILES_NOTE =
  'Model files (STL or 3MF) come later, for the 3D view: you will add them then. They stay in this browser and are never uploaded.'

/** Design platforms: a link there is most likely a printed part. */
const DESIGN_PLATFORMS = new Set(['makerworld', 'printables', 'thingiverse'])

function isPartKind(kind: string): kind is PartKind {
  return kind === 'device' || kind === 'item' || kind === 'frame'
}

/** The visible problem list after a failed save (schema or storage problems). */
interface SaveFailure {
  message: string
  problems: readonly string[]
}

function StepHeading({
  ref,
  id,
  children,
}: {
  ref: Ref<HTMLHeadingElement>
  id: string
  children: ReactNode
}) {
  return (
    <h3
      ref={ref}
      id={id}
      tabIndex={-1}
      className="text-base font-medium tracking-tight outline-none focus-visible:underline"
    >
      {children}
    </h3>
  )
}

function StepIndicator({ step }: { step: Step }) {
  const current = WIZARD_STEPS.findIndex((candidate) => candidate.step === step)
  return (
    <ol aria-label="Steps" className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
      {WIZARD_STEPS.map((candidate, index) => {
        const status = index < current ? 'done' : index === current ? 'current' : 'todo'
        return (
          <li
            key={candidate.step}
            aria-current={status === 'current' ? 'step' : undefined}
            className="flex items-center gap-1.5"
          >
            <span
              aria-hidden
              className={cn(
                'flex size-5 items-center justify-center rounded-full border text-[0.7rem] font-medium',
                status === 'current' && 'border-primary bg-primary text-primary-foreground',
                status === 'done' && 'border-primary bg-accent text-primary',
                status === 'todo' && 'border-input text-muted-foreground',
              )}
            >
              {status === 'done' ? <Check className="size-3" /> : index + 1}
            </span>
            <span
              className={cn(
                status === 'current' ? 'font-semibold text-foreground' : 'text-muted-foreground',
                status !== 'current' && 'max-sm:sr-only',
              )}
            >
              {candidate.title}
              {status === 'done' ? <span className="sr-only"> (done)</span> : null}
            </span>
          </li>
        )
      })}
    </ol>
  )
}

function ModelFilesNote() {
  return (
    <p className="flex items-start gap-2 rounded-lg border border-info-border bg-info-soft p-2.5 text-xs text-muted-foreground">
      <FileBox aria-hidden className="mt-px size-4 shrink-0 text-info" />
      <span>{MODEL_FILES_NOTE}</span>
    </p>
  )
}

// ---------------------------------------------------------------------------------------------
// Step 1 and 2 of the wizard

function LinkStep({
  link,
  onLink,
  error,
  headingRef,
  headingId,
}: {
  link: string
  onLink: (link: string) => void
  error: string | undefined
  headingRef: Ref<HTMLHeadingElement>
  headingId: string
}) {
  const inputId = useId()
  const hintId = useId()
  const statusId = useId()
  const summary = link.trim() === '' ? undefined : linkSummary(link)
  const parsed = link.trim() === '' ? undefined : parseSourceLink(link)
  return (
    <div className="grid gap-4">
      <StepHeading ref={headingRef} id={headingId}>
        Where is it from?
      </StepHeading>
      <div className="grid gap-1.5">
        <label htmlFor={inputId} className="text-sm font-medium">
          Link to its page (optional)
        </label>
        <input
          id={inputId}
          type="url"
          inputMode="url"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          data-field="link"
          placeholder="https://makerworld.com/en/models/…"
          value={link}
          onChange={(event) => onLink(event.target.value)}
          aria-describedby={`${hintId} ${statusId}`}
          aria-invalid={error === undefined ? undefined : true}
          className="h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-base outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30"
        />
        <p id={hintId} className="text-xs text-muted-foreground">
          A MakerWorld, Printables or Thingiverse model, a maker’s product page, or any other page.
          The planner never opens it: it is kept as an Open page link. No link? Go on with Next.
        </p>
        <div id={statusId} aria-live="polite" className="text-xs">
          {error !== undefined ? (
            <p className="flex items-start gap-1.5 text-destructive">
              <CircleAlert aria-hidden className="mt-px size-3.5 shrink-0" />
              {error}
            </p>
          ) : parsed !== undefined ? (
            <p className="flex items-start gap-1.5 text-muted-foreground">
              <Check aria-hidden className="mt-px size-3.5 shrink-0 text-have" />
              <span>
                {summary ?? 'A link to keep as it is.'}
                {parsed.name === undefined ? null : ` Name from the link: “${parsed.name}”.`}
              </span>
            </p>
          ) : null}
        </div>
      </div>
      <ModelFilesNote />
    </div>
  )
}

function KindStep({
  kind,
  onKind,
  error,
  headingRef,
  headingId,
}: {
  kind: PartKind | null
  onKind: (kind: PartKind) => void
  error: string | undefined
  headingRef: Ref<HTMLHeadingElement>
  headingId: string
}) {
  const base = useId()
  const errorId = useId()
  return (
    <div className="grid gap-4">
      <StepHeading ref={headingRef} id={headingId}>
        What is it?
      </StepHeading>
      <div
        role="radiogroup"
        aria-labelledby={headingId}
        aria-describedby={error === undefined ? undefined : errorId}
        className="grid gap-2"
        data-field="kind"
      >
        {KIND_CHOICES.map((choice) => {
          const id = `${base}-${choice.value}`
          return (
            <div key={choice.value} className={cn(CHOICE_CARD, 'gap-3 p-3')}>
              <input
                id={id}
                type="radio"
                name={`${base}-kind`}
                value={choice.value}
                checked={kind === choice.value}
                onChange={() => onKind(choice.value)}
                aria-describedby={`${id}-description`}
                className="mt-0.5 size-4 shrink-0 cursor-pointer accent-primary outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
              />
              <span className="grid gap-0.5">
                <label htmlFor={id} className="cursor-pointer text-sm font-medium">
                  {choice.label}
                </label>
                <span id={`${id}-description`} className="text-sm text-muted-foreground">
                  {choice.description}
                </span>
              </span>
            </div>
          )
        })}
      </div>
      {error === undefined ? null : (
        <p id={errorId} role="alert" className="flex items-start gap-1.5 text-sm text-destructive">
          <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
          {error}
        </p>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------------------------
// The flow

interface Forms {
  device: DeviceForm
  item: ItemForm
  frame: FrameForm
}

/** Each form from the edited entry, else from the request's prefill (only its own kind has one). */
function initialForms(request: Request, entry: CatalogEntry | undefined): Forms {
  return {
    device: deviceForm(
      entry?.kind === 'device'
        ? customDeviceInputOf(entry)
        : request.kind === 'device'
          ? request.prefill
          : undefined,
    ),
    item: itemForm(
      entry?.kind === 'item'
        ? customItemInputOf(entry)
        : request.kind === 'item'
          ? request.prefill
          : undefined,
    ),
    frame: frameForm(
      entry?.kind === 'frame'
        ? customFrameInputOf(entry)
        : request.kind === 'frame'
          ? request.prefill
          : undefined,
    ),
  }
}

/** Fills the empty name and link fields of the chosen form from the wizard's link. */
function formsFromLink(forms: Forms, link: SourceLink | undefined): Forms {
  if (link === undefined) return forms
  const name = link.name ?? ''
  const fill = (current: string, value: string): string => (current.trim() === '' ? value : current)
  return {
    device: {
      ...forms.device,
      model: fill(forms.device.model, name),
      link: fill(forms.device.link, link.url),
    },
    item: {
      ...forms.item,
      name: fill(forms.item.name, name),
      link: fill(forms.item.link, link.url),
    },
    frame: {
      ...forms.frame,
      name: fill(forms.frame.name, name),
      link: fill(forms.frame.link, link.url),
    },
  }
}

function saveLabel(request: Request, kind: PartKind, editing: boolean, form: Forms): string {
  if (editing) return 'Save changes'
  if (kind === 'frame') return 'Save to My parts'
  if (request.placeAfterSave === true) {
    if (kind === 'item' || form.device.earMounted) return 'Save and place'
    return 'Save and add to Equipment to fit'
  }
  return request.addToOpenPlan === true ? 'Save and add to plan' : 'Save to My parts'
}

function PartFlow({
  request,
  entry,
  onSaved,
}: {
  request: Request
  /** The library entry being edited. */
  entry: CatalogEntry | undefined
  onSaved: (result: SaveResult, edited: boolean) => void
}) {
  const wizard = request.kind === 'wizard'
  const [step, setStep] = useState<Step>(wizard ? 'link' : 'details')
  const [kind, setKind] = useState<PartKind | null>(() => {
    if (entry !== undefined && isPartKind(entry.kind)) return entry.kind
    return isPartKind(request.kind) ? request.kind : null
  })
  const [link, setLink] = useState(request.kind === 'wizard' ? (request.url ?? '') : '')
  const [stepError, setStepError] = useState<string | undefined>(undefined)
  const [forms, setForms] = useState(() => initialForms(request, entry))
  const [submitted, setSubmitted] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<SaveFailure | null>(null)
  const [message, announce] = useAnnouncer()
  const { lookup } = useCatalog()
  const hardware = useMemo(() => lookup.allHardware(), [lookup])
  const headingRef = useRef<HTMLHeadingElement>(null)
  const headingId = useId()
  const bodyRef = useRef<HTMLDivElement>(null)
  const shownStep = useRef(step)

  useEffect(() => {
    if (shownStep.current === step) return
    shownStep.current = step
    headingRef.current?.focus()
  }, [step])

  const check: FormCheck<unknown> = useMemo(() => {
    if (kind === 'device') return checkDeviceForm(forms.device)
    if (kind === 'frame') return checkFrameForm(forms.frame)
    return checkItemForm(forms.item)
  }, [kind, forms])
  const view = useFormView(check, submitted)

  const editing = entry !== undefined
  const advanced = entry === undefined ? [] : customAdvancedDetails(entry)

  function update(change: (current: Forms) => Forms): void {
    setForms(change)
    setFailure(null)
  }

  function next(): void {
    setStepError(undefined)
    if (step === 'link') {
      if (link.trim() !== '' && parseSourceLink(link) === undefined) {
        setStepError(
          'Enter the full web address of the page, like https://makerworld.com/en/models/…',
        )
        setTimeout(() => focusField(bodyRef.current, 'link'), 0)
        return
      }
      const parsed = parseSourceLink(link)
      if (kind === null && parsed !== undefined && DESIGN_PLATFORMS.has(parsed.platform)) {
        setKind('item')
      }
      setStep('kind')
      return
    }
    if (step === 'kind') {
      if (kind === null) {
        setStepError('Choose what it is.')
        setTimeout(() => focusField(bodyRef.current, 'kind'), 0)
        return
      }
      setForms((current) => formsFromLink(current, parseSourceLink(link)))
      setStep('details')
    }
  }

  function back(): void {
    setStepError(undefined)
    setFailure(null)
    if (step === 'details') setStep('kind')
    else if (step === 'kind') setStep('link')
  }

  /** The save step for the chosen kind; `today` (local date) stamps `verified.date`. */
  function build(
    chosen: PartKind,
    today: string,
  ): ((taken: ReadonlySet<string>) => CatalogEntry) | undefined {
    if (chosen === 'device') {
      const { value } = checkDeviceForm(forms.device, today)
      if (value === undefined) return undefined
      return entry?.kind === 'device'
        ? () => editCustomDevice(entry, value)
        : (taken) => newCustomDevice(value, taken)
    }
    if (chosen === 'frame') {
      const { value } = checkFrameForm(forms.frame, today)
      if (value === undefined) return undefined
      return entry?.kind === 'frame'
        ? () => editCustomFrame(entry, value)
        : (taken) => newCustomFrame(value, taken)
    }
    const { value } = checkItemForm(forms.item, today)
    if (value === undefined) return undefined
    return entry?.kind === 'item'
      ? () => editCustomItem(entry, value)
      : (taken) => newCustomItem(value, taken)
  }

  async function save(): Promise<void> {
    if (busy || kind === null) return
    setSubmitted(true)
    setFailure(null)
    const first = check.issues[0]
    const builder = build(kind, localDateStamp(new Date()))
    if (first !== undefined || builder === undefined) {
      const count = check.issues.length
      announce(`${count} ${count === 1 ? 'thing needs' : 'things need'} fixing before saving.`)
      // The messages render after this handler: focus once they (and aria-describedby) exist.
      if (first !== undefined) setTimeout(() => focusField(bodyRef.current, first.field), 0)
      return
    }
    setBusy(true)
    try {
      const result = await savePart(builder, request)
      onSaved(result, editing)
    } catch (error) {
      setBusy(false)
      if (error instanceof CustomPartError || error instanceof LibraryEntryError) {
        setFailure({ message: error.message, problems: error.problems })
      } else {
        setFailure({ message: errorMessage(error), problems: [] })
      }
    }
  }

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    if (step === 'details') void save()
    else next()
  }

  const title = wizard
    ? 'Add a part'
    : editing && entry !== undefined
      ? `Edit “${partName(entry)}”`
      : NEW_TITLES[kind ?? 'item']
  const stepNumber = WIZARD_STEPS.findIndex((candidate) => candidate.step === step) + 1

  return (
    <>
      <DialogHeader className="gap-3 border-b px-4 pt-4 pr-12 pb-3">
        <DialogTitle>{title}</DialogTitle>
        {wizard ? <StepIndicator step={step} /> : null}
        <DialogDescription className={wizard ? 'sr-only' : undefined}>
          {wizard
            ? `Step ${stepNumber} of ${WIZARD_STEPS.length}: ${WIZARD_STEPS[stepNumber - 1]?.title ?? ''}.`
            : 'Your parts are saved in this browser. Fill in what you know; you can change it later.'}
        </DialogDescription>
      </DialogHeader>
      <form noValidate onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
        <div ref={bodyRef} className="grid min-h-0 flex-1 content-start gap-4 overflow-y-auto p-4">
          {step === 'link' ? (
            <LinkStep
              link={link}
              onLink={(value) => {
                setLink(value)
                setStepError(undefined)
              }}
              error={stepError}
              headingRef={headingRef}
              headingId={headingId}
            />
          ) : null}
          {step === 'kind' ? (
            <KindStep
              kind={kind}
              onKind={(value) => {
                setKind(value)
                setStepError(undefined)
              }}
              error={stepError}
              headingRef={headingRef}
              headingId={headingId}
            />
          ) : null}
          {step === 'details' && kind !== null ? (
            <>
              {wizard ? (
                <StepHeading ref={headingRef} id={headingId}>
                  {DETAILS_HEADINGS[kind]}
                </StepHeading>
              ) : null}
              {advanced.length === 0 ? null : (
                <p className="rounded-lg border border-info-border bg-info-soft p-2.5 text-sm">
                  This part also has {advanced.join(', ')}. This form does not show{' '}
                  {advanced.length === 1 ? 'it' : 'them'}; saving keeps{' '}
                  {advanced.length === 1 ? 'it' : 'them'} as{' '}
                  {advanced.length === 1 ? 'it is' : 'they are'}.
                </p>
              )}
              {kind === 'device' ? (
                <DeviceFields
                  form={forms.device}
                  onChange={(change) =>
                    update((current) => ({ ...current, device: { ...current.device, ...change } }))
                  }
                  view={view}
                />
              ) : kind === 'frame' ? (
                <FrameFields
                  form={forms.frame}
                  onChange={(change) =>
                    update((current) => ({ ...current, frame: { ...current.frame, ...change } }))
                  }
                  view={view}
                  heightLocked={entry?.kind === 'frame' && !isOnePieceCustomFrame(entry)}
                />
              ) : (
                <ItemFields
                  form={forms.item}
                  onChange={(change) =>
                    update((current) => ({ ...current, item: { ...current.item, ...change } }))
                  }
                  onHolds={(holds) =>
                    update((current) => ({ ...current, item: withHolds(current.item, holds) }))
                  }
                  view={view}
                  announce={announce}
                  hardware={hardware}
                />
              )}
              {kind === 'item' ? <ModelFilesNote /> : null}
            </>
          ) : null}
          {failure === null ? null : (
            <Alert variant="destructive">
              <TriangleAlert aria-hidden />
              <AlertTitle>Not saved: {failure.message}</AlertTitle>
              {failure.problems.length === 0 ? null : (
                <AlertDescription>
                  <ul className="list-disc pl-4">
                    {failure.problems.slice(0, 6).map((problem) => (
                      <li key={problem}>{problem}</li>
                    ))}
                  </ul>
                </AlertDescription>
              )}
            </Alert>
          )}
        </div>
        <DialogFooter className="mx-0 mb-0">
          {wizard && step !== 'link' ? (
            <Button type="button" variant="outline" onClick={back} disabled={busy}>
              <ChevronLeft aria-hidden />
              Back
            </Button>
          ) : null}
          <Button type="submit" disabled={busy} aria-busy={busy || undefined}>
            {step === 'details' && kind !== null ? (
              busy ? (
                'Saving…'
              ) : (
                saveLabel(request, kind, editing, forms)
              )
            ) : (
              <>
                Next
                <ChevronRight aria-hidden />
              </>
            )}
          </Button>
        </DialogFooter>
      </form>
      <LiveRegion message={message} />
    </>
  )
}

// ---------------------------------------------------------------------------------------------
// Loading the part being edited

type EditedEntry =
  | { status: 'none' }
  | { status: 'loading' }
  | { status: 'missing' }
  | { status: 'found'; entry: CatalogEntry }

function useEditedEntry(editId: string | undefined): EditedEntry {
  const fromLibrary = useCatalogStore((state) =>
    editId === undefined ? undefined : state.library.find((entry) => entry.id === editId),
  )
  const [read, setRead] = useState<{ id: string; entry: CatalogEntry | null } | null>(null)
  useEffect(() => {
    if (editId === undefined || fromLibrary !== undefined) return
    let cancelled = false
    getLibraryEntry(editId).then(
      (entry) => {
        if (!cancelled) setRead({ id: editId, entry: entry ?? null })
      },
      () => {
        if (!cancelled) setRead({ id: editId, entry: null })
      },
    )
    return () => {
      cancelled = true
    }
  }, [editId, fromLibrary])
  if (editId === undefined) return { status: 'none' }
  if (fromLibrary !== undefined) return { status: 'found', entry: fromLibrary }
  if (read === null || read.id !== editId) return { status: 'loading' }
  return read.entry === null ? { status: 'missing' } : { status: 'found', entry: read.entry }
}

function editable(entry: CatalogEntry): entry is Device | Item | Frame {
  return entry.kind === 'device' || entry.kind === 'item' || entry.kind === 'frame'
}

function Notice({ title, children }: { title: string; children: ReactNode }) {
  return (
    <>
      <DialogHeader className="border-b px-4 pt-4 pr-12 pb-3">
        <DialogTitle>{title}</DialogTitle>
      </DialogHeader>
      <div className="p-4 text-sm">{children}</div>
    </>
  )
}

function AddPartBody({
  request,
  onSaved,
}: {
  request: Request
  onSaved: (result: SaveResult, edited: boolean) => void
}) {
  const editId = request.kind === 'wizard' ? undefined : request.editId
  const edited = useEditedEntry(editId)
  if (edited.status === 'loading') {
    return (
      <Notice title="Edit a part">
        <p role="status">Loading the part…</p>
      </Notice>
    )
  }
  if (edited.status === 'missing') {
    return (
      <Notice title="Edit a part">
        <p role="alert">This part is not in My parts any more (it may have been deleted).</p>
      </Notice>
    )
  }
  if (edited.status === 'found' && !editable(edited.entry)) {
    return (
      <Notice title={`Edit “${partName(edited.entry)}”`}>
        <p>Parts of this kind cannot be edited here yet.</p>
      </Notice>
    )
  }
  return (
    <PartFlow
      request={request}
      entry={edited.status === 'found' ? edited.entry : undefined}
      onSaved={onSaved}
    />
  )
}

// ---------------------------------------------------------------------------------------------
// The dialog

/** The request to show: the current one, or the last one while the dialog animates closed. */
function useShownRequest(request: Request | null): Request | null {
  const [last, setLast] = useState(request)
  if (request !== null && request !== last) setLast(request)
  return request ?? last
}

/** A key per request object, so each opening starts from scratch. */
const requestKeys = new WeakMap<object, number>()
let nextRequestKey = 0
function requestKey(request: Request): number {
  let key = requestKeys.get(request)
  if (key === undefined) {
    nextRequestKey += 1
    key = nextRequestKey
    requestKeys.set(request, key)
  }
  return key
}

/**
 * The "Add a part" dialog for the current `useAddPart` request. The app shell should render
 * `AddPartHost`, which loads this module lazily (it builds zod schemas at load). Rendered from
 * several places at once, only the first one shows.
 */
export function AddPartDialog() {
  return useFirstSlot() ? <AddPartDialogShown /> : null
}

function AddPartDialogShown() {
  const request = useAddPart((state) => state.request)
  const shown = useShownRequest(request)
  /** Placing started: focus goes to the rack once the dialog has closed. */
  const toRack = useRef(false)

  function saved(result: SaveResult, edited: boolean): void {
    toast.success(savedMessage(result, edited))
    toRack.current = result.placing
    useAddPart.getState().close()
  }

  return (
    <Dialog
      open={request !== null}
      onOpenChange={(open) => {
        if (!open) useAddPart.getState().close()
      }}
      // A stray click beside the dialog must not throw away a half-typed part.
      disablePointerDismissal
      onOpenChangeComplete={(open) => {
        if (open || !toRack.current) return
        toRack.current = false
        focusRackDrawing()
      }}
    >
      <DialogContent
        className="flex max-h-[calc(100dvh-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl"
        data-testid="add-part-dialog"
        finalFocus={() => !toRack.current}
      >
        {shown === null ? null : (
          <AddPartBody key={requestKey(shown)} request={shown} onSaved={saved} />
        )}
      </DialogContent>
    </Dialog>
  )
}
