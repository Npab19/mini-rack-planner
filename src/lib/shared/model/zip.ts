/**
 * Random-access ZIP reader. It reads the central directory from the end of the source and then
 * inflates only the entries asked for, so a dropped File is never loaded whole into memory.
 *
 * Supports stored and deflate entries, ZIP64, UTF-8 / Info-ZIP Unicode Path names and archives with
 * bytes prepended. Caps from ModelLimits are checked against declared sizes before inflating and
 * against actual output while inflating, so zip bombs end in a LimitExceededError.
 */

import { Inflate } from 'fflate'
import { crc32 } from './crc32'
import {
  LimitExceededError,
  ModelError,
  type ModelLimits,
  type RandomAccessSource,
  resolveLimits,
} from './types'

export const METHOD_STORED = 0
export const METHOD_DEFLATE = 8

const SIG_LOCAL_HEADER = 0x04034b50
const SIG_CENTRAL_HEADER = 0x02014b50
const SIG_END = 0x06054b50
const SIG_ZIP64_END = 0x06064b50
const SIG_ZIP64_LOCATOR = 0x07064b50
const END_SIZE = 22
const ZIP64_END_SIZE = 56
const ZIP64_LOCATOR_SIZE = 20
const CENTRAL_HEADER_SIZE = 46
const LOCAL_HEADER_SIZE = 30
const MAX_COMMENT_LENGTH = 0xffff
const U16_MAX = 0xffff
const U32_MAX = 0xffffffff
const FLAG_ENCRYPTED = 0x0001
const FLAG_UTF8 = 0x0800
const EXTRA_ZIP64 = 0x0001
const EXTRA_UNICODE_PATH = 0x7075
/** Compressed bytes per source read. */
const READ_CHUNK_BYTES = 1 << 20
/** Compressed bytes per inflate step. Deflate expands at most ~1032x, so one step yields <= ~66 MiB. */
const INFLATE_STEP_BYTES = 1 << 16

const UTF8 = new TextDecoder()
const UTF8_STRICT = new TextDecoder('utf-8', { fatal: true })
/** CP437 for bytes 0x80-0xFF: the legacy ZIP name encoding when neither UTF-8 flag nor field is set. */
const CP437_HIGH =
  'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐' +
  '└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ '

export interface ZipEntry {
  readonly index: number
  /** Decoded name: Info-ZIP Unicode Path field when valid, else UTF-8, else CP437. */
  readonly name: string
  readonly method: number
  readonly flags: number
  readonly crc32: number
  readonly compressedSize: number
  /** Declared uncompressed size. */
  readonly size: number
  /** Absolute offset of the local header (already corrected for prepended bytes). */
  readonly localHeaderOffset: number
  readonly isDirectory: boolean
  readonly encrypted: boolean
}

export interface ZipArchive {
  readonly source: RandomAccessSource
  readonly entries: readonly ZipEntry[]
  readonly zip64: boolean
  /** Bytes before the archive proper (self-extractor stubs). */
  readonly prefixBytes: number
  readonly limits: ModelLimits
  /** Bytes inflated so far by this archive, checked against maxTotalInflatedBytes. */
  readonly inflatedBytes: number
  /** First entry with exactly this name. */
  get(name: string): ZipEntry | undefined
  read(entry: ZipEntry): Promise<Uint8Array>
  /** UTF-8 text; a byte-order mark is dropped. */
  readText(entry: ZipEntry): Promise<string>
  /** Delivers the inflated bytes in order. `onChunk` may throw to abort. */
  stream(entry: ZipEntry, onChunk: (chunk: Uint8Array) => void): Promise<void>
}

function corrupt(message: string): ModelError {
  return new ModelError('zip-corrupt', message)
}

function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

function readUint64(view: DataView, at: number): number {
  const low = view.getUint32(at, true)
  const high = view.getUint32(at + 4, true)
  if (high > 0x1fffff) throw new ModelError('zip-unsupported', 'ZIP64 value larger than 2^53')
  return high * 0x1_0000_0000 + low
}

function checkRange(offset: number, length: number, size: number): void {
  const valid =
    Number.isSafeInteger(offset) &&
    Number.isSafeInteger(length) &&
    offset >= 0 &&
    length >= 0 &&
    offset + length <= size
  if (!valid)
    throw new RangeError(`Read of ${length} bytes at ${offset} outside a ${size}-byte source`)
}

