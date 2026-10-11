import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useUiStore } from '@/state/uiStore'
import { useEditorState } from '../editorState'
import { clearAnnouncement, useEditorAnnouncer } from '../layout/announcer'
import { panelDomId, resetEditorShell, useEditorShell } from '../layout/shellStore'
import { createEditorActions } from './editorActions'
import { subscribeFitRequest } from './fitRequest'

function said(): string {
  return useEditorAnnouncer.getState().message.trim()
}

beforeEach(() => {
  useUiStore.setState({ ...useUiStore.getInitialState(), recordingMode: {} })
  useEditorState.getState().reset()
  resetEditorShell()
  clearAnnouncement()
})

afterEach(cleanup)

describe('editor actions', () => {
  it('zoom by steps and say the zoom, also when it cannot go further', () => {
    const actions = createEditorActions({ desktop: true })
    actions.zoomIn()
    expect(useUiStore.getState().zoom).toBe(1.1)
    expect(said()).toBe('Zoom 110%.')
    actions.resetZoom()
    expect(useUiStore.getState().zoom).toBe(1)
    useUiStore.getState().setZoom(0.25)
    actions.zoomOut()
    expect(useUiStore.getState().zoom).toBe(0.25)
    expect(said()).toBe('Zoom 25%, the smallest.')
    // The same words twice are still announced (the live region text changes).
    const before = useEditorAnnouncer.getState().message
    actions.zoomOut()
    expect(useEditorAnnouncer.getState().message).not.toBe(before)
  })

  it('fit through the rack when it listens, else back to 100 %', () => {
    const actions = createEditorActions({ desktop: true })
    useUiStore.getState().setZoom(2)
    actions.fit()
    expect(useUiStore.getState().zoom).toBe(1)
    const stop = subscribeFitRequest(() => useUiStore.getState().setZoom(0.6))
    actions.fit()
    stop()
    expect(useUiStore.getState().zoom).toBe(0.6)
    expect(said()).toBe('Zoomed to fit: 60%.')
  })

  it('turn the rack and say which side shows', () => {
    const actions = createEditorActions({ desktop: true })
    actions.setFace('rear')
    expect(useUiStore.getState().face).toBe('rear')
    expect(said()).toBe('Showing the rear of the rack.')
    actions.setFace('front')
    expect(useUiStore.getState().face).toBe('front')
  })

  it('toggle the BOM drawer on desktop and the BOM sheet below lg', () => {
    const desktop = createEditorActions({ desktop: true })
    desktop.toggleBom()
    expect(useUiStore.getState().panels.bom).toBe(true)
    expect(said()).toBe('Bill of materials shown.')
    desktop.toggleBom()
    expect(useUiStore.getState().panels.bom).toBe(false)

    const mobile = createEditorActions({ desktop: false })
    mobile.toggleBom()
    expect(useEditorShell.getState()).toMatchObject({ sheet: 'bom', sheetOpen: true })
    expect(useUiStore.getState().panels.bom).toBe(false)
    mobile.toggleBom()
    expect(useEditorShell.getState().sheetOpen).toBe(false)
    mobile.showChecks()
    expect(useEditorShell.getState()).toMatchObject({ sheet: 'checks', sheetOpen: true })
    mobile.openHelp()
    expect(useEditorShell.getState().helpOpen).toBe(true)
  })

  it('show Checks on desktop by moving focus into its panel', () => {
    render(
      <div id={panelDomId('checks')}>
        <section aria-label="Checks">
          <h2>Checks</h2>
          <button type="button">First issue</button>
        </section>
      </div>,
    )
    createEditorActions({ desktop: true }).showChecks()
    expect(document.activeElement?.textContent).toBe('Checks')
    expect(document.activeElement?.getAttribute('tabindex')).toBe('-1')
  })

  it('Esc stops placing first, then clears the selection, then leaves the key alone', () => {
    const actions = createEditorActions({ desktop: true })
    useEditorState.getState().startPlacing({ kind: 'item', itemId: 'generic-blank-1u' })
    useUiStore.getState().select(['a', 'b'])
    expect(actions.escape()).toBe(true)
    expect(useEditorState.getState().placing).toBeNull()
    expect(useUiStore.getState().selection).toEqual(['a', 'b'])
    expect(said()).toBe('Stopped placing.')
    expect(actions.escape()).toBe(true)
    expect(useUiStore.getState().selection).toEqual([])
    expect(said()).toBe('Selection cleared.')
    expect(actions.escape()).toBe(false)
  })

  it('leave Esc to the rack while it moves a part', () => {
    const actions = createEditorActions({ desktop: true })
    useUiStore.getState().select(['a'])
    useEditorState.getState().setMoving('a')
    expect(actions.escape()).toBe(false)
    expect(useUiStore.getState().selection).toEqual(['a'])
    expect(actions.cancelPlacing()).toBe(false)
  })
})
