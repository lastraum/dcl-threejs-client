import type { VoiceChatService, VoiceChatSnapshot } from '../../../network/voice/VoiceChatService'
import { soundSettings, VOLUME_MAX, VOLUME_MIN } from '../../../rendering/SoundSettings'

export type NearbyVoicePanelOptions = {
  anchor: () => HTMLElement | undefined
  onClose?: () => void
}

/** Explorer-style NEARBY VOICE popover — Hear others · volume · Speak · hold T. */
export class NearbyVoicePanel {
  readonly element: HTMLDivElement
  private voice: VoiceChatService | null = null
  private unsubVoice: (() => void) | null = null
  private unsubSound: (() => void) | null = null
  private visible = false
  private readonly hearToggle: HTMLInputElement
  private readonly volumeSlider: HTMLInputElement
  private readonly speakBtn: HTMLButtonElement
  private readonly hintEl: HTMLElement
  private readonly errorEl: HTMLElement

  constructor(private readonly options: NearbyVoicePanelOptions) {
    this.element = document.createElement('div')
    this.element.className = 'nearby-voice-panel'
    this.element.hidden = true
    this.element.innerHTML = `
      <header class="nearby-voice-panel__header">NEARBY VOICE</header>
      <div class="nearby-voice-panel__row">
        <span class="nearby-voice-panel__label">
          <span class="nearby-voice-panel__icon" aria-hidden="true">${ICON_HEAR}</span>
          Hear others
        </span>
        <label class="nearby-voice-panel__switch">
          <input type="checkbox" data-hear checked />
          <span class="nearby-voice-panel__switch-track" aria-hidden="true"></span>
        </label>
      </div>
      <div class="nearby-voice-panel__volume-row">
        <span class="nearby-voice-panel__icon" aria-hidden="true">${ICON_VOLUME}</span>
        <input type="range" class="nearby-voice-panel__slider" min="${VOLUME_MIN}" max="${VOLUME_MAX}" step="1" data-volume />
      </div>
      <button type="button" class="nearby-voice-panel__speak" data-speak>
        <span class="nearby-voice-panel__speak-icon" aria-hidden="true">${ICON_SPEAK}</span>
        Speak
      </button>
      <p class="nearby-voice-panel__hint" data-hint>Hold <kbd>T</kbd> to speak momentarily</p>
      <p class="nearby-voice-panel__error" data-error hidden></p>
    `

    this.hearToggle = this.element.querySelector('[data-hear]')!
    this.volumeSlider = this.element.querySelector('[data-volume]')!
    this.speakBtn = this.element.querySelector('[data-speak]')!
    this.hintEl = this.element.querySelector('[data-hint]')!
    this.errorEl = this.element.querySelector('[data-error]')!

    this.volumeSlider.value = String(soundSettings.get().voiceChatVolume)
    this.setSliderPct()

    this.hearToggle.addEventListener('change', () => {
      void this.voice?.setHearing(this.hearToggle.checked)
    })
    this.volumeSlider.addEventListener('input', () => {
      soundSettings.set({ voiceChatVolume: Number(this.volumeSlider.value) })
      this.setSliderPct()
    })
    this.speakBtn.addEventListener('click', () => {
      if (!this.voice) {
        console.warn('[voice] Speak clicked but VoiceChatService not bound')
        this.errorEl.hidden = false
        this.errorEl.textContent = 'Voice not ready — rejoin the scene'
        return
      }
      console.log('[voice] Speak button clicked')
      void this.voice.toggleSpeaking()
    })

    document.body.appendChild(this.element)
  }

  bindVoice(voice: VoiceChatService | null): void {
    this.unsubVoice?.()
    this.unsubVoice = null
    this.unsubSound?.()
    this.unsubSound = null
    this.voice = voice
    if (!voice) return
    this.unsubVoice = voice.subscribe((snap) => this.syncFromVoice(snap))
    this.unsubSound = soundSettings.subscribe((s) => {
      this.volumeSlider.value = String(s.voiceChatVolume)
      this.setSliderPct()
    })
  }

  toggle(): void {
    if (this.visible) this.hide()
    else this.show()
  }

  show(): void {
    this.visible = true
    this.element.hidden = false
    this.positionNearAnchor()
    if (this.voice) this.syncFromVoice(this.voice.getSnapshot())
  }

  hide(): void {
    this.visible = false
    this.element.hidden = true
    this.options.onClose?.()
  }

  isVisible(): boolean {
    return this.visible
  }

  dispose(): void {
    this.unsubVoice?.()
    this.unsubSound?.()
    this.element.remove()
  }

  private syncFromVoice(snap: VoiceChatSnapshot): void {
    this.hearToggle.checked = snap.hearing
    this.speakBtn.classList.toggle('is-active', snap.speaking || snap.micLive)
    this.speakBtn.classList.toggle('is-talking', snap.micLive)
    if (!snap.roomReady) {
      this.hintEl.innerHTML = 'Connecting to voice room…'
    } else if (snap.speaking) {
      this.hintEl.innerHTML = snap.micLive
        ? 'Hot mic on — click Speak to stop'
        : 'Starting microphone…'
    } else if (snap.pttHeld) {
      this.hintEl.innerHTML = 'Speaking (hold <kbd>T</kbd>)…'
    } else {
      this.hintEl.innerHTML =
        'Hold <kbd>T</kbd> to talk · or click Speak for hot mic (stays on)'
    }
    if (snap.error) {
      this.errorEl.hidden = false
      this.errorEl.textContent = snap.error
    } else {
      this.errorEl.hidden = true
      this.errorEl.textContent = ''
    }
  }

  private setSliderPct(): void {
    const v = Number(this.volumeSlider.value)
    const pct = ((v - VOLUME_MIN) / (VOLUME_MAX - VOLUME_MIN)) * 100
    this.volumeSlider.style.setProperty('--pct', `${pct}%`)
  }

  private positionNearAnchor(): void {
    const anchor = this.options.anchor()
    if (!anchor) {
      this.element.style.left = 'var(--client-safe-left)'
      this.element.style.bottom = 'var(--client-safe-bottom)'
      this.element.style.top = 'auto'
      return
    }
    const r = anchor.getBoundingClientRect()
    const panelW = this.element.offsetWidth || 248
    const panelH = this.element.offsetHeight || 200
    let left = r.right + 10
    let top = r.top + r.height / 2 - panelH / 2
    if (left + panelW > window.innerWidth - 12) left = Math.max(12, r.left - panelW - 10)
    top = Math.max(12, Math.min(window.innerHeight - panelH - 12, top))
    this.element.style.left = `${left}px`
    this.element.style.top = `${top}px`
    this.element.style.bottom = 'auto'
  }
}

const ICON_HEAR = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M4 10v4M8 7v10M12 4v16M16 7v10M20 10v4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`
const ICON_VOLUME = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M4 10v4h3l4 3V7L7 10H4zM16 9a4 4 0 010 6M18.5 7a7 7 0 010 10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`
const ICON_SPEAK = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M12 3a3.5 3.5 0 00-3.5 3.5v5a3.5 3.5 0 107 0v-5A3.5 3.5 0 0012 3z" stroke="currentColor" stroke-width="1.6"/><path d="M6 12a6 6 0 0012 0M12 18v3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`
