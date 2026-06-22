import {
  LOADING_FALLBACK_IMAGE,
  LOADING_FEATURED_SLIDES,
  type LoadingFeaturedSlide
} from './loadingFeaturedContent'
import { progressFromStatus } from './loadingProgress'
import type { WaitForSceneAssetsResult, SceneHydrationStats } from '../../rendering/sceneHydration'

const POST_LOAD_HOLD_MS = 800
/** After world.start() — let composite spawn / colliders settle before revealing UI. */
export const POST_SPAWN_SETTLE_MS = 5000
export const POST_SPAWN_SETTLE_FAST_MS = 1500
const SLIDE_INTERVAL_MS = 5500
const BODY_LOADING_CLASS = 'client-loading'
const PROGRESS_LERP = 0.12

function formatDurationMs(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(totalSec / 60)
  const seconds = totalSec % 60
  return `${minutes}:${seconds.toString().padStart(2, '0')}`
}

/** Full-screen loading overlay — Unity-style top progress bar + featured carousel. */
export class LoadingScreen {
  private readonly root: HTMLElement
  private readonly progressFill: HTMLElement
  private readonly statusEl: HTMLElement
  private readonly hydrationTimerEl: HTMLElement
  private readonly hydrationTimeEl: HTMLElement
  private readonly hydrationLabelEl: HTMLElement
  private readonly hydrationDetailEl: HTMLElement
  private readonly errorPanelEl: HTMLElement
  private readonly errorTitleEl: HTMLElement
  private readonly errorDetailEl: HTMLElement
  private readonly slideA: HTMLElement
  private readonly slideB: HTMLElement
  private readonly dotsEl: HTMLElement
  private readonly fast: boolean
  private disposed = false
  private targetProgress = 0
  private displayedProgress = 0
  private slideIndex = 0
  private activeSlideEl: HTMLElement
  private idleSlideEl: HTMLElement
  private slideTimer = 0
  private animFrame = 0
  private flipping = false
  /** Elapsed-time clock for the full load pipeline (assets → spawn → prewarm → reveal). */
  private loadingStartedAt = 0
  /** Hydration hard-timeout — adds warning styling once elapsed, does not stop the clock. */
  private hydrationTimeoutMs = 0
  private hydrationTimedOut = false

  constructor(initialStatus = 'Loading world…', options: { fast?: boolean } = {}) {
    this.fast = options.fast ?? false
    this.root = document.createElement('div')
    this.root.className = 'loading-screen'
    this.root.innerHTML = `
      <div class="loading-screen__progress" aria-hidden="true">
        <div class="loading-screen__progress-track">
          <div class="loading-screen__progress-fill"></div>
        </div>
      </div>
      <div class="loading-screen__layout">
        <div class="loading-screen__featured" aria-live="polite">
          <div class="loading-screen__slide loading-screen__slide--active" data-slide="a"></div>
          <div class="loading-screen__slide" data-slide="b"></div>
        </div>
        <div class="loading-screen__dots" role="tablist" aria-label="Featured content"></div>
        <div class="loading-screen__hydration-timer" hidden aria-live="polite">
          <span class="loading-screen__hydration-label">Loading time</span>
          <span class="loading-screen__hydration-time">0:00</span>
          <span class="loading-screen__hydration-detail">Waiting for scene assets…</span>
        </div>
        <div class="loading-screen__error" hidden role="alert" aria-live="assertive">
          <p class="loading-screen__error-title"></p>
          <p class="loading-screen__error-detail"></p>
        </div>
        <p class="loading-screen__status" hidden aria-hidden="true">${initialStatus}</p>
      </div>
    `

    this.progressFill = this.root.querySelector('.loading-screen__progress-fill')!
    this.statusEl = this.root.querySelector('.loading-screen__status')!
    this.hydrationTimerEl = this.root.querySelector('.loading-screen__hydration-timer')!
    this.hydrationTimeEl = this.root.querySelector('.loading-screen__hydration-time')!
    this.hydrationLabelEl = this.root.querySelector('.loading-screen__hydration-label')!
    this.hydrationDetailEl = this.root.querySelector('.loading-screen__hydration-detail')!
    this.errorPanelEl = this.root.querySelector('.loading-screen__error')!
    this.errorTitleEl = this.root.querySelector('.loading-screen__error-title')!
    this.errorDetailEl = this.root.querySelector('.loading-screen__error-detail')!
    this.slideA = this.root.querySelector('[data-slide="a"]')!
    this.slideB = this.root.querySelector('[data-slide="b"]')!
    this.dotsEl = this.root.querySelector('.loading-screen__dots')!
    this.activeSlideEl = this.slideA
    this.idleSlideEl = this.slideB

    this.renderDots()
    this.paintSlide(this.activeSlideEl, LOADING_FEATURED_SLIDES[0]!)
  }

