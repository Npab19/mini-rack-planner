import { describe, expect, it } from 'vitest'
import {
  budgetStatus,
  checkBudgets,
  heavyPackagesInCode,
  heavyPackagesInSources,
  initialChunkKeys,
  lazyFeatureKeys,
  packageName,
  staticImportSpecifiers,
  workerClosure,
  workerEntryFiles,
  type Budgets,
  type ChunkInfo,
  type ChunkReader,
  type Manifest,
} from './check-budgets.ts'

/** Shaped like a Vite 8 build manifest: one entry, a shared vendor chunk, lazy routes, a worker. */
const manifest: Manifest = {
  'index.html': {
    file: 'assets/index-a.js',
    src: 'index.html',
    isEntry: true,
    imports: ['_vendor-b.js'],
    dynamicImports: ['src/features/plans/PlansPage.tsx', 'src/features/viewer3d/Viewer3D.tsx'],
    css: ['assets/index-c.css'],
    assets: ['assets/ingest.worker-d.js', 'assets/geist-e.woff2'],
  },
  '_vendor-b.js': { file: 'assets/vendor-b.js', name: 'vendor' },
  '_three-f.js': { file: 'assets/three-f.js', name: 'three.module' },
  'src/features/plans/PlansPage.tsx': {
    file: 'assets/PlansPage-g.js',
    src: 'src/features/plans/PlansPage.tsx',
    isDynamicEntry: true,
    imports: ['index.html', '_vendor-b.js'],
  },
  'src/features/viewer3d/Viewer3D.tsx': {
    file: 'assets/Viewer3D-h.js',
    src: 'src/features/viewer3d/Viewer3D.tsx',
    isDynamicEntry: true,
    imports: ['index.html', '_three-f.js'],
  },
}

const jsFiles = [
  'assets/index-a.js',
  'assets/vendor-b.js',
  'assets/three-f.js',
  'assets/PlansPage-g.js',
  'assets/Viewer3D-h.js',
  'assets/ingest.worker-d.js',
  'assets/worker-shared-i.js',
  'assets/worker-lazy-j.js',
]

const budgets: Budgets = {
  initialJsGzipKb: 300,
  lazyChunkGzipKb: { viewer3d: 350 },
  workerGzipKb: 150,
  tolerancePct: 5,
}

function chunk(gzipKb: number, extra: Partial<ChunkInfo> = {}): ChunkInfo {
  return {
    rawBytes: gzipKb * 3000,
    gzipBytes: gzipKb * 1000,
    heavyPackages: [],
    detection: 'sourcemap',
    staticImports: [],
    ...extra,
  }
}

function readerFrom(chunks: Record<string, ChunkInfo>): ChunkReader {
  return (file) => chunks[file] ?? chunk(1)
}

describe('chunk graph', () => {
  it('follows static imports from the entry and ignores dynamic imports', () => {
    expect(initialChunkKeys(manifest).toSorted()).toEqual(['_vendor-b.js', 'index.html'])
  })

  it('counts a lazy feature without the chunks the initial load already has', () => {
    const initial = new Set(initialChunkKeys(manifest))
    expect(lazyFeatureKeys(manifest, 'viewer3d', initial).toSorted()).toEqual([
      '_three-f.js',
      'src/features/viewer3d/Viewer3D.tsx',
    ])
    expect(lazyFeatureKeys(manifest, 'missing', initial)).toEqual([])
  })

  it('finds workers from manifest assets and from worker file names', () => {
    expect(workerEntryFiles(manifest, [...jsFiles, 'assets/nested.worker-k.js'])).toEqual([
      'assets/ingest.worker-d.js',
      'assets/nested.worker-k.js',
    ])
  })

  it('follows the static imports of a worker but not its dynamic ones', () => {
    const read = readerFrom({
      'assets/ingest.worker-d.js': chunk(10, { staticImports: ['./worker-shared-i.js'] }),
      'assets/worker-shared-i.js': chunk(5),
    })
    expect(workerClosure('assets/ingest.worker-d.js', read, new Set(jsFiles))).toEqual([
      'assets/ingest.worker-d.js',
      'assets/worker-shared-i.js',
    ])
  })
})

