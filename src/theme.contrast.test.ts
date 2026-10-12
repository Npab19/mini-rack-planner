/**
 * WCAG contrast of the colour tokens in src/index.css, in both themes and every accent: text
 * pairs need 4.5:1, outlines, focus rings and other meaningful graphics 3:1. The token blocks are
 * read as the browser would cascade them (:root, then .dark, then the accent's light and dark
 * blocks), var() references are resolved and oklch() is converted to sRGB.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ACCENTS, DEFAULT_ACCENT, type AccentPreference } from '@/lib/theme'

const css = readFileSync(new URL('./index.css', import.meta.url), 'utf8')

/** Declarations of every block whose selector is exactly `selector`, in source order. */
function declarations(selector: string): Map<string, string> {
  const found = new Map<string, string>()
  const source = css.replace(/\/\*[\s\S]*?\*\//g, '')
  // Innermost blocks only: nested at-rules (@theme, @layer) never match a plain selector.
  for (const [, head = '', body = ''] of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (head.replace(/\s+/g, ' ').trim() !== selector) continue
    for (const declaration of body.split(';')) {
      const colon = declaration.indexOf(':')
      const name = declaration.slice(0, colon).trim()
      if (colon > 0 && name.startsWith('--')) found.set(name, declaration.slice(colon + 1).trim())
    }
  }
  return found
}

type Theme = 'light' | 'dark'

function tokens(theme: Theme, accent: AccentPreference): Map<string, string> {
  const selectors = [':root']
  if (theme === 'dark') selectors.push('.dark')
  if (accent !== DEFAULT_ACCENT) {
    selectors.push(`:root[data-accent='${accent}']`)
    if (theme === 'dark') selectors.push(`:root.dark[data-accent='${accent}']`)
  }
  const merged = new Map<string, string>()
  for (const selector of selectors) {
    const block = declarations(selector)
    if (block.size === 0) throw new Error(`index.css has no ${selector} block`)
    for (const [name, value] of block) merged.set(name, value)
  }
  return merged
}

/** An sRGB colour, channels 0..1 in gamma space, with alpha. */
type Rgba = { rgb: [number, number, number]; alpha: number }

function oklchToRgba(text: string): Rgba {
  const match = /^oklch\(\s*([\d.]+)(%?)\s+([\d.]+)\s+([\d.]+)\s*(?:\/\s*([\d.]+)(%?))?\s*\)$/.exec(
    text,
  )
  if (!match) throw new Error(`not an oklch() colour: ${text}`)
  const [, l = '', lPercent, c = '', h = '', a, aPercent] = match
  const L = Number(l) / (lPercent ? 100 : 1)
  const C = Number(c)
  const H = (Number(h) * Math.PI) / 180
  const alpha = a === undefined ? 1 : Number(a) / (aPercent ? 100 : 1)
  const okA = C * Math.cos(H)
  const okB = C * Math.sin(H)
  const lms = [
    (L + 0.3963377774 * okA + 0.2158037573 * okB) ** 3,
    (L - 0.1055613458 * okA - 0.0638541728 * okB) ** 3,
    (L - 0.0894841775 * okA - 1.291485548 * okB) ** 3,
  ] as const
  const linear = [
    4.0767416621 * lms[0] - 3.3077115913 * lms[1] + 0.2309699292 * lms[2],
    -1.2684380046 * lms[0] + 2.6097574011 * lms[1] - 0.3413193965 * lms[2],
    -0.0041960863 * lms[0] - 0.7034186147 * lms[1] + 1.707614701 * lms[2],
  ]
  const [r = 0, g = 0, b = 0] = linear.map((v) => {
    const x = Math.min(1, Math.max(0, v))
    return x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055
  })
  return { rgb: [r, g, b], alpha }
}

/** `top` painted over an opaque `bottom` (browsers blend in gamma space). */
function over(top: Rgba, bottom: Rgba): Rgba {
  const [r, g, b] = top.rgb.map((v, i) => v * top.alpha + bottom.rgb[i]! * (1 - top.alpha))
  return { rgb: [r!, g!, b!], alpha: 1 }
}

function luminance({ rgb }: Rgba): number {
  const [r = 0, g = 0, b = 0] = rgb.map((v) =>
    v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4,
  )
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrast(a: Rgba, b: Rgba): number {
  const [la, lb] = [luminance(a), luminance(b)]
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/** A token name, optionally with a Tailwind-style opacity (`destructive/10`) painted over `on`. */
type Paint = string | { token: string; opacity: number; on: string }

function paintName(paint: Paint): string {
  return typeof paint === 'string'
    ? paint
    : `${paint.token}/${paint.opacity * 100} over ${paint.on}`
}

type Pair = [fg: Paint, bg: Paint, min: number]

const TEXT = 4.5
const GRAPHIC = 3
const ROLES = ['compute', 'storage', 'network', 'power', 'neutral'] as const
const STATUSES = ['have', 'need', 'warning', 'info'] as const

function pairs(theme: Theme): Pair[] {
  const list: Pair[] = [
    ['foreground', 'background', TEXT],
    ['card-foreground', 'card', TEXT],
    ['popover-foreground', 'popover', TEXT],
    ['muted-foreground', 'background', TEXT],
    ['muted-foreground', 'muted', TEXT],
    ['muted-foreground', 'card', TEXT],
    ['secondary-foreground', 'secondary', TEXT],
    ['primary-foreground', 'primary', TEXT],
    ['primary', 'background', TEXT],
    ['primary', 'card', TEXT],
    ['accent-foreground', 'accent', TEXT],
    ['sidebar-foreground', 'sidebar', TEXT],
    ['sidebar-primary-foreground', 'sidebar-primary', TEXT],
    ['sidebar-accent-foreground', 'sidebar-accent', TEXT],
    ['destructive', 'background', TEXT],
    ['destructive', 'destructive-soft', TEXT],
    // Destructive buttons, badges and menu items: bg-destructive/10, dark:bg-destructive/20.
    ...(['background', 'card'] as const).map((on): Pair => [
      'destructive',
      { token: 'destructive', opacity: theme === 'dark' ? 0.2 : 0.1, on },
      TEXT,
    ]),
    ['ring', 'background', GRAPHIC],
    ['ring', 'card', GRAPHIC],
    ['rack-label', 'rack-inner', TEXT],
    ['rack-label', { token: 'rack-inner-alt', opacity: 1, on: 'rack-inner' }, TEXT],
    ['rack-rail', 'rack-inner', GRAPHIC],
  ]
  for (const status of STATUSES) {
    list.push(
      [status, 'background', TEXT],
      [status, 'card', TEXT],
      [status, `${status}-soft`, TEXT],
      [`${status}-foreground`, status, TEXT],
      [`${status}-border`, 'background', GRAPHIC],
      [`${status}-border`, 'card', GRAPHIC],
    )
  }
  for (const role of ROLES) {
    const stroke = `role-${role}`
    list.push(
      [stroke, 'rack-inner', GRAPHIC],
      [stroke, `${stroke}-fill`, GRAPHIC],
      ['foreground', `${stroke}-fill`, TEXT],
      ['foreground', `${stroke}-strong`, TEXT],
      ['foreground', `${stroke}-soft`, TEXT],
    )
  }
  return list
}

describe.each(['light', 'dark'] as const)('%s theme', (theme) => {
  it.each(ACCENTS.map(({ id }) => id))('%s accent meets the contrast bar', (accent) => {
    const values = tokens(theme, accent)
    const resolve = (name: string, seen: string[] = []): Rgba => {
      const value = values.get(`--${name}`)
      if (value === undefined) throw new Error(`${theme} ${accent}: --${name} is not defined`)
      const reference = /^var\(--([\w-]+)\)$/.exec(value)?.[1]
      if (reference === undefined) return oklchToRgba(value)
      if (seen.includes(reference)) throw new Error(`--${name} refers to itself`)
      return resolve(reference, [...seen, name])
    }
    const paint = (p: Paint): Rgba => {
      if (typeof p === 'string') {
        // Translucent tokens are always drawn on the page background.
        const colour = resolve(p)
        return colour.alpha < 1 ? over(colour, resolve('background')) : colour
      }
      const base = resolve(p.token)
      const below = resolve(p.on)
      return over({ ...base, alpha: base.alpha * p.opacity }, below)
    }

    const failures = pairs(theme).flatMap(([fg, bg, min]) => {
      const ratio = contrast(paint(fg), paint(bg))
      return ratio >= min
        ? []
        : [
            `${theme} ${accent}: ${paintName(fg)} on ${paintName(bg)} is ${ratio.toFixed(2)}:1, needs ${min}:1`,
          ]
    })
    expect(failures).toEqual([])
  })
})
