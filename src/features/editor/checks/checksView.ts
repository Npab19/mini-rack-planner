/**
 * What the Checks panel shows, as plain functions: issues grouped by severity (plan checks and
 * stack checks together), counts in words, the power summary in plain language and the name of
 * the part a check points at.
 */
import type { Issue, IssueSeverity } from '@/domain/api'
import { placementLabel, resolvePlacedEntry } from '@/domain/bom'
import type { PowerReport } from '@/domain/power'
import { sectionHeightU, sectionLabel } from '@/domain/recipe'
import { deviceName, type CatalogLookup, type Frame } from '@/domain/schema/catalog'
import type { Plan } from '@/domain/schema/plan'

export const SEVERITY_ORDER: readonly IssueSeverity[] = ['error', 'warning', 'info']

export const SEVERITY_WORDS: Record<IssueSeverity, { one: string; many: string; title: string }> = {
  error: { one: 'error', many: 'errors', title: 'Errors' },
  warning: { one: 'warning', many: 'warnings', title: 'Warnings' },
  info: { one: 'note', many: 'notes', title: 'Info' },
}

export interface IssueGroup {
  severity: IssueSeverity
  issues: Issue[]
}

function issueId(issue: Issue): string {
  return [issue.severity, issue.code, issue.targetId ?? '', issue.message].join('\u0000')
}

/** All lists in order, each issue once (the same severity, code, target and message). */
export function mergeIssues(...lists: ReadonlyArray<readonly Issue[]>): Issue[] {
  const seen = new Set<string>()
  const merged: Issue[] = []
  for (const issue of lists.flat()) {
    const id = issueId(issue)
    if (seen.has(id)) continue
    seen.add(id)
    merged.push(issue)
  }
  return merged
}

/** Errors, warnings, info; empty groups left out; the checks' own order within a group. */
export function groupIssues(issues: readonly Issue[]): IssueGroup[] {
  return SEVERITY_ORDER.map((severity) => ({
    severity,
    issues: issues.filter((issue) => issue.severity === severity),
  })).filter((group) => group.issues.length > 0)
}

/** "2 errors · 1 warning · 3 notes", or "No problems found". */
export function countsText(groups: readonly IssueGroup[]): string {
  if (groups.length === 0) return 'No problems found'
  return groups
    .map(({ severity, issues }) => {
      const words = SEVERITY_WORDS[severity]
      return `${issues.length} ${issues.length === 1 ? words.one : words.many}`
    })
    .join(' · ')
}

// ---------------------------------------------------------------------------------------------
// Power

export type PowerStatus = 'ok' | 'short' | 'note'

export interface PowerRow {
  id: 'ac' | 'poe' | 'usbc' | 'draw'
  label: string
  value: string
  status: PowerStatus
  /** Says what the status means in words (never colour alone). */
  statusText: string
  detail?: string
}

function portsRow(
  id: 'ac' | 'usbc',
  label: string,
  needed: number,
  available: number,
  sourceWord: string,
  extra?: string,
): PowerRow | undefined {
  if (needed === 0 && available === 0) return undefined
  if (available === 0) {
    return {
      id,
      label,
      value: `${needed} needed`,
      status: 'note',
      statusText: 'Outside the rack',
      detail: `No ${sourceWord} in the plan, so these plug in outside the rack.${extra ? ` ${extra}` : ''}`,
    }
  }
  const short = needed - available
  return {
    id,
    label,
    value: `${needed} needed · ${available} available`,
    status: short > 0 ? 'short' : 'ok',
    statusText: short > 0 ? `${short} short` : 'Enough',
    ...(extra ? { detail: extra } : {}),
  }
}

function watts(value: number): string {
  return `${Math.round(value * 10) / 10} W`
}

