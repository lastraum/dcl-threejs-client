/**
 * 3D "space" map of Decentraland Worlds — textured spheres + name pins.
 */
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { worldDisplayName, type WorldMapEntry } from './worldsCatalog'

type WorldBody = {
  entry: WorldMapEntry
  mesh: THREE.Mesh
  pin: HTMLButtonElement
  radius: number
}

type CameraFly = {
  fromPos: THREE.Vector3
  toPos: THREE.Vector3
  fromTarget: THREE.Vector3
  toTarget: THREE.Vector3
  from: number
  duration: number
  worldKey: string
}

function hashString(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
}

/** Deterministic layout — wide spiral cloud with room between worlds. */
function positionForWorld(name: string, index: number, total: number): THREE.Vector3 {
  const h = hashString(name.toLowerCase())
  const t = total > 1 ? index / (total - 1) : 0
  // Outer radius ~36–110 so spheres sit far apart in space.
  const radius = 36 + t * 68 + ((h % 1000) / 1000) * 18
  const angle = index * 2.399963 + ((h % 360) * Math.PI) / 180
  const y = (((h >> 10) % 2000) / 2000 - 0.5) * 52
  return new THREE.Vector3(Math.cos(angle) * radius, y, Math.sin(angle) * radius)
}

function sphereRadius(users: number): number {
  return 1.35 + Math.log2(1 + Math.max(0, users)) * 0.65
}

export type WorldsSpaceViewOptions = {
  onSelectWorld?: (worldName: string) => void
}

/**
 * Mounts a WebGL canvas + DOM pin layer inside `host`.
 * Call {@link setActive} when switching map modes.
 */
export class WorldsSpaceView {
  readonly root: HTMLDivElement
  private readonly canvas: HTMLCanvasElement
  private readonly pinLayer: HTMLDivElement
  private readonly renderer: THREE.WebGLRenderer
  private readonly scene: THREE.Scene
  private readonly camera: THREE.PerspectiveCamera
  private readonly controls: OrbitControls
  private readonly textureLoader = new THREE.TextureLoader()
  private readonly bodies = new Map<string, WorldBody>()
  private readonly sharedGeo = new THREE.SphereGeometry(1, 48, 32)
  private readonly fallbackMat: THREE.MeshStandardMaterial
  private readonly starFields: THREE.Points[] = []
  private readonly clock = new THREE.Clock()
  private readonly raycaster = new THREE.Raycaster()
  private readonly pointerNdc = new THREE.Vector2()
  private readonly onSelectWorld?: (worldName: string) => void

  private active = false
  private disposed = false
  private rafId = 0
  private size = { w: 1, h: 1 }
  private fly: CameraFly | null = null
  private focusedKey: string | null = null
  private readonly overviewPos = new THREE.Vector3(0, 28, 110)
  private readonly overviewTarget = new THREE.Vector3(0, 0, 0)

