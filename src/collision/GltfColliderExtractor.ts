import * as THREE from 'three'
import type { Entity } from '@dcl/ecs'
import type { MirrorComponents } from '../bridge/mirrorComponents'
import type { ProjectionView } from '../bridge/ProjectionView'
import type { PhysicsColliderDesc, PhysicsColliderShapeDesc } from '../physics/PhysXWorld'
import { physxColliderDebug } from '../debug/PhysxColliderDebug'
import { ColliderLayer, hasColliderLayer } from './ColliderLayer'
import { isGltfInvisibleColliderMesh, isGltfVisibleClassMesh } from './gltfColliderNaming'
import { bakeTrimeshGeometry } from '../physics/bakeTrimeshGeometry'
import { clientDebugLog } from '../client/debug/ClientDebugLog'

const LANDSCAPE_COLLIDER_ENTITY_BASE = 19_000_000
/** Synthetic PhysX entity id — one actor per GltfContainer ECS entity (avoids MeshCollider id clash). */
const GLTF_COLLIDER_ENTITY_BASE = 20_000_000

const _entityInv = new THREE.Matrix4()
const _worldMatrix = new THREE.Matrix4()

/**
 * Extracts physics colliders from GLTF meshes.
 * DCL convention: invisible physics meshes named `_collider…` or `…_collider` (see `gltfColliderNaming.ts`).
 * One static PhysX actor per GltfContainer entity — geometry in mesh-local space, actor at entity world pose.
 */
export class GltfColliderExtractor {
  private readonly extracted = new Map<Entity, PhysicsColliderDesc>()
  private readonly fingerprints = new Map<Entity, string>()
  private readonly poseFingerprints = new Map<Entity, string>()
  /** Stable geometry + mask + mesh child — skip trimesh re-extract when unchanged. */
  private readonly syncState = new Map<Entity, { geomKey: string; maskKey: string; mesh: THREE.Object3D }>()
  private readonly debugRoot: THREE.Group
  private readonly debugMeshes = new Map<string, THREE.Mesh>()
  private debugFingerprint = ''
  private readonly unsubscribeDebug: () => void
  private loggedSyncSummary = false
  /** Dedupe per-entity diagnostics — avoids thousands of repeats on full-resync / prewarm passes. */
  private loggedEntities = new Set<Entity>()
  private landscapeRoot: THREE.Object3D | null = null
  private landscapeColliders: PhysicsColliderDesc[] = []
  private landscapeCollidersReady = false
  private physicsBatchFingerprint = ''

  private static emptyFingerprint = '__empty__'

  constructor(scene: THREE.Scene) {
    this.debugRoot = new THREE.Group()
    this.debugRoot.name = 'gltf-collider-debug'
    this.debugRoot.visible = false
    scene.add(this.debugRoot)
    this.unsubscribeDebug = physxColliderDebug.subscribe(() => this.syncDebugVisibility())
  }

  dispose(): void {
    this.unsubscribeDebug()
    this.landscapeRoot = null
    for (const mesh of this.debugMeshes.values()) {
      mesh.geometry.dispose()
      ;(mesh.material as THREE.Material).dispose()
    }
    this.debugMeshes.clear()
    this.debugRoot.removeFromParent()
  }

