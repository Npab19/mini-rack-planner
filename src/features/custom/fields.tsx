/**
 * Labelled fields for the part forms. Every control gets its label, its unit and hint, and its
 * message tied to it with aria-describedby; problems carry an icon and words, never colour only.
 * `data-field` names the control so a failed save can move focus to the first problem.
 */
import { ChevronDown, CircleAlert, Info } from 'lucide-react'
import { useId, type ComponentProps, type ReactNode } from 'react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'
import type { Choice, FormIssue } from './partForms'

/**
 * A choice card around a radio, as in the New plan wizard: the checked one gets the accent tint
 * and a primary outline, and its radio shows the dot, so the choice never rests on colour alone.
 */
export const CHOICE_CARD =
  'flex items-start rounded-lg border transition-colors hover:bg-accent/40 has-[:checked]:border-primary has-[:checked]:bg-accent has-[:checked]:ring-1 has-[:checked]:ring-primary'

/** Space-separated ids for aria-describedby, skipping missing ones. */
export function describedBy(
  ...values: ReadonlyArray<string | false | undefined>
): string | undefined {
  const joined = values.filter((value) => typeof value === 'string' && value !== '').join(' ')
  return joined === '' ? undefined : joined
}

/** What a field shows: its problem (blocks saving) or its note (worth knowing). */
export interface FieldState {
  error?: FormIssue
  warning?: FormIssue
}

export function FieldMessage({ id, error, warning }: FieldState & { id: string }) {
  if (error !== undefined) {
    return (
      <p id={id} className="flex items-start gap-1.5 text-xs text-destructive">
        <CircleAlert aria-hidden className="mt-px size-3.5 shrink-0" />
        <span>{error.message}</span>
      </p>
    )
  }
  if (warning === undefined) return null
  return (
    <p id={id} className="flex items-start gap-1.5 text-xs text-muted-foreground">
      <Info aria-hidden className="mt-px size-3.5 shrink-0 text-info" />
      <span>
        <span className="sr-only">Note: </span>
        {warning.message}
      </span>
    </p>
  )
}

/** Props a field hands to its control. */
export interface ControlProps {
  id: string
  'aria-describedby'?: string
  'aria-invalid'?: true
  'data-field': string
}

export interface FieldProps extends FieldState {
  id: string
  /** `data-field` of the control (the issue's field). */
  field: string
  label: ReactNode
  hint?: ReactNode
  unit?: string
  className?: string
  children: (control: ControlProps) => ReactNode
}

