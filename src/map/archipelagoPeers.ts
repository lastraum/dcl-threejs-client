import { archipelagoPeersUrl, ARCHIPELAGO_POLL_MS } from './mapConfig'
import { isFinitePosition, normalizeWallet } from './peerParcel'
import type { ArchipelagoConnectionState, LivePeer } from './types'

type PeersResponse = {
  ok?: boolean
  peers?: Array<{
    id?: string
    address?: string
    position?: number[]
    lastPing?: number
    parcel?: number[]
  }>
}

function parsePeersPayload(raw: PeersResponse): LivePeer[] {
  if (!raw?.ok || !Array.isArray(raw.peers)) return []
  const out: LivePeer[] = []

  for (const row of raw.peers) {
    const address = normalizeWallet(String(row.address ?? row.id ?? ''))
    const pos = row.position
    if (!address || !Array.isArray(pos) || pos.length < 3) continue

    const x = Number(pos[0])
    const y = Number(pos[1])
    const z = Number(pos[2])
    const position = { x, y, z }
    if (!isFinitePosition(position)) continue

    const parcelRaw = row.parcel
    const parcel: [number, number] =
      Array.isArray(parcelRaw) && parcelRaw.length >= 2
        ? [Number(parcelRaw[0]) || 0, Number(parcelRaw[1]) || 0]
        : [Math.floor(x / 16), Math.floor(z / 16)]

    out.push({
      address,
      parcel,
      position,
      lastPing: Number(row.lastPing) || 0
    })
  }

  return out
}

export type ArchipelagoPeersListener = (state: {
  connection: ArchipelagoConnectionState
  error: string | null
  players: LivePeer[]
  updatedAtMs: number | null
}) => void

/** Polls archipelago-ea-stats for live Genesis City peers. */
export class ArchipelagoPeersPoller {
  private connection: ArchipelagoConnectionState = 'idle'
  private error: string | null = null
  private players: LivePeer[] = []
  private updatedAtMs: number | null = null
  private timer = 0
  private inFlight = false
  private listeners = new Set<ArchipelagoPeersListener>()
  private active = false

  start(): void {
    if (this.active) return
    this.active = true
    this.connection = 'loading'
    this.emit()
    void this.refresh()
    this.timer = window.setInterval(() => void this.refresh(), ARCHIPELAGO_POLL_MS)
  }

  stop(): void {
    this.active = false
    if (this.timer) window.clearInterval(this.timer)
    this.timer = 0
  }

  subscribe(listener: ArchipelagoPeersListener): () => void {
    this.listeners.add(listener)
    listener(this.snapshot())
    return () => this.listeners.delete(listener)
  }

  async refresh(): Promise<void> {
    if (this.inFlight) return
    this.inFlight = true
    try {
      const res = await fetch(archipelagoPeersUrl(), {
        headers: { Accept: 'application/json' }
      })
      if (!res.ok) throw new Error(`Peers HTTP ${res.status}`)

      const raw = (await res.json()) as PeersResponse
      const parsed = parsePeersPayload(raw)
      parsed.sort((a, b) => a.address.localeCompare(b.address))

      this.players = parsed
      this.updatedAtMs = Date.now()
      this.connection = 'live'
      this.error = null
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      this.error = message
      this.connection = this.connection === 'live' ? 'live' : 'error'
    } finally {
      this.inFlight = false
      this.emit()
    }
  }

  private snapshot() {
    return {
      connection: this.connection,
      error: this.error,
      players: this.players,
      updatedAtMs: this.updatedAtMs
    }
  }

  private emit(): void {
    const snap = this.snapshot()
    for (const listener of this.listeners) listener(snap)
  }
}
