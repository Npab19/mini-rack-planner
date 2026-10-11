/// <reference types="vitest/config" />
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { securityHeaders } from './scripts/headers.ts'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string
}

function gitSha(): string {
  if (process.env.GIT_SHA) return process.env.GIT_SHA.slice(0, 12)
  try {
    return execSync('git rev-parse --short=12 HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim()
  } catch {
    return 'dev'
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __GIT_SHA__: JSON.stringify(gitSha()),
  },
  // Module workers: needed for top-level await, import.meta.url and lazy chunks inside workers.
  worker: { format: 'es' },
  // Dev server only: also scan the workers, so their lazily imported dependencies (hash-wasm,
  // meshoptimizer) are pre-bundled up front. Otherwise the first lazy import inside a worker
  // fails while Vite re-optimizes (spike S4, finding 3).
  optimizeDeps: { entries: ['index.html', 'src/workers/**/*.worker.ts'] },
  build: {
    target: 'es2023',
    manifest: true,
    sourcemap: true,
  },
  // Preview runs under the production security headers so E2E catches CSP violations.
  // (Not applied to the dev server: React refresh injects an inline preamble.)
  preview: { headers: securityHeaders(), port: 4173, strictPort: true },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        extends: true,
        test: {
          name: 'dom',
          include: ['src/**/*.test.tsx'],
          environment: 'jsdom',
          setupFiles: ['src/test/setup.ts'],
        },
      },
    ],
  },
})
