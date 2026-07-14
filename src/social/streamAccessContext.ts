/**
 * Resolve gatekeeper kernel params for scene-stream-access from a landing route.
 */
import type { RouteTarget } from '../dcl/content/route'
import { resolveSceneFromRoute } from '../dcl/content/resolveScene'
import type { SceneStreamAccessParams } from '../network/gatekeeper/sceneStreamAccess'
import { sceneStreamTargetFromRoute } from './sceneStreams'

export type ResolvedStreamAccessContext = SceneStreamAccessParams & {
  pointer: string
  kind: 'world' | 'parcel'
}

export async function resolveStreamAccessContext(
  route: Extract<RouteTarget, { kind: 'coords' } | { kind: 'world' }>,
  opts?: { isGuest?: boolean }
): Promise<ResolvedStreamAccessContext> {
  const target = sceneStreamTargetFromRoute(route)
  const scene = await resolveSceneFromRoute(route)
  const sceneId = scene.entityId?.trim()
  if (!sceneId) {
    throw new Error('scene_not_found_for_pointer')
  }
  const isGuest = opts?.isGuest === true

  if (target.kind === 'world') {
    const realmName = target.pointer.trim().toLowerCase()
    return {
      sceneId,
      parcel: '0,0',
      realmName,
      isWorld: true,
      isGuest,
      pointer: realmName,
      kind: 'world'
    }
  }

  return {
    sceneId,
    parcel: target.pointer,
    realmName: 'main',
    isWorld: false,
    isGuest,
    pointer: target.pointer,
    kind: 'parcel'
  }
}
