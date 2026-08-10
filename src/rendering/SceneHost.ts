import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import type { ResolvedScene } from '../dcl/content/types'
import type { SceneWorldBounds } from '../player/SceneBounds'
import { dclToThreePos } from '../bridge/dclTransform'
import { NameTagRenderer } from '../client/ui/NameTagRenderer'
import { RenderStats } from '../client/ui/RenderStats'
import {
  clampMsaaSamples,
  effectivePixelRatio,
  renderQuality,
  TONE_MAPPING_EXPOSURE,
  type MsaaSamples,
  type RenderQualityOptions
} from './RenderQualitySettings'
import { BloomPipeline } from './BloomPipeline'
import { clientSettings } from './ClientSettings'
import { clientDebugLog } from '../client/debug/ClientDebugLog'
import { AdaptiveQualityController } from './AdaptiveQualityController'
import {
  applyClientCameraDepth,
  CLIENT_CAMERA_NEAR,
  farFromWorldDiagonal
} from '../camera/cameraDepthPolicy'
import { perfNoteFrameHost, perfNoteRenderSplit } from '../util/perfCounters'
import { forceNoBloom, forceNoShadow } from '../client/devFlags'

export class SceneHost {
  readonly renderer: THREE.WebGLRenderer
  readonly scene: THREE.Scene
  readonly camera: THREE.PerspectiveCamera
  readonly controls: OrbitControls
  readonly nameTags: NameTagRenderer
  readonly renderStats: RenderStats
  private orbitEnabled = true
  private disposing = false
  private readonly clock = new THREE.Clock()
  private readonly frameListeners = new Set<(delta: number) => void>()
  /** After sync+render+frame pie meters — for MainFrameHud paint. */
  private readonly postFrameListeners = new Set<() => void>()
  private resizeObserver: ResizeObserver | null = null
  private viewportElement: HTMLElement | null = null
  private onViewportResize: ((width: number, height: number) => void) | null = null
  /** Min ms between full frames; 0 = every rAF. */
  private frameIntervalMs = 0
  private lastFrameTime = 0
  /** When tab is hidden, cap to ~8 FPS so work drains without false “stuck” load. */
  private static readonly HIDDEN_FRAME_INTERVAL_MS = 1000 / 8
  /** Effective MSAA after GPU clamp (0 = render straight to canvas). */
  private msaaSamples: MsaaSamples = 0
  private msaaTarget: THREE.WebGLRenderTarget | null = null
  private readonly blitScene = new THREE.Scene()
  private readonly blitCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
  private readonly blitMaterial: THREE.MeshBasicMaterial
  private viewportCssW = 1
  private viewportCssH = 1
  private bloom: BloomPipeline | null = null
  /** Cached visible mesh count for bloom mode pick (refreshed every ~2s). */
  private bloomMeshCount = 0
  private bloomMeshCountAt = 0
  private bloomModeLogged = ''
  /**
   * Below this → selective bloom (2× geo, half-res extract, emissive occlusion).
   * At/above → fast bloom (1× geo, luminance threshold). Plaza is always fast.
   */
  private static readonly BLOOM_SELECTIVE_MESH_CAP = 900
  private readonly adaptiveQuality = new AdaptiveQualityController()

  constructor(container: HTMLElement) {
    // Canvas AA off — sample count is controlled via multisample render target (runtime prefs).
    this.renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' })
    this.renderer.setPixelRatio(effectivePixelRatio(renderQuality.getResolutionScale()))
    this.renderer.setSize(window.innerWidth, window.innerHeight)
    this.renderer.setClearColor(0x1a1a2e)
    container.appendChild(this.renderer.domElement)

    this.blitMaterial = new THREE.MeshBasicMaterial({
      map: null,
      depthTest: false,
      depthWrite: false,
      toneMapped: false
    })
    const blitMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.blitMaterial)
    this.blitScene.add(blitMesh)

    this.renderer.domElement.addEventListener('webglcontextlost', (e) => {
      if (this.disposing) {
        e.preventDefault()
        return
      }
      console.error('[SceneHost] WebGL context lost unexpectedly — GPU memory or driver reset?', e)
    })

    this.scene = new THREE.Scene()
    this.scene.background = new THREE.Color(0x87ceeb)

