import * as THREE from 'three'
import Stats from 'three/examples/jsm/libs/stats.module.js'
import { perfSnapshot } from '../../util/perfCounters'

export type OceanPerfInfo =
  | { backend: 'water.js'; variant: 'open' | 'island'; planeSpanM: number }
  | {
      backend: 'fft-ocean'
      variant: 'open' | 'island'
      meshResolution: number
      fftResolution: number
      gpgpuPasses: number
      gpgpuHz: number
    }

/** mrdoob stats.js — FPS / MS / MB panel plus optional ocean + draw-call HUD. */
export class RenderStats {
  readonly dom: HTMLDivElement
  private readonly stats: Stats
  private readonly extra: HTMLDivElement
  private oceanInfo: OceanPerfInfo | null = null
  private renderer: THREE.WebGLRenderer | null = null
  private scene: THREE.Scene | null = null
  private uniqueTris = 0
  private uniqueMeshes = 0
  private uniqueCastShadowMeshes = 0
  private inventoryAt = 0

  constructor() {
    this.stats = new Stats()
    this.stats.dom.id = 'render-stats'

    this.extra = document.createElement('div')
    this.extra.id = 'render-stats-extra'
    this.extra.style.cssText =
      'font:11px/1.35 monospace;color:#9fd3ff;margin-top:4px;white-space:pre;line-height:1.4;'

    this.dom = document.createElement('div')
    this.dom.id = 'render-stats-host'
    this.dom.appendChild(this.stats.dom)
    this.dom.appendChild(this.extra)
    this.refreshExtra()
  }

  attachRenderer(renderer: THREE.WebGLRenderer, scene?: THREE.Scene): void {
    this.renderer = renderer
    if (scene) this.scene = scene
  }

  setOceanPerf(info: OceanPerfInfo | null): void {
    this.oceanInfo = info
    this.refreshExtra()
  }

  begin(): void {
    this.stats.begin()
  }

  end(): void {
    this.stats.end()
  }

  update(): void {
    this.stats.update()
    this.refreshExtra()
  }

  private refreshExtra(): void {
    const lines: string[] = []
    if (this.oceanInfo) {
      if (this.oceanInfo.backend === 'water.js') {
        lines.push(
          `ocean: Water.js [${this.oceanInfo.variant}] (${this.oceanInfo.planeSpanM}m plane)`
        )
      } else {
        lines.push(
          `ocean: FFTOCEAN [${this.oceanInfo.variant}] mesh=${this.oceanInfo.meshResolution} fft=${this.oceanInfo.fftResolution}`,
          `gpgpu: ${this.oceanInfo.gpgpuPasses} passes @ ${this.oceanInfo.gpgpuHz}Hz`
        )
      }
    }
    if (this.renderer) {
      const { render, memory } = this.renderer.info
      this.refreshMeshInventoryIfDue()
      // submitTris = GPU work last frame (shadow map passes + main camera).
      // meshTris = unique visible Mesh geometry once (inventory — no multi-pass).
      const ratio =
        this.uniqueTris > 0 ? (render.triangles / this.uniqueTris).toFixed(2) : '—'
      lines.push(
        `draws: ${render.calls}  submitTris: ${formatCount(render.triangles)}`,
        `meshTris: ${formatCount(this.uniqueTris)}  meshes: ${this.uniqueMeshes}  castSh: ${this.uniqueCastShadowMeshes}`,
        `submit/mesh: ${ratio}×  (shadow passes multiply submit)`,
        `gpu: geo=${memory.geometries} tex=${memory.textures}`
      )
    }
    const perf = perfSnapshot()
    lines.push(
      `remotes: vis=${perf.remoteVisible} loaded=${perf.remoteLoaded} poseSkip=${perf.remotePoseSkipped}`,
      `compose: q=${perf.remoteComposePending} active=${perf.remoteComposeActive}  tags=${perf.nameTagsShown}`,
      `move out: ${perf.movementSentPerSec.toFixed(1)}/s  idle skip: ${perf.movementSkippedPerSec.toFixed(1)}/s`
    )
    this.extra.textContent = lines.join('\n')
  }

  /** Throttled scene walk — unique mesh triangle inventory (not multi-pass). */
  private refreshMeshInventoryIfDue(): void {
    if (!this.scene) return
    const now = performance.now()
    if (now - this.inventoryAt < 1000) return
    this.inventoryAt = now
    let tris = 0
    let meshes = 0
    let castSh = 0
    this.scene.traverseVisible((obj) => {
      if (!(obj as THREE.Mesh).isMesh) return
      const mesh = obj as THREE.Mesh
      if (!mesh.visible) return
      meshes++
      if (mesh.castShadow) castSh++
      const geom = mesh.geometry
      if (!geom) return
      const idx = geom.index
      if (idx) tris += idx.count / 3
      else {
        const pos = geom.getAttribute('position')
        if (pos) tris += pos.count / 3
      }
    })
    this.uniqueTris = Math.round(tris)
    this.uniqueMeshes = meshes
    this.uniqueCastShadowMeshes = castSh
  }
}

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}