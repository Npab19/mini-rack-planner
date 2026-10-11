/**
 * Facts-only structure dump for 3MF / STL / ZIP model files (spike S1, see
 * docs/spikes/s1-3mf-structure.md).
 *
 *   npx tsx scripts/model-structure.ts <file-or-dir> [--json] [--no-geometry] [--metadata-keys-only]
 *   npx tsx scripts/model-structure.ts            # uses the MRP_LOCAL_MODELS directory
 *
 * Prints ZIP entries and sizes, metadata (description text omitted), objects with names, types,
 * triangle counts and bounds, components, build items, plates with print tags, units, slice info,
 * and per-object islands, a geometry signature and the g1 key. Never vertices, never descriptions.
 * Directories are walked recursively for *.3mf, *.stl and *.zip. Nothing is written or uploaded.
 */

import { open, readdir, stat } from 'node:fs/promises'
import { basename, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describeModel, isModelFileName, type ModelReport } from '../src/lib/shared/model/report'
import { formatModelReport } from '../src/lib/shared/model/reportText'
import type { RandomAccessSource } from '../src/lib/shared/model/types'

interface CliOptions {
  target: string | undefined
  json: boolean
  geometry: boolean
  metadataValues: boolean
  help: boolean
}

const USAGE = `Usage: npx tsx scripts/model-structure.ts <file-or-dir> [options]
  <file-or-dir>         a .3mf, .stl or .zip file, or a folder searched recursively
                        (default: the MRP_LOCAL_MODELS environment variable)
  --json                print machine-readable JSON instead of text
  --no-geometry         skip mesh analysis (bounds, islands, signature, g1)
  --metadata-keys-only  print metadata keys without their values`

const SKIPPED_DIRECTORIES = new Set(['node_modules', '.git'])

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    target: undefined,
    json: false,
    geometry: true,
    metadataValues: true,
    help: false,
  }
  for (const arg of argv) {
    if (arg === '--json') options.json = true
    else if (arg === '--no-geometry') options.geometry = false
    else if (arg === '--metadata-keys-only') options.metadataValues = false
    else if (arg === '--help' || arg === '-h') options.help = true
    else if (arg.startsWith('--')) throw new Error(`Unknown option ${arg}`)
    else options.target = arg
  }
  options.target ??= process.env.MRP_LOCAL_MODELS
  return options
}

/** Random-access reads through a file handle, so large files are never loaded whole. */
async function openFileSource(
  path: string,
): Promise<{ source: RandomAccessSource; close: () => Promise<void> }> {
  const handle = await open(path, 'r')
  const { size } = await handle.stat()
  const source: RandomAccessSource = {
    size,
    async read(offset, length) {
      const buffer = new Uint8Array(length)
      let filled = 0
      while (filled < length) {
        const { bytesRead } = await handle.read(buffer, filled, length - filled, offset + filled)
        if (bytesRead === 0) throw new Error(`Unexpected end of ${path} at ${offset + filled}`)
        filled += bytesRead
      }
      return buffer
    },
  }
  return { source, close: () => handle.close() }
}

async function collectModelFiles(target: string): Promise<string[]> {
  const info = await stat(target)
  if (info.isFile()) return [target]
  const found: string[] = []
  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) await walk(path)
      } else if (entry.isFile() && isModelFileName(entry.name)) {
        found.push(path)
      }
    }
  }
  await walk(target)
  return found
}

function insideRepository(path: string): boolean {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const fromRoot = relative(root, resolve(path))
  return (
    fromRoot === '' ||
    (!fromRoot.startsWith('..') && !fromRoot.startsWith(sep) && !/^[a-z]:/i.test(fromRoot))
  )
}

async function describeFile(path: string, base: string, options: CliOptions): Promise<ModelReport> {
  const { source, close } = await openFileSource(path)
  try {
    const name = base === path ? basename(path) : relative(base, path)
    return await describeModel(name, source, {
      fileHash: true,
      geometry: options.geometry,
      metadataValues: options.metadataValues,
    })
  } finally {
    await close()
  }
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2))
  if (options.help || !options.target) {
    console.error(USAGE)
    return options.help ? 0 : 2
  }
  if (insideRepository(options.target)) {
    console.error(
      'Note: model files belong outside the repository (MRP_LOCAL_MODELS). Never commit them.',
    )
  }
  const files = await collectModelFiles(options.target)
  if (files.length === 0) {
    console.error(`No .3mf, .stl or .zip files under ${options.target}`)
    return 1
  }
  const reports: ModelReport[] = []
  for (const file of files) {
    const report = await describeFile(file, options.target, options)
    reports.push(report)
    if (!options.json) console.log(`${formatModelReport(report)}\n`)
  }
  if (options.json) console.log(JSON.stringify(reports, null, 2))
  return reports.some((report) => report.kind === 'error') ? 1 : 0
}

main().then(
  (code) => {
    process.exitCode = code
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 2
  },
)
