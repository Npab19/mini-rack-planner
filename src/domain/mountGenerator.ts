/**
 * "Needs a mount?" (M3b): the parameters to type into popular parametric generators on
 * MakerWorld for a device that has no mount in the catalog. Text and a link only: the app never
 * contacts MakerWorld. Every generator fact here (name, designer, link, licence label, parameter
 * names) was entered by people from the public model pages; nothing is fetched.
 *
 * - `suggestedMountSixths`: the device's height + 6 mm of clearance, rounded up to the frame's
 *   usual mount step (whole U, or half U on rails with several holes per U).
 * - `generatorSuggestions`: one parameter set per generator, sized for the device (each dimension
 *   + `GENERATOR_TOLERANCE_MM`), with the rack height that generator will produce.
 * - `generatorParamsText`: a parameter set as copyable text.
 * - `mountWarnings`: plain-language reasons a mount for the device will be hard on this frame.
 */
import { ESTIMATE_CLEARANCE_MM } from './devices'
import { mmToSixthsCeil, SIXTHS_PER_U } from './geometry'
import { deviceName, type Device, type Frame } from './schema/catalog'
import type { Thread } from './schema/common'

/** Room above the device inside its mount: the same 6 mm as the tray's U estimates. */
export const MOUNT_CLEARANCE_MM = ESTIMATE_CLEARANCE_MM
/** Added to each device dimension for a generator's cutout: printed parts run a little tight. */
export const GENERATOR_TOLERANCE_MM = 2
/** Half a U, in sixths. */
export const HALF_U_SIXTHS = SIXTHS_PER_U / 2
/** "Fully Parametric Server/Network Device Rack Mount" makes 1U to 8U mounts. */
export const MERKLE_MAX_U = 8

const PANEL_10_INCH_MM = 254
const PANEL_6_INCH_MM = 152.4
const MM_PER_INCH = 25.4

export interface GeneratorParam {
  /** The generator's own parameter name, e.g. "component_width". */
  name: string
  /** Plain-language label, e.g. "Device width". */
  label: string
  value: string
}

export interface GeneratorSuggestion {
  id: string
  name: string
  designer: string
  url: string
  license?: string
  /** What the generator makes, one short sentence. */
  summary: string
  params: GeneratorParam[]
  /** The rack height it will produce, in sixths. */
  heightSixths: number
  /** Where the generator's own source code lives, when it is published separately. */
  sourceCode?: { url: string; license: string; label: string }
  /** Plain-language notes on the parameter values (e.g. which hole size was picked and why). */
  notes?: string[]
}

// ---------------------------------------------------------------------------------------------
// Heights

/**
 * The step mount heights come in on this frame: half a U on rails with several holes per U (the
 * EIA pattern has 3, so ears can land on a hole every half U), else a whole U.
 */
export function mountStepSixths(frame: Frame): number {
  return frame.rail.holeOffsetsPerUMm.length > 1 ? HALF_U_SIXTHS : SIXTHS_PER_U
}

/** Suggested rack height for the device (clearance + the frame's usual steps), in sixths. */
export function suggestedMountSixths(device: Device, frame: Frame): number {
  const step = mountStepSixths(frame)
  const needed = mmToSixthsCeil(device.dims.h + MOUNT_CLEARANCE_MM)
  return Math.max(step, Math.ceil(needed / step) * step)
}

/** A height in sixths rounded up to whole U, in sixths. */
function wholeUSixths(sixths: number): number {
  return Math.max(1, Math.ceil(sixths / SIXTHS_PER_U)) * SIXTHS_PER_U
}

// ---------------------------------------------------------------------------------------------
// Formatting

/** 34.5 -> "34.5", 36 -> "36" (one decimal at most). */
function mm(value: number): string {
  return String(Math.round(value * 10) / 10)
}

/** 9 sixths -> "1.5", 12 -> "2" (in U). */
function uText(sixths: number): string {
  return String(Math.round((sixths / SIXTHS_PER_U) * 100) / 100)
}

