import { Laptop, Moon, Sun } from 'lucide-react'
import { NavLink, Outlet } from 'react-router'
import { Button } from '@/components/ui/button'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
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

export function AppLayout() {
  return (
    <TooltipProvider>
      <div className="flex min-h-dvh flex-col bg-background text-foreground">
        <header className="sticky top-0 z-40 border-b bg-background/90 backdrop-blur">
          <div className="mx-auto flex h-12 max-w-screen-2xl items-center gap-4 px-4">
            <NavLink to="/" className="flex items-center gap-2 font-semibold tracking-tight">
              <img src="/favicon.svg" alt="" className="size-6" />
              <span>Mini Rack Planner</span>
            </NavLink>
            <nav aria-label="Main" className="flex items-center gap-1 text-sm">
              {NAV.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={'end' in item ? item.end : false}
                  className={({ isActive }) =>
                    cn(
                      'rounded-md px-2 py-1 text-muted-foreground transition-colors hover:text-foreground',
                      isActive && 'bg-muted text-foreground',
                    )
                  }
                >
                  {item.label}
                </NavLink>
              ))}
            </nav>
            <div className="ml-auto">
              <ThemeToggle />
            </div>
          </div>
        </header>
        <main className="flex flex-1 flex-col">
          <Outlet />
        </main>
        <Toaster position="bottom-right" />
      </div>
    </TooltipProvider>
  )
}
