import * as THREE from 'three'
import type { Entity } from '@dcl/ecs'
import type { AssetCache } from '../../rendering/AssetCache'
import { prefetchSceneManifestAssets } from '../../rendering/AssetCache'
import { SceneHost } from '../../rendering/SceneHost'
import {
  applyDclLocalTransform,
  dclToThreePos,
  type DclTransformValues
} from '../../bridge/dclTransform'
import type { EntityPose } from '../../bridge/ReservedEntitiesSync'
import { SceneScriptSystem } from '../../core/systems/SceneScriptSystem'
import type { ResolvedScene } from '../content/types'
import { resolveSceneFromEntityId, resolveSceneFromRoute } from '../content/resolveScene'
import {
  isAoiSecondaryGroundSrc,
  neighborOriginOffset,
  resolveContentUrl,
  shouldSkipAoiSecondaryGroundGlbs
} from './compositeVisuals'
import { lastFrameOverBudget, scheduleOffPlayRaf } from '../../rendering/mainThreadYield'

/**
 * Caps (not “only one scene total”):
 * - MAX_CONCURRENT: how many **workers** sample at once (heavy).
 * - MAX_FF_SECONDARIES: how many first-frame secondaries may be **actively sampling/queued**
 *   toward a first load (AoiVisualLayer may retain more meshes hidden for instant re-show).
 */
export const FF_MAX_CONCURRENT_SAMPLES = 1
export const FF_MAX_ACTIVE_SECONDARIES = 3
/**
 * Hierarchy bake version — bump when bake logic changes so stale AOI groups re-sample.
 * v5: pure Transform.parent Three hierarchy (primary EntityStore path).
 * v6: skip scene ground/floor GLBs (AOI blank tiles cover footprint).
 * v7: keep all GLBs by default (incl. scene.glb); ground skip only if scene.json opts in.
 */
export const FF_HIERARCHY_VERSION = 7
/** Angzaar-scale estates need a high attach budget for nested props. */
const MAX_GLTFS = 400
const TIMEOUT_MS = 35_000
const STABLE_MS = 1_200
const MIN_GLTF_FOR_STABLE = 12
/** Min scene runtime before we trust the Transform graph (scripts parent in onUpdate). */
const MIN_SCENE_RUNTIME_MS = 3_500
/** After GLTFs stabilize, wait until parented-entity count stops changing. */
const PARENT_GRAPH_SETTLE_MS = 2_000
const POLL_MS = 40

export type FirstFrameSampleRequest = {
  entityId: string
  title: string
  base: string
  primaryBase: string
  resolveX: number
  resolveY: number
  cache: AssetCache
  contentBaseUrl: string
  onReady: (entityId: string, group: THREE.Group, placementCount: number) => void
  onFail?: (entityId: string, reason: string) => void
}

/**
 * Explorer-style first-frame pickup for script-built neighbors (no main.composite).
 *
 * Boots an isolated scene worker, waits for GltfContainers **and** Transform.parent
 * graph to settle (Angzaar-style scenes parent in systems, not NetworkParent), then
 * builds a Three hierarchy identical to primary EntityStore: local TRS per node,
 * mesh at entity origin.
 */
export class SecondaryFirstFrameSampler {
  private readonly queued: FirstFrameSampleRequest[] = []
  private readonly inFlightIds = new Set<string>()
  private readonly doneIds = new Set<string>()
  private active = 0
  private disposed = false
  private gen = 0

  private doneKey(entityId: string): string {
    return `${entityId}@ff${FF_HIERARCHY_VERSION}`
  }

  knows(entityId: string): boolean {
    return (
      this.doneIds.has(this.doneKey(entityId)) ||
      this.inFlightIds.has(entityId) ||
      this.queued.some((q) => q.entityId === entityId)
    )
  }

  markLoaded(entityId: string): void {
    this.doneIds.add(this.doneKey(entityId))
  }

  forget(entityId: string): void {
    this.doneIds.delete(this.doneKey(entityId))
  }

  enqueue(req: FirstFrameSampleRequest): void {
    if (this.disposed) return
    if (this.knows(req.entityId)) return
    if (this.active + this.queued.length >= FF_MAX_ACTIVE_SECONDARIES) {
      console.info(
        `[aoi-ff] skip “${req.title}” — sample queue cap (${FF_MAX_ACTIVE_SECONDARIES})`
      )
      return
    }
    this.queued.push(req)
    this.pump()
  }

