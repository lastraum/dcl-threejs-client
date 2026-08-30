/**
 * Isolated Worlds catalog forest — own renderer/scene, not World.ts.
 * Blockout: tall box trees, circular pool discs. Local VRM walks the clearing.
 */
import * as THREE from 'three'
import { LocalAvatar } from '../avatar/LocalAvatar'
import type { AvatarLocomotionState } from '../avatar/AvatarAnimations'
import { getSessionAssetCache } from '../rendering/AssetCache'
import { clientSettings } from '../rendering/ClientSettings'
import { worldDisplayName, type WorldMapEntry } from './worldsCatalog'
import {
  FOREST_LANDING_RADIUS_M,
  FOREST_POOL_WATER_FRAC,
  layoutForestTrees,
  layoutWorldPools,
  type ForestPoolPose,
  type ForestTreePose
} from './worldsForestLayout'
import { ForestVeins } from './worldsForestVeins'
import { ForestTrees } from './worldsForestTrees'
import { ForestWalkTrail } from './worldsForestWalkTrail'
import { ForestNightSky } from './worldsForestSky'
import {
  createForestCurtainMaterial,
  createForestPoolDiscMaterial,
  createForestRimMaterial,
  ForestLanding
} from './worldsForestLanding'
import { ForestPoolOccupants } from './worldsForestOccupants'
import { NameTagRenderer } from '../client/ui/NameTagRenderer'
import { ForestRuneSeal } from './forestRuneSeal'
import { CameraShake } from '@vfx/effects/CameraShake.js'

type PoolBody = {
  entry: WorldMapEntry
  pose: ForestPoolPose
  mesh: THREE.Mesh
  shore: THREE.Mesh
  rim: THREE.Mesh
  pin: HTMLButtonElement
}

const PLAYER_HEIGHT = 1.7
const PLAYER_HALF_W = 0.28
const WALK_SPEED = 7.5
const RUN_SPEED = 10
const POINTER_LOOK_SPEED = 0.003
const PLAYER_TURN_SMOOTH = 12
const FACING_SPEED_MIN = 0.12
const CAM_PIVOT_HEIGHT_FAR = 1.48
const CAM_PIVOT_HEIGHT_NEAR = 1.72
const CAM_LOOK_HEIGHT_FAR = 1.42
const CAM_LOOK_HEIGHT_NEAR = 1.7
const CAM_HEIGHT_NEAR_DIST = 1.15
const CAM_HEIGHT_FAR_DIST = 6.0
const CAM_DISTANCE_DEFAULT = 3.5
const CAM_DISTANCE_MIN = 0.85
const CAM_DISTANCE_MAX = 48
const CAM_SHOULDER_OFFSET = 0.3
const CAM_SHOULDER_CLOSE_DIST = 1.4
const CAM_PITCH_DEFAULT = 0.35
const CAM_PITCH_MIN = 0
const CAM_PITCH_MAX = Math.PI / 2 - 0.02
const ZOOM_WHEEL_SPEED = 0.004
const PICK_DRAG_PX2 = 36
const SPARKS_PER_POOL = 26
const SPARKS_PER_POOL_GROUND = 16
const SPARKS_ON_LANDING_RING = 72
const SPARKS_ON_LANDING_GROUND = 180

const PLAYER = 0xd8d2c6

export type WorldsForestViewOptions = {
  onSelectWorld?: (worldName: string) => void
  onApproachWorld?: (entry: WorldMapEntry | null) => void
  profileId?: string | null
}

export class WorldsForestView {
  readonly root: HTMLDivElement
  private readonly canvas: HTMLCanvasElement
  private readonly pinLayer: HTMLDivElement
  private readonly hintEl: HTMLParagraphElement
  private readonly renderer: THREE.WebGLRenderer
  private readonly scene: THREE.Scene
  private readonly camera: THREE.PerspectiveCamera
  private readonly clock = new THREE.Clock()
  private readonly raycaster = new THREE.Raycaster()
  private readonly pointerNdc = new THREE.Vector2()
  private readonly onSelectWorld?: (worldName: string) => void
  private readonly onApproachWorld?: (entry: WorldMapEntry | null) => void

  private readonly groundGeo: THREE.PlaneGeometry
  private readonly groundMat: THREE.MeshStandardMaterial
  private readonly ground: THREE.Mesh
  private readonly landingGeo: THREE.CircleGeometry
  private readonly landingMat: THREE.MeshStandardMaterial
  private readonly landingRimGeo: THREE.RingGeometry
  private readonly landingRimMat: THREE.MeshStandardMaterial
  private readonly poolGeo: THREE.CircleGeometry
  private readonly shoreGeo: THREE.RingGeometry
  private readonly poolRimGeo: THREE.CircleGeometry
  private readonly poolRimMat: THREE.ShaderMaterial
  private readonly curtainGeo: THREE.CylinderGeometry
  private readonly curtainMat: THREE.ShaderMaterial
  private readonly curtain: THREE.Mesh
  private readonly playerMat: THREE.MeshStandardMaterial
  private readonly fallbackPoolMat: THREE.ShaderMaterial
  private readonly poolFieldTime = { value: 0 }
  private readonly shoreMat: THREE.MeshStandardMaterial

  private readonly pools = new Map<string, PoolBody>()
  private readonly keys = new Set<string>()
  private trees: ForestTrees | null = null
  private treePoses: ForestTreePose[] = []
  private readonly player: THREE.Mesh
  private readonly playerRoot = new THREE.Group()
  private avatar: LocalAvatar | null = null
  private avatarReady = false
  private sparks: PoolSparkles | null = null
  private veins: ForestVeins | null = null
  private walkTrail: ForestWalkTrail | null = null
  private nightSky: ForestNightSky | null = null
  private landingGlb: ForestLanding | null = null
  private occupants: ForestPoolOccupants | null = null
  private nameTags: NameTagRenderer | null = null
  private runeSeal: ForestRuneSeal | null = null
  private locomotionLocked = false
  private readonly sealResolution = new THREE.Vector2(1, 1)
  private readonly shakeRig = { shakeOffset: new THREE.Vector3(), shakeRoll: 0 }
  private readonly shake = new CameraShake(this.shakeRig)

