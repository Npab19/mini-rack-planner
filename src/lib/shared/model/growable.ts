/**
 * Append-only typed arrays that double their capacity, so streaming parsers can fill meshes without
 * knowing vertex or triangle counts up front (3MF has no counts; ASCII STL neither).
 */

const INITIAL_CAPACITY = 3 * 1024

function nextCapacity(current: number, required: number): number {
  let capacity = Math.max(current * 2, INITIAL_CAPACITY)
  while (capacity < required) capacity *= 2
  return capacity
}

export class GrowableFloat32Array {
  private data: Float32Array<ArrayBuffer>
  length = 0

  constructor(initialCapacity = INITIAL_CAPACITY) {
    this.data = new Float32Array(initialCapacity)
  }

  push3(a: number, b: number, c: number): void {
    const at = this.length
    if (at + 3 > this.data.length) this.grow(at + 3)
    const data = this.data
    data[at] = a
    data[at + 1] = b
    data[at + 2] = c
    this.length = at + 3
  }

  /** Live view of the filled part; invalidated by the next push. */
  view(): Float32Array<ArrayBuffer> {
    return this.data.subarray(0, this.length)
  }

  /** Exact-size copy that owns its buffer, so it can be transferred out of a worker. */
  toArray(): Float32Array<ArrayBuffer> {
    return this.data.slice(0, this.length)
  }

  private grow(required: number): void {
    const next = new Float32Array(nextCapacity(this.data.length, required))
    next.set(this.data.subarray(0, this.length))
    this.data = next
  }
}

export class GrowableUint32Array {
  private data: Uint32Array<ArrayBuffer>
  length = 0

  constructor(initialCapacity = INITIAL_CAPACITY) {
    this.data = new Uint32Array(initialCapacity)
  }

  push3(a: number, b: number, c: number): void {
    const at = this.length
    if (at + 3 > this.data.length) this.grow(at + 3)
    const data = this.data
    data[at] = a
    data[at + 1] = b
    data[at + 2] = c
    this.length = at + 3
  }

  view(): Uint32Array<ArrayBuffer> {
    return this.data.subarray(0, this.length)
  }

  toArray(): Uint32Array<ArrayBuffer> {
    return this.data.slice(0, this.length)
  }

  private grow(required: number): void {
    const next = new Uint32Array(nextCapacity(this.data.length, required))
    next.set(this.data.subarray(0, this.length))
    this.data = next
  }
}
