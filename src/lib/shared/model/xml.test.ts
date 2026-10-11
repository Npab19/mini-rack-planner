import { fc, test } from '@fast-check/vitest'
import { describe, expect, it } from 'vitest'
import { LimitExceededError, ModelError } from './types'
import {
  decodeXmlEntities,
  type ModelXmlHandler,
  ModelXmlScanner,
  type ModelXmlScannerOptions,
  parseXml,
  tokenizeXml,
  type XmlAttributes,
} from './xml'

describe('decodeXmlEntities', () => {
  it('expands predefined and numeric entities', () => {
    expect(decodeXmlEntities('a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos;')).toBe(
      `a & b <c> "d" 'e'`,
    )
    expect(decodeXmlEntities('&#65;&#x42;&#X43; &#x1F600;')).toBe('ABC 😀')
    expect(decodeXmlEntities('no entities')).toBe('no entities')
  })

  it.each(['&nbsp;', '&#0;', '&#xD800;', '&#x110000;', '&amp', '&#xZZ;', '&constructor;'])(
    'rejects %s',
    (raw) => {
      expect(() => decodeXmlEntities(raw)).toThrow(ModelError)
    },
  )
})

describe('tokenizeXml / parseXml', () => {
  it('builds a tree with attributes, self-closing elements, text, CDATA and entities', () => {
    const xml = [
      '﻿<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE config [ <!ENTITY boom "never expanded"> ]>',
      '<!-- a comment with <tags> -->',
      '<config version=\'2\' note="a &amp; b">',
      '  <object id="2"><metadata key="name" value="Leg &lt;6U&gt;"/></object>',
      '  <text>one &amp; <![CDATA[<two> & three]]></text>',
      '  <?pi ignored?>',
      '  <p:item xmlns:p="urn:x" p:path="/3D/a.model"/>',
      '</config>',
    ].join('\n')
    const root = parseXml(xml)
    expect(root.name).toBe('config')
    expect(root.attrs.get('version')).toBe('2')
    expect(root.attrs.get('note')).toBe('a & b')
    expect(root.children.map((child) => child.name)).toEqual(['object', 'text', 'p:item'])
    expect(root.children[0]?.children[0]?.attrs.get('value')).toBe('Leg <6U>')
    expect(root.children[1]?.text).toBe('one & <two> & three')
    expect(root.children[2]?.attrs.get('p:path')).toBe('/3D/a.model')
  })

  it('reports self-closing elements with an immediate close', () => {
    const events: string[] = []
    tokenizeXml('<a><b x="1"/><c></c></a>', {
      open: (name, _attrs, selfClosing) => events.push(`open ${name}${selfClosing ? '/' : ''}`),
      close: (name) => events.push(`close ${name}`),
    })
    expect(events).toEqual(['open a', 'open b/', 'close b', 'open c', 'close c', 'close a'])
  })

  it.each([
    ['unclosed root', '<a><b></b>'],
    ['mismatched end tag', '<a><b></a></b>'],
    ['unquoted attribute', '<a x=1/>'],
    ['attribute without value', '<a x/>'],
    ['duplicate attribute', '<a x="1" x="2"/>'],
    ['< in attribute value', '<a x="<"/>'],
    ['missing whitespace between attributes', '<a x="1"y="2"/>'],
    ['unterminated comment', '<a><!-- x </a>'],
    ['unterminated tag', '<a><b x="1"'],
    ['text outside the root', 'junk<a/>'],
    ['two roots', '<a/><b/>'],
    ['no root', '   '],
    ['unknown entity', '<a>&bogus;</a>'],
  ])('throws xml-malformed for %s', (_label, xml) => {
    let error: unknown
    try {
      parseXml(xml)
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(ModelError)
    expect(error).toMatchObject({ code: 'xml-malformed' })
  })

  it('caps element nesting', () => {
    const deep = `${'<a>'.repeat(20)}${'</a>'.repeat(20)}`
    expect(() => parseXml(deep, 10)).toThrow(LimitExceededError)
    expect(parseXml(deep, 20).name).toBe('a')
  })
})

interface ScanResult {
  vertices: number[]
  triangles: number[]
  events: string[]
  texts: Record<string, string>
}

class RecordingHandler implements ModelXmlHandler {
  readonly result: ScanResult = { vertices: [], triangles: [], events: [], texts: {} }
  private lastName = ''

  open(name: string, attrs: XmlAttributes, selfClosing: boolean): void {
    this.result.events.push(`${name}${selfClosing ? '/' : ''}`)
    this.lastName = attrs.get('name') ?? name
  }

  close(name: string, text: string | undefined): void {
    if (text !== undefined) this.result.texts[this.lastName] = text
    this.result.events.push(`/${name}`)
  }

  vertex(x: number, y: number, z: number): void {
    this.result.vertices.push(x, y, z)
  }

  triangle(v1: number, v2: number, v3: number): void {
    this.result.triangles.push(v1, v2, v3)
  }
}

function scan(
  chunks: Uint8Array[],
  options: ModelXmlScannerOptions = { textElements: new Set(['metadata']) },
): ScanResult {
  const handler = new RecordingHandler()
  const scanner = new ModelXmlScanner(handler, options)
  for (const chunk of chunks) scanner.push(chunk)
  scanner.finish()
  return handler.result
}

const encode = (text: string): Uint8Array => new TextEncoder().encode(text)

const MODEL = [
  '﻿<?xml version="1.0" encoding="UTF-8"?>',
  '<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">',
  ' <metadata name="Title">Fuß &amp; Halter <![CDATA[<v2>]]></metadata>',
  ' <!-- comment <vertex x="9" y="9" z="9"/> -->',
  ' <resources><object id="1" type="model"><mesh>',
  '  <vertices>',
  '   <vertex x="1.5" y="-2" z="3e2"/>',
  "   <vertex z='6' x = '4.25E-1'\ty='+5'/>",
  '   <vertex\r\n x="-.5" y="7." z="8" foo="bar"></vertex>',
  '  </vertices>',
  '  <triangles>',
  '   <triangle v1="0" v2="1" v3="2"/>',
  '   <triangle paint_color="0C" v3="0" pid="1" v2="2" v1="1" p1="0"/>',
  '  </triangles>',
  ' </mesh></object></resources>',
  ' <build><item objectid="1"/></build>',
  '</model>',
].join('\n')

const EXPECTED_VERTICES = [1.5, -2, 300, 0.425, 5, 6, -0.5, 7, 8]
const EXPECTED_TRIANGLES = [0, 1, 2, 1, 2, 0]

describe('ModelXmlScanner', () => {
  it('reads vertices and triangles in any attribute order, skipping unknown attributes', () => {
    const result = scan([encode(MODEL)])
    expect(result.vertices).toEqual(EXPECTED_VERTICES)
    expect(result.triangles).toEqual(EXPECTED_TRIANGLES)
    expect(result.texts['Title']).toBe('Fuß & Halter <v2>')
    expect(result.events).toContain('item/')
    // Fast-path elements never reach open/close, and the commented-out vertex is ignored.
    const elementNames = result.events.map((event) => event.replace(/^\/|\/$/g, ''))
    expect(elementNames).toContain('vertices')
    expect(elementNames).not.toContain('vertex')
    expect(elementNames).not.toContain('triangle')
  })

  it('gives the same result for every two-chunk split', () => {
    const bytes = encode(MODEL)
    for (let split = 0; split <= bytes.length; split++) {
      const result = scan([bytes.subarray(0, split), bytes.subarray(split)])
      expect(result.vertices).toEqual(EXPECTED_VERTICES)
      expect(result.triangles).toEqual(EXPECTED_TRIANGLES)
      expect(result.texts['Title']).toBe('Fuß & Halter <v2>')
    }
  })

  it('gives the same result fed one byte at a time', () => {
    const bytes = encode(MODEL)
    const result = scan(Array.from(bytes, (_, i) => bytes.subarray(i, i + 1)))
    expect(result.vertices).toEqual(EXPECTED_VERTICES)
    expect(result.triangles).toEqual(EXPECTED_TRIANGLES)
  })

  test.prop([fc.array(fc.integer({ min: 1, max: 64 }), { minLength: 1, maxLength: 200 })])(
    'gives the same result for random chunk sizes',
    (sizes) => {
      const bytes = encode(MODEL)
      const chunks: Uint8Array[] = []
      let at = 0
      for (let i = 0; at < bytes.length; i++) {
        const size = sizes[i % sizes.length] ?? 1
        chunks.push(bytes.subarray(at, at + size))
        at += size
      }
      const result = scan(chunks)
      expect(result.vertices).toEqual(EXPECTED_VERTICES)
      expect(result.triangles).toEqual(EXPECTED_TRIANGLES)
    },
  )

  it('hands prefixed core elements to the handler instead of the fast path', () => {
    const result = scan([encode('<m:model xmlns:m="x"><m:vertex x="1" y="2" z="3"/></m:model>')])
    expect(result.vertices).toEqual([])
    expect(result.events).toEqual(['m:model', 'm:vertex/', '/m:vertex', '/m:model'])
  })

  it('pairs open and close events however an element was read', () => {
    // A root named "vertex" is a generic element; a non-self-closing vertex inside one is fast-path.
    const result = scan([encode('<vertex><vertex x="1" y="2" z="3"></vertex></vertex>')])
    expect(result.vertices).toEqual([1, 2, 3])
    expect(result.events).toEqual(['vertex', '/vertex'])
  })

  it.each([
    ['a vertex without z', '<model><vertex x="1" y="2"/></model>'],
    ['a non-numeric coordinate', '<model><vertex x="1" y="2" z="abc"/></model>'],
    ['a negative index', '<model><triangle v1="-1" v2="0" v3="1"/></model>'],
    ['a fractional index', '<model><triangle v1="1.5" v2="0" v3="1"/></model>'],
    ['an unquoted value', '<model><vertex x=1 y="2" z="3"/></model>'],
    ['a truncated document', '<model><vertex x="1" y="2" z="3"'],
    ['an unclosed element', '<model><resources>'],
    ['mismatched tags', '<model><a></b></model>'],
    ['text outside the root', '<model/>trailing'],
  ])('throws xml-malformed for %s', (_label, xml) => {
    expect(() => scan([encode(xml)])).toThrow(expect.objectContaining({ code: 'xml-malformed' }))
  })

  it('rejects UTF-16 input', () => {
    expect(() => scan([Uint8Array.of(0xff, 0xfe, 0x3c, 0x00)])).toThrow(ModelError)
  })

  it('caps the bytes buffered for one unfinished tag', () => {
    const huge = encode(`<model><item note="${'x'.repeat(5000)}"/></model>`)
    expect(() =>
      scan([huge.subarray(0, 3000), huge.subarray(3000)], { maxTokenBytes: 1024 }),
    ).toThrow(LimitExceededError)
    expect(scan([huge], { maxTokenBytes: 1024 }).events).toContain('item/')
  })

  it('caps nesting depth', () => {
    const deep = encode(`<model>${'<a>'.repeat(50)}${'</a>'.repeat(50)}</model>`)
    expect(() => scan([deep], { maxDepth: 20 })).toThrow(LimitExceededError)
  })
})
