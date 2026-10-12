import 'fake-indexeddb/auto'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getBackupMeta } from '@/db/backupMetaRepo'
import { resetDbForTests } from '@/db/db'
import { createPlan } from '@/db/plansRepo'
import { getSettings, updateSettings } from '@/db/settingsRepo'
import { samplePlan } from '@/domain/__fixtures__/samplePlan'
import { DEFAULT_ACCENT, setAccent, setTheme } from '@/lib/theme'
import { SettingsPage } from './SettingsPage'

function renderPage(path = '/settings') {
  const router = createMemoryRouter(
    [
      {
        path: '/settings',
        element: (
          <main>
            <SettingsPage />
          </main>
        ),
      },
      { path: '/import', element: <main>Import page</main> },
      { path: '/about', element: <main>About page</main> },
    ],
    { initialEntries: [path] },
  )
  render(<RouterProvider router={router} />)
  return router
}

function region(name: string): HTMLElement {
  return screen.getByRole('region', { name })
}

/** A field of a region, once the stored settings have loaded into it. */
async function loadedField(regionName: string, label: string): Promise<HTMLInputElement> {
  const field = within(region(regionName)).getByLabelText(label)
  if (!(field instanceof HTMLInputElement)) throw new Error(`${label} is not an input`)
  await waitFor(() => expect(field).toBeEnabled())
  return field
}

function edit(field: HTMLElement, value: string, commit: 'blur' | 'enter' = 'blur'): void {
  fireEvent.change(field, { target: { value } })
  if (commit === 'blur') fireEvent.blur(field)
  else fireEvent.keyDown(field, { key: 'Enter' })
}

async function stored<T>(read: (settings: Awaited<ReturnType<typeof getSettings>>) => T) {
  return read(await getSettings())
}

beforeEach(async () => {
  await resetDbForTests()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  setTheme('system')
  setAccent(DEFAULT_ACCENT)
})

