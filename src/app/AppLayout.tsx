import { Laptop, Menu, Moon, Sun } from 'lucide-react'
import { lazy, Suspense, useState } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router'
import { ErrorBoundary } from '@/components/common/ErrorBoundary'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { AddPartHost } from '@/features/custom/AddPartHost'
import { useTheme, type ThemePreference } from '@/lib/theme'
import { cn } from '@/lib/utils'

const NAV = [
  { to: '/', label: 'Plans', end: true },
  { to: '/library', label: 'My parts' },
  { to: '/settings', label: 'Settings' },
  { to: '/about', label: 'About' },
] as const

const NEXT_THEME: Record<ThemePreference, ThemePreference> = {
  system: 'light',
  light: 'dark',
  dark: 'system',
}

const FOCUS_RING = 'outline-none focus-visible:ring-3 focus-visible:ring-ring/50'

/**
 * Loaded after the entry ran: the banners read the plan store, which builds zod schemas, and the
 * entry's static imports all run before main.tsx sets zod up for the CSP (see main.tsx).
 */
const StatusBanners = lazy(async () => ({
  default: (await import('@/components/status/StatusBanners')).StatusBanners,
}))

function ThemeToggle() {
  const { theme, setTheme } = useTheme()
  const Icon = theme === 'light' ? Sun : theme === 'dark' ? Moon : Laptop
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={`Theme: ${theme}. Switch to ${NEXT_THEME[theme]}`}
      onClick={() => setTheme(NEXT_THEME[theme])}
    >
      <Icon />
    </Button>
  )
}

/**
 * The current page is marked by weight and an accent-tinted background as well as colour (and
 * aria-current).
 */
function navLinkClass(base: string) {
  return ({ isActive }: { isActive: boolean }) =>
    cn(
      base,
      FOCUS_RING,
      'rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground',
      isActive &&
        'bg-accent font-semibold text-accent-foreground hover:bg-accent hover:text-accent-foreground',
    )
}

/** Below `sm` the links do not fit next to the title: they move into a sheet. */
function MobileNav() {
  const [open, setOpen] = useState(false)
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger
        render={<Button variant="ghost" size="icon" className="sm:hidden" aria-label="Menu" />}
      >
        <Menu />
      </SheetTrigger>
      <SheetContent side="right" className="w-64">
        <SheetHeader>
          <SheetTitle>Menu</SheetTitle>
        </SheetHeader>
        <nav aria-label="Main" className="flex flex-col gap-1 px-2">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={'end' in item ? item.end : false}
              className={navLinkClass('px-3 py-2.5 text-base')}
              onClick={() => setOpen(false)}
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
      </SheetContent>
    </Sheet>
  )
}

export function AppLayout() {
  const { pathname } = useLocation()
  return (
    <TooltipProvider>
      <div className="flex min-h-dvh flex-col bg-background text-foreground">
        {/* The slim accent line on top is the app's brand mark; it follows the chosen accent. */}
        <header className="sticky top-0 z-40 border-t-2 border-b border-t-primary bg-background/90 backdrop-blur">
          <div className="mx-auto flex h-12 max-w-screen-2xl items-center gap-2 px-3 sm:gap-4 sm:px-4">
            <NavLink
              to="/"
              className={cn(
                'flex min-w-0 items-center gap-2 rounded-md font-semibold tracking-tight',
                FOCUS_RING,
              )}
            >
              {/* The tile keeps the dark logo visible on the dark theme. */}
              <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-accent ring-1 ring-primary/20">
                <img src="/favicon.svg" alt="" className="size-5" />
              </span>
              <span className="truncate">Mini Rack Planner</span>
            </NavLink>
            <nav aria-label="Main" className="hidden items-center gap-1 text-sm sm:flex">
              {NAV.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={'end' in item ? item.end : false}
                  className={navLinkClass('px-2 py-1 whitespace-nowrap')}
                >
                  {item.label}
                </NavLink>
              ))}
            </nav>
            <div className="ml-auto flex shrink-0 items-center gap-1">
              <ThemeToggle />
              <MobileNav />
            </div>
          </div>
        </header>
        <main className="flex flex-1 flex-col">
          {/* App-wide banners (storage, other tabs, reload): inside <main>, above every page.
              Outside the route's error boundary, so a crashed page still shows them. */}
          <div id="app-status-slot">
            {/* A broken banner must not take the page with it (the error is still recorded). */}
            <ErrorBoundary name="status-banners" fallback={null}>
              <Suspense fallback={null}>
                <StatusBanners />
              </Suspense>
            </ErrorBoundary>
          </div>
          {/* A page that crashes keeps the header; moving to another page clears the error. */}
          <ErrorBoundary
            name="route"
            title="This page hit an error"
            resetKeys={[pathname]}
            className="m-4 sm:mx-auto sm:my-8 sm:w-full sm:max-w-lg"
          >
            <Outlet />
          </ErrorBoundary>
        </main>
        <Toaster position="bottom-right" />
        {/* "Add a part" for every page (My parts, the editor's palette, "Needs a mount?"). The host
            builds no schema at load; the dialog itself loads on the first request. */}
        <AddPartHost />
      </div>
    </TooltipProvider>
  )
}
