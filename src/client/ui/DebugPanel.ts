import { clientDebugLog } from '../debug/ClientDebugLog'
import { environmentDebug, type EnvironmentDebugState } from '../../debug/EnvironmentDebug'
import { physxColliderDebug, type PhysxColliderDebugOptions } from '../../debug/PhysxColliderDebug'
import { cameraCollisionDebug } from '../../debug/CameraCollisionDebug'
import { platformMotionDebug } from '../../debug/PlatformMotionDebug'
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
  onRecookColliders?: () => void | Promise<void>
}

/** Top-right debug overlay — toggled from the Help sidebar button. */
export class DebugPanel {
  readonly root: HTMLDivElement
  private readonly physxSceneToggle: HTMLInputElement
  private readonly physxGltfToggle: HTMLInputElement
  private readonly physxPlayerToggle: HTMLInputElement
  private readonly physxProbeToggle: HTMLInputElement
  private readonly physxRuntimeRecookToggle: HTMLInputElement
  private readonly platformMotionToggle: HTMLInputElement
  private readonly cameraWallOcclusionToggle: HTMLInputElement
  private readonly environmentDisableToggle: HTMLInputElement
  private readonly environmentHint: HTMLDivElement
  private readonly physxRecookBtn: HTMLButtonElement
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
  private unsubscribeEnvironmentDebug: (() => void) | null = null
  private onRecookColliders: (() => void | Promise<void>) | null = null
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
      <div class="debug-panel__position">
        <div class="debug-panel__position-main">
          <div class="debug-panel__position-title">Position</div>
          <div class="debug-panel__position-local">Scene-local: —</div>
          <div class="debug-panel__position-world">World: —</div>
        </div>
        <div class="debug-panel__stats" data-debug-stats></div>
      </div>
      <div class="debug-panel__logs">
        <div class="debug-panel__logs-header">
          <span class="debug-panel__logs-title">Client log</span>
          <div class="debug-panel__logs-actions">
            <button type="button" class="debug-panel__logs-btn debug-panel__logs-copy">Copy</button>
            <button type="button" class="debug-panel__logs-btn debug-panel__logs-clear">Clear</button>
          </div>
        </div>
        <label class="debug-panel__check debug-panel__check--log">
          <input type="checkbox" data-panel-record />
          <span>Record client logs in this panel</span>
        </label>
        <label class="debug-panel__check debug-panel__check--log">
          <input type="checkbox" data-all-client-logs />
          <span>Include all categories (comms, etc.)</span>
        </label>
        <label class="debug-panel__check debug-panel__check--log">
          <input type="checkbox" data-console-capture />
          <span>Capture console.log / warn / error here</span>
        </label>
        <label class="debug-panel__check debug-panel__check--log">
          <input type="checkbox" data-console-mirror />
          <span>Mirror panel → browser console</span>
        </label>
        <div class="debug-panel__logs-body" role="log" aria-live="polite"></div>
      </div>
      <div class="debug-panel__tools">
        <div class="debug-panel__environment">
          <div class="debug-panel__physx-title">Environment</div>
          <label class="debug-panel__check">
            <input type="checkbox" data-env-disable />
            <span>Disable loaded environment</span>
          </label>
          <div class="debug-panel__render-quality-hint" data-env-hint></div>
        </div>
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
          <label class="debug-panel__check">
            <input type="checkbox" data-physx-runtime-recook />
            <span>Runtime drift recook (colliderrecook)</span>
          </label>
          <label class="debug-panel__check">
            <input type="checkbox" data-platform-motion />
            <span>Platform velocity transfer log</span>
          </label>
          <label class="debug-panel__check">
            <input type="checkbox" data-camera-wall-occlusion />
            <span>Third-person camera wall sweep (camerasweep)</span>
          </label>
          <button type="button" class="debug-panel__logs-btn" data-physx-recook>Force recook all colliders</button>
        </div>
      </div>
    `

    this.physxSceneToggle = this.root.querySelector('[data-physx-scene]') as HTMLInputElement
    this.physxGltfToggle = this.root.querySelector('[data-physx-gltf]') as HTMLInputElement
    this.physxPlayerToggle = this.root.querySelector('[data-physx-player]') as HTMLInputElement
    this.physxProbeToggle = this.root.querySelector('[data-physx-probe]') as HTMLInputElement
    this.physxRuntimeRecookToggle = this.root.querySelector('[data-physx-runtime-recook]') as HTMLInputElement
    this.platformMotionToggle = this.root.querySelector('[data-platform-motion]') as HTMLInputElement
    this.cameraWallOcclusionToggle = this.root.querySelector(
      '[data-camera-wall-occlusion]'
    ) as HTMLInputElement
    this.environmentDisableToggle = this.root.querySelector('[data-env-disable]') as HTMLInputElement
    this.environmentHint = this.root.querySelector('[data-env-hint]') as HTMLDivElement
    this.physxRecookBtn = this.root.querySelector('[data-physx-recook]') as HTMLButtonElement
    this.positionLocalEl = this.root.querySelector('.debug-panel__position-local') as HTMLDivElement
    this.positionWorldEl = this.root.querySelector('.debug-panel__position-world') as HTMLDivElement
    this.logsBody = this.root.querySelector('.debug-panel__logs-body') as HTMLDivElement
    const statsHost = this.root.querySelector('[data-debug-stats]') as HTMLDivElement
    statsHost.appendChild(renderStats.dom)

    const panelRecordToggle = this.root.querySelector('[data-panel-record]') as HTMLInputElement
    panelRecordToggle.checked = clientDebugLog.isPanelRecord()
    panelRecordToggle.addEventListener('change', () => {
      clientDebugLog.setPanelRecord(panelRecordToggle.checked)
    })

    const allClientLogsToggle = this.root.querySelector(
      '[data-all-client-logs]'
    ) as HTMLInputElement
    allClientLogsToggle.checked = clientDebugLog.isAllClientLogs()
    allClientLogsToggle.addEventListener('change', () => {
      clientDebugLog.setAllClientLogs(allClientLogsToggle.checked)
    })

    const consoleCaptureToggle = this.root.querySelector(
      '[data-console-capture]'
    ) as HTMLInputElement
    consoleCaptureToggle.checked = clientDebugLog.isConsoleCapture()
    consoleCaptureToggle.addEventListener('change', () => {
      clientDebugLog.setConsoleCapture(consoleCaptureToggle.checked)
    })

    const consoleMirrorToggle = this.root.querySelector(
      '[data-console-mirror]'
    ) as HTMLInputElement
    consoleMirrorToggle.checked = clientDebugLog.isConsoleMirror()
    consoleMirrorToggle.addEventListener('change', () => {
      clientDebugLog.setConsoleMirror(consoleMirrorToggle.checked)
    })

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
    this.wirePlatformMotionControls()
    this.wireCameraCollisionControls()
    this.wireEnvironmentDebugControls()

    document.body.appendChild(this.root)
    document.addEventListener('click', this.onDocumentClick, true)
  }

  /** Kept for callers; scene summary was removed to free log space. */
  setStatusHtml(_html: string, _isError = false): void {
    /* no-op */
  }

  replaceRenderStats(renderStats: RenderStats): void {
    const host = this.root.querySelector('[data-debug-stats]') as HTMLDivElement
    host.replaceChildren(renderStats.dom)
  }

  setRecookCollidersHandler(handler: (() => void | Promise<void>) | null): void {
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
    this.unsubscribeEnvironmentDebug?.()
    this.unsubscribeEnvironmentDebug = null
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

  private wirePhysxDebugControls(): void {
    const syncFromStore = (options: PhysxColliderDebugOptions) => {
      this.physxSceneToggle.checked = options.sceneMeshColliders
      this.physxGltfToggle.checked = options.gltfColliders
      this.physxPlayerToggle.checked = options.localPlayerCapsule
      this.physxProbeToggle.checked = options.collidersPhys
      this.physxRuntimeRecookToggle.checked = options.runtimeRecook
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

    this.physxRuntimeRecookToggle.addEventListener('change', () => {
      physxColliderDebug.setOptions({ runtimeRecook: this.physxRuntimeRecookToggle.checked })
    })

    this.physxRecookBtn.addEventListener('click', () => {
      if (!this.onRecookColliders) {
        clientDebugLog.log('collision', 'Recook unavailable — scene not ready', { level: 'warn', alsoConsole: true })
        return
      }
      if (this.physxRecookBtn.disabled) return
      this.physxRecookBtn.disabled = true
      this.physxRecookBtn.textContent = 'Recooking…'
      clientDebugLog.log('collision', 'Manual collider recook started (Debug → Force recook all colliders)', {
        level: 'info',
        alsoConsole: true
      })
      void Promise.resolve(this.onRecookColliders())
        .catch((err) => {
          console.warn('[DebugPanel] collider recook failed', err)
          clientDebugLog.log(
            'collision',
            `Recook failed — ${err instanceof Error ? err.message : String(err)}`,
            { level: 'warn', alsoConsole: true }
          )
        })
        .finally(() => {
          this.physxRecookBtn.disabled = false
          this.physxRecookBtn.textContent = 'Force recook all colliders'
        })
    })

    this.unsubscribePhysxDebug = physxColliderDebug.subscribe(syncFromStore)
  }

  private wireEnvironmentDebugControls(): void {
    const syncFromStore = (state: EnvironmentDebugState) => {
      const available = state.loadedKind !== null
      this.environmentDisableToggle.disabled = !available
      this.environmentDisableToggle.checked = available && state.disabled
      if (!available) {
        this.environmentHint.textContent =
          'No client environment on this scene — add scene.json "environment" or use ?environment=island'
      } else {
        this.environmentHint.textContent = `Loaded: ${state.loadedKind} · force biome at load with ?environment=`
      }
    }

    syncFromStore(environmentDebug.getState())

    this.environmentDisableToggle.addEventListener('change', () => {
      if (!environmentDebug.hasLoadedEnvironment()) {
        this.environmentDisableToggle.checked = false
        return
      }
      environmentDebug.setDisabled(this.environmentDisableToggle.checked)
      if (this.environmentDisableToggle.checked) {
        clientDebugLog.log(
          'environment',
          `Environment hidden (${environmentDebug.getState().loadedKind}) — landscape, ocean, and genesis sky off`,
          { level: 'success', alsoConsole: true }
        )
      } else {
        clientDebugLog.log('environment', 'Environment restored', { level: 'success', alsoConsole: true })
      }
    })

    this.unsubscribeEnvironmentDebug = environmentDebug.subscribe(syncFromStore)
  }

  private wirePlatformMotionControls(): void {
    const syncFromStore = () => {
      this.platformMotionToggle.checked = platformMotionDebug.isEnabled()
    }
    syncFromStore()
    this.platformMotionToggle.addEventListener('change', () => {
      platformMotionDebug.setOptions({ enabled: this.platformMotionToggle.checked })
      if (this.platformMotionToggle.checked) {
        clientDebugLog.log(
          'motion',
          'Platform transfer debug ON — stand on the lift; logs show tween/animator/mesh motion + platform Δ',
          { level: 'success', alsoConsole: true }
        )
      }
    })
    platformMotionDebug.subscribe(syncFromStore)
  }

  private wireCameraCollisionControls(): void {
    const syncFromStore = () => {
      this.cameraWallOcclusionToggle.checked = cameraCollisionDebug.isWallOcclusionEnabled()
    }
    syncFromStore()
    this.cameraWallOcclusionToggle.addEventListener('change', () => {
      cameraCollisionDebug.setOptions({
        wallOcclusion: this.cameraWallOcclusionToggle.checked
      })
      if (this.cameraWallOcclusionToggle.checked) {
        clientDebugLog.log(
          'client',
          'Third-person camera wall sweep ON — PhysX landscape sweep pulls camera in near walls',
          { level: 'success', alsoConsole: true }
        )
      }
    })
    cameraCollisionDebug.subscribe(syncFromStore)
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
