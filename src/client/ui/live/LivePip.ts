/**
 * Draggable Live picture-in-picture.
 * - Expanded: title bar + video
 * - Accordion closed: title bar only (streamer name)
 * DOM video only — no scene VideoTexture.
 */

import Hls from 'hls.js'
import type { GlobalLiveMedia, LiveSession } from '../../../social/LiveDirectoryController'

export type LivePipOptions = {
  onClose?: (sessionId: string) => void
  /**
   * Attach DCL cast (scene LiveKit remote video) into the PiP body host.
   * Returns a cleanup function.
   */
  onCastAttach?: (
    host: HTMLElement,
    worldName: string,
    onUpdate: (attached: boolean) => void,
    opts: { muted: boolean }
  ) => Promise<() => void>
}

export class LivePip {
  readonly element: HTMLDivElement
  private readonly titleEl: HTMLElement
  private readonly bodyEl: HTMLElement
  private readonly video: HTMLVideoElement
  private hls: Hls | null = null
  private session: LiveSession | null = null
  private collapsed = false
  private drag: { ox: number; oy: number; sx: number; sy: number } | null = null
  private muted = true
  private castCleanup: (() => void) | null = null

  constructor(private readonly options: LivePipOptions = {}) {
    this.element = document.createElement('div')
    this.element.className = 'live-pip'
    this.element.hidden = true
    this.element.innerHTML = `
      <div class="live-pip__bar" data-bar>
        <button type="button" class="live-pip__collapse" data-collapse aria-label="Collapse stream" title="Collapse">▾</button>
        <span class="live-pip__title" data-title>Live</span>
        <button type="button" class="live-pip__mute" data-mute aria-label="Unmute" title="Unmute">🔇</button>
        <button type="button" class="live-pip__close" data-close aria-label="Close" title="Close">✕</button>
      </div>
      <div class="live-pip__body" data-body>
        <video class="live-pip__video" playsinline webkit-playsinline></video>
        <p class="live-pip__status" data-status></p>
      </div>
    `
    this.titleEl = this.element.querySelector('[data-title]')!
    this.bodyEl = this.element.querySelector('[data-body]')!
    this.video = this.element.querySelector('video')!
    this.video.muted = true
    this.video.playsInline = true
    this.video.autoplay = true

    const bar = this.element.querySelector('[data-bar]') as HTMLElement
    bar.addEventListener('pointerdown', (ev) => this.onBarPointerDown(ev))
    window.addEventListener('pointermove', this.onPointerMove)
    window.addEventListener('pointerup', this.onPointerUp)

    this.element.querySelector('[data-collapse]')!.addEventListener('click', (ev) => {
      ev.stopPropagation()
      this.setCollapsed(!this.collapsed)
    })
    this.element.querySelector('[data-mute]')!.addEventListener('click', (ev) => {
      ev.stopPropagation()
      this.setMuted(!this.muted)
    })
    this.element.querySelector('[data-close]')!.addEventListener('click', (ev) => {
      ev.stopPropagation()
      const id = this.session?.sessionId
      this.close()
      if (id) this.options.onClose?.(id)
    })

    document.body.appendChild(this.element)
    this.placeDefault()
  }

  isOpen(): boolean {
    return !this.element.hidden && !!this.session
  }

  getSessionId(): string | null {
    return this.session?.sessionId ?? null
  }

  open(session: LiveSession): void {
    if (this.session?.sessionId === session.sessionId && this.isOpen()) {
      this.setCollapsed(false)
      return
    }
    this.stopMedia()
    this.session = session
    this.titleEl.textContent = session.displayName || session.title || 'Live'
    this.element.hidden = false
    this.setCollapsed(false)
    this.setStatus('Connecting…')
    void this.loadMedia(session.media)
  }

  /** End because directory dropped the session. */
  endIfSession(sessionId: string): void {
    if (this.session?.sessionId === sessionId) this.close()
  }

  close(): void {
    this.stopMedia()
    this.session = null
    this.element.hidden = true
  }

  dispose(): void {
    this.close()
    window.removeEventListener('pointermove', this.onPointerMove)
    window.removeEventListener('pointerup', this.onPointerUp)
    this.element.remove()
  }

  private setCollapsed(on: boolean): void {
    this.collapsed = on
    this.element.classList.toggle('is-collapsed', on)
    this.bodyEl.hidden = on
    const btn = this.element.querySelector('[data-collapse]') as HTMLButtonElement
    btn.textContent = on ? '▸' : '▾'
    btn.setAttribute('aria-label', on ? 'Expand stream' : 'Collapse stream')
    btn.title = on ? 'Expand' : 'Collapse'
  }

