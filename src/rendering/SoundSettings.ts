const STORAGE_KEY = 'dcl-sound-settings'

export type SoundSettingsState = {
  /** 0–100 — scales AudioListener master gain */
  masterVolume: number
  /** 0–100 — HUD / menu clicks (stored; not wired yet) */
  uiSfxVolume: number
  /** 0–100 — LiveKit voice + streams (stored; not wired yet) */
  voiceChatVolume: number
  /** 0–100 — ECS AudioSource scene clips */
  inWorldMusicSfxVolume: number
  /** 0–100 — avatar emotes / locomotion (stored; not wired yet) */
  avatarEmotesVolume: number
  /** `deviceId` from `enumerateDevices`; empty = system default */
  microphoneDeviceId: string
  /** When tab/window hidden, mute local mic (stored; voice path pending) */
  muteMicInBackground: boolean
}

export const VOLUME_MIN = 0
export const VOLUME_MAX = 100

const DEFAULTS: SoundSettingsState = {
  masterVolume: 100,
  uiSfxVolume: 100,
  voiceChatVolume: 100,
  inWorldMusicSfxVolume: 100,
  avatarEmotesVolume: 100,
  microphoneDeviceId: '',
  muteMicInBackground: true
}

type Listener = (state: SoundSettingsState) => void

function clampVolume(value: number): number {
  return Math.round(Math.max(VOLUME_MIN, Math.min(VOLUME_MAX, value)))
}

/** Linear 0–100 → 0–1 gain. */
export function volumeToGain(percent: number): number {
  return clampVolume(percent) / VOLUME_MAX
}

export function inWorldVolumeMultiplier(): number {
  return volumeToGain(soundSettings.get().inWorldMusicSfxVolume)
}

class SoundSettingsStore {
  private state: SoundSettingsState
  private readonly listeners = new Set<Listener>()

  constructor() {
    this.state = { ...DEFAULTS }
    this.load()
  }

  get(): SoundSettingsState {
    return { ...this.state }
  }

  set(partial: Partial<SoundSettingsState>): void {
    const next: SoundSettingsState = { ...this.state }
    let changed = false

    if (partial.masterVolume !== undefined) {
      const v = clampVolume(partial.masterVolume)
      if (v !== next.masterVolume) {
        next.masterVolume = v
        changed = true
      }
    }
    if (partial.uiSfxVolume !== undefined) {
      const v = clampVolume(partial.uiSfxVolume)
      if (v !== next.uiSfxVolume) {
        next.uiSfxVolume = v
        changed = true
      }
    }
    if (partial.voiceChatVolume !== undefined) {
      const v = clampVolume(partial.voiceChatVolume)
      if (v !== next.voiceChatVolume) {
        next.voiceChatVolume = v
        changed = true
      }
    }
    if (partial.inWorldMusicSfxVolume !== undefined) {
      const v = clampVolume(partial.inWorldMusicSfxVolume)
      if (v !== next.inWorldMusicSfxVolume) {
        next.inWorldMusicSfxVolume = v
        changed = true
      }
    }
    if (partial.avatarEmotesVolume !== undefined) {
      const v = clampVolume(partial.avatarEmotesVolume)
      if (v !== next.avatarEmotesVolume) {
        next.avatarEmotesVolume = v
        changed = true
      }
    }
    if (partial.microphoneDeviceId !== undefined && partial.microphoneDeviceId !== next.microphoneDeviceId) {
      next.microphoneDeviceId = partial.microphoneDeviceId
      changed = true
    }
    if (partial.muteMicInBackground !== undefined && partial.muteMicInBackground !== next.muteMicInBackground) {
      next.muteMicInBackground = partial.muteMicInBackground
      changed = true
    }

    if (!changed) return
    this.state = next
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
      const parsed = JSON.parse(raw) as Partial<SoundSettingsState>
      if (typeof parsed.masterVolume === 'number') {
        this.state.masterVolume = clampVolume(parsed.masterVolume)
      }
      if (typeof parsed.uiSfxVolume === 'number') {
        this.state.uiSfxVolume = clampVolume(parsed.uiSfxVolume)
      }
      if (typeof parsed.voiceChatVolume === 'number') {
        this.state.voiceChatVolume = clampVolume(parsed.voiceChatVolume)
      }
      if (typeof parsed.inWorldMusicSfxVolume === 'number') {
        this.state.inWorldMusicSfxVolume = clampVolume(parsed.inWorldMusicSfxVolume)
      }
      if (typeof parsed.avatarEmotesVolume === 'number') {
        this.state.avatarEmotesVolume = clampVolume(parsed.avatarEmotesVolume)
      }
      if (typeof parsed.microphoneDeviceId === 'string') {
        this.state.microphoneDeviceId = parsed.microphoneDeviceId
      }
      if (typeof parsed.muteMicInBackground === 'boolean') {
        this.state.muteMicInBackground = parsed.muteMicInBackground
      }
    } catch {
      /* corrupt data */
    }
  }
}

export const soundSettings = new SoundSettingsStore()