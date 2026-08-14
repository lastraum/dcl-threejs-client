/**
 * Draggable / resizable Live picture-in-picture (desktop).
 * - Accordion: title bar only
 * - Fullscreen: browser Fullscreen API on the PiP shell
 * - DOM video only — no scene VideoTexture
 */

import Hls from 'hls.js'
import type { GlobalLiveMedia, LiveSession } from '../../../social/LiveDirectoryController'

export type LivePipOptions = {
  onClose?: (sessionId: string) => void
  onCastAttach?: (
    host: HTMLElement,
    worldName: string,
    onUpdate: (attached: boolean) => void,
    opts: { muted: boolean }
  ) => Promise<() => void>
}

const MIN_W = 280
const MIN_H = 160
const DEFAULT_W = 400
const DEFAULT_H = 260

type ResizeCorner = 'nw' | 'ne' | 'sw' | 'se'

type ResizeState = {
  ox: number
  oy: number
  sw: number
  sh: number
  left: number
  top: number
  corner: ResizeCorner
}

export class LivePip {
  readonly element: HTMLDivElement
  private readonly titleEl: HTMLElement
  private readonly bodyEl: HTMLElement
  private readonly videoHost: HTMLElement
  private readonly statusEl: HTMLElement
  private readonly video: HTMLVideoElement
  private readonly resizeHandles: HTMLElement[]
  private hls: Hls | null = null
  private session: LiveSession | null = null
  private collapsed = false
  private fullscreen = false
  private drag: { ox: number; oy: number; sx: number; sy: number } | null = null
  private resize: ResizeState | null = null
  private muted = true
  private castCleanup: (() => void) | null = null
  private disposed = false
  private pipW = DEFAULT_W
  private pipH = DEFAULT_H

  constructor(private readonly options: LivePipOptions = {}) {
    this.element = document.createElement('div')
    this.element.className = 'live-pip'
    this.element.hidden = true
    this.element.innerHTML = `
      <div class="live-pip__bar" data-bar>
        <button type="button" class="live-pip__icon-btn" data-collapse aria-label="Collapse" title="Collapse">▾</button>
        <span class="live-pip__title" data-title>Live</span>
        <button type="button" class="live-pip__icon-btn" data-mute aria-label="Unmute" title="Unmute">🔇</button>
        <button type="button" class="live-pip__icon-btn" data-fs aria-label="Fullscreen" title="Fullscreen">⛶</button>
        <button type="button" class="live-pip__icon-btn" data-close aria-label="Close" title="Close">✕</button>
      </div>
      <div class="live-pip__body" data-body>
        <div class="live-pip__video-host" data-video-host>
          <video class="live-pip__video" playsinline webkit-playsinline></video>
        </div>
        <p class="live-pip__status" data-status></p>
      </div>
      <div class="live-pip__resize live-pip__resize--nw" data-resize="nw" title="Resize" aria-label="Resize from top-left"></div>
      <div class="live-pip__resize live-pip__resize--ne" data-resize="ne" title="Resize" aria-label="Resize from top-right"></div>
      <div class="live-pip__resize live-pip__resize--sw" data-resize="sw" title="Resize" aria-label="Resize from bottom-left"></div>
      <div class="live-pip__resize live-pip__resize--se" data-resize="se" title="Resize" aria-label="Resize from bottom-right"></div>
    `
    this.titleEl = this.element.querySelector('[data-title]')!
    this.bodyEl = this.element.querySelector('[data-body]')!
    this.videoHost = this.element.querySelector('[data-video-host]')!
    this.statusEl = this.element.querySelector('[data-status]')!
    this.video = this.element.querySelector('video')!
    this.resizeHandles = [
      ...this.element.querySelectorAll<HTMLElement>('[data-resize]')
    ]
    this.video.muted = true
    this.video.playsInline = true
    this.video.autoplay = true

    const bar = this.element.querySelector('[data-bar]') as HTMLElement
    bar.addEventListener('pointerdown', (ev) => this.onBarPointerDown(ev))
    for (const handle of this.resizeHandles) {
      handle.addEventListener('pointerdown', (ev) => this.onResizePointerDown(ev, handle))
    }
    window.addEventListener('pointermove', this.onPointerMove)
    window.addEventListener('pointerup', this.onPointerUp)
    document.addEventListener('fullscreenchange', this.onFullscreenChange)

    this.element.querySelector('[data-collapse]')!.addEventListener('click', (ev) => {
      ev.stopPropagation()
      if (this.fullscreen) void this.exitFullscreen()
      this.setCollapsed(!this.collapsed)
    })
    this.element.querySelector('[data-mute]')!.addEventListener('click', (ev) => {
      ev.stopPropagation()
      this.setMuted(!this.muted)
    })
    this.element.querySelector('[data-fs]')!.addEventListener('click', (ev) => {
      ev.stopPropagation()
      void this.toggleFullscreen()
    })
    this.element.querySelector('[data-close]')!.addEventListener('click', (ev) => {
      ev.stopPropagation()
      const id = this.session?.sessionId
      this.close()
      if (id) this.options.onClose?.(id)
    })

    document.body.appendChild(this.element)
    this.applySize()
    this.placeDefault()
  }

