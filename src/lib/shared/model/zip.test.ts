import { strToU8, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { extraField, unicodePathExtra, writeZip } from './testing/zipWriter'
import { LimitExceededError, ModelError } from './types'
import { blobSource, bytesSource, looksLikeZip, openZip, type ZipArchive } from './zip'

const MiB = 1024 * 1024

function patterned(length: number, seed = 1): Uint8Array {
  const bytes = new Uint8Array(length)
  let state = seed
  for (let i = 0; i < length; i++) {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0
    // Mostly text-like so deflate has something to do, but not trivially compressible.
    bytes[i] = 32 + ((state >>> 16) % 64)
  }
  return bytes
}

async function open(bytes: Uint8Array, limits = {}): Promise<ZipArchive> {
  return openZip(bytesSource(bytes), limits)
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('expected a rejection')
}

describe('openZip: listing and reading', () => {
  it('lists entries and reads stored and deflated content', async () => {
    const text = 'hello 3MF '.repeat(1000)
    const bytes = zipSync({
      'stored.txt': [strToU8(text), { level: 0 }],
      'dir/deflated.txt': [strToU8(text), { level: 9 }],
      'dir/empty.txt': new Uint8Array(0),
    })
    const zip = await open(bytes)
    expect(zip.entries.map((entry) => entry.name)).toEqual([
      'stored.txt',
      'dir/deflated.txt',
      'dir/empty.txt',
    ])
    const [stored, deflated, empty] = zip.entries
    expect(stored?.method).toBe(0)
    expect(deflated?.method).toBe(8)
    expect(deflated?.compressedSize).toBeLessThan(deflated?.size ?? 0)
    expect(await zip.readText(stored!)).toBe(text)
    expect(await zip.readText(deflated!)).toBe(text)
    expect((await zip.read(empty!)).length).toBe(0)
    expect(zip.get('dir/deflated.txt')).toBe(deflated)
    expect(zip.inflatedBytes).toBe(text.length * 2)
  })

  it('streams large entries in order', async () => {
    const data = patterned(3 * MiB + 123)
    const zip = await open(zipSync({ 'big.bin': data }))
    const chunks: Uint8Array[] = []
    await zip.stream(zip.entries[0]!, (chunk) => chunks.push(chunk.slice()))
    expect(chunks.length).toBeGreaterThan(1)
    const joined = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0))
    let at = 0
    for (const chunk of chunks) {
      joined.set(chunk, at)
      at += chunk.length
    }
    // toEqual on multi-megabyte typed arrays takes seconds; compare by hand.
    expect(joined.length).toBe(data.length)
    expect(joined.findIndex((byte, i) => byte !== data[i])).toBe(-1)
  })

  it('reads through a Blob source', async () => {
    const bytes = zipSync({ 'a.txt': strToU8('from a blob') })
    const zip = await openZip(blobSource(new Blob([bytes])))
    expect(await zip.readText(zip.entries[0]!)).toBe('from a blob')
  })

  it('detects the ZIP signature', () => {
    expect(looksLikeZip(zipSync({ 'a.txt': strToU8('x') }))).toBe(true)
    expect(looksLikeZip(strToU8('solid cube'))).toBe(false)
  })

  it('reads ZIP64 end records and ZIP64 entry sizes', async () => {
    const data = patterned(5000)
    const bytes = writeZip(
      [
        { name: '3D/3dmodel.model', data, zip64: true },
        { name: 'stored.txt', data: strToU8('plain'), method: 0 },
      ],
      { zip64End: true },
    )
    const zip = await open(bytes)
    expect(zip.zip64).toBe(true)
    expect(zip.entries[0]?.size).toBe(5000)
    expect(await zip.read(zip.entries[0]!)).toEqual(data)
    expect(await zip.readText(zip.entries[1]!)).toBe('plain')
  })

  it('reads archives with bytes prepended (self-extractor stubs), with and without ZIP64', async () => {
    const stub = patterned(777, 9)
    for (const zip64End of [false, true]) {
      const archive = writeZip([{ name: 'part.txt', data: strToU8('after the stub') }], {
        zip64End,
      })
      const bytes = new Uint8Array(stub.length + archive.length)
      bytes.set(stub)
      bytes.set(archive, stub.length)
      const zip = await open(bytes)
      expect(zip.prefixBytes).toBe(stub.length)
      expect(await zip.readText(zip.entries[0]!)).toBe('after the stub')
    }
  })

  it('finds the end record behind a comment that contains a fake one', async () => {
    const fake = String.fromCharCode(0x50, 0x4b, 0x05, 0x06) + '\0'.repeat(18)
    const bytes = writeZip([{ name: 'a.txt', data: strToU8('ok') }], {
      comment: `note ${fake} end`,
    })
    const zip = await open(bytes)
    expect(await zip.readText(zip.entries[0]!)).toBe('ok')
  })
})

