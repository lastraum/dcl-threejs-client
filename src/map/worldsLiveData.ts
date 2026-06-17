import { worldsLiveDataUrl, WORLDS_POLL_MS } from './mapConfig'
import type { WorldsConnectionState, WorldsLiveData, WorldLiveEntry } from './types'

type LiveDataResponse = {
  data?: {
    totalUsers?: number
    perWorld?: Array<{ worldName?: string; users?: number }>
  }
  lastUpdated?: string
}

function parseLiveDataPayload(raw: LiveDataResponse): WorldsLiveData {
  const perWorld: WorldLiveEntry[] = []
  if (Array.isArray(raw?.data?.perWorld)) {
    for (const row of raw.data.perWorld) {
      const worldName = String(row.worldName ?? '').trim()
      const users = Number(row.users)
      if (!worldName || !Number.isFinite(users) || users <= 0) continue
      perWorld.push({ worldName, users })
    }
  }

  perWorld.sort((a, b) => {
    const byUsers = b.users - a.users
    return byUsers !== 0 ? byUsers : a.worldName.localeCompare(b.worldName, undefined, { sensitivity: 'base' })
  })

  const totalUsers = Number(raw?.data?.totalUsers)
  return {
    totalUsers: Number.isFinite(totalUsers) ? totalUsers : perWorld.reduce((sum, w) => sum + w.users, 0),
    perWorld,
    lastUpdated: raw?.lastUpdated?.trim() || null
  }
}

export type WorldsLiveDataListener = (state: {
  connection: WorldsConnectionState
  error: string | null
  data: WorldsLiveData
  updatedAtMs: number | null
}) => void

/** Polls worlds-content-server for live world occupancy. */
export class WorldsLiveDataPoller {
  private connection: WorldsConnectionState = 'idle'
  private error: string | null = null
  private data: WorldsLiveData = { totalUsers: 0, perWorld: [], lastUpdated: null }
  private updatedAtMs: number | null = null
  private timer = 0
  private inFlight = false
  private listeners = new Set<WorldsLiveDataListener>()
  private active = false

  start(): void {
    if (this.active) return
    this.active = true
    this.connection = 'loading'
    this.emit()
    void this.refresh()
    this.timer = window.setInterval(() => void this.refresh(), WORLDS_POLL_MS)
  }

  stop(): void {
    this.active = false
    if (this.timer) window.clearInterval(this.timer)
    this.timer = 0
  }

  subscribe(listener: WorldsLiveDataListener): () => void {
    this.listeners.add(listener)
    listener(this.snapshot())
    return () => this.listeners.delete(listener)
  }

  async refresh(): Promise<void> {
    if (this.inFlight) return
    this.inFlight = true
    try {
      const res = await fetch(worldsLiveDataUrl(), {
        headers: { Accept: 'application/json' }
      })
      if (!res.ok) throw new Error(`Worlds HTTP ${res.status}`)

      const raw = (await res.json()) as LiveDataResponse
      this.data = parseLiveDataPayload(raw)
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
      data: this.data,
      updatedAtMs: this.updatedAtMs
    }
  }

  private emit(): void {
    const snap = this.snapshot()
    for (const listener of this.listeners) listener(snap)
  }
}
