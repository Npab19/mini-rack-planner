import { describe, expect, it } from 'vitest'
import { parsePrusaModelConfig } from './prusa'
import { parseXml } from './xml'

describe('parsePrusaModelConfig', () => {
  it('reads volume triangle ranges and types per object, including legacy modifier flags', () => {
    const volumes = parsePrusaModelConfig(
      parseXml(`<config>
        <object id="3">
          <volume firstid="0" lastid="99">
            <metadata type="volume" key="name" value="Body"/>
            <metadata type="volume" key="volume_type" value="ModelPart"/>
          </volume>
          <volume firstid="100" lastid="111"><metadata type="volume" key="modifier" value="1"/></volume>
          <volume firstid="112" lastid="123"/>
          <volume firstid="9" lastid="2"/>
        </object>
        <object><volume firstid="0" lastid="1"/></object>
      </config>`),
    )
    expect([...volumes.keys()]).toEqual([3])
    expect(volumes.get(3)).toEqual([
      { firstTriangle: 0, lastTriangle: 99, type: 'ModelPart', name: 'Body' },
      { firstTriangle: 100, lastTriangle: 111, type: 'ParameterModifier', name: undefined },
      { firstTriangle: 112, lastTriangle: 123, type: 'ModelPart', name: undefined },
    ])
  })
})
