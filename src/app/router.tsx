import { LoaderCircle } from 'lucide-react'
import { createBrowserRouter } from 'react-router'
import { AppLayout } from './AppLayout'
import { RouteError } from './RouteError'

/**
 * Shown while the first route's lazy code loads (React Router warns without one). The spinner
 * fades in after 300 ms, so fast loads never flash it.
 */
function AppLoading() {
  return (
    <div role="status" className="flex min-h-dvh items-center justify-center">
      <div className="animate-in duration-300 fade-in fill-mode-both delay-300">
        <LoaderCircle
          aria-hidden="true"
          className="size-6 animate-spin text-muted-foreground motion-reduce:animate-none"
        />
      </div>
      <span className="sr-only">Loading Mini Rack Planner…</span>
    </div>
  )
}

/** Spike/dev pages: present in dev, or in builds made with VITE_SPIKES=1 (used by the CSP spike). */
const devRoutes =
  import.meta.env.DEV || import.meta.env.VITE_SPIKES === '1'
    ? [
        {
          path: 'dev/spike-dnd',
          lazy: async () => ({
            Component: (await import('@/features/dev/SpikeDndPage')).SpikeDndPage,
          }),
        },
        {
          path: 'dev/spike-worker',
          lazy: async () => ({
            Component: (await import('@/features/dev/SpikeWorkerPage')).SpikeWorkerPage,
          }),
        },
      ]
    : []

/**
 * Routes are code-split with `lazy` so the initial bundle stays small
 * (the 3D viewer and model workers live behind the editor route and load on demand).
 */
export const router = createBrowserRouter([
  {
    path: '/',
    Component: AppLayout,
    ErrorBoundary: RouteError,
    HydrateFallback: AppLoading,
    children: [
      {
        index: true,
        lazy: async () => ({ Component: (await import('@/features/plans/PlansPage')).PlansPage }),
      },
      {
        path: 'plan/:planId',
        lazy: async () => ({
          Component: (await import('@/features/editor/EditorPage')).EditorPage,
        }),
      },
      {
        path: 'compare',
        lazy: async () => ({
          Component: (await import('@/features/compare/ComparePage')).ComparePage,
        }),
      },
      {
        path: 'view',
        lazy: async () => ({ Component: (await import('@/features/share/ViewerPage')).ViewerPage }),
      },
      {
        path: 'import',
        lazy: async () => ({ Component: (await import('@/features/share/ImportPage')).ImportPage }),
      },
      {
        path: 'library',
        lazy: async () => ({
          Component: (await import('@/features/library/LibraryPage')).LibraryPage,
        }),
      },
      {
        path: 'settings',
        lazy: async () => ({
          Component: (await import('@/features/settings/SettingsPage')).SettingsPage,
        }),
      },
      {
        path: 'about',
        lazy: async () => ({ Component: (await import('@/features/about/AboutPage')).AboutPage }),
      },
      ...devRoutes,
      {
        path: '*',
        lazy: async () => ({ Component: (await import('./NotFoundPage')).NotFoundPage }),
      },
    ],
  },
])
