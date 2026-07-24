import * as THREE from 'three'
import { parseParcelKey } from '../dcl/content/parseParcel'
import { PARCEL_SIZE } from '../dcl/content/types'
import { isSceneParcel, parcelKey } from '../dcl/landscape/Utils/ParcelGrid'
import { parcelWorldOrigin } from '../dcl/landscape/Utils/SceneSpace'
import { physxColliderDebug } from '../debug/PhysxColliderDebug'
import { platformMotionDebug } from '../debug/PlatformMotionDebug'
import { clientDebugLog } from '../client/debug/ClientDebugLog'
import { extendThreePhysX } from './extendThreePhysX'
import { CAMERA_QUERY_MASK, Layers, TRIGGER_QUERY_MASK } from './Layers'
import { geometryToPxMesh, type PxMeshHandle } from './geometryToPxMesh'
import { bakeTrimeshGeometry, isTrimeshGeometryCookable } from './bakeTrimeshGeometry'
import { bootColliderCookSignature, entityLocalColliderCookSignature } from './physxCookBake'
import { ensureIndexedForCook } from './colliderGeometryPrep'
import { loadPhysX } from './loadPhysX'
import { isSignificantPlatformDelta, MAX_RIDING_DELTA_HORIZ } from './platformMotion'
import {
  ROAD_AOI_COLLIDER_ENTITY_BASE,
  ROAD_AOI_COLLIDER_ID_SPAN
} from '../dcl/aoi/roadTiles'

export type PhysicsColliderShapeDesc = {
  fingerprint: string
  geometry?: THREE.BufferGeometry
  /** Shape pose relative to the actor root (`PhysicsColliderDesc.matrix`). */
  localMatrix: THREE.Matrix4
}

/** SDK TriggerArea volume pose — unit box/sphere scaled by entity world matrix. */
export type TriggerVolumeDesc = {
  entity: number
  mesh: number
  matrix: THREE.Matrix4
}

export type PhysicsColliderDesc = {
  entity: number
  kind: string
  /** Geometry-only fingerprint — stable when only pose changes. */
  fingerprint: string
  /** Actor root world pose. */
  matrix: THREE.Matrix4
  /** Single-shape path — world-baked trimesh or primitives. */
  geometry?: THREE.BufferGeometry
  /** Multi-shape GLTF path — local geometry + per-shape local pose (Hyperfy pattern). */
  shapes?: PhysicsColliderShapeDesc[]
}

/** Min normal.y to count as walkable floor on CCT shape hits (steep wall bases are ignored). */
const WALKABLE_NORMAL_Y = 0.55

/** Unity CharacterController defaults — DCL Foundation uses PhysX CCT with similar tuning. */
const DEG2RAD = Math.PI / 180
const CONTROLLER_SLOPE_LIMIT_DEG = 45
const CONTROLLER_STEP_OFFSET = 0.45
const CONTROLLER_CONTACT_OFFSET = 0.08
/** Descending platform overhead — max gap from feet to walk surface to start transfer (≈ capsule). */
const PLATFORM_OVERHEAD_CATCH = 1.88 + CONTROLLER_STEP_OFFSET + 0.35
/** Per-frame platform Δ sanity — rejects collider pose glitches (walk surface jumping to far global bbox). */
const MAX_PLATFORM_DELTA_HORIZ = 1.25
const MAX_PLATFORM_DELTA_TOTAL = 2.5
/** Ground-contact tread must stay under the capsule column — not a distant shape on the same actor. */
/** Locomotion — tight column avoids grabbing distant elevator treads for platform Δ. */
const MAX_GROUND_CONTACT_HORIZ = 2
/** Tread Y must not jump more than this vs baseline (duplicate mesh at lift bottom). */
const MAX_GROUND_CONTACT_VERT = 1.5
/** Always-on floor at y=0 — large thick static box (PxPlane is unsupported by CCT/sweep queries), no render mesh. */
const INFINITE_GROUND_ENTITY = -1
const INFINITE_GROUND_FINGERPRINT = 'infinite-ground-plane'
/** Half-extent of the ground box in X/Z — effectively "infinite" for genesis multi-parcel. */
const GROUND_BOX_HALF_EXTENT = 5000
/**
 * Half-thickness; box centred at y=-halfHeight so its top face sits exactly at y=0.
 * Thick enough that heavy-load frames (delta clamped ~0.1s, GRAVITY 20) cannot tunnel.
 */
const GROUND_BOX_HALF_HEIGHT = 2.5
/** Max vertical displacement per CCT substep — avoids tunneling when FPS tanks. */
const CCT_MAX_VERTICAL_STEP_M = 0.35
/**
 * Max horizontal displacement per CCT substep.
 * Remote avatar compose can drop plaza to 2–6fps; 0.35m × 8 steps only covers ~2.8m/frame
 * and tunnels thin walls. Tighter steps + higher cap keep CCT solid under remotes.
 */
const CCT_MAX_HORIZONTAL_STEP_M = 0.2
const CCT_MAX_SUBSTEPS = 24
/** Absolute floor — if CCT still reports feet below this, snap up and force grounded. */
const HARD_FLOOR_Y = 0
/**
 * Authored spawn points usually sit ON the walk surface. Creating the CCT with feet
 * exactly there (or slightly inside a trimesh) embeds the capsule. Lift clear, then
 * drop a short distance only — never freefall (Flagtag tower: long settle punched
 * through missing/thin floors into water ~y=48).
 */
const SPAWN_FEET_CLEARANCE_M = 0.12
/**
 * Max feet drop during a single CCT settle pass (metres). Keep modest so thin
 * tower floors are not punched through; probe-first path lands near the deck.
 */
const SPAWN_SETTLE_MAX_DROP_M = 1.35
/** When a probe already found the deck, allow a slightly longer CCT drop (thin/step meshes). */
const SPAWN_SETTLE_PROBE_DROP_M = 2.6
/** Elevated decks only: allow a longer CCT drop when probe misses but floor is below. */
const SPAWN_SETTLE_ELEVATED_MAX_DROP_M = 5.5
/**
 * Sweep search under authored feet when CCT settle fails.
 * Flagtag tower: deck may sit slightly below spawn or only exist at nearby XZ samples.
 */
const SPAWN_PROBE_MAX_DROP_M = 8
/** Elevated authored spawn: search farther under feet (still gated by accept band). */
const SPAWN_PROBE_ELEVATED_MAX_DROP_M = 12
/**
 * Accept settled feet only within this band of authored spawn Y.
 * Reject roof/arch false-grounds (Flagtag upper shell) and deep freefall hits.
 */
const SPAWN_ACCEPT_ABOVE_AUTHORED_M = 0.55
const SPAWN_ACCEPT_BELOW_AUTHORED_M = 6.5
/** XZ offsets for multi-sample floor probe (deck edge / range spawn). */
const SPAWN_PROBE_XZ_OFFSETS_M: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [0.65, 0],
  [-0.65, 0],
  [0, 0.65],
  [0, -0.65],
  [0.9, 0.9],
  [-0.9, 0.9],
  [0.9, -0.9],
  [-0.9, -0.9]
]
const SPAWN_SETTLE_DT = 1 / 30
const SPAWN_SETTLE_GRAVITY = 20

/** Shared with World spawn-floor wait so probe/CCT use the same deck band. */
export function isPlausibleSpawnSurfaceY(surfaceY: number, authoredFeetY: number): boolean {
  return (
    surfaceY <= authoredFeetY + SPAWN_ACCEPT_ABOVE_AUTHORED_M &&
    surfaceY >= authoredFeetY - SPAWN_ACCEPT_BELOW_AUTHORED_M
  )
}

export type ControllerMoveResult = {
  grounded: boolean
}

/** Minimal PhysX world — static scene colliders + player character controller. */
export class PhysXWorld {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private scene: any = null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private physics: any = null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private defaultMaterial: any = null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private tolerances: any = null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private cookingParams: any = null

  private readonly pmeshHandles = new Map<number, PxMeshHandle[]>()

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private sweepPose: any = null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private sweepResult: any = null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private queryFilterData: any = null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _pv2: any = null

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private cameraSweepGeometry: any = null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private playerCapsuleOverlapGeometry: any = null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private overlapPose: any = null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private overlapResult: any = null
  /** Reused pose scratch — avoid per-slide PxTransform allocations (WASM heap pressure). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private actorPoseTransform: any = null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private shapeLocalPoseTransform: any = null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private shapePtrBuffer: any = null
  private shapePtrBufferCapacity = 0

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly staticActors = new Map<number, any>()
  /** Reverse lookup — platform transfer + CCT grounding probes. */
  private readonly staticEntityByActorPtr = new Map<number, number>()
  /** Last descriptor world position per PhysX entity — tweened platform delta tracking. */
  private readonly colliderLastWorldPos = new Map<number, THREE.Vector3>()
  /**
   * Riding transfer Δ — ONLY the CCT-grounded actor this frame (see platformMotion.ts).
   * Populated from actor-root / PhysX-bounds / ground-contact, never scene-wide mesh bbox.
   */
  private readonly platformMotionDelta = new Map<number, THREE.Vector3>()
  /** Actor-root Δ for every transform that moved — head-crush / overhead catch only. */
  private readonly poseMotionDelta = new Map<number, THREE.Vector3>()
  /** CCT-grounded PhysX entity at frame start — gates riding transfer recording. */
  private platformMotionScopeEntity: number | null = null
  private readonly platformTransferDisp = new THREE.Vector3()
  /** Platform we are riding — always the grounded actor when transfer applies. */
  private standingPlatformEntity: number | null = null
  /** Last walkable PhysX actor under the feet — from CCT onShapeHit during move(). */
  private lastGroundPhysEntity: number | null = null
  private lastCctShapeContact: { entity: number; point: THREE.Vector3 } | null = null
  private pendingCctGroundEntity: number | null = null
  private pendingCctGroundY = Number.NEGATIVE_INFINITY
  private pendingCctGroundContact: { entity: number; point: THREE.Vector3 } | null = null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private controllerHitReport: any = null
  /** Bbox-top walk-surface positions — transfer matching uses XZ under soles, not entity pivots. */
  private readonly platformWalkSurfacePos = new Map<number, THREE.Vector3>()
  /** Frame-start GLTF shape tread tops — authoritative vs PhysX pose slides after refreshColliderDescPoses. */
  private readonly gltfWalkSurfaceSnapshot = new Map<number, THREE.Vector3>()
  /**
   * PhysX tread contact under soles at frame start — Unity/DCL rides the hit point, not bbox centers.
   * Sampled again after pose slides; Δ goes to platformMotionDelta for the grounded actor.
   */
  private groundContactBaseline: { entity: number; point: THREE.Vector3 } | null = null

  /** Frame-start actor root world positions — reliable lift Δ when tread probes desync. */
  private readonly actorRootPoseSnapshot = new Map<number, THREE.Vector3>()
  /** Brief fallback when tread/PhysX probes glitch but the player is still grounded on a lift. */
  private readonly stickyPlatformDelta = new Map<number, { delta: THREE.Vector3; framesLeft: number }>()
  /** Frame-start PhysX actor AABB tread top — authoritative vs raycast duplicate treads. */
  private readonly physxActorSurfaceSnapshot = new Map<number, THREE.Vector3>()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly triggerActors = new Map<number, any>()
  private readonly triggerFp = new Map<number, string>()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly triggerEntityByActorPtr = new Map<number, number>()
  private readonly staticFp = new Map<number, string>()
  /** Last applied world matrix fingerprint for pose-driven trimesh actors. */
  private readonly staticPoseFp = new Map<number, string>()
  /** World-space baked trimesh — actor stays at origin; never apply setGlobalPose. */
  private readonly actorWorldBaked = new Map<number, boolean>()
  /**
   * Kinematic rigid dynamics (Animator doors / PART movers). Geometry cooked once entity-local;
   * pose updated each frame — never live-re-bake statics.
   */
  private readonly actorIsKinematic = new Set<number>()
  /**
   * Cook-time shape local matrices — Animator slides use current * baseline⁻¹ as shape pose.
   * Geometry bakes full entityScale × localMatrix into verts (scale and placement do not commute,
   * so absolute shape-pose mode is invalid for DCL Transform.scale and softed plaza).
   */
  private readonly shapeBaselineLocal = new Map<number, THREE.Matrix4[]>()
  /**
   * Entity world scale baked into entity-local verts at cook time.
   * Pose slides only move T+R — scale drift must force recook or colliders stay unit-sized.
   */
  private readonly actorCookScale = new Map<number, THREE.Vector3>()
  /** Fingerprints whose trimesh cook failed — skip retry until fingerprint changes. */
  private readonly failedCookFp = new Set<string>()
  private readonly loggedFailedCookFp = new Set<string>()
  private landscapeFp = ''
  /**
   * After collider seal, zero-dt `scene.simulate(0)` during geometry warm can corrupt PhysX WASM
   * when concurrent pose slides run on large scenes (see refreshStaticColliderQueries comment).
   * Boot/seal may still use full warm; runtime only invalidates the CCT obstacle cache.
   */
  private allowZeroDtWarmSim = true

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private controllerManager: any = null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private controllerFilters: any = null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private controller: any = null
  /**
   * PhysX CCT capsule — full height including hemispherical caps (metres).
   * Matches typical DCL body scale (~1.88 m); previously 1.6 m felt short vs avatar mesh.
   */
  private capsuleRadius = 0.3
  private capsuleHeight = 1.88
  private capsuleDebugGroup: THREE.Group | null = null
  private readonly unsubscribeDebug: () => void

  private readonly position = new THREE.Vector3()
  private readonly quaternion = new THREE.Quaternion()

  private readonly _pos = new THREE.Vector3()
  private readonly _quat = new THREE.Quaternion()
  private readonly _scale = new THREE.Vector3()
  private readonly _v1 = new THREE.Vector3()
  private readonly _worldMatrix = new THREE.Matrix4()
  private readonly _shapeRel = new THREE.Matrix4()
  private readonly _shapeBBox = new THREE.Box3()
  /** Entity-local bake: world scale only (actor carries translation/rotation). */
  private readonly _entityScaleMat = new THREE.Matrix4()
  private readonly _entityLocalBake = new THREE.Matrix4()
  private readonly _identityQuat = new THREE.Quaternion()


  constructor() {
    this.unsubscribeDebug = physxColliderDebug.subscribe(() => this.syncCapsuleDebugVisibility())
  }

  dispose(): void {
    this.unsubscribeDebug()
    this.releasePlayer()

    this.controllerManager?.release()
    this.controllerManager = null
    this.controllerFilters = null

    for (const entity of [...this.staticActors.keys()]) {
      try {
        this.removeStatic(entity)
      } catch (err) {
        console.warn('[PhysXWorld] dispose removeStatic failed:', entity, err)
      }
    }
    for (const entity of [...this.triggerActors.keys()]) {
      try {
        this.removeTriggerVolume(entity)
      } catch (err) {
        console.warn('[PhysXWorld] dispose removeTriggerVolume failed:', entity, err)
      }
    }

    try {
      this.cameraSweepGeometry?.release?.()
    } catch {
      // ignore
    }
    try {
      this.playerCapsuleOverlapGeometry?.release?.()
    } catch {
      // ignore
    }
    this.cameraSweepGeometry = null
    this.playerCapsuleOverlapGeometry = null
    this.overlapPose = null
    this.overlapResult = null

    try {
      this.scene?.release?.()
    } catch (err) {
      console.warn('[PhysXWorld] scene release failed', err)
    }
    this.scene = null

    try {
      this.defaultMaterial?.release?.()
    } catch {
      // ignore
    }
    this.defaultMaterial = null

    try {
      if (this.cookingParams) PHYSX.destroy(this.cookingParams)
    } catch {
      // ignore
    }
    this.cookingParams = null

    try {
      if (this.tolerances) PHYSX.destroy(this.tolerances)
    } catch {
      // ignore
    }
    this.tolerances = null

    try {
      this.physics?.release?.()
    } catch (err) {
      console.warn('[PhysXWorld] physics release failed', err)
    }
    this.physics = null

    this.staticFp.clear()
    this.staticPoseFp.clear()
    this.failedCookFp.clear()
    this.loggedFailedCookFp.clear()
    this.landscapeFp = ''

    if (this.capsuleDebugGroup) {
      this.capsuleDebugGroup.traverse((child) => {
        if (!(child instanceof THREE.Mesh)) return
        child.geometry.dispose()
        ;(child.material as THREE.Material).dispose()
      })
      this.capsuleDebugGroup.removeFromParent()
      this.capsuleDebugGroup = null
    }
  }

  private releasePlayer(): void {
    this.controller?.release()
    this.controller = null
  }

  /**
   * Temporary CCT at `position` — settle onto authored floor, then destroy controller.
   * Used to gate visual avatar spawn until tower decks actually block the capsule.
   * @returns grounded feet world position, or null if settle failed.
   */
  trySettleAtPosition(position: THREE.Vector3, authoredFeetY: number): THREE.Vector3 | null {
    this.spawnPlayer(position)
    this.warmStaticScene()
    const settled = this.settleSpawnOntoFloor(authoredFeetY)
    if (!settled) {
      this.releasePlayer()
      return null
    }
    const feet = this.positionOut.clone()
    this.releasePlayer()
    return feet
  }

  /** Wireframe pill matching the local player PhysX capsule. */
  attachCapsuleDebug(parent: THREE.Object3D): void {
    if (this.capsuleDebugGroup) return

    const radius = this.capsuleRadius
    const halfHeight = (this.capsuleHeight - radius - radius) / 2
    const mesh = new THREE.Mesh(
      new THREE.CapsuleGeometry(radius, halfHeight * 2, 4, 12),
      new THREE.MeshBasicMaterial({
        color: 0xff44aa,
        wireframe: true,
        transparent: true,
        opacity: 0.55,
        depthTest: false,
        depthWrite: false
      })
    )
    mesh.position.y = halfHeight + radius

    this.capsuleDebugGroup = new THREE.Group()
    this.capsuleDebugGroup.name = 'player-capsule-debug'
    this.capsuleDebugGroup.add(mesh)
    this.capsuleDebugGroup.visible = false
    parent.add(this.capsuleDebugGroup)
    this.syncCapsuleDebugVisibility()
  }

