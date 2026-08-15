import * as THREE from 'three'
import { clientDebugLog } from '../../client/debug/ClientDebugLog'
import type { VfxSpec } from './parseTags'

const VFX_LAYER = 1
const STARTER_HINT = 'ice, meteor, snare (LINE / LINE / ZONE)'

type AbilityInstance = {
  element: string
  group: THREE.Object3D
  spawn: (origin: THREE.Vector3, direction: THREE.Vector3, distance: number) => void
  update: (dt: number) => void
  destroy: () => void
  dispose: () => void
  isFinished: boolean
  isActive: boolean
}

type AbilityCtor = new (ctx: unknown) => AbilityInstance

type RegistryDescriptor = {
  id: string
  cast: 'line' | 'zone'
  load: () => Promise<AbilityCtor>
  settings: Record<string, unknown>
}

type PackModules = {
  getAbility: (id: string) => RegistryDescriptor | undefined
  ParticleEngine: new (scene: THREE.Scene) => {
    flush: () => void
    reset: () => void
    dispose: () => void
    get: (name: string, options: unknown) => unknown
  }
  LightPool: new (scene: THREE.Scene) => {
    acquire: () => unknown
    release: (light: unknown) => void
    set: (...args: unknown[]) => void
    update: (dt: number) => void
    reset: () => void
    dispose: () => void
  }
  DecalSystem: new (scene: THREE.Scene) => {
    spawn: (...args: unknown[]) => void
    update: (dt: number) => void
    clear: () => void
    dispose: () => void
  }
  FissureSystem: new (scene: THREE.Scene) => {
    spawn: (...args: unknown[]) => void
    update: (dt: number) => void
    clear: () => void
    dispose: () => void
  }
  BurstSystem: new (scene: THREE.Scene) => {
    spawn: (...args: unknown[]) => void
    update: (dt: number) => void
    clear: () => void
    dispose: () => void
  }
  CameraShake: new (rig: { shakeOffset: THREE.Vector3; shakeRoll: number }) => {
    add: (amount: number, decay?: number, frequency?: number) => void
    rumble: (amount: number, dt: number) => void
    update: (dt: number) => void
    reset: () => void
  }
  ScreenFlash: new () => {
    trigger: (color: THREE.Color, strength: number, decay?: number) => void
    update: (dt: number) => void
    reset: () => void
  }
  frame: { uTime: { value: number }; uDelta: { value: number }; uResolution: { value: THREE.Vector2 } }
  settings: Record<string, Record<string, unknown>>
  patchOnBeforeCompile: (material: THREE.Material, patch: (shader: unknown) => void) => void
}

let packPromise: Promise<PackModules> | null = null
const unknownIds = new Set<string>()

async function loadPack(): Promise<PackModules> {
  if (!packPromise) {
    packPromise = (async () => {
      const [
        registry,
        particles,
        lights,
        decals,
        fissures,
        bursts,
        shake,
        flash,
        frameMod,
        settingsMod,
        shaderPatch
      ] = await Promise.all([
        import('@vfx/abilities/registry.js'),
        import('@vfx/particles/ParticleEngine.js'),
        import('@vfx/effects/LightPool.js'),
        import('@vfx/effects/GroundDecals.js'),
        import('@vfx/effects/GroundFissures.js'),
        import('@vfx/effects/BurstSphere.js'),
        import('@vfx/effects/CameraShake.js'),
        import('@vfx/effects/ScreenFlash.js'),
        import('@vfx/core/FrameUniforms.js'),
        import('@vfx/config/settings.js'),
        import('@vfx/utils/shaderPatch.js')
      ])
      return {
        getAbility: registry.getAbility as PackModules['getAbility'],
        ParticleEngine: particles.ParticleEngine,
        LightPool: lights.LightPool,
        DecalSystem: decals.DecalSystem,
        FissureSystem: fissures.FissureSystem,
        BurstSystem: bursts.BurstSystem,
        CameraShake: shake.CameraShake,
        ScreenFlash: flash.ScreenFlash,
        frame: frameMod.frame,
        settings: settingsMod.settings as PackModules['settings'],
        patchOnBeforeCompile: shaderPatch.patchOnBeforeCompile
      }
    })()
  }
  return packPromise
}

type Pooled = {
  ability: AbilityInstance
  pool: AbilityInstance[]
}

export class VfxRuntime {
  readonly root = new THREE.Group()
  private readonly pack: PackModules
  private readonly particles: InstanceType<PackModules['ParticleEngine']>
  private readonly lights: InstanceType<PackModules['LightPool']>
  private readonly decals: InstanceType<PackModules['DecalSystem']>
  private readonly fissures: InstanceType<PackModules['FissureSystem']>
  private readonly bursts: InstanceType<PackModules['BurstSystem']>
  private readonly shake: InstanceType<PackModules['CameraShake']>
  private readonly flash: InstanceType<PackModules['ScreenFlash']>
  private readonly ctx: unknown
  private readonly classes = new Map<string, AbilityCtor>()
  private readonly loading = new Map<string, Promise<boolean>>()
  private readonly pools = new Map<string, AbilityInstance[]>()
  private readonly active: Pooled[] = []
  private readonly settingsSnapshot = new Map<string, Record<string, unknown>>()
  private elapsed = 0
  private readonly resolve = new THREE.Vector2()