describe('openZip: entry names', () => {
  it('decodes UTF-8 names with the language-encoding flag (fflate sets it)', async () => {
    const zip = await open(zipSync({ '3D/Objects/Fuß – Halter_3.model': strToU8('x') }))
    expect(zip.entries[0]?.name).toBe('3D/Objects/Fuß – Halter_3.model')
    expect((zip.entries[0]?.flags ?? 0) & 0x800).toBe(0x800)
  })

  it('decodes UTF-8 names written without the flag', async () => {
    const zip = await open(writeZip([{ name: 'Füße.stl', data: strToU8('x'), flags: 0 }]))
    expect(zip.entries[0]?.name).toBe('Füße.stl')
  })

  it('falls back to CP437 for names that are not UTF-8', async () => {
    // "Äußere.stl" in CP437: Ä = 0x8E, ß = 0xE1.
    const name = Uint8Array.of(0x8e, 0x75, 0xe1, 0x65, 0x72, 0x65, 0x2e, 0x73, 0x74, 0x6c)
    const zip = await open(writeZip([{ name, data: strToU8('x') }]))
    expect(zip.entries[0]?.name).toBe('Äußere.stl')
  })

  it('prefers a valid Info-ZIP Unicode Path field and ignores a stale one', async () => {
    const stored = strToU8('Fusse.stl')
    const valid = unicodePathExtra('Füße.stl', stored)
    const stale = unicodePathExtra('Old name.stl', strToU8('Renamed.stl'))
    const zip = await open(
      writeZip([
        { name: stored, data: strToU8('a'), extra: valid },
        { name: stored, data: strToU8('b'), extra: stale },
        {
          name: 'other.stl',
          data: strToU8('c'),
          extra: extraField(0x5455, Uint8Array.of(1, 2, 3, 4, 5)),
        },
      ]),
    )
    expect(zip.entries.map((entry) => entry.name)).toEqual(['Füße.stl', 'Fusse.stl', 'other.stl'])
  })
})