  sync(
    view: ProjectionView,
    ecs: MirrorComponents,
    entityNodes: Map<Entity, THREE.Group>
  ): void {
    const { Transform, GltfContainer } = ecs
    const active = new Set<Entity>()

    for (const [entity] of view.getEntitiesWith(GltfContainer, Transform)) {
      if (entity === view.RootEntity || entity === view.PlayerEntity || entity === view.CameraEntity) {
        continue
      }

      const obj = entityNodes.get(entity)
      if (!obj) continue

      const gltfMesh = obj.children.find((c) => c.name.startsWith('__mesh_'))
      if (!gltfMesh) continue

      active.add(entity)

      const gltfData = GltfContainer.get(entity)
      const invisibleMask = gltfData.invisibleMeshesCollisionMask ?? (ColliderLayer.CL_POINTER | ColliderLayer.CL_PHYSICS)
      const visibleMask = gltfData.visibleMeshesCollisionMask ?? 0

      const hasVisiblePhysics = hasColliderLayer(visibleMask, ColliderLayer.CL_PHYSICS)
      const hasInvisiblePhysics = hasColliderLayer(invisibleMask, ColliderLayer.CL_PHYSICS)
      const maskKey = `${invisibleMask}|${visibleMask}`
      const prevGeom = this.fingerprints.get(entity)
      const state = this.syncState.get(entity)
      const stored = this.extracted.get(entity)

      if (
        stored &&
        prevGeom &&
        prevGeom !== GltfColliderExtractor.emptyFingerprint &&
        state?.mesh === gltfMesh &&
        state.geomKey === prevGeom &&
        state.maskKey === maskKey
      ) {
        obj.updateMatrixWorld(true)
        const poseFp = colliderPoseFp(obj.matrixWorld)
        if (this.poseFingerprints.get(entity) !== poseFp) {
          stored.matrix.copy(obj.matrixWorld)
          this.poseFingerprints.set(entity, poseFp)
        }
        continue
      }

      const desc = this.extractColliderDesc(entity, gltfMesh, obj, hasVisiblePhysics, hasInvisiblePhysics)

      if (!desc && !hasVisiblePhysics && !hasInvisiblePhysics && !hasAnyInvisibleColliderMesh(gltfMesh)) {
        continue
      }

      const geomKey = desc?.shapes?.length
        ? desc.shapes.map((s) => s.fingerprint).join('|')
        : GltfColliderExtractor.emptyFingerprint
      const geomChanged = prevGeom !== geomKey

      if (geomChanged) {
        this.fingerprints.set(entity, geomKey)
        this.logEntityOnce(entity, gltfData.src, invisibleMask, visibleMask, desc, gltfMesh)
      }

      if (desc) {
        this.extracted.set(entity, desc)
        this.syncState.set(entity, { geomKey, maskKey, mesh: gltfMesh })
        this.poseFingerprints.set(entity, colliderPoseFp(desc.matrix))
      } else {
        this.extracted.delete(entity)
        this.syncState.delete(entity)
        this.poseFingerprints.delete(entity)
      }
    }

    if (!this.loggedSyncSummary && active.size > 0) {
      const debugVisible = physxColliderDebug.isGltfCollidersVisible()
      clientDebugLog.log(
        'collision',
        `[GltfCollider] sync complete — ${active.size} entities, ${this.totalShapeCount()} shape(s) in ${this.extracted.size} actor(s)`,
        { alsoConsole: debugVisible, throttleMs: debugVisible ? undefined : 60_000 }
      )
      this.loggedSyncSummary = true
    }

    for (const entity of this.extracted.keys()) {
      if (!active.has(entity)) {
        this.extracted.delete(entity)
        this.fingerprints.delete(entity)
        this.poseFingerprints.delete(entity)
        this.syncState.delete(entity)
      }
    }

    this.recomputePhysicsBatchFingerprint()
    this.syncDebugVisibility()
  }

  /** Pose-only pass for tweened entities — skips full GLTF mesh traversal. */
  syncPoses(entityNodes: Map<Entity, THREE.Group>): void {
    if (!this.extracted.size) return
    let changed = false
    for (const [entity, stored] of this.extracted) {
      const obj = entityNodes.get(entity)
      if (!obj) continue
      obj.updateMatrixWorld(true)
      const poseFp = colliderPoseFp(obj.matrixWorld)
      if (this.poseFingerprints.get(entity) === poseFp) continue
      stored.matrix.copy(obj.matrixWorld)
      this.poseFingerprints.set(entity, poseFp)
      changed = true
    }
    if (changed) this.recomputePhysicsBatchFingerprint()
  }

  setLandscapeRoot(root: THREE.Object3D | null): void {
    this.landscapeRoot = root
    this.landscapeCollidersReady = false
    this.landscapeColliders = []
    this.recomputePhysicsBatchFingerprint()
    this.syncDebugVisibility()
  }

  /** Cheap stable hash — skip PhysX cook when geometry + poses are unchanged. */
  getPhysicsBatchFingerprint(): string {
    return this.physicsBatchFingerprint
  }

  getPhysicsColliders(): PhysicsColliderDesc[] {
    return [...this.collectPhysicsColliders(), ...this.ensureLandscapeColliders()]
  }

  /** GltfContainer entities with cookable physics trimeshes (excludes landscape root). */
  getGltfEntityColliderCount(): number {
    return this.extracted.size
  }

  getLandscapeColliderCount(): number {
    return this.ensureLandscapeColliders().length
  }

