import * as THREE from 'three'
import { clientDebugLog } from '../client/debug/ClientDebugLog'

let currentHost: SceneAbilityVfxHost | null = null

export function getSceneAbilityVfxHost(): SceneAbilityVfxHost | null {
  return currentHost
}

export function setSceneAbilityVfxHost(host: SceneAbilityVfxHost | null): void {
  currentHost = host
}

/** Lab LightPool keeps 6 PointLights visible at intensity 0. Hide them until a cast. */
function hideUnusedVfxLights(pool: { lights?: Array<{ light: THREE.Light; inUse?: boolean }> }): void {
  for (const entry of pool.lights ?? []) {
    const on = entry.inUse === true && entry.light.intensity > 0.001
    entry.light.visible = on
  }
}

/** In-flight ability instances — spam-click localpreview stays smooth. */
const MAX_CONCURRENT_ABILITIES = 6
/** Queued while AbilityManager primes — drop oldest on overflow. */
const MAX_PENDING_CASTS = 2

type AbilityManagerLike = {
  warm: (id: string) => Promise<boolean>
  prewarm?: (id: string, n: number) => void
  select: (id: string) => void
  cast: (
    origin: THREE.Vector3,
    direction: THREE.Vector3,
    distance: number,
    id?: string
  ) => { element?: string } | null
  update: (dt: number) => void
  dispose?: () => void
  active?: Array<{ element?: string }>
}

/**
 * Genesis-lab `LabVfxHost` spine inside the play client.
 * AbilityManager boots only when mirrored `tjs` shader rows exist on projection.
 */
export class SceneAbilityVfxHost {
  private abilities: AbilityManagerLike | null = null
  private particles: { flush: () => void; dispose: () => void } | null = null
  private lights: {
    update: (dt: number) => void
    dispose: () => void
    lights?: Array<{ light: THREE.Light; inUse?: boolean }>
  } | null = null
  private decals: { update: (dt: number) => void; dispose: () => void } | null = null
  private fissures: { update: (dt: number) => void; dispose: () => void } | null = null
  private bursts: { update: (dt: number) => void; dispose: () => void } | null = null
  private shake: { update: (dt: number) => void } | null = null
  private flash: { update: (dt: number) => void } | null = null
  private frame: { uTime: { value: number }; uDelta: { value: number } } | null = null
  private elapsed = 0
  private readonly primed = new Set<string>()
  private priming: Promise<void> | null = null
  private failed = false
  private readonly pendingCasts: Array<{
    id: string
    origin: THREE.Vector3
    direction: THREE.Vector3
    distance: number
    publish: boolean
  }> = []
  private onLocalCast: ((id: string, origin: THREE.Vector3, dir: THREE.Vector3, range: number) => void) | null =
    null

  constructor(
    private readonly scene: THREE.Scene,
    private readonly camera: THREE.PerspectiveCamera,
    private readonly renderer: THREE.WebGLRenderer
  ) {
    this.camera.layers.enable(1)
  }

  get ready(): boolean {
    return this.abilities != null && !this.failed
  }

  isCasting(id: string): boolean {
    return (this.abilities?.active ?? []).some((a) => a.element === id)
  }

  isBusy(id: string): boolean {
    return (
      this.isCasting(id) ||
      this.priming != null ||
      this.pendingCasts.some((p) => p.id === id)
    )
  }

  async prime(ids: readonly string[]): Promise<boolean> {
    const wanted = [...new Set(ids.map((id) => id.trim().toLowerCase()).filter(Boolean))]
    if (wanted.length === 0 || this.failed) return this.ready
    if (this.priming) {
      await this.priming
      if (wanted.every((id) => this.primed.has(id))) return this.ready
    }
    this.priming = this.primeInner(wanted)
    try {
      await this.priming
    } finally {
      this.priming = null
    }
    return this.ready
  }

  setOnLocalCast(
    fn: ((id: string, origin: THREE.Vector3, dir: THREE.Vector3, range: number) => void) | null
  ): void {
    this.onLocalCast = fn
  }

  cast(
    id: string,
    origin: THREE.Vector3,
    direction: THREE.Vector3,
    distance: number,
    opts?: { publish?: boolean }
  ): boolean {
    const dir = direction.clone()
    dir.y = 0
    if (dir.lengthSq() < 1e-6) dir.set(0, 0, 1)
    dir.normalize()
    const reach = Math.max(8, distance)
    // Local-only unless the scene opted in (`tjs.sync` / `{ publish: true }`).
    const publish = opts?.publish === true
    if (!this.abilities || !this.primed.has(id)) {
      this.pendingCasts.push({
        id,
        origin: origin.clone(),
        direction: dir,
        distance: reach,
        publish
      })
      while (this.pendingCasts.length > MAX_PENDING_CASTS) this.pendingCasts.shift()
      void this.prime([id]).then(() => this.flushPending())
      return false
    }
    return this.fireNow(id, origin, dir, reach, publish)
  }

  update(dt: number): void {
    if (!this.abilities) return
    const step = Math.min(0.05, Math.max(0, dt))
    this.elapsed += step
    if (this.frame) {
      this.frame.uTime.value = this.elapsed
      this.frame.uDelta.value = step
    }
    this.abilities.update(step)
    this.particles?.flush()
    this.decals?.update(step)
    this.fissures?.update(step)
    this.bursts?.update(step)
    this.lights?.update(step)
    if (this.lights) hideUnusedVfxLights(this.lights)
    this.shake?.update(step)
    this.flash?.update(step)
  }

  dispose(): void {
    this.abilities?.dispose?.()
    this.particles?.dispose()
    this.decals?.dispose()
    this.fissures?.dispose()
    this.bursts?.dispose()
    this.lights?.dispose()
    this.abilities = null
    this.failed = false
    this.primed.clear()
  }

