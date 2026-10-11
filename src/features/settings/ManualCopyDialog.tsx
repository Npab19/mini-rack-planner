import { useRef, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'

export interface ManualCopyDialogProps {
  /** The text to copy; null closes the dialog. */
  text: string | null
  title: string
  /** Accessible name of the text box, e.g. "Diagnostics report". */
  label: string
  onClose: () => void
}

/**
 * The fallback when copying is blocked (`copyText` resolved false): the text in a read-only box
 * that opens focused and fully selected, so Ctrl+C (or the phone's Copy) is all that is left.
 * Focus returns to the button that opened it when it closes.
 */
export function ManualCopyDialog({ text, title, label, onClose }: ManualCopyDialogProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  // Keeps the text on screen while the dialog animates closed.
  const [shownText, setShownText] = useState(text ?? '')
  if (text !== null && text !== shownText) setShownText(text)

  return (
    <Dialog
      open={text !== null}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent initialFocus={textareaRef} className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            Copying is blocked in this browser, so the text is selected for you: press Ctrl+C (⌘C on
            a Mac) or use your device&apos;s Copy.
          </DialogDescription>
        </DialogHeader>
        <Textarea
          ref={textareaRef}
          readOnly
          rows={10}
          spellCheck={false}
          aria-label={label}
          value={shownText}
          onFocus={(event) => {
            // select() alone does not select on iOS.
            event.currentTarget.select()
            event.currentTarget.setSelectionRange(0, event.currentTarget.value.length)
          }}
          className="field-sizing-fixed max-h-72 font-mono text-xs md:text-xs"
        />
        <DialogFooter showCloseButton />
      </DialogContent>
    </Dialog>
  )
}
