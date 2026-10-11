import { ClipboardList, PlusSquare, Sparkles } from 'lucide-react'
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

const START_OPTIONS = [
  {
    icon: ClipboardList,
    title: 'Record my rack and plan an upgrade',
    description: 'Enter what you have built today, then plan what to add and get a shopping list.',
  },
  {
    icon: PlusSquare,
    title: 'Plan a new rack',
    description: 'Pick a frame, choose a height and fit your equipment.',
  },
  {
    icon: Sparkles,
    title: 'Open the sample',
    description: 'A KWS Rack v2 going from 9U to 12U.',
  },
] as const

export function PlansPage() {
  return (
    <div className="mx-auto flex w-full max-w-screen-lg flex-col gap-6 p-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Your racks</h1>
        <p className="text-sm text-muted-foreground">
          Plans are saved in this browser. Nothing is uploaded.
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        {START_OPTIONS.map(({ icon: Icon, title, description }) => (
          <Card key={title}>
            <CardHeader>
              <Icon className="size-5 text-muted-foreground" aria-hidden />
              <CardTitle>{title}</CardTitle>
              <CardDescription>{description}</CardDescription>
            </CardHeader>
          </Card>
        ))}
      </div>
    </div>
  )
}
