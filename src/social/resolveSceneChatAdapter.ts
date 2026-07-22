/**
 * Resolve a LiveKit adapter string for multi-room scene/world chat without connecting.
 * Worlds → signed-login (chat room). Parcels → gatekeeper get-scene-adapter.
 */
import type { AuthIdentity } from '@dcl/crypto/dist/types'
import type { ResolvedScene } from '../dcl/content/types'
import { resolveCommsSceneId } from '../network/catalyst/CatalystClient'
import { isParcelPointer, normalizePointer } from '../network/catalyst/pointer'
import { getSceneAdapter } from '../network/gatekeeper/GatekeeperClient'
import { isLiveKitAdapter } from '../network/comms/livekitAdapter'
import {
  gatekeeperParcelForComms,
  gatekeeperRealmNameForComms
} from '../network/sceneAccess/sceneAccessCommon'
import { fetchWorldCommsAdapter, parseRealmCommsAdapter } from '../network/worlds/WorldCommsClient'
import { clientDebugLog } from '../client/debug/ClientDebugLog'

export type ResolveChatAdapterResult =
  | { ok: true; adapter: string; isWorldChat: boolean }
  | { ok: false; reason: string }

export async function resolveSceneChatAdapter(
  scene: ResolvedScene,
  identity: AuthIdentity
): Promise<ResolveChatAdapterResult> {
  const isWorld = scene.source.kind === 'world'
  const pointer = scene.commsPointer
  const contentUrl = scene.realm.contentUrl.replace(/\/$/, '')

  if (isWorld) {
    // World server owner can run content-only (no LiveKit) — chat stays off, scene still loads.
    if (scene.realm.commsEnabled === false) {
      return { ok: false, reason: 'world_comms_disabled' }
    }
    const hint = scene.realm.commsAdapterHint?.trim()
    if (!hint) {
      return { ok: false, reason: 'world_comms_adapter_missing' }
    }
    const parsed = parseRealmCommsAdapter(hint)
    if (!parsed) {
      return { ok: false, reason: 'world_comms_adapter_unparsed' }
    }
    if (parsed.kind === 'livekit') {
      return { ok: true, adapter: parsed.adapter, isWorldChat: true }
    }
    if (parsed.kind === 'signed-login') {
      const result = await fetchWorldCommsAdapter(identity, parsed.url, contentUrl)
      if (!result.ok) {
        clientDebugLog.log('social', `Chat adapter signed-login failed: ${result.error}`, {
          level: 'warn'
        })
        return { ok: false, reason: result.error }
      }
      let adapter = result.adapter
      if (adapter.startsWith('fixed-adapter:')) adapter = adapter.slice('fixed-adapter:'.length)
      if (!isLiveKitAdapter(adapter)) {
        return { ok: false, reason: 'world_adapter_not_livekit' }
      }
      return { ok: true, adapter, isWorldChat: true }
    }
    // archipelago worlds are not used for named worlds chat
    return { ok: false, reason: `world_adapter_kind_${parsed.kind}` }
  }

  // Genesis / parcel scene room
  let sceneId = scene.entityId?.trim() || ''
  if (!sceneId) {
    sceneId = (await resolveCommsSceneId(pointer, contentUrl, null))?.trim() || ''
  }
  if (!sceneId) {
    return { ok: false, reason: 'scene_id' }
  }

  const target = {
    pointer,
    baseParcel: scene.baseParcel,
    realmName:
      scene.realm.realmName?.trim() ||
      (isParcelPointer(normalizePointer(pointer)) ? 'main' : pointer.trim().toLowerCase())
  }
  const realmName = gatekeeperRealmNameForComms(target)
  const parcel = gatekeeperParcelForComms(target)

  const adapterResult = await getSceneAdapter(identity, {
    sceneId,
    parcel,
    realmName,
    isWorld: false
  })
  if (!adapterResult.ok) {
    clientDebugLog.log('social', `Chat adapter gatekeeper failed: ${adapterResult.error}`, {
      level: 'warn'
    })
    return { ok: false, reason: adapterResult.error }
  }
  if (!isLiveKitAdapter(adapterResult.adapter)) {
    return { ok: false, reason: 'scene_adapter_not_livekit' }
  }
  return { ok: true, adapter: adapterResult.adapter, isWorldChat: false }
}
