/**
 * Where the E2E suite finds the production build. Shared by playwright.config.ts and the specs.
 *
 *   docker run -d --rm --read-only --tmpfs /tmp -p 8080:8080 mini-rack-planner:dev   (default)
 *   npm run build && npm run preview  ->  BASE_URL=http://localhost:4173
 */
export const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080'

/**
 * A non-localhost name for the same server. Chromium maps it to 127.0.0.1 (--host-resolver-rules),
 * so the page is not a secure context, like plain-HTTP Docker opened from another machine on a LAN.
 */
export const LAN_HOST = 'lan.test'

export function lanBaseUrl(baseUrl: string): string {
  const url = new URL(baseUrl)
  url.hostname = LAN_HOST
  return url.origin
}

/**
 * `vite preview` (port 4173) answers every unknown path with index.html, /assets/* included, and
 * sends no cache headers. Checks of the nginx/SWA-only contract are skipped there.
 */
export const SERVED_BY_VITE_PREVIEW =
  process.env.E2E_SERVER === 'vite-preview' || new URL(BASE_URL).port === '4173'

/** Browsers treat https, localhost and loopback addresses as secure contexts. */
export function isSecureOrigin(baseUrl: string): boolean {
  const { protocol, hostname } = new URL(baseUrl)
  return (
    protocol === 'https:' ||
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname === '127.0.0.1' ||
    hostname === '[::1]'
  )
}
