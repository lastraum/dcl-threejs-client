import * as THREE from 'three'
import Stats from 'three/examples/jsm/libs/stats.module.js'
import { perfSnapshot } from '../../util/perfCounters'

export type OceanPerfInfo =
  | {
      backend: 'water.js'
      variant: 'open' | 'island'
      planeSpanM: number
      authorHeight?: boolean
    }
  | {
      backend: 'fft-ocean'
      variant: 'open' | 'island'
      meshResolution: number
      fftResolution: number
      gpgpuPasses: number
      gpgpuHz: number
      authorHeight?: boolean
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
    // stats.js defaults to fixed top-left + only one panel visible (click cycles).
    // In Help → Debug show FPS + MS (+ MB) side by side always.
    this.stats.dom.style.cssText =
      'position:relative;inset:auto;top:auto;left:auto;opacity:1;z-index:1;' +
      'display:flex;flex-direction:row;flex-wrap:wrap;gap:4px;cursor:default;'
    const showAllStatsPanels = (): void => {
      for (let i = 0; i < this.stats.dom.children.length; i++) {
        const panel = this.stats.dom.children[i] as HTMLElement
        panel.style.display = 'block'
        panel.style.position = 'relative'
      }
    }
    showAllStatsPanels()
    // Stop stats.js from hiding panels on click (it toggles display:none).
    this.stats.dom.addEventListener(
      'click',
      (ev) => {
        ev.stopImmediatePropagation()
        showAllStatsPanels()
      },
      true
    )

    this.extra = document.createElement('div')
    this.extra.id = 'render-stats-extra'
    // pre-wrap: long meter lines wrap instead of overflowing over Position HUD.
    this.extra.style.cssText =
      'font:11px/1.4 monospace;color:#9fd3ff;margin-top:6px;white-space:pre-wrap;' +
      'word-break:break-word;overflow-wrap:anywhere;max-width:100%;line-height:1.4;'

    this.dom = document.createElement('div')
    this.dom.id = 'render-stats-host'
    this.dom.style.cssText = 'max-width:100%;overflow:visible;'
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

  /**
   * Refresh extra HUD lines only.
   *
   * Do **not** call `stats.update()` here: three's Stats.update() re-enters `end()`,
   * which increments the FPS counter a second time per frame (panel showed ~2× real FPS
   * vs MainFrameHud / `frame: … fps=` line).
   */
  update(): void {
    this.refreshExtra()
  }

  private refreshExtra(): void {
    const lines: string[] = []
    if (this.oceanInfo) {
      const shore = this.oceanInfo.authorHeight ? ' +authorH' : ''
      if (this.oceanInfo.backend === 'water.js') {
        lines.push(
          `ocean: Water.js [${this.oceanInfo.variant}] (${this.oceanInfo.planeSpanM}m plane)${shore}`
        )
      } else {
        lines.push(
          `ocean: FFTOCEAN [${this.oceanInfo.variant}] mesh=${this.oceanInfo.meshResolution} fft=${this.oceanInfo.fftResolution}${shore}`,
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
    // Keep each line short — long single lines overflow the Debug panel and look "corrupted".
    lines.push(
      `frame: ${perf.frameMs.toFixed(1)}ms fps=${perf.fps.toFixed(0)} ` +
        `sync=${perf.syncMs.toFixed(1)} render=${perf.renderMs.toFixed(1)} ` +
        `loop+=${perf.loopRestMs.toFixed(1)}`,
      `  rem=${perf.remoteUpdateMs.toFixed(1)} plat=${perf.platformMs.toFixed(1)} ` +
        `part=${perf.particleMs.toFixed(1)} pl=${perf.playerMs.toFixed(1)} ` +
        `sync+=${perf.syncRestMs.toFixed(1)}`,
      `  sync+: env=${perf.envMs.toFixed(1)} scene=${perf.sceneTickMs.toFixed(1)} ` +
        `pe=${perf.peMs.toFixed(1)} aoi=${perf.aoiMs.toFixed(1)} ` +
        `pet=${perf.petMs.toFixed(1)} ptr=${perf.pointerMs.toFixed(1)}`,
      `  render: main=${perf.renderMainMs.toFixed(1)} tags=${perf.renderTagsMs.toFixed(1)} ` +
        `scene=${perf.renderSceneMs.toFixed(1)} extract=${perf.renderExtractMs.toFixed(1)}`,
      `    bloom=${perf.renderBloomMs.toFixed(1)} blit=${perf.renderBlitMs.toFixed(1)} ` +
        `${perf.renderMode} sh=${perf.renderShadowOn ? 'on' : 'off'}`,
      `  scene-loop: send=${perf.sceneLoopSendMs.toFixed(1)} recv=${perf.sceneLoopReceiveMs.toFixed(1)} ` +
        `apply=${perf.sceneLoopApplyMs.toFixed(1)} g=${perf.sceneLoopGuests} ` +
        `sent=${perf.sceneLoopSent} mute=${perf.sceneLoopMuteSent} inflight=${perf.sceneLoopInFlight}`,
      `  apply=${perf.applyMs.toFixed(1)} async~=${perf.asyncMs.toFixed(1)} ` +
        `peel=${perf.asyncPeelMs.toFixed(1)} coll=${perf.asyncCollisionMs.toFixed(1)} ` +
        `bridge=${perf.asyncBridgesMs.toFixed(1)}`,
      `    multi=${perf.asyncMultiMs.toFixed(1)} ptr=${perf.asyncPtrMs.toFixed(1)} ` +
        `rest=${perf.asyncRestMs.toFixed(1)}`,
      `  coll: syncC=${perf.asyncCollSyncMs.toFixed(1)} pose=${perf.asyncCollPoseMs.toFixed(1)} ` +
        `disc=${perf.asyncCollDiscoverMs.toFixed(1)} cook=${perf.asyncCollCookMs.toFixed(1)} ` +
        `q=${perf.colliderCookQueueSize}`,
      `    watch=${perf.asyncCollWatchMs.toFixed(1)} health=${perf.asyncCollHealthMs.toFixed(1)} ` +
        `rest=${perf.asyncCollRestMs.toFixed(1)}`
    )
    lines.push(
      `remotes: peers=${perf.remotePeerTotal} pos=${perf.remoteVisible} ` +
        `shell=${perf.remotePlaceholder} body=${perf.remoteLoaded}`,
      `  poseSkip=${perf.remotePoseSkipped} animSkip=${perf.remoteAnimSkipped} ` +
        `ms=${perf.remoteUpdateMs.toFixed(1)} anim=${perf.remoteAnimMs.toFixed(1)}`,
      `  lod n/m/f=${perf.lodNear}/${perf.lodMid}/${perf.lodFar} ` +
        `compose q=${perf.remoteComposePending} act=${perf.remoteComposeActive} ` +
        `last=${perf.lastComposeMs.toFixed(0)}ms tags=${perf.nameTagsShown}`,
      `move out: ${perf.movementSentPerSec.toFixed(1)}/s ` +
        `idle skip: ${perf.movementSkippedPerSec.toFixed(1)}/s`,
      `pipeline: pendingDiff=${perf.pendingDiffSize} ` +
        `age=${perf.pendingDiffAgeMaxMs.toFixed(0)}ms syncR=${perf.syncRendererMs.toFixed(1)}`,
      `peel: m${perf.peelMaterialMs.toFixed(1)}/t${perf.peelTransformMs.toFixed(1)}/` +
        `g${perf.peelGltfMs.toFixed(1)} e${perf.peelEntities} ` +
        `ptr=${perf.pointerEdgeMs.toFixed(1)} dump=${perf.pointerFullDump}`,
      `uiMount/s=${perf.uiMountPostsPerSec.toFixed(1)} ` +
        `drop/s=${perf.uiMountDropsPerSec.toFixed(1)} ` +
        `skip/s=${perf.uiMountReseedSkipsPerSec.toFixed(1)}`,
      `vcHydrate/s=${perf.vcHydratePerSec.toFixed(1)} ` +
        `poseLive/s=${perf.vcPoseLivePerSec.toFixed(1)} ` +
        `seal=${perf.physxStaticSealed} postReb=${perf.physxPostSealRebuild}`,
      `mrInst=${perf.meshRendererInstances} buckets=${perf.meshRendererBuckets} ` +
        `gltfInst=${perf.gltfInstances}/${perf.gltfInstanceBuckets} draws=${perf.gltfInstanceDraws}`
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