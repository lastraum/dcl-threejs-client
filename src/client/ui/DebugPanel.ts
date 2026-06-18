import { clientDebugLog } from '../debug/ClientDebugLog'
import { physxColliderDebug, type PhysxColliderDebugOptions } from '../../debug/PhysxColliderDebug'
import {
  LIGHT_LIMITS,
  MAX_SHADOW_SPOT_LIGHTS,
  LIGHT_CULL_DISTANCE_M,
  renderQuality,
  RenderQualityTier,
  type RenderQualityOptions
} from '../../rendering/RenderQualitySettings'
import type { RenderStats } from './RenderStats'

export type DebugPanelPosition = {
  x: number
  y: number
  z: number
}

export type DebugPanelSceneOrigin = {
  x: number
  z: number
}

export type DebugPanelOptions = {
  anchor: () => HTMLElement | undefined
  renderStats: RenderStats
  onVisibilityChange?: (visible: boolean) => void
  getPlayerPosition?: () => DebugPanelPosition | null
  getSceneOrigin?: () => DebugPanelSceneOrigin
  onRecookColliders?: () => void
}

/** Top-right debug overlay — toggled from the Help sidebar button. */
export class DebugPanel {
  readonly root: HTMLDivElement
  private readonly body: HTMLDivElement
  private readonly physxSceneToggle: HTMLInputElement
  private readonly physxGltfToggle: HTMLInputElement
  private readonly physxPlayerToggle: HTMLInputElement
  private readonly physxProbeToggle: HTMLInputElement
  private readonly physxRecookBtn: HTMLButtonElement
  private readonly renderQualitySelect: HTMLSelectElement
  private readonly renderQualityHint: HTMLDivElement
  private readonly positionLocalEl: HTMLDivElement
  private readonly positionWorldEl: HTMLDivElement
  private readonly logsBody: HTMLDivElement
  private readonly anchor: () => HTMLElement | undefined
  private readonly onVisibilityChange?: (visible: boolean) => void
  private readonly getPlayerPosition?: () => DebugPanelPosition | null
  private readonly getSceneOrigin?: () => DebugPanelSceneOrigin
  private visible = false
  private ignoreOutsideClick = false
  private positionRafId = 0
  private unsubscribeLogs: (() => void) | null = null
  private unsubscribePhysxDebug: (() => void) | null = null
  private onRecookColliders: (() => void) | null = null
  private readonly onDocumentClick = (ev: MouseEvent) => {
    if (this.ignoreOutsideClick) {
      this.ignoreOutsideClick = false
      return
    }
    if (!this.visible) return
    const target = ev.target as Node | null
    if (this.root.contains(target ?? null)) return
    if (this.anchor()?.contains(target ?? null)) return
    this.hide()
  }

