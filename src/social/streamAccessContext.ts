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

  if (target.kind === 'world' || scene.source.kind === 'world') {
    // Same realm string as get-scene-adapter (commsPointer is already lowercased for worlds).
    // Do not use about.realmName mixed case (RickRoll.dcl.eth) — that mints a different LiveKit room.
    const realmName = (scene.commsPointer || target.pointer).trim().toLowerCase()
    const customServer =
      (route.kind === 'world' ? route.customServer : undefined) ||
      (scene.source.kind === 'world' ? scene.source.customServer : undefined)
    return {
      sceneId,
      parcel: '0,0',
      realmName,
      isWorld: true,
      isGuest,
      worldsContentHost: customServer ?? null,
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