  syncCapsuleDebugTransform(): void {
    if (!this.capsuleDebugGroup?.visible) return
    // Parent player root already tracks PhysX position — keep debug group at local origin.
    this.capsuleDebugGroup.position.set(0, 0, 0)
  }

  private syncCapsuleDebugVisibility(): void {
    if (!this.capsuleDebugGroup) return
    this.capsuleDebugGroup.visible = physxColliderDebug.isLocalPlayerCapsuleVisible()
    if (this.capsuleDebugGroup.visible) {
      this.syncCapsuleDebugTransform()
    }
  }

  async init(): Promise<void> {
    const info = await loadPhysX()
    extendThreePhysX()

    this.tolerances = new PHYSX.PxTolerancesScale()
    this.cookingParams = new PHYSX.PxCookingParams(this.tolerances)
    this.physics = PHYSX.CreatePhysics(info.version, info.foundation, this.tolerances)
    PHYSX.PxTopLevelFunctions.prototype.InitExtensions(this.physics)
    this.defaultMaterial = this.physics.createMaterial(0.2, 0.2, 0.2)

    const sceneDesc = new PHYSX.PxSceneDesc(this.tolerances)
    sceneDesc.gravity = new PHYSX.PxVec3(0, -9.81, 0)
    sceneDesc.cpuDispatcher = PHYSX.DefaultCpuDispatcherCreate(0)
    sceneDesc.filterShader = PHYSX.DefaultFilterShader()
    sceneDesc.flags.raise(PHYSX.PxSceneFlagEnum.eENABLE_CCD, true)
    sceneDesc.flags.raise(PHYSX.PxSceneFlagEnum.eENABLE_ACTIVE_ACTORS, true)
    sceneDesc.solverType = PHYSX.PxSolverTypeEnum.eTGS
    // eSAP — default sweep-and-prune; works for multi-parcel scenes without MBP region setup.
    // eMBP drops actors outside PxBroadPhase regions → "out of broadphase bounds" + fall-through.
    sceneDesc.broadPhaseType = PHYSX.PxBroadPhaseTypeEnum.eSAP
    this.scene = this.physics.createScene(sceneDesc)

    this.sweepPose = new PHYSX.PxTransform(PHYSX.PxIDENTITYEnum.PxIdentity)
    this.sweepResult = new PHYSX.PxSweepResult()
    this.queryFilterData = new PHYSX.PxQueryFilterData()
    this._pv2 = new PHYSX.PxVec3()
    const capsuleHalfHeight = (this.capsuleHeight - this.capsuleRadius * 2) / 2
    this.playerCapsuleOverlapGeometry = new PHYSX.PxCapsuleGeometry(this.capsuleRadius, capsuleHalfHeight)
    this.overlapPose = new PHYSX.PxTransform(PHYSX.PxIDENTITYEnum.PxIdentity)
    this.overlapResult = new PHYSX.PxOverlapResult()
    this.actorPoseTransform = new PHYSX.PxTransform(PHYSX.PxIDENTITYEnum.PxIdentity)
    this.shapeLocalPoseTransform = new PHYSX.PxTransform(PHYSX.PxIDENTITYEnum.PxIdentity)

    this.setupControllerManager()
    this.ensureInfiniteGroundPlane()
  }

  /**
   * Scene-agnostic ground at y=0 — highest priority collider, never removed when
   * landscape/walls/GLTF refresh. Idempotent; re-creates if the actor map lost it.
   */
  ensureInfiniteGroundPlane(): void {
    if (!this.physics || !this.scene) return
    if (this.staticActors.has(INFINITE_GROUND_ENTITY)) return

    // Large BOX with top face at y=0 — NOT a PxPlane. PhysX CCT + sweep/overlap queries
    // do not support PxPlaneGeometry (player never grounds / falls forever).
    const halfY = GROUND_BOX_HALF_HEIGHT
    const geometry = new PHYSX.PxBoxGeometry(GROUND_BOX_HALF_EXTENT, halfY, GROUND_BOX_HALF_EXTENT)
    const shapeFlags = new PHYSX.PxShapeFlags(
      PHYSX.PxShapeFlagEnum.eSCENE_QUERY_SHAPE | PHYSX.PxShapeFlagEnum.eSIMULATION_SHAPE
    )
    const shape = this.physics.createShape(geometry, this.defaultMaterial, true, shapeFlags)
    PHYSX.destroy(geometry)

    const filterData = new PHYSX.PxFilterData(Layers.environment.group, Layers.environment.mask, 0, 0)
    shape.setQueryFilterData(filterData)
    shape.setSimulationFilterData(filterData)

    const transform = new PHYSX.PxTransform(PHYSX.PxIDENTITYEnum.PxIdentity)
    this._pos.set(0, -halfY, 0)
    this._quat.set(0, 0, 0, 1)
    this._pos.toPxTransform(transform)
    this._quat.toPxTransform(transform)

    const actor = this.physics.createRigidStatic(transform)
    actor.attachShape(shape)
    this.scene.addActor(actor)
    this.staticActors.set(INFINITE_GROUND_ENTITY, actor)
    this.registerStaticActor(INFINITE_GROUND_ENTITY, actor)
    this.staticFp.set(INFINITE_GROUND_ENTITY, INFINITE_GROUND_FINGERPRINT)
    console.info('[PhysXWorld] infinite ground plane ready (y=0 top face)')
  }

  /**
   * Diagnostic — static actors near feet: floors vs tall walls, infinite ground note.
   * Always mirrors to DevTools (`[phys]`) so invisible walls are diagnosable.
   */
  logStaticCollidersNear(x: number, y: number, z: number, radius = 12, label = 'probe'): void {
    type Hit = {
      entity: number
      minX: number
      maxX: number
      minY: number
      maxY: number
      minZ: number
      maxZ: number
      kind: 'floor' | 'wall' | 'slab' | 'other'
    }
    const hits: Hit[] = []
    let hasInfiniteGround = this.staticActors.has(INFINITE_GROUND_ENTITY)
    for (const [entity, actor] of this.staticActors) {
      if (entity === INFINITE_GROUND_ENTITY) continue
      if (typeof actor.getWorldBounds !== 'function') continue
      let bounds: {
        get_minimum(): { x: number; y: number; z: number }
        get_maximum(): { x: number; y: number; z: number }
      }
      try {
        bounds = actor.getWorldBounds()
      } catch {
        continue
      }
      const min = bounds.get_minimum()
      const max = bounds.get_maximum()
      if (!min || !max) continue
      if (max.x < x - radius || min.x > x + radius) continue
      if (max.z < z - radius || min.z > z + radius) continue
      const h = max.y - min.y
      const w = Math.max(max.x - min.x, max.z - min.z)
      // Feet band: collider spans player mid-height → wall-like; flat top near feet → floor.
      const spansFeetY = min.y < y + 1.2 && max.y > y + 0.2
      const topNearFeet = Math.abs(max.y - y) < 2.5
      let kind: Hit['kind'] = 'other'
      if (spansFeetY && h > 2.5 && h > w * 0.35) kind = 'wall'
      else if (topNearFeet && h < 3) kind = 'floor'
      else if (topNearFeet) kind = 'slab'
      hits.push({
        entity: entity as number,
        minX: min.x,
        maxX: max.x,
        minY: min.y,
        maxY: max.y,
        minZ: min.z,
        maxZ: max.z,
        kind
      })
    }
    hits.sort((a, b) => {
      const order = { wall: 0, floor: 1, slab: 2, other: 3 }
      return order[a.kind] - order[b.kind]
    })
    const walls = hits.filter((h) => h.kind === 'wall').length
    const floors = hits.filter((h) => h.kind === 'floor' || h.kind === 'slab').length
    /** Decode GLTF_COLLIDER_ENTITY_BASE (20_000_000) + ecs entity for readable logs. */
    const fmtEnt = (e: number) =>
      e >= 20_000_000 ? `gltf:e${e - 20_000_000}` : e === INFINITE_GROUND_ENTITY ? 'ground' : `e${e}`
    const samples = hits
      .slice(0, 6)
      .map(
        (h) =>
          `${h.kind}:${fmtEnt(h.entity)} y=[${h.minY.toFixed(1)}..${h.maxY.toFixed(1)}] ` +
          `xz=(${h.minX.toFixed(0)}..${h.maxX.toFixed(0)},${h.minZ.toFixed(0)}..${h.maxZ.toFixed(0)})`
      )
      .join(' · ')
    const msg =
      `${label} feet=(${x.toFixed(1)},${y.toFixed(1)},${z.toFixed(1)}) r=${radius} ` +
      `static=${hits.length} walls≈${walls} floors≈${floors}` +
      (hasInfiniteGround ? ' groundPlane=y0' : ' groundPlane=MISSING') +
      (samples ? ` · ${samples}` : ' · (no nearby statics)')
    console.info(`[phys] ${msg}`)
    clientDebugLog.log('player', msg, { alsoConsole: false, level: 'info' })
  }

  private setupControllerManager(): void {
    this.controllerManager = PHYSX.PxTopLevelFunctions.prototype.CreateControllerManager(this.scene)
    this.controllerFilters = new PHYSX.PxControllerFilters()
    this.controllerFilters.mFilterData = new PHYSX.PxFilterData(Layers.player.group, Layers.player.mask, 0, 0)
    // eSTATIC/eDYNAMIC — hit scene colliders. ePREFILTER — invoke bilateral layer callback below.
    this.controllerFilters.mFilterFlags = new PHYSX.PxQueryFlags(
      PHYSX.PxQueryFlagEnum.eSTATIC |
        PHYSX.PxQueryFlagEnum.eDYNAMIC |
        PHYSX.PxQueryFlagEnum.ePREFILTER
    )

    const cctFilterCallback = new PHYSX.PxControllerFilterCallbackImpl()
    cctFilterCallback.filter = () => true
    this.controllerFilters.mCCTFilterCallback = cctFilterCallback

    // CCT move() uses scene queries — must return eBLOCK or the capsule passes through static trimesh.
    // PhysX preFilter signature: (const PxFilterData& filterData, const PxShape* shape, …)
    // — first arg is PxFilterData, not PxQueryFilterData (word0/word1 live at the pointer root).
    const envMask =
      Layers.environment.group | Layers.prop.group | Layers.gltfCollider.group
    const filterCallback = new PHYSX.PxQueryFilterCallbackImpl()
    filterCallback.simplePreFilter = (
      filterDataPtr: number,
      shapePtr: number,
      _actorPtr?: number,
      _queryFlags?: number
    ) => {
      try {
        const filterData = PHYSX.wrapPointer(filterDataPtr, PHYSX.PxFilterData)
        const shape = PHYSX.wrapPointer(shapePtr, PHYSX.PxShape)
        const shapeFilterData = shape.getQueryFilterData()
        const q0 = filterData.word0 >>> 0
        const q1 = filterData.word1 >>> 0
        const s0 = shapeFilterData.word0 >>> 0
        const s1 = shapeFilterData.word1 >>> 0
        if ((q0 & s1) !== 0 && (s0 & q1) !== 0) {
          return PHYSX.PxQueryHitType.eBLOCK
        }
        // Wrap/layout failure (all-zero query words) — still block solid scene layers so
        // plaza walls never become ghost geometry. Triggers stay out of envMask.
        if (q0 === 0 && q1 === 0 && (s0 & envMask) !== 0) {
          return PHYSX.PxQueryHitType.eBLOCK
        }
        return PHYSX.PxQueryHitType.eNONE
      } catch {
        return PHYSX.PxQueryHitType.eBLOCK
      }
    }
    filterCallback.simplePostFilter = () => PHYSX.PxQueryHitType.eBLOCK
    this.controllerFilters.mFilterCallback = filterCallback
  }

  spawnPlayer(position: THREE.Vector3): void {
    if (!this.physics || !this.scene || !this.controllerManager) {
      throw new Error('PhysXWorld not initialised')
    }

    // Ground before capsule — heavy scenes must never spawn into empty air with no floor.
    this.ensureInfiniteGroundPlane()
    this.releasePlayer()

    const radius = this.capsuleRadius
    const controllerHeight = this.capsuleHeight - radius * 2

    const desc = new PHYSX.PxCapsuleControllerDesc()
    desc.setToDefault()
    desc.height = controllerHeight
    desc.radius = radius
    desc.climbingMode = PHYSX.PxCapsuleClimbingModeEnum.eCONSTRAINED
    desc.slopeLimit = Math.cos(CONTROLLER_SLOPE_LIMIT_DEG * DEG2RAD)
    desc.stepOffset = CONTROLLER_STEP_OFFSET
    desc.contactOffset = CONTROLLER_CONTACT_OFFSET
    desc.material = this.defaultMaterial
    desc.upDirection = new PHYSX.PxVec3(0, 1, 0)

    if (!this.controllerHitReport) {
      const report = new PHYSX.PxUserControllerHitReportImpl()
      // Emscripten JSImpl passes a raw pointer — must wrap before calling PhysX methods.
      report.onShapeHit = (hitPtr: number) => {
        const hit =
          typeof hitPtr === 'number'
            ? PHYSX.wrapPointer(hitPtr, PHYSX.PxControllerShapeHit)
            : hitPtr
        this.recordCctShapeHit(hit)
      }
      report.onControllerHit = () => {}
      report.onObstacleHit = () => {}
      this.controllerHitReport = report
    }
    desc.reportCallback = this.controllerHitReport

    this.controller = this.controllerManager.createController(desc)
    PHYSX.destroy(desc)

    const actor = this.controller.getActor()
    const nbShapes = actor.getNbShapes()
    const shapeBuffer = new PHYSX.PxArray_PxShapePtr(nbShapes)
    const shapesCount = actor.getShapes(shapeBuffer.begin(), nbShapes, 0)
    const filterData = new PHYSX.PxFilterData(
      Layers.player.group,
      Layers.player.mask,
      PHYSX.PxPairFlagEnum.eNOTIFY_TOUCH_FOUND | PHYSX.PxPairFlagEnum.eSOLVE_CONTACT,
      0
    )
    // Simulation-only: the player capsule must NOT be a scene-query shape, or camera
    // sweeps and trigger overlap queries self-hit the CCT geometry.
    const shapeFlags = new PHYSX.PxShapeFlags(PHYSX.PxShapeFlagEnum.eSIMULATION_SHAPE)
    for (let i = 0; i < shapesCount; i++) {
      const shape = shapeBuffer.get(i)
      shape.setFlags(shapeFlags)
      shape.setQueryFilterData(filterData)
      shape.setSimulationFilterData(filterData)
    }

    // Start above the walk surface so the CCT is never born inside floor geometry.
    this._v1.set(position.x, position.y + SPAWN_FEET_CLEARANCE_M, position.z)
    this.controller.setFootPosition(this._v1.toPxExtVec3())
    this.syncPlayerTransform()
    this.invalidateControllerCache()
  }