  constructor({
    anchor,
    renderStats,
    onVisibilityChange,
    getPlayerPosition,
    getSceneOrigin,
    onRecookColliders
  }: DebugPanelOptions) {
    this.anchor = anchor
    this.onVisibilityChange = onVisibilityChange
    this.getPlayerPosition = getPlayerPosition
    this.getSceneOrigin = getSceneOrigin
    this.onRecookColliders = onRecookColliders ?? null
    this.root = document.createElement('div')
    this.root.id = 'debug-panel'
    this.root.className = 'debug-panel'
    this.root.innerHTML = `
      <div class="debug-panel__header">Debug</div>
      <div class="debug-panel__body"></div>
      <div class="debug-panel__physx">
        <div class="debug-panel__physx-title">PhysX colliders</div>
        <label class="debug-panel__check">
          <input type="checkbox" data-physx-scene />
          <span>Scene MeshColliders</span>
        </label>
        <label class="debug-panel__check">
          <input type="checkbox" data-physx-gltf />
          <span>GLTF colliders</span>
        </label>
        <label class="debug-panel__check">
          <input type="checkbox" data-physx-player />
          <span>Local player capsule</span>
        </label>
        <label class="debug-panel__check">
          <input type="checkbox" data-physx-probe />
          <span>Log PhysX probe (collidersphys)</span>
        </label>
        <button type="button" class="debug-panel__logs-btn" data-physx-recook>Recook colliders</button>
      </div>
      <div class="debug-panel__render-quality">
        <div class="debug-panel__render-quality-title">Render quality</div>
        <label class="debug-panel__render-quality-row">
          <span>Light culling tier</span>
          <select data-render-quality>
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
          </select>
        </label>
        <div class="debug-panel__render-quality-hint" data-render-quality-hint></div>
      </div>
      <div class="debug-panel__position">
        <div class="debug-panel__position-title">Position</div>
        <div class="debug-panel__position-local">Scene-local: —</div>
        <div class="debug-panel__position-world">World: —</div>
      </div>
      <div class="debug-panel__logs">
        <div class="debug-panel__logs-header">
          <span class="debug-panel__logs-title">Network log</span>
          <div class="debug-panel__logs-actions">
            <button type="button" class="debug-panel__logs-btn debug-panel__logs-copy">Copy</button>
            <button type="button" class="debug-panel__logs-btn debug-panel__logs-clear">Clear</button>
          </div>
        </div>
        <div class="debug-panel__logs-body" role="log" aria-live="polite"></div>
      </div>
      <div class="debug-panel__stats"></div>
    `

    this.body = this.root.querySelector('.debug-panel__body') as HTMLDivElement
    this.physxSceneToggle = this.root.querySelector('[data-physx-scene]') as HTMLInputElement
    this.physxGltfToggle = this.root.querySelector('[data-physx-gltf]') as HTMLInputElement
    this.physxPlayerToggle = this.root.querySelector('[data-physx-player]') as HTMLInputElement
    this.physxProbeToggle = this.root.querySelector('[data-physx-probe]') as HTMLInputElement
    this.physxRecookBtn = this.root.querySelector('[data-physx-recook]') as HTMLButtonElement
    this.renderQualitySelect = this.root.querySelector('[data-render-quality]') as HTMLSelectElement
    this.renderQualityHint = this.root.querySelector('[data-render-quality-hint]') as HTMLDivElement
    this.positionLocalEl = this.root.querySelector('.debug-panel__position-local') as HTMLDivElement
    this.positionWorldEl = this.root.querySelector('.debug-panel__position-world') as HTMLDivElement
    this.logsBody = this.root.querySelector('.debug-panel__logs-body') as HTMLDivElement
    const statsHost = this.root.querySelector('.debug-panel__stats') as HTMLDivElement
    statsHost.appendChild(renderStats.dom)

    const clearBtn = this.root.querySelector('.debug-panel__logs-clear') as HTMLButtonElement
    clearBtn.addEventListener('click', () => {
      clientDebugLog.clear()
    })

    const copyBtn = this.root.querySelector('.debug-panel__logs-copy') as HTMLButtonElement
    copyBtn.addEventListener('click', () => {
      void this.copyLogs(copyBtn)
    })

    this.unsubscribeLogs = clientDebugLog.subscribe((entries) => this.renderLogs(entries))

    this.wirePhysxDebugControls()
    this.wireRenderQualityControls()

    document.body.appendChild(this.root)
    document.addEventListener('click', this.onDocumentClick, true)
  }

  setStatusHtml(html: string, isError = false): void {
    this.body.className = isError ? 'debug-panel__body error' : 'debug-panel__body'
    this.body.innerHTML = html
  }

  replaceRenderStats(renderStats: RenderStats): void {
    const host = this.root.querySelector('.debug-panel__stats') as HTMLDivElement
    host.replaceChildren(renderStats.dom)
  }

  setRecookCollidersHandler(handler: (() => void) | null): void {
    this.onRecookColliders = handler
  }

  toggle(): boolean {
    if (this.visible) this.hide()
    else this.show()
    return this.visible
  }

  show(): void {
    this.visible = true
    this.root.classList.add('is-open')
    this.ignoreOutsideClick = true
    this.updatePositionHud()
    this.startPositionUpdates()
    this.logsBody.scrollTop = this.logsBody.scrollHeight
    this.onVisibilityChange?.(true)
  }

  hide(): void {
    if (!this.visible) return
    this.visible = false
    this.root.classList.remove('is-open')
    this.stopPositionUpdates()
    this.onVisibilityChange?.(false)
  }

  isVisible(): boolean {
    return this.visible
  }

  dispose(): void {
    this.stopPositionUpdates()
    document.removeEventListener('click', this.onDocumentClick, true)
    this.unsubscribeLogs?.()
    this.unsubscribeLogs = null
    this.unsubscribePhysxDebug?.()
    this.unsubscribePhysxDebug = null
    this.root.remove()
  }

  private startPositionUpdates(): void {
    if (!this.getPlayerPosition) return
    this.stopPositionUpdates()
    const tick = () => {
      if (!this.visible) return
      this.updatePositionHud()
      this.positionRafId = window.requestAnimationFrame(tick)
    }
    this.positionRafId = window.requestAnimationFrame(tick)
  }

  private stopPositionUpdates(): void {
    if (this.positionRafId) {
      window.cancelAnimationFrame(this.positionRafId)
      this.positionRafId = 0
    }
  }

