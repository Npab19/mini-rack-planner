/**
 * DOM-free XML for 3MF packages (DOMParser does not exist in workers or Node).
 *
 * - `tokenizeXml` / `parseXml`: a small string tokenizer and tree builder for small parts:
 *   OPC `.rels`, `Metadata/model_settings.config`, `Metadata/slice_info.config`.
 * - `ModelXmlScanner`: a streaming, byte-level scanner for `3D/*.model` parts. `<vertex>` and
 *   `<triangle>` go straight from bytes to numbers without per-element strings; every other element
 *   is decoded and parsed like the string tokenizer does, then handed to the handler.
 *
 * Only the five predefined entities and numeric references are expanded. DOCTYPE declarations are
 * skipped and their entities never expanded, so entity-expansion bombs cannot apply.
 */

import { isXmlWhitespace, parseDecimal, parseUint32 } from './numbers'
import { DEFAULT_LIMITS, LimitExceededError, ModelError } from './types'

export type XmlAttributes = ReadonlyMap<string, string>

export interface XmlElement {
  name: string
  attrs: XmlAttributes
  children: XmlElement[]
  /** Concatenated direct text and CDATA, entity-decoded. */
  text: string
}

export interface XmlHandler {
  /** Called for every element; self-closing elements get an immediate `close` as well. */
  open?(name: string, attrs: XmlAttributes, selfClosing: boolean): void
  close?(name: string): void
  /** Text or CDATA inside the root element, entity-decoded. May arrive in several pieces. */
  text?(text: string): void
}

const LT = 60
const GT = 62
const SLASH = 47
const EQ = 61
const QUOT = 34
const APOS = 39
const BANG = 33
const QUESTION = 63
const INCOMPLETE = -1

const NAMED_ENTITIES = new Map([
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['quot', '"'],
  ['apos', "'"],
])

function malformed(message: string, offset: number): ModelError {
  return new ModelError('xml-malformed', `${message} (at offset ${offset})`)
}

/** `p:path` -> `path`. */
export function localName(qualifiedName: string): string {
  const colon = qualifiedName.indexOf(':')
  return colon < 0 ? qualifiedName : qualifiedName.slice(colon + 1)
}

/** Expands the predefined entities and numeric character references; rejects anything else. */
export function decodeXmlEntities(raw: string, offset = 0): string {
  let amp = raw.indexOf('&')
  if (amp < 0) return raw
  let out = ''
  let last = 0
  while (amp >= 0) {
    const semicolon = raw.indexOf(';', amp + 1)
    if (semicolon < 0) throw malformed('Unterminated entity reference', offset + amp)
    out += raw.slice(last, amp) + resolveEntity(raw.slice(amp + 1, semicolon), offset + amp)
    last = semicolon + 1
    amp = raw.indexOf('&', last)
  }
  return out + raw.slice(last)
}

function resolveEntity(name: string, offset: number): string {
  if (name.startsWith('#')) {
    const hex = name[1] === 'x' || name[1] === 'X'
    const digits = name.slice(hex ? 2 : 1)
    const valid = hex ? /^[0-9a-fA-F]{1,6}$/.test(digits) : /^\d{1,7}$/.test(digits)
    const code = valid ? Number.parseInt(digits, hex ? 16 : 10) : -1
    const isScalar = code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff)
    if (!isScalar) throw malformed(`Invalid character reference &${name};`, offset)
    return String.fromCodePoint(code)
  }
  const value = NAMED_ENTITIES.get(name)
  if (value === undefined) throw malformed(`Unknown entity &${name};`, offset)
  return value
}

function isWhitespaceCode(code: number): boolean {
  return code === 32 || code === 10 || code === 13 || code === 9
}

function skipWhitespace(src: string, from: number, end: number): number {
  let i = from
  while (i < end && isWhitespaceCode(src.charCodeAt(i))) i++
  return i
}

/** Element and attribute names end at whitespace, `=`, `/` or `>`. */
function scanName(src: string, from: number, end: number): number {
  let i = from
  while (i < end) {
    const code = src.charCodeAt(i)
    if (isWhitespaceCode(code) || code === EQ || code === SLASH || code === GT) break
    if (code === LT || code === QUOT || code === APOS || code === 38 /* & */) break
    i++
  }
  return i
}