  /**
   * Nudge the capsule onto a walk surface after statics are registered.
   * Call after `warmStaticScene()` / collider seal.
   *
   * 1) Scene sweep nearest authored Y (deck — not roof)
   * 2) Short CCT drop from that surface
   * 3) Short CCT drop from authored lift
   * 4) Elevated only: longer CCT drop from lift
   *
   * Only returns true on real CCT ground contact inside the authored band.
   * Never soft-accepts a floating Y (that caused Flagtag hover + dip on move).
   *
   * @param authoredFeetY — scene.json spawn feet Y (Three/world space)
   * @returns true if CCT reported ground contact on a plausible surface
   */
  settleSpawnOntoFloor(authoredFeetY: number): boolean {
    if (!this.controller) return false
    const liftY = authoredFeetY + SPAWN_FEET_CLEARANCE_M
    const feetX = this.position.x
    const feetZ = this.position.z
    // Dedicated vector — movePlayer mutates `_v1` as stepDisp; must not alias.
    const drop = new THREE.Vector3()

    const tryCctDropFrom = (startY: number, maxDrop: number): boolean => {
      this._v1.set(feetX, startY, feetZ)
      this.teleport(this._v1)
      this.invalidateControllerCache()
      this.warmStaticScene()
      const dropFloorY = startY - maxDrop
      const maxSteps = Math.ceil(maxDrop / (SPAWN_SETTLE_GRAVITY * SPAWN_SETTLE_DT)) + 2
      for (let i = 0; i < maxSteps; i++) {
        if (this.position.y <= dropFloorY) break
        drop.set(0, -SPAWN_SETTLE_GRAVITY * SPAWN_SETTLE_DT, 0)
        const result = this.movePlayer(drop, SPAWN_SETTLE_DT)
        if (!result.grounded) continue
        if (isPlausibleSpawnSurfaceY(this.position.y, authoredFeetY)) {
          this.invalidateControllerCache()
          return true
        }
        clientDebugLog.log(
          'player',
          `spawn settle reject CCT ground y=${this.position.y.toFixed(2)} (authored ${authoredFeetY.toFixed(2)}) — likely roof/arch`,
          { alsoConsole: true, level: 'warn' }
        )
        return false
      }
      return false
    }

    // Prefer surface nearest authored Y (deck), not absolute highest hit (roofs).
    const probeDrop =
      authoredFeetY > 8 ? SPAWN_PROBE_ELEVATED_MAX_DROP_M : SPAWN_PROBE_MAX_DROP_M
    const probed = this.probeWalkSurfaceFeetY(
      feetX,
      feetZ,
      liftY + 0.4,
      probeDrop,
      authoredFeetY
    )

    if (probed != null && isPlausibleSpawnSurfaceY(probed, authoredFeetY)) {
      if (tryCctDropFrom(probed + SPAWN_FEET_CLEARANCE_M, SPAWN_SETTLE_MAX_DROP_M)) {
        clientDebugLog.log(
          'player',
          `spawn settle probe+CCT — feet y=${this.position.y.toFixed(2)} (authored ${authoredFeetY.toFixed(2)}, probe ${probed.toFixed(2)})`,
          { alsoConsole: true, level: 'info' }
        )
        return true
      }
      // Probe found the deck but short drop missed (thin step / first-frame contact).
      if (tryCctDropFrom(probed + SPAWN_FEET_CLEARANCE_M, SPAWN_SETTLE_PROBE_DROP_M)) {
        clientDebugLog.log(
          'player',
          `spawn settle probe+CCT long — feet y=${this.position.y.toFixed(2)} (authored ${authoredFeetY.toFixed(2)}, probe ${probed.toFixed(2)})`,
          { alsoConsole: true, level: 'info' }
        )
        return true
      }
    }

    if (tryCctDropFrom(liftY, SPAWN_SETTLE_MAX_DROP_M)) {
      clientDebugLog.log(
        'player',
        `spawn settle lift+CCT — feet y=${this.position.y.toFixed(2)} (authored ${authoredFeetY.toFixed(2)})`,
        { alsoConsole: true, level: 'info' }
      )
      return true
    }

    if (authoredFeetY > 8 && tryCctDropFrom(liftY, SPAWN_SETTLE_ELEVATED_MAX_DROP_M)) {
      clientDebugLog.log(
        'player',
        `spawn settle elevated drop — feet y=${this.position.y.toFixed(2)} (authored ${authoredFeetY.toFixed(2)})`,
        { alsoConsole: true, level: 'info' }
      )
      return true
    }

    // Best-effort place near probe for next wait/re-probe — do NOT claim grounded.
    const restoreY =
      probed != null && isPlausibleSpawnSurfaceY(probed, authoredFeetY)
        ? probed + SPAWN_FEET_CLEARANCE_M * 0.5
        : liftY
    this._v1.set(feetX, restoreY, feetZ)
    this.teleport(this._v1)
    this.invalidateControllerCache()
    clientDebugLog.log(
      'player',
      `spawn settle pending — no CCT ground near y=${authoredFeetY.toFixed(2)}; parked y=${restoreY.toFixed(2)}` +
        (probed != null ? ` probe=${probed.toFixed(2)}` : ' probe=none'),
      { alsoConsole: true, level: 'warn' }
    )
    return false
  }

  /**
   * Downward sphere sweep for a walkable hit under (x,z), multi-sample XZ.
   * Returns world feet Y (hit point Y) or null.
   *
   * When `preferNearY` is set, pick the hit closest to that Y (Flagtag deck), not the
   * absolute highest (roofs / arches above the play surface).
   */
  probeWalkSurfaceFeetY(
    x: number,
    z: number,
    fromY: number,
    maxDrop: number,
    preferNearY?: number
  ): number | null {
    if (!this.scene || maxDrop <= 0.2) return null
    this.ensureCameraSweepGeometry()
    if (!this.cameraSweepGeometry) return null

    let bestY: number | null = null
    let bestScore = Number.POSITIVE_INFINITY
    for (const [ox, oz] of SPAWN_PROBE_XZ_OFFSETS_M) {
      const sample = this.probeWalkSurfaceFeetYAt(x + ox, z + oz, fromY, maxDrop, preferNearY)
      if (sample == null) continue
      if (preferNearY != null && Number.isFinite(preferNearY)) {
        if (!isPlausibleSpawnSurfaceY(sample, preferNearY)) continue
        const score = Math.abs(sample - preferNearY)
        if (score < bestScore) {
          bestScore = score
          bestY = sample
        }
      } else if (bestY === null || sample > bestY) {
        bestY = sample
      }
    }
    return bestY
  }

  private probeWalkSurfaceFeetYAt(
    x: number,
    z: number,
    fromY: number,
    maxDrop: number,
    preferNearY?: number
  ): number | null {
    if (!this.scene || !this.cameraSweepGeometry) return null

    this._v1.set(x, fromY, z)
    this._v1.toPxVec3(this.sweepPose.p)
    this.applySceneQueryFilter(0)

    const down = this._pv2
    down.x = 0
    down.y = -1
    down.z = 0

    const didHit = this.scene.sweep(
      this.cameraSweepGeometry,
      this.sweepPose,
      down,
      maxDrop,
      this.sweepResult,
      PHYSX.PxHitFlagEnum.eDEFAULT,
      this.queryFilterData
    )
    if (!didHit) return null

    const nbHits = this.sweepResult.getNbAnyHits?.() ?? 1
    let bestY: number | null = null
    let bestScore = Number.POSITIVE_INFINITY
    for (let i = 0; i < nbHits; i++) {
      const hit = this.sweepResult.getAnyHit(i)
      const ny = hit.normal?.y ?? 0
      // Walk surface: mostly upward normal
      if (ny < 0.45) continue
      const hitY = fromY - hit.distance
      if (preferNearY != null && Number.isFinite(preferNearY)) {
        if (!isPlausibleSpawnSurfaceY(hitY, preferNearY)) continue
        const score = Math.abs(hitY - preferNearY)
        if (score < bestScore) {
          bestScore = score
          bestY = hitY
        }
      } else if (bestY === null || hitY > bestY) {
        bestY = hitY
      }
    }
    return bestY
  }

  hasStaticActor(entity: number): boolean {
    return this.staticActors.has(entity)
  }

  isKinematicActor(entity: number): boolean {
    return this.actorIsKinematic.has(entity)
  }

  /**
   * Ensure multi-shape collider is a **kinematic** rigid dynamic (PART / Animator movers).
   * Cooks entity-local geometry once; subsequent frames only set pose (no re-bake).
   */
  ensureKinematicMultiShape(desc: PhysicsColliderDesc): boolean {
    if (!desc.shapes?.length || !this.physics || !this.scene) return false
    if (this.actorIsKinematic.has(desc.entity) && this.staticActors.has(desc.entity)) {
      if (this.geomFingerprintMatches(desc) && this.hasShapeBaselines(desc.entity)) return true
    }
    // Drop static / stale kinematic — rebuild kinematic with current geometry.
    if (this.staticActors.has(desc.entity)) this.removeStatic(desc.entity)
    return this.addMultiShapeKinematic(desc)
  }

  /**
   * Pose kinematic multi-shape from live desc (entity T+R + relative shape locals).
   * Call after refreshShapeLocalMatrices for Animator frames.
   */
  updateKinematicMultiShapePose(desc: PhysicsColliderDesc): boolean {
    if (!this.ensureKinematicMultiShape(desc)) return false
    const actor = this.staticActors.get(desc.entity)
    if (!actor) return false
    if (!this.isPoseSlideSafe(actor, desc)) return false
    try {
      if (!this.updateMultiShapeActorPose(actor, desc, true)) return false
      this.staticFp.set(desc.entity, desc.fingerprint)
      this.staticPoseFp.set(desc.entity, multiShapePoseFingerprint(desc))
      this.invalidateControllerCache()
      return true
    } catch (err) {
      console.warn('[PhysXWorld] kinematic multi-shape pose failed:', desc.entity, err)
      return false
    }
  }

  /** Clears trimesh cook failure blacklist — use before a manual recook pass. */
  clearFailedCookCaches(): void {
    this.failedCookFp.clear()
    this.loggedFailedCookFp.clear()
  }

  /** Drop all GLTF multi-shape PhysX actors — Help panel force-recook only. */
  clearGltfStaticActors(): void {
    for (const entity of [...this.staticActors.keys()]) {
      if (this.isGltfStaticActor(entity)) this.removeStatic(entity)
    }
    this.ensureInfiniteGroundPlane()
  }

  /**
   * Remove every scene static actor (keeps infinite ground) — manual recook / pose drift reset.
   * Preserves AOI road furniture colliders so a scene recook does not soft road planters
   * until the next AOI rebuild.
   *
   * Prefer {@link staleNonRoadColliderFingerprints} for hot integrity — clearAll creates a
   * multi-second soft window while ~700 actors recook.
   */
  clearAllSceneStaticActors(options?: { preserveAoiRoads?: boolean }): void {
    const keepRoads = options?.preserveAoiRoads !== false
    for (const entity of [...this.staticActors.keys()]) {
      if (entity === INFINITE_GROUND_ENTITY) continue
      // Preserve by id range (not only bookkeeping set) so roads never die on scene recook.
      if (keepRoads && this.isAoiRoadColliderEntity(entity)) continue
      this.removeStatic(entity)
    }
    this.ensureInfiniteGroundPlane()
  }

  /**
   * Mark primary scene colliders as needing recook without removing live PhysX actors.
   * replaceStaticWithCook keeps the prior solid until the new cook succeeds — no soft hole.
   */
  staleNonRoadColliderFingerprints(): number {
    let n = 0
    for (const entity of [...this.staticFp.keys()]) {
      if (entity === INFINITE_GROUND_ENTITY) continue
      if (this.isAoiRoadColliderEntity(entity)) continue
      this.staticFp.delete(entity)
      this.staticPoseFp.delete(entity)
      n++
    }
    return n
  }

  /** Remove one static actor + sync fingerprints — boot cook always recooks fresh. */
  invalidateStaticCollider(entity: number): void {
    if (entity === INFINITE_GROUND_ENTITY) return
    if (this.staticActors.has(entity)) this.removeStatic(entity)
    else {
      this.staticFp.delete(entity)
      this.staticPoseFp.delete(entity)
      this.actorWorldBaked.delete(entity)
    }
  }

  /** True when a cooked actor exists and geometry fingerprint still matches the live desc. */
  geomFingerprintMatches(desc: PhysicsColliderDesc): boolean {
    return this.staticFp.get(desc.entity) === desc.fingerprint
  }

  isWorldBakedStatic(entity: number): boolean {
    return this.actorWorldBaked.get(entity) === true && this.staticActors.has(entity)
  }

  /** Entity-local multi-shape cooks store baselines for relative door/lift slides. */
  hasShapeBaselines(entity: number): boolean {
    const bas = this.shapeBaselineLocal.get(entity)
    return !!bas && bas.length > 0
  }

  /** True when last cooked/slid pose fingerprint matches the live descriptor. */
  actorPoseMatchesDesc(desc: PhysicsColliderDesc): boolean {
    if (!this.staticActors.has(desc.entity)) return false
    const poseFp = desc.shapes?.length
      ? multiShapePoseFingerprint(desc)
      : matrixFingerprint(desc.matrix)
    return this.staticPoseFp.get(desc.entity) === poseFp
  }

  /** Descriptor pose moved (CRDT resync) — world-baked vertices are already in world space. */
  ackStaticPoseFingerprint(desc: PhysicsColliderDesc): void {
    const poseFp = desc.shapes?.length
      ? multiShapePoseFingerprint(desc)
      : matrixFingerprint(desc.matrix)
    this.staticPoseFp.set(desc.entity, poseFp)
  }

  /**
   * World-baked trimeshes embed placement in vertices — actor pose slides are a no-op.
   * Returns true when the live descriptor matrix moved since the last cook.
   */
  needsWorldBakedPoseRecook(desc: PhysicsColliderDesc): boolean {
    if (!this.actorWorldBaked.get(desc.entity)) return false
    if (!this.staticActors.has(desc.entity)) return false
    if (!this.geomFingerprintMatches(desc)) return false
    const poseFp = desc.shapes?.length
      ? multiShapePoseFingerprint(desc)
      : matrixFingerprint(desc.matrix)
    return this.staticPoseFp.get(desc.entity) !== poseFp
  }

  /** Recook world-baked actors whose matrixWorld drifted (landscape + MeshCollider trimesh). */
  recookWorldBakedPoseDrift(
    descs: PhysicsColliderDesc[],
    options?: { forceAll?: boolean }
  ): number {
    const stale = options?.forceAll
      ? descs.filter(
          (d) =>
            this.actorWorldBaked.get(d.entity) &&
            this.staticActors.has(d.entity) &&
            this.geomFingerprintMatches(d)
        )
      : descs.filter((d) => this.needsWorldBakedPoseRecook(d))
    if (!stale.length) return 0
    if (options?.forceAll) {
      for (const desc of stale) this.staticPoseFp.delete(desc.entity)
    }
    const result = this.syncStaticColliders(stale, {
      cookBudget: stale.length,
      freezeRemoval: true,
      forceRecookOnPoseChange: true
    })
    if (result.geometryChanged) this.invalidateControllerCache()
    return stale.length
  }

  /**
   * Runtime pose slide — moves existing actors without remove/recook gaps.
   * Returns how many actors were repositioned.
   *
   * @param options.actorRootOnly — multi-shape: only set actor global T+R from desc.matrix;
   *   leave per-shape local poses alone. Required after boot: re-extracting shape locals and
   *   applying relative slides against cook baselines double-transforms plaza solids (soft world).
   * @param options.forceEntities — allow-list that also enables full multi-shape shape slides
   *   (Animator door/lift shape-motion only).
   */
  applyStaticColliderPoseUpdates(
    descs: PhysicsColliderDesc[],
    options?: {
      force?: boolean
      forceEntities?: ReadonlySet<number>
      /** Entity root T+R only — never rewrite multi-shape local poses. */
      actorRootOnly?: boolean
    }
  ): number {
    const forceAll = options?.force === true
    const forceEntities = options?.forceEntities
    const actorRootOnly = options?.actorRootOnly === true
    let updated = 0
    /** True when any multi-shape child local pose changed (needs SQ tree rebuild). */
    let shapeLocalsChanged = false
    for (const desc of descs) {
      if (this.failedCookFp.has(desc.fingerprint)) continue
      if (forceEntities && !forceAll && !forceEntities.has(desc.entity)) continue
      const forceThis = forceAll || (!!forceEntities && forceEntities.has(desc.entity))
      const shapeMotion = forceThis && !actorRootOnly

      if (desc.shapes?.length) {
        if (!this.geomFingerprintMatches(desc)) continue
        const actor = this.staticActors.get(desc.entity)
        // World-baked verts are fixed in world space — root/shape slides cannot track bones.
        if (!actor || this.actorWorldBaked.get(desc.entity)) continue

        if (actorRootOnly || !shapeMotion) {
          // Plaza static / entity Transform only: slide actor root; keep cooked shape locals.
          if (!this.matrixHasFinitePose(desc.matrix)) continue
          // Skip no-op when not forced (shape locals stay at cook baseline).
          if (!forceThis && this.staticPoseFp.get(desc.entity) === multiShapePoseFingerprint(desc)) {
            continue
          }
          try {
            desc.matrix.decompose(this._pos, this._quat, this._scale)
            this._pos.toPxTransform(this.actorPoseTransform)
            this._quat.toPxTransform(this.actorPoseTransform)
            actor.setGlobalPose(this.actorPoseTransform)
            this.staticPoseFp.set(desc.entity, multiShapePoseFingerprint(desc))
            updated++
          } catch (err) {
            console.warn('[PhysXWorld] multi-shape root pose slide failed:', desc.entity, err)
          }
          continue
        }

        // Shape-motion (doors): relative shape poses + actor root.
        const poseFp = multiShapePoseFingerprint(desc)
        const prevPoseFp = this.staticPoseFp.get(desc.entity)
        // forceThis allows shape slides — still skip pure no-ops (FPS: 120→40 was rewrite thrash).
        if (prevPoseFp === poseFp) continue
        if (!this.isPoseSlideSafe(actor, desc)) {
          // Unsafe (scale drift / shape count) — leave actor; caller may queue recook.
          continue
        }
        try {
          const kinematic = this.actorIsKinematic.has(desc.entity)
          if (!this.updateMultiShapeActorPose(actor, desc, kinematic)) continue
          this.staticPoseFp.set(desc.entity, poseFp)
          updated++
          shapeLocalsChanged = true
          // Static only: re-register so SQ bounds include child setLocalPose (CCT).
          // Kinematic uses setKinematicTarget + eDYNAMIC queries — no reinsert.
          if (!kinematic) this.reinsertStaticActorForSceneQuery(actor)
        } catch (err) {
          console.warn('[PhysXWorld] multi-shape pose slide failed:', desc.entity, err)
        }
        continue
      }

      if (!this.geomFingerprintMatches(desc)) continue
      const poseFp = matrixFingerprint(desc.matrix)
      if (!forceThis && this.staticPoseFp.get(desc.entity) === poseFp) continue
      const actor = this.staticActors.get(desc.entity)
      if (!actor || this.actorWorldBaked.get(desc.entity)) continue
      if (!this.matrixHasFinitePose(desc.matrix)) continue
      try {
        desc.matrix.decompose(this._pos, this._quat, this._scale)
        this._pos.toPxTransform(this.actorPoseTransform)
        this._quat.toPxTransform(this.actorPoseTransform)
        actor.setGlobalPose(this.actorPoseTransform)
        this.staticPoseFp.set(desc.entity, poseFp)
        updated++
      } catch (err) {
        console.warn('[PhysXWorld] primitive pose slide failed:', desc.entity, err)
        this.invalidateStaticCollider(desc.entity)
      }
    }
    // Critical: PhysX SQ stores one bound per static actor. shape.setLocalPose (door panels)
    // does NOT expand that bound — CCT never tests the swung hull without a static tree rebuild.
    if (shapeLocalsChanged) {
      this.rebuildStaticSceneQueryTree()
    } else if (updated > 0) {
      this.invalidateControllerCache()
    }
    return updated
  }