describe('openZip: hostile and broken archives', () => {
  it('rejects an entry whose declared size exceeds the per-entry cap, before inflating', async () => {
    const bytes = writeZip([
      { name: 'bomb.model', data: strToU8('tiny'), declaredSize: 5_000_000_000, zip64: true },
    ])
    const zip = await open(bytes)
    const error = await rejection(zip.read(zip.entries[0]!))
    expect(error).toBeInstanceOf(LimitExceededError)
    expect(error).toMatchObject({
      code: 'limit-exceeded',
      limit: 'entry-bytes',
      actual: 5_000_000_000,
    })
    expect(zip.inflatedBytes).toBe(0)
  })

  it('rejects a high-ratio entry with an honest header by its declared size', async () => {
    const zeros = new Uint8Array(24 * MiB)
    const bytes = zipSync({ 'zeros.model': [zeros, { level: 9 }] })
    expect(bytes.length).toBeLessThan(MiB)
    const zip = await open(bytes, { maxEntryInflatedBytes: 4 * MiB })
    expect(await rejection(zip.read(zip.entries[0]!))).toMatchObject({ limit: 'entry-bytes' })
  })

  it('stops an entry that inflates past its declared size (lying header)', async () => {
    const zeros = new Uint8Array(8 * MiB)
    const bytes = writeZip([{ name: 'liar.model', data: zeros, declaredSize: 1000 }])
    const zip = await open(bytes)
    const error = await rejection(zip.stream(zip.entries[0]!, () => {}))
    expect(error).toBeInstanceOf(LimitExceededError)
    expect(error).toMatchObject({ limit: 'declared-size', max: 1000 })
    // Nothing past the declared size was handed out or counted.
    expect(zip.inflatedBytes).toBeLessThanOrEqual(1000)
  })

  it('caps the total inflated across entries', async () => {
    const files = Object.fromEntries(
      Array.from({ length: 5 }, (_, i) => [`part${i}.model`, patterned(MiB, i + 1)]),
    )
    const zip = await open(zipSync(files), { maxTotalInflatedBytes: 3 * MiB + 10 })
    for (const entry of zip.entries.slice(0, 3)) await zip.read(entry)
    expect(await rejection(zip.read(zip.entries[3]!))).toMatchObject({ limit: 'total-bytes' })
  })

  it('caps overlapping entries that reuse one compressed payload', async () => {
    const bytes = writeZip([{ name: 'kernel.model', data: new Uint8Array(MiB) }], {
      centralCopies: 50,
    })
    const zip = await open(bytes, { maxTotalInflatedBytes: 10 * MiB })
    expect(zip.entries).toHaveLength(50)
    let read = 0
    const error = await rejection(
      (async () => {
        for (const entry of zip.entries) {
          await zip.read(entry)
          read++
        }
      })(),
    )
    expect(error).toMatchObject({ limit: 'total-bytes' })
    expect(read).toBe(10)
  })

  it('caps the number of entries before reading the directory', async () => {
    const bytes = writeZip([{ name: 'a', data: strToU8('a') }], { centralCopies: 20 })
    expect(await rejection(open(bytes, { maxEntries: 10 }))).toMatchObject({
      limit: 'entries',
      actual: 20,
    })
  })

  it('refuses encrypted entries and unsupported methods', async () => {
    const zip = await open(
      writeZip([
        { name: 'secret.model', data: strToU8('x'), flags: 0x1 },
        { name: 'bzip2.model', data: strToU8('x'), method: 12 },
      ]),
    )
    expect(await rejection(zip.read(zip.entries[0]!))).toMatchObject({ code: 'zip-encrypted' })
    expect(await rejection(zip.read(zip.entries[1]!))).toMatchObject({ code: 'zip-unsupported' })
  })

  it('detects CRC mismatches and corrupt deflate data', async () => {
    const zip = await open(
      writeZip([{ name: 'a.model', data: strToU8('payload'), crc: 0x12345678 }]),
    )
    expect(await rejection(zip.read(zip.entries[0]!))).toMatchObject({ code: 'zip-corrupt' })

    const bytes = writeZip([{ name: 'b.model', data: patterned(4000) }])
    bytes.fill(0xff, 60, 200) // stomp on the deflate stream
    const broken = await open(bytes)
    const error = await rejection(broken.read(broken.entries[0]!))
    expect(error).toBeInstanceOf(ModelError)
    expect(error).toMatchObject({ code: 'zip-corrupt' })
  })

  it('reports non-ZIP, truncated and damaged archives', async () => {
    expect(await rejection(open(strToU8('solid cube\nendsolid cube\n')))).toMatchObject({
      code: 'not-a-zip',
    })
    const bytes = zipSync({ 'a.txt': strToU8('x'.repeat(100)) })
    expect(await rejection(open(bytes.subarray(0, bytes.length - 10)))).toMatchObject({
      code: 'not-a-zip',
    })
    const damaged = bytes.slice()
    const directory = damaged.length - 22 - 46 - 'a.txt'.length
    damaged.fill(0, directory, directory + 4)
    expect(await rejection(open(damaged))).toMatchObject({ code: 'zip-corrupt' })
  })
})
