import { clientDebugLog } from '../debug/ClientDebugLog'
import { environmentDebug, type EnvironmentDebugState } from '../../debug/EnvironmentDebug'
import { physxColliderDebug, type PhysxColliderDebugOptions } from '../../debug/PhysxColliderDebug'
import { cameraCollisionDebug } from '../../debug/CameraCollisionDebug'
import { platformMotionDebug } from '../../debug/PlatformMotionDebug'
import type { RenderStats } from './RenderStats'
import { isLocalPreviewPath, openEphemeralPreviewTab } from '../preview/ephemeralPreview'

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
  /** Unused — callers still pass a Labs button; scene clicks no longer dismiss. */
  anchor?: () => HTMLElement | undefined
  renderStats: RenderStats
  onVisibilityChange?: (visible: boolean) => void
  getPlayerPosition?: () => DebugPanelPosition | null
  getSceneOrigin?: () => DebugPanelSceneOrigin
  onRecookColliders?: () => void | Promise<void>
  /** Multi-avatar perf harness — spawn fake peers around the player. */
  onCrowdDelta?: (delta: number) => void
  onCrowdClear?: () => void
  getCrowdCount?: () => { count: number; target: number; busy: boolean }
}

/** Debug tools HUD — standalone top-right, or embedded in Help & Dev modal. */
export class DebugPanel {
  readonly root: HTMLDivElement
  private readonly physxSceneToggle: HTMLInputElement
  private readonly physxGltfToggle: HTMLInputElement
  private readonly physxGltfSolidToggle: HTMLInputElement
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
  private readonly onVisibilityChange?: (visible: boolean) => void
  private readonly getPlayerPosition?: () => DebugPanelPosition | null
  private readonly getSceneOrigin?: () => DebugPanelSceneOrigin
  private visible = false
  /** When true, panel lives inside Help & Dev body (no fixed float / outside-click). */
  private embedded = false
  private positionRafId = 0
  private unsubscribeLogs: (() => void) | null = null
  private unsubscribePhysxDebug: (() => void) | null = null
  private unsubscribeEnvironmentDebug: (() => void) | null = null
  private onRecookColliders: (() => void | Promise<void>) | null = null
  private onCrowdDelta: ((delta: number) => void) | null = null
  private onCrowdClear: (() => void) | null = null
  private getCrowdCount: (() => { count: number; target: number; busy: boolean }) | null = null
  private crowdStatusEl: HTMLDivElement | null = null
  constructor({
    renderStats,
    onVisibilityChange,
    getPlayerPosition,
    getSceneOrigin,
    onRecookColliders,
    onCrowdDelta,
    onCrowdClear,
    getCrowdCount
  }: DebugPanelOptions) {
    this.onVisibilityChange = onVisibilityChange
    this.getPlayerPosition = getPlayerPosition
    this.getSceneOrigin = getSceneOrigin
    this.onRecookColliders = onRecookColliders ?? null
    this.onCrowdDelta = onCrowdDelta ?? null
    this.onCrowdClear = onCrowdClear ?? null
    this.getCrowdCount = getCrowdCount ?? null
    this.root = document.createElement('div')
    this.root.id = 'debug-panel'
    this.root.className = 'debug-panel'
    this.root.innerHTML = `
      <div class="debug-panel__header">
        <span>Debug</span>
        <div class="debug-panel__header-actions">
          <button type="button" class="debug-panel__logs-btn" data-add-peer hidden>Add multiplayer</button>
          <button type="button" class="debug-panel__logs-btn" data-debug-close aria-label="Close">Close</button>
        </div>
      </div>
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
          <span>Mirror → browser console (<code>?consolelogs</code>)</span>
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
            <span>GLTF colliders (magenta = _collider source + cooked)</span>
          </label>
          <label class="debug-panel__check">
            <input type="checkbox" data-physx-gltf-solid />
            <span>Solid filled hulls (off = wireframe only)</span>
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
            <span>Third-person camera wall sweep (on; ?nocamerasweep)</span>
          </label>
          <button type="button" class="debug-panel__logs-btn" data-physx-recook>Force recook all colliders</button>
        </div>
        <div class="debug-panel__crowd">
          <div class="debug-panel__physx-title">Avatar crowd (perf)</div>
          <div class="debug-panel__render-quality-hint" data-crowd-status>0 / 0</div>
          <div class="debug-panel__crowd-row">
            <button type="button" class="debug-panel__logs-btn" data-crowd-minus5 title="Remove 5">−5</button>
            <button type="button" class="debug-panel__logs-btn" data-crowd-minus1 title="Remove 1">−1</button>
            <button type="button" class="debug-panel__logs-btn" data-crowd-plus1 title="Add 1">+1</button>
            <button type="button" class="debug-panel__logs-btn" data-crowd-plus5 title="Add 5">+5</button>
            <button type="button" class="debug-panel__logs-btn" data-crowd-plus10 title="Add 10">+10</button>
            <button type="button" class="debug-panel__logs-btn" data-crowd-clear title="Clear all">Clear</button>
          </div>
        </div>
      </div>
    `

    this.physxSceneToggle = this.root.querySelector('[data-physx-scene]') as HTMLInputElement
    this.physxGltfToggle = this.root.querySelector('[data-physx-gltf]') as HTMLInputElement
    this.physxGltfSolidToggle = this.root.querySelector('[data-physx-gltf-solid]') as HTMLInputElement
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
    this.wireCrowdControls()

    const addPeerBtn = this.root.querySelector('[data-add-peer]') as HTMLButtonElement | null
    if (addPeerBtn && isLocalPreviewPath()) {
      addPeerBtn.hidden = false
      addPeerBtn.addEventListener('click', (e) => {
        e.preventDefault()
        e.stopPropagation()
        openEphemeralPreviewTab()
      })
    }
    this.root.querySelector('[data-debug-close]')?.addEventListener('click', (e) => {
      e.stopPropagation()
      this.hide()
    })

    document.body.appendChild(this.root)
  }