  reset(): void {
    this.gen++
    this.queued.length = 0
    this.inFlightIds.clear()
    this.doneIds.clear()
    this.active = 0
  }

  dispose(): void {
    this.disposed = true
    this.reset()
  }

  private pump(): void {
    if (this.disposed) return
    while (this.active < FF_MAX_CONCURRENT_SAMPLES && this.queued.length) {
      const req = this.queued.shift()!
      if (this.doneIds.has(this.doneKey(req.entityId)) || this.inFlightIds.has(req.entityId)) {
        continue
      }
      this.inFlightIds.add(req.entityId)
      this.active++
      const gen = this.gen
      // Isolated host after present — never tickPlayFrame on the play rAF.
      scheduleOffPlayRaf(() => {
        void this.runOne(req, gen).finally(() => {
          this.inFlightIds.delete(req.entityId)
          this.active = Math.max(0, this.active - 1)
          this.pump()
        })
      })
    }
  }

  private async runOne(req: FirstFrameSampleRequest, gen: number): Promise<void> {
    const label = req.title || req.base
    let hostEl: HTMLDivElement | null = null
    let host: SceneHost | null = null
    let system: SceneScriptSystem | null = null

    try {
      const scene =
        (await resolveSceneFromEntityId(req.entityId, {
          x: req.resolveX,
          y: req.resolveY
        })) ??
        (await resolveSceneFromRoute({
          kind: 'coords',
          x: req.resolveX,
          y: req.resolveY,
          segment: `${req.resolveX},${req.resolveY}`
        }))
      if (gen !== this.gen || this.disposed) return
      if (!scene?.mainEntry) {
        this.doneIds.add(this.doneKey(req.entityId))
        req.onFail?.(req.entityId, 'no main entry')
        return
      }
      if (scene.entityId && req.entityId && scene.entityId !== req.entityId) {
        this.doneIds.add(this.doneKey(req.entityId))
        req.onFail?.(req.entityId, 'pointer resolved covering plaza, not this entity')
        return
      }

      const neighborBase = scene.baseParcel || req.base
      try {
        await prefetchSceneManifestAssets(req.cache, scene)
      } catch {
        /* best-effort */
      }
      if (gen !== this.gen || this.disposed) return

      hostEl = document.createElement('div')
      hostEl.style.cssText =
        'position:fixed;left:-9999px;top:0;width:4px;height:4px;opacity:0;pointer-events:none'
      hostEl.setAttribute('data-aoi-ff-host', req.entityId.slice(0, 12))
      document.body.appendChild(hostEl)

      host = new SceneHost(hostEl)
      system = new SceneScriptSystem()
      const playerPose = spawnPose(scene, 0)
      const cameraPose = spawnPose(scene, 1.6)
      system.setClientPoseProvider(() => ({ player: playerPose, camera: cameraPose }))
      system.prepare(scene, req.cache, host)
      system.seedRendererEntities(playerPose, cameraPose)
      // Projection + Transform hierarchy only — no full GPU attach of every GLB in the host.
      system.setAssetHydrationMode(false)

      await system.start(scene, req.cache, host)
      if (gen !== this.gen || this.disposed) return

      const started = performance.now()
      let peak = 0
      let gltfStableSince = 0
      let lastGltf = -1
      let parentedStableSince = 0
      let lastParented = -1
      let ready = false
      let overBudgetStreak = 0

      while (performance.now() - started < TIMEOUT_MS) {
        if (gen !== this.gen || this.disposed) return
        if (lastFrameOverBudget(33)) {
          overBudgetStreak++
          if (overBudgetStreak >= 3 && peak < 1) {
            this.doneIds.add(this.doneKey(req.entityId))
            req.onFail?.(req.entityId, 'over-budget')
            return
          }
        } else {
          overBudgetStreak = 0
        }
        system.tickPlayFrame()
        await system.yieldForWorkerMessages()
        try {
          await system.syncRenderer()
        } catch {
          /* projection may still advance */
        }
        // Harmless no-op when the scene has no NetworkParent components.
        system.rebindAllNetworkParents()

        const gltfCount = countProjectionGltfs(system)
        const parented = countParentedTransforms(system)

        if (gltfCount !== lastGltf) {
          lastGltf = gltfCount
          if (gltfCount > peak) peak = gltfCount
          gltfStableSince = performance.now()
        }
        if (parented !== lastParented) {
          lastParented = parented
          parentedStableSince = performance.now()
        }

        const runtime = performance.now() - started
        const gltfOk =
          peak >= MIN_GLTF_FOR_STABLE &&
          gltfStableSince > 0 &&
          performance.now() - gltfStableSince >= STABLE_MS
        const parentOk =
          parentedStableSince > 0 &&
          performance.now() - parentedStableSince >= PARENT_GRAPH_SETTLE_MS
        // Prefer both; if almost no parented entities after min runtime, still bake
        // (scene may be flat) once GLTFs are stable.
        const flatScene = parented < 3 && runtime >= MIN_SCENE_RUNTIME_MS + STABLE_MS
        if (runtime >= MIN_SCENE_RUNTIME_MS && gltfOk && (parentOk || flatScene)) {
          ready = true
          break
        }
        if (peak >= MAX_GLTFS && runtime >= MIN_SCENE_RUNTIME_MS && parentOk) {
          ready = true
          break
        }
        await sleep(POLL_MS)
      }

      if (gen !== this.gen || this.disposed) return

      // One more sync so last Transform puts land.
      system.tickPlayFrame()
      await system.yieldForWorkerMessages()
      try {
        await system.syncRenderer()
      } catch {
        /* ignore */
      }
      system.rebindAllNetworkParents()

      const parentedFinal = countParentedTransforms(system)
      const group = await buildHierarchicalFirstFrameGroup({
        system,
        cache: req.cache,
        contentBaseUrl: scene.contentsBaseUrl || req.contentBaseUrl,
        content: scene.content,
        neighborBase,
        primaryBase: req.primaryBase,
        maxGltfs: MAX_GLTFS,
        groupName: `aoi-secondary-ff:${req.entityId}`,
        skipGroundGlbs: shouldSkipAoiSecondaryGroundGlbs(
          scene.metadata as { featureToggles?: Record<string, unknown>; aoiSkipGroundGlbs?: unknown } | undefined
        )
      })

      console.info(
        `[aoi-ff] hierarchy v${FF_HIERARCHY_VERSION} “${label}” peakGltf=${peak}` +
          ` attached=${group.userData.ffGltfCount ?? 0}` +
          ` parentedTf=${parentedFinal}` +
          ` nodes=${group.userData.ffNodeCount ?? 0}` +
          ` orphans=${group.userData.ffOrphans ?? 0}` +
          ` maxDepth=${group.userData.ffMaxDepth ?? 0}` +
          ` ready=${ready}` +
          ` waited=${((performance.now() - started) / 1000).toFixed(1)}s base=${neighborBase}`
      )

      system.setAssetHydrationMode(false)
      system.dispose()
      system = null
      host.dispose()
      host = null
      hostEl.remove()
      hostEl = null

      if (gen !== this.gen || this.disposed) {
        group.clear()
        return
      }

      const gltfCount = (group.userData.ffGltfCount as number) ?? 0
      if (gltfCount === 0) {
        this.doneIds.add(this.doneKey(req.entityId))
        req.onFail?.(req.entityId, 'zero meshes loaded')
        group.clear()
        return
      }

      this.doneIds.add(this.doneKey(req.entityId))
      console.info(
        `[aoi] first-frame secondary “${label}” gltfs=${gltfCount} base=${neighborBase} (hierarchy v${FF_HIERARCHY_VERSION})`
      )
      req.onReady(req.entityId, group, gltfCount)
    } catch (err) {
      this.doneIds.add(this.doneKey(req.entityId))
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(`[aoi-ff] first-frame sample failed “${label}”`, err)
      req.onFail?.(req.entityId, msg)
    } finally {
      try {
        system?.dispose()
      } catch {
        /* ignore */
      }
      try {
        host?.dispose()
      } catch {
        /* ignore */
      }
      hostEl?.remove()
    }
  }
}

