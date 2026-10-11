/**
 * A deliberately low-level ZIP writer for tests: it can write what fflate's zipSync will not
 * (ZIP64 records, names without the UTF-8 flag, Info-ZIP Unicode Path fields, lying sizes and CRCs,
 * central records that share one local entry). Production-like packages use zipSync instead.
 */

import { deflateSync } from 'fflate'
import { crc32 } from '../crc32'

export interface RawZipEntry {
  /** A string is written as UTF-8 bytes; pass bytes for other encodings. */
  name: string | Uint8Array
  /** Uncompressed content. */
  data: Uint8Array
  /** 0 = stored, 8 = deflate (default), anything else is written as stored bytes with that method id. */
  method?: number
  flags?: number
  /** Extra field bytes written to both the local and the central header. */
  extra?: Uint8Array
  /** Uncompressed size to declare instead of the real one. */
  declaredSize?: number
  /** CRC-32 to declare instead of the real one. */
  crc?: number
  /** Write sizes and offset through a ZIP64 extra field (0xFFFFFFFF in the headers). */
  zip64?: boolean
}

export interface RawZipOptions {
  /** Write the ZIP64 end record and locator before the classic end record. */
  zip64End?: boolean
  comment?: string
  /** Write every central record this many times, all pointing at the same local entry. */
  centralCopies?: number
}

const U32_MAX = 0xffffffff

class ByteWriter {
  private readonly chunks: Uint8Array[] = []
  length = 0

  bytes(data: Uint8Array): this {
    this.chunks.push(data)
    this.length += data.length
    return this
  }

  u16(value: number): this {
    const b = new Uint8Array(2)
    new DataView(b.buffer).setUint16(0, value, true)
    return this.bytes(b)
  }

  u32(value: number): this {
    const b = new Uint8Array(4)
    new DataView(b.buffer).setUint32(0, value >>> 0, true)
    return this.bytes(b)
  }

  u64(value: number): this {
    return this.u32(value % 0x1_0000_0000).u32(Math.floor(value / 0x1_0000_0000))
  }

  toBytes(): Uint8Array<ArrayBuffer> {
    const out = new Uint8Array(this.length)
    let at = 0
    for (const chunk of this.chunks) {
      out.set(chunk, at)
      at += chunk.length
    }
    return out
  }
}

/** Builds one extra-field block: id, size, data. */
export function extraField(id: number, data: Uint8Array): Uint8Array {
  return new ByteWriter().u16(id).u16(data.length).bytes(data).toBytes()
}

/** Info-ZIP Unicode Path extra field (0x7075) for an entry whose stored name is `storedName`. */
export function unicodePathExtra(unicodeName: string, storedName: Uint8Array): Uint8Array {
  const data = new ByteWriter().bytes(Uint8Array.of(1)).u32(crc32(storedName))
  data.bytes(new TextEncoder().encode(unicodeName))
  return extraField(0x7075, data.toBytes())
}

function zip64Extra(size: number, compressedSize: number, offset: number): Uint8Array {
  return extraField(0x0001, new ByteWriter().u64(size).u64(compressedSize).u64(offset).toBytes())
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length)
  out.set(a)
  out.set(b, a.length)
  return out
}

export function writeZip(
  entries: RawZipEntry[],
  options: RawZipOptions = {},
): Uint8Array<ArrayBuffer> {
  const out = new ByteWriter()
  const central: Uint8Array[] = []
  for (const entry of entries) {
    const name = typeof entry.name === 'string' ? new TextEncoder().encode(entry.name) : entry.name
    const method = entry.method ?? 8
    const stored = method === 8 ? deflateSync(entry.data) : entry.data
    const crc = entry.crc ?? crc32(entry.data)
    const size = entry.declaredSize ?? entry.data.length
    const offset = out.length
    const zip64 = entry.zip64 ?? false
    const baseExtra = entry.extra ?? new Uint8Array(0)
    const extra = zip64 ? concat(baseExtra, zip64Extra(size, stored.length, offset)) : baseExtra
    const version = zip64 ? 45 : 20
    const flags = entry.flags ?? 0

    out.u32(0x04034b50).u16(version).u16(flags).u16(method).u16(0).u16(0x21)
    out
      .u32(crc)
      .u32(zip64 ? U32_MAX : stored.length)
      .u32(zip64 ? U32_MAX : size)
    out.u16(name.length).u16(extra.length).bytes(name).bytes(extra).bytes(stored)

    const record = new ByteWriter()
    record.u32(0x02014b50).u16(version).u16(version).u16(flags).u16(method).u16(0).u16(0x21)
    record
      .u32(crc)
      .u32(zip64 ? U32_MAX : stored.length)
      .u32(zip64 ? U32_MAX : size)
    record.u16(name.length).u16(extra.length).u16(0).u16(0).u16(0).u32(0)
    record
      .u32(zip64 ? U32_MAX : offset)
      .bytes(name)
      .bytes(extra)
    central.push(record.toBytes())
  }

  const directoryOffset = out.length
  const copies = options.centralCopies ?? 1
  for (let copy = 0; copy < copies; copy++) for (const record of central) out.bytes(record)
  const directorySize = out.length - directoryOffset
  const count = central.length * copies

  if (options.zip64End) {
    const recordOffset = out.length
    out.u32(0x06064b50).u64(44).u16(45).u16(45).u32(0).u32(0)
    out.u64(count).u64(count).u64(directorySize).u64(directoryOffset)
    out.u32(0x07064b50).u32(0).u64(recordOffset).u32(1)
  }
  const comment = new TextEncoder().encode(options.comment ?? '')
  out.u32(0x06054b50).u16(0).u16(0)
  out.u16(options.zip64End ? 0xffff : count).u16(options.zip64End ? 0xffff : count)
  out
    .u32(options.zip64End ? U32_MAX : directorySize)
    .u32(options.zip64End ? U32_MAX : directoryOffset)
  out.u16(comment.length).bytes(comment)
  return out.toBytes()
}