interface StartTag {
  name: string
  attrs: Map<string, string>
  selfClosing: boolean
}

/** Parses the inside of a start tag: `src[start, end)` is everything between `<` and `>`. */
function parseStartTag(src: string, start: number, end: number, offset: number): StartTag {
  let stop = end
  let selfClosing = false
  if (stop > start && src.charCodeAt(stop - 1) === SLASH) {
    selfClosing = true
    stop--
  }
  const nameEnd = scanName(src, start, stop)
  if (nameEnd === start) throw malformed('Missing element name', offset)
  const name = src.slice(start, nameEnd)
  const attrs = new Map<string, string>()

  let i = nameEnd
  for (;;) {
    const next = skipWhitespace(src, i, stop)
    if (next >= stop) break
    if (next === i) throw malformed(`Unexpected character in <${name}>`, offset)
    i = next
    const attrNameEnd = scanName(src, i, stop)
    if (attrNameEnd === i) throw malformed(`Unexpected character in <${name}>`, offset)
    const attrName = src.slice(i, attrNameEnd)
    i = skipWhitespace(src, attrNameEnd, stop)
    if (src.charCodeAt(i) !== EQ) throw malformed(`Attribute ${attrName} has no value`, offset)
    i = skipWhitespace(src, i + 1, stop)
    const quote = src.charCodeAt(i)
    if (quote !== QUOT && quote !== APOS) throw malformed(`Unquoted value for ${attrName}`, offset)
    const valueEnd = src.indexOf(quote === QUOT ? '"' : "'", i + 1)
    if (valueEnd < 0 || valueEnd >= stop)
      throw malformed(`Unterminated value for ${attrName}`, offset)
    const raw = src.slice(i + 1, valueEnd)
    if (raw.includes('<')) throw malformed(`'<' in the value of ${attrName}`, offset)
    if (attrs.has(attrName)) throw malformed(`Duplicate attribute ${attrName}`, offset)
    attrs.set(attrName, decodeXmlEntities(raw, offset))
    i = valueEnd + 1
  }
  return { name, attrs, selfClosing }
}

/** Index of the `>` that ends the tag starting before `from`, skipping quoted values; -1 if absent. */
function findTagEnd(src: string, from: number): number {
  let quote = 0
  for (let i = from; i < src.length; i++) {
    const code = src.charCodeAt(i)
    if (quote !== 0) {
      if (code === quote) quote = 0
    } else if (code === QUOT || code === APOS) {
      quote = code
    } else if (code === GT) {
      return i
    } else if (code === LT) {
      throw malformed('Unclosed tag', from)
    }
  }
  return -1
}

/** Skips `<!DOCTYPE ...>` including an internal subset in brackets. Returns the index after it. */
function skipDoctype(src: string, lt: number): number {
  const gt = src.indexOf('>', lt)
  const bracket = src.indexOf('[', lt)
  if (bracket >= 0 && (gt < 0 || bracket < gt)) {
    const close = src.indexOf(']', bracket)
    const end = close < 0 ? -1 : src.indexOf('>', close)
    if (end < 0) throw malformed('Unterminated DOCTYPE', lt)
    return end + 1
  }
  if (gt < 0) throw malformed('Unterminated DOCTYPE', lt)
  return gt + 1
}