/** Source over bytes already in memory (tests, archives nested in archives). No copies. */
export function bytesSource(bytes: Uint8Array): RandomAccessSource {
  return {
    size: bytes.length,
    read(offset, length) {
      checkRange(offset, length, bytes.length)
      return Promise.resolve(bytes.subarray(offset, offset + length))
    },
  }
}

/** Source over a Blob or File: each read is a `slice()`, so the file is never read whole. */
export function blobSource(blob: Blob): RandomAccessSource {
  return {
    size: blob.size,
    async read(offset, length) {
      checkRange(offset, length, blob.size)
      return new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer())
    },
  }
}

/** True for a local-header or empty-archive signature at the start ("PK\3\4" / "PK\5\6"). */
export function looksLikeZip(head: Uint8Array): boolean {
  if (head.length < 4 || head[0] !== 0x50 || head[1] !== 0x4b) return false
  return (head[2] === 3 && head[3] === 4) || (head[2] === 5 && head[3] === 6)
}

interface EndRecord {
  /** Absolute offset of the record pointing at the central directory (EOCD or ZIP64 EOCD). */
  recordOffset: number
  entryCount: number
  directoryOffset: number
  directorySize: number
  zip64: boolean
}

/** Scans backwards for the EOCD signature, preferring a record whose comment ends the file exactly. */
function findEndRecord(view: DataView): number {
  let fallback = -1
  for (let at = view.byteLength - END_SIZE; at >= 0; at--) {
    if (view.getUint32(at, true) !== SIG_END) continue
    const recordEnd = at + END_SIZE + view.getUint16(at + 20, true)
    if (recordEnd === view.byteLength) return at
    if (recordEnd < view.byteLength && fallback < 0) fallback = at
  }
  return fallback
}

function unsupportedMultiDisk(): ModelError {
  return new ModelError('zip-unsupported', 'Multi-disk (spanned) ZIP archives are not supported')
}

async function readZip64End(
  source: RandomAccessSource,
  tail: DataView,
  locatorAt: number,
  tailStart: number,
): Promise<EndRecord> {
  const declaredOffset = readUint64(tail, locatorAt + 8)
  if (tail.getUint32(locatorAt + 16, true) > 1) throw unsupportedMultiDisk()
  const locatorOffset = tailStart + locatorAt
  // Bytes prepended to the archive shift every offset; the record normally sits right before the
  // locator, so look there as well.
  for (const offset of [declaredOffset, locatorOffset - ZIP64_END_SIZE]) {
    if (offset < 0 || offset + ZIP64_END_SIZE > locatorOffset) continue
    const view = viewOf(await source.read(offset, ZIP64_END_SIZE))
    if (view.getUint32(0, true) !== SIG_ZIP64_END) continue
    if (view.getUint32(16, true) !== 0 || view.getUint32(20, true) !== 0)
      throw unsupportedMultiDisk()
    return {
      recordOffset: offset,
      entryCount: readUint64(view, 32),
      directorySize: readUint64(view, 40),
      directoryOffset: readUint64(view, 48),
      zip64: true,
    }
  }
  throw corrupt('ZIP64 end-of-central-directory record not found')
}

async function readEndRecord(source: RandomAccessSource): Promise<EndRecord> {
  if (source.size < END_SIZE) throw new ModelError('not-a-zip', 'Too small to be a ZIP archive')
  const tailLength = Math.min(source.size, END_SIZE + MAX_COMMENT_LENGTH + ZIP64_LOCATOR_SIZE)
  const tailStart = source.size - tailLength
  const tail = viewOf(await source.read(tailStart, tailLength))
  const at = findEndRecord(tail)
  if (at < 0) throw new ModelError('not-a-zip', 'No ZIP end-of-central-directory record found')

  const locatorAt = at - ZIP64_LOCATOR_SIZE
  if (locatorAt >= 0 && tail.getUint32(locatorAt, true) === SIG_ZIP64_LOCATOR) {
    return readZip64End(source, tail, locatorAt, tailStart)
  }
  if (tail.getUint16(at + 4, true) !== 0 || tail.getUint16(at + 6, true) !== 0) {
    throw unsupportedMultiDisk()
  }
  return {
    recordOffset: tailStart + at,
    entryCount: tail.getUint16(at + 10, true),
    directorySize: tail.getUint32(at + 12, true),
    directoryOffset: tail.getUint32(at + 16, true),
    zip64: false,
  }
}

