/**
 * The mount, panel and shelf form: name, what it holds (one device, a shelf of devices, or
 * nothing), its rack height (also ½U and ⅓U steps), depth and faces, the space it offers, the
 * prints and hardware from the model page, and where it is from.
 */
import { useId } from 'react'
import type { Hardware } from '@/domain/schema/catalog'
import { CheckboxField, FieldGroup, NumberField, SelectField, TextField } from './fields'
import type { FormView } from './formView'
import {
  DEVICE_CATEGORY_CHOICES,
  deviceCategoryLabel,
  FACES_CHOICES,
  heightChoices,
  ITEM_CATEGORY_CHOICES,
  PANEL_LOOK_CHOICES,
  type Choice,
  type ItemForm,
  type ItemHoldsKind,
} from './partForms'
import { HardwareRows, PrintRows } from './PartRows'
import { SourceFields } from './SourceFields'

const HOLDS_CHOICES: ReadonlyArray<{ value: ItemHoldsKind; label: string; description: string }> = [
  {
    value: 'device',
    label: 'One device',
    description: 'A mount or cradle made for a device, like a mini PC.',
  },
  {
    value: 'shelf',
    label: 'Devices on a shelf',
    description: 'A shelf or tray that several devices can sit on side by side.',
  },
  {
    value: 'nothing',
    label: 'Nothing',
    description: 'A blank, vent, keystone or fan panel.',
  },
]

const ACRONYMS: Readonly<Record<string, string>> = {
  pc: 'PC',
  sbc: 'SBC',
  nas: 'NAS',
  pdu: 'PDU',
  ups: 'UPS',
  kvm: 'KVM',
  usb: 'USB',
  poe: 'PoE',
}

/** "mini-pc-mount" -> "Mini PC mount": a category that is not one of the usual ones. */
function categoryText(category: string): string {
  const words = category.split('-').filter((word) => word !== '')
  const text = words.map((word) => ACRONYMS[word] ?? word).join(' ')
  return text.charAt(0).toUpperCase() + text.slice(1)
}

function categoryChoices(current: string): Array<Choice<string>> {
  const known = ITEM_CATEGORY_CHOICES.some((choice) => choice.value === current)
  return known || current === ''
    ? [...ITEM_CATEGORY_CHOICES]
    : [{ value: current, label: categoryText(current) }, ...ITEM_CATEGORY_CHOICES]
}

function HoldsChoice({
  form,
  onHolds,
}: {
  form: ItemForm
  onHolds: (holds: ItemHoldsKind) => void
}) {
  const base = useId()
  return (
    <fieldset className="grid gap-2" data-field="holds">
      <legend className="mb-1.5 text-sm font-medium">What does it hold?</legend>
      <div className="grid gap-2 sm:grid-cols-3">
        {HOLDS_CHOICES.map((choice) => {
          const id = `${base}-${choice.value}`
          return (
            <div
              key={choice.value}
              className="flex items-start gap-2.5 rounded-lg border p-2.5 has-[:checked]:border-primary has-[:checked]:bg-muted/50"
            >
              <input
                id={id}
                type="radio"
                name={`${base}-holds`}
                value={choice.value}
                checked={form.holds === choice.value}
                onChange={() => onHolds(choice.value)}
                aria-describedby={`${id}-description`}
                className="mt-0.5 size-4 shrink-0 cursor-pointer accent-primary outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
              />
              <span className="grid gap-0.5">
                <label htmlFor={id} className="cursor-pointer text-sm font-medium">
                  {choice.label}
                </label>
                <span id={`${id}-description`} className="text-xs text-muted-foreground">
                  {choice.description}
                </span>
              </span>
            </div>
          )
        })}
      </div>
    </fieldset>
  )
}

