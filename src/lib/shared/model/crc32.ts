/**
 * CRC-32 (IEEE 802.3, the ZIP checksum). fflate does not export its implementation, and ZIP
 * extraction needs one to verify entries and the Info-ZIP Unicode Path field.
 *
 * Slicing-by-8: inflated 3MF meshes run to tens of MB, and the byte-at-a-time loop is ~4x slower.
 */

const TABLES = buildTables()

function buildTables(): Uint32Array {
  const tables = new Uint32Array(8 * 256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    tables[n] = c
  }
  // tables[k][n] is tables[k - 1][n] advanced by one zero byte.
  for (let n = 0; n < 256; n++) {
    let c = tables[n]!
    for (let k = 1; k < 8; k++) {
      c = tables[c & 0xff]! ^ (c >>> 8)
      tables[k * 256 + n] = c
    }
  }
  return tables
}

/** CRC-32 of `data`. Pass the previous result as `previous` to continue across chunks. */
export function crc32(data: Uint8Array, previous = 0): number {
  const t = TABLES
  const length = data.length
  let crc = ~previous
  let i = 0
  for (; i + 8 <= length; i += 8) {
    const lo = crc ^ (data[i]! | (data[i + 1]! << 8) | (data[i + 2]! << 16) | (data[i + 3]! << 24))
    const hi = data[i + 4]! | (data[i + 5]! << 8) | (data[i + 6]! << 16) | (data[i + 7]! << 24)
    crc =
      t[1792 + (lo & 0xff)]! ^
      t[1536 + ((lo >>> 8) & 0xff)]! ^
      t[1280 + ((lo >>> 16) & 0xff)]! ^
      t[1024 + (lo >>> 24)]! ^
      t[768 + (hi & 0xff)]! ^
      t[512 + ((hi >>> 8) & 0xff)]! ^
      t[256 + ((hi >>> 16) & 0xff)]! ^
      t[hi >>> 24]!
  }
  for (; i < length; i++) crc = t[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8)
  return ~crc >>> 0
}