/** Event-based tokenizer over a complete string. Throws a ModelError('xml-malformed') on bad input. */
export function tokenizeXml(
  xml: string,
  handler: XmlHandler,
  maxDepth = DEFAULT_LIMITS.maxXmlDepth,
): void {
  const stack: string[] = []
  let rootSeen = false
  let pos = xml.charCodeAt(0) === 0xfeff ? 1 : 0

  while (pos < xml.length) {
    const lt = xml.indexOf('<', pos)
    const textEnd = lt < 0 ? xml.length : lt
    if (textEnd > pos) {
      const raw = xml.slice(pos, textEnd)
      if (stack.length > 0) handler.text?.(decodeXmlEntities(raw, pos))
      else if (raw.trim() !== '') throw malformed('Text outside the root element', pos)
    }
    if (lt < 0) break

    if (xml.startsWith('<!--', lt)) {
      const end = xml.indexOf('-->', lt + 4)
      if (end < 0) throw malformed('Unterminated comment', lt)
      pos = end + 3
    } else if (xml.startsWith('<![CDATA[', lt)) {
      const end = xml.indexOf(']]>', lt + 9)
      if (end < 0) throw malformed('Unterminated CDATA section', lt)
      if (stack.length === 0) throw malformed('CDATA outside the root element', lt)
      handler.text?.(xml.slice(lt + 9, end))
      pos = end + 3
    } else if (xml.startsWith('<!DOCTYPE', lt)) {
      pos = skipDoctype(xml, lt)
    } else if (xml.startsWith('<?', lt)) {
      const end = xml.indexOf('?>', lt + 2)
      if (end < 0) throw malformed('Unterminated processing instruction', lt)
      pos = end + 2
    } else if (xml.startsWith('</', lt)) {
      const gt = xml.indexOf('>', lt + 2)
      if (gt < 0) throw malformed('Unterminated end tag', lt)
      const name = xml.slice(lt + 2, gt).trim()
      const open = stack.pop()
      if (open !== name) throw malformed(`Expected </${open ?? ''}> but found </${name}>`, lt)
      handler.close?.(name)
      pos = gt + 1
    } else if (xml.charCodeAt(lt + 1) === BANG) {
      throw malformed('Unsupported markup declaration', lt)
    } else {
      const gt = findTagEnd(xml, lt + 1)
      if (gt < 0) throw malformed('Unterminated start tag', lt)
      const tag = parseStartTag(xml, lt + 1, gt, lt)
      if (stack.length === 0 && rootSeen) throw malformed('More than one root element', lt)
      rootSeen = true
      handler.open?.(tag.name, tag.attrs, tag.selfClosing)
      if (tag.selfClosing) {
        handler.close?.(tag.name)
      } else {
        if (stack.length >= maxDepth)
          throw new LimitExceededError('xml-depth', stack.length + 1, maxDepth)
        stack.push(tag.name)
      }
      pos = gt + 1
    }
  }
  if (stack.length > 0)
    throw malformed(`Unclosed element <${stack[stack.length - 1] ?? ''}>`, xml.length)
  if (!rootSeen) throw malformed('No root element', 0)
}

/** Parses a complete document into a small element tree. Meant for small files only. */
export function parseXml(xml: string, maxDepth = DEFAULT_LIMITS.maxXmlDepth): XmlElement {
  let root: XmlElement | undefined
  const stack: XmlElement[] = []
  tokenizeXml(
    xml,
    {
      open(name, attrs) {
        const element: XmlElement = { name, attrs, children: [], text: '' }
        const parent = stack[stack.length - 1]
        if (parent) parent.children.push(element)
        else root = element
        stack.push(element)
      },
      close() {
        stack.pop()
      },
      text(text) {
        const current = stack[stack.length - 1]
        if (current) current.text += text
      },
    },
    maxDepth,
  )
  if (!root) throw malformed('No root element', 0)
  return root
}

/** Direct children whose local name matches (namespace prefixes ignored). */
export function childElements(element: XmlElement, name: string): XmlElement[] {
  return element.children.filter((child) => localName(child.name) === name)
}

export function firstChild(element: XmlElement, name: string): XmlElement | undefined {
  return element.children.find((child) => localName(child.name) === name)
}

// ---------------------------------------------------------------------------------------------
// Streaming byte-level scanner for 3D model parts
// ---------------------------------------------------------------------------------------------

export interface ModelXmlHandler {
  /** Every element except the fast-path `<vertex>` and `<triangle>`. */
  open(name: string, attrs: XmlAttributes, selfClosing: boolean): void
  /** `text` is the element's own text when its local name is one of the scanner's `textElements`. */
  close(name: string, text: string | undefined): void
  vertex(x: number, y: number, z: number): void
  triangle(v1: number, v2: number, v3: number): void
}

export interface ModelXmlScannerOptions {
  /** Local names whose direct text is collected and passed to `close` (3MF: `metadata`). */
  textElements?: ReadonlySet<string>
  maxTokenBytes?: number
  maxDepth?: number
  /** Collected text beyond this is dropped (descriptions can be long and are never needed whole). */
  maxTextBytes?: number
}