function spawnPose(scene: ResolvedScene, yExtra: number): EntityPose {
  const x = scene.spawn?.x ?? 8
  const y = (scene.spawn?.y ?? 0) + yExtra
  const z = scene.spawn?.z ?? 8
  return {
    position: new THREE.Vector3(x, y, z),
    rotation: new THREE.Quaternion(0, 0, 0, 1)
  }
}

function countProjectionGltfs(system: SceneScriptSystem): number {
  const { GltfContainer } = system.readComponents
  const view = system.view
  let n = 0
  for (const [entity] of view.getEntitiesWith(GltfContainer)) {
    if (isReserved(entity, view)) continue
    const src = GltfContainer.get(entity).src?.trim()
    if (src) n++
  }
  return n
}

/** Entities whose Transform.parent is another scene entity (not root / reserved). */
function countParentedTransforms(system: SceneScriptSystem): number {
  const { Transform } = system.readComponents
  const view = system.view
  let n = 0
  for (const [entity] of view.getEntitiesWith(Transform)) {
    if (isReserved(entity, view)) continue
    const t = Transform.get(entity) as DclTransformValues
    const p = t.parent as Entity | undefined
    if (p == null || (p as number) === 0 || p === view.RootEntity) continue
    if (isReserved(p, view)) continue
    if (!Transform.has(p)) continue
    n++
  }
  return n
}

