/**
 * Per-channel chat preferences (notification ping mode).
 * Auto-translate lives in chatTranslationSettings — keep concerns separate.
 */

export type ChatNotificationPing = 'all' | 'mentions' | 'none'

const STORAGE_KEY = 'dcl-chat-channel-prefs'

type StoreState = {
  pingByChannel: Record<string, ChatNotificationPing>
}

const DEFAULTS: StoreState = {
  pingByChannel: {}
}

type Listener = () => void

class ChatChannelPrefsStore {
  private state: StoreState = { pingByChannel: {} }
  private readonly listeners = new Set<Listener>()

  constructor() {
    this.load()
  }

  getNotificationPing(channelKey: string): ChatNotificationPing {
    return this.state.pingByChannel[channelKey] ?? 'all'
  }

  setNotificationPing(channelKey: string, mode: ChatNotificationPing): void {
    const key = channelKey.trim()
    if (!key) return
    if (this.getNotificationPing(key) === mode) return
    const pingByChannel = { ...this.state.pingByChannel }
    if (mode === 'all') delete pingByChannel[key]
    else pingByChannel[key] = mode
    this.state = { pingByChannel }
    this.persist()
    this.notify()
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private notify(): void {
    for (const l of this.listeners) l()
  }

  private persist(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state))
    } catch {
      /* ignore */
    }
  }

  private load(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (!raw) return
      const parsed = JSON.parse(raw) as Partial<StoreState>
      if (!parsed.pingByChannel || typeof parsed.pingByChannel !== 'object') return
      const next: Record<string, ChatNotificationPing> = {}
      for (const [k, v] of Object.entries(parsed.pingByChannel)) {
        if (v === 'all' || v === 'mentions' || v === 'none') next[k] = v
      }
      this.state = { pingByChannel: next }
    } catch {
      this.state = { ...DEFAULTS }
    }
  }
}

export const chatChannelPrefs = new ChatChannelPrefsStore()