/** The power summary as rows: AC outlets, PoE, USB-C power and the total draw. */
export function powerRows(power: PowerReport): PowerRow[] {
  const rows: PowerRow[] = []
  const battery =
    power.acOutletsBatteryBacked > 0
      ? ` ${power.acOutletsBatteryBacked} of them run on battery.`
      : ''
  const ac = portsRow(
    'ac',
    'AC outlets',
    power.acOutletsNeeded,
    power.acOutletsAvailable,
    'power strip or PDU',
    `Power bricks that plug straight into the wall take 2 outlets.${battery}`,
  )
  if (ac !== undefined) rows.push(ac)

  if (power.poePortsNeeded > 0 || power.poePortsAvailable > 0) {
    const shortPorts = power.poePortsNeeded - power.poePortsAvailable
    const overBudget = power.poeBudgetW > 0 && power.poeDemandW > power.poeBudgetW
    const budget =
      power.poeBudgetW > 0
        ? `Up to ${watts(power.poeDemandW)} of a ${watts(power.poeBudgetW)} PoE budget.`
        : undefined
    if (power.poePortsAvailable === 0) {
      rows.push({
        id: 'poe',
        label: 'PoE ports',
        value: `${power.poePortsNeeded} needed`,
        status: 'note',
        statusText: 'Outside the rack',
        detail: 'No PoE switch in the plan, so these need a switch or injector outside the rack.',
      })
    } else {
      rows.push({
        id: 'poe',
        label: 'PoE ports',
        value: `${power.poePortsNeeded} needed · ${power.poePortsAvailable} available`,
        status: shortPorts > 0 || overBudget ? 'short' : 'ok',
        statusText: shortPorts > 0 ? `${shortPorts} short` : overBudget ? 'Over budget' : 'Enough',
        ...(budget === undefined ? {} : { detail: budget }),
      })
    }
  }

  const usbc = portsRow(
    'usbc',
    'USB-C power',
    power.usbcPortsNeeded,
    power.usbcPortsAvailable,
    'USB-C charger',
  )
  if (usbc !== undefined) rows.push(usbc)

  rows.push(
    power.totalTypW > 0 || power.totalMaxW > 0
      ? {
          id: 'draw',
          label: 'Power draw',
          value: `about ${watts(power.totalTypW)} typical · up to ${watts(power.totalMaxW)}`,
          status: 'note',
          statusText: 'Estimate',
          detail: 'From the devices’ listed power use; real draw depends on the load.',
        }
      : {
          id: 'draw',
          label: 'Power draw',
          value: 'not known yet',
          status: 'note',
          statusText: 'No data',
          detail: 'None of the devices in this plan lists its power use.',
        },
  )
  return rows
}

// ---------------------------------------------------------------------------------------------
// Targets

/** What to call the section, placement, device or tray entry a check points at. */
export function targetName(
  plan: Plan,
  catalog: CatalogLookup,
  frame: Frame | undefined,
  targetId: string,
): string | undefined {
  const sectionIndex = plan.frame.sections.findIndex((section) => section.id === targetId)
  const section = plan.frame.sections[sectionIndex]
  if (section !== undefined) {
    return sectionLabel(sectionIndex, sectionHeightU(frame, section.typeId, section.heightU))
  }
  for (const placement of plan.placements) {
    const label = placementLabel(placement, resolvePlacedEntry(catalog, placement.itemId))
    if (placement.id === targetId) return label
    const placed = placement.devices.find((device) => device.id === targetId)
    if (placed !== undefined) {
      const device = catalog.device(placed.deviceId)
      return `${device ? deviceName(device) : placed.deviceId} in ${label}`
    }
  }
  const entry = plan.equipment.find((candidate) => candidate.id === targetId)
  if (entry !== undefined) {
    const device = catalog.device(entry.deviceId)
    return `${device ? deviceName(device) : entry.deviceId} (equipment to fit)`
  }
  const extra = plan.extras.find((candidate) => candidate.id === targetId)
  if (extra !== undefined) return catalog.item(extra.itemId)?.name ?? extra.itemId
  return undefined
}
