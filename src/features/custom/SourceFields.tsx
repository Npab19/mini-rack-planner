/**
 * "Where it is from": the page link (kept as an Open page link, never fetched), the designer and
 * licence as the page shows them (designs only), and how the numbers were checked.
 */
import { useId } from 'react'
import { parseSourceLink } from '@/domain/customParts'
import type { VerifyMethod } from '@/domain/schema/common'
import { FieldGroup, SelectField, TextField } from './fields'
import type { FormView } from './formView'
import { VERIFY_CHOICES } from './partForms'

export interface SourcePatch {
  link?: string
  checked?: VerifyMethod
  designer?: string
  license?: string
}

const PLATFORM_NAMES: Readonly<Record<string, string>> = {
  makerworld: 'MakerWorld',
  printables: 'Printables',
  thingiverse: 'Thingiverse',
  github: 'GitHub',
}

/** "MakerWorld model 1945283, print profile 2087424" for a recognised link. */
export function linkSummary(text: string): string | undefined {
  const link = parseSourceLink(text)
  if (link === undefined) return undefined
  const platform = PLATFORM_NAMES[link.platform]
  if (link.modelId !== undefined) {
    const profile = link.profileId === undefined ? '' : `, print profile ${link.profileId}`
    return `${platform ?? 'Page'} model ${link.modelId}${profile}.`
  }
  return platform === undefined ? undefined : `A ${platform} page.`
}

export function SourceFields({
  link,
  checked,
  credits,
  onChange,
  view,
  linkHint,
}: {
  link: string
  checked: VerifyMethod
  /** Designer and licence (printed designs). */
  credits?: { designer: string; license: string }
  onChange: (patch: SourcePatch) => void
  view: FormView
  linkHint: string
}) {
  const base = useId()
  const field = (name: string) => ({ id: `${base}-${name}`, field: name, ...view.state(name) })
  const summary = linkSummary(link)
  return (
    <FieldGroup title="Where it is from">
      <TextField
        {...field('link')}
        label="Link to its page (optional)"
        hint={summary === undefined ? linkHint : `${summary} ${linkHint}`}
        value={link}
        onValue={(next) => onChange({ link: next })}
        onDone={() => view.done('link')}
        inputProps={{
          type: 'url',
          inputMode: 'url',
          spellCheck: false,
          autoCapitalize: 'none',
          placeholder: 'https://',
        }}
      />
      {credits === undefined ? null : (
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField
            {...field('designer')}
            label="Designer (optional)"
            hint="As the page shows it."
            value={credits.designer}
            onValue={(designer) => onChange({ designer })}
            onDone={() => view.done('designer')}
          />
          <TextField
            {...field('license')}
            label="Licence (optional)"
            hint="Copied exactly, like “Standard Digital File License”."
            value={credits.license}
            onValue={(license) => onChange({ license })}
            onDone={() => view.done('license')}
          />
        </div>
      )}
      <SelectField
        {...field('checked')}
        label="How were these numbers checked?"
        value={checked}
        choices={VERIFY_CHOICES}
        onValue={(next) => onChange({ checked: next })}
        className="sm:max-w-80"
      />
    </FieldGroup>
  )
}
