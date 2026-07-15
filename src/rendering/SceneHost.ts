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
import { clientSettings } from './ClientSettings'

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
  private resizeObserver: ResizeObserver | null = null
  private viewportElement: HTMLElement | null = null
  private onViewportResize: ((width: number, height: number) => void) | null = null
  /** Min ms between full frames; 0 = every rAF. */
  private frameIntervalMs = 0
  private lastFrameTime = 0
  /** Effective MSAA after GPU clamp (0 = render straight to canvas). */
  private msaaSamples: MsaaSamples = 0
  private msaaTarget: THREE.WebGLRenderTarget | null = null
  private readonly blitScene = new THREE.Scene()
  private readonly blitCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
  private readonly blitMaterial: THREE.MeshBasicMaterial
  private viewportCssW = 1
  private viewportCssH = 1

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

    this.camera = new THREE.PerspectiveCamera(clientSettings.getFov(), window.innerWidth / window.innerHeight, 0.1, 500)
    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.enableDamping = true
    this.controls.maxPolarAngle = Math.PI * 0.49
    this.nameTags = new NameTagRenderer(container)
    this.renderStats = new RenderStats()
    this.renderStats.attachRenderer(this.renderer, this.scene)

    // Quality apply resizes the viewport — camera + nameTags must already exist.
    this.applyRendererQuality(renderQuality.getOptions())
    renderQuality.subscribe((options) => this.applyRendererQuality(options))

    clientSettings.subscribe((s) => {
      this.camera.fov = s.fov
      this.camera.updateProjectionMatrix()
    })

    window.addEventListener('resize', () => this.applyViewportSize())
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
    this.renderer.setSize(width, height, false)
    this.ensureMsaaTargetSize()
    this.nameTags?.setSize(width, height)
    this.onViewportResize?.(width, height)
  }

  private applyViewportSize(): void {
    if (this.viewportElement) {
      this.setViewportSize(this.viewportElement.clientWidth, this.viewportElement.clientHeight)
      return
    }
    this.setViewportSize(window.innerWidth, window.innerHeight)
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
    const diagonal = Math.hypot(width, depth)

    this.camera.far = Math.max(800, diagonal * 1.25)
    this.camera.near = 0.1
    this.camera.updateProjectionMatrix()
  }

  setOrbitEnabled(enabled: boolean): void {
    this.orbitEnabled = enabled
    this.controls.enabled = enabled
  }

  addFrameListener(listener: (delta: number) => void): () => void {
    this.frameListeners.add(listener)
    return () => this.frameListeners.delete(listener)
  }

  /** ACES tone mapping + exposure, shadows, resolution scale, FPS cap, MSAA. */
  private applyRendererQuality(options: RenderQualityOptions): void {
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = TONE_MAPPING_EXPOSURE[options.tier]
    this.renderer.shadowMap.enabled = options.shadowQuality !== 'off'
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
    this.renderer.setPixelRatio(effectivePixelRatio(options.resolutionScale))

    // VSync On + Max FPS → pure rAF (display-aligned). VSync Off still uses rAF (browser limit).
    // Explicit FPS caps always apply.
    if (options.fpsLimit > 0) {
      this.frameIntervalMs = 1000 / options.fpsLimit
    } else {
      this.frameIntervalMs = 0
    }

    const maxSamples = this.renderer.capabilities.maxSamples ?? 0
    this.msaaSamples = clampMsaaSamples(options.msaaSamples, maxSamples)
    this.rebuildMsaaTarget()
    // Re-apply size so backing store matches new pixel ratio / MSAA buffer.
    this.applyViewportSize()
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

  private renderMainPass(): void {
    if (this.msaaTarget && this.msaaSamples > 0) {
      this.renderer.setRenderTarget(this.msaaTarget)
      this.renderer.clear(true, true, true)
      this.renderer.render(this.scene, this.camera)
      this.renderer.setRenderTarget(null)
      // Resolved MSAA color → canvas (tone mapping already applied in main pass).
      const prevTone = this.renderer.toneMapping
      const prevAutoClear = this.renderer.autoClear
      this.renderer.toneMapping = THREE.NoToneMapping
      this.renderer.autoClear = true
      this.renderer.render(this.blitScene, this.blitCamera)
      this.renderer.toneMapping = prevTone
      this.renderer.autoClear = prevAutoClear
    } else {
      this.renderer.setRenderTarget(null)
      this.renderer.render(this.scene, this.camera)
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
      if (this.frameIntervalMs > 0 && this.lastFrameTime > 0) {
        if (frameT0 - this.lastFrameTime < this.frameIntervalMs) return
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
      this.renderMainPass()
      this.nameTags.render(this.scene, this.camera)
      const renderMs = performance.now() - renderT0
      this.renderStats.end()
      this.renderStats.update()

      if (frameCount === 1) {
        console.info(
          '[SceneHost] first frame — cam:',
          this.camera.position.toArray().map((n) => n.toFixed(1)),
          'children:',
          this.scene.children.length,
          'msaa:',
          this.msaaSamples
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
      // Rollup every ~1s. Only warn on real pain (<28fps or many slow frames), and at most
      // every 5s — logging at 40fps with DevTools open was a self-inflicted hitch loop.
      if (performance.now() - windowStart >= 1000) {
        const n = Math.max(1, windowFrames)
        const fps = (windowFrames * 1000) / Math.max(1, performance.now() - windowStart)
        const now = performance.now()
        const painful = fps < 28 || windowSlow > n * 0.25
        if (painful && now - lastFpsWarnMs > 5000) {
          lastFpsWarnMs = now
          console.warn(
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
    })
  }

  stop(): void {
    this.renderer.setAnimationLoop(null)
  }

  dispose(): void {
    this.disposing = true
    this.resizeObserver?.disconnect()
    this.resizeObserver = null
    this.viewportElement = null
    this.onViewportResize = null
    this.stop()
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