  private async primeInner(ids: readonly string[]): Promise<void> {
    if (!this.abilities) {
      const ok = await this.bootManager()
      if (!ok) return
    }
    for (const id of ids) {
      if (this.primed.has(id)) continue
      const ready = await this.abilities!.warm(id)
      if (ready) this.primed.add(id)
    }
    this.compileWarmedGroups()
    clientDebugLog.log(
      'scene',
      `ability-vfx primed [${[...this.primed].join(', ') || 'none'}]`,
      { alsoConsole: true }
    )
    this.flushPending()
  }

  /**
   * Point lights in the compile light list (intensity 0). First cast used to
   * flip `visible` and recompile every world material.
   */
  armLightsForCompile(): void {
    for (const entry of this.lights?.lights ?? []) {
      entry.light.intensity = 0
      entry.light.visible = true
    }
  }

  hideIdleLights(): void {
    if (this.lights) hideUnusedVfxLights(this.lights)
  }

  /**
   * Compile only warmed ability groups — never the landscape grass graph.
   * `targetScene` keeps play lights / fog / IBL on the program key.
   */
  compileWarmedGroups(): void {
    for (const root of this.collectAbilityRoots()) {
      try {
        this.renderer.compile(root, this.camera, this.scene)
      } catch {
        /* first present still compiles if this program is skipped */
      }
    }
  }

  private collectAbilityRoots(): THREE.Object3D[] {
    const roots: THREE.Object3D[] = []
    for (const child of this.scene.children) {
      if (typeof child.name === 'string' && child.name.startsWith('Ability:')) roots.push(child)
    }
    return roots
  }

  private flushPending(): void {
    if (!this.abilities) return
    const queued = this.pendingCasts.splice(0)
    for (const q of queued) this.fireNow(q.id, q.origin, q.direction, q.distance, q.publish)
  }

  private fireNow(
    id: string,
    origin: THREE.Vector3,
    dir: THREE.Vector3,
    reach: number,
    publish: boolean
  ): boolean {
    if (!this.abilities) return false
    this.abilities.select(id)
    this.applyIceRange(reach, id)
    const hit = this.abilities.cast(origin, dir, reach, id)
    if (!hit) {
      void this.abilities.warm(id)
      return false
    }
    if (publish) this.onLocalCast?.(id, origin, dir, reach)
    clientDebugLog.log(
      'scene',
      `ability-vfx ${id} start=(${origin.x.toFixed(1)},${origin.y.toFixed(1)},${origin.z.toFixed(1)}) ` +
        `dir=(${dir.x.toFixed(2)},${dir.z.toFixed(2)}) range=${reach}`
    )
    return true
  }

  private async bootManager(): Promise<boolean> {
    try {
      const [
        { AbilityManager },
        { ParticleEngine },
        { LightPool },
        { DecalSystem },
        { FissureSystem },
        { BurstSystem },
        { CameraShake },
        { ScreenFlash },
        { frame },
        { patchOnBeforeCompile }
      ] = await Promise.all([
        import('@vfx/abilities/AbilityManager.js'),
        import('@vfx/particles/ParticleEngine.js'),
        import('@vfx/effects/LightPool.js'),
        import('@vfx/effects/GroundDecals.js'),
        import('@vfx/effects/GroundFissures.js'),
        import('@vfx/effects/BurstSphere.js'),
        import('@vfx/effects/CameraShake.js'),
        import('@vfx/effects/ScreenFlash.js'),
        import('@vfx/core/FrameUniforms.js'),
        import('@vfx/utils/shaderPatch.js')
      ])

      this.frame = frame
      this.particles = new ParticleEngine(this.scene)
      const lights = new LightPool(this.scene) as {
        update: (dt: number) => void
        dispose: () => void
        lights?: Array<{ light: THREE.Light; inUse?: boolean }>
      }
      // Intensity 0 is not enough — visible PointLights still enter Three's
      // lighting list and recompile / shade every world material (grass, GLBs).
      hideUnusedVfxLights(lights)
      this.lights = lights
      this.decals = new DecalSystem(this.scene)
      this.fissures = new FissureSystem(this.scene)
      this.bursts = new BurstSystem(this.scene)
      this.shake = new CameraShake({
        shakeOffset: new THREE.Vector3(),
        shakeRoll: 0
      })
      this.flash = new ScreenFlash()

      const environment = {
        scene: this.scene,
        registerShadowCasterWithPatch(material: THREE.Material, patch: (shader: unknown) => void) {
          patchOnBeforeCompile(material, patch)
          return material
        },
        setFocus(_x: number, _z: number) {},
        envMap: null,
        sun: null
      }

      this.abilities = new AbilityManager({
        scene: this.scene,
        camera: this.camera,
        environment,
        particles: this.particles,
        lights: this.lights,
        decals: this.decals,
        fissures: this.fissures,
        bursts: this.bursts,
        shake: this.shake,
        flash: this.flash,
        maxConcurrent: MAX_CONCURRENT_ABILITIES
      }) as AbilityManagerLike
      return true
    } catch (err) {
      this.failed = true
      clientDebugLog.log(
        'scene',
        `ability-vfx boot failed — ${err instanceof Error ? err.message : String(err)}`,
        { level: 'warn', alsoConsole: true }
      )
      return false
    }
  }

  /** Ability settings blocks expose `range` — keep in sync with the tag. */
  private applyIceRange(metres: number, id = 'ice'): void {
    void import('@vfx/config/settings.js')
      .then((mod) => {
        const block = (mod.settings as Record<string, { range?: number } | undefined>)?.[id]
        if (block && typeof block.range === 'number') block.range = metres
      })
      .catch(() => {
        /* settings module optional until primed */
      })
  }

}