  private setMuted(on: boolean): void {
    this.muted = on
    this.video.muted = on
    const btn = this.element.querySelector('[data-mute]') as HTMLButtonElement
    btn.textContent = on ? '🔇' : '🔊'
    btn.title = on ? 'Unmute' : 'Mute'
    btn.setAttribute('aria-label', on ? 'Unmute' : 'Mute')
    if (!on) void this.video.play().catch(() => {})
  }

  private setStatus(text: string): void {
    const el = this.element.querySelector('[data-status]') as HTMLElement
    el.textContent = text
    el.hidden = !text
  }

  private async loadMedia(media: GlobalLiveMedia): Promise<void> {
    this.stopMedia(false)
    if (media.type === 'dcl-cast') {
      this.video.hidden = true
      this.setStatus(`Connecting to ${media.worldName}…`)
      if (!this.options.onCastAttach) {
        this.setStatus(`DCL cast: ${media.worldName} (watch unavailable)`)
        return
      }
      try {
        this.castCleanup = await this.options.onCastAttach(
          this.bodyEl,
          media.worldName,
          (attached) => {
            if (attached) this.setStatus('')
            else this.setStatus(`Waiting for stream on ${media.worldName}…`)
          },
          { muted: this.muted }
        )
      } catch (e) {
        this.setStatus(e instanceof Error ? e.message : 'Cast connect failed')
      }
      return
    }
    this.video.hidden = false
    const url = media.url
    try {
      if (media.type === 'hls' || url.toLowerCase().includes('.m3u8')) {
        if (Hls.isSupported()) {
          const hls = new Hls({ enableWorker: true, lowLatencyMode: true })
          this.hls = hls
          hls.loadSource(url)
          hls.attachMedia(this.video)
          hls.on(Hls.Events.MANIFEST_PARSED, () => {
            this.setStatus('')
            void this.video.play().catch(() => this.setStatus('Tap unmute / play'))
          })
          hls.on(Hls.Events.ERROR, (_e, data) => {
            if (data.fatal) this.setStatus('Stream error')
          })
          return
        }
        if (this.video.canPlayType('application/vnd.apple.mpegurl')) {
          this.video.src = url
          await this.video.play().catch(() => {})
          this.setStatus('')
          return
        }
        this.setStatus('HLS not supported')
        return
      }
      this.video.src = url
      this.video.addEventListener(
        'loadeddata',
        () => {
          this.setStatus('')
          void this.video.play().catch(() => this.setStatus('Tap unmute / play'))
        },
        { once: true }
      )
      this.video.addEventListener(
        'error',
        () => this.setStatus('Could not play stream'),
        { once: true }
      )
    } catch {
      this.setStatus('Could not open stream')
    }
  }

  private stopMedia(clearSrc = true): void {
    try {
      this.castCleanup?.()
    } catch {
      /* ignore */
    }
    this.castCleanup = null
    try {
      this.hls?.destroy()
    } catch {
      /* ignore */
    }
    this.hls = null
    this.video.pause()
    if (clearSrc) {
      this.video.removeAttribute('src')
      this.video.load()
    }
  }

  private placeDefault(): void {
    const w = 360
    const h = 240
    const left = Math.max(12, window.innerWidth - w - 24)
    const top = Math.max(12, window.innerHeight - h - 96)
    this.element.style.left = `${left}px`
    this.element.style.top = `${top}px`
  }

  private onBarPointerDown = (ev: PointerEvent): void => {
    if ((ev.target as HTMLElement).closest('button')) return
    const rect = this.element.getBoundingClientRect()
    this.drag = { ox: ev.clientX, oy: ev.clientY, sx: rect.left, sy: rect.top }
    this.element.classList.add('is-dragging')
    try {
      ;(ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId)
    } catch {
      /* ignore */
    }
  }

  private onPointerMove = (ev: PointerEvent): void => {
    if (!this.drag) return
    const dx = ev.clientX - this.drag.ox
    const dy = ev.clientY - this.drag.oy
    const left = Math.min(window.innerWidth - 80, Math.max(0, this.drag.sx + dx))
    const top = Math.min(window.innerHeight - 40, Math.max(0, this.drag.sy + dy))
    this.element.style.left = `${left}px`
    this.element.style.top = `${top}px`
  }

  private onPointerUp = (): void => {
    if (!this.drag) return
    this.drag = null
    this.element.classList.remove('is-dragging')
  }
}
