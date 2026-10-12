/**
 * "Keyboard shortcuts": every key the editor understands, the shell's global ones and the rack's
 * own (which work while a part on the rack has focus). Opened with ? or the toolbar's help button.
 */
import { Fragment, useId } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Kbd } from '@/components/ui/kbd'
import { setHelpOpen, useEditorShell } from './layout/shellStore'
import { isApplePlatform } from './toolbar/platform'

/** Keys as accent-tinted caps, so they stand out from the descriptions next to them. */
const KBD_CLASS = 'border-primary/40 bg-accent text-accent-foreground'

/** One way to press a shortcut: keys held together, e.g. ["Ctrl", "Shift", "Z"]. */
type Combo = readonly string[]

interface ShortcutRow {
  /** Alternatives ("or"), each a combo. */
  keys: readonly Combo[]
  action: string
}

interface ShortcutGroup {
  title: string
  note?: string
  rows: readonly ShortcutRow[]
}

export function shortcutGroups(apple: boolean): ShortcutGroup[] {
  const mod = apple ? '⌘' : 'Ctrl'
  const alt = apple ? '⌥' : 'Alt'
  const redo: Combo[] = apple
    ? [[mod, 'Shift', 'Z']]
    : [
        [mod, 'Shift', 'Z'],
        ['Ctrl', 'Y'],
      ]
  return [
    {
      title: 'Anywhere in the editor',
      rows: [
        { keys: [[mod, 'Z']], action: 'Undo' },
        { keys: redo, action: 'Redo' },
        { keys: [['?']], action: 'Show these shortcuts' },
        { keys: [['Esc']], action: 'Stop placing, or clear the selection' },
        { keys: [['B']], action: 'Show or hide the bill of materials' },
        {
          keys: [['F6'], ['Shift', 'F6']],
          action: 'Go to the next or previous panel',
        },
      ],
    },
    {
      title: 'View',
      rows: [
        { keys: [['F']], action: 'Fit the whole rack in view' },
        { keys: [['['], ['-']], action: 'Zoom out' },
        { keys: [[']'], ['+']], action: 'Zoom in' },
        { keys: [['1']], action: 'Show the front of the rack' },
        { keys: [['2']], action: 'Show the rear of the rack' },
      ],
    },
    {
      title: 'While placing',
      note: 'With the rack drawing focused: Place in the palette or the equipment tray puts focus there, and so does F6 to the rack.',
      rows: [
        { keys: [['↑'], ['↓']], action: 'Move the ghost one step up or down' },
        {
          keys: [
            ['Shift', '↑'],
            ['Shift', '↓'],
          ],
          action: 'Move the ghost 5 steps',
        },
        { keys: [['←'], ['→']], action: 'Choose the half for a half-width part' },
        { keys: [['Enter']], action: 'Place it where the ghost is' },
        { keys: [['Shift', 'Enter']], action: 'Place it and keep placing' },
      ],
    },
    {
      title: 'Parts on the rack',
      note: 'While a part on the rack has focus (Tab reaches the rack).',
      rows: [
        { keys: [['Enter'], ['Space']], action: 'Select the part' },
        {
          keys: [['↑'], ['↓']],
          action: 'Go to the part above or below; once selected, move it one step',
        },
        {
          keys: [
            ['Shift', '↑'],
            ['Shift', '↓'],
          ],
          action: 'Move the selected part 5 steps',
        },
        {
          keys: [
            [alt, '↑'],
            [alt, '↓'],
          ],
          action: 'Move the part without selecting it first',
        },
        { keys: [['Home'], ['End']], action: 'Go to the top or bottom part' },
        { keys: [['Delete'], ['Backspace']], action: 'Remove the part' },
        { keys: [[mod, 'D']], action: 'Duplicate the part' },
      ],
    },
  ]
}

function ComboKeys({ combo }: { combo: Combo }) {
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap">
      {combo.map((key, index) => (
        <Fragment key={key}>
          {index > 0 ? <span className="text-xs text-muted-foreground">+</span> : null}
          <Kbd className={KBD_CLASS}>{key}</Kbd>
        </Fragment>
      ))}
    </span>
  )
}

function ShortcutKeys({ keys }: { keys: readonly Combo[] }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-1">
      {keys.map((combo, index) => (
        <Fragment key={combo.join('+')}>
          {index > 0 ? <span className="text-xs text-muted-foreground">or</span> : null}
          <ComboKeys combo={combo} />
        </Fragment>
      ))}
    </span>
  )
}

function Group({ group }: { group: ShortcutGroup }) {
  const titleId = useId()
  return (
    <section aria-labelledby={titleId} className="grid gap-2">
      <div className="grid gap-0.5">
        <h3 id={titleId} className="text-sm font-medium">
          {group.title}
        </h3>
        {group.note === undefined ? null : (
          <p className="text-xs text-muted-foreground">{group.note}</p>
        )}
      </div>
      <dl className="grid gap-1.5">
        {group.rows.map((row) => (
          <div
            key={row.action}
            className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 rounded-md bg-muted/40 px-2.5 py-1.5"
          >
            <dt className="text-sm">{row.action}</dt>
            <dd className="justify-self-end">
              <ShortcutKeys keys={row.keys} />
            </dd>
          </div>
        ))}
      </dl>
    </section>
  )
}

export function KeyboardHelp() {
  const open = useEditorShell((state) => state.helpOpen)
  const groups = shortcutGroups(isApplePlatform())
  return (
    <Dialog open={open} onOpenChange={(next) => setHelpOpen(next)}>
      <DialogContent
        data-testid="keyboard-help"
        className="max-h-[85dvh] overflow-y-auto sm:max-w-lg"
      >
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>
            These keys work anywhere in the editor, except while you type in a field.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-5">
          {groups.map((group) => (
            <Group key={group.title} group={group} />
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