  constructor(pack: PackModules, scene: THREE.Scene, camera: THREE.Camera) {
    this.pack = pack
    this.root.name = 'tjs-vfx-root'
    scene.add(this.root)
    camera.layers.enable(VFX_LAYER)

    this.particles = new pack.ParticleEngine(this.root as unknown as THREE.Scene)
    this.lights = new pack.LightPool(this.root as unknown as THREE.Scene)
    this.decals = new pack.DecalSystem(this.root as unknown as THREE.Scene)
    this.fissures = new pack.FissureSystem(this.root as unknown as THREE.Scene)
    this.bursts = new pack.BurstSystem(this.root as unknown as THREE.Scene)
    this.shake = new pack.CameraShake({ shakeOffset: new THREE.Vector3(), shakeRoll: 0 })
    this.flash = new pack.ScreenFlash()

    const environment = {
      registerShadowCasterWithPatch: (material: THREE.Material, patch: (shader: unknown) => void) => {
        pack.patchOnBeforeCompile(material, patch)
        return material
      },
      scene: this.root,
      camera
    }

    this.ctx = {
      scene: this.root,
      camera,
      environment,
      particles: this.particles,
      lights: this.lights,
      decals: this.decals,
      fissures: this.fissures,
      bursts: this.bursts,
      shake: this.shake,
      flash: this.flash
    }
  }

  get liveCount(): number {
    return this.active.length
  }

  isReady(id: string): boolean {
    return this.classes.has(id)
  }

  lookup(id: string): RegistryDescriptor | undefined {
    return this.pack.getAbility(id)
  }

  warm(id: string): Promise<boolean> {
    const existing = this.loading.get(id)
    if (existing) return existing
    if (this.classes.has(id)) return Promise.resolve(true)

    const descriptor = this.pack.getAbility(id)
    if (!descriptor) {
      if (!unknownIds.has(id)) {
        unknownIds.add(id)
        clientDebugLog.log(
          'scene',
          `vfx unknown id "${id}" — skip. Starter set: ${STARTER_HINT}`,
          { level: 'warn', alsoConsole: true }
        )
      }
      return Promise.resolve(false)
    }

    const pending = descriptor
      .load()
      .then((Type) => {
        this.classes.set(id, Type)
        const block = this.pack.settings[id]
        if (block && !this.settingsSnapshot.has(id)) {
          this.settingsSnapshot.set(id, { ...block })
        }
        return true
      })
      .catch((err: unknown) => {
        clientDebugLog.log(
          'scene',
          `vfx failed to load "${id}": ${err instanceof Error ? err.message : String(err)}`,
          { level: 'warn', alsoConsole: true }
        )
        return false
      })
      .finally(() => {
        this.loading.delete(id)
      })
    this.loading.set(id, pending)
    return pending
  }

  cast(
    spec: VfxSpec,
    origin: THREE.Vector3,
    direction: THREE.Vector3,
    distance: number,
    budget: number
  ): AbilityInstance | null {
    const Type = this.classes.get(spec.id)
    if (!Type) {
      void this.warm(spec.id)
      return null
    }
    if (this.active.length >= budget) {
      clientDebugLog.log('scene', `vfx budget refuse — live=${this.active.length} cap=${budget}`, {
        level: 'warn',
        alsoConsole: true,
        throttleMs: 2000,
        throttleKey: 'vfx-budget'
      })
      return null
    }

    this.applySpec(spec)
    const pool = this.pools.get(spec.id) ?? []
    this.pools.set(spec.id, pool)
    const ability = pool.pop() ?? this.construct(Type)
    ability.spawn(origin, direction, Math.max(0.1, distance))
    this.active.push({ ability, pool })
    return ability
  }

  update(dt: number, viewport: { width: number; height: number }): void {
    this.elapsed += dt
    this.pack.frame.uTime.value = this.elapsed
    this.pack.frame.uDelta.value = dt
    this.resolve.set(viewport.width, viewport.height)
    this.pack.frame.uResolution.value.copy(this.resolve)

    for (let i = this.active.length - 1; i >= 0; i--) {
      const slot = this.active[i]!
      slot.ability.update(dt)
      if (slot.ability.isFinished) {
        slot.ability.destroy()
        slot.pool.push(slot.ability)
        this.active.splice(i, 1)
      }
    }
    this.particles.flush()
    this.decals.update(dt)
    this.fissures.update(dt)
    this.bursts.update(dt)
    this.lights.update(dt)
    this.shake.update(dt)
    this.flash.update(dt)
  }

  dispose(): void {
    for (const slot of this.active) {
      slot.ability.destroy()
      slot.ability.dispose()
    }
    this.active.length = 0
    for (const pool of this.pools.values()) {
      for (const ability of pool) ability.dispose()
    }
    this.pools.clear()
    this.classes.clear()
    this.particles.dispose()
    this.decals.dispose()
    this.fissures.dispose()
    this.bursts.dispose()
    this.lights.dispose()
    this.root.removeFromParent()
  }

  private construct(Type: AbilityCtor): AbilityInstance {
    const ability = new Type(this.ctx)
    this.root.add(ability.group)
    ability.group.visible = false
    return ability
  }

  private applySpec(spec: VfxSpec): void {
    const block = this.pack.settings[spec.id]
    const snap = this.settingsSnapshot.get(spec.id)
    if (!block || !snap) return
    if (typeof snap.range === 'number' && spec.range !== undefined) block.range = spec.range
    if (typeof snap.speed === 'number' && spec.speed !== undefined) block.speed = spec.speed
    if (typeof snap.zoneRadius === 'number') {
      block.zoneRadius = spec.range ?? snap.zoneRadius
    }
    if (typeof snap.lightIntensity === 'number' && spec.intensity !== undefined) {
      block.lightIntensity = snap.lightIntensity * spec.intensity
    }
  }
}

export async function createVfxRuntime(scene: THREE.Scene, camera: THREE.Camera): Promise<VfxRuntime> {
  const pack = await loadPack()
  return new VfxRuntime(pack, scene, camera)
}