  private active = false
  private disposed = false
  private rafId = 0
  private size = { w: 1, h: 1 }
  private focusedKey: string | null = null
  private approachedKey: string | null = null
  private curtainOn = 0
  private curtainX = 0
  private curtainZ = 0
  private curtainR = 1
  /** Orbit yaw — independent of avatar facing. Same convention as PlayerSystem. */
  private camYaw = 0
  private camPitch = CAM_PITCH_DEFAULT
  private camDistance = CAM_DISTANCE_DEFAULT
  private playerYaw = 0
  private playerX = 0
  private playerZ = 0
  private moveSpeed = 0
  private drag: { id: number; x: number; y: number; looking: boolean } | null = null
  private firstFrameDone = false
  private worldNamesKey = ''
  private readonly firstFrameWaiters: Array<() => void> = []
  private readonly profileId: string | null

  constructor(opts: WorldsForestViewOptions = {}) {
    this.onSelectWorld = opts.onSelectWorld
    this.onApproachWorld = opts.onApproachWorld
    this.profileId = opts.profileId?.trim() || null

    this.root = document.createElement('div')
    this.root.className = 'dcl-map__worlds-forest'
    this.root.hidden = true
    this.root.setAttribute('aria-label', 'Worlds forest')

    this.canvas = document.createElement('canvas')
    this.canvas.className = 'dcl-map__worlds-canvas'
    this.canvas.tabIndex = 0

    this.pinLayer = document.createElement('div')
    this.pinLayer.className = 'dcl-map__worlds-pins'
    this.pinLayer.hidden = true
    this.pinLayer.setAttribute('aria-hidden', 'true')

    this.hintEl = document.createElement('p')
    this.hintEl.className = 'dcl-map__worlds-forest-hint'
    this.hintEl.textContent = 'WASD walk · drag to orbit · scroll zoom · click a pool'

    this.root.append(this.canvas, this.pinLayer, this.hintEl)

    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance'
    })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    this.renderer.setClearColor(0x321c44, 1)
    this.renderer.outputColorSpace = THREE.SRGBColorSpace

    this.scene = new THREE.Scene()
    this.scene.fog = new THREE.FogExp2(0x4a0070, 0.0076)
    this.scene.background = new THREE.Color(0x321c44)

    this.camera = new THREE.PerspectiveCamera(60, 1, 0.12, 1400)
    this.nightSky = new ForestNightSky(this.scene, this.camera)

    this.groundGeo = new THREE.PlaneGeometry(2400, 2400)
    this.groundMat = new THREE.MeshStandardMaterial({
      color: 0x2c223a,
      roughness: 0.94,
      metalness: 0.02
    })
    this.ground = new THREE.Mesh(this.groundGeo, this.groundMat)
    this.ground.name = 'forest-ground'
    this.ground.rotation.x = -Math.PI / 2
    this.ground.position.y = 0
    this.ground.receiveShadow = false
    this.ground.frustumCulled = false
    this.scene.add(this.ground)

    this.landingGeo = new THREE.CircleGeometry(FOREST_LANDING_RADIUS_M, 64)
    this.landingMat = new THREE.MeshStandardMaterial({
      color: 0xc5c0b4,
      roughness: 0.82,
      metalness: 0.04
    })
    const landing = new THREE.Mesh(this.landingGeo, this.landingMat)
    landing.name = 'forest-landing-fallback'
    landing.rotation.x = -Math.PI / 2
    landing.position.y = 0.03
    this.scene.add(landing)

    this.landingRimGeo = new THREE.RingGeometry(
      FOREST_LANDING_RADIUS_M * 0.97,
      FOREST_LANDING_RADIUS_M * 1.035,
      64
    )
    this.landingRimMat = new THREE.MeshStandardMaterial({
      color: 0x9fefff,
      roughness: 0.28,
      metalness: 0.08,
      emissive: 0x3ec8e0,
      emissiveIntensity: 1.15,
      side: THREE.DoubleSide
    })
    const landingRim = new THREE.Mesh(this.landingRimGeo, this.landingRimMat)
    landingRim.rotation.x = -Math.PI / 2
    landingRim.position.y = 0.08
    this.scene.add(landingRim)
    this.landingGlb = new ForestLanding(this.scene, landing, landingRim)

    this.poolGeo = new THREE.CircleGeometry(1, 40)
    this.shoreGeo = new THREE.RingGeometry(FOREST_POOL_WATER_FRAC, 1, 40)
    this.poolRimGeo = new THREE.RingGeometry(FOREST_POOL_WATER_FRAC, 1, 64)
    this.poolRimMat = createForestRimMaterial(FOREST_POOL_WATER_FRAC)
    this.curtainGeo = new THREE.CylinderGeometry(1, 1, 1, 96, 1, true)
    this.curtainMat = createForestCurtainMaterial()
    this.curtain = new THREE.Mesh(this.curtainGeo, this.curtainMat)
    this.curtain.name = 'forest-pool-curtain'
    this.curtain.visible = false
    this.curtain.renderOrder = 5
    this.curtain.frustumCulled = false
    this.curtain.raycast = () => {}
    this.scene.add(this.curtain)
    this.playerMat = new THREE.MeshStandardMaterial({
      color: PLAYER,
      roughness: 0.55,
      metalness: 0.08
    })
    this.fallbackPoolMat = createForestPoolDiscMaterial()
    this.shoreMat = new THREE.MeshStandardMaterial({
      color: 0x2c223a,
      roughness: 0.95,
      metalness: 0.02
    })

    const playerGeo = new THREE.BoxGeometry(PLAYER_HALF_W * 2, PLAYER_HEIGHT, 0.36)
    this.player = new THREE.Mesh(playerGeo, this.playerMat)
    this.player.position.set(0, PLAYER_HEIGHT / 2, 0)
    this.playerRoot.name = 'forest-player'
    this.playerRoot.add(this.player)
    this.scene.add(this.playerRoot)
    this.avatar = new LocalAvatar(this.playerRoot)
    this.avatar.setAssetCache(getSessionAssetCache())

    this.sparks = new PoolSparkles(this.scene)
    this.sparks.setPools([])
    this.trees = new ForestTrees(this.scene)
    this.veins = new ForestVeins(this.scene)
    this.walkTrail = new ForestWalkTrail(this.scene)
    this.occupants = new ForestPoolOccupants(this.scene)
    this.nameTags = new NameTagRenderer(this.root)

    this.canvas.addEventListener('pointerdown', this.onPointerDown)
    this.canvas.addEventListener('pointermove', this.onPointerMove)
    this.canvas.addEventListener('pointerup', this.onPointerUp)
    this.canvas.addEventListener('pointercancel', this.onPointerUp)
    this.canvas.addEventListener('lostpointercapture', this.onPointerUp)
    this.canvas.addEventListener('wheel', this.onWheel, { passive: false })

    this.runeSeal = new ForestRuneSeal(this.scene)
  }

  setActive(active: boolean): void {
    if (this.disposed) return
    this.active = active
    this.root.hidden = !active
    if (active) {
      this.clock.start()
      this.resize(this.size.w, this.size.h)
      this.startLoop()
      this.canvas.focus({ preventScroll: true })
    } else {
      this.keys.clear()
      this.drag = null
      this.stopLoop()
    }
  }

  isActive(): boolean {
    return this.active
  }

  resize(w: number, h: number): void {
    const width = Math.max(1, Math.floor(w))
    const height = Math.max(1, Math.floor(h))
    this.size = { w: width, h: height }
    if (!this.active) return
    this.camera.aspect = width / height
    this.camera.updateProjectionMatrix()
    this.renderer.setSize(width, height, false)
    this.sealResolution.set(width, height)
    this.nameTags?.setSize(width, height)
  }

  setWorlds(entries: WorldMapEntry[]): void {
    if (this.disposed) return
    const poses = layoutWorldPools(entries)
    const namesKey = poses
      .map((p) => p.worldName.toLowerCase())
      .sort()
      .join('|')
    const firstLayout = !this.worldNamesKey
    const worldsChanged = namesKey !== this.worldNamesKey
    this.worldNamesKey = namesKey
    const byKey = new Map(entries.map((e) => [e.worldName.toLowerCase(), e] as const))
    const nextKeys = new Set(poses.map((p) => p.worldName.toLowerCase()))

    for (const [key, body] of this.pools) {
      if (nextKeys.has(key)) continue
      this.scene.remove(body.mesh, body.shore, body.rim)
      this.disposePoolMesh(body.mesh)
      body.pin.remove()
      this.pools.delete(key)
      if (this.focusedKey === key) this.focusedKey = null
      if (this.approachedKey === key) {
        this.approachedKey = null
        this.onApproachWorld?.(null)
      }
    }

    for (const pose of poses) {
      const key = pose.worldName.toLowerCase()
      const entry = byKey.get(key)
      if (!entry) continue
      let body = this.pools.get(key)
      if (!body) {
        body = this.createPool(entry, pose)
        this.pools.set(key, body)
        this.scene.add(body.mesh, body.shore, body.rim)
        this.pinLayer.appendChild(body.pin)
      } else {
        body.entry = entry
        body.pose = pose
        this.tintPool(body)
        body.pin.textContent = pinLabel(entry)
        body.pin.title = pinTitle(entry)
        body.pin.classList.toggle('is-focused', this.focusedKey === key)
      }
    }

    if (worldsChanged) this.rebuildTrees(poses)
    this.occupants?.sync(poses, entries)
    this.sparks?.setPools([...this.pools.values()])
    this.syncVeins()
    if (firstLayout) this.faceMostActiveIfAtSpawn(poses)
  }

  async loadPlayerAvatar(): Promise<void> {
    if (this.disposed || !this.avatar) return
    try {
      await this.avatar.load({ profileId: this.profileId ?? undefined })
      if (this.disposed) return
      this.avatarReady = true
      this.player.visible = false
    } catch (err) {
      console.warn('[forest] avatar load failed — keeping stand-in', err)
      this.avatarReady = false
      this.player.visible = true
    }
  }

  /** Sidebar / search — walk-camera to the pool, then open the world sheet. */
  waitForFirstFrame(): Promise<void> {
    if (this.disposed || this.firstFrameDone) return Promise.resolve()
    return new Promise((resolve) => this.firstFrameWaiters.push(resolve))
  }

  async prewarmRuneSeal(): Promise<void> {
    if (this.disposed) return
    if (!this.runeSeal) this.runeSeal = new ForestRuneSeal(this.scene)
    await this.runeSeal.prewarm(this.renderer, this.camera, this.scene)
  }

  focusWorld(worldName: string): void {
    const body = this.selectWorld(worldName)
    if (!body) return
    const p = body.pose
    const dist = p.radius + 3.2
    const ang = Math.atan2(p.z, p.x)
    this.playerX = p.x - Math.cos(ang) * dist
    this.playerZ = p.z - Math.sin(ang) * dist
    this.resolveTreeCollisions()
    this.syncPlayerPose()
    this.camYaw = Math.atan2(-(p.x - this.playerX), -(p.z - this.playerZ))
    this.playerYaw = this.camYaw
    this.avatar?.setYaw(this.playerYaw)
  }

  /** Click a pool in the forest — highlight + Jump In sheet, do not teleport. */
  private selectWorld(worldName: string): PoolBody | null {
    const body = this.pools.get(worldName.toLowerCase())
    if (!body || this.disposed) return null
    const key = worldName.toLowerCase()
    this.focusedKey = key
    for (const [k, b] of this.pools) {
      b.pin.classList.toggle('is-focused', k === key)
    }
    this.onSelectWorld?.(body.entry.worldName)
    return body
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.active = false
    this.stopLoop()
    this.keys.clear()
    this.shake.reset()
    this.unbindKeys()
    this.canvas.removeEventListener('pointerdown', this.onPointerDown)
    this.canvas.removeEventListener('pointermove', this.onPointerMove)
    this.canvas.removeEventListener('pointerup', this.onPointerUp)
    this.canvas.removeEventListener('pointercancel', this.onPointerUp)
    this.canvas.removeEventListener('lostpointercapture', this.onPointerUp)
    this.canvas.removeEventListener('wheel', this.onWheel)
    for (const body of this.pools.values()) {
      this.scene.remove(body.mesh, body.shore, body.rim)
      this.disposePoolMesh(body.mesh)
      body.pin.remove()
    }
    this.pools.clear()
    this.trees?.dispose()
    this.trees = null
    this.sparks?.dispose()
    this.sparks = null
    this.veins?.dispose()
    this.veins = null
    this.walkTrail?.dispose()
    this.walkTrail = null
    this.nightSky?.dispose()
    this.nightSky = null
    this.landingGlb?.dispose()
    this.landingGlb = null
    this.occupants?.dispose()
    this.occupants = null
    this.runeSeal?.dispose()
    this.runeSeal = null
    this.nameTags?.dispose()
    this.nameTags = null
    this.avatar?.dispose()
    this.avatar = null
    // Occupants + local avatar composed into the session AssetCache on this
    // renderer. Jump In builds a new World + WebGLRenderer — ImageBitmaps still
    // bound to the dead context remount as a black silhouette (same as World.dispose).
    getSessionAssetCache().invalidateGpuResources('forest-dispose')
    this.player.geometry.dispose()
    this.groundGeo.dispose()
    this.groundMat.dispose()
    this.landingGeo.dispose()
    this.landingMat.dispose()
    this.landingRimGeo.dispose()
    this.landingRimMat.dispose()
    this.poolGeo.dispose()
    this.shoreGeo.dispose()
    this.poolRimGeo.dispose()
    this.poolRimMat.dispose()
    this.curtain.removeFromParent()
    this.curtainGeo.dispose()
    this.curtainMat.dispose()
    this.playerMat.dispose()
    this.fallbackPoolMat.dispose()
    this.shoreMat.dispose()
    if (typeof this.renderer.forceContextLoss === 'function') this.renderer.forceContextLoss()
    this.renderer.dispose()
    this.root.remove()
  }

  private createPool(entry: WorldMapEntry, pose: ForestPoolPose): PoolBody {
    const mat = this.fallbackPoolMat.clone()
    mat.uniforms.uTime = this.poolFieldTime
    const mesh = new THREE.Mesh(this.poolGeo, mat)
    mesh.rotation.x = -Math.PI / 2
    mesh.position.set(pose.x, 0.04, pose.z)
    mesh.scale.setScalar(pose.radius * FOREST_POOL_WATER_FRAC)
    mesh.userData.worldName = entry.worldName
    mesh.userData.worldKey = entry.worldName.toLowerCase()

    const shore = new THREE.Mesh(this.shoreGeo, this.shoreMat)
    shore.rotation.x = -Math.PI / 2
    shore.position.set(pose.x, 0.02, pose.z)
    shore.scale.setScalar(pose.radius)
    shore.raycast = () => {}

    const rim = new THREE.Mesh(this.poolRimGeo, this.poolRimMat)
    rim.rotation.x = -Math.PI / 2
    rim.position.set(pose.x, 0.055, pose.z)
    rim.scale.setScalar(pose.radius)
    rim.renderOrder = 4
    rim.frustumCulled = false
    rim.raycast = () => {}

    const pin = document.createElement('button')
    pin.type = 'button'
    pin.className = 'dcl-map__worlds-pin'
    pin.textContent = pinLabel(entry)
    pin.title = pinTitle(entry)
    pin.addEventListener('click', (ev) => {
      ev.stopPropagation()
      this.selectWorld(entry.worldName)
    })

    const body: PoolBody = { entry, pose, mesh, shore, rim, pin }
    this.tintPool(body)
    return body
  }

  private tintPool(body: PoolBody): void {
    const mat = body.mesh.material as THREE.ShaderMaterial
    if (mat.uniforms?.uLive) mat.uniforms.uLive.value = body.entry.users > 0 ? 1 : 0
  }

  private rebuildTrees(pools: ForestPoolPose[]): void {
    const layoutKey = pools
      .map((p) => p.worldName.toLowerCase())
      .sort()
      .join('|')
    const poses = layoutForestTrees(pools)
    this.treePoses = poses
    this.trees?.setPoses(poses, layoutKey)
  }

  private faceMostActiveIfAtSpawn(poses: ForestPoolPose[]): void {
    if (Math.hypot(this.playerX, this.playerZ) > 0.8) return
    const first = poses[0]
    if (!first) return
    this.camYaw = Math.atan2(-(first.x - this.playerX), -(first.z - this.playerZ))
    this.playerYaw = this.camYaw
    this.avatar?.setYaw(this.playerYaw)
  }

  private startLoop(): void {
    this.stopLoop()
    this.bindKeys()
    const tick = () => {
      if (!this.active || this.disposed) return
      this.rafId = requestAnimationFrame(tick)
      const dt = Math.min(0.05, this.clock.getDelta())
      this.stepPlayer(dt)
      this.lerpPools(dt)
      this.sparks?.update(dt, this.pools)
      this.veins?.update(this.clock.elapsedTime, this.playerX, this.playerZ, dt)
      this.walkTrail?.update(
        dt,
        this.clock.elapsedTime,
        this.playerX,
        this.playerZ,
        this.moveSpeed > FACING_SPEED_MIN,
        this.playerYaw
      )
      this.nightSky?.update(dt)
      this.landingGlb?.update(this.clock.elapsedTime)
      this.runeSeal?.update(dt, this.clock.elapsedTime, this.sealResolution, this.camera)
      if (this.runeSeal?.isBeamLive()) this.shake.rumble(0.085, dt)
      this.shake.update(dt)
      this.poolFieldTime.value = this.clock.elapsedTime
      this.poolRimMat.uniforms.uTime.value = this.clock.elapsedTime
      this.updateApproach(dt)
      this.trees?.update(this.clock.elapsedTime, this.playerX, this.playerZ)
      this.ground.position.set(
        Math.round(this.playerX / 32) * 32,
        0,
        Math.round(this.playerZ / 32) * 32
      )
      this.occupants?.update(dt)
      this.updateCamera()
      this.renderer.render(this.scene, this.camera)
      this.nameTags?.render(this.scene, this.camera)
      this.updatePins()
      if (!this.firstFrameDone) {
        this.firstFrameDone = true
        const waiters = this.firstFrameWaiters.splice(0)
        for (const w of waiters) w()
      }
    }
    this.rafId = requestAnimationFrame(tick)
  }

  private stopLoop(): void {
    if (this.rafId) cancelAnimationFrame(this.rafId)
    this.rafId = 0
    this.unbindKeys()
  }

  private bindKeys(): void {
    window.addEventListener('keydown', this.onKeyDown)
    window.addEventListener('keyup', this.onKeyUp)
    window.addEventListener('blur', this.onBlur)
  }

  private unbindKeys(): void {
    window.removeEventListener('keydown', this.onKeyDown)
    window.removeEventListener('keyup', this.onKeyUp)
    window.removeEventListener('blur', this.onBlur)
  }

  private onKeyDown = (ev: KeyboardEvent): void => {
    if (!this.active || this.disposed) return
    if (this.locomotionLocked) {
      ev.preventDefault()
      return
    }
    if (isTypingTarget()) return
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return
    const code = ev.code
    if (
      code === 'KeyW' ||
      code === 'KeyA' ||
      code === 'KeyS' ||
      code === 'KeyD' ||
      code === 'ShiftLeft' ||
      code === 'ShiftRight' ||
      code === 'ArrowUp' ||
      code === 'ArrowDown' ||
      code === 'ArrowLeft' ||
      code === 'ArrowRight'
    ) {
      this.keys.add(code)
      ev.preventDefault()
    }
  }

  private onKeyUp = (ev: KeyboardEvent): void => {
    this.keys.delete(ev.code)
  }

  private onBlur = (): void => {
    this.keys.clear()
  }

  playJumpSeal(): Promise<void> {
    if (this.locomotionLocked && this.runeSeal) {
      return new Promise((resolve) => {
        const wait = () => {
          if (!this.locomotionLocked) resolve()
          else requestAnimationFrame(wait)
        }
        wait()
      })
    }
    this.locomotionLocked = true
    this.keys.clear()
    this.moveSpeed = 0
    this.curtainOn = 0
    this.curtain.visible = false
    const approached =
      (this.approachedKey ? this.pools.get(this.approachedKey) : null) ??
      (this.focusedKey ? this.pools.get(this.focusedKey) : null)
    const x = approached ? approached.mesh.position.x : this.playerX
    const z = approached ? approached.mesh.position.z : this.playerZ
    const radius = approached ? Math.max(2.4, approached.pose.radius * 1.05) : 3.6
    if (!this.runeSeal) this.runeSeal = new ForestRuneSeal(this.scene)
    return this.runeSeal.play({
      x,
      z,
      yaw: 0,
      radius,
      onBurst: () => this.hidePlayer(),
      onDischarge: () => this.shake.add(0.92, 1 / 0.65, 20)
    })
  }

  private hidePlayer(): void {
    this.playerRoot.visible = false
  }

  private stepPlayer(dt: number): void {
    if (this.locomotionLocked) {
      this.moveSpeed = 0
      this.syncPlayerPose()
      this.avatar?.update(dt, this.locomotionState(0, 0))
      return
    }
    const sin = Math.sin(this.camYaw)
    const cos = Math.cos(this.camYaw)
    // Same basis as PlayerSystem freecam: -Z look, +X right.
    const fwdX = -sin
    const fwdZ = -cos
    const rightX = cos
    const rightZ = -sin

    let ax = 0
    let az = 0
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) az += 1
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) az -= 1
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) ax += 1
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) ax -= 1

    let dx = 0
    let dz = 0
    if (ax !== 0 || az !== 0) {
      const len = Math.hypot(ax, az) || 1
      ax /= len
      az /= len
      dx = fwdX * az + rightX * ax
      dz = fwdZ * az + rightZ * ax
      const run = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight')
      const speed = run ? RUN_SPEED : WALK_SPEED
      this.playerX += dx * speed * dt
      this.playerZ += dz * speed * dt
      this.moveSpeed = speed
    } else {
      this.moveSpeed = 0
    }

    this.resolveTreeCollisions()

    const moving = this.moveSpeed > FACING_SPEED_MIN
    if (moving) {
      const targetYaw = Math.atan2(-dx, -dz)
      const turnAlpha = 1 - Math.exp(-PLAYER_TURN_SMOOTH * dt)
      this.playerYaw = lerpAngle(this.playerYaw, targetYaw, turnAlpha)
    }

    this.syncPlayerPose()
    this.avatar?.setYaw(this.playerYaw)
    this.avatar?.update(dt, this.locomotionState(dx, dz))
  }

  private syncPlayerPose(): void {
    this.playerRoot.position.set(this.playerX, 0, this.playerZ)
    if (!this.avatarReady) this.player.rotation.y = this.playerYaw
  }

  private locomotionState(dx: number, dz: number): AvatarLocomotionState {
    const moving = this.moveSpeed > FACING_SPEED_MIN
    const run = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight')
    const mode = !moving ? 'walk' : run ? 'run' : 'jog'
    const sin = Math.sin(this.playerYaw)
    const cos = Math.cos(this.playerYaw)
    // Avatar-local +X right, -Z forward.
    const localX = dx * cos - dz * sin
    const localZ = -(dx * sin + dz * cos)
    return {
      horizontalSpeed: this.moveSpeed,
      grounded: true,
      nearGround: true,
      verticalVelocity: 0,
      locomotionMode: mode,
      jumping: false,
      doubleJumping: false,
      falling: false,
      gliding: false,
      moveAxisX: moving ? localX : 0,
      moveAxisZ: moving ? localZ : 0,
      targetLocomotionSpeed: moving ? this.moveSpeed : 0
    }
  }

  private resolveTreeCollisions(): void {
    const pr = PLAYER_HALF_W + 0.12
    const colliders = this.trees?.colliders() ?? this.treePoses
    for (const t of colliders) {
      const dx = this.playerX - t.x
      const dz = this.playerZ - t.z
      const min = pr + t.width * 0.5
      const d = Math.hypot(dx, dz)
      if (d >= min || d < 1e-5) continue
      const push = (min - d) / d
      this.playerX += dx * push
      this.playerZ += dz * push
    }
  }

  private updateApproach(dt: number): void {
    if (this.locomotionLocked) {
      this.curtainOn = 0
      this.curtain.visible = false
      this.curtainMat.uniforms.uOn.value = 0
      return
    }
    let best: PoolBody | null = null
    let bestD = Infinity
    for (const body of this.pools.values()) {
      const d = Math.hypot(this.playerX - body.pose.x, this.playerZ - body.pose.z)
      const key = body.pose.worldName.toLowerCase()
      const enter = body.pose.radius + 0.28
      const leave = body.pose.radius + 1.2
      const thresh = this.approachedKey === key ? leave : enter
      if (d <= thresh && d < bestD) {
        best = body
        bestD = d
      }
    }
    const nextKey = best?.pose.worldName.toLowerCase() ?? null
    if (best) {
      this.curtainX = best.mesh.position.x
      this.curtainZ = best.mesh.position.z
      this.curtainR = Math.max(0.8, best.pose.radius)
    }
    const want = best ? 1 : 0
    this.curtainOn += (want - this.curtainOn) * (1 - Math.exp(-dt * 7.5))
    if (this.curtainOn < 0.008 && !best) this.curtainOn = 0
    const h = 6.4
    this.curtain.visible = this.curtainOn > 0.01
    this.curtain.position.set(this.curtainX, 0.08 + h * 0.5, this.curtainZ)
    this.curtain.scale.set(this.curtainR * 1.04, h, this.curtainR * 1.04)
    this.curtainMat.uniforms.uTime.value = this.clock.elapsedTime
    this.curtainMat.uniforms.uOn.value = this.curtainOn
    this.curtainMat.uniforms.uOrigin.value.set(this.curtainX, this.curtainZ)

    if (nextKey === this.approachedKey) return
    this.approachedKey = nextKey
    this.onApproachWorld?.(best?.entry ?? null)
  }

  private lerpPools(dt: number): void {
    const k = 1 - Math.exp(-dt * 3.2)
    for (const body of this.pools.values()) {
      const p = body.pose
      body.mesh.position.x += (p.x - body.mesh.position.x) * k
      body.mesh.position.z += (p.z - body.mesh.position.z) * k
      const water = p.radius * FOREST_POOL_WATER_FRAC
      const s = body.mesh.scale.x + (water - body.mesh.scale.x) * k
      body.mesh.scale.setScalar(s)
      body.shore.position.x = body.mesh.position.x
      body.shore.position.z = body.mesh.position.z
      body.shore.scale.setScalar(p.radius)
      body.rim.position.x = body.mesh.position.x
      body.rim.position.z = body.mesh.position.z
      body.rim.scale.setScalar(p.radius)
    }
  }

  private updateCamera(): void {
    const h = camHeightsForDistance(this.camDistance)
    const cosPitch = Math.cos(this.camPitch)
    const sinPitch = Math.sin(this.camPitch)
    let ox = Math.sin(this.camYaw) * cosPitch * this.camDistance
    let oy = sinPitch * this.camDistance
    let oz = Math.cos(this.camYaw) * cosPitch * this.camDistance
    if (this.camPitch < 0.65 && this.camDistance > CAM_SHOULDER_CLOSE_DIST) {
      const shoulderScale =
        (1 - this.camPitch / 0.65) *
        Math.min(
          1,
          (this.camDistance - CAM_SHOULDER_CLOSE_DIST) /
            (CAM_HEIGHT_FAR_DIST - CAM_SHOULDER_CLOSE_DIST)
        )
      ox += Math.cos(this.camYaw) * CAM_SHOULDER_OFFSET * shoulderScale
      oz += -Math.sin(this.camYaw) * CAM_SHOULDER_OFFSET * shoulderScale
    }
    this.camera.position.set(this.playerX + ox, h.pivotY + oy, this.playerZ + oz)
    this.camera.lookAt(this.playerX, h.lookY, this.playerZ)
    if (this.shakeRig.shakeOffset.lengthSq() > 0) {
      this.camera.position.add(this.shakeRig.shakeOffset)
      this.camera.rotateZ(this.shakeRig.shakeRoll)
    }
  }

  private onPointerDown = (ev: PointerEvent): void => {
    if (!this.active || this.disposed || this.locomotionLocked || ev.button !== 0) return
    this.canvas.setPointerCapture(ev.pointerId)
    this.drag = { id: ev.pointerId, x: ev.clientX, y: ev.clientY, looking: false }
    this.canvas.focus({ preventScroll: true })
  }

  private onPointerMove = (ev: PointerEvent): void => {
    if (this.locomotionLocked) return
    const drag = this.drag
    if (!drag || ev.pointerId !== drag.id) return
    const dx = ev.clientX - drag.x
    const dy = ev.clientY - drag.y
    if (!drag.looking && dx * dx + dy * dy > PICK_DRAG_PX2) drag.looking = true
    if (!drag.looking) return
    const look = POINTER_LOOK_SPEED * clientSettings.getMouseSensitivityScale()
    this.camYaw -= dx * look
    this.camPitch = Math.min(CAM_PITCH_MAX, Math.max(CAM_PITCH_MIN, this.camPitch + dy * look))
    drag.x = ev.clientX
    drag.y = ev.clientY
  }

  private onWheel = (ev: WheelEvent): void => {
    if (!this.active || this.disposed || this.locomotionLocked) return
    ev.preventDefault()
    this.camDistance += ev.deltaY * ZOOM_WHEEL_SPEED
    this.camDistance = Math.max(CAM_DISTANCE_MIN, Math.min(CAM_DISTANCE_MAX, this.camDistance))
  }

  private onPointerUp = (ev: PointerEvent): void => {
    const drag = this.drag
    if (!drag || ev.pointerId !== drag.id) return
    const looking = drag.looking
    this.drag = null
    if (this.canvas.hasPointerCapture(ev.pointerId)) {
      this.canvas.releasePointerCapture(ev.pointerId)
    }
    if (this.locomotionLocked || looking) return
    this.pickPoolAt(ev.clientX, ev.clientY)
  }

  private pickPoolAt(clientX: number, clientY: number): void {
    const rect = this.canvas.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return
    this.pointerNdc.x = ((clientX - rect.left) / rect.width) * 2 - 1
    this.pointerNdc.y = -((clientY - rect.top) / rect.height) * 2 + 1
    this.raycaster.setFromCamera(this.pointerNdc, this.camera)
    const meshes = [...this.pools.values()].map((b) => b.mesh)
    const hit = this.raycaster.intersectObjects(meshes, false)[0]
    if (!hit) return
    const name = String(hit.object.userData.worldName ?? '')
    if (name) this.selectWorld(name)
  }

  private syncVeins(): void {
    if (!this.veins) return
    const rows: Array<{ x: number; z: number; radius: number; live: boolean }> = []
    for (const body of this.pools.values()) {
      rows.push({
        x: body.pose.x,
        z: body.pose.z,
        radius: body.pose.radius,
        live: body.entry.users > 0
      })
    }
    this.veins.setLayout(rows, this.treePoses)
  }

  focusVein(worldName: string | null): void {
    if (!this.veins) return
    if (!worldName?.trim()) {
      this.veins.setFocus(null, null)
      return
    }
    const body = this.pools.get(worldName.toLowerCase())
    if (!body) {
      this.veins.setFocus(null, null)
      return
    }
    this.veins.setFocus(body.pose.x, body.pose.z)
  }

  private updatePins(): void {
    for (const body of this.pools.values()) body.pin.hidden = true
  }

  private disposePoolMesh(mesh: THREE.Mesh): void {
    const mat = mesh.material
    if (mat instanceof THREE.MeshStandardMaterial) {
      mat.map?.dispose()
      mat.dispose()
    } else if (mat instanceof THREE.ShaderMaterial) {
      mat.dispose()
    }
  }

}

