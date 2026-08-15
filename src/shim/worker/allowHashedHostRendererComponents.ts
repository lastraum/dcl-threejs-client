import { componentNumberFromName } from '@dcl/ecs/dist/components/component-number'

/**
 * Official `@dcl/sdk` rendererTransport.filter drops componentId > 2048
 * (hashed `defineComponent` names). Unity never needs them.
 *
 * This client reads `core-schema::Tags` (VFX contract) and `core-schema::Name`
 * (entity labels) on the host. Let those two through; leave other custom ids
 * filtered (asset-pack Triggers stay worker-only).
 */
const HOST_HASHED_RENDERER_IDS = new Set<number>([
  componentNumberFromName('core-schema::Tags'),
  componentNumberFromName('core-schema::Name')
])

function isHashedHostRendererMessage(message: unknown): boolean {
  if (!message || typeof message !== 'object') return false
  const id = (message as { componentId?: unknown }).componentId
  return typeof id === 'number' && HOST_HASHED_RENDERER_IDS.has(id >>> 0)
}

export function allowHashedHostRendererComponents(transport: {
  filter?: unknown
}): void {
  const t = transport as {
    filter?: (message: unknown) => boolean
    __tjsHashedHostFilter?: boolean
  }
  if (!t || typeof t.filter !== 'function' || t.__tjsHashedHostFilter) return
  t.__tjsHashedHostFilter = true
  const orig = t.filter.bind(t)
  t.filter = (message: unknown) => {
    if (isHashedHostRendererMessage(message)) return true
    return orig(message)
  }
}