  private wireCrowdControls(): void {
    this.crowdStatusEl = this.root.querySelector('[data-crowd-status]') as HTMLDivElement
    const bind = (sel: string, delta: number | 'clear') => {
      const btn = this.root.querySelector(sel) as HTMLButtonElement | null
      btn?.addEventListener('click', (e) => {
        e.stopPropagation()
        if (delta === 'clear') this.onCrowdClear?.()
        else this.onCrowdDelta?.(delta)
        this.refreshCrowdStatus()
      })
    }
    bind('[data-crowd-minus5]', -5)
    bind('[data-crowd-minus1]', -1)
    bind('[data-crowd-plus1]', 1)
    bind('[data-crowd-plus5]', 5)
    bind('[data-crowd-plus10]', 10)
    bind('[data-crowd-clear]', 'clear')
    this.refreshCrowdStatus()
  }

  refreshCrowdStatus(): void {
    if (!this.crowdStatusEl) return
    if (!this.getCrowdCount) {
      this.crowdStatusEl.textContent = 'Crowd harness not bound'
      return
    }
    const { count, target, busy } = this.getCrowdCount()
    this.crowdStatusEl.textContent = busy
      ? `Spawning… ${count} ready → target ${target}`
      : `${count} avatars (target ${target})`
  }

  setCrowdHandlers(opts: {
    onCrowdDelta?: (delta: number) => void
    onCrowdClear?: () => void
    getCrowdCount?: () => { count: number; target: number; busy: boolean }
  }): void {
    this.onCrowdDelta = opts.onCrowdDelta ?? null
    this.onCrowdClear = opts.onCrowdClear ?? null
    this.getCrowdCount = opts.getCrowdCount ?? null
    this.refreshCrowdStatus()
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

  /** Mount inside Help & Dev Debug tab (layout becomes in-flow). */
  attachTo(host: HTMLElement): void {
    this.embedded = true
    this.root.classList.add('debug-panel--embedded')
    host.appendChild(this.root)
    this.show()
  }

  /** Return to body-level floating panel. */
  detach(): void {
    if (!this.embedded) return
    this.embedded = false
    this.root.classList.remove('debug-panel--embedded')
    document.body.appendChild(this.root)
    this.hide()
  }

  isEmbedded(): boolean {
    return this.embedded
  }

  dispose(): void {
    this.stopPositionUpdates()
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
      this.refreshCrowdStatus()
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
      this.physxGltfSolidToggle.checked = options.gltfColliderSolids
      this.physxPlayerToggle.checked = options.localPlayerCapsule
      this.physxProbeToggle.checked = options.collidersPhys
      this.physxRuntimeRecookToggle.checked = options.runtimeRecook
    }

    syncFromStore(physxColliderDebug.getOptions())

    this.physxSceneToggle.addEventListener('change', () => {
      physxColliderDebug.setOptions({ sceneMeshColliders: this.physxSceneToggle.checked })
    })

    this.physxGltfToggle.addEventListener('change', () => {
      const on = this.physxGltfToggle.checked
      // Turning GLTF debug on defaults solid fill so hulls are obvious (wireframe is optional).
      physxColliderDebug.setOptions(
        on ? { gltfColliders: true, gltfColliderSolids: true } : { gltfColliders: false }
      )
    })

    this.physxGltfSolidToggle.addEventListener('change', () => {
      physxColliderDebug.setOptions({ gltfColliderSolids: this.physxGltfSolidToggle.checked })
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