function isTypingTarget(): boolean {
  const el = document.activeElement
  if (!(el instanceof HTMLElement)) return false
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
    return true
  }
  return el.isContentEditable
}

function pinLabel(entry: WorldMapEntry): string {
  const name = worldDisplayName(entry)
  return entry.users > 0 ? `${name} · ${entry.users}` : name
}

function pinTitle(entry: WorldMapEntry): string {
  return `${entry.worldName}${entry.users ? ` · ${entry.users} online` : ''}`
}

function lerpAngle(from: number, to: number, t: number): number {
  let delta = to - from
  while (delta > Math.PI) delta -= Math.PI * 2
  while (delta < -Math.PI) delta += Math.PI * 2
  return from + delta * t
}

function camHeightsForDistance(dist: number): { pivotY: number; lookY: number } {
  if (dist <= CAM_HEIGHT_NEAR_DIST) {
    return { pivotY: CAM_PIVOT_HEIGHT_NEAR, lookY: CAM_LOOK_HEIGHT_NEAR }
  }
  if (dist >= CAM_HEIGHT_FAR_DIST) {
    return { pivotY: CAM_PIVOT_HEIGHT_FAR, lookY: CAM_LOOK_HEIGHT_FAR }
  }
  const t = (dist - CAM_HEIGHT_NEAR_DIST) / (CAM_HEIGHT_FAR_DIST - CAM_HEIGHT_NEAR_DIST)
  const s = t * t * (3 - 2 * t)
  return {
    pivotY: THREE.MathUtils.lerp(CAM_PIVOT_HEIGHT_NEAR, CAM_PIVOT_HEIGHT_FAR, s),
    lookY: THREE.MathUtils.lerp(CAM_LOOK_HEIGHT_NEAR, CAM_LOOK_HEIGHT_FAR, s)
  }
}

