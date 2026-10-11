/**
 * The inspector: two tabs, Selection and Rack (`useEditorState.inspectorTab`).
 * - Selection shows the selected placement, section, or several things at once. Selecting
 *   something on the rack switches to it.
 * - Rack is the persistent rack view: frame facts, the section stack editor, Set height, and the
 *   frame's options. With nothing selected, the inspector shows it.
 * Every change goes through the plan store (undoable, autosaved) and is announced politely.
 */
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { LiveRegion, useAnnouncer } from '@/components/common/LiveRegion'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useUiStore } from '@/state/uiStore'
import { useEditorState } from '../editorState'
import { selectInEditor } from '../selection'
import { MultiInspector } from './MultiInspector'
import { PlacementInspector } from './PlacementInspector'
import { resolveSelection, type ResolvedSelection } from './placementOps'
import { useSpareContext, type SpareContext } from './planOps'
import { RackTab } from './RackTab'
import { SectionInspector } from './SectionInspector'
import { useOpenPlan, type OpenPlan } from './useOpenPlan'
import { useStackOps, type StackOps } from './useStackOps'

const NOTHING: ResolvedSelection = { kind: 'none' }

function SelectionView({
  selection,
  open,
  ops,
  spares,
  announce,
  onGone,
  onPick,
}: {
  selection: ResolvedSelection
  open: OpenPlan
  ops: StackOps
  spares: SpareContext
  announce: (text: string) => void
  onGone: () => void
  onPick: (ids: readonly string[]) => void
}) {
  switch (selection.kind) {
    case 'none':
      return null
    case 'placement':
      return (
        <PlacementInspector
          key={selection.placement.id}
          placement={selection.placement}
          open={open}
          spares={spares}
          announce={announce}
          onGone={onGone}
          {...(selection.deviceEntryId === undefined
            ? {}
            : { deviceEntryId: selection.deviceEntryId })}
        />
      )
    case 'section': {
      const { frame } = open
      if (frame === undefined) {
        return (
          <p className="text-sm text-muted-foreground">
            This plan’s frame is not in the catalog, so its sections cannot be edited.
          </p>
        )
      }
      return (
        <SectionInspector
          key={selection.section.id}
          section={selection.section}
          open={{ ...open, frame }}
          ops={ops}
          spares={spares}
          announce={announce}
          onGone={onGone}
          onPick={onPick}
        />
      )
    }
    case 'multi':
      return (
        <MultiInspector
          placements={selection.placements}
          sections={selection.sections}
          open={open}
          spares={spares}
          announce={announce}
          onCleared={onGone}
        />
      )
  }
}

export function Inspector() {
  const open = useOpenPlan()
  const spares = useSpareContext()
  const [message, announce] = useAnnouncer()
  const ops = useStackOps(announce, spares)
  const selectionIds = useUiStore((state) => state.selection)
  const inspectorTab = useEditorState((state) => state.inspectorTab)
  const tabsRef = useRef<HTMLDivElement>(null)
  /** Focus the shown panel's heading after the next render (see `focusAfterRender`). */
  const focusHeading = useRef(false)
  const plan = open?.plan
  const selection = useMemo(
    () => (plan === undefined ? NOTHING : resolveSelection(plan, selectionIds)),
    [plan, selectionIds],
  )
  const primary = selectionIds[0]

  // Selecting something (on the rack, or from a list here) shows it.
  useEffect(() => {
    if (primary !== undefined) useEditorState.getState().setInspectorTab('selection')
  }, [primary])

  useLayoutEffect(() => {
    if (!focusHeading.current) return
    const heading = tabsRef.current?.querySelector<HTMLElement>(
      '[role="tabpanel"] [data-panel-focus]',
    )
    if (heading === null || heading === undefined) return
    focusHeading.current = false
    heading.focus()
  })

  if (open === null) {
    return (
      <section aria-label="Inspector" className="p-3 text-sm text-muted-foreground">
        Open a plan to see its details.
      </section>
    )
  }

  const tab = selection.kind === 'none' ? 'rack' : inspectorTab

  /**
   * The focused control is about to go away with its panel (the selection was deleted or cleared,
   * or something was picked from a list here): focus the heading of what shows next.
   */
  function focusAfterRender(): void {
    focusHeading.current = true
  }

  function pick(ids: readonly string[]): void {
    focusAfterRender()
    // The rack turns to the part's face and scrolls it into view.
    selectInEditor(ids)
  }

  return (
    <section
      aria-label="Inspector"
      className="@container flex min-w-0 flex-col gap-3 p-3"
      data-testid="inspector"
    >
      {open.readOnly ? (
        <p className="rounded-md border border-dashed p-2 text-xs text-muted-foreground">
          Read-only: this plan was made with a newer version, so it cannot be changed here.
        </p>
      ) : null}
      <Tabs
        ref={tabsRef}
        value={tab}
        onValueChange={(value) => {
          useEditorState.getState().setInspectorTab(value === 'rack' ? 'rack' : 'selection')
        }}
        className="gap-3"
      >
        <TabsList aria-label="Inspector views" className="w-full">
          <TabsTrigger value="selection" disabled={selection.kind === 'none'}>
            Selection
          </TabsTrigger>
          <TabsTrigger value="rack">Rack</TabsTrigger>
        </TabsList>
        {selection.kind === 'none' ? (
          <p className="text-xs text-muted-foreground">
            Nothing selected: select a part or a section on the rack to see and change it.
          </p>
        ) : null}
        <TabsContent value="selection">
          <SelectionView
            selection={selection}
            open={open}
            ops={ops}
            spares={spares}
            announce={announce}
            onGone={focusAfterRender}
            onPick={pick}
          />
        </TabsContent>
        <TabsContent value="rack">
          <RackTab open={open} ops={ops} spares={spares} announce={announce} onPick={pick} />
        </TabsContent>
      </Tabs>
      <LiveRegion message={message} />
      {ops.dialog}
    </section>
  )
}
