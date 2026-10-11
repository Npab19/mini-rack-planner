import 'fake-indexeddb/auto'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetDbForTests } from '@/db/db'
import { getPlan } from '@/db/plansRepo'
import type { Plan } from '@/domain/schema/plan'
import { stopLibrarySync } from '@/state/catalogStore'
import { useUiStore } from '@/state/uiStore'
import { NewPlanWizard } from './NewPlanWizard'
import type { WizardMode } from './wizardModel'

interface Rendered {
  onCreated: ReturnType<typeof vi.fn<(plan: Plan) => void>>
  onOpenSample: ReturnType<typeof vi.fn<() => void>>
}

function renderWizard(mode?: WizardMode): Rendered {
  const onCreated = vi.fn<(plan: Plan) => void>()
  const onOpenSample = vi.fn<() => void>()
  render(
    <NewPlanWizard
      open
      launchKey={1}
      mode={mode}
      onOpenChange={() => undefined}
      onOpenSample={onOpenSample}
      onCreated={onCreated}
    />,
  )
  return { onCreated, onOpenSample }
}

function dialog(): HTMLElement {
  return screen.getByRole('dialog')
}

function click(element: HTMLElement): void {
  fireEvent.click(element)
}

async function next(): Promise<void> {
  await act(async () => {
    click(within(dialog()).getByRole('button', { name: /^Next/ }))
  })
}

async function pickKws(): Promise<void> {
  click(await within(dialog()).findByRole('radio', { name: 'KWS Rack v2' }))
  await waitFor(() =>
    expect(within(dialog()).getByRole('radio', { name: 'KWS Rack v2' })).toHaveAttribute(
      'aria-checked',
      'true',
    ),
  )
}

/** Section rows as shown: top to bottom, "label | U range". */
function shownStack(): string[] {
  const list = within(dialog()).getByRole('list', { name: 'Sections, top to bottom' })
  return within(list)
    .getAllByRole('listitem')
    .map((item) => item.querySelector('p')?.textContent ?? '')
}

beforeEach(async () => {
  await resetDbForTests()
  useUiStore.setState({ recordingMode: {} })
})

afterEach(() => {
  cleanup()
  stopLibrarySync()
  vi.restoreAllMocks()
})