function makeSparkTexture(): THREE.Texture {
  const canvas = document.createElement('canvas')
  canvas.width = 64
  canvas.height = 64
  const ctx = canvas.getContext('2d')!
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32)
  g.addColorStop(0, 'rgba(255,255,255,1)')
  g.addColorStop(0.28, 'rgba(160,236,255,0.85)')
  g.addColorStop(1, 'rgba(80,180,210,0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, 64, 64)
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.needsUpdate = true
  return tex
}

/** Rising rim sparks + ground motes around the landing ring / pool shores. */
class PoolSparkles {
  private readonly points: THREE.Points
  private ages = new Float32Array(0)
  private lives = new Float32Array(0)
  private vx = new Float32Array(0)
  private vz = new Float32Array(0)
  /** 0 = rising, 1 = ground. */
  private kind = new Uint8Array(0)
  private readonly tex: THREE.Texture
  private poolList: PoolBody[] = []
  private count = 0

  constructor(scene: THREE.Scene) {
    this.tex = makeSparkTexture()
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(0), 3))
    const mat = new THREE.PointsMaterial({
      map: this.tex,
      color: 0xb8f4ff,
      size: 0.42,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    })
    this.points = new THREE.Points(geo, mat)
    this.points.frustumCulled = false
    scene.add(this.points)
  }

  setPools(pools: PoolBody[]): void {
    this.poolList = pools
    const count =
      pools.length * (SPARKS_PER_POOL + SPARKS_PER_POOL_GROUND) +
      SPARKS_ON_LANDING_RING +
      SPARKS_ON_LANDING_GROUND
    if (count === this.count) {
      this.seedAll()
      return
    }
    this.count = count
    this.ages = new Float32Array(count)
    this.lives = new Float32Array(count)
    this.vx = new Float32Array(count)
    this.vz = new Float32Array(count)
    this.kind = new Uint8Array(count)
    this.points.geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array(count * 3), 3)
    )
    this.seedAll()
  }

  update(dt: number, pools: Map<string, PoolBody>): void {
    this.poolList = [...pools.values()]
    if (!this.count) {
      this.points.visible = false
      return
    }
    this.points.visible = true
    const pos = this.points.geometry.getAttribute('position') as THREE.BufferAttribute
    const arr = pos.array as Float32Array
    for (let i = 0; i < this.count; i++) {
      this.ages[i]! += dt
      if (this.ages[i]! >= this.lives[i]!) {
        this.respawn(i)
        continue
      }
      arr[i * 3]! += this.vx[i]! * dt
      arr[i * 3 + 2]! += this.vz[i]! * dt
      if (this.kind[i] === 1) {
        arr[i * 3 + 1] = 0.04 + 0.035 * Math.sin(this.ages[i]! * 3.4 + i)
        this.keepOnGroundBand(arr, i)
      } else {
        arr[i * 3 + 1]! += (0.55 + this.lives[i]! * 0.35) * dt
        if (i < this.ranges().poolRise) this.keepOnDonut(arr, i)
        else this.keepOutsideDiscs(arr, i)
      }
    }
    pos.needsUpdate = true
  }

  dispose(): void {
    this.points.removeFromParent()
    this.points.geometry.dispose()
    const mat = this.points.material
    if (mat instanceof THREE.PointsMaterial) mat.dispose()
    this.tex.dispose()
  }

  private ranges() {
    const n = this.poolList.length
    const poolRise = n * SPARKS_PER_POOL
    const landingRise = poolRise + SPARKS_ON_LANDING_RING
    const landingGround = landingRise + SPARKS_ON_LANDING_GROUND
    return { poolRise, landingRise, landingGround }
  }

  private seedAll(): void {
    for (let i = 0; i < this.count; i++) this.respawn(i, true)
    const pos = this.points.geometry.getAttribute('position') as THREE.BufferAttribute
    if (pos) pos.needsUpdate = true
  }

  private respawn(i: number, scatter = false): void {
    const arr = this.points.geometry.getAttribute('position')?.array as Float32Array | undefined
    if (!arr) return
    const { poolRise, landingRise, landingGround } = this.ranges()
    if (i < poolRise && this.poolList.length) {
      this.respawnPoolRise(i, scatter, arr)
      return
    }
    if (i < landingRise) {
      this.respawnLandingRise(i, scatter, arr)
      return
    }
    if (i < landingGround) {
      this.respawnLandingGround(i, scatter, arr)
      return
    }
    this.respawnPoolGround(i, scatter, arr)
  }

  private respawnPoolRise(i: number, scatter: boolean, arr: Float32Array): void {
    const p = this.poolList[i % this.poolList.length]!
    const live = p.entry.users > 0
    const ang = Math.random() * Math.PI * 2
    const inner = p.pose.radius * FOREST_POOL_WATER_FRAC + 0.06
    const outer = p.pose.radius * 0.97
    const rim = inner + Math.random() * Math.max(0.05, outer - inner)
    this.kind[i] = 0
    const life = live ? 1.1 + Math.random() * 1.4 : 1.6 + Math.random() * 1.8
    this.lives[i] = life
    this.ages[i] = scatter ? Math.random() * life : 0
    const out = 0.08 + Math.random() * 0.16
    this.vx[i] = Math.cos(ang) * out
    this.vz[i] = Math.sin(ang) * out
    arr[i * 3] = p.mesh.position.x + Math.cos(ang) * rim
    arr[i * 3 + 1] = 0.08 + (this.ages[i]! / life) * (live ? 2.4 : 1.6)
    arr[i * 3 + 2] = p.mesh.position.z + Math.sin(ang) * rim
  }

  private respawnLandingRise(i: number, scatter: boolean, arr: Float32Array): void {
    const ang = Math.random() * Math.PI * 2
    const rad = FOREST_LANDING_RADIUS_M + 0.12 + Math.random() * 0.28
    this.kind[i] = 0
    const life = 1.2 + Math.random() * 1.6
    this.lives[i] = life
    this.ages[i] = scatter ? Math.random() * life : 0
    const out = 0.1 + Math.random() * 0.18
    this.vx[i] = Math.cos(ang) * out
    this.vz[i] = Math.sin(ang) * out
    arr[i * 3] = Math.cos(ang) * rad
    arr[i * 3 + 1] = 0.06 + (this.ages[i]! / life) * 1.8
    arr[i * 3 + 2] = Math.sin(ang) * rad
  }

  private respawnLandingGround(i: number, scatter: boolean, arr: Float32Array): void {
    const ang = Math.random() * Math.PI * 2
    const rad = FOREST_LANDING_RADIUS_M - 0.35 + Math.random() * 2.4
    this.kind[i] = 1
    const life = 2.4 + Math.random() * 3.2
    this.lives[i] = life
    this.ages[i] = scatter ? Math.random() * life : 0
    const spin = (Math.random() < 0.5 ? -1 : 1) * (0.35 + Math.random() * 0.55)
    this.vx[i] = -Math.sin(ang) * spin + Math.cos(ang) * (Math.random() - 0.5) * 0.12
    this.vz[i] = Math.cos(ang) * spin + Math.sin(ang) * (Math.random() - 0.5) * 0.12
    arr[i * 3] = Math.cos(ang) * rad
    arr[i * 3 + 1] = 0.045
    arr[i * 3 + 2] = Math.sin(ang) * rad
  }

  private respawnPoolGround(i: number, scatter: boolean, arr: Float32Array): void {
    if (!this.poolList.length) {
      this.respawnLandingGround(i, scatter, arr)
      return
    }
    const p = this.poolList[i % this.poolList.length]!
    const ang = Math.random() * Math.PI * 2
    const rim = p.pose.radius + 0.2 + Math.random() * 1.35
    this.kind[i] = 1
    const life = 2.2 + Math.random() * 2.8
    this.lives[i] = life
    this.ages[i] = scatter ? Math.random() * life : 0
    const spin = (Math.random() < 0.5 ? -1 : 1) * (0.2 + Math.random() * 0.35)
    this.vx[i] = -Math.sin(ang) * spin
    this.vz[i] = Math.cos(ang) * spin
    arr[i * 3] = p.mesh.position.x + Math.cos(ang) * rim
    arr[i * 3 + 1] = 0.045
    arr[i * 3 + 2] = p.mesh.position.z + Math.sin(ang) * rim
  }

  /** Pool rise sparks stay on the cyan donut, not in the pond. */
  private keepOnDonut(arr: Float32Array, i: number): void {
    const p = this.poolList[i % Math.max(1, this.poolList.length)]
    if (!p) return
    let x = arr[i * 3]!
    let z = arr[i * 3 + 2]!
    const dx = x - p.mesh.position.x
    const dz = z - p.mesh.position.z
    const d = Math.hypot(dx, dz)
    const inner = p.pose.radius * FOREST_POOL_WATER_FRAC + 0.04
    const outer = p.pose.radius * 0.98
    if (d < 1e-4) return
    let s = 1
    if (d < inner) s = inner / d
    else if (d > outer) s = outer / d
    arr[i * 3] = p.mesh.position.x + dx * s
    arr[i * 3 + 2] = p.mesh.position.z + dz * s
  }

  /** Rising sparks stay off water / pad interior. */
  private keepOutsideDiscs(arr: Float32Array, i: number): void {
    let x = arr[i * 3]!
    let z = arr[i * 3 + 2]!
    const pad = FOREST_LANDING_RADIUS_M + 0.08
    const pr = Math.hypot(x, z)
    if (pr < pad && pr > 1e-4) {
      const s = pad / pr
      x *= s
      z *= s
    }
    for (const p of this.poolList) {
      const dx = x - p.mesh.position.x
      const dz = z - p.mesh.position.z
      const min = p.pose.radius + 0.18
      const d = Math.hypot(dx, dz)
      if (d >= min || d < 1e-4) continue
      const s = min / d
      x = p.mesh.position.x + dx * s
      z = p.mesh.position.z + dz * s
    }
    arr[i * 3] = x
    arr[i * 3 + 2] = z
  }

  /** Ground motes hug a band around the landing rim (and stay off pool water). */
  private keepOnGroundBand(arr: Float32Array, i: number): void {
    let x = arr[i * 3]!
    let z = arr[i * 3 + 2]!
    const { landingRise, landingGround } = this.ranges()
    if (i < landingGround && i >= landingRise) {
      const r = Math.hypot(x, z)
      const minR = FOREST_LANDING_RADIUS_M - 0.5
      const maxR = FOREST_LANDING_RADIUS_M + 2.5
      if (r > 1e-4 && r < minR) {
        const s = minR / r
        x *= s
        z *= s
      } else if (r > maxR) {
        const s = maxR / r
        x *= s
        z *= s
      }
    }
    for (const p of this.poolList) {
      const dx = x - p.mesh.position.x
      const dz = z - p.mesh.position.z
      const min = p.pose.radius + 0.16
      const d = Math.hypot(dx, dz)
      if (d >= min || d < 1e-4) continue
      const s = min / d
      x = p.mesh.position.x + dx * s
      z = p.mesh.position.z + dz * s
    }
    arr[i * 3] = x
    arr[i * 3 + 2] = z
  }
}
