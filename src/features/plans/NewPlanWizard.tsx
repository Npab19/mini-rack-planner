/**
 * The New plan wizard: a dialog with numbered steps (frame, the stack, then the goal or the name).
 * The answers live in `WizardState` (wizardModel.ts); this file renders them and moves focus:
 * each step's heading gets focus when the step changes, and a failed Next focuses the first
 * control with a problem, whose message is tied to it with aria-describedby.
 */
import { Radio as RadioPrimitive } from '@base-ui/react/radio'
import { RadioGroup as RadioGroupPrimitive } from '@base-ui/react/radio-group'
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  ExternalLink,
  Plus,
  TriangleAlert,
  X,
} from 'lucide-react'
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
  type Ref,
} from 'react'
import { HAVE_TEXT, HaveIcon, NEED_TEXT, NeedIcon } from '@/components/common/HaveNeed'
import { LiveRegion, useAnnouncer } from '@/components/common/LiveRegion'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { errorMessage } from '@/db/errors'
import { createPlan, nowIso } from '@/db/plansRepo'
import type { Frame, Option } from '@/domain/schema/catalog'
import { isCustomId, type OptionValue } from '@/domain/schema/common'
import type { Plan } from '@/domain/schema/plan'
import { cn } from '@/lib/utils'
import { getCatalog, useCatalog } from '@/state/catalogStore'
import { useUiStore } from '@/state/uiStore'
import { StartOptions, type StartChoice } from './StartOptions'
import {
  addSection,
  applyPreset,
  buildPlanFromWizard,
  canAddSection,
  fixedSectionTypes,
  frameSizesText,
  goalHeights,
  goalSummary,
  initialWizardState,
  isOnePieceFrame,
  MAX_PLAN_NAME_LENGTH,
  moveSection,
  optionAnswer,
  optionGroups,
  planName,
  removeSection,
  resolveGoal,
  selectFrame,
  setGoal,
  setName,
  setOptionValue,
  setSectionHave,
  setSectionHeight,
  stackHeightU,
  stackPresets,
  stackRows,
  stackSummary,
  WIZARD_STEPS,
  WizardBuildError,
  wizardIssues,
  type NumberedStep,
  type StackEnd,
  type StackRow,
  type WizardField,
  type WizardIssue,
  type WizardMode,
  type WizardOptionScope,
  type WizardState,
  type WizardStep,
} from './wizardModel'

export interface NewPlanWizardProps {
  open: boolean
  /** Changes every time the wizard opens, so each opening starts from scratch. */
  launchKey: number
  /** The start card that opened it; without one the wizard first asks how to start. */
  mode?: WizardMode
  onOpenChange: (open: boolean) => void
  /** "Open the sample" was chosen in the wizard: the caller closes it and opens the sample. */
  onOpenSample: () => void
  /** The plan is stored: the caller closes the wizard and opens the plan. */
  onCreated: (plan: Plan) => void
}

const SCOPE_TITLES: Record<WizardOptionScope, string> = {
  rack: 'Whole rack',
  top: 'Top of the rack',
  bottom: 'Bottom of the rack',
  section: 'Every section',
}

/** A choice with this many options or fewer shows as radio buttons, more as a select. */
const MAX_RADIO_CHOICES = 4

function stepTitle(mode: WizardMode, step: NumberedStep): string {
  if (step === 'frame') return 'Frame'
  if (step === 'stack') return mode === 'record' ? 'Your rack' : 'Your new rack'
  return mode === 'record' ? 'Goal' : 'Name'
}

function frameRank(frame: Frame): number {
  if (isCustomId(frame.id)) return 2
  return frame.source?.platform === 'makerworld' ? 0 : 1
}

/** Designer frames first (KWS), then templates (generic 10"), then the user's own frames. */
function sortFrames(frames: readonly Frame[]): Frame[] {
  return frames.toSorted((a, b) => frameRank(a) - frameRank(b) || a.name.localeCompare(b.name))
}

function frameFacts(frame: Frame): string {
  const facts: string[] = []
  if (frame.source?.designer !== undefined) facts.push(`By ${frame.source.designer}`)
  if (frame.source?.license !== undefined) facts.push(`Licence: ${frame.source.license}`)
  facts.push(frameSizesText(frame))
  return facts.join(' · ')
}

/** Every element that can take focus, for moving focus to a field's first control. */
const FOCUSABLE =
  'input:not([disabled]):not([type="hidden"]), button:not([disabled]), [role="radio"][tabindex="0"], [tabindex]:not([tabindex="-1"])'

/** Focuses the first control of a field (marked with data-wizard-field) inside `root`. */
function focusField(root: HTMLElement | null, field: WizardField): void {
  const target = root?.querySelector<HTMLElement>(`[data-wizard-field="${field}"]`)
  if (target === null || target === undefined) return
  const control = target.matches(FOCUSABLE) ? target : target.querySelector<HTMLElement>(FOCUSABLE)
  ;(control ?? target).focus()
}