interface TextPiece {
  bytes: Uint8Array
  cdata: boolean
}

const VERTEX_NAME = new TextEncoder().encode('vertex')
const TRIANGLE_NAME = new TextEncoder().encode('triangle')
const COMMENT_OPEN = new TextEncoder().encode('<!--')
const COMMENT_CLOSE = new TextEncoder().encode('-->')
const CDATA_OPEN = new TextEncoder().encode('<![CDATA[')
const CDATA_CLOSE = new TextEncoder().encode(']]>')
const DOCTYPE_OPEN = new TextEncoder().encode('<!DOCTYPE')
const PI_CLOSE = new TextEncoder().encode('?>')
const EMPTY_TEXT_ELEMENTS: ReadonlySet<string> = new Set()
const DEFAULT_MAX_TEXT_BYTES = 1024 * 1024

/** 1 if `bytes[at..]` starts with `word`, 0 if it does not, INCOMPLETE if the buffer ends first. */
function startsWithBytes(bytes: Uint8Array, at: number, word: Uint8Array): number {
  for (let k = 0; k < word.length; k++) {
    if (at + k >= bytes.length) return INCOMPLETE
    if (bytes[at + k] !== word[k]) return 0
  }
  return 1
}

/** Like startsWithBytes, and the name must be followed by whitespace, `/` or `>`. */
function matchesElementName(bytes: Uint8Array, at: number, name: Uint8Array): number {
  const prefix = startsWithBytes(bytes, at, name)
  if (prefix !== 1) return prefix
  const next = bytes[at + name.length]
  if (next === undefined) return INCOMPLETE
  return isXmlWhitespace(next) || next === SLASH || next === GT ? 1 : 0
}

function indexOfBytes(bytes: Uint8Array, sequence: Uint8Array, from: number): number {
  const first = sequence[0]!
  let i = bytes.indexOf(first, from)
  while (i >= 0 && i + sequence.length <= bytes.length) {
    if (startsWithBytes(bytes, i, sequence) === 1) return i
    i = bytes.indexOf(first, i + 1)
  }
  return -1
}

/** Quote-aware search for the `>` that ends a start tag; INCOMPLETE if the buffer ends first. */
function findTagEndBytes(bytes: Uint8Array, from: number, offset: number): number {
  let quote = 0
  for (let i = from; i < bytes.length; i++) {
    const byte = bytes[i]!
    if (quote !== 0) {
      if (byte === quote) quote = 0
    } else if (byte === QUOT || byte === APOS) {
      quote = byte
    } else if (byte === GT) {
      return i
    } else if (byte === LT) {
      throw malformed('Unclosed tag', offset)
    }
  }
  return INCOMPLETE
}

/** x/y/z -> 0/1/2 for `<vertex>`. */
function vertexSlot(bytes: Uint8Array, start: number, length: number): number {
  if (length !== 1) return -1
  const slot = bytes[start]! - 120
  return slot >= 0 && slot <= 2 ? slot : -1
}

