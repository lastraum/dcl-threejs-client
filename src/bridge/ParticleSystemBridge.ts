import * as THREE from 'three'
import type { Entity } from '@dcl/ecs'
import type { ResolvedScene } from '../dcl/content/types'
import type { AssetCache } from '../rendering/AssetCache'
import { resolveSceneTextureUrl } from './material/resolveTexture'
import type { MirrorComponents } from './mirrorComponents'
import type { ProjectionView } from './ProjectionView'
import { PSS_WORLD, PS_PAUSED, PS_STOPPED, SCENE_PARTICLE_BUDGET } from './particles/constants'
import {
  applyParticleTexture,
  createParticleGpuMesh,
  disposeParticleGpuMesh,
  updateParticleGpuUniforms,
  uploadParticlesToGpu,
  type ParticleGpuMesh
} from './particles/gpuRenderer'
import {
  createBurstRuntimes,
  cycleDuration,
  emitContinuous,
  prewarmParticles,
  processBursts,
  resetBurstRuntimes,
  simulateParticles,
  specSignature,
  type SpawnContext
} from './particles/simulation'
import type { BurstRuntime, LiveParticle, ParticleSpec } from './particles/types'

function particleKey(entity: Entity): string {
  return `__particles_${entity}`
}

type ParticleRuntime = {
  specSig: string
  spec: ParticleSpec
  gpu: ParticleGpuMesh
  live: LiveParticle[]
  bursts: BurstRuntime[]
  emitCarry: number
  elapsed: number
  prevElapsed: number
  worldSpace: boolean
  loop: boolean
  prewarmed: boolean
  finished: boolean
  textureUrl: string | null
  invParent: THREE.Matrix4
}

/** ECS ParticleSystem → GPU-instanced billboard sprites (Explorer parity). */
export class ParticleSystemBridge {
  private readonly runtimes = new Map<Entity, ParticleRuntime>()

  constructor(
    private readonly ecs: MirrorComponents,
    private readonly cache: AssetCache,
    private readonly scene: ResolvedScene,
    private readonly getNodes: () => Map<Entity, THREE.Group> | undefined
  ) {}

  async sync(view: ProjectionView): Promise<void> {
    const { ParticleSystem, Transform } = this.ecs
    const nodes = this.getNodes()
    if (!nodes) return

    for (const [entity, runtime] of this.runtimes) {
      if (nodes.has(entity)) continue
      disposeParticleGpuMesh(runtime.gpu)
      this.runtimes.delete(entity)
    }

    const active = new Set<Entity>()
    for (const [entity] of view.getEntitiesWith(ParticleSystem)) {
      if (!Transform.has(entity)) continue
      const parent = nodes.get(entity)
      if (!parent) continue

      active.add(entity)
      const spec = ParticleSystem.get(entity) as ParticleSpec
      const sig = specSignature(spec)
      let runtime = this.runtimes.get(entity)

      if (!runtime || runtime.specSig !== sig) {
        if (runtime) this.disposeRuntime(entity, parent)
        const created = await this.createRuntime(spec, sig)
        if (!created) continue
        created.gpu.mesh.name = particleKey(entity)
        parent.add(created.gpu.mesh)
        this.runtimes.set(entity, created)
        runtime = created
      } else {
        runtime.spec = spec
        updateParticleGpuUniforms(runtime.gpu, spec)
      }

      if (spec.playbackState === PS_STOPPED) {
        runtime.live.length = 0
        runtime.emitCarry = 0
        runtime.elapsed = 0
        runtime.prevElapsed = 0
        runtime.finished = false
        resetBurstRuntimes(runtime.bursts, spec, runtime.loop)
      }

      const playing = spec.playbackState !== PS_PAUSED && spec.playbackState !== PS_STOPPED
      const visible = (spec.active !== false && playing) || runtime.live.length > 0
      runtime.gpu.mesh.visible = visible
    }

    for (const [entity, runtime] of this.runtimes) {
      if (active.has(entity)) continue
      const parent = nodes.get(entity)
      if (parent) this.disposeRuntime(entity, parent)
      else disposeParticleGpuMesh(runtime.gpu)
      this.runtimes.delete(entity)
    }
  }