  /**
   * After multi-shape child local poses move (Animator doors/lifts), rebuild static SQ structure
   * so character-controller queries see the new panel bounds. No-op if scene missing.
   */
  rebuildStaticSceneQueryTree(): void {
    if (!this.scene) {
      this.invalidateControllerCache()
      return
    }
    try {
      // (rebuildStaticStructure, rebuildDynamicStructure)
      this.scene.forceDynamicTreeRebuild(true, false)
    } catch (err) {
      console.warn('[PhysXWorld] forceDynamicTreeRebuild failed:', err)
    }
    this.invalidateControllerCache()
  }

  /**
   * PhysX static actors keep a single SQ bound; setLocalPose on shapes does not expand it.
   * Remove+add forces the bound to match current shape poses so CCT can hit swung doors.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private reinsertStaticActorForSceneQuery(actor: any): void {
    if (!this.scene || !actor) return
    try {
      this.scene.removeActor(actor)
      this.scene.addActor(actor)
    } catch (err) {
      console.warn('[PhysXWorld] reinsert static actor for SQ failed:', err)
    }
  }

  isColliderSynced(desc: PhysicsColliderDesc): boolean {
    if (this.failedCookFp.has(desc.fingerprint)) return false

    if (desc.shapes?.length) {
      const geomFp = desc.fingerprint
      const poseFp = multiShapePoseFingerprint(desc)
      if (this.staticFp.get(desc.entity) !== geomFp) return false
      const actor = this.staticActors.get(desc.entity)
      if (!actor || this.staticPoseFp.get(desc.entity) !== poseFp) return false
      // Shape-count mismatch = partial cook; must not report synced (pose slides unsafe).
      try {
        if (actor.getNbShapes() !== desc.shapes.length) return false
      } catch {
        return false
      }
      return true
    }

    const poseFp = matrixFingerprint(desc.matrix)
    if (this.staticFp.get(desc.entity) !== desc.fingerprint) return false
    if (!this.staticActors.has(desc.entity)) return false
    return this.staticPoseFp.get(desc.entity) === poseFp
  }

  syncStaticColliders(
    descs: PhysicsColliderDesc[],
    options?: {
      cookBudget?: number
      freezeRemoval?: boolean
      /** Skip actor pose-only moves — full trimesh recook when pose drifts (loading). */
      forceRecookOnPoseChange?: boolean
      /** Share cooked trimesh meshes across instances — disable during boot cook. */
      geometryCache?: boolean
      /** Write cooked streams to IndexedDB — boot loading only. */
      persistCook?: boolean
      /** Boot warm start — deserialize primed IndexedDB before worker streams. */
      preferPersistedCook?: boolean
      /** Boot authoritative path — skip worker streams; cook live baked geometry on main thread. */
      skipWorkerStream?: boolean
    }
  ): { geometryChanged: boolean; pendingCooks: number } {
    const persistCook = options?.persistCook === true
    const preferPersistedCook = options?.preferPersistedCook === true
    const skipWorkerStream = options?.skipWorkerStream === true
    const bootStyleCook = options?.geometryCache === false
    const active = new Set<number>()
    let cooksRemaining = options?.cookBudget ?? Number.POSITIVE_INFINITY
    let geometryChanged = false
    let pendingCooks = 0

    for (const desc of descs) {
      active.add(desc.entity)

      if (desc.shapes?.length) {
        const geomFp = desc.fingerprint
        const poseFp = multiShapePoseFingerprint(desc)
        const prevGeomFp = this.staticFp.get(desc.entity)

        if (prevGeomFp === geomFp) {
          const actor = this.staticActors.get(desc.entity)
          // Partial cook (shape count mismatch) — must recook; pose slide is unsafe.
          const shapeCountOk =
            !!actor &&
            !!desc.shapes &&
            (() => {
              try {
                return actor.getNbShapes() === desc.shapes!.length
              } catch {
                return false
              }
            })()
          if (actor && shapeCountOk && this.staticPoseFp.get(desc.entity) === poseFp) continue
          const worldBaked = !!(actor && this.actorWorldBaked.get(desc.entity))
          if (actor && shapeCountOk && !options?.forceRecookOnPoseChange && !worldBaked) {
            try {
              if (this.updateMultiShapeActorPose(actor, desc)) {
                this.staticPoseFp.set(desc.entity, poseFp)
                geometryChanged = true
                continue
              }
              // Unsafe slide — fall through to recook.
            } catch (err) {
              console.warn('[PhysXWorld] multi-shape pose update failed:', desc.entity, err)
            }
          }
          // World-baked: remove→recook is a mid-scene hole (floors vanish). Keep live actor
          // unless boot/force explicitly demands recook — except partial cooks which never block.
          if (actor && worldBaked && shapeCountOk && !options?.forceRecookOnPoseChange) {
            pendingCooks++
            continue
          }
        } else if (
          prevGeomFp &&
          this.staticActors.has(desc.entity) &&
          !options?.forceRecookOnPoseChange &&
          !bootStyleCook
        ) {
          // Runtime re-extract often tweaks geom fingerprints while mesh is still solid.
          // Prefer stale solid over remove→cook hole mid-walk.
          pendingCooks++
          continue
        }

        if (prevGeomFp && prevGeomFp !== geomFp) {
          this.failedCookFp.delete(prevGeomFp)
          this.loggedFailedCookFp.delete(prevGeomFp)
        }
        if (this.failedCookFp.has(geomFp)) {
          if (this.staticActors.has(desc.entity)) continue
          continue
        }

        if (cooksRemaining <= 0) {
          pendingCooks++
          continue
        }

        try {
          // Keep live actor until cook succeeds — remove→add holes floors mid-hitch.
          const ok = this.replaceStaticWithCook(desc.entity, () =>
            this.addMultiShapeStatic(desc, {
              geometryCache: !bootStyleCook,
              persistCook,
              preferPersistedCook,
              skipWorkerStream
            })
          )
          if (!ok) {
            this.failedCookFp.add(geomFp)
            continue
          }
          cooksRemaining--
          geometryChanged = true
          this.failedCookFp.delete(geomFp)
          this.staticFp.set(desc.entity, geomFp)
          this.staticPoseFp.set(desc.entity, poseFp)
        } catch (err) {
          this.failedCookFp.add(geomFp)
          this.logCookFailedOnce(geomFp, '[PhysXWorld] multi-shape static collider sync failed:', err)
        }
        continue
      }

      const poseFp = matrixFingerprint(desc.matrix)
      const geomFp = this.staticFp.get(desc.entity)

      if (geomFp === desc.fingerprint) {
        const hasActor = this.staticActors.has(desc.entity)
        if (hasActor && this.staticPoseFp.get(desc.entity) === poseFp) continue
        if (
          hasActor &&
          !options?.forceRecookOnPoseChange &&
          !this.actorWorldBaked.get(desc.entity)
        ) {
          try {
            if (!this.matrixHasFinitePose(desc.matrix)) continue
            desc.matrix.decompose(this._pos, this._quat, this._scale)
            const actor = this.staticActors.get(desc.entity)!
            this._pos.toPxTransform(this.actorPoseTransform)
            this._quat.toPxTransform(this.actorPoseTransform)
            actor.setGlobalPose(this.actorPoseTransform)
            this.staticPoseFp.set(desc.entity, poseFp)
            geometryChanged = true
            continue
          } catch (err) {
            console.warn('[PhysXWorld] primitive pose update failed:', desc.entity, err)
          }
        }
        if (
          hasActor &&
          this.actorWorldBaked.get(desc.entity) &&
          !options?.forceRecookOnPoseChange
        ) {
          pendingCooks++
          continue
        }
      }

      const prevFp = geomFp
      if (prevFp && prevFp !== desc.fingerprint) {
        this.failedCookFp.delete(prevFp)
        this.loggedFailedCookFp.delete(prevFp)
      }
      if (this.failedCookFp.has(desc.fingerprint)) {
        if (this.staticActors.has(desc.entity)) continue
        continue
      }

      if (cooksRemaining <= 0) {
        pendingCooks++
        continue
      }

      try {
        const ok = this.replaceStaticWithCook(desc.entity, () =>
          this.addStatic(desc, persistCook, preferPersistedCook, skipWorkerStream)
        )
        if (!ok) {
          this.failedCookFp.add(desc.fingerprint)
          continue
        }
        cooksRemaining--
        geometryChanged = true
        this.failedCookFp.delete(desc.fingerprint)
        this.staticFp.set(desc.entity, desc.fingerprint)
        this.staticPoseFp.set(desc.entity, poseFp)
      } catch (err) {
        this.failedCookFp.add(desc.fingerprint)
        this.logCookFailedOnce(desc.fingerprint, '[PhysXWorld] static collider sync failed:', err)
      }
    }

    if (!options?.freezeRemoval) {
      for (const entity of [...this.staticActors.keys()]) {
        if (entity === INFINITE_GROUND_ENTITY) continue
        if (!active.has(entity)) {
          try {
            this.removeStatic(entity)
            geometryChanged = true
          } catch (err) {
            console.warn('[PhysXWorld] static collider removal failed:', entity, err)
          }
        }
      }
    }

    if (geometryChanged) {
      this.invalidateControllerCache()
    }
    return { geometryChanged, pendingCooks }
  }

  /** CCT obstacle cache must refresh when static geometry changes (GLTF collider batches). */
  invalidateControllerCache(): void {
    this.controller?.invalidateCache()
  }

  /**
   * Pose-only actor moves — invalidate CCT cache without simulating.
   * simulate(0) during incremental pose slides corrupts WASM state on large scenes.
   * Prefer rebuildStaticSceneQueryTree() after shape-local (door) pose slides.
   */
  refreshStaticColliderQueries(): void {
    this.invalidateControllerCache()
  }

  /**
   * Boot may use zero-dt sim; after seal World sets this false so runtime warms never
   * `simulate(0)` (corrupts WASM under concurrent pose slides on plaza-scale scenes).
   */
  setAllowZeroDtWarmSim(allowed: boolean): void {
    this.allowZeroDtWarmSim = allowed
  }

  /**
   * After bulk static registration, optionally run a zero-dt sim + CCT interaction pass so
   * queries see new actors. Runtime (post-seal) only invalidates the CCT obstacle cache.
   */
  warmStaticScene(): void {
    if (!this.scene) return
    this.ensureInfiniteGroundPlane()
    if (this.allowZeroDtWarmSim) {
      try {
        this.scene.simulate(0)
        this.scene.fetchResults(true)
        this.controllerManager?.computeInteractions(0)
      } catch (err) {
        console.warn('[PhysXWorld] warmStaticScene failed:', err)
      }
    }
    this.invalidateControllerCache()
  }

  /**
   * Runtime-safe refresh after late cooks / road AOI / heavy main-thread hitch.
   * Never runs simulate(0) — CCT re-queries solids via cache invalidate only.
   */
  refreshStaticAfterRuntimeGeometryChange(): void {
    this.ensureInfiniteGroundPlane()
    this.invalidateControllerCache()
  }

  /**
   * Padding-ring perimeter walls — tall thin boxes on the outer edges of empty padding parcels.
   * Never placed on scene parcels or on edges that border scene parcels (grass → sand must stay open).
   * Floor collision is `ensureInfiniteGroundPlane()`; island / open shore passes `perimeterWalls: false`.
   */
  syncLandscapeGround(
    parcelKeys: string[],
    baseParcel: string,
    sceneParcels: string[],
    options?: { perimeterWalls?: boolean }
  ): void {
    const perimeterWalls = options?.perimeterWalls !== false
    const fp = `${baseParcel}:${perimeterWalls ? 'w' : 'o'}:${parcelKeys.join(',')}:${sceneParcels.join(',')}`
    if (this.landscapeFp === fp) return

    for (const entity of [...this.staticActors.keys()]) {
      if (entity === INFINITE_GROUND_ENTITY) continue
      if (entity < 0) this.removeStatic(entity)
    }

    if (!perimeterWalls) {
      this.landscapeFp = fp
      this.invalidateControllerCache()
      return
    }

    const base = parseParcelKey(baseParcel)
    const keySet = new Set(parcelKeys)
    const matrix = new THREE.Matrix4()
    const quat = new THREE.Quaternion()
    const wallHeight = 500
    const wallThick = 0.25
    const wallHalfY = wallHeight / 2
    let nextEntity = -(parcelKeys.length + 2)

    const needsOuterWall = (nx: number, ny: number): boolean => {
      const neighbor = parcelKey({ x: nx, y: ny })
      if (keySet.has(neighbor)) return false
      if (isSceneParcel(neighbor, sceneParcels)) return false
      return true
    }

    parcelKeys.forEach((key) => {
      if (isSceneParcel(key, sceneParcels)) return

      const parcel = parseParcelKey(key)
      const origin = parcelWorldOrigin(parcel, base)

      const addWall = (center: THREE.Vector3, size: THREE.Vector3, edge: string): void => {
        matrix.compose(center, quat, size)
        const wallEntity = nextEntity--
        this.addStatic({
          entity: wallEntity,
          kind: 'box',
          fingerprint: `${fp}:wall:${key}:${edge}`,
          matrix
        })
        this.staticFp.set(wallEntity, `${fp}:wall:${key}:${edge}`)
      }

      const ox = -origin.x
      const oz = origin.z
      const mid = PARCEL_SIZE / 2

      if (needsOuterWall(parcel.x - 1, parcel.y)) {
        addWall(
          new THREE.Vector3(ox - wallThick / 2, wallHalfY, oz + mid),
          new THREE.Vector3(wallThick, wallHeight, PARCEL_SIZE),
          'west'
        )
      }
      if (needsOuterWall(parcel.x + 1, parcel.y)) {
        addWall(
          new THREE.Vector3(ox - PARCEL_SIZE + wallThick / 2, wallHalfY, oz + mid),
          new THREE.Vector3(wallThick, wallHeight, PARCEL_SIZE),
          'east'
        )
      }
      if (needsOuterWall(parcel.x, parcel.y - 1)) {
        addWall(
          new THREE.Vector3(ox - mid, wallHalfY, oz + wallThick / 2),
          new THREE.Vector3(PARCEL_SIZE, wallHeight, wallThick),
          'south'
        )
      }
      if (needsOuterWall(parcel.x, parcel.y + 1)) {
        addWall(
          new THREE.Vector3(ox - mid, wallHalfY, oz + PARCEL_SIZE - wallThick / 2),
          new THREE.Vector3(PARCEL_SIZE, wallHeight, wallThick),
          'north'
        )
      }
    })

    this.landscapeFp = fp
    this.invalidateControllerCache()
  }

  /**
   * Genesis AOI road furniture colliders — real FBX `*_collider` meshes (not boxes).
   * Entity ids live only in ROAD_AOI_COLLIDER_ENTITY_BASE range.
   *
   * Isolation contract (hard): AOI may ONLY add/remove/update actors whose entity id is in
   * that range. Primary scene MeshCollider / GLTF colliders (small ECS ids / 20_000_000+)
   * must never be touched by this path — shared PhysX scene, separate ownership.
   */
  private aoiRoadEntityIds = new Set<number>()

  /** True when entity id is reserved for AOI road furniture (not primary scene). */
  isAoiRoadColliderEntity(entity: number): boolean {
    return (
      entity >= ROAD_AOI_COLLIDER_ENTITY_BASE &&
      entity < ROAD_AOI_COLLIDER_ENTITY_BASE + ROAD_AOI_COLLIDER_ID_SPAN
    )
  }

  syncAoiRoadColliders(descs: PhysicsColliderDesc[]): { geometryChanged: boolean; pendingCooks: number } {
    // Drop any non-road ids that somehow appear in the payload — never write over scene solids.
    const roadOnly = descs.filter((d) => this.isAoiRoadColliderEntity(d.entity))
    if (roadOnly.length !== descs.length) {
      console.warn(
        `[PhysXWorld] AOI road sync rejected ${descs.length - roadOnly.length} non-road entity id(s)`
      )
    }

    const next = new Set(roadOnly.map((d) => d.entity))
    for (const entity of this.aoiRoadEntityIds) {
      if (next.has(entity)) continue
      if (!this.isAoiRoadColliderEntity(entity)) {
        // Corrupt bookkeeping — never removeStatic a primary id.
        console.warn(`[PhysXWorld] AOI bookkeeping had non-road id e${entity} — ignored`)
        continue
      }
      try {
        this.removeStatic(entity)
      } catch (err) {
        console.warn('[PhysXWorld] aoi road collider remove failed', entity, err)
      }
    }
    this.aoiRoadEntityIds = next

    // freezeRemoval:true is mandatory — syncStaticColliders must not prune actors absent
    // from this road-only list (that would delete every plaza furniture solid).
    const result = this.syncStaticColliders(roadOnly, {
      freezeRemoval: true,
      geometryCache: true,
      cookBudget: roadOnly.length
    })
    if (result.geometryChanged) {
      // CCT cache only — never zero-dt simulate (that corrupted all actors under load).
      this.refreshStaticAfterRuntimeGeometryChange()
    }
    return result
  }

  clearAoiRoadColliders(): void {
    for (const entity of this.aoiRoadEntityIds) {
      if (!this.isAoiRoadColliderEntity(entity)) continue
      try {
        this.removeStatic(entity)
      } catch {
        /* ignore */
      }
    }
    this.aoiRoadEntityIds.clear()
    this.invalidateControllerCache()
  }

  /** PhysX scene step — call after `movePlayer`. */
  step(delta: number): void {
    if (!this.scene) return
    this.scene.simulate(delta)
    this.scene.fetchResults(true)
    this.controllerManager?.computeInteractions(delta)
    this.syncCapsuleDebugTransform()
  }

  /** Unity/DCL-style CCT move — displacement in metres for this frame. */
  movePlayer(displacement: THREE.Vector3, delta: number): ControllerMoveResult {
    if (!this.controller) return { grounded: false }

    // Always re-assert y=0 floor before any move (scene cook churn must not strand the avatar).
    this.ensureInfiniteGroundPlane()

    this.pendingCctGroundEntity = null
    this.pendingCctGroundY = Number.NEGATIVE_INFINITY
    this.pendingCctGroundContact = null

    // Substep large moves so low-FPS genesis loads cannot tunnel ground or thin plaza walls.
    const absY = Math.abs(displacement.y)
    const absH = Math.hypot(displacement.x, displacement.z)
    const substeps = Math.min(
      CCT_MAX_SUBSTEPS,
      Math.max(
        1,
        Math.ceil(absY / CCT_MAX_VERTICAL_STEP_M),
        Math.ceil(absH / CCT_MAX_HORIZONTAL_STEP_M)
      )
    )
    const inv = 1 / substeps
    const stepDisp = this._v1.copy(displacement).multiplyScalar(inv)
    const stepDt = Math.max(1e-4, delta * inv)

    let grounded = false
    let hitUp = false
    for (let i = 0; i < substeps; i++) {
      const flags = this.controller.move(
        stepDisp.toPxVec3(this._pv2),
        0,
        stepDt,
        this.controllerFilters
      )
      if (flags.isSet(PHYSX.PxControllerCollisionFlagEnum.eCOLLISION_DOWN)) grounded = true
      if (flags.isSet(PHYSX.PxControllerCollisionFlagEnum.eCOLLISION_UP)) hitUp = true
    }
    this.syncPlayerTransform()

    if (hitUp && this.correctDescendingPlatformHeadCrush()) {
      grounded = true
    }

    // Hard floor — last line of defence if CCT still reports feet under y=0.
    if (this.position.y < HARD_FLOOR_Y) {
      this.position.y = HARD_FLOOR_Y
      this.controller.setFootPosition(this.position.toPxExtVec3())
      this.syncPlayerTransform()
      grounded = true
      this.lastGroundPhysEntity = INFINITE_GROUND_ENTITY
      this.pendingCctGroundEntity = INFINITE_GROUND_ENTITY
      this.pendingCctGroundY = HARD_FLOOR_Y
    }

    if (grounded && this.pendingCctGroundEntity !== null) {
      this.lastGroundPhysEntity = this.pendingCctGroundEntity
      if (this.pendingCctGroundContact) {
        this.lastCctShapeContact = this.pendingCctGroundContact
      }
    } else if (!grounded) {
      this.lastGroundPhysEntity = null
    }

    return { grounded }
  }

  /** CCT shape contact during move() — authoritative ground actor (no post-move ray probes). */
  private recordCctShapeHit(hit: {
    get_actor(): { ptr: number } | null
    get_worldNormal(): { x: number; y: number; z: number }
    get_dir(): { x: number; y: number; z: number }
    get_worldPos(): { x: number; y: number; z: number }
  }): void {
    const normal = hit.get_worldNormal()
    if (!normal || normal.y < WALKABLE_NORMAL_Y) return
    const dir = hit.get_dir()
    if (!dir || dir.y > -0.05) return

    const actor = hit.get_actor()
    const entity =
      actor?.ptr !== undefined ? this.staticEntityByActorPtr.get(actor.ptr) : undefined
    if (entity === undefined) return

    const worldPos = hit.get_worldPos()
    const contactY = worldPos?.y ?? Number.NEGATIVE_INFINITY
    const contactPoint = worldPos
      ? this._pos.set(worldPos.x, worldPos.y, worldPos.z)
      : null

    if (this.pendingCctGroundEntity === null) {
      this.pendingCctGroundEntity = entity
      this.pendingCctGroundY = contactY
      if (contactPoint) {
        this.pendingCctGroundContact = { entity, point: contactPoint.clone() }
      }
      return
    }

    const pending = this.pendingCctGroundEntity
    if (pending === INFINITE_GROUND_ENTITY && entity !== INFINITE_GROUND_ENTITY) {
      this.pendingCctGroundEntity = entity
      this.pendingCctGroundY = contactY
      if (contactPoint) {
        this.pendingCctGroundContact = { entity, point: contactPoint.clone() }
      }
      return
    }
    if (
      pending !== INFINITE_GROUND_ENTITY &&
      entity !== INFINITE_GROUND_ENTITY &&
      contactY > this.pendingCctGroundY + 0.02
    ) {
      this.pendingCctGroundEntity = entity
      this.pendingCctGroundY = contactY
      if (contactPoint) {
        this.pendingCctGroundContact = { entity, point: contactPoint.clone() }
      }
    }
  }

  get positionOut(): THREE.Vector3 {
    return this.position
  }

  /** Number of static collider actors currently registered (incl. infinite ground box). */
  get staticColliderCount(): number {
    return this.staticActors.size
  }

  /** GLTF multi-shape static actors successfully registered in PhysX. */
  get gltfStaticActorCount(): number {
    let count = 0
    for (const [entity] of this.staticFp) {
      if (this.isGltfStaticActor(entity)) count++
    }
    return count
  }

  private isGltfStaticActor(entity: number): boolean {
    if (entity === INFINITE_GROUND_ENTITY) return false
    const fp = this.staticFp.get(entity)
    return !!fp?.startsWith('gltf-entity:') && this.staticActors.has(entity)
  }

  get quaternionOut(): THREE.Quaternion {
    return this.quaternion
  }

  get playerController(): any {
    return this.controller
  }

  private footPositionFromController(out: THREE.Vector3): THREE.Vector3 {
    if (!this.controller) return out
    return out.copy(this.controller.getFootPosition())
  }

  /** MeshCollider anchor for platform Δ — highest shape world point (GLTF uses walk-surface instead). */
  private colliderWalkSurfaceAnchor(desc: PhysicsColliderDesc, out: THREE.Vector3): THREE.Vector3 {
    const top = this.gltfShapeWalkSurfaceTop(desc)
    return top ? out.copy(top) : out.setFromMatrixPosition(desc.matrix)
  }

  /**
   * Highest collider-shape tread in world space — matches the PhysX poses we slide each frame.
   * With `feet`, prefer the highest shape whose XZ bbox overlaps the capsule column.
   */
  private gltfShapeWalkSurfaceTop(
    desc: PhysicsColliderDesc,
    feet?: THREE.Vector3
  ): THREE.Vector3 | null {
    const shapes = desc.shapes
    if (!shapes?.length) return null

    const columnMargin = 1.5
    let columnMaxY = Number.NEGATIVE_INFINITY
    let columnBest: THREE.Vector3 | null = null
    let globalMaxY = Number.NEGATIVE_INFINITY
    let globalBest: THREE.Vector3 | null = null

    for (const shape of shapes) {
      const geometry = shape.geometry
      if (!geometry) continue
      if (!geometry.boundingBox) geometry.computeBoundingBox()
      const localBox = geometry.boundingBox
      if (!localBox || !Number.isFinite(localBox.max.y)) continue

      this._worldMatrix.copy(desc.matrix).multiply(shape.localMatrix)
      this._shapeBBox.copy(localBox).applyMatrix4(this._worldMatrix)
      if (!Number.isFinite(this._shapeBBox.max.y)) continue

      const top = this._v1.set(
        (this._shapeBBox.min.x + this._shapeBBox.max.x) * 0.5,
        this._shapeBBox.max.y,
        (this._shapeBBox.min.z + this._shapeBBox.max.z) * 0.5
      )

      if (this._shapeBBox.max.y >= globalMaxY) {
        globalMaxY = this._shapeBBox.max.y
        globalBest = top.clone()
      }

      if (feet) {
        if (feet.x < this._shapeBBox.min.x - columnMargin) continue
        if (feet.x > this._shapeBBox.max.x + columnMargin) continue
        if (feet.z < this._shapeBBox.min.z - columnMargin) continue
        if (feet.z > this._shapeBBox.max.z + columnMargin) continue
        if (this._shapeBBox.max.y >= columnMaxY) {
          columnMaxY = this._shapeBBox.max.y
          columnBest = top.clone()
        }
      }
    }

    // When `feet` is set, only tread under the capsule column counts — never fall back to a far
    // global bbox (pose desync would yield a ~parcel-span Δ and teleport the player to spawn).
    return feet ? columnBest : globalBest
  }

  private isPlausiblePlatformDelta(delta: THREE.Vector3): boolean {
    const horizSq = delta.x * delta.x + delta.z * delta.z
    if (horizSq > MAX_PLATFORM_DELTA_HORIZ * MAX_PLATFORM_DELTA_HORIZ) return false
    if (Math.abs(delta.y) > MAX_GROUND_CONTACT_VERT) return false
    return delta.lengthSq() <= MAX_PLATFORM_DELTA_TOTAL * MAX_PLATFORM_DELTA_TOTAL
  }

  /** Stricter cap for capsule riding — rejects actor-root glitches that pass pose-sync bounds. */
  private isPlausibleRidingDelta(delta: THREE.Vector3): boolean {
    const horizSq = delta.x * delta.x + delta.z * delta.z
    if (horizSq > MAX_RIDING_DELTA_HORIZ * MAX_RIDING_DELTA_HORIZ) return false
    return this.isPlausiblePlatformDelta(delta)
  }

  /** Drop jitter entries before CCT transfer — static ground must not micro-teleport. */
  cullInsignificantPlatformMotionDeltas(): void {
    for (const [entity, delta] of this.platformMotionDelta) {
      if (!isSignificantPlatformDelta(delta)) {
        this.platformMotionDelta.delete(entity)
      }
    }
  }

  private logRejectedPlatformDelta(
    source: string,
    entity: number,
    delta: THREE.Vector3,
    extra?: string
  ): void {
    if (!platformMotionDebug.isEnabled()) return
    clientDebugLog.log(
      'motion',
      `platform Δ rejected (${source}) · entity=${entity} · Δ=(${delta.x.toFixed(3)},${delta.y.toFixed(3)},${delta.z.toFixed(3)})${extra ? ` · ${extra}` : ''}`,
      { throttleKey: `platform-delta-reject-${source}`, throttleMs: 600, alsoConsole: true, level: 'warn' }
    )
  }

  /** Frame-start GLTF tread snapshot — baseline for shape-based platform Δ after pose refresh. */
  snapshotGltfColliderWalkSurfaces(
    descs: PhysicsColliderDesc[],
    feet?: THREE.Vector3,
    scopePhysEntity?: number | null
  ): void {
    this.gltfWalkSurfaceSnapshot.clear()
    if (scopePhysEntity !== null && scopePhysEntity !== undefined) {
      const desc = descs.find((d) => d.entity === scopePhysEntity)
      if (desc?.fingerprint.startsWith('gltf-entity:')) {
        const top = this.gltfShapeWalkSurfaceTop(desc, feet)
        if (top) this.gltfWalkSurfaceSnapshot.set(desc.entity, top.clone())
      }
      return
    }
    for (const desc of descs) {
      if (!desc.fingerprint.startsWith('gltf-entity:')) continue
      const top = this.gltfShapeWalkSurfaceTop(desc, feet)
      if (top) this.gltfWalkSurfaceSnapshot.set(desc.entity, top.clone())
    }
  }

  /**
   * GLTF platform Δ from cooked-shape tread tops — catches Animator slides mesh bbox can miss
   * when the CCT ground actor pose updates but walk-surface extractors report zero Δ.
   */
  applyGltfColliderPoseDeltas(descs: PhysicsColliderDesc[], feet?: THREE.Vector3): void {
    const scope = this.platformMotionScopeEntity
    if (scope === null) return
    for (const desc of descs) {
      if (desc.entity !== scope || !desc.fingerprint.startsWith('gltf-entity:')) continue
      const snapshot = this.gltfWalkSurfaceSnapshot.get(desc.entity)
      const current = this.gltfShapeWalkSurfaceTop(desc, feet)
      if (!snapshot || !current) continue

      this._v1.subVectors(current, snapshot)
      if (!isSignificantPlatformDelta(this._v1)) continue
      if (!this.isPlausiblePlatformDelta(this._v1)) {
        this.logRejectedPlatformDelta('gltf-walk-surface', desc.entity, this._v1)
        continue
      }
      this.commitPoseMotionDelta(desc.entity, this._v1, current)
    }
  }

  /**
   * Snapshot collider descriptor world positions before pose slides / tweens.
   * Call once per frame before motion bridges update entity transforms.
   */
  snapshotColliderPositions(descs: PhysicsColliderDesc[]): void {
    for (const desc of descs) {
      if (desc.fingerprint.startsWith('gltf-entity:')) continue
      this.colliderWalkSurfaceAnchor(desc, this._pos)
      let prev = this.colliderLastWorldPos.get(desc.entity)
      if (!prev) {
        prev = new THREE.Vector3()
        this.colliderLastWorldPos.set(desc.entity, prev)
      }
      prev.copy(this._pos)
    }
  }

  /**
   * Start of platform-motion frame.
   * @param groundEntity CCT-grounded actor from the previous tick — riding Δ is scoped to this only.
   */
  beginPlatformMotionFrame(groundEntity: number | null = null): void {
    this.platformMotionDelta.clear()
    this.poseMotionDelta.clear()
    this.gltfWalkSurfaceSnapshot.clear()
    this.actorRootPoseSnapshot.clear()
    this.physxActorSurfaceSnapshot.clear()
    this.groundContactBaseline = null
    this.platformMotionScopeEntity =
      groundEntity !== null && groundEntity !== INFINITE_GROUND_ENTITY ? groundEntity : null
  }

  private isRidingTransferEntity(entity: number): boolean {
    return this.platformMotionScopeEntity !== null && entity === this.platformMotionScopeEntity
  }

  /** Record transform motion — poseMotionDelta always; riding map only when grounded on this actor. */
  private commitPoseMotionDelta(
    entity: number,
    delta: THREE.Vector3,
    surface?: THREE.Vector3,
    sticky = true
  ): void {
    if (!isSignificantPlatformDelta(delta) || !this.isPlausiblePlatformDelta(delta)) return

    let poseDelta = this.poseMotionDelta.get(entity)
    if (!poseDelta) {
      poseDelta = new THREE.Vector3()
      this.poseMotionDelta.set(entity, poseDelta)
    }
    poseDelta.copy(delta)

    if (surface) {
      let walk = this.platformWalkSurfacePos.get(entity)
      if (!walk) {
        walk = new THREE.Vector3()
        this.platformWalkSurfacePos.set(entity, walk)
      }
      walk.copy(surface)
    }

    if (!this.isRidingTransferEntity(entity)) return
    if (!this.isPlausibleRidingDelta(delta)) {
      this.stickyPlatformDelta.delete(entity)
      return
    }

    let riding = this.platformMotionDelta.get(entity)
    if (!riding) {
      riding = new THREE.Vector3()
      this.platformMotionDelta.set(entity, riding)
    }
    riding.copy(delta)
    if (sticky) this.recordStickyPlatformDelta(entity, delta)
  }

  /**
   * Frame-start tread top — GLTF uses per-shape descriptor tread under the capsule (not combined
   * PhysX AABB, which can include far duplicate shapes and report treadY 50m+ away from feet).
   */
  snapshotPhysXActorWalkSurfaces(
    groundEntity: number | null,
    feet?: THREE.Vector3,
    descs?: PhysicsColliderDesc[]
  ): void {
    this.physxActorSurfaceSnapshot.clear()
    if (groundEntity === null || groundEntity === INFINITE_GROUND_ENTITY) return
    const top = this.actorWalkSurfaceTopForFrame(groundEntity, feet, descs)
    if (top) this.physxActorSurfaceSnapshot.set(groundEntity, top.clone())
  }

  /**
   * Grounded-entity Δ after pose slide — GLTF tread from live shape locals; mesh colliders use PhysX AABB.
   */
  applyPhysXActorWalkSurfaceDeltas(
    groundEntity: number | null,
    feet?: THREE.Vector3,
    descs?: PhysicsColliderDesc[]
  ): void {
    if (groundEntity === null || groundEntity === INFINITE_GROUND_ENTITY) return
    if (this.isWorldBakedStatic(groundEntity)) return

    const snapshot = this.physxActorSurfaceSnapshot.get(groundEntity)
    const current = this.actorWalkSurfaceTopForFrame(groundEntity, feet, descs)
    if (!snapshot || !current) return

    this._v1.subVectors(current, snapshot)
    if (!isSignificantPlatformDelta(this._v1)) return
    if (!this.isPlausiblePlatformDelta(this._v1)) {
      this.logRejectedPlatformDelta('physx-actor-bounds', groundEntity, this._v1)
      return
    }

    this.commitPoseMotionDelta(groundEntity, this._v1, current)

    if (platformMotionDebug.isEnabled()) {
      clientDebugLog.log(
        'motion',
        `physxBounds Δ=(${this._v1.x.toFixed(3)},${this._v1.y.toFixed(3)},${this._v1.z.toFixed(3)}) · entity=${groundEntity} · treadY ${snapshot.y.toFixed(2)}→${current.y.toFixed(2)}`,
        { throttleKey: 'physx-bounds-delta', throttleMs: 400, alsoConsole: true }
      )
    }
  }

  private actorWalkSurfaceTopForFrame(
    entity: number,
    feet?: THREE.Vector3,
    descs?: PhysicsColliderDesc[]
  ): THREE.Vector3 | null {
    const desc = descs?.find((d) => d.entity === entity)
    if (desc?.fingerprint.startsWith('gltf-entity:')) {
      return this.gltfShapeWalkSurfaceTop(desc, feet)
    }
    return this.physxActorWalkSurfaceTop(entity, feet)
  }

  private physxActorWalkSurfaceTop(entity: number, feet?: THREE.Vector3): THREE.Vector3 | null {
    const actor = this.staticActors.get(entity)
    if (!actor || typeof actor.getWorldBounds !== 'function') return null
    const bounds = actor.getWorldBounds()
    if (!bounds || typeof bounds.get_minimum !== 'function') return null
    const min = bounds.get_minimum()
    const max = bounds.get_maximum()
    if (!min || !max) return null

    const minX = min.x
    const minZ = min.z
    const maxX = max.x
    const maxY = max.y
    const maxZ = max.z
    if (![minX, minZ, maxX, maxY, maxZ].every(Number.isFinite)) return null

    if (feet) {
      const margin = MAX_GROUND_CONTACT_HORIZ
      if (feet.x < minX - margin || feet.x > maxX + margin) return null
      if (feet.z < minZ - margin || feet.z > maxZ + margin) return null
      if (maxY < feet.y - MAX_GROUND_CONTACT_VERT - 0.5) return null
    }

    return this._pos.set((minX + maxX) * 0.5, maxY, (minZ + maxZ) * 0.5)
  }

  /** All collider actor roots (incl. GLTF) — baseline for matrix-based platform Δ. */
  snapshotActorRootPoses(descs: PhysicsColliderDesc[]): void {
    this.actorRootPoseSnapshot.clear()
    for (const desc of descs) {
      this._pos.setFromMatrixPosition(desc.matrix)
      this.actorRootPoseSnapshot.set(desc.entity, this._pos.clone())
    }
  }

  /**
   * Descriptor matrix root Δ after pose refresh — tracks Animator/tween lifts even when PhysX
   * tread probes pick a stale duplicate mesh at scene origin.
   */
  applyActorRootPoseDeltas(descs: PhysicsColliderDesc[], priorityEntity?: number | null): void {
    for (const desc of descs) {
      if (priorityEntity !== null && priorityEntity !== undefined && desc.entity !== priorityEntity) {
        continue
      }
      const snapshot = this.actorRootPoseSnapshot.get(desc.entity)
      if (!snapshot) continue
      this._pos.setFromMatrixPosition(desc.matrix)
      this._v1.subVectors(this._pos, snapshot)
      if (!isSignificantPlatformDelta(this._v1)) continue
      if (!this.isPlausiblePlatformDelta(this._v1)) {
        this.logRejectedPlatformDelta('actor-root', desc.entity, this._v1)
        continue
      }

      this.commitPoseMotionDelta(desc.entity, this._v1, this._pos)

      if (
        platformMotionDebug.isEnabled() &&
        priorityEntity !== null &&
        priorityEntity !== undefined &&
        desc.entity === priorityEntity
      ) {
        clientDebugLog.log(
          'motion',
          `actorRoot Δ=(${this._v1.x.toFixed(3)},${this._v1.y.toFixed(3)},${this._v1.z.toFixed(3)}) · entity=${desc.entity}`,
          { throttleKey: 'actor-root-delta', throttleMs: 400, alsoConsole: true }
        )
      }
    }
  }

  private recordStickyPlatformDelta(entity: number, delta: THREE.Vector3): void {
    if (!isSignificantPlatformDelta(delta) || !this.isPlausibleRidingDelta(delta)) return
    let sticky = this.stickyPlatformDelta.get(entity)
    if (!sticky) {
      sticky = { delta: new THREE.Vector3(), framesLeft: 0 }
      this.stickyPlatformDelta.set(entity, sticky)
    }
    sticky.delta.copy(delta)
    sticky.framesLeft = 12
  }

  private refreshStickyPlatformDelta(entity: number): void {
    const sticky = this.stickyPlatformDelta.get(entity)
    if (sticky) sticky.framesLeft = 12
  }

  private decayStickyPlatformDelta(entity: number | null): void {
    if (entity === null) return
    const sticky = this.stickyPlatformDelta.get(entity)
    if (sticky) sticky.framesLeft = Math.max(0, sticky.framesLeft - 1)
  }

  private stickyPlatformDeltaFor(entity: number): THREE.Vector3 | null {
    const sticky = this.stickyPlatformDelta.get(entity)
    if (!sticky || sticky.framesLeft <= 0) return null
    return isSignificantPlatformDelta(sticky.delta) ? sticky.delta : null
  }

  /** Frame-start CCT contact from the previous locomotion tick. */
  snapshotGroundContactBaseline(_feet: THREE.Vector3): void {
    const contact = this.lastCctShapeContact
    if (!contact || contact.entity === INFINITE_GROUND_ENTITY) {
      this.groundContactBaseline = null
      return
    }
    this.groundContactBaseline = { entity: contact.entity, point: contact.point.clone() }
  }

  /** Tread contact Δ after collider pose slides — uses CCT contact only (no mid-frame ray probe). */
  applyGroundContactDelta(_feet: THREE.Vector3): void {
    const baseline = this.groundContactBaseline
    if (!baseline) return

    const contact = this.lastCctShapeContact
    if (!contact || contact.entity === INFINITE_GROUND_ENTITY) return

    const entity = contact.entity
    const trustEntity =
      entity === baseline.entity ||
      entity === this.lastGroundPhysEntity ||
      entity === this.standingPlatformEntity
    if (!trustEntity) return

    const hit = { physEntity: entity, point: contact.point }
    if (Math.abs(hit.point.y - _feet.y) > MAX_GROUND_CONTACT_VERT + 0.35) {
      this.logRejectedPlatformDelta(
        'ground-contact-feet-y',
        entity,
        hit.point.clone().sub(baseline.point),
        `feetY=${_feet.y.toFixed(2)} hitY=${hit.point.y.toFixed(2)}`
      )
      return
    }

    const horizFromFeetSq =
      (hit.point.x - _feet.x) * (hit.point.x - _feet.x) +
      (hit.point.z - _feet.z) * (hit.point.z - _feet.z)
    if (horizFromFeetSq > MAX_GROUND_CONTACT_HORIZ * MAX_GROUND_CONTACT_HORIZ) {
      this.logRejectedPlatformDelta(
        'ground-contact-horiz',
        entity,
        hit.point.clone().sub(baseline.point),
        `feet→hit horiz=${Math.sqrt(horizFromFeetSq).toFixed(2)}m`
      )
      this.groundContactBaseline = null
      return
    }

    this._v1.subVectors(hit.point, baseline.point)
    if (!isSignificantPlatformDelta(this._v1)) return
    if (Math.abs(this._v1.y) > MAX_GROUND_CONTACT_VERT) {
      this.logRejectedPlatformDelta(
        'ground-contact-vert',
        entity,
        this._v1,
        `baselineY ${baseline.point.y.toFixed(2)}→${hit.point.y.toFixed(2)}`
      )
      this.groundContactBaseline = null
      return
    }
    if (!this.isPlausiblePlatformDelta(this._v1)) {
      this.logRejectedPlatformDelta('ground-contact', entity, this._v1)
      this.groundContactBaseline = null
      return
    }

    const existing = this.platformMotionDelta.get(entity)
    if (existing && existing.lengthSq() > 1e-12 && Math.abs(existing.y) >= Math.abs(this._v1.y)) {
      return
    }

    this.commitPoseMotionDelta(entity, this._v1, hit.point)

    if (platformMotionDebug.isEnabled()) {
      clientDebugLog.log(
        'motion',
        `groundContact Δ=(${this._v1.x.toFixed(3)},${this._v1.y.toFixed(3)},${this._v1.z.toFixed(3)}) · entity=${entity} · treadY ${baseline.point.y.toFixed(2)}→${hit.point.y.toFixed(2)}`,
        { throttleKey: 'ground-contact-delta', throttleMs: 400, alsoConsole: true }
      )
    }
  }

  /** MeshCollider / landscape tweens — GLTF uses walk-surface Δ from GltfColliderExtractor. */
  applyMeshColliderPoseDeltas(descs: PhysicsColliderDesc[]): void {
    const scope = this.platformMotionScopeEntity
    for (const desc of descs) {
      if (desc.fingerprint.startsWith('gltf-entity:')) continue
      this.colliderWalkSurfaceAnchor(desc, this._pos)
      const prev = this.colliderLastWorldPos.get(desc.entity)
      if (!prev) {
        this.colliderLastWorldPos.set(desc.entity, this._pos.clone())
        continue
      }
      this._v1.subVectors(this._pos, prev)
      if (isSignificantPlatformDelta(this._v1)) {
        if (!this.isPlausiblePlatformDelta(this._v1)) {
          this.logRejectedPlatformDelta('mesh-collider', desc.entity, this._v1)
        } else if (scope !== null && desc.entity === scope) {
          this.commitPoseMotionDelta(desc.entity, this._v1, this._pos)
        } else {
          this.commitPoseMotionDelta(desc.entity, this._v1, this._pos, false)
        }
      }
      prev.copy(this._pos)
    }
  }

  clearStandingPlatform(): void {
    this.standingPlatformEntity = null
    this.lastGroundPhysEntity = null
    this.stickyPlatformDelta.clear()
    this.groundContactBaseline = null
  }

  /** Walk-surface positions after motion — feet-over-platform matching. */
  mergePlatformWalkSurfacePositions(positions: Map<number, THREE.Vector3>): void {
    for (const [entity, surfacePos] of positions) {
      let existing = this.platformWalkSurfacePos.get(entity)
      if (!existing) {
        existing = new THREE.Vector3()
        this.platformWalkSurfacePos.set(entity, existing)
      }
      existing.copy(surfacePos)
    }
  }

  /** Descending transform overhead — head-crush correction only (not riding transfer). */
  private overheadPoseMotionMatch(
    feet: THREE.Vector3,
    entity: number,
    delta: THREE.Vector3,
    maxHoriz = 3
  ): boolean {
    const surfacePos = this.platformWalkSurfacePos.get(entity)
    if (!surfacePos || delta.y >= -1e-5) return false
    const dx = feet.x - surfacePos.x
    const dz = feet.z - surfacePos.z
    if (dx * dx + dz * dz > maxHoriz * maxHoriz) return false
    const gapAboveFeet = surfacePos.y - feet.y
    return gapAboveFeet > 0 && gapAboveFeet <= PLATFORM_OVERHEAD_CATCH
  }

  /** Glue feet to walk-surface tread — after transfer or head-crush, avoids tunneling through floor below. */
  private snapFeetToPlatformWalkSurface(entity: number): boolean {
    const surface = this.platformWalkSurfacePos.get(entity)
    if (!surface) return false
    const targetFeetY = surface.y - CONTROLLER_CONTACT_OFFSET * 0.25
    const gap = targetFeetY - this.position.y
    if (gap <= 0.02 || gap > PLATFORM_OVERHEAD_CATCH) return false
    this._v1.set(this.position.x, targetFeetY, this.position.z)
    this.teleport(this._v1)
    this.lastGroundPhysEntity = entity
    this.invalidateControllerCache()
    return true
  }

  /** CCT eCOLLISION_UP from descending platform — snap onto tread instead of shoving through floor. */
  private correctDescendingPlatformHeadCrush(): boolean {
    const feet = this.position
    const tryEntity = (entity: number): boolean => {
      const delta = this.poseMotionDelta.get(entity)
      if (!delta || !this.overheadPoseMotionMatch(feet, entity, delta, 3)) return false
      return this.snapFeetToPlatformWalkSurface(entity)
    }

    if (this.platformMotionScopeEntity !== null && tryEntity(this.platformMotionScopeEntity)) {
      return true
    }

    let bestHoriz = Number.POSITIVE_INFINITY
    let bestEntity: number | null = null
    for (const [entity, delta] of this.poseMotionDelta) {
      if (entity === INFINITE_GROUND_ENTITY) continue
      if (!this.overheadPoseMotionMatch(feet, entity, delta, 3)) continue
      const surface = this.platformWalkSurfacePos.get(entity)
      if (!surface) continue
      const horizSq = (feet.x - surface.x) ** 2 + (feet.z - surface.z) ** 2
      if (horizSq < bestHoriz) {
        bestHoriz = horizSq
        bestEntity = entity
      }
    }
    return bestEntity !== null && tryEntity(bestEntity)
  }

  private platformMotionDeltaForEntity(entity: number): THREE.Vector3 | null {
    const delta = this.platformMotionDelta.get(entity)
    return delta && delta.lengthSq() > 1e-12 ? delta : null
  }

  /**
   * Riding Δ for the CCT-grounded actor only — see platformMotion.ts.
   * No scene-wide search; distant animated props cannot affect the capsule.
   */
  getPlatformTransferDelta(): THREE.Vector3 {
    this.platformTransferDisp.set(0, 0, 0)

    const groundEntity = this.platformMotionScopeEntity ?? this.lastGroundPhysEntity
    if (groundEntity === null || groundEntity === INFINITE_GROUND_ENTITY) {
      this.standingPlatformEntity = null
      return this.platformTransferDisp
    }

    const delta =
      this.platformMotionDeltaForEntity(groundEntity) ?? this.stickyPlatformDeltaFor(groundEntity)

    if (!delta || !isSignificantPlatformDelta(delta) || !this.isPlausibleRidingDelta(delta)) {
      this.standingPlatformEntity = null
      return this.platformTransferDisp
    }

    if (platformMotionDebug.isEnabled() && !this.platformMotionDelta.has(groundEntity)) {
      clientDebugLog.log(
        'motion',
        `platform transfer sticky Δ=(${delta.x.toFixed(3)},${delta.y.toFixed(3)},${delta.z.toFixed(3)}) · entity=${groundEntity}`,
        { throttleKey: 'platform-sticky', throttleMs: 500, alsoConsole: true }
      )
    }

    this.standingPlatformEntity = groundEntity
    return this.platformTransferDisp.copy(delta)
  }

  /**
   * Explicit platform velocity transfer — capsule position += standing surface Δ, then CCT move().
   */
  applyPlatformVelocityTransfer(): boolean {
    const delta = this.getPlatformTransferDelta()
    if (delta.lengthSq() >= 1e-12 && !this.isPlausibleRidingDelta(delta)) {
      this.logRejectedPlatformDelta(
        'transfer',
        this.standingPlatformEntity ?? this.lastGroundPhysEntity ?? -1,
        delta,
        `feet=(${this.position.x.toFixed(2)},${this.position.y.toFixed(2)},${this.position.z.toFixed(2)})`
      )
      this.standingPlatformEntity = null
      const rejectEntity = this.platformMotionScopeEntity ?? this.lastGroundPhysEntity
      if (rejectEntity !== null) this.stickyPlatformDelta.delete(rejectEntity)
      return false
    }
    if (!isSignificantPlatformDelta(delta)) {
      this.decayStickyPlatformDelta(this.lastGroundPhysEntity)
      if (platformMotionDebug.isEnabled() && this.platformMotionDelta.size > 0) {
        const baseline = this.groundContactBaseline
        const baselineStr = baseline
          ? ` · contact=${baseline.entity}@${baseline.point.y.toFixed(2)}`
          : ''
        clientDebugLog.log(
          'motion',
          `platform transfer skip — ${this.platformMotionDelta.size} Δ(s) but no match · ground=${this.lastGroundPhysEntity ?? 'none'} · feet=(${this.position.x.toFixed(2)},${this.position.y.toFixed(2)},${this.position.z.toFixed(2)})${baselineStr}`,
          { throttleKey: 'platform-transfer-skip', throttleMs: 800, alsoConsole: true }
        )
      }
      return false
    }
    const entity = this.standingPlatformEntity
    if (entity === null || entity !== (this.platformMotionScopeEntity ?? this.lastGroundPhysEntity)) {
      this.standingPlatformEntity = null
      return false
    }
    this._v1.copy(this.position).add(delta)
    this.teleport(this._v1)
    if (Math.abs(delta.y) >= 0.01) {
      this.snapFeetToPlatformWalkSurface(entity)
    }
    if (entity !== null) this.refreshStickyPlatformDelta(entity)
    this.invalidateControllerCache()
    if (platformMotionDebug.isEnabled()) {
      clientDebugLog.log(
        'motion',
        `platform transfer Δ=(${delta.x.toFixed(3)},${delta.y.toFixed(3)},${delta.z.toFixed(3)}) · entity=${entity ?? '?'} · grounded · feet→(${this.position.x.toFixed(2)},${this.position.y.toFixed(2)},${this.position.z.toFixed(2)})`,
        { throttleKey: 'platform-transfer', throttleMs: 400, alsoConsole: true, level: 'success' }
      )
    }
    return true
  }

  /**
   * Animator GLTF root-origin Δ — whole-entity lifts (Unity moves the platform Transform).
   * Prefer |Δy| over walk-surface bbox when the lift has no `_collider` tread motion.
   */
  mergeAnimatorOriginPlatformMotion(
    originDeltas: Map<number, THREE.Vector3>,
    originPositions: Map<number, THREE.Vector3>
  ): void {
    for (const [entity, originDelta] of originDeltas) {
      if (!isSignificantPlatformDelta(originDelta)) continue
      if (!this.isPlausibleRidingDelta(originDelta)) {
        this.logRejectedPlatformDelta('animator-origin', entity, originDelta)
        continue
      }
      this.commitPoseMotionDelta(entity, originDelta, originPositions.get(entity))
    }
  }

  getPlatformMotionDeltaSnapshot(): { entity: number; dx: number; dy: number; dz: number }[] {
    const out: { entity: number; dx: number; dy: number; dz: number }[] = []
    for (const [entity, delta] of this.platformMotionDelta) {
      out.push({ entity, dx: delta.x, dy: delta.y, dz: delta.z })
    }
    return out
  }

  getLastGroundPhysEntity(): number | null {
    return this.lastGroundPhysEntity
  }

  getStandingPlatformEntity(): number | null {
    return this.standingPlatformEntity
  }

  private registerStaticActor(entity: number, actor: { ptr: number }): void {
    this.staticEntityByActorPtr.set(actor.ptr, entity)
  }

  private unregisterStaticActor(entity: number): void {
    const actor = this.staticActors.get(entity)
    if (actor?.ptr !== undefined) this.staticEntityByActorPtr.delete(actor.ptr)
    this.colliderLastWorldPos.delete(entity)
    this.gltfWalkSurfaceSnapshot.delete(entity)
    this.platformMotionDelta.delete(entity)
    this.platformWalkSurfacePos.delete(entity)
    this.shapeBaselineLocal.delete(entity)
    this.actorCookScale.delete(entity)
  }

  /** Scene queries — bilateral layer test (matches CCT preFilter). */
  private applySceneQueryFilter(layerMask: number): void {
    this.queryFilterData.data.word0 = Layers.player.group
    this.queryFilterData.data.word1 =
      layerMask === 0 ? Layers.player.mask : layerMask & Layers.player.mask
  }

  private ensureCameraSweepGeometry(): void {
    if (this.cameraSweepGeometry || !this.physics) return
    this.cameraSweepGeometry = new PHYSX.PxSphereGeometry(0.2)
  }

  /** Ray-style sweep for third-person camera wall collision — opt-in via `?camerasweep`. */
  sweepRay(origin: THREE.Vector3, direction: THREE.Vector3, maxDistance: number): number | null {
    if (!this.scene) return null
    this.ensureCameraSweepGeometry()
    if (!this.cameraSweepGeometry) return null
    const skipNear = Math.min(0.55, maxDistance * 0.06)
    const sweepDist = maxDistance - skipNear
    if (sweepDist <= 0.2) return null

    this._v1.copy(origin).addScaledVector(direction, skipNear)
    this._v1.toPxVec3(this.sweepPose.p)

    this.applySceneQueryFilter(CAMERA_QUERY_MASK)

    const didHit = this.scene.sweep(
      this.cameraSweepGeometry,
      this.sweepPose,
      direction.toPxVec3(this._pv2),
      sweepDist,
      this.sweepResult,
      PHYSX.PxHitFlagEnum.eDEFAULT,
      this.queryFilterData
    )

    if (!didHit) return null
    const nbHits = this.sweepResult.getNbAnyHits?.() ?? 1
    let bestDist: number | null = null
    for (let i = 0; i < nbHits; i++) {
      const hit = this.sweepResult.getAnyHit(i)
      const ny = hit.normal.y
      if (ny > 0.42) continue
      const nx = hit.normal.x
      const nz = hit.normal.z
      const dot =
        nx * direction.x + ny * direction.y + nz * direction.z
      if (dot > -0.12) continue
      const dist = hit.distance + skipNear
      if (bestDist === null || dist < bestDist) bestDist = dist
    }
    return bestDist
  }

  teleport(position: THREE.Vector3): void {
    if (!this.controller) return
    this.controller.setFootPosition(position.toPxExtVec3())
    this.syncPlayerTransform()
  }

  private syncPlayerTransform(): void {
    if (!this.controller) return
    this.position.fromPxVec3(this.controller.getFootPosition())
    this.quaternion.set(0, 0, 0, 1)
  }

  private logCookFailedOnce(fingerprint: string, message: string, err?: unknown): void {
    if (this.loggedFailedCookFp.has(fingerprint)) return
    this.loggedFailedCookFp.add(fingerprint)
    if (err !== undefined) console.warn(message, fingerprint, err)
    else console.warn(message, fingerprint)
  }

  private addMultiShapeStatic(
    desc: PhysicsColliderDesc,
    options?: {
      geometryCache?: boolean
      persistCook?: boolean
      preferPersistedCook?: boolean
      skipWorkerStream?: boolean
    }
  ): boolean {
    const geometryCache = options?.geometryCache !== false
    const persistCook = options?.persistCook === true
    const preferPersistedCook = options?.preferPersistedCook === true
    const skipWorkerStream = options?.skipWorkerStream === true
    const shapes = desc.shapes
    if (!shapes?.length || !this.physics || !this.scene) return false

    const handles: PxMeshHandle[] = []
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pxShapes: any[] = []
    let attached = 0
    let actorAtOrigin = false

    for (const shapeDesc of shapes) {
      if (!shapeDesc.geometry) continue
      // Entity-local: bake entityScale × shape localMatrix into verts; actor T+R; shape pose
      // identity at rest. Animator slides: shape pose = currentLocal * inv(baselineLocal).
      const result = this.createLocalTrimeshShape(
        shapeDesc,
        handles,
        desc,
        false,
        geometryCache,
        persistCook,
        preferPersistedCook,
        skipWorkerStream
      )
      if (!result) continue
      if (result.worldBaked) actorAtOrigin = true
      pxShapes.push(result.shape)
      attached++
    }

    if (actorAtOrigin) {
      this._pos.set(0, 0, 0)
      this._quat.set(0, 0, 0, 1)
    } else {
      desc.matrix.decompose(this._pos, this._quat, this._scale)
    }
    this._pos.toPxTransform(this.actorPoseTransform)
    this._quat.toPxTransform(this.actorPoseTransform)

    const actor = this.physics.createRigidStatic(this.actorPoseTransform)
    for (const pxShape of pxShapes) {
      actor.attachShape(pxShape)
    }

    if (!attached) {
      try {
        actor.release?.()
      } catch {
        // ignore
      }
      for (const handle of handles) {
        try {
          handle.release()
        } catch {
          // ignore
        }
      }
      this.logCookFailedOnce(desc.fingerprint, '[PhysXWorld] multi-shape cook failed — no shapes attached:')
      return false
    }

    this.scene.addActor(actor)
    this.staticActors.set(desc.entity, actor)
    this.registerStaticActor(desc.entity, actor)
    this.pmeshHandles.set(desc.entity, handles)
    this.actorWorldBaked.set(desc.entity, actorAtOrigin)
    if (!actorAtOrigin && shapes.length) {
      this.shapeBaselineLocal.set(
        desc.entity,
        shapes.map((shape) => shape.localMatrix.clone())
      )
      desc.matrix.decompose(this._pos, this._quat, this._scale)
      this.actorCookScale.set(desc.entity, this._scale.clone())
    } else {
      this.actorCookScale.delete(desc.entity)
    }
    if (attached < shapes.length) {
      console.warn(
        `[PhysXWorld] multi-shape cook partial — entity=${desc.entity} attached=${attached}/${shapes.length} ` +
          `(triangle-only; failed shapes dropped — check cook logs). fp=${desc.fingerprint.slice(0, 80)}`
      )
    }
    return true
  }

  private cookBakedGeometryToCache(
    bakedGeo: THREE.BufferGeometry,
    persistCook = false,
    workerStorageKey?: string,
    preferPersistedCook = false,
    skipWorkerStream = false
  ): PxMeshHandle | null {
    if (!isTrimeshGeometryCookable(bakedGeo)) return null
    // Triangle mesh only — never convex fallback. Convex hulls turn hollow DCL wall /
    // dome `_collider` shells into solid volumes (player hits "invisible wall" mid-map).
    // Explorer cooks triangle meshes for GltfContainer physics; matching that is required.
    const handle = geometryToPxMesh(this.cookingParams, bakedGeo, false, {
      cache: true,
      physics: this.physics,
      persistCook,
      preferPersistedCook,
      skipWorkerStream,
      workerStorageKey
    })
    return handle?.value ? handle : null
  }

  private createLocalTrimeshShape(
    shapeDesc: PhysicsColliderShapeDesc,
    handles: PxMeshHandle[],
    desc: PhysicsColliderDesc,
    allowWorldFallback: boolean,
    geometryCache = true,
    persistCook = false,
    preferPersistedCook = false,
    skipWorkerStream = false
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): { shape: any; worldBaked: boolean } | null {
    const geometry = shapeDesc.geometry
    if (!geometry) return null

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cookBakedGeo = (
      bakedGeo: THREE.BufferGeometry,
      cache: boolean,
      workerStorageKey?: string
    ): any | null => {
      if (!isTrimeshGeometryCookable(bakedGeo)) return null

      const cookOpts = {
        cache: false as const,
        physics: this.physics,
        persistCook,
        preferPersistedCook,
        skipWorkerStream,
        workerStorageKey
      }
      const pmeshHandle = cache
        ? this.cookBakedGeometryToCache(
            bakedGeo,
            persistCook,
            workerStorageKey,
            preferPersistedCook,
            skipWorkerStream
          )
        : geometryToPxMesh(this.cookingParams, bakedGeo, false, cookOpts)
      let pxGeometry: unknown = null

      // No convex fallback here either — hollow scene walls must stay triangle meshes.
      if (!pmeshHandle?.value) return null

      if (!pxGeometry) {
        const meshFlags = new PHYSX.PxMeshGeometryFlags(PHYSX.PxMeshGeometryFlagEnum.eDOUBLE_SIDED)
        const meshScale = unitPxMeshScale()
        pxGeometry = new PHYSX.PxTriangleMeshGeometry(pmeshHandle.value, meshScale, meshFlags)
        PHYSX.destroy(meshScale)
        PHYSX.destroy(meshFlags)
      }

      handles.push(pmeshHandle)
      return pxGeometry
    }

    try {
      const indexed = ensureIndexedForCook(geometry)
      let pxGeometry: unknown = null
      let worldBaked = false
      let entityLocalGeo: THREE.BufferGeometry | null = null

      if (!geometryCache) {
        // World-space vertices, actor at origin.
        this._worldMatrix.copy(desc.matrix).multiply(shapeDesc.localMatrix)
        const worldGeo = bakeTrimeshGeometry(indexed, this._worldMatrix)
        const workerKey = bootColliderCookSignature(geometry, desc, shapeDesc.localMatrix, false)
        pxGeometry = cookBakedGeo(worldGeo, false, workerKey)
        if (pxGeometry) worldBaked = true
        worldGeo.dispose()
      } else {
        // Entity-local: bake entity world scale × shape localMatrix into verts (placement+scale
        // do not commute — must bake together). Shape pose stays identity; Animator slides via
        // relative shape pose current * inv(baseline).
        desc.matrix.decompose(this._pos, this._quat, this._scale)
        this._entityScaleMat.makeScale(
          Number.isFinite(this._scale.x) && Math.abs(this._scale.x) > 1e-8 ? this._scale.x : 1,
          Number.isFinite(this._scale.y) && Math.abs(this._scale.y) > 1e-8 ? this._scale.y : 1,
          Number.isFinite(this._scale.z) && Math.abs(this._scale.z) > 1e-8 ? this._scale.z : 1
        )
        this._entityLocalBake.copy(this._entityScaleMat).multiply(shapeDesc.localMatrix)
        const workerKey = entityLocalColliderCookSignature(geometry, this._entityLocalBake, false)
        entityLocalGeo = bakeTrimeshGeometry(indexed, this._entityLocalBake)
        pxGeometry = cookBakedGeo(entityLocalGeo, geometryCache, workerKey)

        if (!pxGeometry && allowWorldFallback) {
          this._worldMatrix.copy(desc.matrix).multiply(shapeDesc.localMatrix)
          const worldGeo = bakeTrimeshGeometry(indexed, this._worldMatrix)
          const workerKey = bootColliderCookSignature(geometry, desc, shapeDesc.localMatrix, false)
          pxGeometry = cookBakedGeo(worldGeo, false, workerKey)
          if (pxGeometry) worldBaked = true
          worldGeo.dispose()
        }
      }

      entityLocalGeo?.dispose()
      if (indexed !== geometry) indexed.dispose()

      if (!pxGeometry) {
        this.logCookFailedOnce(shapeDesc.fingerprint, '[PhysXWorld] trimesh cook failed:')
        return null
      }

      const shapeFlags = new PHYSX.PxShapeFlags(
        PHYSX.PxShapeFlagEnum.eSCENE_QUERY_SHAPE | PHYSX.PxShapeFlagEnum.eSIMULATION_SHAPE
      )
      const shape = this.physics.createShape(pxGeometry, this.defaultMaterial, true, shapeFlags)
      PHYSX.destroy(pxGeometry)

      // Prop layer — same filter path as MeshCollider (proven CCT + scene query blocking).
      const filterData = new PHYSX.PxFilterData(Layers.prop.group, Layers.prop.mask, 0, 0)
      shape.setQueryFilterData(filterData)
      shape.setSimulationFilterData(filterData)

      // Geometry carries local bake — shape pose identity at rest.
      this._pos.set(0, 0, 0)
      this._identityQuat.set(0, 0, 0, 1)
      this._pos.toPxTransform(this.shapeLocalPoseTransform)
      this._identityQuat.toPxTransform(this.shapeLocalPoseTransform)
      shape.setLocalPose(this.shapeLocalPoseTransform)

      return { shape, worldBaked }
    } catch (err) {
      this.logCookFailedOnce(shapeDesc.fingerprint, '[PhysXWorld] local trimesh cook failed:', err)
      return null
    }
  }

  private matrixHasFinitePose(matrix: THREE.Matrix4): boolean {
    const e = matrix.elements
    for (let i = 0; i < 16; i++) {
      const v = e[i]!
      if (!Number.isFinite(v)) return false
    }
    return true
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private isPoseSlideSafe(actor: any, desc: PhysicsColliderDesc): boolean {
    if (!this.matrixHasFinitePose(desc.matrix)) return false
    const shapes = desc.shapes
    if (!shapes?.length) return false
    let nbShapes = 0
    try {
      nbShapes = actor.getNbShapes()
    } catch {
      return false
    }
    if (nbShapes <= 0 || nbShapes !== shapes.length) return false
    for (const shape of shapes) {
      if (!this.matrixHasFinitePose(shape.localMatrix)) return false
    }
    // Entity-local cooks bake world scale into verts — T+R slide cannot fix scale drift.
    // Parent scale settle after boot cook used to leave unit-sized soft furniture.
    if (!this.actorWorldBaked.get(desc.entity)) {
      const cookScale = this.actorCookScale.get(desc.entity)
      if (cookScale) {
        desc.matrix.decompose(this._pos, this._quat, this._scale)
        const sx = Math.abs(this._scale.x)
        const sy = Math.abs(this._scale.y)
        const sz = Math.abs(this._scale.z)
        const cx = Math.abs(cookScale.x)
        const cy = Math.abs(cookScale.y)
        const cz = Math.abs(cookScale.z)
        const rel = (a: number, b: number) => {
          const den = Math.max(a, b, 1e-4)
          return Math.abs(a - b) / den
        }
        if (rel(sx, cx) > 0.04 || rel(sy, cy) > 0.04 || rel(sz, cz) > 0.04) {
          return false
        }
      }
    }
    return true
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private ensureShapePtrBuffer(nbShapes: number): any {
    if (!this.shapePtrBuffer || nbShapes > this.shapePtrBufferCapacity) {
      if (this.shapePtrBuffer) {
        try {
          PHYSX.destroy(this.shapePtrBuffer)
        } catch {
          // ignore
        }
      }
      this.shapePtrBuffer = new PHYSX.PxArray_PxShapePtr(nbShapes)
      this.shapePtrBufferCapacity = nbShapes
    }
    return this.shapePtrBuffer
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private setPxShapeLocalPose(pxShape: any, matrix: THREE.Matrix4): void {
    if (!this.matrixHasFinitePose(matrix)) return
    matrix.decompose(this._pos, this._quat, this._scale)
    this._pos.toPxTransform(this.shapeLocalPoseTransform)
    this._quat.toPxTransform(this.shapeLocalPoseTransform)
    pxShape.setLocalPose(this.shapeLocalPoseTransform)
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  /**
   * Slide actor root + per-shape relative poses — geometry baked at cook baseline.
   * @param kinematic — use setKinematicTarget when available so CCT SQ sees the move.
   * @returns false when the actor cannot be slid safely (caller must recook).
   */
  private updateMultiShapeActorPose(
    actor: any,
    desc: PhysicsColliderDesc,
    kinematic = false
  ): boolean {
    const shapes = desc.shapes
    if (!shapes?.length) return false
    if (!this.isPoseSlideSafe(actor, desc)) return false

    desc.matrix.decompose(this._pos, this._quat, this._scale)
    this._pos.toPxTransform(this.actorPoseTransform)
    this._quat.toPxTransform(this.actorPoseTransform)
    if (kinematic && typeof actor.setKinematicTarget === 'function') {
      actor.setKinematicTarget(this.actorPoseTransform)
    } else {
      actor.setGlobalPose(this.actorPoseTransform)
    }

    if (this.actorWorldBaked.get(desc.entity)) return true

    const baselines = this.shapeBaselineLocal.get(desc.entity)
    const nbShapes = actor.getNbShapes()
    const shapeBuffer = this.ensureShapePtrBuffer(nbShapes)
    const shapesCount = actor.getShapes(shapeBuffer.begin(), nbShapes, 0)
    for (let i = 0; i < shapesCount && i < shapes.length; i++) {
      const pxShape = shapeBuffer.get(i)
      const current = shapes[i]!.localMatrix
      const baseline = baselines?.[i]
      if (baseline) {
        // Door/lift: verts baked at baseline local; shape pose carries open*inv(closed).
        this._shapeRel.copy(baseline).invert()
        this._shapeRel.premultiply(current)
        this.setPxShapeLocalPose(pxShape, this._shapeRel)
      } else {
        this._pos.set(0, 0, 0)
        this._identityQuat.set(0, 0, 0, 1)
        this._pos.toPxTransform(this.shapeLocalPoseTransform)
        this._identityQuat.toPxTransform(this.shapeLocalPoseTransform)
        pxShape.setLocalPose(this.shapeLocalPoseTransform)
      }
    }
    return true
  }

  /**
   * Multi-shape kinematic rigid dynamic — same entity-local cook as static, but CCT-friendly
   * pose updates via setKinematicTarget (doors / PART movers).
   */
  private addMultiShapeKinematic(desc: PhysicsColliderDesc): boolean {
    const shapes = desc.shapes
    if (!shapes?.length || !this.physics || !this.scene) return false

    const handles: PxMeshHandle[] = []
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pxShapes: any[] = []
    let attached = 0

    for (const shapeDesc of shapes) {
      if (!shapeDesc.geometry) continue
      // Always entity-local for kinematics (baselines + relative shape pose).
      const result = this.createLocalTrimeshShape(
        shapeDesc,
        handles,
        desc,
        false,
        true,
        false,
        false,
        true
      )
      if (!result || result.worldBaked) continue
      pxShapes.push(result.shape)
      attached++
    }

    desc.matrix.decompose(this._pos, this._quat, this._scale)
    this._pos.toPxTransform(this.actorPoseTransform)
    this._quat.toPxTransform(this.actorPoseTransform)

    let actor: any
    try {
      actor = this.physics.createRigidDynamic(this.actorPoseTransform)
      if (typeof actor.setRigidBodyFlag === 'function') {
        actor.setRigidBodyFlag(PHYSX.PxRigidBodyFlagEnum.eKINEMATIC, true)
        // CCT scene queries use the kinematic target pose when set.
        if (PHYSX.PxRigidBodyFlagEnum.eUSE_KINEMATIC_TARGET_FOR_SCENE_QUERIES != null) {
          actor.setRigidBodyFlag(
            PHYSX.PxRigidBodyFlagEnum.eUSE_KINEMATIC_TARGET_FOR_SCENE_QUERIES,
            true
          )
        }
      }
    } catch (err) {
      console.warn('[PhysXWorld] createRigidDynamic kinematic failed:', desc.entity, err)
      for (const h of handles) {
        try {
          h.release()
        } catch {
          /* ignore */
        }
      }
      return false
    }

    for (const pxShape of pxShapes) {
      actor.attachShape(pxShape)
    }

    if (!attached) {
      try {
        this.scene.removeActor?.(actor)
        actor.release?.()
      } catch {
        /* ignore */
      }
      for (const handle of handles) {
        try {
          handle.release()
        } catch {
          /* ignore */
        }
      }
      this.logCookFailedOnce(desc.fingerprint, '[PhysXWorld] kinematic multi-shape cook failed:')
      return false
    }

    this.scene.addActor(actor)
    this.staticActors.set(desc.entity, actor)
    this.registerStaticActor(desc.entity, actor)
    this.pmeshHandles.set(desc.entity, handles)
    this.actorWorldBaked.set(desc.entity, false)
    this.actorIsKinematic.add(desc.entity)
    this.shapeBaselineLocal.set(
      desc.entity,
      shapes.map((shape) => shape.localMatrix.clone())
    )
    this.actorCookScale.set(desc.entity, this._scale.clone())
    this.staticFp.set(desc.entity, desc.fingerprint)
    this.staticPoseFp.set(desc.entity, multiShapePoseFingerprint(desc))
    // Seed kinematic target so CCT sees initial pose.
    if (typeof actor.setKinematicTarget === 'function') {
      actor.setKinematicTarget(this.actorPoseTransform)
    }
    return true
  }

  private addStatic(
    desc: PhysicsColliderDesc,
    persistCook = false,
    preferPersistedCook = false,
    skipWorkerStream = false
  ): boolean {
    desc.matrix.decompose(this._pos, this._quat, this._scale)
    const kind = desc.kind.startsWith('cylinder') ? 'cylinder' : desc.kind.split(':')[0] ?? 'box'

    let geometry: unknown
    let pmeshHandle: PxMeshHandle | null = null

    if ((kind === 'geometry' || kind === 'trimesh') && desc.geometry) {
      try {
        const indexed = ensureIndexedForCook(desc.geometry)
        const bakedGeo = bakeTrimeshGeometry(indexed, desc.matrix)
        if (indexed !== desc.geometry) indexed.dispose()
        if (!isTrimeshGeometryCookable(bakedGeo)) {
          bakedGeo.dispose()
          this.logCookFailedOnce(desc.fingerprint, '[PhysXWorld] trimesh not cookable (degenerate):')
          return false
        }
        const workerKey = bootColliderCookSignature(desc.geometry, desc, undefined, false)
        const cookOpts = {
          cache: false,
          physics: this.physics,
          persistCook,
          preferPersistedCook,
          skipWorkerStream,
          workerStorageKey: workerKey
        }
        // Triangle mesh only (no convex fallback — hollow walls must stay shells).
        pmeshHandle = geometryToPxMesh(this.cookingParams, bakedGeo, false, cookOpts)
        bakedGeo.dispose()
        if (!pmeshHandle?.value) {
          this.logCookFailedOnce(desc.fingerprint, '[PhysXWorld] trimesh cook failed:')
          return false
        }
        {
          const meshFlags = new PHYSX.PxMeshGeometryFlags(PHYSX.PxMeshGeometryFlagEnum.eDOUBLE_SIDED)
          const meshScale = unitPxMeshScale()
          geometry = new PHYSX.PxTriangleMeshGeometry(pmeshHandle.value, meshScale, meshFlags)
          PHYSX.destroy(meshScale)
          PHYSX.destroy(meshFlags)
          this.pmeshHandles.set(desc.entity, [pmeshHandle])
        }
        // Vertices are world-space — actor stays at origin.
        this._pos.set(0, 0, 0)
        this._quat.set(0, 0, 0, 1)
        this._scale.set(1, 1, 1)
        this.actorWorldBaked.set(desc.entity, true)
      } catch (err) {
        this.logCookFailedOnce(desc.fingerprint, '[PhysXWorld] trimesh bake/cook failed:', err)
        return false
      }
    } else if (kind === 'sphere') {
      const r = 0.5 * Math.max(this._scale.x, this._scale.y, this._scale.z)
      geometry = new PHYSX.PxSphereGeometry(r)
    } else if (kind === 'cylinder') {
      const parts = desc.kind.split(':')
      const rt = parseFloat(parts[1] ?? '0.5') * Math.max(this._scale.x, this._scale.z)
      const rb = parseFloat(parts[2] ?? '0.5') * Math.max(this._scale.x, this._scale.z)
      const halfHeight = 0.5 * this._scale.y
      geometry = new PHYSX.PxCapsuleGeometry(Math.max(rt, rb), halfHeight)
    } else if (kind === 'plane') {
      geometry = new PHYSX.PxBoxGeometry(0.5 * this._scale.x, 0.05, 0.5 * this._scale.z)
    } else {
      geometry = new PHYSX.PxBoxGeometry(0.5 * this._scale.x, 0.5 * this._scale.y, 0.5 * this._scale.z)
    }

    const shapeFlags = new PHYSX.PxShapeFlags(
      PHYSX.PxShapeFlagEnum.eSCENE_QUERY_SHAPE | PHYSX.PxShapeFlagEnum.eSIMULATION_SHAPE
    )

    const shape = this.physics.createShape(
      geometry,
      this.defaultMaterial,
      true,
      shapeFlags
    )
    PHYSX.destroy(geometry)

    const isLandscape = desc.fingerprint.includes(':wall:')
    // GLTF trimesh colliders use prop layer — same as MeshCollider (proven CCT blocking).
    const layer = isLandscape ? Layers.environment : Layers.prop
    const filterData = new PHYSX.PxFilterData(layer.group, layer.mask, 0, 0)
    shape.setQueryFilterData(filterData)
    shape.setSimulationFilterData(filterData)

    const transform = new PHYSX.PxTransform(PHYSX.PxIDENTITYEnum.PxIdentity)
    this._pos.toPxTransform(transform)
    this._quat.toPxTransform(transform)

    const actor = this.physics.createRigidStatic(transform)
    actor.attachShape(shape)
    this.scene.addActor(actor)
    this.staticActors.set(desc.entity, actor)
    this.registerStaticActor(desc.entity, actor)
    return true
  }

  private removeStatic(entity: number): void {
    this.unregisterStaticActor(entity)
    const actor = this.staticActors.get(entity)
    this.staticActors.delete(entity)
    this.staticFp.delete(entity)
    this.staticPoseFp.delete(entity)
    this.actorWorldBaked.delete(entity)
    this.actorIsKinematic.delete(entity)
    this.shapeBaselineLocal.delete(entity)
    this.actorCookScale.delete(entity)
    const pmeshList = this.pmeshHandles.get(entity)
    this.pmeshHandles.delete(entity)

    try {
      if (actor && this.scene) {
        this.scene.removeActor(actor)
        if (typeof actor.release === 'function') actor.release()
      }
    } catch (err) {
      console.warn('[PhysXWorld] removeStatic actor failed:', entity, err)
    }

    if (pmeshList) {
      for (const pmesh of pmeshList) {
        try {
          pmesh.release()
        } catch (err) {
          console.warn('[PhysXWorld] removeStatic pmesh failed:', entity, err)
        }
      }
    }
  }

  /**
   * Recook without a floor hole: leave the old actor in the PhysX scene until the new
   * cook registers successfully. On failure, restore maps and keep the previous collider.
   */
  private replaceStaticWithCook(entity: number, cook: () => boolean): boolean {
    const prevActor = this.staticActors.get(entity)
    const prevPmesh = this.pmeshHandles.get(entity)
    const prevFp = this.staticFp.get(entity)
    const prevPoseFp = this.staticPoseFp.get(entity)
    const prevWorldBaked = this.actorWorldBaked.get(entity)
    const prevBaseline = this.shapeBaselineLocal.get(entity)
    const prevCookScale = this.actorCookScale.get(entity)

    if (prevActor) {
      // Detach from maps so cook can own the entity key — actor stays in the scene.
      this.unregisterStaticActor(entity)
      this.staticActors.delete(entity)
      this.pmeshHandles.delete(entity)
      this.staticFp.delete(entity)
      this.staticPoseFp.delete(entity)
      this.actorWorldBaked.delete(entity)
      this.shapeBaselineLocal.delete(entity)
      this.actorCookScale.delete(entity)
    }

    let ok = false
    try {
      ok = cook()
    } catch (err) {
      console.warn('[PhysXWorld] replaceStaticWithCook failed:', entity, err)
      ok = false
    }

    if (ok) {
      if (prevActor) {
        try {
          if (this.scene) this.scene.removeActor(prevActor)
          if (typeof prevActor.release === 'function') prevActor.release()
        } catch (err) {
          console.warn('[PhysXWorld] release previous static actor failed:', entity, err)
        }
      }
      if (prevPmesh) {
        for (const pmesh of prevPmesh) {
          try {
            pmesh.release()
          } catch {
            // ignore
          }
        }
      }
      return true
    }

    // Cook failed — restore previous actor if we had one.
    if (prevActor) {
      this.staticActors.set(entity, prevActor)
      this.registerStaticActor(entity, prevActor)
      if (prevPmesh) this.pmeshHandles.set(entity, prevPmesh)
      if (prevFp !== undefined) this.staticFp.set(entity, prevFp)
      if (prevPoseFp !== undefined) this.staticPoseFp.set(entity, prevPoseFp)
      if (prevWorldBaked !== undefined) this.actorWorldBaked.set(entity, prevWorldBaked)
      if (prevBaseline) this.shapeBaselineLocal.set(entity, prevBaseline)
      if (prevCookScale) this.actorCookScale.set(entity, prevCookScale)
    }
    return false
  }

  /** Tier B — sync PhysX trigger actors for SDK TriggerArea volumes. */
  syncTriggerVolumes(descs: TriggerVolumeDesc[]): void {
    if (!this.physics || !this.scene) return

    const active = new Set<number>()
    for (const desc of descs) {
      active.add(desc.entity)
      const fp = `${desc.mesh}:${matrixFingerprint(desc.matrix)}`
      if (this.triggerFp.get(desc.entity) === fp) continue
      this.removeTriggerVolume(desc.entity)
      if (!this.addTriggerVolume(desc)) continue
      this.triggerFp.set(desc.entity, fp)
    }

    for (const entity of [...this.triggerActors.keys()]) {
      if (!active.has(entity)) {
        this.removeTriggerVolume(entity)
        this.triggerFp.delete(entity)
      }
    }
  }

  /**
   * Optional PhysX path: scene.overlap with a **query geometry** matching the player CCT.
   *
   * Not a second character. The CCT actor shapes are **simulation-only** (no eSCENE_QUERY_SHAPE)
   * so camera sweeps do not self-hit the player — they cannot be the overlap query volume.
   * We reuse the same radius/height as a disposable query capsule at the CCT foot pose.
   */
  queryTriggerVolumesOverlappingPlayer(out: Set<number>): Set<number> {
    out.clear()
    if (!this.scene || !this.controller || !this.playerCapsuleOverlapGeometry || !this.overlapPose) {
      return out
    }

    const foot = this.footPositionFromController(this._v1)
    const halfHeight = (this.capsuleHeight - this.capsuleRadius * 2) / 2
    const centerY = foot.y + this.capsuleRadius + halfHeight
    this._pos.set(foot.x, centerY, foot.z)
    this._pos.toPxTransform(this.overlapPose)
    // PxCapsuleGeometry is X-aligned — rotate to Y-up (same CCT orientation).
    this._quat.setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2)
    this._quat.toPxTransform(this.overlapPose)

    this.applySceneQueryFilter(TRIGGER_QUERY_MASK)
    // Must include statics — trigger volumes are rigid statics.
    try {
      this.queryFilterData.flags = new PHYSX.PxQueryFlags(
        PHYSX.PxQueryFlagEnum.eSTATIC | PHYSX.PxQueryFlagEnum.eDYNAMIC
      )
    } catch {
      // older bindings may not expose flags setter the same way
    }
    const didHit = this.scene.overlap(
      this.playerCapsuleOverlapGeometry,
      this.overlapPose,
      this.overlapResult,
      this.queryFilterData
    )
    if (!didHit) return out

    const nbHits = this.overlapResult.getNbAnyHits()
    for (let i = 0; i < nbHits; i++) {
      const hit = this.overlapResult.getAnyHit(i)
      const entity = this.triggerEntityByActorPtr.get(hit.actor.ptr)
      if (entity !== undefined) out.add(entity)
    }
    return out
  }

  getPlayerCapsuleRadius(): number {
    return this.capsuleRadius
  }

  getPlayerCapsuleHeight(): number {
    return this.capsuleHeight
  }

  private addTriggerVolume(desc: TriggerVolumeDesc): boolean {
    if (!this.physics || !this.scene) return false

    desc.matrix.decompose(this._pos, this._quat, this._scale)
    const meshSphere = desc.mesh === 1
    const sx = Math.abs(this._scale.x)
    const sy = Math.abs(this._scale.y)
    const sz = Math.abs(this._scale.z)
    let geometry
    if (meshSphere) {
      // PhysX has no ellipsoid: isotropic sphere that contains the DCL unit-sphere × scale
      // (max axis). Slightly larger than true math ellipsoid — no false negatives.
      const r = 0.5 * Math.max(sx, sy, sz)
      geometry = new PHYSX.PxSphereGeometry(Math.max(r, 1e-4))
    } else {
      geometry = new PHYSX.PxBoxGeometry(
        Math.max(0.5 * sx, 1e-4),
        Math.max(0.5 * sy, 1e-4),
        Math.max(0.5 * sz, 1e-4)
      )
    }

    const shapeFlags = new PHYSX.PxShapeFlags(
      PHYSX.PxShapeFlagEnum.eTRIGGER_SHAPE | PHYSX.PxShapeFlagEnum.eSCENE_QUERY_SHAPE
    )
    const shape = this.physics.createShape(geometry, this.defaultMaterial, true, shapeFlags)
    PHYSX.destroy(geometry)

    const pairFlags =
      PHYSX.PxPairFlagEnum.eNOTIFY_TOUCH_FOUND | PHYSX.PxPairFlagEnum.eNOTIFY_TOUCH_LOST
    const filterData = new PHYSX.PxFilterData(Layers.trigger.group, Layers.player.group, pairFlags, 0)
    shape.setQueryFilterData(filterData)
    shape.setSimulationFilterData(filterData)

    const transform = new PHYSX.PxTransform(PHYSX.PxIDENTITYEnum.PxIdentity)
    this._pos.toPxTransform(transform)
    this._quat.toPxTransform(transform)

    const actor = this.physics.createRigidStatic(transform)
    actor.attachShape(shape)
    this.scene.addActor(actor)

    this.triggerActors.set(desc.entity, actor)
    this.triggerEntityByActorPtr.set(actor.ptr, desc.entity)
    return true
  }

  private removeTriggerVolume(entity: number): void {
    const actor = this.triggerActors.get(entity)
    if (!actor || !this.scene) return
    try {
      this.scene.removeActor(actor)
    } catch (err) {
      console.warn('[PhysXWorld] removeTriggerVolume scene.removeActor failed:', entity, err)
    }
    this.triggerEntityByActorPtr.delete(actor.ptr)
    try {
      actor.release()
    } catch (err) {
      console.warn('[PhysXWorld] removeTriggerVolume actor.release failed:', entity, err)
    }
    this.triggerActors.delete(entity)
    this.triggerFp.delete(entity)
  }
}

function matrixFingerprint(matrix: THREE.Matrix4): string {
  return matrix.elements.map((n) => n.toFixed(3)).join(',')
}

function multiShapePoseFingerprint(desc: PhysicsColliderDesc): string {
  const parts = [matrixFingerprint(desc.matrix)]
  for (const shape of desc.shapes ?? []) {
    parts.push(matrixFingerprint(shape.localMatrix))
  }
  return parts.join('|')
}

function unitPxMeshScale(): unknown {
  return new PHYSX.PxMeshScale(new PHYSX.PxVec3(1, 1, 1), new PHYSX.PxQuat(0, 0, 0, 1))
}

declare module 'three' {
  interface Vector3 {
    fromPxVec3(pxVec3: { x: number; y: number; z: number }): this
  }
}
