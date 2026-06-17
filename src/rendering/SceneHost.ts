import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import type { ResolvedScene } from '../dcl/content/types'
import type { SceneWorldBounds } from '../player/SceneBounds'
import { dclToThreePos } from '../bridge/dclTransform'
import { NameTagRenderer } from '../client/ui/NameTagRenderer'
import { RenderStats } from '../client/ui/RenderStats'
import {
  renderQuality,
  TONE_MAPPING_EXPOSURE,
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

  constructor(container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5))
    this.renderer.setSize(window.innerWidth, window.innerHeight)
    this.renderer.setClearColor(0x1a1a2e)
    this.applyRendererQuality(renderQuality.getOptions())
    renderQuality.subscribe((options) => this.applyRendererQuality(options))
    container.appendChild(this.renderer.domElement)

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

    clientSettings.subscribe((s) => {
      this.camera.fov = s.fov
      this.camera.updateProjectionMatrix()
    })

    window.addEventListener('resize', () => {
      this.camera.aspect = window.innerWidth / window.innerHeight
      this.camera.updateProjectionMatrix()
      this.renderer.setSize(window.innerWidth, window.innerHeight)
      this.nameTags.setSize(window.innerWidth, window.innerHeight)
    })
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

  /** ACES tone mapping + exposure; spot shadows capped at 3 lights in LightManager. */
  private applyRendererQuality(_options: RenderQualityOptions): void {
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = TONE_MAPPING_EXPOSURE[renderQuality.getTier()]
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
  }

  /** Draw one frame without starting the animation loop (used after asset hydration). */
  renderFrame(): void {
    if (this.orbitEnabled) this.controls.update()
    this.renderStats.begin()
    this.renderer.render(this.scene, this.camera)
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

    this.renderer.setAnimationLoop(() => {
      const delta = Math.min(this.clock.getDelta(), 0.1)
      frameCount++

      try {
        opts.onSyncFrame?.(delta)
      } catch (err) {
        if (frameCount <= 3) console.error('[SceneHost] syncFrame error:', err)
      }

      this.renderStats.begin()
      if (this.orbitEnabled) this.controls.update()
      this.renderer.render(this.scene, this.camera)
      this.nameTags.render(this.scene, this.camera)
      this.renderStats.end()
      this.renderStats.update()

      if (frameCount === 1) {
        console.info(
          '[SceneHost] first frame — cam:',
          this.camera.position.toArray().map((n) => n.toFixed(1)),
          'children:', this.scene.children.length
        )
      }

      if (!asyncBusy && opts.onAsyncFrame) {
        asyncBusy = true
        opts.onAsyncFrame(delta)
          .catch((err) => console.error('[SceneHost] async frame failed', err))
          .finally(() => { asyncBusy = false })
      }
    })
  }

  stop(): void {
    this.renderer.setAnimationLoop(null)
  }

  dispose(): void {
    this.disposing = true
    this.stop()
    this.nameTags.dispose()
    this.controls.dispose()
    this.renderStats.dom.remove()
    this.renderer.forceContextLoss()
    this.renderer.dispose()
    this.renderer.domElement.remove()
  }
}
