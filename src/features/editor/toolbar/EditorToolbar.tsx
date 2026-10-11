/**
 * The editor's toolbar. Desktop (lg+), one row: back, the plan name (the page heading) with the
 * frame and stack under it, save state, Undo/Redo, zoom and Fit, Front/Rear, Checks, BOM and the
 * keyboard help. Below lg, three rows that fit 360 px: back, name, save state and help; history,
 * zoom and face; then the panel buttons that open sheets.
 */
import { ArrowLeft } from 'lucide-react'
import { memo, type Ref } from 'react'
import { Link } from 'react-router'
import { buttonVariants } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { TOOLBAR_ID } from '../layout/shellStore'
import { FaceToggle } from './FaceToggle'
import { HistoryControls } from './HistoryControls'
import { PanelButtons } from './PanelButtons'
import { PlanMeta } from './PlanMeta'
import { PlanNameField } from './PlanNameField'
import { SaveIndicator } from './SaveIndicator'
import { BomButton, ChecksButton, HelpButton } from './StatusButtons'
import { ZoomControls } from './ZoomControls'

function BackToPlans() {
  return (
    <Link
      to="/"
      title="Back to your racks"
      className={cn(
        buttonVariants({ variant: 'ghost', size: 'sm' }),
        'shrink-0 text-muted-foreground max-xl:w-7 max-xl:px-0',
      )}
    >
      <ArrowLeft aria-hidden />
      <span className="sr-only xl:not-sr-only">Your racks</span>
    </Link>
  )
}

function Divider() {
  return <span aria-hidden className="h-6 w-px shrink-0 bg-border" />
}

export interface EditorToolbarProps {
  /** lg and up: one row, panels in columns. Below: wrapped rows and panel buttons. */
  desktop: boolean
  /** The plan name's heading, focused when the plan opens. */
  headingRef: Ref<HTMLHeadingElement>
}

export const EditorToolbar = memo(function EditorToolbar({
  desktop,
  headingRef,
}: EditorToolbarProps) {
  return (
    <header
      id={TOOLBAR_ID}
      data-testid="editor-toolbar"
      className="shrink-0 border-b bg-background"
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 px-2 py-1.5 lg:px-3">
        <BackToPlans />
        <div className="grid min-w-0 flex-1 basis-40">
          <PlanNameField headingRef={headingRef} />
          <PlanMeta />
        </div>
        <SaveIndicator />
        {desktop ? null : <HelpButton />}
        {desktop ? (
          <div className="flex flex-wrap items-center gap-2">
            <Divider />
            <HistoryControls />
            <Divider />
            <ZoomControls />
            <FaceToggle />
            <Divider />
            <ChecksButton variant="toolbar" />
            <BomButton variant="toolbar" />
            <HelpButton />
          </div>
        ) : null}
      </div>
      {desktop ? null : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1.5 px-2 pb-1.5">
            <HistoryControls />
            <ZoomControls />
            <FaceToggle />
          </div>
          <PanelButtons />
        </>
      )}
    </header>
  )
})
