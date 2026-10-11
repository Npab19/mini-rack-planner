/**
 * Backward compatibility: every build must still open what earlier versions wrote.
 *
 * - `fixtures/compat/v<schema>/*.plan.json`: plans as stored or exported (migrate + validate).
 * - `fixtures/compat/v<schema>/share-links.json`: share links ("p=<codec>.…") by name.
 * - `fixtures/compat/v<schema>/plan.schema.json`: the JSON Schema of `PlanSchema` at that version.
 *
 * These files are frozen. A change to `PlanSchema` fails the snapshot test below: bump
 * `PLAN_SCHEMA_VERSION`, add the migration step in migrate.ts and a new `v<n>` folder with fixtures
 * written by the new version; the new snapshot is then written on the next local run. If only
 * zod's JSON Schema output changed (a zod upgrade), review the diff and regenerate it with
 * `npx vitest run src/domain/compat.test.ts -u`.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { migratePlan } from './migrate'
import { ConditionSchema } from './schema/common'
import { PLAN_SCHEMA_VERSION, PlanSchema, type Plan } from './schema/plan'
import { decodeShare } from './share'

const COMPAT_DIR = fileURLToPath(new URL('../../fixtures/compat/', import.meta.url))
const SAMPLE = 'kws-sample-12u'

const ShareLinksSchema = z.record(z.string(), z.string())

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function versionDirs(): string[] {
  return readdirSync(COMPAT_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^v\d+$/.test(entry.name))
    .map((entry) => entry.name)
}

function planFiles(): string[] {
  return versionDirs().flatMap((dir) =>
    readdirSync(join(COMPAT_DIR, dir))
      .filter((name) => name.endsWith('.plan.json'))
      .map((name) => `${dir}/${name}`),
  )
}

function shareLinks(): Array<[string, string]> {
  return versionDirs().flatMap((dir) => {
    const links = ShareLinksSchema.parse(readJson(join(COMPAT_DIR, dir, 'share-links.json')))
    return Object.entries(links).map(([name, link]): [string, string] => [`${dir}/${name}`, link])
  })
}

function owned(plan: Plan): { sections: number; placements: number; retired: number } {
  return {
    sections: plan.frame.sections.filter((section) => section.have !== undefined).length,
    placements: plan.placements.filter((placement) => placement.have !== undefined).length,
    retired: plan.retired.length,
  }
}

describe('compat fixtures', () => {
  it('cover the current plan schema', () => {
    expect(versionDirs()).toContain(`v${PLAN_SCHEMA_VERSION}`)
    expect(planFiles().length).toBeGreaterThan(0)
    expect(shareLinks().length).toBeGreaterThan(0)
  })

  it.each(planFiles())('opens the plan %s', (path) => {
    const { plan } = migratePlan(readJson(join(COMPAT_DIR, path)))
    expect(plan.schema).toBe(PLAN_SCHEMA_VERSION)
    expect(plan.frame.sections.length).toBeGreaterThan(0)
  })

  it('keeps the v1 12U sample as it was stored', () => {
    const { plan, warnings } = migratePlan(readJson(join(COMPAT_DIR, `v1/${SAMPLE}.plan.json`)))
    expect(warnings).toEqual([])
    expect(plan.name).toBe('KWS 9U → 12U')
    expect(plan.frame.sections.map((section) => section.typeId)).toEqual(['s3', 's6', 's3'])
    expect(plan.placements).toHaveLength(6)
    expect(plan.placements.flatMap((placement) => placement.devices)).toHaveLength(5)
    expect(plan.equipment).toHaveLength(2)
    expect(plan.custom.devices.map((device) => device.id)).toEqual(['custom:diy-n100-nas'])
    expect(owned(plan)).toEqual({ sections: 2, placements: 5, retired: 1 })
  })

  it.each(shareLinks())('opens the share link %s', async (name, link) => {
    const { plan, mode } = await decodeShare(link)
    expect(mode).toBe(name.endsWith('.showoff') ? 'showoff' : 'template')
    expect(plan.schema).toBe(PLAN_SCHEMA_VERSION)
    expect(plan.frame.sections.length).toBeGreaterThan(0)
  })

  it('keeps ownership in the v1 show-off link and none in the template link', async () => {
    const links = ShareLinksSchema.parse(readJson(join(COMPAT_DIR, 'v1/share-links.json')))
    const showoff = await decodeShare(links[`${SAMPLE}.showoff`] ?? '')
    const template = await decodeShare(links[`${SAMPLE}.template`] ?? '')
    expect(owned(showoff.plan)).toEqual({ sections: 2, placements: 5, retired: 1 })
    expect(owned(template.plan)).toEqual({ sections: 0, placements: 0, retired: 0 })
    expect(template.plan.placements).toHaveLength(6)
  })
})

describe('plan JSON Schema', () => {
  it('changes only together with a schema version bump', async () => {
    // Named like the catalog schemas (scripts/validate-catalog.ts), instead of a generated id.
    const metadata = z.registry<{ id: string }>()
    metadata.add(ConditionSchema, { id: 'Condition' })
    const schema = z.toJSONSchema(PlanSchema, { io: 'input', metadata })
    await expect(`${JSON.stringify(schema, null, 2)}\n`).toMatchFileSnapshot(
      `../../fixtures/compat/v${PLAN_SCHEMA_VERSION}/plan.schema.json`,
    )
  })
})
