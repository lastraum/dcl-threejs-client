import * as THREE from 'three'
import type { Entity } from '@dcl/ecs'
import type { ResolvedScene } from '../dcl/content/types'
import type { AssetCache } from '../rendering/AssetCache'
import { clientDebugLog } from '../client/debug/ClientDebugLog'
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

const _frustum = new THREE.Frustum()
const _projScreen = new THREE.Matrix4()
const _emitterWorld = new THREE.Vector3()
const _emitterSphere = new THREE.Sphere()

/** ECS ParticleSystem → GPU-instanced billboard sprites (Explorer parity). */
export class ParticleSystemBridge {
  private readonly runtimes = new Map<Entity, ParticleRuntime>()
  private lastDiagAt = 0
  private loggedCreates = 0
  private syncInFlight = false

  constructor(
    private readonly ecs: MirrorComponents,
    private readonly cache: AssetCache,
    private readonly scene: ResolvedScene,
    private readonly getNodes: () => Map<Entity, THREE.Group> | undefined,
    /** Active camera for frustum prioritization (in-view systems always full rate). */
    private readonly getCamera: () => THREE.Camera | null = () => null
  ) {}

  async sync(view: ProjectionView): Promise<void> {
    if (this.syncInFlight) return
    this.syncInFlight = true
    try {
      await this.syncInner(view)
    } finally {
      this.syncInFlight = false
    }
  }

