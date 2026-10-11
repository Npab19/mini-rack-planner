/**
 * PrusaSlicer project files inside a 3MF (common on Printables).
 *
 * PrusaSlicer merges every volume of an object (parts, modifiers, negative volumes, support
 * blockers/enforcers) into that object's single mesh. `Metadata/Slic3r_PE_model.config` records
 * which triangle range belongs to which volume, so modifiers can be left out like Bambu's.
 */

import { parseIntegerString } from './numbers'
import { childElements, type XmlElement } from './xml'

export const PRUSA_MODEL_PART = 'ModelPart'

export interface PrusaVolume {
  /** Inclusive triangle index range within the object's mesh. */
  firstTriangle: number
  lastTriangle: number
  /** ModelPart, NegativeVolume, ParameterModifier, SupportBlocker or SupportEnforcer. */
  type: string
  name?: string
}

/** `<metadata type="volume" key="k" value="v"/>` children. */
function volumeMetadata(element: XmlElement, key: string): string | undefined {
  const match = childElements(element, 'metadata').find((child) => child.attrs.get('key') === key)
  return match?.attrs.get('value')
}

function parseVolume(element: XmlElement): PrusaVolume | undefined {
  const firstTriangle = parseIntegerString(element.attrs.get('firstid'))
  const lastTriangle = parseIntegerString(element.attrs.get('lastid'))
  if (firstTriangle === undefined || lastTriangle === undefined || lastTriangle < firstTriangle)
    return undefined
  // Files from before volume_type existed only flag modifiers.
  const legacyModifier = volumeMetadata(element, 'modifier') === '1'
  const type =
    volumeMetadata(element, 'volume_type') ??
    (legacyModifier ? 'ParameterModifier' : PRUSA_MODEL_PART)
  return { firstTriangle, lastTriangle, type, name: volumeMetadata(element, 'name') }
}

/** Root element of `Metadata/Slic3r_PE_model.config`: volumes per root object id. */
export function parsePrusaModelConfig(root: XmlElement): Map<number, PrusaVolume[]> {
  const volumes = new Map<number, PrusaVolume[]>()
  for (const object of childElements(root, 'object')) {
    const id = parseIntegerString(object.attrs.get('id'))
    if (id === undefined) continue
    volumes.set(
      id,
      childElements(object, 'volume').flatMap((element) => parseVolume(element) ?? []),
    )
  }
  return volumes
}