  private ensureLandscapeColliders(): PhysicsColliderDesc[] {
    if (!this.landscapeRoot) return []
    if (!this.landscapeCollidersReady) {
      this.landscapeRoot.updateMatrixWorld(true)
      this.landscapeColliders = buildColliderDescs(this.landscapeRoot, this.landscapeRoot, 'landscape')
      this.landscapeCollidersReady = true
    }
    return this.landscapeColliders
  }

  private recomputePhysicsBatchFingerprint(): void {
    const parts: string[] = []
    for (const [entity, desc] of this.extracted) {
      parts.push(`${entity}:${desc.fingerprint}:${colliderPoseFp(desc.matrix)}`)
    }
    for (const desc of this.landscapeColliders) {
      parts.push(`L:${desc.fingerprint}:${colliderPoseFp(desc.matrix)}`)
    }
    this.physicsBatchFingerprint = parts.join('|')
  }

  private collectPhysicsColliders(): PhysicsColliderDesc[] {
    return [...this.extracted.values()]
  }

  private totalShapeCount(): number {
    let n = 0
    for (const desc of this.extracted.values()) {
      n += desc.shapes?.length ?? 0
    }
    return n
  }

  /** Verbose per-entity lines only with `?colliders`; each entity logged at most once per session. */
  private logEntityOnce(
    entity: Entity,
    src: string,
    invisibleMask: number,
    visibleMask: number,
    desc: PhysicsColliderDesc | null,
    gltfMesh: THREE.Object3D
  ): void {
    if (!physxColliderDebug.isGltfCollidersVisible()) return
    if (this.loggedEntities.has(entity)) return
    this.loggedEntities.add(entity)

    const shapeCount = desc?.shapes?.length ?? 0
    const meshNames = collectMeshNames(gltfMesh)
    const invCount = desc?.shapes?.filter((s) => s.fingerprint.includes(':inv:')).length ?? 0
    clientDebugLog.log(
      'collision',
      `[GltfCollider] e${entity} src="${src}" invisibleMask=${invisibleMask} visibleMask=${visibleMask} → ${shapeCount} trimesh (${invCount} invisible _collider)${shapeCount === 0 ? ` meshes=[${meshNames.join(', ')}]` : ''}`,
      { alsoConsole: true, throttleKey: `gltf-collider:${entity}` }
    )
  }

  private syncDebugVisibility(): void {
    if (!physxColliderDebug.isGltfCollidersVisible()) {
      this.clearDebugMeshes()
      return
    }

    const descs = this.getPhysicsColliders()
    const fp = descs
      .flatMap((desc) => debugWireframeEntries(desc).map((e) => `${e.key}:${colliderPoseFp(e.matrix)}`))
      .join('|')
    if (fp === this.debugFingerprint && this.debugMeshes.size > 0) return

    this.debugFingerprint = fp
    this.rebuildDebugMeshes(descs)
  }

  private clearDebugMeshes(): void {
    for (const mesh of this.debugMeshes.values()) {
      mesh.geometry.dispose()
      ;(mesh.material as THREE.Material).dispose()
      this.debugRoot.remove(mesh)
    }
    this.debugMeshes.clear()
    this.debugRoot.visible = false
    this.debugFingerprint = ''
  }

  private rebuildDebugMeshes(descs: PhysicsColliderDesc[]): void {
    for (const mesh of this.debugMeshes.values()) {
      mesh.geometry.dispose()
      ;(mesh.material as THREE.Material).dispose()
      this.debugRoot.remove(mesh)
    }
    this.debugMeshes.clear()

    if (!physxColliderDebug.isGltfCollidersVisible() || descs.length === 0) {
      this.debugRoot.visible = false
      return
    }

    const matFor = (fingerprint: string) =>
      new THREE.MeshBasicMaterial({
        color: fingerprint.includes(':inv:') ? 0xff44ff : 0x00ffff,
        wireframe: true,
        transparent: true,
        opacity: fingerprint.includes(':inv:') ? 0.35 : 0.25,
        depthTest: false,
        depthWrite: false
      })

    for (const desc of descs) {
      for (const entry of debugWireframeEntries(desc)) {
        const geo = entry.geometry
          ? bakeTrimeshGeometry(entry.geometry, entry.matrix)
          : new THREE.BoxGeometry(1, 1, 1)
        const mesh = new THREE.Mesh(geo, matFor(entry.fingerprint))
        this.debugRoot.add(mesh)
        this.debugMeshes.set(entry.key, mesh)
      }
    }
    this.debugRoot.visible = true
  }