  constructor(opts: WorldsSpaceViewOptions = {}) {
    this.onSelectWorld = opts.onSelectWorld

    this.root = document.createElement('div')
    this.root.className = 'dcl-map__worlds-space'
    this.root.hidden = true
    this.root.setAttribute('aria-label', 'Worlds space map')

    this.canvas = document.createElement('canvas')
    this.canvas.className = 'dcl-map__worlds-canvas'
    this.pinLayer = document.createElement('div')
    this.pinLayer.className = 'dcl-map__worlds-pins'
    this.pinLayer.setAttribute('aria-hidden', 'false')
    this.root.append(this.canvas, this.pinLayer)

    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance'
    })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    this.renderer.setClearColor(0x03010a, 1)
    this.renderer.outputColorSpace = THREE.SRGBColorSpace

    this.scene = new THREE.Scene()
    this.scene.fog = new THREE.FogExp2(0x060318, 0.0045)

    this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 900)
    this.camera.position.copy(this.overviewPos)

    this.controls = new OrbitControls(this.camera, this.canvas)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.06
    this.controls.minDistance = 4
    this.controls.maxDistance = 280
    this.controls.target.copy(this.overviewTarget)
    this.controls.autoRotate = true
    this.controls.autoRotateSpeed = 0.28

    const amb = new THREE.AmbientLight(0xb8c0ff, 0.55)
    const key = new THREE.DirectionalLight(0xffffff, 1.15)
    key.position.set(40, 50, 20)
    const fill = new THREE.DirectionalLight(0x8866ff, 0.4)
    fill.position.set(-30, -16, -24)
    this.scene.add(amb, key, fill)

    this.fallbackMat = new THREE.MeshStandardMaterial({
      color: 0x5a4a88,
      roughness: 0.55,
      metalness: 0.15,
      emissive: 0x1a1030,
      emissiveIntensity: 0.25
    })

    // Dense multi-layer starfield.
    this.starFields.push(
      this.buildStars(5200, 90, 220, 0.55, 0.9, 0xd0d8ff),
      this.buildStars(2800, 160, 380, 0.9, 0.55, 0x9aa8ff),
      this.buildStars(1200, 40, 120, 0.28, 0.75, 0xffffff)
    )
    for (const field of this.starFields) this.scene.add(field)

    this.textureLoader.setCrossOrigin('anonymous')

    this.canvas.addEventListener('pointerdown', this.onCanvasPointerDown)
  }

  setActive(active: boolean): void {
    if (this.disposed) return
    this.active = active
    this.root.hidden = !active
    this.controls.enabled = active
    if (active) {
      this.controls.autoRotate = !this.focusedKey
      this.clock.start()
      this.startLoop()
      this.resize(this.size.w, this.size.h)
    } else {
      this.fly = null
      this.focusedKey = null
      this.controls.autoRotate = false
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
  }

  setWorlds(entries: WorldMapEntry[]): void {
    if (this.disposed) return
    const nextKeys = new Set(entries.map((e) => e.worldName.toLowerCase()))

    for (const [key, body] of this.bodies) {
      if (nextKeys.has(key)) continue
      this.scene.remove(body.mesh)
      this.disposeMesh(body.mesh)
      body.pin.remove()
      this.bodies.delete(key)
      if (this.focusedKey === key) {
        this.focusedKey = null
        this.controls.autoRotate = this.active
      }
    }

    const total = entries.length
    entries.forEach((entry, index) => {
      const key = entry.worldName.toLowerCase()
      let body = this.bodies.get(key)
      if (!body) {
        body = this.createBody(entry, index, total)
        this.bodies.set(key, body)
        this.scene.add(body.mesh)
        this.pinLayer.appendChild(body.pin)
      } else {
        body.entry = entry
        body.radius = sphereRadius(entry.users)
        body.mesh.scale.setScalar(body.radius)
        // Don't yank a focused world out from under the camera mid-flight.
        if (this.focusedKey !== key && !this.fly) {
          body.mesh.position.copy(positionForWorld(entry.worldName, index, total))
        }
        body.pin.textContent = worldDisplayName(entry)
        body.pin.title = `${entry.worldName}${entry.users ? ` · ${entry.users} online` : ''}`
        body.pin.classList.toggle('is-focused', this.focusedKey === key)
        if (entry.imageUrl) this.applyTexture(body, entry.imageUrl)
      }
    })
  }

  /** Smooth zoom so the world fills the frame and stays centered. */
  focusWorld(worldName: string): void {
    const body = this.bodies.get(worldName.toLowerCase())
    if (!body || this.disposed) return

    const key = worldName.toLowerCase()
    this.focusedKey = key
    this.controls.autoRotate = false

    for (const [k, b] of this.bodies) {
      b.pin.classList.toggle('is-focused', k === key)
    }

    const center = body.mesh.position.clone()
    const radius = body.radius
    // Pull in close so the sphere is large in view (still full disk + pin).
    const dist = Math.max(radius * 3.2, 5.5)

    // Approach along current view direction when possible (smoother cinematic).
    const dir = new THREE.Vector3().subVectors(this.camera.position, this.controls.target)
    if (dir.lengthSq() < 1e-6) dir.set(0.35, 0.25, 1)
    dir.normalize()
    // Slight top bias so the pin stays readable above the globe.
    dir.y = Math.max(0.18, Math.abs(dir.y) * 0.45 + 0.22)
    dir.normalize()

    const toPos = center.clone().addScaledVector(dir, dist)
    const toTarget = center.clone()

    this.fly = {
      fromPos: this.camera.position.clone(),
      toPos,
      fromTarget: this.controls.target.clone(),
      toTarget,
      from: performance.now(),
      duration: 1400,
      worldKey: key
    }

    // During flight OrbitControls would fight the tween.
    this.controls.enabled = false
    this.onSelectWorld?.(body.entry.worldName)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.active = false
    this.fly = null
    this.stopLoop()
    this.canvas.removeEventListener('pointerdown', this.onCanvasPointerDown)
    this.controls.dispose()
    for (const body of this.bodies.values()) {
      this.disposeMesh(body.mesh)
      body.pin.remove()
    }
    this.bodies.clear()
    this.sharedGeo.dispose()
    this.fallbackMat.dispose()
    for (const field of this.starFields) {
      field.geometry.dispose()
      const sm = field.material
      if (Array.isArray(sm)) sm.forEach((m) => m.dispose())
      else sm.dispose()
    }
    this.starFields.length = 0
    this.renderer.dispose()
    this.root.remove()
  }

  private createBody(entry: WorldMapEntry, index: number, total: number): WorldBody {
    const radius = sphereRadius(entry.users)
    const mat = this.fallbackMat.clone()
    const mesh = new THREE.Mesh(this.sharedGeo, mat)
    mesh.scale.setScalar(radius)
    mesh.position.copy(positionForWorld(entry.worldName, index, total))
    mesh.userData.worldName = entry.worldName
    mesh.userData.worldKey = entry.worldName.toLowerCase()

    const pin = document.createElement('button')
    pin.type = 'button'
    pin.className = 'dcl-map__worlds-pin'
    pin.textContent = worldDisplayName(entry)
    pin.title = `${entry.worldName}${entry.users ? ` · ${entry.users} online` : ''}`
    pin.addEventListener('click', (ev) => {
      ev.stopPropagation()
      this.focusWorld(entry.worldName)
    })

    const body: WorldBody = { entry, mesh, pin, radius }
    if (entry.imageUrl) this.applyTexture(body, entry.imageUrl)
    return body
  }

  private applyTexture(body: WorldBody, url: string): void {
    const mat = body.mesh.material as THREE.MeshStandardMaterial
    if (mat.userData.texUrl === url) return
    mat.userData.texUrl = url
    this.textureLoader.load(
      url,
      (tex) => {
        if (this.disposed) {
          tex.dispose()
          return
        }
        tex.colorSpace = THREE.SRGBColorSpace
        tex.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy())
        const prev = mat.map
        mat.map = tex
        mat.color.set(0xffffff)
        mat.needsUpdate = true
        prev?.dispose()
      },
      undefined,
      () => {
        /* keep fallback color */
      }
    )
  }

  private disposeMesh(mesh: THREE.Mesh): void {
    const mat = mesh.material
    if (Array.isArray(mat)) {
      for (const m of mat) {
        if (m instanceof THREE.MeshStandardMaterial) m.map?.dispose()
        m.dispose()
      }
    } else if (mat instanceof THREE.MeshStandardMaterial) {
      mat.map?.dispose()
      mat.dispose()
    }
  }

  private buildStars(
    count: number,
    rMin: number,
    rMax: number,
    size: number,
    opacity: number,
    color: number
  ): THREE.Points {
    const positions = new Float32Array(count * 3)
    for (let i = 0; i < count; i++) {
      const r = rMin + Math.random() * (rMax - rMin)
      const theta = Math.random() * Math.PI * 2
      const phi = Math.acos(2 * Math.random() - 1)
      positions[i * 3] = r * Math.sin(phi) * Math.cos(theta)
      positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta)
      positions[i * 3 + 2] = r * Math.cos(phi)
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    const mat = new THREE.PointsMaterial({
      color,
      size,
      sizeAttenuation: true,
      transparent: true,
      opacity,
      depthWrite: false
    })
    return new THREE.Points(geo, mat)
  }

  private onCanvasPointerDown = (ev: PointerEvent): void => {
    if (!this.active || this.disposed || ev.button !== 0) return
    // Don't steal orbit drag — only pick when click is nearly stationary.
    const startX = ev.clientX
    const startY = ev.clientY
    const onUp = (up: PointerEvent) => {
      window.removeEventListener('pointerup', onUp)
      const dx = up.clientX - startX
      const dy = up.clientY - startY
      if (dx * dx + dy * dy > 36) return
      this.pickWorldAt(up.clientX, up.clientY)
    }
    window.addEventListener('pointerup', onUp)
  }

  private pickWorldAt(clientX: number, clientY: number): void {
    const rect = this.canvas.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return
    this.pointerNdc.x = ((clientX - rect.left) / rect.width) * 2 - 1
    this.pointerNdc.y = -((clientY - rect.top) / rect.height) * 2 + 1
    this.raycaster.setFromCamera(this.pointerNdc, this.camera)
    const meshes = [...this.bodies.values()].map((b) => b.mesh)
    const hits = this.raycaster.intersectObjects(meshes, false)
    const hit = hits[0]
    if (!hit) return
    const name = String(hit.object.userData.worldName ?? '')
    if (name) this.focusWorld(name)
  }

  private updateFly(now: number): void {
    const fly = this.fly
    if (!fly) return
    const t = Math.min(1, (now - fly.from) / fly.duration)
    const e = easeInOutCubic(t)
    this.camera.position.lerpVectors(fly.fromPos, fly.toPos, e)
    this.controls.target.lerpVectors(fly.fromTarget, fly.toTarget, e)
    this.camera.lookAt(this.controls.target)
    if (t >= 1) {
      this.fly = null
      this.controls.enabled = this.active
      this.controls.minDistance = 3.2
      this.controls.update()
    }
  }

  private startLoop(): void {
    this.stopLoop()
    const tick = () => {
      if (!this.active || this.disposed) return
      this.rafId = requestAnimationFrame(tick)
      const now = performance.now()
      const t = this.clock.getElapsedTime()
      for (const body of this.bodies.values()) {
        body.mesh.rotation.y = t * 0.12 + body.mesh.position.x * 0.015
      }
      if (this.fly) this.updateFly(now)
      else this.controls.update()
      this.renderer.render(this.scene, this.camera)
      this.updatePins()
    }
    this.rafId = requestAnimationFrame(tick)
  }

  private stopLoop(): void {
    if (this.rafId) cancelAnimationFrame(this.rafId)
    this.rafId = 0
  }

  private updatePins(): void {
    const w = this.size.w
    const h = this.size.h
    const halfW = w / 2
    const halfH = h / 2
    const cam = this.camera
    const tmp = new THREE.Vector3()

    for (const body of this.bodies.values()) {
      tmp.copy(body.mesh.position)
      tmp.y += body.radius + 0.65
      tmp.project(cam)
      const behind = tmp.z > 1
      const x = tmp.x * halfW + halfW
      const y = -tmp.y * halfH + halfH
      if (behind || x < -80 || x > w + 80 || y < -80 || y > h + 80) {
        body.pin.hidden = true
        continue
      }
      body.pin.hidden = false
      body.pin.style.transform = `translate(-50%, -100%) translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`
    }
  }
}