    this.camera = new THREE.PerspectiveCamera(
      clientSettings.getFov(),
      window.innerWidth / window.innerHeight,
      CLIENT_CAMERA_NEAR,
      500
    )
    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.enableDamping = true
    this.controls.maxPolarAngle = Math.PI * 0.49
    this.nameTags = new NameTagRenderer(container)
    this.renderStats = new RenderStats()
    this.renderStats.attachRenderer(this.renderer, this.scene)
    this.bloom = new BloomPipeline(this.renderer, this.scene, this.camera)

    // Quality apply resizes the viewport — camera + nameTags must already exist.
    this.applyRendererQuality(renderQuality.getOptions())
    renderQuality.subscribe((options) => this.applyRendererQuality(options))

    clientSettings.subscribe((s) => {
      this.camera.fov = s.fov
      this.camera.updateProjectionMatrix()
    })

    window.addEventListener('resize', () => this.applyViewportSize())
    // Mobile URL bar show/hide changes visualViewport without a window resize.
    window.visualViewport?.addEventListener('resize', () => this.applyViewportSize())
    window.visualViewport?.addEventListener('scroll', () => this.applyViewportSize())
  }

  /** Size renderer/camera to a panel element (editor workspace) instead of the full window. */
  bindViewport(element: HTMLElement, onResize?: (width: number, height: number) => void): void {
    this.viewportElement = element
    this.onViewportResize = onResize ?? null
    this.resizeObserver?.disconnect()
    this.resizeObserver = new ResizeObserver(() => this.applyViewportSize())
    this.resizeObserver.observe(element)
    this.applyViewportSize()
  }

  setViewportSize(width: number, height: number): void {
    if (width < 1 || height < 1) return
    this.viewportCssW = width
    this.viewportCssH = height
    if (this.camera) {
      this.camera.aspect = width / height
      this.camera.updateProjectionMatrix()
    }
    // Drawing buffer = CSS pixel size of #app (canvas is position:absolute inset 0 in CSS).
    // updateStyle=false: keep CSS width/height 100% so we never letterbox under #app.
    this.renderer.setSize(width, height, false)
    const canvas = this.renderer.domElement
    canvas.style.display = 'block'
    // Three may leave inline width/height from an earlier setSize(true) — force fill.
    canvas.style.width = '100%'
    canvas.style.height = '100%'
    canvas.style.inset = '0'
    canvas.style.position = 'absolute'
    canvas.style.left = '0'
    canvas.style.top = '0'
    this.ensureMsaaTargetSize()
    this.configureBloom(renderQuality.getOptions())
    this.nameTags?.setSize(width, height)
    this.onViewportResize?.(width, height)
  }

  private applyViewportSize(): void {
    if (this.viewportElement) {
      this.setViewportSize(this.viewportElement.clientWidth, this.viewportElement.clientHeight)
      return
    }
    // Always size to the largest stable viewport metric. A short #app (stale CSS /
    // 100dvh vs layout chrome) left a solid black strip under the HUD while scene-ui
    // mapped to 1920×884 of a taller window (logs: e1835 1920×884).
    const app = document.getElementById('app')
    const vv = window.visualViewport
    const targetW = Math.max(
      1,
      Math.round(vv?.width ?? 0),
      document.documentElement.clientWidth || 0,
      window.innerWidth || 0,
      app?.clientWidth || 0
    )
    const targetH = Math.max(
      1,
      Math.round(vv?.height ?? 0),
      document.documentElement.clientHeight || 0,
      window.innerHeight || 0,
      app?.clientHeight || 0
    )
    if (app) {
      app.style.width = '100%'
      app.style.height = '100%'
      app.style.minHeight = `${targetH}px`
      app.style.maxHeight = 'none'
      // Absolute fill in case % height collapses under a non-height parent.
      if (app.clientHeight + 2 < targetH || app.clientWidth + 2 < targetW) {
        app.style.position = app.style.position || 'relative'
        app.style.minHeight = `${targetH}px`
        app.style.minWidth = `${targetW}px`
      }
    }
    this.setViewportSize(targetW, targetH)
  }

  focusSpawn(sceneConfig: ResolvedScene): void {
    const target = dclToThreePos(sceneConfig.spawn.x, sceneConfig.spawn.y + 1.5, sceneConfig.spawn.z)
    this.camera.position.set(target.x + 14, target.y + 10, target.z + 18)
    this.controls.target.copy(target)
    this.controls.update()
  }

  /** Match camera far plane to scene footprint so large worlds keep horizon sky. */
  configureViewDistance(bounds: SceneWorldBounds): void {
    const width = bounds.maxX - bounds.minX
    const depth = bounds.maxZ - bounds.minZ
    applyClientCameraDepth(this.camera, {
      near: CLIENT_CAMERA_NEAR,
      far: farFromWorldDiagonal(width, depth)
    })
  }

  setOrbitEnabled(enabled: boolean): void {
    this.orbitEnabled = enabled
    this.controls.enabled = enabled
  }

  addFrameListener(listener: (delta: number) => void): () => void {
    this.frameListeners.add(listener)
    return () => this.frameListeners.delete(listener)
  }

  /** After sync + render + frame pie meters (for MainFrameHud). */
  addPostFrameListener(listener: () => void): () => void {
    this.postFrameListeners.add(listener)
    return () => this.postFrameListeners.delete(listener)
  }

  private abFlagsLogged = false

  /** ACES tone mapping + exposure, shadows, resolution scale, FPS cap, MSAA, bloom. */
  private applyRendererQuality(options: RenderQualityOptions): void {
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = TONE_MAPPING_EXPOSURE[options.tier]
    // Effective shadow/res may be temporarily lowered by AdaptiveQualityController.
    // `?noshadow` forces off for render A/B (does not rewrite Preferences storage).
    const shadowQ = forceNoShadow() ? 'off' : renderQuality.getShadowQuality()
    const resScale = renderQuality.getResolutionScale()
    this.renderer.shadowMap.enabled = shadowQ !== 'off'
    if (!this.abFlagsLogged && (forceNoShadow() || forceNoBloom())) {
      this.abFlagsLogged = true
      console.info(
        `[SceneHost] render A/B flags —` +
          (forceNoShadow() ? ' noshadow' : '') +
          (forceNoBloom() ? ' nobloom' : '')
      )
    }
    // Explorer soft directional: PCFSoft on medium+ (parity). Low stays Basic for mobile/budget.
    // Soft cost is real — AdaptiveQuality can still drop shadow tier under hitch.
    this.renderer.shadowMap.type =
      shadowQ === 'ultra' || shadowQ === 'high' || shadowQ === 'medium'
        ? THREE.PCFSoftShadowMap
        : THREE.BasicShadowMap
    this.renderer.setPixelRatio(effectivePixelRatio(resScale))

    // VSync On + Max FPS → pure rAF (display-aligned). VSync Off still uses rAF (browser limit).
    // Explicit FPS caps always apply.
    if (options.fpsLimit > 0) {
      this.frameIntervalMs = 1000 / options.fpsLimit
    } else {
      this.frameIntervalMs = 0
    }

    // Bloom uses EffectComposer (no MSAA samples on that path).
    // Effective bloom includes adaptive step-down; `?nobloom` forces off for A/B.
    const bloomOn = renderQuality.getBloomEnabled() && !forceNoBloom()
    const maxSamples = this.renderer.capabilities.maxSamples ?? 0
    this.msaaSamples = bloomOn
      ? 0
      : clampMsaaSamples(options.msaaSamples, maxSamples)
    this.rebuildMsaaTarget()
    // Re-apply size so backing store matches new pixel ratio / MSAA / bloom buffers.
    this.applyViewportSize()
    this.configureBloom(options)
  }

  private configureBloom(options: RenderQualityOptions): void {
    if (!this.bloom) return
    const pr = this.renderer.getPixelRatio()
    // Film scale only — surface glow amount comes from glTF/ECS emissive × intensity.
    // Keep modest: outdoor sunlit beauty + low threshold washed brainrot chalk-white vs Explorer.
    const strength =
      options.tier === 'ultra' ? 0.14 : options.tier === 'high' ? 0.12 : 0.1
    // Prefer selective on high/ultra when the scene is small enough; always fast on plaza-scale.
    // Mode is re-evaluated each frame in renderMainPass via pickBloomMode().
    const mode = this.pickBloomMode(options)
    const bloomOn = renderQuality.getBloomEnabled() && !forceNoBloom()
    this.bloom.configure(
      {
        enabled: bloomOn,
        hdr: options.hdrEnabled,
        mode,
        strength,
        // Selective only; fast path clamps via FAST_THRESHOLD in BloomPipeline.
        threshold: 0.15,
        radius: 0.26
      },
      this.viewportCssW,
      this.viewportCssH,
      pr
    )
  }

  /**
   * selective = emissive isolation + depth occlusion (2× scene).
   * fast = 1× beauty + UnrealBloom luminance (plaza / large worlds).
   * Preferences → Bloom mode: Auto (legacy heuristic) / Fast / Selective.
   */
  private pickBloomMode(options: RenderQualityOptions): 'fast' | 'selective' {
    const pref = renderQuality.getBloomMode()
    if (pref === 'fast') return 'fast'
    if (pref === 'selective') return 'selective'
    // auto — prior behavior
    const meshes = this.sceneMeshCountForBloom()
    const smallEnough = meshes > 0 && meshes <= SceneHost.BLOOM_SELECTIVE_MESH_CAP
    const tierWantsSelective = options.tier === 'high' || options.tier === 'ultra'
    return smallEnough && tierWantsSelective ? 'selective' : 'fast'
  }

  private rebuildMsaaTarget(): void {
    if (this.msaaSamples <= 0) {
      this.msaaTarget?.dispose()
      this.msaaTarget = null
      this.blitMaterial.map = null
      return
    }
    const pr = this.renderer.getPixelRatio()
    const w = Math.max(1, Math.floor(this.viewportCssW * pr))
    const h = Math.max(1, Math.floor(this.viewportCssH * pr))
    if (
      this.msaaTarget &&
      this.msaaTarget.width === w &&
      this.msaaTarget.height === h &&
      this.msaaTarget.samples === this.msaaSamples
    ) {
      return
    }
    this.msaaTarget?.dispose()
    this.msaaTarget = new THREE.WebGLRenderTarget(w, h, {
      samples: this.msaaSamples,
      type: THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      colorSpace: THREE.SRGBColorSpace,
      depthBuffer: true,
      stencilBuffer: false
    })
    this.msaaTarget.texture.name = 'msaa-color'
    this.blitMaterial.map = this.msaaTarget.texture
    this.blitMaterial.needsUpdate = true
  }

  private ensureMsaaTargetSize(): void {
    if (this.msaaSamples <= 0) return
    this.rebuildMsaaTarget()
  }

  /** Visible mesh inventory for bloom gate — full walk only every 2s. */
  private sceneMeshCountForBloom(): number {
    const now = performance.now()
    if (now - this.bloomMeshCountAt < 2000 && this.bloomMeshCountAt > 0) {
      return this.bloomMeshCount
    }
    this.bloomMeshCountAt = now
    let n = 0
    this.scene.traverseVisible((obj) => {
      if ((obj as THREE.Mesh).isMesh) n++
    })
    this.bloomMeshCount = n
    return n
  }

  private renderForwardPass(): { sceneMs: number; blitMs: number } {
    if (this.msaaTarget && this.msaaSamples > 0) {
      const tScene0 = performance.now()
      this.renderer.setRenderTarget(this.msaaTarget)
      this.renderer.clear(true, true, true)
      this.renderer.render(this.scene, this.camera)
      const sceneMs = performance.now() - tScene0
      // Resolved MSAA color → canvas (tone mapping already applied in main pass).
      const tBlit0 = performance.now()
      this.renderer.setRenderTarget(null)
      const prevTone = this.renderer.toneMapping
      const prevAutoClear = this.renderer.autoClear
      this.renderer.toneMapping = THREE.NoToneMapping
      this.renderer.autoClear = true
      this.renderer.render(this.blitScene, this.blitCamera)
      this.renderer.toneMapping = prevTone
      this.renderer.autoClear = prevAutoClear
      return { sceneMs, blitMs: performance.now() - tBlit0 }
    }
    const tScene0 = performance.now()
    this.renderer.setRenderTarget(null)
    this.renderer.render(this.scene, this.camera)
    return { sceneMs: performance.now() - tScene0, blitMs: 0 }
  }

  /**
   * Main WebGL pass with sub-meters:
   * - scene: beauty geometry (+ shadow maps baked into three.js render)
   * - extract: selective bloom material-swap + half-res emissive pass
   * - bloom: UnrealBloom / composite (fast: whole composer lives here as beauty)
   * - blit: MSAA resolve (only when bloom off + MSAA on)
   */
  private renderMainPass(): {
    sceneMs: number
    extractMs: number
    bloomMs: number
    blitMs: number
    mode: string
  } {
    const bloomWanted =
      !!this.bloom?.isActive() && renderQuality.getBloomEnabled() && !forceNoBloom()
    if (!bloomWanted) {
      const fwd = this.renderForwardPass()
      return {
        sceneMs: fwd.sceneMs,
        extractMs: 0,
        bloomMs: 0,
        blitMs: fwd.blitMs,
        mode: 'forward'
      }
    }

    // Hot-swap mode when mesh inventory crosses the selective cap (plaza hydrate).
    const mode = this.pickBloomMode(renderQuality.getOptions())
    if (this.bloom!.getMode() !== mode) {
      this.configureBloom(renderQuality.getOptions())
      if (this.bloomModeLogged !== mode) {
        this.bloomModeLogged = mode
        console.info(
          `[SceneHost] bloom mode=${mode} meshes≈${this.bloomMeshCount}` +
            (mode === 'fast'
              ? ' (1× scene + luminance threshold)'
              : ' (2× scene, half-res emissive extract)')
        )
      }
    }

    this.renderer.setRenderTarget(null)
    const split = this.bloom!.render()
    // Fast: beautyMs = full composer (scene+bloom). Selective: beauty = full-res scene only.
    if (split.mode === 'fast') {
      return {
        sceneMs: split.beautyMs,
        extractMs: 0,
        bloomMs: 0, // folded into scene (one composer; cannot split without custom passes)
        blitMs: 0,
        mode: 'bloom-fast'
      }
    }
    return {
      sceneMs: split.beautyMs,
      extractMs: split.extractMs,
      bloomMs: split.compositeMs,
      blitMs: 0,
      mode: 'bloom-selective'
    }
  }

  /** Draw one frame without starting the animation loop (used after asset hydration). */
  renderFrame(): void {
    if (this.orbitEnabled) this.controls.update()
    this.renderStats.begin()
    this.renderMainPass()
    this.nameTags.render(this.scene, this.camera)
    this.renderStats.end()
    this.renderStats.update()
  }

  start(opts: {
    onSyncFrame?: (delta: number) => void
    onAsyncFrame?: (delta: number) => Promise<void>
  } = {}): void {
    this.clock.start()
    this.adaptiveQuality.start()
    let asyncBusy = false
    let frameCount = 0
    let windowStart = performance.now()
    let windowSyncMs = 0
    let windowRenderMs = 0
    let windowAsyncMs = 0
    let windowFrames = 0
    let windowSlow = 0
    let lastAsyncMs = 0
    /** Don't console.warn every second at 40fps — DevTools logging itself tanks FPS. */
    let lastFpsWarnMs = 0
    this.lastFrameTime = 0

    this.renderer.setAnimationLoop(() => {
      const frameT0 = performance.now()
      const minInterval = Math.max(
        this.frameIntervalMs,
        typeof document !== 'undefined' && document.hidden
          ? SceneHost.HIDDEN_FRAME_INTERVAL_MS
          : 0
      )
      if (minInterval > 0 && this.lastFrameTime > 0) {
        if (frameT0 - this.lastFrameTime < minInterval) return
      }
      this.lastFrameTime = frameT0

      const delta = Math.min(this.clock.getDelta(), 0.1)
      frameCount++

      const syncT0 = performance.now()
      try {
        opts.onSyncFrame?.(delta)
      } catch (err) {
        if (frameCount <= 3) console.error('[SceneHost] syncFrame error:', err)
      }
      const syncMs = performance.now() - syncT0

      for (const listener of this.frameListeners) {
        try {
          listener(delta)
        } catch (err) {
          if (frameCount <= 3) console.error('[SceneHost] frameListener error:', err)
        }
      }

      this.renderStats.begin()
      if (this.orbitEnabled) this.controls.update()
      const renderT0 = performance.now()
      const mainSplit = this.renderMainPass()
      const mainMs = performance.now() - renderT0
      const tagsT0 = performance.now()
      this.nameTags.render(this.scene, this.camera)
      const tagsMs = performance.now() - tagsT0
      const renderMs = performance.now() - renderT0
      const info = this.renderer.info.render
      perfNoteRenderSplit({
        mainMs,
        tagsMs,
        sceneMs: mainSplit.sceneMs,
        extractMs: mainSplit.extractMs,
        bloomMs: mainSplit.bloomMs,
        blitMs: mainSplit.blitMs,
        mode: mainSplit.mode,
        shadowOn: this.renderer.shadowMap.enabled,
        drawCalls: info.calls,
        triangles: info.triangles
      })
      this.renderStats.end()
      this.renderStats.update()
      // Count completed frames only (skipped interval frames never reach here).
      this.adaptiveQuality.noteFrame()

      if (frameCount === 1) {
        console.info(
          '[SceneHost] first frame — cam:',
          this.camera.position.toArray().map((n) => n.toFixed(1)),
          'children:',
          this.scene.children.length,
          'msaa:',
          this.msaaSamples,
          'bloom:',
          this.bloom?.isActive() ? 'on' : 'off'
        )
      }

      if (!asyncBusy && opts.onAsyncFrame) {
        asyncBusy = true
        const asyncT0 = performance.now()
        opts
          .onAsyncFrame(delta)
          .catch((err) => console.error('[SceneHost] async frame failed', err))
          .finally(() => {
            lastAsyncMs = performance.now() - asyncT0
            asyncBusy = false
          })
      }

      const totalMs = performance.now() - frameT0
      windowSyncMs += syncMs
      windowRenderMs += renderMs
      windowAsyncMs += lastAsyncMs
      windowFrames++
      if (totalMs > 33) windowSlow++
      // Rolling FPS for MainFrameHud / RenderStats (update each ~1s window).
      let windowFps =
        windowFrames > 0
          ? (windowFrames * 1000) / Math.max(1, performance.now() - windowStart)
          : 0
      // Rollup every ~1s. Only warn on real pain (<28fps or many slow frames), and at most
      // every 5s — logging at 40fps with DevTools open was a self-inflicted hitch loop.
      if (performance.now() - windowStart >= 1000) {
        const n = Math.max(1, windowFrames)
        const fps = (windowFrames * 1000) / Math.max(1, performance.now() - windowStart)
        windowFps = fps
        const now = performance.now()
        const painful = fps < 28 || windowSlow > n * 0.25
        if (painful && now - lastFpsWarnMs > 5000) {
          lastFpsWarnMs = now
          // Opt-in only — spam console.warn every 5s under load worsens the hitch.
          clientDebugLog.consoleOnly(
            'warn',
            `[fps] ${fps.toFixed(0)}fps over ${windowFrames}f — ` +
              `sync=${(windowSyncMs / n).toFixed(1)}ms render=${(windowRenderMs / n).toFixed(1)}ms ` +
              `async~=${(windowAsyncMs / n).toFixed(1)}ms slow>${33}ms=${windowSlow}`
          )
        }
        windowStart = performance.now()
        windowSyncMs = 0
        windowRenderMs = 0
        windowAsyncMs = 0
        windowFrames = 0
        windowSlow = 0
      }
      // Main frame pie — splits former black-box "other" (sync sub + render + loop residual).
      perfNoteFrameHost({
        frameMs: totalMs,
        syncMs,
        renderMs,
        asyncMs: lastAsyncMs,
        fps: windowFps
      })
      for (const listener of this.postFrameListeners) {
        try {
          listener()
        } catch (err) {
          if (frameCount <= 3) console.error('[SceneHost] postFrameListener error:', err)
        }
      }
    })
  }

  stop(): void {
    this.renderer.setAnimationLoop(null)
    this.adaptiveQuality.stop()
  }

  dispose(): void {
    this.disposing = true
    this.resizeObserver?.disconnect()
    this.resizeObserver = null
    this.viewportElement = null
    this.onViewportResize = null
    this.stop()
    this.bloom?.dispose()
    this.bloom = null
    this.msaaTarget?.dispose()
    this.msaaTarget = null
    this.blitMaterial.dispose()
    this.nameTags.dispose()
    this.controls.dispose()
    this.renderStats.dom.remove()
    this.renderer.forceContextLoss()
    this.renderer.dispose()
    this.renderer.domElement.remove()
  }
}
