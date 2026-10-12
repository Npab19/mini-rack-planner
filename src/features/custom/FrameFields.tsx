/**
 * The rack frame form, for a commercial or self-designed one-piece 10-inch rack: its height, the
 * width between the rails, its depth, and the screws (and nuts) that fix gear to the rails.
 */
import { useId } from 'react'
import { CheckboxField, FieldGroup, NumberField, SelectField, TextField } from './fields'
import type { FormView } from './formView'
import { PER_HOLE_CHOICES, THREAD_CHOICES, type FrameForm } from './partForms'
import { SourceFields } from './SourceFields'

export function FrameFields({
  form,
  onChange,
  view,
  heightLocked = false,
}: {
  form: FrameForm
  onChange: (patch: Partial<FrameForm>) => void
  view: FormView
  /** A frame of several section types: its height comes from its sections and is kept. */
  heightLocked?: boolean
}) {
  const base = useId()
  const field = (name: string) => ({ id: `${base}-${name}`, field: name, ...view.state(name) })
  const done = (name: string) => () => view.done(name)

  return (
    <div className="grid gap-4">
      <TextField
        {...field('name')}
        label="Name"
        value={form.name}
        onValue={(name) => onChange({ name })}
        onDone={done('name')}
        inputProps={{ placeholder: 'DeskPi RackMate T1' }}
      />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <NumberField
          {...field('heightU')}
          label="Height"
          unit="U"
          {...(heightLocked
            ? { hint: 'Set by its sections; kept as it is.' }
            : { hint: 'Whole U, like 8.' })}
          value={form.heightU}
          onValue={(heightU) => onChange({ heightU })}
          onDone={done('heightU')}
          inputProps={{ inputMode: 'numeric', disabled: heightLocked }}
        />
        <NumberField
          {...field('depth')}
          label="Depth"
          unit="mm"
          hint="From the front rails to the back."
          value={form.depth}
          onValue={(depth) => onChange({ depth })}
          onDone={done('depth')}
        />
        <NumberField
          {...field('innerWidth')}
          label="Width between the rails"
          unit="mm"
          hint="Usually 210 to 222 mm."
          value={form.innerWidth}
          onValue={(innerWidth) => onChange({ innerWidth })}
          onDone={done('innerWidth')}
          className="col-span-2 sm:col-span-1"
        />
      </div>
      <CheckboxField
        field="rearOpen"
        checked={form.rearOpen}
        onChecked={(rearOpen) => onChange({ rearOpen })}
        label="It is open at the back"
        hint="Deeper gear may then stick out at the back. Leave it off for a closed cabinet."
      />
      <FieldGroup
        title="Fixing gear to the rails"
        description="Used to count the rack screws (and nuts) on the shopping list."
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <SelectField
            {...field('thread')}
            label="Screw thread"
            value={form.thread}
            choices={THREAD_CHOICES}
            onValue={(thread) => onChange({ thread })}
          />
          <SelectField
            {...field('perHole')}
            label="Each hole takes"
            value={form.perHole}
            choices={PER_HOLE_CHOICES}
            onValue={(perHole) => onChange({ perHole })}
          />
        </div>
      </FieldGroup>
      <SourceFields
        link={form.link}
        checked={form.checked}
        onChange={onChange}
        view={view}
        linkHint="The shop’s or the design’s page. The planner never opens it: it shows as an Open page link."
      />
    </div>
  )
}