  private extractColliderDesc(
    entity: Entity,
    gltfRoot: THREE.Object3D,
    entityObj: THREE.Object3D,
    hasVisiblePhysics: boolean,
    hasInvisiblePhysics: boolean
  ): PhysicsColliderDesc | null {
    const colliderMeshes: THREE.Mesh[] = []
    gltfRoot.traverse((node) => {
      if (!(node instanceof THREE.Mesh)) return
      if (isGltfVisibleClassMesh(node)) {
        if (hasVisiblePhysics) colliderMeshes.push(node)
        return
      }
      if (isGltfInvisibleColliderMesh(node, gltfRoot) && hasInvisiblePhysics) {
        colliderMeshes.push(node)
      }
    })

    if (!colliderMeshes.length) return null

    entityObj.updateMatrixWorld(true)
    _entityInv.copy(entityObj.matrixWorld).invert()

    const shapes: PhysicsColliderShapeDesc[] = []

    for (const mesh of colliderMeshes) {
      mesh.updateMatrixWorld(true)

      const sourceGeo = mesh.geometry
      const posAttr = sourceGeo.getAttribute('position')
      if (!posAttr || posAttr.count < 3) continue

      _worldMatrix.copy(mesh.matrixWorld).premultiply(_entityInv)

      const fp = `gltf:${isGltfInvisibleColliderMesh(mesh, gltfRoot) ? 'inv' : 'vis'}:${entity}:${shapes.length}:${mesh.name}:${sourceGeo.uuid}`

      // Reference shared AssetCache geometry — PhysX cook clones via bakeTrimeshGeometry.
      shapes.push({
        fingerprint: fp,
        geometry: sourceGeo,
        localMatrix: _worldMatrix.clone()
      })
    }

    if (!shapes.length) return null

    const geomKey = shapes.map((s) => s.fingerprint).join('|')

    return {
      entity: GLTF_COLLIDER_ENTITY_BASE + entity,
      kind: 'gltf-multi',
      fingerprint: `gltf-entity:${entity}:${geomKey}`,
      matrix: entityObj.matrixWorld.clone(),
      shapes
    }
  }
}

function buildColliderDescs(
  searchRoot: THREE.Object3D,
  stopBefore: THREE.Object3D,
  fpPrefix: string
): PhysicsColliderDesc[] {
  const descs: PhysicsColliderDesc[] = []
  searchRoot.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) return
    if (!isGltfInvisibleColliderMesh(node, stopBefore)) return

    node.updateMatrixWorld(true)

    const geometry = node.geometry
    const posAttr = geometry.getAttribute('position')
    if (!posAttr || posAttr.count < 3) return

    const idx = descs.length
    descs.push({
      entity: LANDSCAPE_COLLIDER_ENTITY_BASE + idx,
      kind: 'geometry',
      fingerprint: `${fpPrefix}:inv:collider:${idx}:${node.name}:${geometry.uuid}`,
      matrix: node.matrixWorld.clone(),
      geometry
    })
  })
  return descs
}

type DebugWireframeEntry = {
  key: string
  fingerprint: string
  matrix: THREE.Matrix4
  geometry?: THREE.BufferGeometry
}

function debugWireframeEntries(desc: PhysicsColliderDesc): DebugWireframeEntry[] {
  if (desc.shapes?.length) {
    return desc.shapes.map((shape, i) => {
      _worldMatrix.copy(desc.matrix).multiply(shape.localMatrix)
      return {
        key: `${desc.entity}:${shape.fingerprint}:${i}`,
        fingerprint: shape.fingerprint,
        matrix: _worldMatrix.clone(),
        geometry: shape.geometry
      }
    })
  }

  return [
    {
      key: desc.fingerprint,
      fingerprint: desc.fingerprint,
      matrix: desc.matrix,
      geometry: desc.geometry
    }
  ]
}

function colliderPoseFp(matrix: THREE.Matrix4): string {
  return matrix.elements.map((n) => n.toFixed(3)).join(',')
}

export { colliderPoseFp }

function hasAnyInvisibleColliderMesh(gltfRoot: THREE.Object3D): boolean {
  let found = false
  gltfRoot.traverse((node) => {
    if (found || !(node instanceof THREE.Mesh)) return
    if (isGltfInvisibleColliderMesh(node, gltfRoot)) found = true
  })
  return found
}

function collectMeshNames(root: THREE.Object3D): string[] {
  const names: string[] = []
  root.traverse((node) => {
    if (node instanceof THREE.Mesh) names.push(node.name || '(unnamed)')
  })
  return names.slice(0, 24)
}
