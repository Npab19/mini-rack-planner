/**
 * The + handles at the top and bottom of the stack and between sections. They are HTML buttons
 * laid over the section-band column of the drawing (menus need HTML), positioned with the same
 * mm -> px scale as the SVG, so they track zoom and stay in the tab order after the drawing.
 */
import { Plus } from 'lucide-react'
import { memo } from 'react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import type { Frame } from '@/domain/schema/catalog'
import { svgYOfSixths, type RackLayout } from './rackLayout'
import { insertItemText, sectionChoices, type InsertGap, type SectionChoice } from './rackModel'

export const InsertHandles = memo(function InsertHandles({
  gaps,
  layout,
  pxPerMm,
  frame,
  totalU,
  onInsert,
}: {
  gaps: readonly InsertGap[]
  layout: RackLayout
  pxPerMm: number
  frame: Frame
  totalU: number
  onInsert: (gap: InsertGap, choice: SectionChoice) => void
}) {
  const choices = sectionChoices(frame)
  const left = (layout.bandX + layout.bandWidth / 2 - layout.leftX) * pxPerMm
  return (
    <div className="pointer-events-none absolute inset-0" data-layer="insert-handles">
      {gaps.map((gap) => (
        <div
          key={`${gap.where}-${gap.index}`}
          className="pointer-events-auto absolute -translate-x-1/2 -translate-y-1/2"
          style={{ left, top: svgYOfSixths(layout, gap.ySixths) * pxPerMm }}
        >
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="outline"
                  size="icon-sm"
                  aria-label={gap.label}
                  title={gap.label}
                  data-testid={`rack-insert-${gap.where}-${gap.index}`}
                  className="rounded-full bg-background shadow-sm dark:bg-background"
                />
              }
            >
              <Plus aria-hidden />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="center" className="w-60">
              <DropdownMenuGroup>
                <DropdownMenuLabel>{gap.heading}</DropdownMenuLabel>
                {choices.map((choice) => {
                  const tooTall = totalU + choice.heightU > frame.stack.maxU
                  return (
                    <DropdownMenuItem
                      key={choice.typeId}
                      disabled={tooTall}
                      onClick={() => onInsert(gap, choice)}
                    >
                      <Plus aria-hidden />
                      <span className="grid">
                        <span>{insertItemText(gap, choice)}</span>
                        {tooTall ? (
                          <span className="text-xs text-muted-foreground">
                            Over the {frame.stack.maxU}U maximum of {frame.name}
                          </span>
                        ) : null}
                      </span>
                    </DropdownMenuItem>
                  )
                })}
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      ))}
    </div>
  )
})
