/**
 * Companion-style floating bar while in a community voice session (2D shell).
 * Bottom-anchored pill; click community name → participant roster panel above the pill.
 * Session is a module singleton — survives tab switches / landing remounts.
 */
import {
  getCommunityVoiceSession,
  walletFromIdentity,
  type CommunityVoiceParticipant,
  type CommunityVoiceSessionState
} from '../../../social/CommunityVoiceSession'
import { ChatPeerProfiles } from '../../../social/ChatPeerProfiles'
import { soundSettings, VOLUME_MAX, VOLUME_MIN } from '../../../rendering/SoundSettings'
import { shortenAddress } from '../../../avatar/displayName'

export type CommunityVoiceFloatingBarOptions = {
  /** When false, bar is hidden (e.g. in-world 3D play). Session keeps running. */
  shouldShow?: () => boolean
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export class CommunityVoiceFloatingBar {
  readonly root: HTMLElement
  private readonly shouldShow: () => boolean
  private readonly profiles = new ChatPeerProfiles()
  private unsubVoice: (() => void) | null = null
  private unsubSound: (() => void) | null = null
  private unsubProfiles: (() => void) | null = null
  private disposed = false
  private state: CommunityVoiceSessionState | null = null
  private leaving = false
  /** Participant roster open above the pill. */
  private rosterOpen = false
  private onDocPointer: ((ev: PointerEvent) => void) | null = null

  constructor(opts: CommunityVoiceFloatingBarOptions = {}) {
    this.shouldShow = opts.shouldShow ?? (() => true)

    this.root = document.createElement('div')
    this.root.className = 'community-voice-float'
    this.root.hidden = true
    this.root.setAttribute('role', 'region')
    this.root.setAttribute('aria-label', 'Community voice chat')
    document.body.appendChild(this.root)

    this.unsubVoice = getCommunityVoiceSession().subscribe((s) => {
      if (this.disposed) return
      this.state = s
      if (!s.active) this.rosterOpen = false
      void this.ensureFaces(s.participants)
      this.render()
    })
    this.unsubSound = soundSettings.subscribe(() => {
      if (this.disposed || !this.state?.active) return
      this.syncVolumeSlider()
    })
    this.unsubProfiles = this.profiles.onUpdate(() => {
      if (this.disposed || !this.rosterOpen) return
      this.render()
    })
  }

  /** Call after 2D ↔ 3D mode changes so the bar can show/hide without leaving voice. */
  refreshVisibility(): void {
    if (this.disposed) return
    this.render()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.detachOutsideClose()
    this.unsubVoice?.()
    this.unsubVoice = null
    this.unsubSound?.()
    this.unsubSound = null
    this.unsubProfiles?.()
    this.unsubProfiles = null
    this.profiles.clear()
    this.root.remove()
  }

  private async ensureFaces(participants: CommunityVoiceParticipant[]): Promise<void> {
    const wallets = participants
      .map((p) => p.wallet ?? walletFromIdentity(p.identity))
      .filter((w): w is string => !!w)
    await Promise.all(wallets.map((w) => this.profiles.ensurePeer(w, { fast: true })))
  }

  private render(): void {
    const s = this.state
    const show = !!s?.active && s.communityId && this.shouldShow()
    this.root.hidden = !show
    if (!show || !s?.communityId) {
      this.rosterOpen = false
      this.detachOutsideClose()
      this.root.innerHTML = ''
      this.root.classList.remove('is-roster-open')
      return
    }

    const name = (s.communityName || 'Community').trim()
    const img = s.communityImage?.trim() || ''
    const initial = name.charAt(0).toUpperCase() || 'C'
    const count = Math.max(1, s.participants.length)
    const canMic = s.role === 'speaker' || s.canPublish
    const micOn = s.micEnabled
    const vol = soundSettings.get().voiceChatVolume
    const roleLabel = s.role === 'speaker' ? 'Speaker' : s.handRaised ? 'Hand raised' : 'Listening'

    this.root.classList.toggle('is-roster-open', this.rosterOpen)

    this.root.innerHTML = `
      <div class="community-voice-float__stack">
        <div class="community-voice-float__roster" data-roster ${this.rosterOpen ? '' : 'hidden'}
          role="dialog" aria-label="Voice participants">
          <div class="community-voice-float__roster-head">
            <span class="community-voice-float__roster-title">In voice · ${count}</span>
            <button type="button" class="community-voice-float__roster-close" data-roster-close
              aria-label="Close participants">✕</button>
          </div>
          <ul class="community-voice-float__roster-list" role="list">
            ${this.renderParticipantRows(s.participants)}
          </ul>
        </div>
        <div class="community-voice-float__card">
          <button type="button" class="community-voice-float__identity" data-toggle-roster
            title="Show participants" aria-expanded="${this.rosterOpen ? 'true' : 'false'}">
            <span class="community-voice-float__media">
              ${
                img
                  ? `<img src="${escapeHtml(img)}" alt="" width="36" height="36" loading="lazy" decoding="async" />`
                  : `<span class="community-voice-float__fallback" aria-hidden="true">${escapeHtml(initial)}</span>`
              }
              <span class="community-voice-float__live" aria-hidden="true"></span>
            </span>
            <span class="community-voice-float__text">
              <span class="community-voice-float__kicker">VOICE · ${escapeHtml(roleLabel)}</span>
              <span class="community-voice-float__name">${escapeHtml(name)}</span>
              <span class="community-voice-float__meta">${count} in room · tap for list</span>
            </span>
            <span class="community-voice-float__chevron" aria-hidden="true">${this.rosterOpen ? '▾' : '▴'}</span>
          </button>
          <div class="community-voice-float__controls">
            ${
              canMic
                ? `<button type="button" class="community-voice-float__btn${micOn ? '' : ' is-off'}" data-mic
                    title="${micOn ? 'Mute microphone' : 'Unmute microphone'}"
                    aria-pressed="${micOn ? 'false' : 'true'}">
                    <span aria-hidden="true">${micOn ? '🎤' : '🔇'}</span>
                    <span class="community-voice-float__btn-label">${micOn ? 'Mute' : 'Unmute'}</span>
                  </button>`
                : `<button type="button" class="community-voice-float__btn" data-hand
                    title="${s.handRaised ? 'Lower hand' : 'Request to speak'}">
                    <span aria-hidden="true">${s.handRaised ? '✋' : '🖐️'}</span>
                    <span class="community-voice-float__btn-label">${s.handRaised ? 'Lower' : 'Speak'}</span>
                  </button>`
            }
            <label class="community-voice-float__volume" title="Voice volume">
              <span class="community-voice-float__vol-icon" aria-hidden="true">🔊</span>
              <input type="range" class="community-voice-float__slider" data-volume
                min="${VOLUME_MIN}" max="${VOLUME_MAX}" step="1" value="${vol}"
                aria-label="Community voice volume" />
            </label>
            <button type="button" class="community-voice-float__btn community-voice-float__btn--leave"
              data-leave title="Leave voice chat" ${this.leaving ? 'disabled' : ''}>
              <span aria-hidden="true">✕</span>
              <span class="community-voice-float__btn-label">${this.leaving ? '…' : 'Leave'}</span>
            </button>
          </div>
        </div>
      </div>
    `

    this.bind()
  }

  private renderParticipantRows(participants: CommunityVoiceParticipant[]): string {
    if (!participants.length) {
      return `<li class="community-voice-float__roster-empty">No one else here yet</li>`
    }
    const localIsMod = getCommunityVoiceSession().isLocalMod()
    return participants
      .map((p) => {
        const wallet = p.wallet ?? walletFromIdentity(p.identity)
        const profile = wallet ? this.profiles.get(wallet) : null
        const displayName =
          profile?.displayName?.trim() ||
          p.name?.trim() ||
          (wallet ? shortenAddress(wallet) : p.identity.slice(0, 12))
        const face = profile?.faceUrl
          ? `<img src="${escapeHtml(profile.faceUrl)}" alt="" class="community-voice-float__p-face" />`
          : `<span class="community-voice-float__p-face community-voice-float__p-face--fallback">${escapeHtml(
              displayName.charAt(0).toUpperCase() || '?'
            )}</span>`
        const tags: string[] = []
        if (p.isLocal) tags.push('you')
        if (p.isMod) tags.push('mod')
        if (p.isSpeaker) tags.push('speaker')
        else tags.push('listener')
        if (p.handRaised) tags.push('✋')
        if (p.isSpeaking) tags.push('speaking')
        const tagHtml = tags
          .map((t) => `<span class="community-voice-float__p-tag">${escapeHtml(t)}</span>`)
          .join('')
        const target = (wallet || p.identity).trim()
        let actions = ''
        if (localIsMod && !p.isLocal && target) {
          const btns: string[] = []
          if (p.handRaised && !p.isSpeaker) {
            btns.push(
              `<button type="button" class="community-voice-float__mod-btn" data-mod-accept="${escapeHtml(target)}" title="Accept speak request">Accept</button>`,
              `<button type="button" class="community-voice-float__mod-btn community-voice-float__mod-btn--muted" data-mod-reject="${escapeHtml(target)}" title="Reject speak request">Reject</button>`
            )
          } else if (p.isSpeaker) {
            btns.push(
              `<button type="button" class="community-voice-float__mod-btn" data-mod-demote="${escapeHtml(target)}" title="Demote to listener">Demote</button>`
            )
          } else {
            btns.push(
              `<button type="button" class="community-voice-float__mod-btn" data-mod-promote="${escapeHtml(target)}" title="Promote to speaker">Promote</button>`
            )
          }
          btns.push(
            `<button type="button" class="community-voice-float__mod-btn community-voice-float__mod-btn--danger" data-mod-kick="${escapeHtml(target)}" title="Kick from voice">Kick</button>`
          )
          actions = `<span class="community-voice-float__mod-actions">${btns.join('')}</span>`
        }
        return `<li class="community-voice-float__p-row${p.isSpeaking ? ' is-speaking' : ''}" role="listitem">
          ${face}
          <span class="community-voice-float__p-body">
            <span class="community-voice-float__p-name">${escapeHtml(displayName)}</span>
            <span class="community-voice-float__p-tags">${tagHtml}</span>
            ${actions}
          </span>
        </li>`
      })
      .join('')
  }

  private bind(): void {
    const s = this.state
    if (!s?.communityId) return
    const voice = getCommunityVoiceSession()

    this.root.querySelector('[data-toggle-roster]')?.addEventListener('click', (ev) => {
      ev.stopPropagation()
      this.rosterOpen = !this.rosterOpen
      this.render()
    })

    this.root.querySelector('[data-roster-close]')?.addEventListener('click', (ev) => {
      ev.stopPropagation()
      this.rosterOpen = false
      this.render()
    })

    // Don't close when interacting inside the stack
    this.root.querySelector('.community-voice-float__stack')?.addEventListener('click', (ev) => {
      ev.stopPropagation()
    })

    this.root.querySelector('[data-mic]')?.addEventListener('click', () => {
      void voice.setMicEnabled(!voice.getState().micEnabled)
    })

    this.root.querySelector('[data-hand]')?.addEventListener('click', () => {
      void voice.setHandRaised(!voice.isHandRaised())
    })

    const slider = this.root.querySelector<HTMLInputElement>('[data-volume]')
    slider?.addEventListener('input', () => {
      const v = Number(slider.value)
      if (Number.isFinite(v)) soundSettings.set({ voiceChatVolume: v })
      this.setSliderPct(slider)
    })
    if (slider) this.setSliderPct(slider)

    this.root.querySelector('[data-leave]')?.addEventListener('click', () => {
      if (this.leaving) return
      this.leaving = true
      this.rosterOpen = false
      this.render()
      void voice.leave().finally(() => {
        this.leaving = false
      })
    })

    this.bindModActions(voice)

    if (this.rosterOpen) this.attachOutsideClose()
    else this.detachOutsideClose()
  }

  private bindModActions(voice: ReturnType<typeof getCommunityVoiceSession>): void {
    const run = async (
      btn: HTMLButtonElement,
      action: () => Promise<{ ok: true } | { ok: false; error: string }>,
      busyLabel: string
    ): Promise<void> => {
      const prev = btn.textContent
      btn.disabled = true
      btn.textContent = busyLabel
      const result = await action()
      if (!result.ok) {
        btn.disabled = false
        btn.textContent = prev
        btn.title = result.error
        return
      }
      // Session emit re-renders roster when LiveKit state updates; re-enable if still present.
      btn.disabled = false
    }

    for (const btn of this.root.querySelectorAll<HTMLButtonElement>('[data-mod-accept]')) {
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation()
        const addr = btn.dataset.modAccept
        if (addr) void run(btn, () => voice.promoteSpeaker(addr), '…')
      })
    }
    for (const btn of this.root.querySelectorAll<HTMLButtonElement>('[data-mod-promote]')) {
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation()
        const addr = btn.dataset.modPromote
        if (addr) void run(btn, () => voice.promoteSpeaker(addr), '…')
      })
    }
    for (const btn of this.root.querySelectorAll<HTMLButtonElement>('[data-mod-demote]')) {
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation()
        const addr = btn.dataset.modDemote
        if (addr) void run(btn, () => voice.demoteSpeaker(addr), '…')
      })
    }
    for (const btn of this.root.querySelectorAll<HTMLButtonElement>('[data-mod-reject]')) {
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation()
        const addr = btn.dataset.modReject
        if (addr) void run(btn, () => voice.rejectSpeakRequest(addr), '…')
      })
    }
    for (const btn of this.root.querySelectorAll<HTMLButtonElement>('[data-mod-kick]')) {
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation()
        const addr = btn.dataset.modKick
        if (addr) void run(btn, () => voice.kickPlayer(addr), '…')
      })
    }
  }

  private attachOutsideClose(): void {
    if (this.onDocPointer) return
    this.onDocPointer = (ev: PointerEvent) => {
      if (!this.rosterOpen || this.disposed) return
      const t = ev.target
      if (t instanceof Node && this.root.contains(t)) return
      this.rosterOpen = false
      this.render()
    }
    // Next tick so the opening click doesn't immediately close.
    window.setTimeout(() => {
      if (this.onDocPointer) {
        document.addEventListener('pointerdown', this.onDocPointer, true)
      }
    }, 0)
  }

  private detachOutsideClose(): void {
    if (!this.onDocPointer) return
    document.removeEventListener('pointerdown', this.onDocPointer, true)
    this.onDocPointer = null
  }

  private syncVolumeSlider(): void {
    const slider = this.root.querySelector<HTMLInputElement>('[data-volume]')
    if (!slider) return
    slider.value = String(soundSettings.get().voiceChatVolume)
    this.setSliderPct(slider)
  }

  private setSliderPct(slider: HTMLInputElement): void {
    const min = Number(slider.min) || 0
    const max = Number(slider.max) || 100
    const val = Number(slider.value)
    const pct = max > min ? ((val - min) / (max - min)) * 100 : 0
    slider.style.setProperty('--pct', `${pct}%`)
  }
}