describe('SettingsPage', () => {
  it('shows every section as a named region with an in-page link', () => {
    renderPage()
    expect(screen.getByRole('heading', { level: 1, name: 'Settings' })).toBeInTheDocument()
    const nav = screen.getByRole('navigation', { name: 'Settings sections' })
    for (const name of [
      'Appearance',
      'Costs & spares',
      'Printer',
      'Storage',
      'Backup',
      'Diagnostics',
      'About',
    ]) {
      expect(region(name)).toBeInTheDocument()
      const link = within(nav).getByRole('link', { name })
      expect(link.getAttribute('href')).toBe(`#${region(name).id}`)
    }
  })

  it('moves focus to the section a link points at (/settings#storage)', async () => {
    renderPage('/settings#storage')
    const heading = within(region('Storage')).getByRole('heading', { level: 2, name: 'Storage' })
    await waitFor(() => expect(heading).toHaveFocus())
  })

  it('saves filament prices as they are edited, and shows that it saved', async () => {
    renderPage()
    const pla = await loadedField('Costs & spares', 'PLA')
    expect(pla).toHaveValue('20')
    edit(pla, '24,5')
    await waitFor(async () => expect(await stored((s) => s.filamentCostPerKg.PLA)).toBe(24.5))
    expect(await within(region('Costs & spares')).findByText('Saved')).toBeInTheDocument()
    expect(pla).toHaveValue('24.5')

    // Empty means "price unknown": the material leaves the record.
    const petg = await loadedField('Costs & spares', 'PETG')
    edit(petg, '', 'enter')
    await waitFor(async () =>
      expect(await stored((s) => 'PETG' in s.filamentCostPerKg)).toBe(false),
    )
    expect(await stored((s) => s.filamentCostPerKg)).toEqual({ PLA: 24.5 })
  })

  it('saves spare percentages as fractions and maps "Other hardware" to the default', async () => {
    renderPage()
    const screws = await loadedField('Costs & spares', 'Screws')
    expect(screws).toHaveValue('10')
    edit(screws, '15', 'enter')
    const other = await loadedField('Costs & spares', 'Other hardware')
    edit(other, '2.5')
    await waitFor(async () =>
      expect(await stored((s) => s.sparePct)).toEqual({
        screw: 0.15,
        nut: 0.1,
        insert: 0.1,
        magnet: 0.05,
        default: 0.025,
      }),
    )
  })

  it('refuses invalid numbers with a message and saves nothing', async () => {
    renderPage()
    const nuts = await loadedField('Costs & spares', 'Nuts')
    edit(nuts, '-3')
    expect(await screen.findByRole('alert')).toHaveTextContent('Enter a number using digits')
    expect(nuts).toHaveAttribute('aria-invalid', 'true')
    expect(nuts).toHaveAccessibleDescription(/Enter a number using digits/)

    edit(nuts, '150', 'enter')
    expect(await screen.findByRole('alert')).toHaveTextContent('from 0 to 100')
    edit(nuts, '', 'enter')
    expect(await screen.findByRole('alert')).toHaveTextContent('or 0 for no spares')

    // Escape puts the stored value back.
    fireEvent.keyDown(nuts, { key: 'Escape' })
    expect(nuts).toHaveValue('10')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(await stored((s) => s.sparePct.nut)).toBe(0.1)
  })

  it('takes any three-letter currency code under "Other"', async () => {
    await updateSettings({ currency: 'CHF' })
    renderPage()
    const trigger = within(region('Costs & spares')).getByRole('combobox', { name: 'Currency' })
    await waitFor(() => expect(trigger).toHaveTextContent('Other…'))
    const code = await loadedField('Costs & spares', 'Currency code')
    await waitFor(() => expect(code).toHaveValue('CHF'))
    edit(code, 'sek')
    await waitFor(async () => expect(await stored((s) => s.currency)).toBe('SEK'))
    expect(code).toHaveValue('SEK')
    // The unit next to prices follows.
    expect(await within(region('Costs & spares')).findAllByText('SEK/kg')).toHaveLength(5)

    edit(code, 'S1', 'enter')
    expect(await screen.findByRole('alert')).toHaveTextContent('three-letter currency code')
    expect(await stored((s) => s.currency)).toBe('SEK')
  })

  it('picks a listed currency from the list', async () => {
    renderPage()
    const trigger = within(region('Costs & spares')).getByRole('combobox', { name: 'Currency' })
    await waitFor(() => expect(trigger).toHaveTextContent('USD'))
    await waitFor(() => expect(trigger).toBeEnabled())
    // Base UI opens the list on mousedown and takes a mouse choice after a pointerdown on it.
    fireEvent.mouseDown(trigger, { button: 0 })
    const eur = await screen.findByRole('option', { name: /EUR/ })
    fireEvent.pointerDown(eur, { pointerType: 'mouse' })
    fireEvent.click(eur)
    await waitFor(async () => expect(await stored((s) => s.currency)).toBe('EUR'))
    await waitFor(() => expect(trigger).toHaveTextContent('EUR'))
    expect(within(region('Costs & spares')).queryByLabelText('Currency code')).toBeNull()
  })

  it('saves the printer bed only once all three sizes are in, and clears it', async () => {
    renderPage()
    const printer = () => region('Printer')
    const x = await loadedField('Printer', 'Width (X)')
    edit(x, '256')
    expect(await within(printer()).findByText(/Enter all three sizes/)).toBeInTheDocument()
    expect(await stored((s) => s.printerBedMm)).toBeUndefined()

    edit(await loadedField('Printer', 'Depth (Y)'), '256')
    edit(await loadedField('Printer', 'Height (Z)'), '250.5', 'enter')
    await waitFor(async () =>
      expect(await stored((s) => s.printerBedMm)).toEqual({ x: 256, y: 256, z: 250.5 }),
    )
    expect(
      await within(printer()).findByText('Parts larger than 256 × 256 × 250.5 mm get a warning.'),
    ).toBeInTheDocument()

    fireEvent.click(within(printer()).getByRole('button', { name: 'Clear bed size' }))
    await waitFor(async () => expect(await stored((s) => s.printerBedMm)).toBeUndefined())
    expect(x).toHaveValue('')
    expect(x).toHaveFocus()
  })

  it('switches the theme and remembers it', () => {
    renderPage()
    const appearance = region('Appearance')
    const dark = within(appearance).getByRole('radio', { name: 'Dark' })
    expect(within(appearance).getByRole('radio', { name: 'System' })).toBeChecked()
    fireEvent.click(dark)
    expect(dark).toBeChecked()
    expect(document.documentElement).toHaveClass('dark')
    expect(window.localStorage.getItem('mrp-theme')).toBe('dark')
    expect(within(appearance).getByRole('status')).toHaveTextContent('Saved')
  })

  it('switches the accent colour and remembers it', () => {
    renderPage()
    const accent = within(region('Appearance')).getByRole('radiogroup', { name: 'Accent colour' })
    expect(within(accent).getAllByRole('radio')).toHaveLength(7)
    expect(within(accent).getByRole('radio', { name: 'Indigo' })).toBeChecked()
    const teal = within(accent).getByRole('radio', { name: 'Teal' })
    fireEvent.click(teal)
    expect(teal).toBeChecked()
    expect(document.documentElement.dataset.accent).toBe('teal')
    expect(window.localStorage.getItem('mrp-accent')).toBe('teal')
    expect(within(region('Appearance')).getByRole('status')).toHaveTextContent('Saved')
    fireEvent.click(within(accent).getByRole('radio', { name: 'Indigo' }))
    expect(document.documentElement).not.toHaveAttribute('data-accent')
  })

  it('exports everything to a dated JSON file and remembers when', async () => {
    await createPlan(samplePlan())
    let downloadName = ''
    let blob: Blob | undefined
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: (value: Blob) => {
        blob = value
        return 'blob:test'
      },
    })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: () => undefined })
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      downloadName = this.download
    })

    renderPage()
    const backup = region('Backup')
    expect(await within(backup).findByText('Never from this browser.')).toBeInTheDocument()
    fireEvent.click(within(backup).getByRole('button', { name: 'Export everything' }))

    const status = within(backup).getByRole('status')
    await waitFor(() =>
      expect(status).toHaveTextContent(
        /Backup downloaded as mini-rack-planner-backup-\d{4}-\d{2}-\d{2}\.json \(1 plan, 0 custom parts, settings and parts on hand\)/,
      ),
    )
    expect(downloadName).toMatch(/^mini-rack-planner-backup-\d{4}-\d{2}-\d{2}\.json$/)
    const file: unknown = JSON.parse((await blob?.text()) ?? '')
    expect(file).toMatchObject({
      format: 'mini-rack-planner-backup',
      plans: [{ name: samplePlan().name }],
    })
    expect(file).toHaveProperty('settings.currency', 'USD')
    expect((await getBackupMeta()).lastBackupAt).toBeDefined()
    expect(await within(backup).findByText(/\(today\)/)).toBeInTheDocument()
    expect(within(backup).getByRole('link', { name: 'Import a backup' })).toHaveAttribute(
      'href',
      '/import',
    )
  })
})
