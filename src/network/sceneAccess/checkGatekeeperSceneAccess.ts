import type { AuthIdentity } from '@dcl/crypto/dist/types'
import { getSceneAdapter } from '../gatekeeper/GatekeeperClient'
import type { SceneAccessDeniedSource } from './SceneAccessDeniedError'

export type GatekeeperSceneAccessParams = {
  sceneId: string
  parcel: string
  realmName: string
  isWorld: boolean
}

export type GatekeeperSceneAccessDenied = {
  denied: true
  source: SceneAccessDeniedSource
  error: string
  customMessage?: string
}

export type GatekeeperSceneAccessAllowed = {
  denied: false
  adapter: string
}

export type GatekeeperSceneAccessUnavailable = {
  denied: false
  adapter: null
  status: number
  error: string
}

export type GatekeeperSceneAccessResult =
  | GatekeeperSceneAccessDenied
  | GatekeeperSceneAccessAllowed
  | GatekeeperSceneAccessUnavailable

/** Signed gatekeeper preflight — 401/403 means the wallet cannot enter. */
export async function checkGatekeeperSceneAccess(
  identity: AuthIdentity,
  params: GatekeeperSceneAccessParams
): Promise<GatekeeperSceneAccessResult> {
  const result = await getSceneAdapter(identity, params)
  if (result.ok) {
    return { denied: false, adapter: result.adapter }
  }

  if (result.status === 403) {
    return {
      denied: true,
      source: 'gatekeeper_ban',
      error: result.error,
      customMessage: result.customMessage
    }
  }

  if (result.status === 401) {
    return {
      denied: true,
      source: 'gatekeeper_blacklist',
      error: result.error,
      customMessage: result.customMessage
    }
  }

  return {
    denied: false,
    adapter: null,
    status: result.status,
    error: result.error
  }
}