import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import type { ResolvedScene } from '../dcl/content/types'
import type { SceneWorldBounds } from '../player/SceneBounds'
import { dclToThreePos } from '../bridge/dclTransform'
import { genesisMetersFromSceneLocal } from '../dcl/aoi/parcelAoi'
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
import { reapplySceneCastShadows } from './shadowCastPolicy'
import { BloomPipeline } from './BloomPipeline'
import { DrawWorld } from './DrawWorld'
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
import { getSessionAssetCache } from './AssetCache'
import { isAppleTouchDevice } from '../util/appleTouch'
import { isHandheldDevice } from '../client/ui/touchPlayLayout'
import { isDocumentHidden } from '../util/documentVisibility'

/** Handheld Low path (phone + iPad). `?nomobile` skips. */
function isPhoneLowGfx(): boolean {
  return isHandheldDevice()
}

/** Bloom / HDR / MSAA cuts: phones + all Apple touch (iPad included). */
function skipBloomHdrMsaa(): boolean {
  return isHandheldDevice() || isAppleTouchDevice()
}

export class SceneHost {
  renderer: THREE.WebGLRenderer
  readonly scene: THREE.Scene
  /** Entity Transform graph — not a child of {@link scene}; present does not walk it. */
  readonly poseRoot = new THREE.Group()
  readonly drawWorld = new DrawWorld()
  readonly camera: THREE.PerspectiveCamera
  controls: OrbitControls
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
  /**
   * Min ms between full presents. Max FPS still rAF-paced with a 240 Hz floor so
   * PhysX CCT / mixers never see a 700 Hz free-run (1/dt HUD lie + ground jackhammer).
   * 144/165/240 Hz panels stay display-paced; the floor only bites when vsync is off.
   */
  private frameIntervalMs = 1000 / 240
  /** Ceiling for fpsLimit 0 (Max). Display rAF is usually slower; this only bites when vsync is off. */
  private static readonly MAX_PRESENT_INTERVAL_MS = 1000 / 240
  private lastFrameTime = 0
  private loopRunning = false
  private uncapTimer: ReturnType<typeof setTimeout> | 0 = 0
  private rafId = 0
  /** After tab focus, stay on rAF so GPU wake + orbit aren't a 2fps dump. */
  private static readonly RESUME_RAF_FRAMES = 48
  private resumeRafFrames = 0
  private loopTick: (() => void) | null = null
  /** Effective MSAA after GPU clamp (0 = render straight to canvas). */
  private msaaSamples: MsaaSamples = 0
  private msaaTarget: THREE.WebGLRenderTarget | null = null
  private readonly blitScene = new THREE.Scene()
  private readonly blitCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
  private readonly blitMaterial: THREE.MeshBasicMaterial
  private viewportCssW = 1
  private viewportCssH = 1
  private bloom: BloomPipeline | null = null
  private readonly adaptiveQuality = new AdaptiveQualityController()

