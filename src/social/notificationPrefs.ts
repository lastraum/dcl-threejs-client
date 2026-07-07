const STORAGE_KEY = 'dcl-social-notification-prefs'

export type NotificationPrefsState = {
  enabled: boolean
}

const DEFAULTS: NotificationPrefsState = {
  enabled: true
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

  setEnabled(enabled: boolean): void {
    if (enabled === this.state.enabled) return
    this.state = { ...this.state, enabled }
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
    } catch {
      /* corrupt data */
    }
  }
}

export const notificationPrefs = new NotificationPrefsStore()