  private async syncInner(view: ProjectionView): Promise<void> {
    const { ParticleSystem, Transform } = this.ecs
    const nodes = this.getNodes()
    if (!nodes) return

    for (const [entity, runtime] of this.runtimes) {
      if (nodes.has(entity)) continue
      disposeParticleGpuMesh(runtime.gpu)
      this.runtimes.delete(entity)
    }

    const active = new Set<Entity>()
    // Create all pending particle systems this sync (was 2/tick — clubhouse fire could wait forever
    // behind async bridge cadence). Texture load is still async per create.
    let pendingCreates = 0
    let missingNode = 0
    for (const [entity] of view.getEntitiesWith(ParticleSystem)) {
      if (!Transform.has(entity)) continue
      const parent = nodes.get(entity)
      if (!parent) {
        missingNode++
        continue
      }

      active.add(entity)
      const spec = ParticleSystem.get(entity) as ParticleSpec
      const sig = specSignature(spec)
      let runtime = this.runtimes.get(entity)

      if (!runtime || runtime.specSig !== sig) {
        if (runtime) this.disposeRuntime(entity, parent)
        const created = await this.createRuntime(spec, sig)
        if (!created) {
          pendingCreates++
          continue
        }
        created.gpu.mesh.name = particleKey(entity)
        parent.add(created.gpu.mesh)
        this.runtimes.set(entity, created)
        runtime = created
        this.loggedCreates++
        if (this.loggedCreates <= 12) {
          const tex = spec.texture?.src?.trim() || '(none)'
          clientDebugLog.log(
            'scene',
            `particles create e${entity as number} tex=${tex} rate=${spec.rate ?? 10} ` +
              `max=${spec.maxParticles ?? 1000} state=${spec.playbackState ?? 0} ` +
              `active=${spec.active !== false} loop=${spec.loop !== false}`,
            { alsoConsole: true }
          )
        }
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

    const now = performance.now()
    if (now - this.lastDiagAt > 3000) {
      this.lastDiagAt = now
      const ecsCount = [...view.getEntitiesWith(ParticleSystem)].length
      let live = 0
      for (const r of this.runtimes.values()) live += r.live.length
      clientDebugLog.log(
        'scene',
        `particles sync ecs=${ecsCount} runtimes=${this.runtimes.size} live=${live}` +
          (missingNode ? ` missingNode=${missingNode}` : '') +
          (pendingCreates ? ` createFail=${pendingCreates}` : '') +
          ` frustumPriority=1`,
        { alsoConsole: true, throttleMs: 3000, throttleKey: 'particles-sync-diag' }
      )
    }
  }

  update(delta: number): void {
    const nodes = this.getNodes()
    if (!nodes) return

    // Frustum: every system whose emitter is in (or near) view plays at full rate.
    // Off-camera systems do not emit (free budget / GPU); already-live particles still age out.
    let frustumReady = false
    const cam = this.getCamera()
    if (cam) {
      cam.updateMatrixWorld(false)
      _projScreen.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse)
      _frustum.setFromProjectionMatrix(_projScreen)
      frustumReady = true
    }

    type Marked = { entity: Entity; runtime: ParticleRuntime; parent: THREE.Group; inView: boolean }
    const marked: Marked[] = []
    let liveInView = 0
    for (const [entity, runtime] of this.runtimes) {
      const parent = nodes.get(entity)
      if (!parent) continue
      parent.updateWorldMatrix(true, false)
      parent.getWorldPosition(_emitterWorld)
      const radius = emitterRadius(runtime.spec)
      _emitterSphere.center.copy(_emitterWorld)
      _emitterSphere.radius = radius
      const inView = !frustumReady || _frustum.intersectsSphere(_emitterSphere)
      if (inView) liveInView += runtime.live.length
      marked.push({ entity, runtime, parent, inView })
    }

    // Budget only among in-view systems — never starve visible VFX for off-camera emitters.
    const rateScaleIn =
      liveInView > SCENE_PARTICLE_BUDGET ? SCENE_PARTICLE_BUDGET / Math.max(1, liveInView) : 1

    for (const { runtime, parent, inView } of marked) {
      const spec = runtime.spec
      const paused = spec.playbackState === PS_PAUSED
      const stopped = spec.playbackState === PS_STOPPED
      // Scene-paused still honored; we never force-play against ECS. Off-camera: stop *emit*
      // so in-view systems get full budget, but keep simulating existing particles.
      const sceneAllows = spec.active !== false && !paused && !stopped && !runtime.finished
      const canEmit = sceneAllows && inView

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
      const rateScale = inView ? rateScaleIn : 0

      if (!paused && canEmit) {
        if (!runtime.prewarmed && spec.prewarm === true && runtime.loop) {
          prewarmParticles(runtime.live, spec, ctx)
          processBursts(runtime.live, spec, runtime.bursts, runtime.elapsed, 0, ctx, lifetime)
          runtime.prewarmed = true
        }

        const canEmitRate = runtime.loop || runtime.elapsed < lifetime
        if (canEmitRate) {
          runtime.emitCarry = emitContinuous(
            runtime.live,
            spec,
            ctx,
            delta,
            runtime.emitCarry,
            rateScale
          )
        }
        processBursts(
          runtime.live,
          spec,
          runtime.bursts,
          runtime.elapsed,
          runtime.prevElapsed,
          ctx,
          lifetime
        )
      }

      // Always simulate while in view (or while live particles remain off-camera).
      if (!paused && (inView || runtime.live.length > 0)) {
        simulateParticles(runtime.live, spec, delta)
      }

      if (!runtime.loop && runtime.live.length === 0) {
        const burstsDone = runtime.bursts.every((b) => b.cycles !== 0 && b.firedCycles >= b.cycles)
        const rateDone = (spec.rate ?? 10) <= 0 || runtime.elapsed >= lifetime
        if (burstsDone && rateDone) runtime.finished = true
      }

      let inv: THREE.Matrix4 | null = null
      if (runtime.worldSpace) {
        runtime.invParent.copy(parent.matrixWorld).invert()
        inv = runtime.invParent
      }

      uploadParticlesToGpu(runtime.gpu, runtime.live, spec, runtime.worldSpace, inv)
      // Keep mesh visible when in view or still has live sprites (tail of burst).
      runtime.gpu.mesh.visible =
        ((spec.active !== false && !stopped && !runtime.finished && inView) ||
          runtime.live.length > 0)
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
      } catch (err) {
        clientDebugLog.log(
          'scene',
          `particles texture load failed src=${spec.texture?.src} url=${textureUrl} ` +
            `${err instanceof Error ? err.message : String(err)}`,
          { level: 'warn', alsoConsole: true }
        )
        applyParticleTexture(gpu, null, spec)
      }
    } else if (spec.texture?.src) {
      clientDebugLog.log(
        'scene',
        `particles texture URL unresolved — src=${spec.texture.src}`,
        { level: 'warn', alsoConsole: true }
      )
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

/** Conservative emitter sphere so large VFX still count as in-view near the camera. */
function emitterRadius(spec: ParticleSpec): number {
  const life = Math.max(0.5, typeof spec.lifetime === 'number' ? spec.lifetime : 5)
  const vel = spec.initialVelocitySpeed
  let speed = 1
  if (typeof vel === 'number') speed = vel
  else if (vel && typeof vel === 'object') {
    const a = typeof vel.start === 'number' ? vel.start : 1
    const b = typeof vel.end === 'number' ? vel.end : a
    speed = Math.max(a, b)
  }
  speed = Math.max(0, speed)
  // Spread ~ lifetime * speed; clamp so we don't keep half the plaza "in view".
  return Math.min(48, Math.max(4, life * speed * 0.35 + 3))
}