import 'fake-indexeddb/auto'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dismissBackupNudge, getBackupMeta, recordBackup } from '@/db/backupMetaRepo'
import { resetDbForTests } from '@/db/db'
import { createPlan } from '@/db/plansRepo'
import { samplePlan } from '@/domain/__fixtures__/samplePlan'
import { BackupNudge } from './BackupNudge'

const DAY = 86_400_000

function changedPlans(daysAgo = 1) {
  return [{ updatedAt: new Date(Date.now() - daysAgo * DAY).toISOString() }]
}

function renderNudge(plans: readonly { updatedAt: string }[] | undefined) {
  return render(
    <main>
      <h1>Your racks</h1>
      <BackupNudge plans={plans} />
    </main>,
  )
}

/** Lets the metadata live query answer, so "not shown" is a real answer and not "still loading". */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50))
  })
}

let downloads: string[] = []

beforeEach(async () => {
  await resetDbForTests()
  downloads = []
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: () => 'blob:test' })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: () => undefined })
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    downloads.push(this.download)
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  Object.defineProperty(window, 'showSaveFilePicker', { configurable: true, value: undefined })
  Object.defineProperty(navigator, 'userActivation', { configurable: true, value: undefined })
})

describe('BackupNudge', () => {
  it('asks for a backup when there are plans and none was ever made', async () => {
    renderNudge(changedPlans())
    const nudge = await screen.findByRole('region', { name: 'Backup reminder' })
    expect(nudge).toHaveTextContent('Plans live only in this browser. Export a backup now?')
    expect(nudge).toHaveTextContent('There is no backup from this browser yet.')
    expect(within(nudge).getByRole('button', { name: 'Export' })).toBeEnabled()
    expect(within(nudge).getByRole('button', { name: 'Later' })).toBeEnabled()
  })

  it('stays away without plans, while plans load, and after a recent backup', async () => {
    const view = renderNudge([])
    await settle()
    expect(screen.queryByRole('region', { name: 'Backup reminder' })).toBeNull()
    view.rerender(
      <main>
        <BackupNudge plans={undefined} />
      </main>,
    )
    await settle()
    expect(screen.queryByRole('region', { name: 'Backup reminder' })).toBeNull()
    cleanup()

    await recordBackup(new Date(Date.now() - 3 * DAY))
    renderNudge(changedPlans())
    await settle()
    expect(screen.queryByRole('region', { name: 'Backup reminder' })).toBeNull()
  })

  it('comes back when the last backup is old and plans changed since', async () => {
    await recordBackup(new Date(Date.now() - 20 * DAY))
    renderNudge(changedPlans())
    const nudge = await screen.findByRole('region', { name: 'Backup reminder' })
    expect(nudge).toHaveTextContent(
      'The last backup was 20 days ago, and plans have changed since.',
    )
  })

  it('"Later" hides it, remembers when, and keeps focus on the page', async () => {
    renderNudge(changedPlans())
    const nudge = await screen.findByRole('region', { name: 'Backup reminder' })
    fireEvent.click(within(nudge).getByRole('button', { name: 'Later' }))
    expect(screen.queryByRole('region', { name: 'Backup reminder' })).toBeNull()
    expect(screen.getByRole('main')).toHaveFocus()
    await waitFor(async () => expect((await getBackupMeta()).nudgeDismissedAt).toBeDefined())

    // A new visit within the snooze stays quiet.
    cleanup()
    renderNudge(changedPlans())
    await settle()
    expect(screen.queryByRole('region', { name: 'Backup reminder' })).toBeNull()
  })

  it('"Export" saves a full backup and goes away', async () => {
    await createPlan(samplePlan())
    renderNudge(changedPlans())
    const nudge = await screen.findByRole('region', { name: 'Backup reminder' })
    fireEvent.click(within(nudge).getByRole('button', { name: 'Export' }))
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'Backup reminder' })).toBeNull(),
    )
    expect(downloads).toHaveLength(1)
    expect(downloads[0]).toMatch(/^mini-rack-planner-backup-\d{4}-\d{2}-\d{2}\.json$/)
    expect((await getBackupMeta()).lastBackupAt).toBeDefined()
    expect(screen.getByRole('main')).toHaveFocus()
  })

  it('stays when the user closes the save dialog', async () => {
    vi.stubGlobal('isSecureContext', true)
    Object.defineProperty(navigator, 'userActivation', {
      configurable: true,
      value: { isActive: true, hasBeenActive: true },
    })
    Object.defineProperty(window, 'showSaveFilePicker', {
      configurable: true,
      value: () => Promise.reject(new DOMException('The user aborted a request.', 'AbortError')),
    })
    renderNudge(changedPlans())
    const nudge = await screen.findByRole('region', { name: 'Backup reminder' })
    const exportButton = within(nudge).getByRole('button', { name: 'Export' })
    fireEvent.click(exportButton)
    await waitFor(() => expect(exportButton).toHaveTextContent('Export'))
    await settle()
    expect(screen.getByRole('region', { name: 'Backup reminder' })).toBeInTheDocument()
    expect(downloads).toHaveLength(0)
    expect((await getBackupMeta()).lastBackupAt).toBeUndefined()
  })

  it('follows a dismissal made in another tab', async () => {
    renderNudge(changedPlans())
    await screen.findByRole('region', { name: 'Backup reminder' })
    await dismissBackupNudge()
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'Backup reminder' })).toBeNull(),
    )
  })
})