  constructor(container: HTMLElement) {
    // Canvas AA off — sample count is controlled via multisample render target (runtime prefs).
    const appleTouch = isAppleTouchDevice()
    this.renderer = new THREE.WebGLRenderer({
      antialias: false,
      // iOS: extra high-performance contexts steal/lose the play context (shaderSource arg 1).
      powerPreference: appleTouch ? 'default' : 'high-performance',
      failIfMajorPerformanceCaveat: false,
      alpha: false,
      stencil: false
    })
    const pr = effectivePixelRatio(renderQuality.getResolutionScale())
    this.renderer.setPixelRatio(
      isPhoneLowGfx() ? Math.min(pr, 1.25) : appleTouch ? Math.min(pr, 1.5) : pr
    )
    this.renderer.setSize(window.innerWidth, window.innerHeight)
    this.renderer.setClearColor(0x1a1a2e)
    // Bloom composer calls renderer.render() per pass; autoReset made HUD draws:1.
    this.renderer.info.autoReset = false
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
      if (this.disposing) return
      // Without preventDefault Safari never restores — shaders then fail "not from this context".
      e.preventDefault()
      console.error('[SceneHost] WebGL context lost unexpectedly — GPU memory or driver reset?', e)
      getSessionAssetCache().invalidateGpuResources('webgl-context-lost')
    })

    this.scene = new THREE.Scene()
    this.scene.background = new THREE.Color(0x87ceeb)
    this.poseRoot.name = 'pose-root'
    this.scene.add(this.drawWorld.drawRoot)

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
    // iOS URL-bar / keyboard fire visualViewport scroll constantly — resizing WebGL
    // mid-walk hitches the camera (looks like a laggy head).
    if (!isAppleTouchDevice()) {
      window.visualViewport?.addEventListener('resize', () => this.applyViewportSize())
      window.visualViewport?.addEventListener('scroll', () => this.applyViewportSize())
    }
    document.addEventListener('visibilitychange', this.onVisibilityChange)
    window.addEventListener('focus', this.onWindowFocusChange)
    window.addEventListener('blur', this.onWindowFocusChange)
  }

  private readonly onWindowFocusChange = (): void => {
    this.kickLoop()
  }

  private readonly onVisibilityChange = (): void => {
    if (typeof document === 'undefined') return
    if (document.visibilityState === 'visible') {
      this.resumeRafFrames = SceneHost.RESUME_RAF_FRAMES
      this.lastFrameTime = 0
      // Drain the huge hidden-tab delta so the first orbit frame isn't a 100ms step.
      this.clock.getDelta()
    }
    // Hidden: pause the loop. Visible: rAF again.
    this.kickLoop()
  }

  private kickLoop(): void {
    if (!this.loopRunning || !this.loopTick) return
    if (this.uncapTimer) {
      clearTimeout(this.uncapTimer)
      this.uncapTimer = 0
    }
    if (this.rafId) {
      cancelAnimationFrame(this.rafId)
      this.rafId = 0
    }
    this.scheduleNext(this.loopTick)
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
    if (Math.abs(width - this.viewportCssW) < 2 && Math.abs(height - this.viewportCssH) < 2) return
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
    const vv = isAppleTouchDevice() ? null : window.visualViewport
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
    const origin = genesisMetersFromSceneLocal(0, 0, sceneConfig.baseParcel)
    const target = dclToThreePos(
      sceneConfig.spawn.x + origin.x,
      sceneConfig.spawn.y + 1.5,
      sceneConfig.spawn.z + origin.z
    )
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

  /**
   * Bevy extract: after pose flush + drawWorld.sync, before WebGL.
   * Billboard instance matrices land here — not in Update.
   */
  private extractHook: ((camera: THREE.Camera) => void) | null = null

  setExtractHook(hook: ((camera: THREE.Camera) => void) | null): void {
    this.extractHook = hook
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
    // r185: PCFSoft is deprecated (WebGL maps it to PCF). Medium+ uses PCF.
    this.renderer.shadowMap.type =
      shadowQ === 'ultra' || shadowQ === 'high' || shadowQ === 'medium'
        ? THREE.PCFShadowMap
        : THREE.BasicShadowMap
    const pr = effectivePixelRatio(resScale)
    this.renderer.setPixelRatio(isPhoneLowGfx() ? Math.min(pr, 1.25) : pr)

    // Avatar vs environment cast toggles (and shadow off/on) re-apply without reloading meshes.
    reapplySceneCastShadows(this.scene)

    // 30/60/120 cap via rAF + interval. Max (0) stays display-paced with a 240 Hz floor
    // so a vsync-less compositor cannot free-run PhysX at 700 Hz.
    if (options.fpsLimit > 0) {
      this.frameIntervalMs = 1000 / options.fpsLimit
    } else {
      this.frameIntervalMs = SceneHost.MAX_PRESENT_INTERVAL_MS
    }

    // Bloom Unreal path cannot take MSAA samples — FXAA runs on the bloom blit instead.
    // Effective bloom includes adaptive step-down; `?nobloom` forces off for A/B.
    // iOS: Linear beauty + ACES blit reads as solid white even without HDR.
    // iPad: MSAA offscreen FBO paints skinned avatars black (High prefs still request 4×).
    const cutPost = skipBloomHdrMsaa()
    const bloomOn =
      renderQuality.getBloomEnabled() && !forceNoBloom() && !cutPost
    const maxSamples = this.renderer.capabilities?.maxSamples ?? 0
    this.msaaSamples = bloomOn || cutPost ? 0 : clampMsaaSamples(options.msaaSamples, maxSamples)
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
      options.tier === 'ultra' ? 0.09 : options.tier === 'high' ? 0.08 : 0.06
    const bloomOn =
      renderQuality.getBloomEnabled() && !forceNoBloom() && !skipBloomHdrMsaa()
    this.bloom.configure(
      {
        enabled: bloomOn,
        // iOS Safari HalfFloat beauty blit often samples as solid white.
        // Phones (incl. Android) stay on the Low path — bloom/HDR off.
        hdr: options.hdrEnabled && !skipBloomHdrMsaa(),
        mode: 'fast',
        strength,
        threshold: 0.15,
        radius: 0.26
      },
      this.viewportCssW,
      this.viewportCssH,
      pr
    )
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

  /** Extract: flush pose, copy to draw list, billboard instance matrices. */
  private extractPass(): void {
    this.poseRoot.updateMatrixWorld(false)
    this.drawWorld.sync(this.camera)
    this.extractHook?.(this.camera)
  }

  /**
   * Main WebGL pass with sub-meters:
   * - extract: pose → draw list (not a Bevy RenderGraph)
   * - scene: beauty geometry (+ shadow maps baked into three.js render)
   * - bloom: UnrealBloom / composite (filter on the beauty buffer)
   * - blit: MSAA resolve (only when bloom off + MSAA on)
   */
  private renderMainPass(): {
    sceneMs: number
    extractMs: number
    bloomMs: number
    blitMs: number
    mode: string
  } {
    // Bevy stages we can do in Three: Update already ran (onSyncFrame).
    // Extract copies pose → GPU objects. Queue+Render is still WebGLRenderer.
    this.extractPass()
    const bloomWanted =
      !!this.bloom?.isActive() &&
      renderQuality.getBloomEnabled() &&
      !forceNoBloom() &&
      !skipBloomHdrMsaa()
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

    const split = this.bloom!.render()
    return {
      sceneMs: split.beautyMs,
      extractMs: split.extractMs,
      bloomMs: split.compositeMs,
      blitMs: 0,
      mode: 'bloom-post'
    }
  }

  /**
   * Compile beauty programs for the live graph. Three.js keys programs on the
   * current lights / fog / environment / tone mapping — those must already match
   * play. `compile()` only *starts* work (KHR_parallel_shader_compile); first
   * `render()` is what waits unless we await `compileAsync`.
   */
  async compileSceneShaders(): Promise<void> {
    try {
      this.drawWorld.sync(this.camera)
      const started = performance.now()
      const compileAsync = this.renderer.compileAsync?.bind(this.renderer)
      // iOS KHR_parallel_shader_compile / compileAsync often throws
      // "shaderSource: argument 1 is not a WebGLShader".
      if (compileAsync && !isAppleTouchDevice()) {
        await Promise.race([
          compileAsync(this.scene, this.camera),
          new Promise<void>((resolve) => setTimeout(resolve, 8_000))
        ])
      } else {
        this.renderer.compile(this.scene, this.camera)
      }
      console.info(`[SceneHost] shader compile ${(performance.now() - started).toFixed(0)}ms`)
    } catch (err) {
      console.warn('[SceneHost] compileSceneShaders failed', err)
    }
  }

  /**
   * Force the next present to recast sun shadows so dummy Jump In frames compile
   * the shadow-depth program, not just the beauty pass.
   */
  warmShadowAndBloomPresents(): void {
    this.renderer.shadowMap.needsUpdate = true
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
    let presentLock = false
    /** Don't console.warn every second at 40fps — DevTools logging itself tanks FPS. */
    let lastFpsWarnMs = 0
    this.lastFrameTime = 0
    this.stopLoop()
    this.loopRunning = true

    const tick = (): void => {
      const frameT0 = performance.now()
      // Hidden: rAF is frozen and the GPU is cold. Do not run world/AOI/SceneLoop
      // (was 10Hz timeout + SharedWorker — 3s background during load dumped a hitch
      // storm on the first visible frames). visibilitychange resumes via kickLoop.
      if (isDocumentHidden()) {
        this.clock.getDelta()
        this.scheduleNext(tick)
        return
      }
      const minInterval = this.frameIntervalMs
      if (minInterval > 0 && this.lastFrameTime > 0) {
        if (frameT0 - this.lastFrameTime < minInterval) {
          // Must reschedule — a bare return kills the loop (incognito default is 60fps + rAF).
          this.scheduleNext(tick)
          return
        }
      }
      this.lastFrameTime = frameT0

      const delta = Math.min(this.clock.getDelta(), 0.1)
      frameCount++

      presentLock = true
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

      let renderMs = 0
      this.renderStats.begin()
      if (this.orbitEnabled) this.controls.update()
      this.renderer.info?.reset?.()
      const renderT0 = performance.now()
      const mainSplit = this.renderMainPass()
      const mainMs = performance.now() - renderT0
      const tagsT0 = performance.now()
      this.nameTags.render(this.scene, this.camera)
      const tagsMs = performance.now() - tagsT0
      renderMs = performance.now() - renderT0
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
      this.adaptiveQuality.noteFrame()
      presentLock = false

      if (frameCount === 1) {
        console.info(
          '[SceneHost] first frame — cam:',
          this.camera.position.toArray().map((n) => n.toFixed(1)),
          'children:',
          this.scene.children.length,
          'msaa:',
          this.msaaSamples,
          'bloom:',
          this.bloom?.isActive() ? 'post' : 'off',
          'drawVisuals:',
          this.drawWorld.visualCount,
          'drawCalls:',
          info.calls,
          'tris:',
          info.triangles
        )
      }

      // Guest clock starts after this rAF returns. Do not idle-delay into the
      // next present and then drop — that starved live guests on CBD (19 ticks
      // per walk, snow onUpdate never applied flowers).
      if (!asyncBusy && opts.onAsyncFrame) {
        asyncBusy = true
        const asyncDelta = delta
        const kick = (): void => {
          if (presentLock) {
            setTimeout(kick, 0)
            return
          }
          const asyncT0 = performance.now()
          opts
            .onAsyncFrame!(asyncDelta)
            .catch((err) => console.error('[SceneHost] async frame failed', err))
            .finally(() => {
              lastAsyncMs = performance.now() - asyncT0
              asyncBusy = false
            })
        }
        setTimeout(kick, 0)
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
      this.scheduleNext(tick)
    }
    this.loopTick = tick
    this.scheduleNext(tick)
  }

  /**
   * 30/60/120 → rAF + interval. Max (fpsLimit 0) → rAF with a 240 Hz floor.
   * Hidden tabs: do not timeout-tick (that stacked AOI/SceneLoop work). Resume via
   * visibilitychange → kickLoop.
   */
  private scheduleNext(tick: () => void): void {
    if (!this.loopRunning) return
    if (this.resumeRafFrames > 0) this.resumeRafFrames--
    if (isDocumentHidden()) return
    this.rafId = requestAnimationFrame(tick)
  }

  private stopLoop(): void {
    this.loopRunning = false
    this.loopTick = null
    if (this.uncapTimer) {
      clearTimeout(this.uncapTimer)
      this.uncapTimer = 0
    }
    if (this.rafId) {
      cancelAnimationFrame(this.rafId)
      this.rafId = 0
    }
    this.renderer.setAnimationLoop(null)
  }

  stop(): void {
    this.stopLoop()
    this.adaptiveQuality.stop()
  }

  dispose(): void {
    this.disposing = true
    this.resizeObserver?.disconnect()
    this.resizeObserver = null
    this.viewportElement = null
    this.onViewportResize = null
    document.removeEventListener('visibilitychange', this.onVisibilityChange)
    window.removeEventListener('focus', this.onWindowFocusChange)
    window.removeEventListener('blur', this.onWindowFocusChange)
    this.stop()
    this.bloom?.dispose()
    this.bloom = null
    this.msaaTarget?.dispose()
    this.msaaTarget = null
    this.blitMaterial.dispose()
    this.nameTags.dispose()
    this.controls.dispose()
    this.renderStats.dom.remove()
    this.drawWorld.dispose()
    if (typeof this.renderer.forceContextLoss === 'function') this.renderer.forceContextLoss()
    this.renderer.dispose()
    this.renderer.domElement.remove()
  }
}