/** v1/v2/v3 -> 0/1/2 for `<triangle>`. */
function triangleSlot(bytes: Uint8Array, start: number, length: number): number {
  if (length !== 2 || bytes[start] !== 118) return -1
  const slot = bytes[start + 1]! - 49
  return slot >= 0 && slot <= 2 ? slot : -1
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  if (parts.length === 1) return parts[0]!
  let length = 0
  for (const part of parts) length += part.length
  const out = new Uint8Array(length)
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

/**
 * Streaming scanner for 3MF model XML. Feed decompressed chunks with `push` in order, then call
 * `finish`. Chunks may split anything (tags, numbers, UTF-8 sequences); an unfinished construct is
 * carried over to the next chunk, bounded by `maxTokenBytes`.
 */
export class ModelXmlScanner {
  private readonly handler: ModelXmlHandler
  private readonly textElements: ReadonlySet<string>
  private readonly maxTokenBytes: number
  private readonly maxDepth: number
  private readonly maxTextBytes: number
  private readonly decoder = new TextDecoder()
  private readonly stack: string[] = []
  /** Parallel to `stack`: true for fast-path elements, which the handler never sees. */
  private readonly fastPath: boolean[] = []
  private readonly values = new Float64Array(3)
  private carry: Uint8Array | undefined
  /** Absolute offset of the current buffer's first byte, for error messages. */
  private base = 0
  private started = false
  private rootSeen = false
  private textDepth = -1
  private textPieces: TextPiece[] = []
  private textBytes = 0

  constructor(handler: ModelXmlHandler, options: ModelXmlScannerOptions = {}) {
    this.handler = handler
    this.textElements = options.textElements ?? EMPTY_TEXT_ELEMENTS
    this.maxTokenBytes = options.maxTokenBytes ?? DEFAULT_LIMITS.maxXmlTokenBytes
    this.maxDepth = options.maxDepth ?? DEFAULT_LIMITS.maxXmlDepth
    this.maxTextBytes = options.maxTextBytes ?? DEFAULT_MAX_TEXT_BYTES
  }

  push(chunk: Uint8Array): void {
    let buffer = this.carry ? concatBytes([this.carry, chunk]) : chunk
    this.carry = undefined
    if (!this.started) {
      if (buffer.length < 3) {
        this.carry = buffer.slice()
        return
      }
      buffer = this.skipByteOrderMark(buffer)
      this.started = true
    }
    const consumed = this.scan(buffer)
    const remaining = buffer.length - consumed
    if (remaining > this.maxTokenBytes) {
      const message = 'An XML tag, comment or CDATA section is too long'
      throw new LimitExceededError('xml-token', remaining, this.maxTokenBytes, message)
    }
    if (remaining > 0) this.carry = buffer.slice(consumed)
    this.base += consumed
  }

  finish(): void {
    if (this.carry && !this.started) {
      // Shorter than a byte-order mark: scan whatever there is.
      const buffer = this.carry
      this.carry = undefined
      this.started = true
      const consumed = this.scan(buffer)
      if (consumed < buffer.length) this.carry = buffer.slice(consumed)
    }
    if (this.carry && this.carry.length > 0) {
      throw malformed('Unexpected end of document inside markup', this.base)
    }
    const open = this.stack[this.stack.length - 1]
    if (open !== undefined) throw malformed(`Unclosed element <${open}>`, this.base)
    if (!this.rootSeen) throw malformed('No root element', this.base)
  }

  private skipByteOrderMark(buffer: Uint8Array): Uint8Array {
    const [b0, b1, b2] = buffer
    if (b0 === 0xef && b1 === 0xbb && b2 === 0xbf) {
      this.base += 3
      return buffer.subarray(3)
    }
    if ((b0 === 0xfe && b1 === 0xff) || (b0 === 0xff && b1 === 0xfe)) {
      throw malformed('UTF-16 model files are not supported', 0)
    }
    return buffer
  }

  /** Processes complete constructs; returns how many bytes were consumed. */
  private scan(buffer: Uint8Array): number {
    let pos = 0
    while (pos < buffer.length) {
      const lt = buffer.indexOf(LT, pos)
      if (lt < 0) {
        this.text(buffer, pos, buffer.length)
        return buffer.length
      }
      if (lt > pos) this.text(buffer, pos, lt)
      const next = this.markup(buffer, lt)
      if (next === INCOMPLETE) return lt
      pos = next
    }
    return buffer.length
  }

  private text(buffer: Uint8Array, start: number, end: number): void {
    if (this.stack.length === 0) {
      for (let i = start; i < end; i++) {
        if (!isXmlWhitespace(buffer[i]!))
          throw malformed('Text outside the root element', this.base + i)
      }
      return
    }
    this.collectText(buffer, start, end, false)
  }

  private collectText(buffer: Uint8Array, start: number, end: number, cdata: boolean): void {
    if (this.textDepth !== this.stack.length) return
    const length = end - start
    if (this.textBytes + length > this.maxTextBytes) return
    this.textPieces.push({ bytes: buffer.slice(start, end), cdata })
    this.textBytes += length
  }

  private takeText(): string {
    let out = ''
    let run: Uint8Array[] = []
    let runIsCdata = false
    const flush = (): void => {
      if (run.length === 0) return
      const decoded = this.decoder.decode(concatBytes(run))
      out += runIsCdata ? decoded : decodeXmlEntities(decoded, this.base)
      run = []
    }
    for (const piece of this.textPieces) {
      if (piece.cdata !== runIsCdata) flush()
      runIsCdata = piece.cdata
      run.push(piece.bytes)
    }
    flush()
    this.textPieces = []
    this.textBytes = 0
    this.textDepth = -1
    return out
  }

  /** Handles the markup starting at `lt`; returns the index after it, or INCOMPLETE. */
  private markup(buffer: Uint8Array, lt: number): number {
    const next = buffer[lt + 1]
    if (next === undefined) return INCOMPLETE
    if (next === SLASH) return this.endTag(buffer, lt)
    if (next === QUESTION) {
      const end = indexOfBytes(buffer, PI_CLOSE, lt + 2)
      return end < 0 ? INCOMPLETE : end + PI_CLOSE.length
    }
    if (next === BANG) return this.declaration(buffer, lt)
    if (this.stack.length > 0) {
      const vertex = matchesElementName(buffer, lt + 1, VERTEX_NAME)
      if (vertex === INCOMPLETE) return INCOMPLETE
      if (vertex === 1) return this.fastElement(buffer, lt + 1 + VERTEX_NAME.length, false)
      const triangle = matchesElementName(buffer, lt + 1, TRIANGLE_NAME)
      if (triangle === INCOMPLETE) return INCOMPLETE
      if (triangle === 1) return this.fastElement(buffer, lt + 1 + TRIANGLE_NAME.length, true)
    }
    return this.startTag(buffer, lt)
  }

  private declaration(buffer: Uint8Array, lt: number): number {
    const comment = startsWithBytes(buffer, lt, COMMENT_OPEN)
    if (comment === 1) {
      const end = indexOfBytes(buffer, COMMENT_CLOSE, lt + COMMENT_OPEN.length)
      return end < 0 ? INCOMPLETE : end + COMMENT_CLOSE.length
    }
    const cdata = startsWithBytes(buffer, lt, CDATA_OPEN)
    if (cdata === 1) {
      const end = indexOfBytes(buffer, CDATA_CLOSE, lt + CDATA_OPEN.length)
      if (end < 0) return INCOMPLETE
      if (this.stack.length === 0) throw malformed('CDATA outside the root element', this.base + lt)
      this.collectText(buffer, lt + CDATA_OPEN.length, end, true)
      return end + CDATA_CLOSE.length
    }
    const doctype = startsWithBytes(buffer, lt, DOCTYPE_OPEN)
    if (doctype === 1) return this.skipDoctypeBytes(buffer, lt)
    if (comment === INCOMPLETE || cdata === INCOMPLETE || doctype === INCOMPLETE) return INCOMPLETE
    throw malformed('Unsupported markup declaration', this.base + lt)
  }

  private skipDoctypeBytes(buffer: Uint8Array, lt: number): number {
    const gt = buffer.indexOf(GT, lt)
    const bracket = buffer.indexOf(91 /* [ */, lt)
    if (bracket >= 0 && (gt < 0 || bracket < gt)) {
      const close = buffer.indexOf(93 /* ] */, bracket)
      const end = close < 0 ? -1 : buffer.indexOf(GT, close)
      return end < 0 ? INCOMPLETE : end + 1
    }
    return gt < 0 ? INCOMPLETE : gt + 1
  }

  private startTag(buffer: Uint8Array, lt: number): number {
    const gt = findTagEndBytes(buffer, lt + 1, this.base + lt)
    if (gt === INCOMPLETE) return INCOMPLETE
    const content = this.decoder.decode(buffer.subarray(lt + 1, gt))
    const tag = parseStartTag(content, 0, content.length, this.base + lt)
    if (this.stack.length === 0 && this.rootSeen) {
      throw malformed('More than one root element', this.base + lt)
    }
    this.rootSeen = true
    this.handler.open(tag.name, tag.attrs, tag.selfClosing)
    if (tag.selfClosing) {
      this.handler.close(tag.name, undefined)
    } else {
      this.pushElement(tag.name, lt, false)
      if (this.textElements.has(localName(tag.name))) this.textDepth = this.stack.length
    }
    return gt + 1
  }

  private endTag(buffer: Uint8Array, lt: number): number {
    const gt = buffer.indexOf(GT, lt + 2)
    if (gt < 0) return INCOMPLETE
    const name = this.decoder.decode(buffer.subarray(lt + 2, gt)).trim()
    const depth = this.stack.length
    const open = this.stack.pop()
    const fastPath = this.fastPath.pop()
    if (open !== name)
      throw malformed(`Expected </${open ?? ''}> but found </${name}>`, this.base + lt)
    const text = this.textDepth === depth ? this.takeText() : undefined
    // Fast-path elements were never opened on the handler, so they are not closed on it either.
    if (!fastPath) this.handler.close(name, text)
    return gt + 1
  }

  private pushElement(name: string, at: number, fastPath: boolean): void {
    if (this.stack.length >= this.maxDepth) {
      const message = `XML nested too deeply (at offset ${this.base + at})`
      throw new LimitExceededError('xml-depth', this.stack.length + 1, this.maxDepth, message)
    }
    this.stack.push(name)
    this.fastPath.push(fastPath)
  }

  /**
   * `<vertex x= y= z=/>` or `<triangle v1= v2= v3= .../>` from `start` (just after the name).
   * Attribute order is free and unknown attributes (paint_color, p1, pid, ...) are skipped.
   * Nothing is reported to the handler until the whole tag is in the buffer.
   */
  private fastElement(buffer: Uint8Array, start: number, triangle: boolean): number {
    const values = this.values
    let found = 0
    let selfClosing = true
    let i = start
    for (;;) {
      while (i < buffer.length && isXmlWhitespace(buffer[i]!)) i++
      const byte = buffer[i]
      if (byte === undefined) return INCOMPLETE
      if (byte === SLASH) {
        const after = buffer[i + 1]
        if (after === undefined) return INCOMPLETE
        if (after !== GT) throw malformed("Expected '/>'", this.base + i)
        i += 2
        break
      }
      if (byte === GT) {
        selfClosing = false
        i += 1
        break
      }
      const nameStart = i
      while (i < buffer.length) {
        const b = buffer[i]!
        if (isXmlWhitespace(b) || b === EQ || b === SLASH || b === GT) break
        i++
      }
      const nameLength = i - nameStart
      while (i < buffer.length && isXmlWhitespace(buffer[i]!)) i++
      if (i >= buffer.length) return INCOMPLETE
      if (nameLength === 0 || buffer[i] !== EQ)
        throw malformed('Expected name="value"', this.base + i)
      i++
      while (i < buffer.length && isXmlWhitespace(buffer[i]!)) i++
      const quote = buffer[i]
      if (quote === undefined) return INCOMPLETE
      if (quote !== QUOT && quote !== APOS)
        throw malformed('Attribute value must be quoted', this.base + i)
      const valueStart = i + 1
      const valueEnd = buffer.indexOf(quote, valueStart)
      if (valueEnd < 0) return INCOMPLETE
      const slot = triangle
        ? triangleSlot(buffer, nameStart, nameLength)
        : vertexSlot(buffer, nameStart, nameLength)
      if (slot >= 0) {
        const value = triangle
          ? parseUint32(buffer, valueStart, valueEnd)
          : parseDecimal(buffer, valueStart, valueEnd)
        if (triangle ? value < 0 : !Number.isFinite(value)) {
          const element = triangle ? 'triangle' : 'vertex'
          throw malformed(`Invalid number in <${element}>`, this.base + valueStart)
        }
        values[slot] = value
        found |= 1 << slot
      }
      i = valueEnd + 1
    }
    if (found !== 7) {
      const message = triangle ? '<triangle> needs v1, v2 and v3' : '<vertex> needs x, y and z'
      throw malformed(message, this.base + start)
    }
    if (triangle) this.handler.triangle(values[0]!, values[1]!, values[2]!)
    else this.handler.vertex(values[0]!, values[1]!, values[2]!)
    if (!selfClosing) this.pushElement(triangle ? 'triangle' : 'vertex', start, true)
    return i
  }
}
