const STORAGE_KEY = 'dcl-social-notification-prefs'

export type NotificationPrefsState = {
  /** Master switch for toast banners (chat, community, pool, system). */
  enabled: boolean
  /**
   * Grab bag claims from peers (PM topic `d3js-gacha:claims`).
   * Default on. Does not toast your own claim (local win modal only).
   */
  poolClaims: boolean
}

const DEFAULTS: NotificationPrefsState = {
  enabled: true,
  poolClaims: true
}

type Listener = (state: NotificationPrefsState) => void

class NotificationPrefsStore {
  private state: NotificationPrefsState
  private readonly listeners = new Set<Listener>()

  constructor() {
    this.state = { ...DEFAULTS }
    this.load()
  }

  get(): NotificationPrefsState {
    return { ...this.state }
  }

  isEnabled(): boolean {
    return this.state.enabled
  }

  /** Master banners on and pool claim peer toasts on. */
  isPoolClaimsEnabled(): boolean {
    return this.state.enabled && this.state.poolClaims
  }

  setEnabled(enabled: boolean): void {
    if (enabled === this.state.enabled) return
    this.state = { ...this.state, enabled }
    this.persist()
    this.notify()
  }

  setPoolClaims(poolClaims: boolean): void {
    if (poolClaims === this.state.poolClaims) return
    this.state = { ...this.state, poolClaims }
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
    const snapshot = this.get()
    for (const listener of this.listeners) listener(snapshot)
  }

  private persist(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state))
    } catch {
      /* quota or private mode */
    }
  }

  private load(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (!raw) return
      const parsed = JSON.parse(raw) as Partial<NotificationPrefsState>
      if (typeof parsed.enabled === 'boolean') {
        this.state.enabled = parsed.enabled
      }
      if (typeof parsed.poolClaims === 'boolean') {
        this.state.poolClaims = parsed.poolClaims
      }
    } catch {
      /* corrupt data */
    }
  }
}

export const notificationPrefs = new NotificationPrefsStore()