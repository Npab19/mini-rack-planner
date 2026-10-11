/**
 * "Rack contents": the stack as a list (sections top to bottom, what is mounted in each with its
 * U range and In my rack / To get, and the devices on it), with a button to select each. It is
 * visually hidden until it holds focus, then shows as a panel over the rack, so keyboard users see
 * where they are. One tab stop: the arrow keys (and Home/End) move between its buttons.
 */
import { memo, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { cn } from '@/lib/utils'
import {
  haveWords,
  placementAriaLabel,
  sectionAriaLabel,
  type ContentsGroup,
  type DeviceView,
  type PlacementView,
} from './rackModel'

export interface RackContentsListProps {
  groups: readonly ContentsGroup[]
  selection: readonly string[]
  onSelectSection: (sectionId: string) => void
  onSelectPlacement: (view: PlacementView) => void
  onSelectDevice: (view: PlacementView, device: DeviceView) => void
}

/** Each entry's place in reading order (the roving tab stop moves along it). */
function entryPositions(groups: readonly ContentsGroup[]): Map<string, number> {
  const keys: string[] = []
  for (const group of groups) {
    if (group.section !== undefined) keys.push(`section:${group.section.id}`)
    for (const view of group.placements) {
      keys.push(`placement:${view.id}`)
      for (const device of view.devices) keys.push(`device:${device.id}`)
    }
  }
  return new Map(keys.map((key, index) => [key, index]))
}

const ITEM =
  'w-full rounded-md px-2 py-1 text-left text-sm outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 aria-pressed:font-semibold'

export const RackContentsList = memo(function RackContentsList({
  groups,
  selection,
  onSelectSection,
  onSelectPlacement,
  onSelectDevice,
}: RackContentsListProps) {
  const headingId = useId()
  const listRef = useRef<HTMLUListElement>(null)
  const [activeIndex, setActiveIndex] = useState(0)

  function buttons(): HTMLButtonElement[] {
    return [...(listRef.current?.querySelectorAll<HTMLButtonElement>('button[data-entry]') ?? [])]
  }

  function onKeyDown(event: KeyboardEvent<HTMLUListElement>): void {
    const all = buttons()
    const current = all.indexOf(event.target as HTMLButtonElement)
    if (current < 0) return
    let next: number | undefined
    if (event.key === 'ArrowDown') next = Math.min(all.length - 1, current + 1)
    else if (event.key === 'ArrowUp') next = Math.max(0, current - 1)
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = all.length - 1
    if (next === undefined) return
    event.preventDefault()
    setActiveIndex(next)
    all[next]?.focus()
  }

  const positions = useMemo(() => entryPositions(groups), [groups])
  // Entries can disappear (a removed item): the tab stop must always be on one of them.
  const active = Math.max(0, Math.min(activeIndex, positions.size - 1))
  /** Roving tabindex: the active entry is the list's single tab stop. */
  const entryProps = (key: string) => {
    const position = positions.get(key) ?? -1
    return {
      'data-entry': position,
      tabIndex: position === active ? 0 : -1,
      onFocus: () => setActiveIndex(position),
    }
  }
  const isSelected = (id: string): boolean => selection.includes(id)

  return (
    <section
      aria-labelledby={headingId}
      data-testid="rack-contents"
      className="absolute top-2 left-2 z-20 max-h-[70%] w-[min(24rem,calc(100%-1rem))] overflow-y-auto rounded-lg border bg-popover p-3 text-popover-foreground shadow-lg not-focus-within:sr-only"
    >
      <h2 id={headingId} className="text-sm font-medium">
        Rack contents, top to bottom
      </h2>
      <p className="mt-0.5 text-xs text-muted-foreground">
        Arrow keys move through the list; Enter selects.
      </p>
      {groups.length === 0 ? (
        <p className="mt-2 text-sm">The rack has no sections yet.</p>
      ) : (
        <ul ref={listRef} className="mt-2 grid gap-1" onKeyDown={onKeyDown}>
          {groups.map((group) => (
            <li key={group.section?.id ?? 'outside'} className="grid gap-0.5">
              {group.section === undefined ? (
                <span className="px-2 py-1 text-sm font-medium">Outside the rack</span>
              ) : (
                <button
                  type="button"
                  {...entryProps(`section:${group.section.id}`)}
                  aria-pressed={isSelected(group.section.id)}
                  className={cn(ITEM, 'font-medium')}
                  onClick={() => {
                    if (group.section !== undefined) onSelectSection(group.section.id)
                  }}
                >
                  {sectionAriaLabel(group.section)}
                </button>
              )}
              {group.placements.length === 0 ? null : (
                <ul className="ml-3 grid gap-0.5 border-l pl-2">
                  {group.placements.map((view) => (
                    <li key={view.id} className="grid gap-0.5">
                      <button
                        type="button"
                        {...entryProps(`placement:${view.id}`)}
                        aria-pressed={isSelected(view.id)}
                        className={ITEM}
                        onClick={() => onSelectPlacement(view)}
                      >
                        {placementAriaLabel({ ...view, devices: [] })}
                      </button>
                      {view.devices.length === 0 ? null : (
                        <ul className="ml-3 grid gap-0.5 border-l pl-2">
                          {view.devices.map((device) => (
                            <li key={device.id}>
                              <button
                                type="button"
                                {...entryProps(`device:${device.id}`)}
                                aria-pressed={isSelected(device.id)}
                                className={ITEM}
                                onClick={() => onSelectDevice(view, device)}
                              >
                                {device.known ? device.name : `Unknown device: ${device.name}`},{' '}
                                {haveWords(device.have)}
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
})