  mount(): void {
    document.body.classList.add(BODY_LOADING_CLASS)
    document.body.appendChild(this.root)
    this.targetProgress = 0.02
    this.displayedProgress = 0
    this.updateProgressBar()
    this.slideTimer = window.setInterval(() => this.advanceSlide(), SLIDE_INTERVAL_MS)
    this.tickProgress()
  }

  setStatus(text: string, isError = false): void {
    if (this.disposed) return
    this.statusEl.textContent = text
    this.statusEl.classList.toggle('is-error', isError)
    if (!isError) {
      this.targetProgress = progressFromStatus(text, this.targetProgress)
      if (this.loadingStartedAt > 0) {
        this.hydrationDetailEl.textContent = text
      }
    }
  }

  /**
   * Fatal scene load — keep overlay visible with a clear message (do not call `finish()`).
   */
  showFatalError(title: string, detail: string): void {
    if (this.disposed) return
    this.root.classList.add('is-error')
    this.errorTitleEl.textContent = title
    this.errorDetailEl.textContent = detail
    this.errorPanelEl.hidden = false
    this.hydrationTimerEl.hidden = true
    window.clearInterval(this.slideTimer)
    this.finishLoadingTimer()
    this.hydrationLabelEl.textContent = 'Load failed'
    this.hydrationTimeEl.textContent = ''
    this.hydrationDetailEl.textContent = detail
    this.hydrationTimerEl.hidden = false
    this.hydrationTimerEl.classList.add('is-error')
    this.targetProgress = 0
    this.displayedProgress = 0
    this.updateProgressBar()
  }

  setProgress(fraction: number): void {
    if (this.disposed) return
    this.targetProgress = Math.max(this.targetProgress, Math.min(1, fraction))
  }

  /** Start the visible load clock — runs until `finish()` is about to hide the overlay. */
  startLoadingTimer(): void {
    if (this.disposed) return
    this.loadingStartedAt = performance.now()
    this.hydrationTimeoutMs = 0
    this.hydrationTimedOut = false
    this.hydrationTimerEl.hidden = false
    this.hydrationTimerEl.classList.remove('is-ready', 'is-timeout')
    this.hydrationLabelEl.textContent = 'Loading time'
    this.hydrationTimeEl.textContent = '0:00'
    this.hydrationDetailEl.textContent = 'Preparing…'
  }

  /** Asset hydration hard timeout — warning styling only; clock keeps running. */
  setHydrationTimeoutMs(timeoutMs: number): void {
    if (this.disposed) return
    this.hydrationTimeoutMs = timeoutMs
  }

  setHydrationStats(stats: SceneHydrationStats): void {
    if (this.disposed || this.loadingStartedAt <= 0) return
    const blocking = Math.max(0, stats.gltfPending - stats.gltfAbandoned)
    const parts = [`${stats.gltfLoaded}/${stats.gltfEntities} attached`]
    if (blocking > 0) parts.push(`${blocking} blocking`)
    if (stats.gltfAbandoned > 0) parts.push(`${stats.gltfAbandoned} skipped`)
    if (stats.gltfInflight > 0) parts.push(`${stats.gltfInflight} downloading`)
    else if (blocking > 0) parts.push('0 downloading')
    this.hydrationDetailEl.textContent = parts.join(' · ')
  }

  /** Hydration gate passed or timed out — update detail only; clock continues through spawn/prewarm. */
  noteHydrationComplete(result: WaitForSceneAssetsResult): void {
    if (this.disposed || this.loadingStartedAt <= 0) return
    this.hydrationTimedOut = result.timedOut
    if (result.timedOut) {
      this.hydrationTimerEl.classList.add('is-timeout')
      this.hydrationDetailEl.textContent = 'Assets still loading — finishing spawn & collisions…'
    } else {
      this.hydrationDetailEl.textContent = 'Scene models attached — preparing collisions…'
    }
  }

  isMounted(): boolean {
    return !this.disposed
  }

  async finish(loadPromise: Promise<unknown>, options: { skipHold?: boolean } = {}): Promise<void> {
    await loadPromise
    this.finishLoadingTimer()
    this.targetProgress = 1
    if (!this.fast && !options.skipHold) {
      await new Promise((r) => setTimeout(r, POST_LOAD_HOLD_MS))
    }
    this.dispose()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    document.body.classList.remove(BODY_LOADING_CLASS)
    window.clearInterval(this.slideTimer)
    if (this.animFrame) cancelAnimationFrame(this.animFrame)
    this.root.classList.add('is-hiding')
    window.setTimeout(() => this.root.remove(), 360)
  }

