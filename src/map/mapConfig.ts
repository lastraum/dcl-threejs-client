import { PEER_URL } from '../avatar/constants'

export const ARCHIPELAGO_POLL_MS = 15_000
export const WORLDS_POLL_MS = 15_000

export function archipelagoPeersUrl(): string {
  const fromEnv = import.meta.env.VITE_ARCHIPELAGO_PEERS_URL?.trim()
  if (fromEnv) return fromEnv
  return import.meta.env.DEV
    ? '/api/peers'
    : 'https://archipelago-ea-stats.decentraland.org/peers'
}

export function parcelsApiBase(): string {
  const fromEnv = import.meta.env.VITE_PARCELS_API_BASE?.trim()
  if (fromEnv) return fromEnv.replace(/\/+$/, '')
  return import.meta.env.DEV ? '/api/parcels' : 'https://api.decentraland.org/v2/parcels'
}

export function worldsLiveDataUrl(): string {
  const fromEnv = import.meta.env.VITE_WORLDS_LIVE_DATA_URL?.trim()
  if (fromEnv) return fromEnv
  return import.meta.env.DEV
    ? '/api/worlds/live-data'
    : 'https://worlds-content-server.decentraland.org/live-data'
}

export function catalystPeerBaseUrl(): string {
  const fromEnv = import.meta.env.VITE_CATALYST_BASE_URL?.trim()
  return (fromEnv || PEER_URL).replace(/\/+$/, '')
}

export function catalystProfilesEndpoint(): string {
  return `${catalystPeerBaseUrl()}/lambdas/profiles`
}