describe('NewPlanWizard', () => {
  it('starts with the three choices when opened from New plan', async () => {
    const { onOpenSample } = renderWizard()
    expect(within(dialog()).getByRole('heading', { name: 'New plan' })).toBeInTheDocument()
    expect(within(dialog()).getByRole('button', { name: 'Plan a new rack' })).toBeInTheDocument()
    click(within(dialog()).getByRole('button', { name: 'Open the sample' }))
    expect(onOpenSample).toHaveBeenCalledTimes(1)

    click(within(dialog()).getByRole('button', { name: 'Record my rack and plan an upgrade' }))
    expect(
      await within(dialog()).findByRole('heading', { name: 'Which frame is your rack?' }),
    ).toBeInTheDocument()
    // Back returns to the choices.
    click(within(dialog()).getByRole('button', { name: 'Back' }))
    expect(
      within(dialog()).getByRole('heading', { name: 'How do you want to start?' }),
    ).toBeInTheDocument()
  })

  it('records a 3U + 6U KWS rack and grows it to 12U on top', async () => {
    const { onCreated } = renderWizard('record')
    expect(within(dialog()).getByRole('heading', { name: 'Record my rack' })).toBeInTheDocument()
    const steps = within(dialog()).getByRole('list', { name: 'Steps' })
    expect(within(steps).getAllByRole('listitem')[0]).toHaveAttribute('aria-current', 'step')

    // Next without a frame explains what is missing, next to the choice.
    await next()
    expect(within(dialog()).getByText('Pick a frame to continue.')).toBeInTheDocument()
    expect(
      within(dialog()).getByRole('radiogroup', { name: 'Which frame is your rack?' }),
    ).toHaveAttribute('aria-invalid', 'true')

    await pickKws()
    expect(within(dialog()).getByRole('link', { name: /Open on MakerWorld/ })).toHaveAttribute(
      'rel',
      'noopener noreferrer',
    )
    await next()
    const heading = within(dialog()).getByRole('heading', {
      name: 'What does your rack have today?',
    })
    await waitFor(() => expect(heading).toHaveFocus())

    // An empty stack cannot go on.
    await next()
    expect(within(dialog()).getByRole('alert')).toHaveTextContent('Add the sections your rack has')

    click(within(dialog()).getByRole('button', { name: /^3U \+ 6U:/ }))
    expect(shownStack()).toEqual(['6U section', '3U section'])
    expect(within(dialog()).getByText('U4–U9 · top')).toBeInTheDocument()
    const have = within(dialog()).getAllByRole('radio', { name: 'In my rack' })
    expect(have.map((radio) => radio.getAttribute('aria-checked'))).toEqual(['true', 'true'])
    // "Your rack today has…" lists the frame's options by scope.
    expect(within(dialog()).getByRole('group', { name: 'Top of the rack' })).toBeInTheDocument()
    expect(
      within(dialog()).getByRole('switch', { name: 'Bottom base stoppers' }),
    ).toBeInTheDocument()

    await next()
    expect(
      within(dialog()).getByRole('heading', { name: 'How tall do you want it?' }),
    ).toBeInTheDocument()
    expect(within(dialog()).getByRole('radio', { name: 'Grow it to a height' })).toHaveAttribute(
      'aria-checked',
      'true',
    )
    expect(within(dialog()).getByRole('radio', { name: /Fit my equipment/ })).toHaveAttribute(
      'aria-disabled',
      'true',
    )
    expect(within(dialog()).getByText('9U → 12U: a new 3U section on top.')).toBeInTheDocument()
    expect(within(dialog()).getByLabelText('Plan name')).toHaveValue('KWS Rack v2: 9U → 12U')

    await act(async () => {
      click(within(dialog()).getByRole('button', { name: 'Create plan' }))
    })
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1))
    const created = onCreated.mock.calls[0]?.[0]
    if (created === undefined) throw new Error('no plan')
    const stored = (await getPlan(created.id)).plan
    expect(
      stored.frame.sections.map((section) => [section.typeId, section.have !== undefined]),
    ).toEqual([
      ['s3', true],
      ['s6', true],
      ['s3', false],
    ])
    expect(stored.catalogRev).toMatch(/^[0-9a-f]+$/)
    expect(useUiStore.getState().recordingMode[created.id]).toBe(true)
  })

  it('adds the new sections at the bottom and keeps a typed name', async () => {
    const { onCreated } = renderWizard('record')
    await pickKws()
    await next()
    click(within(dialog()).getByRole('button', { name: /^3U \+ 6U:/ }))
    await next()
    click(within(dialog()).getByRole('radio', { name: 'At the bottom' }))
    expect(
      within(dialog()).getByText('9U → 12U: a new 3U section at the bottom.'),
    ).toBeInTheDocument()
    const name = within(dialog()).getByLabelText('Plan name')
    fireEvent.change(name, { target: { value: '' } })
    await act(async () => {
      click(within(dialog()).getByRole('button', { name: 'Create plan' }))
    })
    expect(within(dialog()).getByText('Give the plan a name.')).toBeInTheDocument()
    await waitFor(() => expect(name).toHaveFocus())
    fireEvent.change(name, { target: { value: 'Garage 12U' } })
    await act(async () => {
      click(within(dialog()).getByRole('button', { name: 'Create plan' }))
    })
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1))
    const created = onCreated.mock.calls[0]?.[0]
    expect(created?.name).toBe('Garage 12U')
    expect(created?.frame.sections.map((section) => section.have !== undefined)).toEqual([
      false,
      true,
      true,
    ])
  })

  it('moves, removes and marks sections with focus kept on the row', async () => {
    renderWizard('record')
    await pickKws()
    await next()
    click(within(dialog()).getByRole('button', { name: '3U on top' }))
    click(within(dialog()).getByRole('button', { name: '6U on top' }))
    expect(shownStack()).toEqual(['6U section', '3U section'])

    const moveDown = within(dialog()).getByRole('button', { name: 'Move 6U section, U4–U9 down' })
    moveDown.focus()
    click(moveDown)
    expect(shownStack()).toEqual(['3U section', '6U section'])
    // Now at the bottom: "down" is disabled, so focus moves to the same row's "up".
    await waitFor(() =>
      expect(
        within(dialog()).getByRole('button', { name: 'Move 6U section, U1–U6 up' }),
      ).toHaveFocus(),
    )
    expect(screen.getByText(/Moved 6U section down: now U1–U6/)).toBeInTheDocument()

    const top = within(dialog()).getByRole('radiogroup', {
      name: '3U section, U7–U9: in my rack or to get',
    })
    click(within(top).getByRole('radio', { name: 'To get' }))
    expect(within(top).getByRole('radio', { name: 'To get' })).toHaveAttribute(
      'aria-checked',
      'true',
    )
    expect(screen.getByText('3U section, U7–U9: To get.')).toBeInTheDocument()
    click(within(dialog()).getByRole('button', { name: 'Remove 3U section, U7–U9' }))
    expect(shownStack()).toEqual(['6U section'])
    await waitFor(() =>
      expect(
        within(dialog()).getByRole('button', { name: 'Remove 6U section, U1–U6' }),
      ).toHaveFocus(),
    )
  })

  it('plans a new 6U + 6U rack with everything to get', async () => {
    const { onCreated } = renderWizard('new')
    expect(within(dialog()).getByRole('heading', { name: 'Plan a new rack' })).toBeInTheDocument()
    await pickKws()
    await next()
    click(within(dialog()).getByRole('button', { name: /^6U \+ 6U:/ }))
    // No Have/Need choice for a new rack.
    expect(within(dialog()).queryByRole('radio', { name: 'In my rack' })).toBeNull()
    await next()
    expect(within(dialog()).getByRole('heading', { name: 'Name your plan' })).toBeInTheDocument()
    expect(within(dialog()).getByLabelText('Plan name')).toHaveValue('KWS Rack v2: new 12U')
    await act(async () => {
      click(within(dialog()).getByRole('button', { name: 'Create plan' }))
    })
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1))
    const created = onCreated.mock.calls[0]?.[0]
    expect(created?.frame.sections.map((section) => [section.typeId, section.have])).toEqual([
      ['s6', undefined],
      ['s6', undefined],
    ])
    expect(useUiStore.getState().recordingMode).toEqual({})
  })

  it('asks a generic rack for its height', async () => {
    const { onCreated } = renderWizard('record')
    click(await within(dialog()).findByRole('radio', { name: 'Generic 10-inch rack' }))
    await next()
    const height = within(dialog()).getByLabelText('How tall is your rack? (U)')
    expect(height).toHaveValue(6)
    fireEvent.change(height, { target: { value: '30' } })
    await next()
    expect(
      within(dialog()).getByText('Enter a whole number of U from 2 to 22.'),
    ).toBeInTheDocument()
    expect(height).toHaveAttribute('aria-invalid', 'true')
    fireEvent.change(height, { target: { value: '9' } })
    await next()
    // A one-piece rack does not grow by sections.
    expect(within(dialog()).getByRole('radio', { name: 'Grow it to a height' })).toHaveAttribute(
      'aria-disabled',
      'true',
    )
    expect(within(dialog()).getByRole('radio', { name: 'I’ll plan it myself' })).toHaveAttribute(
      'aria-checked',
      'true',
    )
    await act(async () => {
      click(within(dialog()).getByRole('button', { name: 'Create plan' }))
    })
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1))
    expect(onCreated.mock.calls[0]?.[0].frame.sections).toEqual([
      expect.objectContaining({ typeId: 'rack', heightU: 9 }),
    ])
  })
})