  isOpen(): boolean {
    return !this.element.hidden && !!this.session
  }

  getSessionId(): string | null {
    return this.session?.sessionId ?? null
  }

  open(session: LiveSession): void {
    if (this.disposed) return
    if (this.session?.sessionId === session.sessionId && this.isOpen()) {
      this.setCollapsed(false)
      return
    }
    this.stopMedia()
    this.session = session
    this.titleEl.textContent = session.displayName || session.title || 'Live'
    this.element.hidden = false
    this.element.removeAttribute('hidden')
    this.setCollapsed(false)
    this.setStatus('Connecting…')
    void this.loadMedia(session.media)
  }

  endIfSession(sessionId: string): void {
    if (this.session?.sessionId === sessionId) this.close()
  }

  close(): void {
    if (this.fullscreen) void this.exitFullscreen()
    this.stopMedia()
    this.session = null
    this.element.hidden = true
    this.element.setAttribute('hidden', '')
  }

  dispose(): void {
    this.disposed = true
    this.close()
    window.removeEventListener('pointermove', this.onPointerMove)
    window.removeEventListener('pointerup', this.onPointerUp)
    document.removeEventListener('fullscreenchange', this.onFullscreenChange)
    this.element.remove()
  }

  private setCollapsed(on: boolean): void {
    this.collapsed = on
    this.element.classList.toggle('is-collapsed', on)
    this.bodyEl.hidden = on
    this.setResizeHandlesVisible(!on && !this.fullscreen)
    const btn = this.element.querySelector('[data-collapse]') as HTMLButtonElement | null
    if (btn) {
      btn.textContent = on ? '▸' : '▾'
      btn.setAttribute('aria-label', on ? 'Expand stream' : 'Collapse stream')
      btn.title = on ? 'Expand' : 'Collapse'
    }
  }

  private setResizeHandlesVisible(visible: boolean): void {
    for (const h of this.resizeHandles) {
      h.hidden = !visible
      if (visible) h.removeAttribute('hidden')
      else h.setAttribute('hidden', '')
    }
  }

  private setMuted(on: boolean): void {
    this.muted = on
    this.video.muted = on
    // Cast-attached videos live in videoHost
    this.videoHost.querySelectorAll('video, audio').forEach((node) => {
      const m = node as HTMLMediaElement
      m.muted = on
      if (!on) m.volume = 1
    })
    const btn = this.element.querySelector('[data-mute]') as HTMLButtonElement | null
    if (btn) {
      btn.textContent = on ? '🔇' : '🔊'
      btn.title = on ? 'Unmute' : 'Mute'
      btn.setAttribute('aria-label', on ? 'Unmute' : 'Mute')
    }
    if (!on) {
      void this.video.play().catch(() => {})
      this.videoHost.querySelectorAll('video').forEach((v) => {
        void (v as HTMLVideoElement).play().catch(() => {})
      })
    }
  }

  private setStatus(text: string): void {
    if (this.disposed || !this.statusEl?.isConnected) return
    this.statusEl.textContent = text
    this.statusEl.hidden = !text
  }

  private async toggleFullscreen(): Promise<void> {
    if (this.collapsed) this.setCollapsed(false)
    if (document.fullscreenElement === this.element) {
      await this.exitFullscreen()
      return
    }
    try {
      await this.element.requestFullscreen()
    } catch {
      this.setStatus('Fullscreen blocked by browser')
    }
  }

  private async exitFullscreen(): Promise<void> {
    if (document.fullscreenElement === this.element) {
      try {
        await document.exitFullscreen()
      } catch {
        /* ignore */
      }
    }
  }

  private onFullscreenChange = (): void => {
    this.fullscreen = document.fullscreenElement === this.element
    this.element.classList.toggle('is-fullscreen', this.fullscreen)
    this.setResizeHandlesVisible(!this.fullscreen && !this.collapsed)
    const btn = this.element.querySelector('[data-fs]') as HTMLButtonElement | null
    if (btn) {
      btn.textContent = this.fullscreen ? '⛶' : '⛶'
      btn.title = this.fullscreen ? 'Exit fullscreen' : 'Fullscreen'
      btn.setAttribute('aria-label', btn.title)
    }
  }

