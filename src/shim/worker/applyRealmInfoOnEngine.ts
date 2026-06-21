import type { IEngine } from '@dcl/ecs'
import * as generated from '@dcl/ecs/dist/components/generated/index.gen'
import type { PBRealmInfo } from '@dcl/ecs/dist/components/generated/pb/decentraland/sdk/components/realm_info.gen'

export function applyRealmInfoOnEngine(
  engine: IEngine,
  realmInfo: PBRealmInfo,
  options?: { forceNotify?: boolean }
): void {
  const RealmInfo = generated.RealmInfo(engine)
  if (options?.forceNotify && RealmInfo.has(engine.RootEntity)) {
    RealmInfo.deleteFrom(engine.RootEntity)
  }
  RealmInfo.createOrReplace(engine.RootEntity, {
    baseUrl: realmInfo.baseUrl ?? '',
    realmName: realmInfo.realmName ?? '',
    networkId: realmInfo.networkId ?? 1,
    commsAdapter: realmInfo.commsAdapter ?? '',
    isPreview: realmInfo.isPreview ?? false,
    room: realmInfo.room,
    isConnectedSceneRoom: realmInfo.isConnectedSceneRoom
  })
}