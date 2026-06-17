import type { AuthIdentity } from '@dcl/crypto/dist/types'
import { clientDebugLog } from '../../client/debug/ClientDebugLog'
import { isLiveKitAdapter } from './livekitAdapter'
import { parseCommsAdapter } from './types'
import { fetchWorldCommsAdapter } from '../worlds/WorldCommsClient'

export type ParsedRealmAdapter =
  | { kind: 'archipelago'; url: string }
  | { kind: 'signed-login'; url: string }
  | { kind: 'livekit'; adapter: string }
  | { kind: 'ws-room'; url: string }
  | { kind: 'offline' }

export type AdapterConnectors = {
  connectArchipelago: (url: string) => void
  connectLiveKit: (adapter: string, label: 'island' | 'scene' | 'world') => Promise<boolean>
  connectWsRoom: (url: string) => boolean
}

/** Bevy `AdapterManager` — unwrap `fixed-adapter:` and dispatch protocol handlers. */
export class AdapterManager {
  constructor(
    private identity: AuthIdentity | null,
    private contentUrl: string,
    private connectors: AdapterConnectors
  ) {}

  setIdentity(identity: AuthIdentity | null): void {
    this.identity = identity
  }

  setContentUrl(contentUrl: string): void {
    this.contentUrl = contentUrl.replace(/\/$/, '')
  }

  parse(adapterHint: string | undefined): ParsedRealmAdapter | null {
    let raw = adapterHint?.trim() ?? ''
    if (!raw) return null
    if (raw.startsWith('fixed-adapter:')) raw = raw.slice('fixed-adapter:'.length)
    if (raw.startsWith('offline:') || raw === 'offline') return { kind: 'offline' }
    if (raw.startsWith('archipelago:')) return { kind: 'archipelago', url: raw.slice('archipelago:'.length) }
    if (raw.startsWith('signed-login:')) return { kind: 'signed-login', url: raw.slice('signed-login:'.length) }
    if (isLiveKitAdapter(raw)) return { kind: 'livekit', adapter: raw }
    const ws = parseCommsAdapter(raw)
    if (ws) return { kind: 'ws-room', url: ws }
    return null
  }

  async connect(adapterHint: string | undefined, liveKitLabel: 'island' | 'scene' | 'world' = 'world'): Promise<boolean> {
    const parsed = this.parse(adapterHint)
    if (!parsed) return false
    if (parsed.kind === 'offline') {
      clientDebugLog.log('comms', 'Realm comms adapter is offline', { level: 'warn' })
      return false
    }
    if (parsed.kind === 'archipelago') {
      if (!this.identity) return false
      this.connectors.connectArchipelago(parsed.url)
      return true
    }
    if (parsed.kind === 'signed-login') {
      if (!this.identity) return false
      clientDebugLog.log('comms', `Signed-login handshake · ${parsed.url}`, { level: 'info' })
      const result = await fetchWorldCommsAdapter(this.identity, parsed.url, this.contentUrl)
      if (!result.ok) {
        clientDebugLog.log('comms', `Signed-login failed: ${result.error}`, { level: 'warn' })
        return false
      }
      return this.connect(result.adapter, liveKitLabel)
    }
    if (parsed.kind === 'livekit') {
      return this.connectors.connectLiveKit(parsed.adapter, liveKitLabel)
    }
    if (parsed.kind === 'ws-room') {
      return this.connectors.connectWsRoom(parsed.url)
    }
    return false
  }
}

export function archipelagoUrlFromAbout(adapterHint: string | undefined): string | null {
  const manager = new AdapterManager(null, '', {
    connectArchipelago: () => {},
    connectLiveKit: async () => false,
    connectWsRoom: () => false
  })
  const parsed = manager.parse(adapterHint)
  return parsed?.kind === 'archipelago' ? parsed.url : null
}
