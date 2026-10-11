/**
 * The frame's options grouped by where they apply: the whole rack, the top and the bottom of the
 * rack (each a once-per-rack assembly with its own In my rack / To get), and defaults for every
 * section (a section can change them in its own settings). Edits are undoable plan edits.
 */
import { type ReactNode, useId } from 'react'
import { HAVE_TEXT, NEED_TEXT } from '@/components/common/HaveNeed'
import { HaveNeedToggle } from '@/components/common/HaveNeedToggle'
import { markCap } from '@/domain/build'
import { resolveOptionValues } from '@/domain/recipe'
import type { Frame, Option, OptionScope } from '@/domain/schema/catalog'
import type { OptionValue } from '@/domain/schema/common'
import { usePlanStore } from '@/state/planStore'
import { OptionField } from './OptionField'
import { applyPlanOp, nowIso, sparesText, type SpareContext } from './planOps'
import type { OpenPlan } from './useOpenPlan'

type Cap = 'top' | 'bottom'

export interface FrameOptionsPanelProps {
  open: OpenPlan & { frame: Frame }
  spares: SpareContext
  announce: (text: string) => void
}

const CAP_TITLES: Record<Cap, string> = { top: 'Top of the rack', bottom: 'Bottom of the rack' }

function optionsIn(frame: Frame, scope: OptionScope): Option[] {
  return frame.options.filter((option) => option.scope === scope)
}

/** "Heat-set inserts: Top and bottom hole of each U." */
export function optionChangeText(option: Option, value: OptionValue): string {
  if (option.kind === 'boolean') return `${option.label}: ${value === true ? 'on' : 'off'}.`
  const choice = option.choices?.find((candidate) => candidate.id === value)
  return `${option.label}: ${choice?.label ?? String(value)}.`
}

function Group({ title, children, note }: { title: string; children: ReactNode; note?: string }) {
  return (
    <fieldset className="grid gap-3 rounded-lg border p-3">
      <legend className="px-1 text-sm font-medium">{title}</legend>
      {note === undefined ? null : <p className="-mt-1 text-xs text-muted-foreground">{note}</p>}
      {children}
    </fieldset>
  )
}

export function FrameOptionsPanel({ open, spares, announce }: FrameOptionsPanelProps) {
  const { plan, frame, readOnly } = open
  const headingId = useId()
  const hasSections = plan.frame.sections.length > 0
  const rackOptions = optionsIn(frame, 'rack')
  const sectionOptions = optionsIn(frame, 'section')
  const rackValues = resolveOptionValues(rackOptions, plan.frame.options)
  const sectionDefaults = resolveOptionValues(sectionOptions, plan.frame.options)

  function setRackValue(option: Option, value: OptionValue): void {
    const changed = usePlanStore.getState().edit((draft) => {
      draft.frame.options[option.id] = value
    })
    if (changed) announce(optionChangeText(option, value))
  }

  function setCapValue(cap: Cap, option: Option, value: OptionValue): void {
    const changed = usePlanStore.getState().edit((draft) => {
      const state = draft.frame.caps[cap]
      state.options = { ...state.options, [option.id]: value }
    })
    if (changed) announce(`${CAP_TITLES[cap]}: ${optionChangeText(option, value)}`)
  }

  function markCapHave(cap: Cap, have: boolean): void {
    const outcome = applyPlanOp(
      (current) => ({ plan: markCap(current, frame, cap, have, nowIso()) }),
      spares,
    )
    if (outcome.applied) {
      announce(
        `${CAP_TITLES[cap]}: ${have ? HAVE_TEXT : NEED_TEXT}.${sparesText(outcome.sparesUsed)}`,
      )
    } else {
      announce(outcome.error ?? `${CAP_TITLES[cap]} could not be marked.`)
    }
  }

  const caps: Cap[] = ['top', 'bottom']
  const nothingToShow = rackOptions.length === 0 && sectionOptions.length === 0 && !hasSections
  if (nothingToShow) return null

  return (
    <section aria-labelledby={headingId} className="grid gap-2">
      <h3 id={headingId} className="text-sm font-medium">
        Options
      </h3>
      {rackOptions.length === 0 ? null : (
        <Group title="Whole rack">
          {rackOptions.map((option) => (
            <OptionField
              key={option.id}
              option={option}
              value={rackValues[option.id]}
              onChange={(value) => setRackValue(option, value)}
              disabled={readOnly}
            />
          ))}
        </Group>
      )}
      {hasSections
        ? caps.map((cap) => {
            const capOptions = optionsIn(frame, cap)
            const state = plan.frame.caps[cap]
            const values = resolveOptionValues(capOptions, plan.frame.options, state.options)
            return (
              <Group key={cap} title={CAP_TITLES[cap]}>
                <HaveNeedToggle
                  have={state.have !== undefined}
                  label={`${CAP_TITLES[cap]}: in my rack or to get`}
                  onChange={(have) => markCapHave(cap, have)}
                  disabled={readOnly}
                  size="sm"
                />
                {capOptions.map((option) => (
                  <OptionField
                    key={option.id}
                    option={option}
                    value={values[option.id]}
                    onChange={(value) => setCapValue(cap, option, value)}
                    disabled={readOnly}
                  />
                ))}
              </Group>
            )
          })
        : null}
      {sectionOptions.length === 0 ? null : (
        <Group
          title="Every section (defaults)"
          note="Sections use these unless you change one in its own settings: select the section."
        >
          {sectionOptions.map((option) => (
            <OptionField
              key={option.id}
              option={option}
              value={sectionDefaults[option.id]}
              onChange={(value) => setRackValue(option, value)}
              disabled={readOnly}
            />
          ))}
        </Group>
      )}
    </section>
  )
}