  private async loadMedia(media: GlobalLiveMedia): Promise<void> {
    if (this.disposed) return
    this.stopMedia(false)
    if (media.type === 'dcl-cast') {
      this.video.hidden = true
      this.setStatus(`Connecting to ${media.worldName}…`)
      if (!this.options.onCastAttach) {
        this.setStatus(`DCL cast: ${media.worldName} (watch unavailable)`)
        return
      }
      try {
        // Attach into videoHost only — never wipe status/bar via replaceChildren on body.
        this.castCleanup = await this.options.onCastAttach(
          this.videoHost,
          media.worldName,
          (attached) => {
            if (this.disposed || !this.session) return
            if (attached) this.setStatus('')
            else this.setStatus(`Waiting for stream on ${media.worldName}…`)
          },
          { muted: this.muted }
        )
      } catch (e) {
        if (!this.disposed) {
          this.setStatus(e instanceof Error ? e.message : 'Cast connect failed')
        }
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
      try {
        this.video.load()
      } catch {
        /* ignore */
      }
      // Leave only the built-in video element in host after cast clear.
      if (!this.videoHost.contains(this.video)) {
        this.videoHost.replaceChildren(this.video)
      }
    }
  }

  private applySize(): void {
    this.element.style.width = `${this.pipW}px`
    this.element.style.height = this.collapsed ? 'auto' : `${this.pipH}px`
  }

  private placeDefault(): void {
    const left = Math.max(12, window.innerWidth - this.pipW - 24)
    const top = Math.max(12, window.innerHeight - this.pipH - 96)
    this.element.style.left = `${left}px`
    this.element.style.top = `${top}px`
  }

  private onBarPointerDown = (ev: PointerEvent): void => {
    if (this.fullscreen) return
    if ((ev.target as HTMLElement).closest('button')) return
    const rect = this.element.getBoundingClientRect()
    this.drag = { ox: ev.clientX, oy: ev.clientY, sx: rect.left, sy: rect.top }
    this.resize = null
    this.element.classList.add('is-dragging')
    try {
      ;(ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId)
    } catch {
      /* ignore */
    }
  }

  private onResizePointerDown = (ev: PointerEvent, handle: HTMLElement): void => {
    if (this.fullscreen || this.collapsed) return
    ev.preventDefault()
    ev.stopPropagation()
    const corner = (handle.dataset.resize as ResizeCorner | undefined) ?? 'se'
    const rect = this.element.getBoundingClientRect()
    this.resize = {
      ox: ev.clientX,
      oy: ev.clientY,
      sw: rect.width,
      sh: rect.height,
      left: rect.left,
      top: rect.top,
      corner
    }
    this.drag = null
    this.element.classList.add('is-resizing')
    try {
      handle.setPointerCapture(ev.pointerId)
    } catch {
      /* ignore */
    }
  }

  private onPointerMove = (ev: PointerEvent): void => {
    if (this.drag) {
      const dx = ev.clientX - this.drag.ox
      const dy = ev.clientY - this.drag.oy
      const left = Math.min(window.innerWidth - 80, Math.max(0, this.drag.sx + dx))
      const top = Math.min(window.innerHeight - 40, Math.max(0, this.drag.sy + dy))
      this.element.style.left = `${left}px`
      this.element.style.top = `${top}px`
      return
    }
    if (this.resize) {
      const { ox, oy, sw, sh, left, top, corner } = this.resize
      const dx = ev.clientX - ox
      const dy = ev.clientY - oy
      const maxW = window.innerWidth - 24
      const maxH = window.innerHeight - 24

      let nextW = sw
      let nextH = sh
      let nextLeft = left
      let nextTop = top

      if (corner === 'se' || corner === 'ne') {
        nextW = Math.min(maxW, Math.max(MIN_W, sw + dx))
      } else {
        // nw / sw — grow leftward; keep right edge fixed
        nextW = Math.min(maxW, Math.max(MIN_W, sw - dx))
        nextLeft = left + (sw - nextW)
      }

      if (corner === 'se' || corner === 'sw') {
        nextH = Math.min(maxH, Math.max(MIN_H, sh + dy))
      } else {
        // nw / ne — grow upward; keep bottom edge fixed
        nextH = Math.min(maxH, Math.max(MIN_H, sh - dy))
        nextTop = top + (sh - nextH)
      }

      // Keep box on-screen
      nextLeft = Math.min(window.innerWidth - 80, Math.max(0, nextLeft))
      nextTop = Math.min(window.innerHeight - 40, Math.max(0, nextTop))

      this.pipW = nextW
      this.pipH = nextH
      this.element.style.left = `${nextLeft}px`
      this.element.style.top = `${nextTop}px`
      this.applySize()
    }
  }

  private onPointerUp = (): void => {
    if (this.drag) {
      this.drag = null
      this.element.classList.remove('is-dragging')
    }
    if (this.resize) {
      this.resize = null
      this.element.classList.remove('is-resizing')
    }
  }
}