interface CentralDirectory {
  bytes: Uint8Array
  /** Bytes prepended to the archive; add to every stored offset. */
  prefix: number
}

async function readCentralDirectory(
  source: RandomAccessSource,
  end: EndRecord,
): Promise<CentralDirectory> {
  const { directoryOffset, directorySize, recordOffset, entryCount } = end
  if (entryCount === 0) return { bytes: new Uint8Array(0), prefix: 0 }
  // Where the directory should be, and where it is if bytes were prepended to the archive.
  const candidates = [directoryOffset, recordOffset - directorySize]
  for (const offset of candidates) {
    if (offset < 0 || offset + directorySize > recordOffset || directorySize < 4) continue
    const head = viewOf(await source.read(offset, 4))
    if (head.getUint32(0, true) !== SIG_CENTRAL_HEADER) continue
    return { bytes: await source.read(offset, directorySize), prefix: offset - directoryOffset }
  }
  throw corrupt('Central directory not found where the end record points')
}

function findExtraField(extra: Uint8Array, id: number): Uint8Array | undefined {
  const view = viewOf(extra)
  let at = 0
  while (at + 4 <= extra.length) {
    const fieldId = view.getUint16(at, true)
    const start = at + 4
    const end = start + view.getUint16(at + 2, true)
    if (end > extra.length) return undefined
    if (fieldId === id) return extra.subarray(start, end)
    at = end
  }
  return undefined
}

function decodeCp437(raw: Uint8Array): string {
  let out = ''
  for (const byte of raw) out += byte < 0x80 ? String.fromCharCode(byte) : CP437_HIGH[byte - 0x80]
  return out
}

/** Info-ZIP Unicode Path (0x7075): version 1, CRC-32 of the stored name, then the UTF-8 name. */
function readUnicodePathField(extra: Uint8Array, rawName: Uint8Array): string | undefined {
  const field = findExtraField(extra, EXTRA_UNICODE_PATH)
  if (!field || field.length < 5 || field[0] !== 1) return undefined
  // A field whose CRC no longer matches was left behind by a tool that renamed the entry: ignore it.
  if (viewOf(field).getUint32(1, true) !== crc32(rawName)) return undefined
  try {
    return UTF8_STRICT.decode(field.subarray(5))
  } catch {
    return undefined
  }
}

function decodeEntryName(rawName: Uint8Array, extra: Uint8Array, flags: number): string {
  const unicode = readUnicodePathField(extra, rawName)
  if (unicode !== undefined) return unicode
  if ((flags & FLAG_UTF8) !== 0) return UTF8.decode(rawName)
  // Many tools write UTF-8 without setting the flag; real CP437 names are rarely valid UTF-8.
  try {
    return UTF8_STRICT.decode(rawName)
  } catch {
    return decodeCp437(rawName)
  }
}

interface EntrySizes {
  compressedSize: number
  size: number
  localHeaderOffset: number
}

function readEntrySizes(view: DataView, at: number, extra: Uint8Array, name: string): EntrySizes {
  let compressedSize = view.getUint32(at + 20, true)
  let size = view.getUint32(at + 24, true)
  let localHeaderOffset = view.getUint32(at + 42, true)
  const needsZip64 =
    size === U32_MAX ||
    compressedSize === U32_MAX ||
    localHeaderOffset === U32_MAX ||
    view.getUint16(at + 34, true) === U16_MAX
  if (!needsZip64) return { compressedSize, size, localHeaderOffset }

  const field = findExtraField(extra, EXTRA_ZIP64)
  if (!field) throw corrupt(`${name}: ZIP64 sizes without a ZIP64 extra field`)
  const fieldView = viewOf(field)
  let cursor = 0
  // Only the values saturated in the header are present, in this order.
  const next = (): number => {
    if (cursor + 8 > field.length) throw corrupt(`${name}: truncated ZIP64 extra field`)
    const value = readUint64(fieldView, cursor)
    cursor += 8
    return value
  }
  if (size === U32_MAX) size = next()
  if (compressedSize === U32_MAX) compressedSize = next()
  if (localHeaderOffset === U32_MAX) localHeaderOffset = next()
  return { compressedSize, size, localHeaderOffset }
}

