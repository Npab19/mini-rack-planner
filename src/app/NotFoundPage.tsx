import { MapPinOff } from 'lucide-react'
import { Link } from 'react-router'
import { Button } from '@/components/ui/button'

export function NotFoundPage() {
  return (
    <div className="mx-auto flex max-w-lg flex-col gap-4 p-8">
      <span
        aria-hidden="true"
        className="flex size-10 items-center justify-center rounded-lg bg-accent text-primary"
      >
        <MapPinOff className="size-5" />
      </span>
      <h1 className="text-xl font-semibold">Page not found</h1>
      <p className="text-sm text-muted-foreground">That page doesn&apos;t exist.</p>
      <div>
        <Button render={<Link to="/" />}>Back to plans</Button>
      </div>
    </div>
  )
}