function withTolerance(value: number): string {
  return mm(value + GENERATOR_TOLERANCE_MM)
}

/** The nominal rack width the generators know (10" = 254 mm, 6" = 152.4 mm) nearest the frame's. */
function nominalPanelWidthMm(frame: Frame): number {
  const width = frame.standard.panelWidthMm
  return Math.abs(width - PANEL_6_INCH_MM) < Math.abs(width - PANEL_10_INCH_MM)
    ? PANEL_6_INCH_MM
    : PANEL_10_INCH_MM
}

/** Ear holes for the frame's screws: M6 holes pass M5/M6/12-24 screws, 10-32 holes the smaller. */
function railHoleChoice(thread: Thread): { value: 'M6' | '10-32'; note?: string } {
  switch (thread) {
    case 'M6':
      return { value: 'M6' }
    case '10-32':
      return { value: '10-32' }
    case 'M5':
    case '12-24':
      return {
        value: 'M6',
        note: `Your frame takes ${thread} screws: M6 holes let them through.`,
      }
    case 'M3':
    case 'M4':
      return {
        value: '10-32',
        note: `Your frame takes ${thread} screws: the smaller 10-32 holes let them through.`,
      }
  }
}

// ---------------------------------------------------------------------------------------------
// Generators

function spuder(device: Device, frame: Frame): GeneratorSuggestion {
  const heightSixths = suggestedMountSixths(device, frame)
  const width = nominalPanelWidthMm(frame)
  return {
    id: 'spuder-10-inch-rack',
    name: '10 Inch Mini Rack Generator',
    designer: 'spuder',
    url: 'https://makerworld.com/en/models/1765102',
    license: 'Standard Digital File License',
    summary: 'A mount for one device in half-U steps; keystone ports and air holes are optional.',
    heightSixths,
    params: [
      {
        name: 'rack_width',
        label: width === PANEL_6_INCH_MM ? 'Rack width (6-inch)' : 'Rack width (10-inch)',
        value: mm(width),
      },
      { name: 'rack_height', label: 'Rack height in U (steps of 0.5)', value: uText(heightSixths) },
      {
        name: 'component_width',
        label: `Device width + ${GENERATOR_TOLERANCE_MM} mm`,
        value: withTolerance(device.dims.w),
      },
      {
        name: 'component_height',
        label: `Device height + ${GENERATOR_TOLERANCE_MM} mm`,
        value: withTolerance(device.dims.h),
      },
      {
        name: 'component_depth',
        label: `Device depth + ${GENERATOR_TOLERANCE_MM} mm`,
        value: withTolerance(device.dims.d),
      },
      { name: 'air_holes', label: 'Air holes (optional)', value: 'true' },
    ],
    sourceCode: {
      url: 'https://github.com/spuder/10-Inch-Rack-OpenSCAD',
      license: 'MIT',
      label: 'OpenSCAD source on GitHub (spuder/10-Inch-Rack-OpenSCAD)',
    },
  }
}

function kellerLab(device: Device, frame: Frame): GeneratorSuggestion {
  const heightSixths = wholeUSixths(suggestedMountSixths(device, frame))
  const inches = Math.round(nominalPanelWidthMm(frame) / MM_PER_INCH)
  return {
    id: 'kellerlab-unimount',
    name: 'Customizable Rackmount [ANY RACKSIZE]',
    designer: 'KellerLab',
    url: 'https://makerworld.com/en/models/2128492',
    license: 'Standard Digital File License',
    summary: 'The "unimount": a mount for any rack size, set by the device’s size.',
    heightSixths,
    params: [
      {
        name: 'device width',
        label: `Device width + ${GENERATOR_TOLERANCE_MM} mm`,
        value: withTolerance(device.dims.w),
      },
      {
        name: 'device height',
        label: `Device height + ${GENERATOR_TOLERANCE_MM} mm`,
        value: withTolerance(device.dims.h),
      },
      {
        name: 'device depth',
        label: `Device depth + ${GENERATOR_TOLERANCE_MM} mm`,
        value: withTolerance(device.dims.d),
      },
      { name: 'rack size', label: 'Rack size', value: `${inches}in` },
      { name: 'U', label: 'Rack height in whole U', value: uText(heightSixths) },
    ],
  }
}