/**
 * Primary EntityStore path: Object3D per Transform, local TRS, parent chain, mesh at origin.
 * Flattening to world TRS previously lost nested scales/pivots for some graphs; hierarchy
 * matches play-mode when Transform.parent is correct.
 */
async function buildHierarchicalFirstFrameGroup(opts: {
  system: SceneScriptSystem
  cache: AssetCache
  contentBaseUrl: string
  content: { file: string; hash: string }[]
  neighborBase: string
  primaryBase: string
  maxGltfs: number
  groupName: string
  /** From scene.json — default false keeps scene.glb / floors. */
  skipGroundGlbs?: boolean
}): Promise<THREE.Group> {
  const { GltfContainer, Transform } = opts.system.readComponents
  const view = opts.system.view
  const skipGround = opts.skipGroundGlbs === true

  const wrap = new THREE.Group()
  wrap.name = opts.groupName
  wrap.userData.ffHierarchyVer = FF_HIERARCHY_VERSION
  const origin = neighborOriginOffset(opts.neighborBase, opts.primaryBase)
  dclToThreePos(origin.x, 0, origin.z, wrap.position)

  const sceneRoot = new THREE.Group()
  sceneRoot.name = 'ff-scene-root'
  wrap.add(sceneRoot)

  const nodes = new Map<Entity, THREE.Object3D>()
  const parents = new Map<Entity, Entity | null>()

  for (const [entity] of view.getEntitiesWith(Transform)) {
    if (isReserved(entity, view)) continue
    const raw = Transform.get(entity) as DclTransformValues
    const obj = new THREE.Object3D()
    obj.name = `ff-ent-${entity as number}`
    applyDclLocalTransform(obj, normalizeDclTransform(raw))
    nodes.set(entity, obj)

    const p = raw.parent as Entity | undefined
    if (
      p !== undefined &&
      p !== null &&
      (p as number) !== 0 &&
      p !== view.RootEntity &&
      !isReserved(p, view) &&
      Transform.has(p)
    ) {
      parents.set(entity, p)
    } else {
      parents.set(entity, null)
    }
  }

  // Ensure parent pivots exist even if they somehow lacked Transform in the first pass
  // (should not happen if Transform.has(p) was required above).
  let grew = true
  while (grew) {
    grew = false
    for (const p of [...parents.values()]) {
      if (p == null || nodes.has(p) || !Transform.has(p) || isReserved(p, view)) continue
      const raw = Transform.get(p) as DclTransformValues
      const obj = new THREE.Object3D()
      obj.name = `ff-ent-${p as number}`
      applyDclLocalTransform(obj, normalizeDclTransform(raw))
      nodes.set(p, obj)
      const pp = raw.parent as Entity | undefined
      if (
        pp != null &&
        (pp as number) !== 0 &&
        pp !== view.RootEntity &&
        !isReserved(pp, view) &&
        Transform.has(pp)
      ) {
        parents.set(p, pp)
      } else {
        parents.set(p, null)
      }
      grew = true
    }
  }

  let orphans = 0
  let maxDepth = 0
  const depthOf = (entity: Entity): number => {
    let d = 0
    let cur: Entity | null | undefined = entity
    const guard = new Set<Entity>()
    while (cur != null) {
      if (guard.has(cur)) break
      guard.add(cur)
      const p = parents.get(cur)
      if (p == null) break
      d++
      cur = p
    }
    return d
  }

  for (const [entity, obj] of nodes) {
    obj.removeFromParent()
    const p = parents.get(entity) ?? null
    if (p != null && nodes.has(p) && p !== entity) {
      nodes.get(p)!.add(obj)
      maxDepth = Math.max(maxDepth, depthOf(entity))
    } else {
      if (p != null) orphans++
      sceneRoot.add(obj)
    }
  }

  const candidates: Array<{ entity: Entity; src: string; depth: number }> = []
  let skippedGround = 0
  for (const [entity] of view.getEntitiesWith(GltfContainer, Transform)) {
    if (isReserved(entity, view)) continue
    if (!nodes.has(entity)) continue
    const src = GltfContainer.get(entity).src?.trim()
    if (!src) continue
    // Only when scene.json opts in (aoiSkipGroundGlbs) — never strip scene.glb by default.
    if (skipGround && isAoiSecondaryGroundSrc(src)) {
      skippedGround++
      continue
    }
    candidates.push({ entity, src, depth: depthOf(entity) })
  }
  candidates.sort((a, b) => a.depth - b.depth || (a.entity as number) - (b.entity as number))

  const results = await Promise.all(
    candidates.slice(0, opts.maxGltfs).map(async ({ entity, src }) => {
      const parentNode = nodes.get(entity)
      if (!parentNode) return false
      const resolved = resolveContentUrl(src, opts.content, opts.contentBaseUrl)
      if (!resolved) return false
      try {
        const { root } = await opts.cache.load(resolved.url, resolved.hash)
        const clone = root.clone(true)
        clone.traverse((node) => {
          if (node instanceof THREE.Mesh && /collider/i.test(node.name)) {
            node.visible = false
          }
        })
        // Mesh at entity origin — parent chain carries all local transforms (primary path).
        clone.position.set(0, 0, 0)
        clone.quaternion.identity()
        clone.scale.set(1, 1, 1)
        clone.name = `ff-gltf:${src.split('/').pop() ?? 'mesh'}`
        parentNode.add(clone)
        return true
      } catch {
        return false
      }
    })
  )

  wrap.userData.ffGltfCount = results.filter(Boolean).length
  wrap.userData.ffNodeCount = nodes.size
  wrap.userData.ffOrphans = orphans
  wrap.userData.ffMaxDepth = maxDepth
  wrap.userData.ffParentedNodes = [...parents.values()].filter((p) => p != null).length
  wrap.userData.ffSkippedGround = skippedGround
  if (skippedGround > 0) {
    console.info(`[aoi-ff] skipped ${skippedGround} ground/floor GLB(s) (client blank tiles cover footprint)`)
  }
  return wrap
}

function normalizeDclTransform(raw: DclTransformValues): DclTransformValues {
  const p = raw.position ?? { x: 0, y: 0, z: 0 }
  const r = raw.rotation ?? { x: 0, y: 0, z: 0, w: 1 }
  const s = raw.scale ?? { x: 1, y: 1, z: 1 }
  return {
    position: {
      x: num(p.x),
      y: num(p.y),
      z: num(p.z)
    },
    rotation: {
      x: num(r.x),
      y: num(r.y),
      z: num(r.z),
      w: r.w === undefined ? 1 : num(r.w, 1)
    },
    scale: {
      x: s.x === undefined ? 1 : num(s.x, 1),
      y: s.y === undefined ? 1 : num(s.y, 1),
      z: s.z === undefined ? 1 : num(s.z, 1)
    },
    parent: raw.parent
  }
}

function isReserved(
  entity: Entity,
  view: { RootEntity: Entity; PlayerEntity: Entity; CameraEntity: Entity }
): boolean {
  return (
    entity === view.RootEntity || entity === view.PlayerEntity || entity === view.CameraEntity
  )
}

function num(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
