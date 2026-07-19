import type { LanguageCode } from './types'
import { LANGUAGE_OPTIONS } from './types'

const STORAGE_KEY = 'dcl-chat-translation'

export type ChatTranslationSettingsState = {
  preferredLanguage: LanguageCode
  /** channelKey → auto-translate enabled */
  autoByChannel: Record<string, boolean>
}

const DEFAULTS: ChatTranslationSettingsState = {
  preferredLanguage: detectSystemLanguage(),
  autoByChannel: {}
}

type Listener = (state: ChatTranslationSettingsState) => void

function detectSystemLanguage(): LanguageCode {
  try {
    const nav = (navigator.language || 'en').toLowerCase()
    const base = nav.split('-')[0] ?? 'en'
    if (LANGUAGE_OPTIONS.some((o) => o.code === base)) return base as LanguageCode
    if (base === 'zh') return 'zh'
  } catch {
    /* SSR / private mode */
  }
  return 'en'
}

function isLanguageCode(value: unknown): value is LanguageCode {
  return typeof value === 'string' && LANGUAGE_OPTIONS.some((o) => o.code === value)
}

class ChatTranslationSettingsStore {
  private state: ChatTranslationSettingsState
  private readonly listeners = new Set<Listener>()

  constructor() {
    this.state = { ...DEFAULTS, autoByChannel: {} }
    this.load()
  }

  get(): ChatTranslationSettingsState {
    return {
      preferredLanguage: this.state.preferredLanguage,
      autoByChannel: { ...this.state.autoByChannel }
    }
  }

  getPreferredLanguage(): LanguageCode {
    return this.state.preferredLanguage
  }

  setPreferredLanguage(code: LanguageCode): void {
    if (code === this.state.preferredLanguage) return
    this.state = { ...this.state, preferredLanguage: code }
    this.persist()
    this.notify()
  }

  getAutoTranslate(channelKey: string): boolean {
    return Boolean(this.state.autoByChannel[channelKey])
  }

  setAutoTranslate(channelKey: string, enabled: boolean): void {
    const key = channelKey.trim()
    if (!key) return
    if (Boolean(this.state.autoByChannel[key]) === enabled) return
    const autoByChannel = { ...this.state.autoByChannel }
    if (enabled) autoByChannel[key] = true
    else delete autoByChannel[key]
    this.state = { ...this.state, autoByChannel }
    this.persist()
    this.notify()
  }

  toggleAutoTranslate(channelKey: string): boolean {
    const next = !this.getAutoTranslate(channelKey)
    this.setAutoTranslate(channelKey, next)
    return next
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
      /* quota / private mode */
    }
  }

  private load(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (!raw) return
      const parsed = JSON.parse(raw) as Partial<ChatTranslationSettingsState>
      if (isLanguageCode(parsed.preferredLanguage)) {
        this.state.preferredLanguage = parsed.preferredLanguage
      }
      if (parsed.autoByChannel && typeof parsed.autoByChannel === 'object') {
        const next: Record<string, boolean> = {}
        for (const [k, v] of Object.entries(parsed.autoByChannel)) {
          if (v) next[k] = true
        }
        this.state.autoByChannel = next
      }
    } catch {
      /* corrupt */
    }
  }
}

export const chatTranslationSettings = new ChatTranslationSettingsStore()