  update(delta: number): void {
    const nodes = this.getNodes()
    if (!nodes) return

    let totalLive = 0
    for (const runtime of this.runtimes.values()) totalLive += runtime.live.length
    const rateScale = totalLive > SCENE_PARTICLE_BUDGET ? SCENE_PARTICLE_BUDGET / totalLive : 1

    for (const [entity, runtime] of this.runtimes) {
      const parent = nodes.get(entity)
      if (!parent) continue

      const spec = runtime.spec
      const paused = spec.playbackState === PS_PAUSED
      const stopped = spec.playbackState === PS_STOPPED
      const canEmit = spec.active !== false && !paused && !stopped && !runtime.finished

      if (stopped) {
        runtime.live.length = 0
        runtime.emitCarry = 0
        runtime.gpu.geometry.instanceCount = 0
        runtime.gpu.mesh.visible = false
        continue
      }

      runtime.prevElapsed = runtime.elapsed
      if (!paused) runtime.elapsed += delta

      if (runtime.loop && !paused) {
        const dur = cycleDuration(spec, runtime.bursts)
        if (dur > 0 && runtime.elapsed >= dur) {
          runtime.elapsed -= dur
          runtime.prevElapsed = Math.max(0, runtime.prevElapsed - dur)
          resetBurstRuntimes(runtime.bursts, spec, runtime.loop)
        }
      }

      const ctx: SpawnContext = { worldSpace: runtime.worldSpace, parent }
      const lifetime = Math.max(0.05, spec.lifetime ?? 5)

      if (!paused && canEmit) {
        if (!runtime.prewarmed && spec.prewarm === true && runtime.loop) {
          prewarmParticles(runtime.live, spec, ctx)
          processBursts(runtime.live, spec, runtime.bursts, runtime.elapsed, 0, ctx, lifetime)
          runtime.prewarmed = true
        }

        const canEmitRate = runtime.loop || runtime.elapsed < lifetime
        if (canEmitRate) {
          runtime.emitCarry = emitContinuous(runtime.live, spec, ctx, delta, runtime.emitCarry, rateScale)
        }
        processBursts(runtime.live, spec, runtime.bursts, runtime.elapsed, runtime.prevElapsed, ctx, lifetime)
      }

      if (!paused) simulateParticles(runtime.live, spec, delta)

      if (!runtime.loop && runtime.live.length === 0) {
        const burstsDone = runtime.bursts.every((b) => b.cycles !== 0 && b.firedCycles >= b.cycles)
        const rateDone = (spec.rate ?? 10) <= 0 || runtime.elapsed >= lifetime
        if (burstsDone && rateDone) runtime.finished = true
      }

      let inv: THREE.Matrix4 | null = null
      if (runtime.worldSpace) {
        parent.updateWorldMatrix(true, false)
        runtime.invParent.copy(parent.matrixWorld).invert()
        inv = runtime.invParent
      }

      uploadParticlesToGpu(runtime.gpu, runtime.live, spec, runtime.worldSpace, inv)
      runtime.gpu.mesh.visible =
        ((spec.active !== false && !stopped && !runtime.finished) || runtime.live.length > 0)
    }
  }

  dispose(): void {
    for (const [entity, runtime] of this.runtimes) {
      const parent = this.getNodes()?.get(entity)
      if (parent) this.disposeRuntime(entity, parent)
      else disposeParticleGpuMesh(runtime.gpu)
    }
    this.runtimes.clear()
  }

  private async createRuntime(spec: ParticleSpec, sig: string): Promise<ParticleRuntime | null> {
    const capacity = Math.max(1, Math.floor(spec.maxParticles ?? 1000))
    const gpu = createParticleGpuMesh(capacity, spec)
    const loop = spec.loop !== false

    const textureUrl = spec.texture?.src ? resolveSceneTextureUrl(spec.texture.src, this.scene) : null
    if (textureUrl) {
      try {
        const tex = await this.cache.loadTexture(textureUrl)
        applyParticleTexture(gpu, tex, spec)
      } catch {
        applyParticleTexture(gpu, null, spec)
      }
    }

    return {
      specSig: sig,
      spec,
      gpu,
      live: [],
      bursts: createBurstRuntimes(spec, loop),
      emitCarry: 0,
      elapsed: 0,
      prevElapsed: 0,
      worldSpace: spec.simulationSpace === PSS_WORLD,
      loop,
      prewarmed: false,
      finished: false,
      textureUrl,
      invParent: new THREE.Matrix4()
    }
  }

  private disposeRuntime(entity: Entity, parent: THREE.Object3D): void {
    const runtime = this.runtimes.get(entity)
    if (!runtime) return
    const child = parent.getObjectByName(particleKey(entity))
    if (child) parent.remove(child)
    disposeParticleGpuMesh(runtime.gpu)
    runtime.live.length = 0
    this.runtimes.delete(entity)
  }
}