  private tickProgress = (): void => {
    if (this.disposed) return
    const delta = this.targetProgress - this.displayedProgress
    if (Math.abs(delta) > 0.001) {
      this.displayedProgress += delta * PROGRESS_LERP
      this.updateProgressBar()
    } else if (this.displayedProgress !== this.targetProgress) {
      this.displayedProgress = this.targetProgress
      this.updateProgressBar()
    }
    if (this.loadingStartedAt > 0) {
      this.updateLoadingTimer()
    }
    this.animFrame = requestAnimationFrame(this.tickProgress)
  }

  private updateProgressBar(): void {
    const pct = `${Math.round(this.displayedProgress * 1000) / 10}%`
    this.progressFill.style.width = pct
    this.root.style.setProperty('--loading-progress', String(this.displayedProgress))
  }

  private finishLoadingTimer(): void {
    if (this.disposed || this.loadingStartedAt <= 0) return
    const elapsed = performance.now() - this.loadingStartedAt
    this.loadingStartedAt = 0
    this.hydrationTimeoutMs = 0
    this.hydrationTimeEl.textContent = formatDurationMs(elapsed)
    this.hydrationTimerEl.classList.toggle('is-ready', !this.hydrationTimedOut)
    this.hydrationTimerEl.classList.toggle('is-timeout', this.hydrationTimedOut)
    this.hydrationLabelEl.textContent = this.hydrationTimedOut ? 'Ready (assets in background)' : 'Ready'
    this.hydrationDetailEl.textContent = 'Entering scene…'
  }

  private updateLoadingTimer(): void {
    if (this.disposed || this.loadingStartedAt <= 0) return
    const elapsed = performance.now() - this.loadingStartedAt
    this.hydrationTimeEl.textContent = formatDurationMs(elapsed)
    if (this.hydrationTimeoutMs > 0 && elapsed >= this.hydrationTimeoutMs) {
      this.hydrationTimerEl.classList.add('is-timeout')
    }
  }

  private renderDots(): void {
    this.dotsEl.innerHTML = LOADING_FEATURED_SLIDES.map(
      (_, index) =>
        `<span class="loading-screen__dot${index === 0 ? ' is-active' : ''}" role="presentation"></span>`
    ).join('')
  }

  private updateDots(): void {
    const dots = this.dotsEl.querySelectorAll('.loading-screen__dot')
    dots.forEach((dot, index) => {
      dot.classList.toggle('is-active', index === this.slideIndex)
    })
  }

  private paintSlide(el: HTMLElement, slide: LoadingFeaturedSlide): void {
    el.innerHTML = `
      <div class="loading-screen__slide-media">
        <img src="${slide.imageUrl}" alt="" decoding="async" />
        <div class="loading-screen__slide-shade"></div>
      </div>
      <div class="loading-screen__slide-copy">
        <span class="loading-screen__slide-tag">${slide.tag}</span>
        <h2 class="loading-screen__slide-title">${slide.title}</h2>
        <p class="loading-screen__slide-subtitle">${slide.subtitle}</p>
      </div>
    `

    const media = el.querySelector('.loading-screen__slide-media') as HTMLElement | null
    const img = el.querySelector('img') as HTMLImageElement | null
    if (!media || !img) return

    img.addEventListener(
      'error',
      () => {
        img.remove()
        media.classList.add('loading-screen__slide-media--fallback')
        media.style.backgroundImage = `url("${LOADING_FALLBACK_IMAGE}")`
      },
      { once: true }
    )
  }

  private advanceSlide(): void {
    if (this.disposed || this.flipping) return
    const nextIndex = (this.slideIndex + 1) % LOADING_FEATURED_SLIDES.length
    const nextSlide = LOADING_FEATURED_SLIDES[nextIndex]
    if (!nextSlide) return

    this.flipping = true
    this.paintSlide(this.idleSlideEl, nextSlide)
    this.idleSlideEl.classList.add('loading-screen__slide--enter')
    this.activeSlideEl.classList.add('loading-screen__slide--exit')

    window.setTimeout(() => {
      if (this.disposed) return
      this.activeSlideEl.classList.remove('loading-screen__slide--active', 'loading-screen__slide--exit')
      this.idleSlideEl.classList.remove('loading-screen__slide--enter')
      this.idleSlideEl.classList.add('loading-screen__slide--active')

      const previousActive = this.activeSlideEl
      this.activeSlideEl = this.idleSlideEl
      this.idleSlideEl = previousActive
      this.slideIndex = nextIndex
      this.updateDots()
      this.flipping = false
    }, 420)
  }
}