function merkle(device: Device, frame: Frame): GeneratorSuggestion | undefined {
  const heightSixths = wholeUSixths(suggestedMountSixths(device, frame))
  if (heightSixths > MERKLE_MAX_U * SIXTHS_PER_U) return undefined
  const holes = railHoleChoice(frame.equipmentFastener.thread)
  return {
    id: 'merkle-parametric-mount',
    name: 'Fully Parametric Server/Network Device Rack Mount',
    designer: 'Clayton Merkle',
    url: 'https://makerworld.com/en/models/1488064',
    license: 'Standard Digital File License',
    summary: `A 1U to ${MERKLE_MAX_U}U mount with a cutout for the device and a shelf.`,
    heightSixths,
    params: [
      { name: 'rack units', label: 'Rack height in whole U (1 to 8)', value: uText(heightSixths) },
      { name: 'rail holes', label: 'Rail holes (M6 or 10-32)', value: holes.value },
      {
        name: 'device cutout width',
        label: `Device width + ${GENERATOR_TOLERANCE_MM} mm`,
        value: withTolerance(device.dims.w),
      },
      {
        name: 'device cutout height',
        label: `Device height + ${GENERATOR_TOLERANCE_MM} mm`,
        value: withTolerance(device.dims.h),
      },
      {
        name: 'shelf depth',
        label: `Device depth + ${GENERATOR_TOLERANCE_MM} mm`,
        value: withTolerance(device.dims.d),
      },
    ],
    ...(holes.note === undefined ? {} : { notes: [holes.note] }),
  }
}

/**
 * Parameter sets for three popular parametric mount generators on MakerWorld, sized for the
 * device on this frame: spuder's "10 Inch Mini Rack Generator" (half-U steps), KellerLab's
 * "Customizable Rackmount [ANY RACKSIZE]" and Clayton Merkle's "Fully Parametric Server/Network
 * Device Rack Mount" (whole U, up to 8U: left out for taller devices). Facts and links only.
 */
export function generatorSuggestions(device: Device, frame: Frame): GeneratorSuggestion[] {
  const suggestions = [spuder(device, frame), kellerLab(device, frame), merkle(device, frame)]
  return suggestions.filter((suggestion) => suggestion !== undefined)
}

/** A parameter set as text to paste or keep: a title line, then one `name = value` per line. */
export function generatorParamsText(suggestion: GeneratorSuggestion): string {
  const lines = suggestion.params.map((param) => `${param.name} = ${param.value}`)
  return [`${suggestion.name} (${suggestion.designer})`, ...lines].join('\n')
}

// ---------------------------------------------------------------------------------------------
// Warnings

export interface MountSpace {
  /** Opening between the rails (after rack options), mm. */
  innerWidthMm: number
  /** Rack depth (after rack options), mm. */
  depthMm: number
}

/**
 * Why a mount for the device may be hard on this frame: wider than the opening between the
 * rails, or deeper than the rack. Pass the size after rack options (`effectiveFrameSize`) when a
 * plan is open; the frame's standard size otherwise.
 */
export function mountWarnings(device: Device, frame: Frame, space?: MountSpace): string[] {
  const innerWidthMm = space?.innerWidthMm ?? frame.standard.innerWidthMm
  const depthMm = space?.depthMm ?? frame.standard.depthMm
  const name = deviceName(device)
  const warnings: string[] = []
  if (device.dims.w > innerWidthMm) {
    warnings.push(
      `The ${name} is ${mm(device.dims.w)} mm wide, wider than the ${mm(innerWidthMm)} mm opening of the ${frame.name}: it would have to stand on its side.`,
    )
  }
  if (device.dims.d > depthMm) {
    warnings.push(
      `The ${name} is ${mm(device.dims.d)} mm deep, deeper than the ${frame.name} (${mm(depthMm)} mm): it would stick out at the back.`,
    )
  }
  return warnings
}