  private updatePositionHud(): void {
    const pos = this.getPlayerPosition?.()
    if (!pos) {
      this.positionLocalEl.textContent = 'Scene-local: —'
      this.positionWorldEl.textContent = 'World: —'
      return
    }

    const origin = this.getSceneOrigin?.() ?? { x: 0, z: 0 }
    const worldX = pos.x + origin.x
    const worldZ = pos.z + origin.z
    this.positionLocalEl.textContent = `Scene-local: (${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)})`
    this.positionWorldEl.textContent = `World: (${worldX.toFixed(1)}, ${pos.y.toFixed(1)}, ${worldZ.toFixed(1)})`
  }

  private renderLogs(entries: readonly { id: number; at: number; category: string; level: string; message: string }[]): void {
    if (entries.length === 0) {
      this.logsBody.innerHTML = '<div class="debug-panel__logs-empty">No log entries yet.</div>'
      return
    }

    const html = entries
      .map((entry) => {
        const time = new Date(entry.at).toLocaleTimeString(undefined, {
          hour12: false,
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit'
        })
        return `<div class="debug-panel__log-line debug-panel__log-line--${entry.level}"><span class="debug-panel__log-time">${time}</span><span class="debug-panel__log-cat">${entry.category}</span><span class="debug-panel__log-msg">${escapeHtml(entry.message)}</span></div>`
      })
      .join('')

    const stickToBottom = this.logsBody.scrollTop + this.logsBody.clientHeight >= this.logsBody.scrollHeight - 24
    this.logsBody.innerHTML = html
    if (stickToBottom) {
      this.logsBody.scrollTop = this.logsBody.scrollHeight
    }
  }

  private wireRenderQualityControls(): void {
    const syncFromStore = (options: RenderQualityOptions) => {
      this.renderQualitySelect.value = options.tier
      const maxLights = LIGHT_LIMITS[options.tier]
      this.renderQualityHint.textContent = `≤${maxLights} lights within ${LIGHT_CULL_DISTANCE_M}m · ≤${MAX_SHADOW_SPOT_LIGHTS} spot shadows`
    }

    syncFromStore(renderQuality.getOptions())

    this.renderQualitySelect.addEventListener('change', () => {
      const tier = this.renderQualitySelect.value as RenderQualityTier
      if (tier === RenderQualityTier.Low || tier === RenderQualityTier.Medium || tier === RenderQualityTier.High) {
        renderQuality.setTier(tier)
      }
    })

    renderQuality.subscribe(syncFromStore)
  }

  private wirePhysxDebugControls(): void {
    const syncFromStore = (options: PhysxColliderDebugOptions) => {
      this.physxSceneToggle.checked = options.sceneMeshColliders
      this.physxGltfToggle.checked = options.gltfColliders
      this.physxPlayerToggle.checked = options.localPlayerCapsule
      this.physxProbeToggle.checked = options.collidersPhys
    }

    syncFromStore(physxColliderDebug.getOptions())

    this.physxSceneToggle.addEventListener('change', () => {
      physxColliderDebug.setOptions({ sceneMeshColliders: this.physxSceneToggle.checked })
    })

    this.physxGltfToggle.addEventListener('change', () => {
      physxColliderDebug.setOptions({ gltfColliders: this.physxGltfToggle.checked })
    })

    this.physxPlayerToggle.addEventListener('change', () => {
      physxColliderDebug.setOptions({ localPlayerCapsule: this.physxPlayerToggle.checked })
    })

    this.physxProbeToggle.addEventListener('change', () => {
      physxColliderDebug.setOptions({ collidersPhys: this.physxProbeToggle.checked })
    })

    this.physxRecookBtn.addEventListener('click', () => {
      this.onRecookColliders?.()
      this.physxRecookBtn.textContent = 'Recooking…'
      window.setTimeout(() => {
        this.physxRecookBtn.textContent = 'Recook colliders'
      }, 1200)
    })

    this.unsubscribePhysxDebug = physxColliderDebug.subscribe(syncFromStore)
  }

  private async copyLogs(button: HTMLButtonElement): Promise<void> {
    const text = clientDebugLog.formatEntriesForCopy()
    if (!text) {
      button.textContent = 'Empty'
      window.setTimeout(() => {
        button.textContent = 'Copy'
      }, 1200)
      return
    }

    try {
      await navigator.clipboard.writeText(text)
      button.textContent = 'Copied!'
    } catch {
      button.textContent = 'Failed'
    }

    window.setTimeout(() => {
      button.textContent = 'Copy'
    }, 1200)
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