describe('module detection', () => {
  it('reads package names from source map paths', () => {
    expect(packageName('../../node_modules/three/build/three.core.js')).toBe('three')
    expect(packageName('../../node_modules/@react-three/fiber/dist/index.js')).toBe(
      '@react-three/fiber',
    )
    expect(packageName('../../node_modules/a/node_modules/fflate/esm/browser.js')).toBe('fflate')
    expect(packageName('../../src/domain/bom.ts')).toBeUndefined()
  })

  it('flags heavy packages from source map sources', () => {
    expect(
      heavyPackagesInSources([
        '../../node_modules/react/index.js',
        '../../node_modules/three-stdlib/index.js',
        '../../node_modules/meshoptimizer/meshopt_decoder.mjs',
      ]),
    ).toEqual(['three', 'meshoptimizer'])
    expect(heavyPackagesInSources(['../../node_modules/threejs-math/x.js'])).toEqual([])
  })

  it('falls back to strings that survive minification', () => {
    expect(heavyPackagesInCode('window.__THREE__=`186`;throw Error(`invalid zip data`)')).toEqual([
      'three',
      'fflate',
    ])
    expect(heavyPackagesInCode('console.log(`plain app code`)')).toEqual([])
  })

  it('extracts relative static imports from minified ES chunks', () => {
    const code =
      'import{t as e}from"./index-a.js";import"./side-effect.js";export*from"./re-export.js";' +
      'const m=await import(`./lazy.js`);import x from"react"'
    expect(staticImportSpecifiers(code)).toEqual([
      './index-a.js',
      './side-effect.js',
      './re-export.js',
    ])
  })
})

describe('budgets', () => {
  it('warns inside the tolerance and fails beyond it', () => {
    expect(budgetStatus(300, 300, 5)).toBe('ok')
    expect(budgetStatus(310, 300, 5)).toBe('warn')
    expect(budgetStatus(316, 300, 5)).toBe('fail')
  })

  it('passes a build within budget', () => {
    const report = checkBudgets(manifest, budgets, jsFiles, readerFrom({}))
    expect(report.checks.filter((check) => check.status === 'fail')).toEqual([])
    expect(report.checks.map((check) => check.status)).toEqual(['ok', 'ok', 'ok', 'ok'])
  })

  it('fails when an initial chunk bundles three', () => {
    const read = readerFrom({ 'assets/vendor-b.js': chunk(40, { heavyPackages: ['three'] }) })
    const failures = checkBudgets(manifest, budgets, jsFiles, read).checks.filter(
      (check) => check.status === 'fail',
    )
    expect(failures).toHaveLength(1)
    expect(failures[0]?.text).toContain('assets/vendor-b.js has three')
  })

  it('fails when the initial JS is over budget beyond the tolerance', () => {
    const read = readerFrom({ 'assets/index-a.js': chunk(320) })
    const initial = checkBudgets(manifest, budgets, jsFiles, read).checks[0]
    expect(initial).toEqual({ status: 'fail', text: 'initial JS: 321.0 kB of 300 kB' })
  })

  it('sums a lazy feature and checks every worker', () => {
    const read = readerFrom({
      'assets/Viewer3D-h.js': chunk(100),
      'assets/three-f.js': chunk(300),
      'assets/ingest.worker-d.js': chunk(120, { staticImports: ['./worker-shared-i.js'] }),
      'assets/worker-shared-i.js': chunk(40),
    })
    const texts = checkBudgets(manifest, budgets, jsFiles, read).checks.map(
      (check) => `${check.status} ${check.text}`,
    )
    expect(texts).toContain('fail lazy:viewer3d: 400.0 kB of 350 kB')
    expect(texts).toContain('fail worker assets/ingest.worker-d.js: 160.0 kB of 150 kB')
  })
})
