import { useParams } from 'react-router'
import { PagePlaceholder } from '@/components/common/PagePlaceholder'

export function EditorPage() {
  const { planId } = useParams()
  return (
    <PagePlaceholder title="Rack editor" milestone="M3a">
      <p className="text-sm">Plan: {planId}</p>
    </PagePlaceholder>
  )
}