export function Field({
  id,
  field,
  label,
  hint,
  unit,
  error,
  warning,
  className,
  children,
}: FieldProps) {
  const unitId = `${id}-unit`
  const hintId = `${id}-hint`
  const messageId = `${id}-message`
  const control: ControlProps = {
    id,
    'data-field': field,
    ...(error === undefined ? {} : { 'aria-invalid': true as const }),
  }
  const described = describedBy(
    unit !== undefined && unitId,
    hint !== undefined && hintId,
    (error ?? warning) !== undefined && messageId,
  )
  if (described !== undefined) control['aria-describedby'] = described
  return (
    <div className={cn('grid min-w-0 content-start gap-1.5', className)}>
      <Label htmlFor={id} className="leading-snug">
        {label}
      </Label>
      <div className="flex min-w-0 items-center gap-2">
        {children(control)}
        {unit === undefined ? null : (
          <span id={unitId} className="shrink-0 text-sm text-muted-foreground">
            {unit}
          </span>
        )}
      </div>
      {hint === undefined ? null : (
        <p id={hintId} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
      <FieldMessage id={messageId} error={error} warning={warning} />
    </div>
  )
}

type InputProps = Omit<ComponentProps<'input'>, 'value' | 'onChange'>

/** A text input as a field: `onValue` gets the text, `onDone` runs on blur (shows its message). */
export function TextField({
  value,
  onValue,
  onDone,
  inputProps,
  ...field
}: Omit<FieldProps, 'children'> & {
  value: string
  onValue: (value: string) => void
  onDone?: () => void
  inputProps?: InputProps
}) {
  return (
    <Field {...field}>
      {(control) => (
        <Input
          {...inputProps}
          {...control}
          value={value}
          autoComplete="off"
          onChange={(event) => onValue(event.target.value)}
          onBlur={onDone}
        />
      )}
    </Field>
  )
}

/** A number in mm, g, W…: a text input with the decimal keypad (it takes a decimal comma). */
export function NumberField(
  props: Omit<Parameters<typeof TextField>[0], 'inputProps'> & {
    inputProps?: InputProps
  },
) {
  return (
    <TextField
      {...props}
      inputProps={{
        inputMode: 'decimal',
        spellCheck: false,
        enterKeyHint: 'next',
        className: 'w-full min-w-0',
        ...props.inputProps,
      }}
    />
  )
}

/**
 * A native select styled like the inputs: the platform picker is the most robust choice on
 * phones and with assistive tech, and needs no portal inside the dialog.
 */
export function NativeSelect({ className, children, ...props }: ComponentProps<'select'>) {
  return (
    <span className="relative inline-flex w-full min-w-0">
      <select
        className={cn(
          'h-8 w-full min-w-0 appearance-none rounded-lg border border-input bg-background py-1 pr-8 pl-2.5 text-base outline-none',
          'focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50',
          'disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive md:text-sm dark:bg-input/30',
          className,
        )}
        {...props}
      >
        {children}
      </select>
      <ChevronDown
        aria-hidden
        className="pointer-events-none absolute top-1/2 right-2.5 size-4 -translate-y-1/2 text-muted-foreground"
      />
    </span>
  )
}

export function SelectField<T extends string>({
  value,
  onValue,
  choices,
  placeholder,
  disabled,
  ...field
}: Omit<FieldProps, 'children'> & {
  value: T | ''
  onValue: (value: T) => void
  choices: ReadonlyArray<Choice<T>>
  /** An empty first option ("Choose…") while nothing is chosen. */
  placeholder?: string
  disabled?: boolean
}) {
  return (
    <Field {...field}>
      {(control) => (
        <NativeSelect
          {...control}
          value={value}
          disabled={disabled}
          onChange={(event) => {
            const next = choices.find((choice) => choice.value === event.target.value)
            if (next !== undefined) onValue(next.value)
          }}
        >
          {placeholder === undefined ? null : (
            <option value="" disabled>
              {placeholder}
            </option>
          )}
          {choices.map((choice) => (
            <option key={choice.value} value={choice.value}>
              {choice.label}
            </option>
          ))}
        </NativeSelect>
      )}
    </Field>
  )
}

/** A group of fields with a visible title. */
export function FieldGroup({
  title,
  description,
  children,
  className,
}: {
  title: string
  description?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <fieldset className={cn('grid min-w-0 gap-3 rounded-lg border p-3', className)}>
      <legend className="px-1 text-sm font-medium">{title}</legend>
      {description === undefined ? null : (
        <p className="-mt-1 text-xs text-muted-foreground">{description}</p>
      )}
      {children}
    </fieldset>
  )
}

/** A native checkbox with its label; the hint is its description. */
export function CheckboxField({
  checked,
  onChecked,
  label,
  hint,
  field,
}: {
  checked: boolean
  onChecked: (checked: boolean) => void
  label: ReactNode
  hint?: ReactNode
  field: string
}) {
  const id = useId()
  const hintId = useId()
  return (
    <div className="flex items-start gap-2.5">
      <input
        id={id}
        type="checkbox"
        data-field={field}
        checked={checked}
        aria-describedby={hint === undefined ? undefined : hintId}
        onChange={(event) => onChecked(event.target.checked)}
        className="mt-0.5 size-4 shrink-0 cursor-pointer accent-primary outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      />
      <div className="grid gap-0.5">
        <label htmlFor={id} className="cursor-pointer text-sm leading-snug">
          {label}
        </label>
        {hint === undefined ? null : (
          <p id={hintId} className="text-xs text-muted-foreground">
            {hint}
          </p>
        )}
      </div>
    </div>
  )
}