function parseCentralDirectory(directory: CentralDirectory, count: number): ZipEntry[] {
  const { bytes, prefix } = directory
  const view = viewOf(bytes)
  const entries: ZipEntry[] = []
  let at = 0
  for (let index = 0; index < count; index++) {
    if (
      at + CENTRAL_HEADER_SIZE > bytes.length ||
      view.getUint32(at, true) !== SIG_CENTRAL_HEADER
    ) {
      throw corrupt(`Central directory entry ${index} is damaged`)
    }
    const flags = view.getUint16(at + 8, true)
    const nameStart = at + CENTRAL_HEADER_SIZE
    const extraStart = nameStart + view.getUint16(at + 28, true)
    const extraEnd = extraStart + view.getUint16(at + 30, true)
    const next = extraEnd + view.getUint16(at + 32, true)
    if (next > bytes.length) throw corrupt(`Central directory entry ${index} is truncated`)

    const extra = bytes.subarray(extraStart, extraEnd)
    const name = decodeEntryName(bytes.subarray(nameStart, extraStart), extra, flags)
    const sizes = readEntrySizes(view, at, extra, name)
    entries.push({
      index,
      name,
      method: view.getUint16(at + 10, true),
      flags,
      crc32: view.getUint32(at + 16, true),
      compressedSize: sizes.compressedSize,
      size: sizes.size,
      localHeaderOffset: sizes.localHeaderOffset + prefix,
      isDirectory: name.endsWith('/'),
      encrypted: (flags & FLAG_ENCRYPTED) !== 0,
    })
    at = next
  }
  return entries
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

class ZipReader implements ZipArchive {
  readonly source: RandomAccessSource
  readonly entries: readonly ZipEntry[]
  readonly zip64: boolean
  readonly prefixBytes: number
  readonly limits: ModelLimits
  private readonly byName = new Map<string, ZipEntry>()
  private inflated = 0

  constructor(
    source: RandomAccessSource,
    entries: readonly ZipEntry[],
    zip64: boolean,
    prefixBytes: number,
    limits: ModelLimits,
  ) {
    this.source = source
    this.entries = entries
    this.zip64 = zip64
    this.prefixBytes = prefixBytes
    this.limits = limits
    for (const entry of entries)
      if (!this.byName.has(entry.name)) this.byName.set(entry.name, entry)
  }

  get inflatedBytes(): number {
    return this.inflated
  }

  get(name: string): ZipEntry | undefined {
    return this.byName.get(name)
  }

  async read(entry: ZipEntry): Promise<Uint8Array> {
    this.assertReadable(entry)
    const out = new Uint8Array(entry.size)
    let at = 0
    // stream() never delivers more than entry.size bytes, so this cannot overflow.
    await this.stream(entry, (chunk) => {
      out.set(chunk, at)
      at += chunk.length
    })
    return out
  }

  async readText(entry: ZipEntry): Promise<string> {
    return UTF8.decode(await this.read(entry))
  }

  async stream(entry: ZipEntry, onChunk: (chunk: Uint8Array) => void): Promise<void> {
    this.assertReadable(entry)
    const start = await this.dataStart(entry)
    let produced = 0
    let crc = 0
    const emit = (chunk: Uint8Array): void => {
      if (chunk.length === 0) return
      produced += chunk.length
      if (produced > entry.size) {
        const message = `${entry.name} inflates past its declared ${entry.size} bytes`
        throw new LimitExceededError('declared-size', produced, entry.size, message)
      }
      this.inflated += chunk.length
      if (this.inflated > this.limits.maxTotalInflatedBytes) {
        throw new LimitExceededError(
          'total-bytes',
          this.inflated,
          this.limits.maxTotalInflatedBytes,
        )
      }
      crc = crc32(chunk, crc)
      onChunk(chunk)
    }
    if (entry.method === METHOD_STORED) await this.copyStored(entry, start, emit)
    else await this.inflate(entry, start, emit)
    if (produced !== entry.size)
      throw corrupt(`${entry.name}: got ${produced} bytes, expected ${entry.size}`)
    if (crc !== entry.crc32) throw corrupt(`${entry.name}: CRC-32 mismatch`)
  }

  private assertReadable(entry: ZipEntry): void {
    if (this.entries[entry.index] !== entry) {
      throw new ModelError('entry-not-found', `${entry.name} is not in this archive`)
    }
    if (entry.encrypted) throw new ModelError('zip-encrypted', `${entry.name} is encrypted`)
    if (entry.method !== METHOD_STORED && entry.method !== METHOD_DEFLATE) {
      throw new ModelError(
        'zip-unsupported',
        `${entry.name} uses compression method ${entry.method}`,
      )
    }
    const { maxEntryInflatedBytes, maxTotalInflatedBytes } = this.limits
    if (entry.size > maxEntryInflatedBytes) {
      const message = `${entry.name} declares ${entry.size} bytes (cap ${maxEntryInflatedBytes})`
      throw new LimitExceededError('entry-bytes', entry.size, maxEntryInflatedBytes, message)
    }
    const total = this.inflated + entry.size
    if (total > maxTotalInflatedBytes) {
      const message = `Reading ${entry.name} would inflate ${total} bytes in total`
      throw new LimitExceededError('total-bytes', total, maxTotalInflatedBytes, message)
    }
    if (entry.method === METHOD_STORED && entry.compressedSize !== entry.size) {
      throw corrupt(`${entry.name}: stored entry with different compressed and declared sizes`)
    }
  }

  private async dataStart(entry: ZipEntry): Promise<number> {
    const offset = entry.localHeaderOffset
    if (offset + LOCAL_HEADER_SIZE > this.source.size) {
      throw corrupt(`${entry.name}: local header past the end of the file`)
    }
    const header = viewOf(await this.source.read(offset, LOCAL_HEADER_SIZE))
    if (header.getUint32(0, true) !== SIG_LOCAL_HEADER)
      throw corrupt(`${entry.name}: bad local header`)
    // Sizes come from the central directory; only the local name/extra lengths are needed here.
    const start =
      offset + LOCAL_HEADER_SIZE + header.getUint16(26, true) + header.getUint16(28, true)
    if (start + entry.compressedSize > this.source.size) {
      throw corrupt(`${entry.name}: data runs past the end of the file`)
    }
    return start
  }

  private async copyStored(
    entry: ZipEntry,
    start: number,
    emit: (chunk: Uint8Array) => void,
  ): Promise<void> {
    for (let offset = 0; offset < entry.compressedSize; offset += READ_CHUNK_BYTES) {
      const length = Math.min(READ_CHUNK_BYTES, entry.compressedSize - offset)
      emit(await this.source.read(start + offset, length))
    }
  }

  private async inflate(
    entry: ZipEntry,
    start: number,
    emit: (chunk: Uint8Array) => void,
  ): Promise<void> {
    // Output is queued and emitted after each push, so a consumer error is never mistaken for
    // corrupt deflate data, and the size checks in emit() run after every bounded step.
    const pending: Uint8Array[] = []
    const inflater = new Inflate((chunk) => {
      pending.push(chunk)
    })
    const total = entry.compressedSize
    for (let offset = 0; offset < total; offset += READ_CHUNK_BYTES) {
      const input = await this.source.read(
        start + offset,
        Math.min(READ_CHUNK_BYTES, total - offset),
      )
      for (let step = 0; step < input.length; step += INFLATE_STEP_BYTES) {
        const final = offset + step + INFLATE_STEP_BYTES >= total
        try {
          inflater.push(input.subarray(step, step + INFLATE_STEP_BYTES), final)
        } catch (error) {
          const message = `${entry.name}: invalid deflate data (${describeError(error)})`
          throw new ModelError('zip-corrupt', message, { cause: error })
        }
        for (const chunk of pending) emit(chunk)
        pending.length = 0
      }
    }
  }
}

/** Opens an archive: reads the end records and the central directory, inflates nothing yet. */
export async function openZip(
  source: RandomAccessSource,
  limits: Partial<ModelLimits> = {},
): Promise<ZipArchive> {
  const resolved = resolveLimits(limits)
  const end = await readEndRecord(source)
  if (end.entryCount > resolved.maxEntries) {
    const message = `ZIP declares ${end.entryCount} entries (cap ${resolved.maxEntries})`
    throw new LimitExceededError('entries', end.entryCount, resolved.maxEntries, message)
  }
  const directory = await readCentralDirectory(source, end)
  const entries = parseCentralDirectory(directory, end.entryCount)
  return new ZipReader(source, entries, end.zip64, directory.prefix, resolved)
}
