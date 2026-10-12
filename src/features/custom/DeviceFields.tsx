/**
 * The device form: brand and model, what kind of device, its outside size, how it is powered and
 * whether it has its own 10-inch rack ears.
 */
import { useId } from 'react'
import type { CustomPowerChoice } from '@/domain/customParts'
import { CheckboxField, FieldGroup, NumberField, SelectField, TextField } from './fields'
import type { FormView } from './formView'
import {
  DEVICE_CATEGORY_CHOICES,
  heightChoices,
  POWER_CHOICES,
  type Choice,
  type DeviceForm,
} from './partForms'
import { SourceFields } from './SourceFields'

const POWER_WITH_UNSET: ReadonlyArray<Choice<CustomPowerChoice | 'unset'>> = [
  { value: 'unset', label: 'Not set' },
  ...POWER_CHOICES,
]

export function DeviceFields({
  form,
  onChange,
  view,
}: {
  form: DeviceForm
  onChange: (patch: Partial<DeviceForm>) => void
  view: FormView
}) {
  const base = useId()
  const field = (name: string) => ({ id: `${base}-${name}`, field: name, ...view.state(name) })
  const done = (name: string) => () => view.done(name)
  const watts = form.power !== '' && form.power !== 'none'

  return (
    <div className="grid gap-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField
          {...field('brand')}
          label="Brand"
          value={form.brand}
          onValue={(brand) => onChange({ brand })}
          onDone={done('brand')}
          inputProps={{ placeholder: 'Lenovo', autoCapitalize: 'words' }}
        />
        <TextField
          {...field('model')}
          label="Model"
          value={form.model}
          onValue={(model) => onChange({ model })}
          onDone={done('model')}
          inputProps={{ placeholder: 'ThinkCentre M720q Tiny' }}
        />
        <SelectField
          {...field('category')}
          label="What kind of device is it?"
          hint="Mounts made for a kind of device (mini PCs, drives…) are offered for it."
          value={form.category}
          placeholder="Choose…"
          choices={DEVICE_CATEGORY_CHOICES}
          onValue={(category) => {
            onChange({ category })
            view.done('category')
          }}
          className="sm:col-span-2"
        />
      </div>

      <FieldGroup
        title="Outside size"
        description="As it normally sits, without cables: width across the rack, depth into it, and height."
      >
        <div className="grid grid-cols-3 gap-2 sm:gap-3">
          <NumberField
            {...field('width')}
            label="Width"
            unit="mm"
            value={form.width}
            onValue={(width) => onChange({ width })}
            onDone={done('width')}
          />
          <NumberField
            {...field('depth')}
            label="Depth"
            unit="mm"
            value={form.depth}
            onValue={(depth) => onChange({ depth })}
            onDone={done('depth')}
          />
          <NumberField
            {...field('height')}
            label="Height"
            unit="mm"
            value={form.height}
            onValue={(height) => onChange({ height })}
            onDone={done('height')}
          />
        </div>
        <NumberField
          {...field('weight')}
          label="Weight (optional)"
          unit="g"
          value={form.weight}
          onValue={(weight) => onChange({ weight })}
          onDone={done('weight')}
          className="max-w-48"
        />
      </FieldGroup>

      <FieldGroup
        title="Power"
        description="Used for the power check: outlets, PoE and USB-C ports."
      >
        <SelectField
          {...field('power')}
          label="How is it powered?"
          value={form.power === '' ? 'unset' : form.power}
          choices={POWER_WITH_UNSET}
          onValue={(power) => onChange({ power: power === 'unset' ? '' : power })}
        />
        {form.power === 'brick' ? (
          <CheckboxField
            field="brickWall"
            checked={form.brickWall}
            onChecked={(brickWall) => onChange({ brickWall })}
            label="The brick plugs straight into the wall"
            hint="It then covers two outlets of a power strip."
          />
        ) : null}
        {watts ? (
          <div className="grid grid-cols-2 gap-2 sm:gap-3">
            <NumberField
              {...field('typicalW')}
              label="Typical power (optional)"
              unit="W"
              value={form.typicalW}
              onValue={(typicalW) => onChange({ typicalW })}
              onDone={done('typicalW')}
            />
            <NumberField
              {...field('maxW')}
              label="Maximum power (optional)"
              unit="W"
              value={form.maxW}
              onValue={(maxW) => onChange({ maxW })}
              onDone={done('maxW')}
            />
          </div>
        ) : null}
      </FieldGroup>

      <FieldGroup title="Rack ears">
        <CheckboxField
          field="earMounted"
          checked={form.earMounted}
          onChecked={(earMounted) => onChange({ earMounted })}
          label="It has its own 10-inch rack ears"
          hint="Switches, patch panels and power strips made for 10-inch racks go on the rails without a printed mount."
        />
        {form.earMounted ? (
          <SelectField
            {...field('rackSixths')}
            label="Rack height"
            value={form.rackSixths}
            choices={heightChoices(Number(form.rackSixths))}
            onValue={(rackSixths) => onChange({ rackSixths })}
            className="max-w-48"
          />
        ) : null}
      </FieldGroup>

      <SourceFields
        link={form.link}
        checked={form.checked}
        onChange={onChange}
        view={view}
        linkHint="The maker’s product page, for example. The planner never opens it: it shows as an Open page link."
      />
    </div>
  )
}
