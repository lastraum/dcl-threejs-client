import type { LoginResult } from '../../auth/AuthClient'
import type { ResolvedScene } from '../../dcl/content/types'
import { resolveCommsSceneId } from '../catalyst/CatalystClient'
import { clientDebugLog } from '../../client/debug/ClientDebugLog'
import { checkGatekeeperSceneAccess } from './checkGatekeeperSceneAccess'
import {
  blacklistFromMetadata,
  gatekeeperParcelForComms,
  gatekeeperRealmNameForComms,
  isAddressMetadataBlacklisted
} from './sceneAccessCommon'
import { SceneAccessDeniedError } from './SceneAccessDeniedError'
import { simulatedSceneAccessDenied } from './sceneBanDebug'
function sceneAccessContext(scene: ResolvedScene) {
  return {
    pointer: scene.commsPointer,
    baseParcel: scene.baseParcel,
    realmName: scene.realm.realmName,
    metadataBlacklist: blacklistFromMetadata(scene.metadata)
  }
}

function throwAccessDenied(
  source: SceneAccessDeniedError['source'],
  sceneTitle: string | undefined,
  customMessage?: string,
  gatekeeperError?: string
): never {
  throw new SceneAccessDeniedError({
    source,
    sceneTitle,
    customMessage,
    gatekeeperError
  })
}

/** Catalyst metadata blacklist + gatekeeper scene-ban preflight (wallet only). */
export async function assertSceneAccess(
  scene: ResolvedScene,
  login: LoginResult | null
): Promise<void> {
  if (scene.source.kind === 'blank') return

  const simulated = simulatedSceneAccessDenied(scene.title)
  if (simulated) {
    clientDebugLog.log('client', `Scene access denied · simulated ban · ${scene.commsPointer}`, {
      level: 'warn'
    })
    throw simulated
  }

  const accessContext = sceneAccessContext(scene)
  const walletAddress = login?.kind === 'wallet' ? login.address : null

  if (walletAddress && isAddressMetadataBlacklisted(accessContext.metadataBlacklist, walletAddress)) {
    clientDebugLog.log('client', `Scene access denied · metadata blacklist · ${scene.commsPointer}`, {
      level: 'warn'
    })
    throwAccessDenied('metadata_blacklist', scene.title)
  }

  if (login?.kind !== 'wallet') return

  const pointer = scene.commsPointer
  const isWorld = scene.source.kind === 'world'
  let sceneId = scene.entityId?.trim() || ''
  if (!sceneId) {
    sceneId =
      (
        await resolveCommsSceneId(
          pointer,
          scene.realm.contentUrl,
          null,
          scene.source.kind === 'world' ? scene.source.customServer : null
        )
      )?.trim() || ''
  }
  if (!sceneId) {
    clientDebugLog.log('client', `Scene access check skipped — no scene id for ${pointer}`, {
      level: 'warn'
    })
    return
  }

  const access = await checkGatekeeperSceneAccess(login.identity, {
    sceneId,
    parcel: gatekeeperParcelForComms(accessContext),
    realmName: gatekeeperRealmNameForComms(accessContext),
    isWorld
  })

  if (access.denied) {
    clientDebugLog.log('client', `Scene access denied · ${access.source} · ${pointer}`, {
      level: 'warn'
    })
    throwAccessDenied(access.source, scene.title, access.customMessage, access.error)
  }

  if (access.adapter === null) {
    clientDebugLog.log(
      'client',
      `Scene access gatekeeper preflight failed (${access.status}) — continuing load: ${access.error}`,
      { level: 'warn' }
    )
  }
}