function rowName(row: StackRow): string {
  return `${row.label}, U${row.fromU}–U${row.toU}`
}

// ---------------------------------------------------------------------------------------------
// Small pieces

function FieldError({
  id,
  issue,
  alert = false,
}: {
  id: string
  issue?: WizardIssue
  alert?: boolean
}) {
  if (issue === undefined) return null
  return (
    <p
      id={id}
      role={alert ? 'alert' : undefined}
      className="flex items-start gap-1.5 text-sm text-destructive"
    >
      <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
      {issue.message}
    </p>
  )
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

/** Space-separated ids for aria-describedby, skipping missing ones. */
function ids(...values: ReadonlyArray<string | false | undefined>): string | undefined {
  const joined = values.filter((value) => typeof value === 'string' && value !== '').join(' ')
  return joined === '' ? undefined : joined
}

function StepIndicator({ mode, step }: { mode: WizardMode; step: NumberedStep }) {
  const current = WIZARD_STEPS.indexOf(step)
  return (
    <ol aria-label="Steps" className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
      {WIZARD_STEPS.map((candidate, index) => {
        const status = index < current ? 'done' : index === current ? 'current' : 'todo'
        return (
          <li
            key={candidate}
            aria-current={status === 'current' ? 'step' : undefined}
            className="flex items-center gap-1.5"
          >
            <span
              aria-hidden
              className={cn(
                'flex size-5 items-center justify-center rounded-full border text-[0.7rem] font-medium',
                status === 'current' && 'border-primary bg-primary text-primary-foreground',
                status === 'done' && 'border-primary',
              )}
            >
              {status === 'done' ? <Check className="size-3" /> : index + 1}
            </span>
            <span
              className={cn(
                status === 'current' ? 'font-medium text-foreground' : 'text-muted-foreground',
                // Narrow screens keep only the current step's name visible.
                status !== 'current' && 'max-sm:sr-only',
              )}
            >
              {stepTitle(mode, candidate)}
              {status === 'done' ? <span className="sr-only"> (done)</span> : null}
            </span>
          </li>
        )
      })}
    </ol>
  )
}

/** Have/Need as a two-option radio group styled like a segmented control. */
function HaveNeedChoice({
  have,
  label,
  onChange,
}: {
  have: boolean
  label: string
  onChange: (have: boolean) => void
}) {
  return (
    <RadioGroupPrimitive
      value={have ? 'have' : 'need'}
      onValueChange={(value) => onChange(value === 'have')}
      aria-label={label}
      className="inline-flex shrink-0 rounded-lg border bg-background p-0.5"
    >
      {(['have', 'need'] as const).map((value) => {
        const Icon = value === 'have' ? HaveIcon : NeedIcon
        return (
          <RadioPrimitive.Root
            key={value}
            value={value}
            className={cn(
              'inline-flex h-7 cursor-pointer items-center gap-1 rounded-md px-2 text-xs text-muted-foreground outline-none select-none',
              'focus-visible:ring-3 focus-visible:ring-ring/50',
              'data-checked:bg-primary data-checked:font-semibold data-checked:text-primary-foreground',
            )}
          >
            <Icon aria-hidden className="size-3.5" />
            {value === 'have' ? HAVE_TEXT : NEED_TEXT}
          </RadioPrimitive.Root>
        )
      })}
    </RadioGroupPrimitive>
  )
}

// ---------------------------------------------------------------------------------------------
// Step 1: frame

function FrameOption({ frame, checked }: { frame: Frame; checked: boolean }) {
  const nameId = useId()
  const factsId = useId()
  const makerWorld = frame.source?.platform === 'makerworld' ? frame.source.url : undefined
  const onePiece = isOnePieceFrame(frame)
  return (
    <div
      className={cn(
        'rounded-xl border p-3 transition-colors',
        checked ? 'border-primary bg-muted/60' : 'hover:bg-muted/30',
      )}
    >
      <label className="flex cursor-pointer items-start gap-3">
        <RadioGroupItem
          value={frame.id}
          aria-labelledby={nameId}
          aria-describedby={factsId}
          className="mt-0.5"
        />
        <span className="grid min-w-0 gap-1">
          <span id={nameId} className="font-medium">
            {frame.name}
            {isCustomId(frame.id) ? (
              <Badge variant="outline" className="ml-2 align-middle">
                My part
              </Badge>
            ) : null}
          </span>
          <span id={factsId} className="text-sm text-muted-foreground">
            {frameFacts(frame)}
            {onePiece
              ? '. Any 10-inch rack, bought or self-built: it does not grow by sections, you set its height.'
              : null}
          </span>
        </span>
      </label>
      {makerWorld === undefined ? null : (
        <a
          href={makerWorld}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-2 ml-7 inline-flex items-center gap-1 rounded-sm text-sm font-medium underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          Open on MakerWorld
          <ExternalLink aria-hidden className="size-3.5" />
          <span className="sr-only"> (opens in a new tab)</span>
        </a>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------------------------
// Step 2: the stack

interface StackStepProps {
  state: WizardState
  frame: Frame
  update: (change: (state: WizardState) => WizardState) => void
  issues: readonly WizardIssue[]
  announce: (text: string) => void
  /** Id of the message about the whole stack, when there is one. */
  stackErrorId?: string
}

function OptionField({
  option,
  value,
  onChange,
}: {
  option: Option
  value: OptionValue
  onChange: (value: OptionValue) => void
}) {
  const labelId = useId()
  const helpId = useId()
  const help =
    option.help === undefined ? null : (
      <span id={helpId} className="text-xs text-muted-foreground">
        {option.help}
      </span>
    )
  if (option.kind === 'boolean') {
    return (
      <label className="flex cursor-pointer items-center justify-between gap-3">
        <span className="grid gap-0.5">
          <span id={labelId} className="text-sm">
            {option.label}
          </span>
          {help}
        </span>
        <Switch
          checked={value === true}
          onCheckedChange={(checked) => onChange(checked)}
          aria-labelledby={labelId}
          aria-describedby={help === null ? undefined : helpId}
        />
      </label>
    )
  }
  const choices = option.choices ?? []
  const selected = typeof value === 'string' ? value : ''
  if (choices.length > MAX_RADIO_CHOICES) {
    return (
      <div className="grid gap-1.5">
        <span id={labelId} className="text-sm">
          {option.label}
        </span>
        <Select
          value={selected}
          onValueChange={(next) => {
            if (typeof next === 'string') onChange(next)
          }}
          items={choices.map((choice) => ({ value: choice.id, label: choice.label }))}
        >
          <SelectTrigger aria-labelledby={labelId} className="w-full sm:w-72">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {choices.map((choice) => (
              <SelectItem key={choice.id} value={choice.id}>
                {choice.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {help}
      </div>
    )
  }
  return (
    <div className="grid gap-1.5">
      <span id={labelId} className="text-sm">
        {option.label}
      </span>
      <RadioGroup
        value={selected}
        onValueChange={(next: unknown) => {
          if (typeof next === 'string') onChange(next)
        }}
        aria-labelledby={labelId}
        aria-describedby={help === null ? undefined : helpId}
        className="gap-1.5"
      >
        {choices.map((choice) => (
          <label key={choice.id} className="flex cursor-pointer items-center gap-2 text-sm">
            <RadioGroupItem value={choice.id} aria-label={choice.label} />
            <span>{choice.label}</span>
          </label>
        ))}
      </RadioGroup>
      {help}
    </div>
  )
}

function OptionsSection({ state, frame, update }: Omit<StackStepProps, 'issues' | 'announce'>) {
  const headingId = useId()
  const groups = optionGroups(frame)
  if (groups.length === 0) return null
  const recording = state.mode === 'record'
  return (
    <section aria-labelledby={headingId} className="grid gap-3">
      <div className="grid gap-1">
        <h4 id={headingId} className="text-sm font-medium">
          {recording ? 'Your rack today has…' : 'Options'}
        </h4>
        <p className="text-xs text-muted-foreground">
          {recording ? 'Answer for what is built. ' : ''}You can change these later in the editor.
        </p>
      </div>
      {groups.map((group) => (
        <fieldset key={group.scope} className="grid gap-3 rounded-lg border p-3">
          <legend className="px-1 text-sm font-medium">{SCOPE_TITLES[group.scope]}</legend>
          {group.options.map((option) => (
            <OptionField
              key={option.id}
              option={option}
              value={optionAnswer(state, option)}
              onChange={(value) => update((current) => setOptionValue(current, option, value))}
            />
          ))}
        </fieldset>
      ))}
    </section>
  )
}

function OnePieceStack({
  state,
  frame,
  update,
  issues,
  stackErrorId,
}: Omit<StackStepProps, 'announce'>) {
  const inputId = useId()
  const hintId = useId()
  const errorId = useId()
  const row = stackRows(state, frame)[0]
  const section = state.sections[0]
  if (row === undefined || section === undefined) return null
  const issue = issues.find((candidate) => candidate.field === `section:${section.key}`)
  const recording = state.mode === 'record'
  const value =
    section.heightU === undefined || Number.isNaN(section.heightU) ? '' : section.heightU
  return (
    <div className="grid gap-2" data-wizard-field={`section:${section.key}`}>
      <Label htmlFor={inputId}>
        {recording ? 'How tall is your rack? (U)' : 'How tall will it be? (U)'}
      </Label>
      <div className="flex flex-wrap items-center gap-3">
        <Input
          id={inputId}
          type="number"
          inputMode="numeric"
          min={row.range?.min}
          max={row.range?.max}
          step={1}
          value={value}
          onChange={(event) => {
            const text = event.target.value
            const heightU = text === '' ? Number.NaN : Number(text)
            update((current) => setSectionHeight(current, section.key, heightU))
          }}
          aria-invalid={issue === undefined ? undefined : true}
          aria-describedby={ids(hintId, issue !== undefined && errorId, stackErrorId)}
          className="w-24"
        />
        {recording ? (
          <HaveNeedChoice
            have={section.have}
            label="Your rack: in my rack or to get"
            onChange={(have) => update((current) => setSectionHave(current, section.key, have))}
          />
        ) : null}
      </div>
      <p id={hintId} className="text-xs text-muted-foreground">
        {row.range === undefined ? '' : `${row.range.min}U to ${row.range.max}U.`}
      </p>
      <FieldError id={errorId} issue={issue} />
    </div>
  )
}

function SectionStack({ state, frame, update, announce, stackErrorId }: StackStepProps) {
  const presetsLabelId = useId()
  const rows = stackRows(state, frame)
  const topDown = rows.toReversed()
  const presets = stackPresets(frame)
  const types = fixedSectionTypes(frame)
  const recording = state.mode === 'record'
  const totalU = stackHeightU(state, frame)
  const buttons = useRef(new Map<string, HTMLButtonElement>())
  /** The control to focus after the next render (a moved or removed row's button went away). */
  const focusNext = useRef<string[] | null>(null)

  useLayoutEffect(() => {
    const wanted = focusNext.current
    if (wanted === null) return
    focusNext.current = null
    for (const id of wanted) {
      const button = buttons.current.get(id)
      if (button !== undefined && !button.disabled) {
        button.focus()
        return
      }
    }
  })

  function register(id: string) {
    return (element: HTMLButtonElement | null) => {
      if (element === null) buttons.current.delete(id)
      else buttons.current.set(id, element)
    }
  }

  function describe(next: WizardState): string {
    const height = stackHeightU(next, frame)
    return next.sections.length === 0
      ? 'No sections left.'
      : `Stack, bottom to top: ${stackSummary(next, frame)}, ${height}U.`
  }

  function move(row: StackRow, direction: 'up' | 'down') {
    const next = moveSection(state, row.key, direction)
    update(() => next)
    // Moving re-inserts the row's element, which drops focus: put it back on the row.
    focusNext.current = [
      `${row.key}:${direction}`,
      `${row.key}:${direction === 'up' ? 'down' : 'up'}`,
    ]
    const moved = stackRows(next, frame).find((candidate) => candidate.key === row.key)
    if (moved !== undefined) {
      announce(
        `Moved ${row.label} ${direction}: now U${moved.fromU}–U${moved.toU}. ${describe(next)}`,
      )
    }
  }

  function remove(row: StackRow) {
    const index = topDown.findIndex((candidate) => candidate.key === row.key)
    const neighbour = topDown[index + 1] ?? topDown[index - 1]
    const next = removeSection(state, row.key)
    update(() => next)
    focusNext.current = neighbour === undefined ? ['add:top:first'] : [`${neighbour.key}:remove`]
    announce(`Removed ${rowName(row)}. ${describe(next)}`)
  }

  function add(typeId: string, at: StackEnd) {
    const next = addSection(state, frame, typeId, at)
    if (next === state) return
    update(() => next)
    const label = types.find((type) => type.id === typeId)?.label ?? typeId
    announce(`Added a ${label} ${at === 'top' ? 'on top' : 'at the bottom'}. ${describe(next)}`)
  }

  function addButtons(at: StackEnd) {
    return (
      <div
        role="group"
        aria-label={at === 'top' ? 'Add a section on top' : 'Add a section at the bottom'}
        className="flex flex-wrap gap-2"
      >
        {types.map((type, index) => (
          <Button
            key={type.id}
            ref={index === 0 ? register(`add:${at}:first`) : undefined}
            type="button"
            variant="outline"
            size="sm"
            disabled={!canAddSection(state, frame, type.id)}
            onClick={() => add(type.id, at)}
          >
            <Plus aria-hidden />
            {typeof type.heightU === 'number' ? `${type.heightU}U` : type.label}{' '}
            {at === 'top' ? 'on top' : 'at the bottom'}
          </Button>
        ))}
      </div>
    )
  }

  return (
    <div className="grid gap-4" data-wizard-field="sections">
      {presets.length > 0 ? (
        <div role="group" aria-labelledby={presetsLabelId} className="grid gap-2">
          <p id={presetsLabelId} className="text-sm font-medium">
            Quick start <span className="font-normal text-muted-foreground">(bottom first)</span>
          </p>
          <div className="flex flex-wrap gap-2">
            {presets.map((preset) => (
              <Button
                key={preset.id}
                type="button"
                variant="secondary"
                size="sm"
                aria-label={`${preset.label}: ${preset.description}`}
                aria-describedby={stackErrorId}
                onClick={() => {
                  const next = applyPreset(state, frame, preset)
                  update(() => next)
                  announce(describe(next))
                }}
              >
                {preset.label}
              </Button>
            ))}
          </div>
        </div>
      ) : null}

      <div className="grid gap-2">
        {addButtons('top')}
        {topDown.length === 0 ? (
          <p className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">
            No sections yet. Pick a quick start or add a section.
          </p>
        ) : (
          <ol aria-label="Sections, top to bottom" className="grid gap-2">
            {topDown.map((row, index) => {
              const isTop = index === 0
              const isBottom = index === topDown.length - 1
              const name = rowName(row)
              return (
                <li
                  key={row.key}
                  className={cn(
                    'flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border bg-card p-2.5',
                    !row.have && 'border-dashed border-foreground/30',
                  )}
                >
                  <div className="min-w-32 flex-1">
                    <p className="text-sm font-medium">{row.label}</p>
                    <p className="text-xs text-muted-foreground">
                      U{row.fromU}–U{row.toU}
                      {isTop && topDown.length > 1 ? ' · top' : ''}
                      {isBottom && topDown.length > 1 ? ' · bottom' : ''}
                    </p>
                  </div>
                  {recording ? (
                    <HaveNeedChoice
                      have={row.have}
                      label={`${name}: in my rack or to get`}
                      onChange={(have) => {
                        update((current) => setSectionHave(current, row.key, have))
                        announce(`${name}: ${have ? HAVE_TEXT : NEED_TEXT}.`)
                      }}
                    />
                  ) : null}
                  <div className="flex gap-1">
                    <Button
                      ref={register(`${row.key}:up`)}
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Move ${name} up`}
                      disabled={isTop}
                      onClick={() => move(row, 'up')}
                    >
                      <ArrowUp aria-hidden />
                    </Button>
                    <Button
                      ref={register(`${row.key}:down`)}
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Move ${name} down`}
                      disabled={isBottom}
                      onClick={() => move(row, 'down')}
                    >
                      <ArrowDown aria-hidden />
                    </Button>
                    <Button
                      ref={register(`${row.key}:remove`)}
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Remove ${name}`}
                      onClick={() => remove(row)}
                    >
                      <X aria-hidden />
                    </Button>
                  </div>
                </li>
              )
            })}
          </ol>
        )}
        {addButtons('bottom')}
      </div>

      <p className="text-sm">
        Total: <strong>{totalU}U</strong>{' '}
        <span className="text-muted-foreground">
          ({frame.name}: {frame.stack.minU}U to {frame.stack.maxU}U)
        </span>
      </p>
    </div>
  )
}

function StackStep(props: StackStepProps) {
  const errorId = useId()
  const stackIssue = props.issues.find((issue) => issue.field === 'sections')
  const stackErrorId = stackIssue === undefined ? undefined : errorId
  return (
    <div className="grid gap-6">
      <div className="grid gap-3">
        {isOnePieceFrame(props.frame) ? (
          // The whole-stack problems ("mark something as In my rack") focus the height field.
          <div data-wizard-field="sections">
            <OnePieceStack {...props} stackErrorId={stackErrorId} />
          </div>
        ) : (
          <SectionStack {...props} stackErrorId={stackErrorId} />
        )}
        <FieldError id={errorId} issue={stackIssue} alert />
      </div>
      <OptionsSection state={props.state} frame={props.frame} update={props.update} />
    </div>
  )
}

// ---------------------------------------------------------------------------------------------
// Step 3: goal and name

type GoalChoiceValue = 'target-height' | 'fit-equipment' | 'none'

function GoalChoice({
  value,
  title,
  description,
  disabled = false,
  comingSoon = false,
}: {
  value: GoalChoiceValue
  title: string
  description: string
  disabled?: boolean
  comingSoon?: boolean
}) {
  const titleId = useId()
  const descriptionId = useId()
  return (
    <label
      className={cn(
        'flex items-start gap-3 rounded-lg border p-3',
        disabled ? 'cursor-not-allowed opacity-70' : 'cursor-pointer hover:bg-muted/30',
      )}
    >
      <RadioGroupItem
        value={value}
        disabled={disabled}
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        className="mt-0.5"
      />
      <span className="grid gap-0.5">
        <span id={titleId} className="flex flex-wrap items-center gap-2 text-sm font-medium">
          {title}
          {comingSoon ? <Badge variant="outline">Coming soon</Badge> : null}
        </span>
        <span id={descriptionId} className="text-sm text-muted-foreground">
          {description}
        </span>
      </span>
    </label>
  )
}

function NameField({
  state,
  frame,
  update,
  issue,
}: {
  state: WizardState
  frame: Frame
  update: StackStepProps['update']
  issue?: WizardIssue
}) {
  const inputId = useId()
  const errorId = useId()
  return (
    <div className="grid gap-1.5" data-wizard-field="name">
      <Label htmlFor={inputId}>Plan name</Label>
      <Input
        id={inputId}
        value={planName(state, frame)}
        maxLength={MAX_PLAN_NAME_LENGTH}
        autoComplete="off"
        onChange={(event) => {
          const name = event.target.value
          update((current) => setName(current, name))
        }}
        aria-invalid={issue === undefined ? undefined : true}
        aria-describedby={issue === undefined ? undefined : errorId}
      />
      <FieldError id={errorId} issue={issue} />
    </div>
  )
}

function GoalStep({
  state,
  frame,
  update,
  issues,
  headingId,
}: Omit<StackStepProps, 'announce'> & { headingId: string }) {
  const heightId = useId()
  const atLabelId = useId()
  const goal = resolveGoal(state, frame)
  const currentU = stackHeightU(state, frame)
  const at: StackEnd = goal.kind === 'target-height' ? goal.at : 'top'
  const heights = goalHeights(state, frame, at)
  const growable =
    goalHeights(state, frame, 'top').length + goalHeights(state, frame, 'bottom').length > 0
  const summary = goalSummary(state, frame, goal)

  function chooseKind(kind: unknown) {
    if (kind === 'none') update((current) => setGoal(current, { kind: 'none' }))
    if (kind !== 'target-height') return
    update((current) => {
      const first = goalHeights(current, frame, 'top')[0]
      return first === undefined
        ? current
        : setGoal(current, { kind: 'target-height', targetU: first, at: 'top' })
    })
  }

  function chooseEnd(end: unknown) {
    if ((end !== 'top' && end !== 'bottom') || goal.kind !== 'target-height') return
    const options = goalHeights(state, frame, end)
    // Keep the height when that end can reach it, else the closest one it can.
    const targetU = options.includes(goal.targetU)
      ? goal.targetU
      : (options.find((heightU) => heightU >= goal.targetU) ?? options.at(-1))
    if (targetU !== undefined)
      update((current) => setGoal(current, { kind: 'target-height', targetU, at: end }))
  }

  return (
    <div className="grid gap-4">
      <p className="text-sm text-muted-foreground">
        Your rack is {currentU}U now ({stackSummary(state, frame)}, bottom to top).
      </p>
      <RadioGroup
        value={goal.kind}
        onValueChange={chooseKind}
        aria-labelledby={headingId}
        className="gap-2"
        data-wizard-field="goal"
      >
        <GoalChoice
          value="target-height"
          title="Grow it to a height"
          description={
            growable
              ? 'New sections are planned: they go on your shopping list.'
              : `This ${frame.name} cannot grow by sections${isOnePieceFrame(frame) ? '' : ' any more'}.`
          }
          disabled={!growable}
        />
        <GoalChoice
          value="fit-equipment"
          title="Fit my equipment"
          description="List your gear and the planner picks the height."
          disabled
          comingSoon
        />
        <GoalChoice
          value="none"
          title="I’ll plan it myself"
          description="Keep the rack as it is for now and add sections in the editor."
        />
      </RadioGroup>

      {goal.kind === 'target-height' ? (
        <div className="grid gap-4 rounded-lg border p-3 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label htmlFor={heightId}>Height</Label>
            <Select
              value={String(goal.targetU)}
              onValueChange={(next) => {
                const targetU = Number(next)
                if (Number.isInteger(targetU)) {
                  update((current) => setGoal(current, { kind: 'target-height', targetU, at }))
                }
              }}
              items={heights.map((heightU) => ({
                value: String(heightU),
                label: `${heightU}U (+${heightU - currentU}U)`,
              }))}
            >
              <SelectTrigger id={heightId} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {heights.map((heightU) => (
                  <SelectItem key={heightU} value={String(heightU)}>
                    {heightU}U (+{heightU - currentU}U)
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <span id={atLabelId} className="text-sm font-medium">
              Add the new sections
            </span>
            <RadioGroup
              value={at}
              onValueChange={chooseEnd}
              aria-labelledby={atLabelId}
              className="flex flex-wrap gap-x-4 gap-y-2"
            >
              {(['top', 'bottom'] as const).map((end) => (
                <label key={end} className="flex cursor-pointer items-center gap-2 text-sm">
                  <RadioGroupItem
                    value={end}
                    aria-label={end === 'top' ? 'On top' : 'At the bottom'}
                    disabled={goalHeights(state, frame, end).length === 0}
                  />
                  {end === 'top' ? 'On top' : 'At the bottom'}
                </label>
              ))}
            </RadioGroup>
          </div>
          {summary === undefined ? null : (
            <p className="text-sm sm:col-span-2" aria-live="polite">
              {summary}
            </p>
          )}
        </div>
      ) : null}
      <FieldError
        id={`${heightId}-error`}
        issue={issues.find((issue) => issue.field === 'goal')}
        alert
      />
      <NameField
        state={state}
        frame={frame}
        update={update}
        issue={issues.find((issue) => issue.field === 'name')}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------------------------
// The wizard

interface WizardBodyProps {
  initialMode?: WizardMode
  onOpenSample: () => void
  onCreated: (plan: Plan) => void
}

function WizardBody({ initialMode, onOpenSample, onCreated }: WizardBodyProps) {
  const [step, setStep] = useState<WizardStep>(initialMode === undefined ? 'start' : 'frame')
  const [state, setState] = useState(() => initialWizardState(initialMode ?? 'record'))
  /** Steps where Next was tried: their problems show (and update live) from then on. */
  const [tried, setTried] = useState<ReadonlySet<NumberedStep>>(() => new Set())
  const [buildIssue, setBuildIssue] = useState<WizardIssue | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, announce] = useAnnouncer()
  const { lookup } = useCatalog()
  const frames = useMemo(() => sortFrames(lookup.allFrames()), [lookup])
  const frame = state.frameId === undefined ? undefined : lookup.frame(state.frameId)
  const headingId = useId()
  const frameErrorId = useId()
  const headingRef = useRef<HTMLHeadingElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  /** The step whose heading last got focus (the dialog itself focuses the first step). */
  const focusedStep = useRef(step)
  /** A field to focus once the step has rendered, instead of the step heading. */
  const pendingField = useRef<WizardField | null>(null)

  useEffect(() => {
    if (focusedStep.current === step) return
    focusedStep.current = step
    const field = pendingField.current
    pendingField.current = null
    if (field === null) headingRef.current?.focus()
    else focusField(bodyRef.current, field)
  }, [step])

  const numbered = step === 'start' ? undefined : step
  const issues: WizardIssue[] = [
    ...(numbered !== undefined && tried.has(numbered) ? wizardIssues(state, frame, numbered) : []),
    ...(buildIssue !== null && buildIssue.step === numbered ? [buildIssue] : []),
  ]
  const recording = state.mode === 'record'

  function update(change: (current: WizardState) => WizardState): void {
    setState(change)
    setBuildIssue(null)
    setSaveError(null)
  }

  function goTo(target: WizardStep): void {
    setStep(target)
    setSaveError(null)
  }

  function choose(choice: StartChoice): void {
    if (choice === 'sample') {
      onOpenSample()
      return
    }
    setState(initialWizardState(choice))
    goTo('frame')
  }

  function back(): void {
    if (step === 'finish') goTo('stack')
    else if (step === 'stack') goTo('frame')
    else if (step === 'frame' && initialMode === undefined) goTo('start')
  }

  async function create(target: Frame): Promise<void> {
    setBusy(true)
    setSaveError(null)
    try {
      const plan = buildPlanFromWizard(target, lookup, state, nowIso())
      const created = await createPlan({ ...plan, catalogRev: getCatalog().catalogRev })
      if (state.mode === 'record') useUiStore.getState().setRecordingMode(created.id, true)
      onCreated(created)
    } catch (error) {
      setBusy(false)
      if (error instanceof WizardBuildError) {
        const issue: WizardIssue = { step: error.step, field: error.field, message: error.message }
        setBuildIssue(issue)
        if (error.step === step) focusField(bodyRef.current, error.field)
        else {
          pendingField.current = error.field
          goTo(error.step)
        }
        return
      }
      setSaveError(`The plan was not saved: ${errorMessage(error)}`)
    }
  }

  function next(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    if (numbered === undefined || busy) return
    const problems = wizardIssues(state, frame, numbered)
    if (problems.length > 0) {
      setTried((current) => new Set(current).add(numbered))
      const first = problems[0]
      // The messages render after this handler: focus once they (and aria-describedby) exist.
      if (first !== undefined) setTimeout(() => focusField(bodyRef.current, first.field), 0)
      return
    }
    if (numbered === 'frame') goTo('stack')
    else if (numbered === 'stack') {
      // The goal step opens on a goal that the stack as it is now can reach.
      if (frame !== undefined) setState((current) => setGoal(current, resolveGoal(current, frame)))
      goTo('finish')
    } else if (frame !== undefined) void create(frame)
  }

  const title = step === 'start' ? 'New plan' : recording ? 'Record my rack' : 'Plan a new rack'
  const frameIssue = issues.find((issue) => issue.field === 'frame')

  return (
    <>
      <DialogHeader className="gap-3 border-b px-4 pt-4 pr-12 pb-3">
        <DialogTitle>{title}</DialogTitle>
        {numbered === undefined ? null : <StepIndicator mode={state.mode} step={numbered} />}
        <DialogDescription className="sr-only">
          {numbered === undefined
            ? 'Choose how to start.'
            : `Step ${WIZARD_STEPS.indexOf(numbered) + 1} of ${WIZARD_STEPS.length}: ${stepTitle(state.mode, numbered)}.`}
        </DialogDescription>
      </DialogHeader>
      <form noValidate onSubmit={next} className="flex min-h-0 flex-1 flex-col">
        <div ref={bodyRef} className="grid min-h-0 flex-1 content-start gap-4 overflow-y-auto p-4">
          {step === 'start' ? (
            <>
              <StepHeading ref={headingRef} id={headingId}>
                How do you want to start?
              </StepHeading>
              <StartOptions onChoose={choose} className="sm:grid-cols-1" />
            </>
          ) : null}

          {step === 'frame' ? (
            <>
              <StepHeading ref={headingRef} id={headingId}>
                {recording ? 'Which frame is your rack?' : 'Which frame will you build?'}
              </StepHeading>
              <RadioGroup
                value={state.frameId ?? null}
                onValueChange={(id: unknown) => {
                  const picked = frames.find((candidate) => candidate.id === id)
                  if (picked !== undefined) update((current) => selectFrame(current, picked))
                }}
                aria-labelledby={headingId}
                aria-describedby={frameIssue === undefined ? undefined : frameErrorId}
                aria-invalid={frameIssue === undefined ? undefined : true}
                className="gap-2"
                data-wizard-field="frame"
              >
                {frames.map((candidate) => (
                  <FrameOption
                    key={candidate.id}
                    frame={candidate}
                    checked={candidate.id === state.frameId}
                  />
                ))}
              </RadioGroup>
              <FieldError id={frameErrorId} issue={frameIssue} />
            </>
          ) : null}

          {step === 'stack' && frame !== undefined ? (
            <>
              <StepHeading ref={headingRef} id={headingId}>
                {recording ? 'What does your rack have today?' : 'Which sections will it have?'}
              </StepHeading>
              <p className="-mt-2 text-sm text-muted-foreground">
                {isOnePieceFrame(frame)
                  ? `${frame.name}: one piece of ${frame.stack.minU}U to ${frame.stack.maxU}U.`
                  : recording
                    ? 'Add the sections that are built, bottom first. A section you still have to make can be marked To get.'
                    : 'Add the sections of the rack you want to build. Everything is To get.'}
              </p>
              <StackStep
                state={state}
                frame={frame}
                update={update}
                issues={issues}
                announce={announce}
              />
            </>
          ) : null}

          {step === 'finish' && frame !== undefined ? (
            <>
              <StepHeading ref={headingRef} id={headingId}>
                {recording ? 'How tall do you want it?' : 'Name your plan'}
              </StepHeading>
              {recording ? (
                <GoalStep
                  state={state}
                  frame={frame}
                  update={update}
                  issues={issues}
                  headingId={headingId}
                />
              ) : (
                <>
                  <p className="-mt-2 text-sm text-muted-foreground">
                    {frame.name}, {stackHeightU(state, frame)}U: {stackSummary(state, frame)}{' '}
                    (bottom to top).
                  </p>
                  <NameField
                    state={state}
                    frame={frame}
                    update={update}
                    issue={issues.find((issue) => issue.field === 'name')}
                  />
                </>
              )}
            </>
          ) : null}

          {saveError === null ? null : (
            <Alert variant="destructive">
              <TriangleAlert aria-hidden />
              <AlertTitle>Could not create the plan</AlertTitle>
              <AlertDescription>{saveError}</AlertDescription>
            </Alert>
          )}
        </div>
        {numbered === undefined ? null : (
          <DialogFooter className="mx-0 mb-0">
            {numbered !== 'frame' || initialMode === undefined ? (
              <Button type="button" variant="outline" onClick={back} disabled={busy}>
                <ChevronLeft aria-hidden />
                Back
              </Button>
            ) : null}
            <Button type="submit" disabled={busy} aria-busy={busy || undefined}>
              {numbered === 'finish' ? (
                busy ? (
                  'Creating…'
                ) : (
                  'Create plan'
                )
              ) : (
                <>
                  Next
                  <ChevronRight aria-hidden />
                </>
              )}
            </Button>
          </DialogFooter>
        )}
      </form>
      <LiveRegion message={message} />
    </>
  )
}

/**
 * The New plan wizard. Without `mode` it opens on the three ways to start; with one it opens on
 * the frame step. Creating the plan stores it (Recording mode on for "Record my rack") and hands
 * it to `onCreated`.
 */
export function NewPlanWizard({
  open,
  launchKey,
  mode,
  onOpenChange,
  onOpenSample,
  onCreated,
}: NewPlanWizardProps) {
  /** Set when the wizard closes because the user is going somewhere else (the new plan). */
  const leaving = useRef(false)
  useEffect(() => {
    if (open) leaving.current = false
  }, [open])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex max-h-[calc(100dvh-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl"
        // Returning focus to the button that opened the wizard only makes sense if we stay here.
        finalFocus={() => !leaving.current}
      >
        <WizardBody
          key={launchKey}
          initialMode={mode}
          onOpenSample={() => {
            leaving.current = true
            onOpenSample()
          }}
          onCreated={(plan) => {
            leaving.current = true
            onCreated(plan)
          }}
        />
      </DialogContent>
    </Dialog>
  )
}