export function ItemFields({
  form,
  onChange,
  onHolds,
  view,
  announce,
  hardware,
}: {
  form: ItemForm
  onChange: (patch: Partial<ItemForm>) => void
  onHolds: (holds: ItemHoldsKind) => void
  view: FormView
  announce: (text: string) => void
  hardware: readonly Hardware[]
}) {
  const base = useId()
  const field = (name: string) => ({ id: `${base}-${name}`, field: name, ...view.state(name) })
  const done = (name: string) => () => view.done(name)
  const device = form.holds === 'device'
  const chosen = form.slotCategories.map(deviceCategoryLabel).join(', ')

  return (
    <div className="grid gap-4">
      <TextField
        {...field('name')}
        label="Name"
        value={form.name}
        onValue={(name) => onChange({ name })}
        onDone={done('name')}
        inputProps={{ placeholder: 'Lenovo Tiny mount 1U' }}
      />
      <HoldsChoice form={form} onHolds={onHolds} />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <SelectField
          {...field('heightSixths')}
          label="Rack height"
          value={form.heightSixths}
          choices={heightChoices(Number(form.heightSixths))}
          onValue={(heightSixths) => onChange({ heightSixths })}
        />
        <NumberField
          {...field('depth')}
          label="Depth"
          unit="mm"
          hint="How far it reaches into the rack."
          value={form.depth}
          onValue={(depth) => onChange({ depth })}
          onDone={done('depth')}
        />
        <SelectField
          {...field('faces')}
          label="Mounts on"
          value={form.faces}
          choices={FACES_CHOICES}
          onValue={(faces) => onChange({ faces })}
          className="col-span-2 sm:col-span-1"
        />
      </div>

      {form.holds === 'nothing' ? (
        <SelectField
          {...field('look')}
          label="Looks like (in the drawing)"
          value={form.look}
          choices={PANEL_LOOK_CHOICES}
          onValue={(look) => onChange({ look })}
          className="sm:max-w-60"
        />
      ) : (
        <FieldGroup
          title={device ? 'The largest device it takes' : 'Shelf space'}
          description={
            device
              ? 'The room inside the mount: width across the rack, depth into it, height.'
              : 'Width and depth of the shelf, and the room above it if it has a lid or a shelf above.'
          }
        >
          <div className="grid grid-cols-3 gap-2 sm:gap-3">
            <NumberField
              {...field('slotW')}
              label="Width"
              unit="mm"
              value={form.slotW}
              onValue={(slotW) => onChange({ slotW })}
              onDone={done('slotW')}
            />
            <NumberField
              {...field('slotD')}
              label="Depth"
              unit="mm"
              value={form.slotD}
              onValue={(slotD) => onChange({ slotD })}
              onDone={done('slotD')}
            />
            <NumberField
              {...field('slotH')}
              label={device ? 'Height' : 'Room above (optional)'}
              unit="mm"
              value={form.slotH}
              onValue={(slotH) => onChange({ slotH })}
              onDone={done('slotH')}
            />
          </div>
          {device ? (
            <details className="group rounded-lg border p-2.5">
              <summary className="cursor-pointer rounded-sm text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
                Only for some kinds of devices (optional)
                {chosen === '' ? null : (
                  <span className="text-muted-foreground"> · now: {chosen}</span>
                )}
              </summary>
              <div
                role="group"
                aria-label="Kinds of devices it takes"
                className="mt-2.5 grid gap-2 sm:grid-cols-2"
              >
                {DEVICE_CATEGORY_CHOICES.map((choice) => (
                  <CheckboxField
                    key={choice.value}
                    field={`slotCategories.${choice.value}`}
                    checked={form.slotCategories.includes(choice.value)}
                    onChecked={(checked) =>
                      onChange({
                        slotCategories: checked
                          ? [...form.slotCategories, choice.value]
                          : form.slotCategories.filter((category) => category !== choice.value),
                      })
                    }
                    label={choice.label}
                  />
                ))}
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                With none ticked, any device that fits can go in.
              </p>
            </details>
          ) : null}
        </FieldGroup>
      )}

      <SelectField
        {...field('category')}
        label="Category"
        hint="Groups it in the parts list."
        value={form.category}
        choices={categoryChoices(form.category)}
        onValue={(category) => onChange({ category })}
        className="sm:max-w-60"
      />

      <PrintRows
        rows={form.prints}
        onRows={(prints) => onChange({ prints })}
        view={view}
        announce={announce}
      />
      <HardwareRows
        rows={form.hardware}
        onRows={(rows) => onChange({ hardware: rows })}
        hardware={hardware}
        view={view}
        announce={announce}
      />

      <SourceFields
        link={form.link}
        checked={form.checked}
        credits={{ designer: form.designer, license: form.license }}
        onChange={onChange}
        view={view}
        linkHint="MakerWorld, Printables, Thingiverse or any page. The planner never opens it: it shows as an Open page link."
      />
    </div>
  )
}
