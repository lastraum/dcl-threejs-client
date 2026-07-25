import type { PeSlotState } from '../../../dcl/multiScene/types'
import type { PortableExperienceManager } from '../../../dcl/multiScene/PortableExperienceManager'

export type PortableExperiencePanelOptions = {
  anchor: () => HTMLElement | undefined
  onClose?: () => void
}

/**
 * HUD Smart wearables / PE menu — per-PE enable + UI toggle.
 */
export class PortableExperiencePanel {
  readonly element: HTMLDivElement
  private manager: PortableExperienceManager | null = null
  private unsub: (() => void) | null = null
  private visible = false
  private readonly listEl: HTMLElement
  private readonly emptyEl: HTMLElement
  private readonly statusEl: HTMLElement

  constructor(private readonly options: PortableExperiencePanelOptions) {
    this.element = document.createElement('div')
    this.element.className = 'pe-panel'
    this.element.hidden = true
    this.element.innerHTML = `
      <header class="pe-panel__header">PORTABLE EXPERIENCES</header>
      <p class="pe-panel__status" data-status></p>
      <div class="pe-panel__list" data-list></div>
      <p class="pe-panel__empty" data-empty>No portable experiences detected on your avatar.</p>
      <p class="pe-panel__hint">Equip a smart wearable, then enable it here. Travel keeps enabled PEs without reloading.</p>
    `
    this.listEl = this.element.querySelector('[data-list]')!
    this.emptyEl = this.element.querySelector('[data-empty]')!
    this.statusEl = this.element.querySelector('[data-status]')!
    document.body.appendChild(this.element)
  }

  bindManager(manager: PortableExperienceManager | null): void {
    this.unsub?.()
    this.unsub = null
    this.manager = manager
    if (!manager) {
      this.render([])
      return
    }
    this.unsub = manager.subscribe((slots) => this.render(slots))
  }

  toggle(): void {
    if (this.visible) this.hide()
    else this.show()
  }

  show(): void {
    this.visible = true
    this.element.hidden = false
    this.position()
  }

  hide(): void {
    this.visible = false
    this.element.hidden = true
    this.options.onClose?.()
  }

  isVisible(): boolean {
    return this.visible
  }

  private position(): void {
    const anchor = this.options.anchor()
    if (!anchor) return
    const rect = anchor.getBoundingClientRect()
    const panelW = this.element.offsetWidth || 280
    const left = Math.min(window.innerWidth - panelW - 12, rect.right + 10)
    const top = Math.max(12, rect.top)
    this.element.style.left = `${left}px`
    this.element.style.top = `${top}px`
  }

  private render(slots: PeSlotState[]): void {
    this.listEl.innerHTML = ''
    const policy = this.manager?.getPePolicy()
    const sceneBlocks = policy ? !policy.allowed : false
    const sceneHidesUi = policy ? !policy.uiAllowed : false
    const running = slots.filter((s) => s.status === 'running').length

    if (sceneBlocks) {
      this.statusEl.textContent = 'This scene is overriding portable experiences'
      this.statusEl.hidden = false
    } else if (sceneHidesUi) {
      this.statusEl.textContent = 'This scene hides portable experience UI'
      this.statusEl.hidden = false
    } else {
      this.statusEl.textContent =
        slots.length === 0 ? '' : `${running} running · ${slots.length} available`
      this.statusEl.hidden = !this.statusEl.textContent
    }

    if (!slots.length) {
      this.emptyEl.hidden = false
      return
    }
    this.emptyEl.hidden = true

    for (const slot of slots) {
      const row = document.createElement('div')
      row.className = 'pe-panel__row'
      const running = slot.status === 'running'
      const blocked = slot.status === 'scene_blocked' || sceneBlocks
      const title = document.createElement('div')
      title.className = 'pe-panel__title'
      title.textContent = slot.candidate.title
      const sub = document.createElement('div')
      sub.className = 'pe-panel__sub'
      sub.textContent = blocked
        ? 'Scene is overriding'
        : running
          ? 'Running'
          : slot.wantEnabled
            ? 'Will restore…'
            : 'Off'

      const controls = document.createElement('div')
      controls.className = 'pe-panel__controls'

      // Enable toggle
      const enableLabel = document.createElement('label')
      enableLabel.className = 'pe-panel__switch'
      enableLabel.title = blocked
        ? 'This scene is overriding portable experiences'
        : 'Enable portable experience'
      const enableInput = document.createElement('input')
      enableInput.type = 'checkbox'
      enableInput.checked = running || slot.wantEnabled
      enableInput.disabled = blocked
      enableInput.addEventListener('change', () => {
        if (!this.manager) return
        if (enableInput.checked) void this.manager.enablePe(slot.candidate.id)
        else void this.manager.disablePe(slot.candidate.id)
      })
      const enableTrack = document.createElement('span')
      enableTrack.className = 'pe-panel__switch-track'
      enableLabel.append(enableInput, enableTrack)

      const enableText = document.createElement('span')
      enableText.className = 'pe-panel__ctl-label'
      enableText.textContent = 'On'

      // UI toggle — also disabled when scene hideUi / disabled
      const uiLabel = document.createElement('label')
      uiLabel.className = 'pe-panel__switch'
      uiLabel.title = sceneHidesUi || blocked
        ? 'This scene is overriding portable experience UI'
        : 'Show portable experience UI'
      const uiInput = document.createElement('input')
      uiInput.type = 'checkbox'
      uiInput.checked = sceneHidesUi || blocked ? false : slot.uiEnabled
      uiInput.disabled = blocked || sceneHidesUi || (!running && !slot.wantEnabled)
      uiInput.addEventListener('change', () => {
        this.manager?.setPeUiEnabled(slot.candidate.id, uiInput.checked)
      })
      const uiTrack = document.createElement('span')
      uiTrack.className = 'pe-panel__switch-track'
      uiLabel.append(uiInput, uiTrack)

      const uiText = document.createElement('span')
      uiText.className = 'pe-panel__ctl-label'
      uiText.textContent = 'UI'

      const enableWrap = document.createElement('div')
      enableWrap.className = 'pe-panel__ctl'
      enableWrap.append(enableText, enableLabel)

      const uiWrap = document.createElement('div')
      uiWrap.className = 'pe-panel__ctl'
      uiWrap.append(uiText, uiLabel)

      controls.append(enableWrap, uiWrap)

      const head = document.createElement('div')
      head.className = 'pe-panel__head'
      head.append(title, sub)

      row.append(head, controls)
      this.listEl.appendChild(row)
    }

    if (this.visible) this.position()
  }

  dispose(): void {
    this.unsub?.()
    this.unsub = null
    this.manager = null
    this.element.remove()
  }
}
