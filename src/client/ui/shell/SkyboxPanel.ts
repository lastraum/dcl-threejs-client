import type { EnvironmentSystem } from '../../../environment/EnvironmentSystem'
import {
  formatTimeOfDay,
  MINUTES_PER_DAY,
  secondsToSliderMinutes,
  sliderMinutesToSeconds
} from '../../../environment/skyboxTime'

export type SkyboxPanelOptions = {
  environment: EnvironmentSystem
  anchor: () => HTMLElement | undefined
  onClose?: () => void
}

const NUDGE_MINUTES = 15

/** NIGHT/DAY popup — Explorer-style manual skybox override + auto cycle toggle. */
export class SkyboxPanel {
  readonly element: HTMLDivElement
  private readonly autoToggle: HTMLInputElement
  private readonly customBlock: HTMLDivElement
  private readonly timeLabel: HTMLSpanElement
  private readonly slider: HTMLInputElement
  private visible = false
  private rafId = 0
  private environment: EnvironmentSystem

  constructor(private readonly options: SkyboxPanelOptions) {
    this.environment = options.environment
    this.element = document.createElement('div')
    this.element.className = 'skybox-panel'
    this.element.hidden = true
    this.element.innerHTML = `
      <header class="skybox-panel__header">NIGHT/DAY</header>
      <div class="skybox-panel__row">
        <span class="skybox-panel__label">Auto</span>
        <label class="skybox-panel__switch">
          <input type="checkbox" data-auto checked />
          <span class="skybox-panel__switch-track" aria-hidden="true"></span>
        </label>
      </div>
      <hr class="skybox-panel__divider" />
      <div class="skybox-panel__custom" data-custom>
        <div class="skybox-panel__row">
          <span class="skybox-panel__label">Custom</span>
          <span class="skybox-panel__time" data-time>12:00</span>
        </div>
        <div class="skybox-panel__slider-row">
          <button type="button" class="skybox-panel__nudge" data-prev aria-label="Earlier">‹</button>
          <input type="range" min="0" max="${MINUTES_PER_DAY}" step="1" value="720" data-slider />
          <button type="button" class="skybox-panel__nudge" data-next aria-label="Later">›</button>
        </div>
      </div>
    `

    this.autoToggle = this.element.querySelector('[data-auto]')!
    this.customBlock = this.element.querySelector('[data-custom]')!
    this.timeLabel = this.element.querySelector('[data-time]')!
    this.slider = this.element.querySelector('[data-slider]')!

    this.autoToggle.addEventListener('change', () => this.applyAuto(this.autoToggle.checked))
    this.slider.addEventListener('input', () => this.applyManual(Number(this.slider.value)))

    this.element.querySelector('[data-prev]')!.addEventListener('click', () => {
      this.nudge(-NUDGE_MINUTES)
    })
    this.element.querySelector('[data-next]')!.addEventListener('click', () => {
      this.nudge(NUDGE_MINUTES)
    })

    document.body.appendChild(this.element)
  }

  toggle(): void {
    if (this.visible) this.hide()
    else this.show()
  }

  show(): void {
    this.visible = true
    this.element.hidden = false
    this.syncFromEnvironment()
    this.positionNearAnchor()
    this.startLiveSync()
  }

  hide(): void {
    this.visible = false
    this.element.hidden = true
    this.stopLiveSync()
    this.options.onClose?.()
  }

  isVisible(): boolean {
    return this.visible
  }

  setEnvironment(environment: EnvironmentSystem): void {
    this.environment = environment
    if (this.visible) this.syncFromEnvironment()
  }

  private applyAuto(enabled: boolean): void {
    this.setCustomEnabled(!enabled)
    if (enabled) {
      this.environment.setUiCycleEnabled(true)
      this.syncFromEnvironment()
      return
    }
    const minutes = Number(this.slider.value)
    this.environment.setUiTimeOverride(sliderMinutesToSeconds(minutes))
    this.updateTimeLabel(minutes)
  }

  private applyManual(minutes: number): void {
    if (this.autoToggle.checked) {
      this.autoToggle.checked = false
      this.setCustomEnabled(true)
    }
    this.environment.setUiTimeOverride(sliderMinutesToSeconds(minutes))
    this.updateTimeLabel(minutes)
  }

  private nudge(deltaMinutes: number): void {
    const next = Math.max(0, Math.min(MINUTES_PER_DAY, Number(this.slider.value) + deltaMinutes))
    this.slider.value = String(next)
    this.applyManual(next)
  }

  private setCustomEnabled(enabled: boolean): void {
    this.customBlock.classList.toggle('is-disabled', !enabled)
    this.slider.disabled = !enabled
    for (const btn of this.element.querySelectorAll<HTMLButtonElement>('.skybox-panel__nudge')) {
      btn.disabled = !enabled
    }
  }

  private syncFromEnvironment(): void {
    const env = this.environment
    const auto = env.isUiAutoCycle()
    this.autoToggle.checked = auto
    this.setCustomEnabled(!auto)

    const minutes = secondsToSliderMinutes(env.getTimeOfDay())
    this.slider.value = String(minutes)
    this.updateTimeLabel(minutes)
  }

  private updateTimeLabel(minutes: number): void {
    this.timeLabel.textContent = formatTimeOfDay(sliderMinutesToSeconds(minutes))
  }

  private positionNearAnchor(): void {
    const anchor = this.options.anchor()
    if (!anchor) return
    const rect = anchor.getBoundingClientRect()
    const panelH = this.element.offsetHeight
    const top = Math.max(12, Math.min(window.innerHeight - panelH - 12, rect.top + rect.height / 2 - panelH / 2))
    this.element.style.top = `${top}px`
  }

  private startLiveSync(): void {
    this.stopLiveSync()
    const tick = () => {
      if (!this.visible) return
      if (this.autoToggle.checked) {
        const minutes = secondsToSliderMinutes(this.environment.getTimeOfDay())
        this.slider.value = String(minutes)
        this.updateTimeLabel(minutes)
      }
      this.rafId = requestAnimationFrame(tick)
    }
    this.rafId = requestAnimationFrame(tick)
  }

  private stopLiveSync(): void {
    if (this.rafId) cancelAnimationFrame(this.rafId)
    this.rafId = 0
  }
}
