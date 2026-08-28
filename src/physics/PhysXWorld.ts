import * as THREE from 'three'
import { parseParcelKey } from '../dcl/content/parseParcel'
import { PARCEL_SIZE } from '../dcl/content/types'
import { isSceneParcel, parcelKey } from '../dcl/landscape/Utils/ParcelGrid'
import { parcelWorldOrigin } from '../dcl/landscape/Utils/SceneSpace'
import { physxColliderDebug } from '../debug/PhysxColliderDebug'
import { platformMotionDebug } from '../debug/PlatformMotionDebug'
import { clientDebugLog } from '../client/debug/ClientDebugLog'
import { extendThreePhysX } from './extendThreePhysX'
import {
  Layers,
  SOLID_FILTER_OPEN,
  TRIGGER_QUERY_MASK
} from './Layers'
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
import {
  EMPTY_LAND_AOI_COLLIDER_ENTITY_BASE,
  EMPTY_LAND_AOI_COLLIDER_ID_SPAN
} from '../dcl/aoi/emptyParcelLayer'
import { SECONDARY_PHYS_BASE } from '../dcl/multiScene/physOffsets'

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

const _ringShapeBox = new THREE.Box3()
const _ringMat = new THREE.Matrix4()

/**
 * Horizontal distance² from feet to the collider **hull**, not the entity pivot.
 *
 * Winterfest Ice-Rink-1 / Entry_Door_1: authored pivot at local (112, 32) while the
 * mesh AABB covers spawn (~50, 2). A 48 m pivot ring skipped the floor the player
 * was standing on (`groundPhys=-1`). Inside the AABB → 0.
 */
export function colliderHorizDistSq(
  desc: PhysicsColliderDesc,
  feetX: number,
  feetZ: number
): number {
  let minX = Infinity
  let maxX = -Infinity
  let minZ = Infinity
  let maxZ = -Infinity
  let any = false

  const addGeometry = (geometry: THREE.BufferGeometry | undefined, world: THREE.Matrix4): void => {
    if (!geometry) return
    if (!geometry.boundingBox) geometry.computeBoundingBox()
    const bb = geometry.boundingBox
    if (!bb || bb.isEmpty()) return
    _ringShapeBox.copy(bb).applyMatrix4(world)
    if (!Number.isFinite(_ringShapeBox.min.x) || !Number.isFinite(_ringShapeBox.min.z)) return
    minX = Math.min(minX, _ringShapeBox.min.x)
    maxX = Math.max(maxX, _ringShapeBox.max.x)
    minZ = Math.min(minZ, _ringShapeBox.min.z)
    maxZ = Math.max(maxZ, _ringShapeBox.max.z)
    any = true
  }

  if (desc.shapes?.length) {
    for (const shape of desc.shapes) {
      _ringMat.copy(desc.matrix).multiply(shape.localMatrix)
      addGeometry(shape.geometry, _ringMat)
    }
  } else {
    addGeometry(desc.geometry, desc.matrix)
  }

  if (!any) {
    const dx = desc.matrix.elements[12]! - feetX
    const dz = desc.matrix.elements[14]! - feetZ
    return dx * dx + dz * dz
  }

  const cx = feetX < minX ? minX : feetX > maxX ? maxX : feetX
  const cz = feetZ < minZ ? minZ : feetZ > maxZ ? maxZ : feetZ
  const dx = feetX - cx
  const dz = feetZ - cz
  return dx * dx + dz * dz
}

/** Min normal.y to count as walkable floor on CCT shape hits (steep wall bases are ignored). */
const WALKABLE_NORMAL_Y = 0.55
/**
 * Contact must land under the capsule column (not a pad edge meters to the side while
 * walking off into a lower volume). Radius + small margin.
 */
const GROUND_CONTACT_COLUMN_RADIUS = 0.3 + 0.28

/** Unity CharacterController defaults — DCL Foundation uses PhysX CCT with similar tuning. */
const DEG2RAD = Math.PI / 180
const CONTROLLER_SLOPE_LIMIT_DEG = 45
/** Must clear 0.5 m GLTF floor slabs (visibleMeshesCollisionMask: CL_PHYSICS). 0.45 left a lip. */
const CONTROLLER_STEP_OFFSET = 0.55
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
/**
 * Multi-shape GltfContainer parents (phys id = 20_000_000+ecs) expand to one RigidStatic
 * per shape. Child ids live in this range so CCT hits proven single-mesh actors (multi-shape
 * single-actor SQ bounds were soft for walk surfaces — SpaceRunner dome freefall).
 */
const MULTI_SHAPE_CHILD_BASE = 40_000_000
const MULTI_SHAPE_SLOT_STRIDE = 512
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
  /**
   * Parent multi-shape phys id → number of per-shape child actors registered.
   * Parent has no single RigidStatic; children are MULTI_SHAPE_CHILD_BASE+…
   */
  private readonly multiShapeChildCount = new Map<number, number>()
  /** Rate-limit multi-shape expand console spam (thrash diagnosis). */
  private readonly multiShapeExpandLogAt = new Map<number, number>()
  /** Coalesce CCT overlap separate after a burst of tile cooks (not per expand). */
  private pendingCctOverlapSeparate = false
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
  /** Last move() reported eCOLLISION_SIDES (wall/prop contact). */
  private lastCctHitSides = false
  /** Feet pose at start of this movePlayer — jam detection vs actual travel. */
  private readonly _cctMoveStart = new THREE.Vector3()
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

  /** Frame-start actor root world positions — head-crush / overhead only (not riding). */
  private readonly actorRootPoseSnapshot = new Map<number, THREE.Vector3>()
  /**
   * Stand actor world position before ROOT PhysX slide this frame.
   * Riding Δ = post-slide actor pose − this (single law: docs/RIDING_TRANSFER_LAW.md).
   */
  private actorWorldPosBeforeSlide: { entity: number; pos: THREE.Vector3 } | null = null
  /** Stand entity already received this frame’s riding Δ (exactly one author). */
  private ridingDeltaCommittedEntity: number | null = null
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
   * Cook-time shape baselines for relative slides (current * inv(baseline) → setLocalPose).
   * - Entity-local (ROOT solids): baseline = shape.localMatrix at cook
   * - PART (world cook): baseline = entityWorld × localMatrix at cook
   * PxTransform is T+R only — world-relative PART math keeps residual scale out of the pose.
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
   * Boot may still allow; runtime only invalidates the CCT obstacle cache.
   */
  private allowZeroDtWarmSim = true
  /**
   * Boot only: bulk reinsert-all + per-actor remove+add after pose slides.
   * After seal (COD): NEVER reinsert thrash — mass remove+add softs plaza SQ
   * (healthy → MISS within seconds). See docs/STATIC_COLLIDER_COD.md.
   */
  private allowStaticReinsert = true
  /** True after boot seal committed SQ once — blocks bulk reinsert / thrash rebuilds. */
  private staticSqSealed = false
  /** Seal-time forceDynamicTreeRebuild count (0 or 1). Post-seal must stay 0. */
  private sealRebuildCount = 0
  /** Runtime rebuild attempts after seal — COD E1 law: must remain 0. */
  private postSealRebuildCount = 0
  /** Permanent filter data for scene sweeps — avoid temp wrapPointer drops. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private sceneQueryFilterWords: any = null
  /** Permanent CCT query flags — must not be a one-shot that GC can free. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private cctQueryFlags: any = null
  /**
   * Permanent CCT bilateral filter — open solid mask.
   * null mFilterData was unreliable on this WASM (SQ healthy while CCT sides=no).
   * Zero words reject all CCT hits; open non-zero words collide-all solids.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private cctFilterData: any = null
  /** Permanent scene-query flags for sweeps (same GC rule as cctQueryFlags). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private sceneQueryFlags: any = null
  /** Last post-seal SQ heal (rebuild) time — throttle while soft (fast recover). */
  private lastPostSealSqHealMs = 0
  /** Soft windows were 8s+; keep heals responsive without rebuild-every-frame thrash. */
  private static readonly POST_SEAL_SQ_HEAL_COOLDOWN_MS = 1_000

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
  private readonly _v2 = new THREE.Vector3()
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
    // DefaultFilterShader is a static on PxTopLevelFunctions — call via prototype (Hyperfy style).
    try {
      const tlf = PHYSX.PxTopLevelFunctions?.prototype
      sceneDesc.filterShader =
        typeof tlf?.DefaultFilterShader === 'function'
          ? tlf.DefaultFilterShader.call(tlf)
          : PHYSX.DefaultFilterShader()
    } catch {
      sceneDesc.filterShader = PHYSX.DefaultFilterShader()
    }
    sceneDesc.flags.raise(PHYSX.PxSceneFlagEnum.eENABLE_CCD, true)
    sceneDesc.flags.raise(PHYSX.PxSceneFlagEnum.eENABLE_ACTIVE_ACTORS, true)
    sceneDesc.solverType = PHYSX.PxSolverTypeEnum.eTGS
    // eSAP — default sweep-and-prune; works for multi-parcel scenes without MBP region setup.
    // eMBP drops actors outside PxBroadPhase regions → "out of broadphase bounds" + fall-through.
    sceneDesc.broadPhaseType = PHYSX.PxBroadPhaseTypeEnum.eSAP
    // DYNAMIC tree so bulk static addActor lands in SQ without requiring a rebuild every time.
    try {
      sceneDesc.staticStructure = PHYSX.PxPruningStructureTypeEnum.eDYNAMIC_AABB_TREE
      sceneDesc.dynamicStructure = PHYSX.PxPruningStructureTypeEnum.eDYNAMIC_AABB_TREE
    } catch {
      /* optional on older bindings */
    }
    this.scene = this.physics.createScene(sceneDesc)
    try {
      if (typeof this.scene.setSceneQueryUpdateMode === 'function') {
        this.scene.setSceneQueryUpdateMode(
          PHYSX.PxSceneQueryUpdateModeEnum.eBUILD_ENABLED_COMMIT_ENABLED
        )
      }
    } catch {
      /* optional */
    }

    this.sweepPose = new PHYSX.PxTransform(PHYSX.PxIDENTITYEnum.PxIdentity)
    // PxSweepBuffer10 is the fixed-capacity buffer PhysX-js examples use; PxSweepResult can
    // report didHit=false forever on some WASM builds with 1000+ statics.
    this.sweepResult =
      typeof PHYSX.PxSweepBuffer10 === 'function'
        ? new PHYSX.PxSweepBuffer10()
        : new PHYSX.PxSweepResult()
    this.queryFilterData = new PHYSX.PxQueryFilterData()
    // Zero words = PhysX default "accept all" for scene queries (not a color / not new colliders).
    // Solid shapes still carry group bits; CCT ignores eTRIGGER_SHAPE for blocking.
    // Non-zero bilateral words required for CCT. word0=word1=0 rejects ALL CCT hits
    // (sweep may still special-case zero → false “SQ healthy” while player walks through walls).
    this.sceneQueryFilterWords = new PHYSX.PxFilterData(
      Layers.player.group,
      SOLID_FILTER_OPEN,
      0,
      0
    )
    this.queryFilterData.data = this.sceneQueryFilterWords
    try {
      this.sceneQueryFlags = new PHYSX.PxQueryFlags(
        PHYSX.PxQueryFlagEnum.eSTATIC | PHYSX.PxQueryFlagEnum.eDYNAMIC
      )
      this.queryFilterData.flags = this.sceneQueryFlags
    } catch {
      /* optional */
    }
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

    const filterData = new PHYSX.PxFilterData(
      Layers.environment.group,
      SOLID_FILTER_OPEN,
      0,
      0
    )
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
    // Open bilateral CCT filter (permanent object — never GC, never zero words).
    // null mFilterData looked correct in docs but left plaza CCT soft while sphere SQ hit.
    // eTRIGGER_SHAPE is still ignored by the controller for blocking.
    this.controllerFilters = new PHYSX.PxControllerFilters()
    this.cctFilterData = new PHYSX.PxFilterData(Layers.player.group, SOLID_FILTER_OPEN, 0, 0)
    this.controllerFilters.mFilterData = this.cctFilterData
    // No ePREFILTER — custom preFilter was a soft-world footgun.
    this.cctQueryFlags = new PHYSX.PxQueryFlags(
      PHYSX.PxQueryFlagEnum.eSTATIC | PHYSX.PxQueryFlagEnum.eDYNAMIC
    )
    this.controllerFilters.mFilterFlags = this.cctQueryFlags
    this.controllerFilters.mFilterCallback = null

    const cctFilterCallback = new PHYSX.PxControllerFilterCallbackImpl()
    cctFilterCallback.filter = () => true
    this.controllerFilters.mCCTFilterCallback = cctFilterCallback
  }

  /** Re-pin CCT open filter each move / heal — WASM can drop dangling filter pointers. */
  private pinCctFilters(): void {
    if (!this.controllerFilters || !this.cctQueryFlags) return
    this.controllerFilters.mFilterFlags = this.cctQueryFlags
    if (!this.cctFilterData) {
      this.cctFilterData = new PHYSX.PxFilterData(Layers.player.group, SOLID_FILTER_OPEN, 0, 0)
    } else {
      try {
        this.cctFilterData.word0 = Layers.player.group
        this.cctFilterData.word1 = SOLID_FILTER_OPEN
      } catch {
        this.cctFilterData = new PHYSX.PxFilterData(Layers.player.group, SOLID_FILTER_OPEN, 0, 0)
      }
    }
    try {
      this.controllerFilters.mFilterData = this.cctFilterData
    } catch {
      /* omit */
    }
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
    // Explorer-like: steep faces (sphere sides, wall tops) do not become ladders.
    desc.nonWalkableMode =
      PHYSX.PxControllerNonWalkableModeEnum.ePREVENT_CLIMBING_AND_FORCE_SLIDING
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
    this.pinCctFilters()
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

    const hitFlags =
      (PHYSX.PxHitFlagEnum.eDEFAULT ?? 0) |
      (PHYSX.PxHitFlagEnum.ePOSITION ?? 0) |
      (PHYSX.PxHitFlagEnum.eNORMAL ?? 0) |
      (PHYSX.PxHitFlagEnum.eMESH_BOTH_SIDES ?? 0)
    const didHit = this.scene.sweep(
      this.cameraSweepGeometry,
      this.sweepPose,
      down,
      maxDrop,
      this.sweepResult,
      hitFlags || PHYSX.PxHitFlagEnum.eDEFAULT,
      this.queryFilterData
    )
    if (!didHit) return null

    const nbHits = this.sweepResult.getNbAnyHits?.() ?? 1
    let bestY: number | null = null
    let bestScore = Number.POSITIVE_INFINITY
    let anyDist: number | null = null
    for (let i = 0; i < nbHits; i++) {
      const hit = this.sweepResult.getAnyHit(i)
      const dist = hit?.distance
      if (typeof dist === 'number' && Number.isFinite(dist) && anyDist === null) {
        anyDist = dist
      }
      const ny = hit?.normal?.y
      // Prefer upward normals; if normal missing (flag not filled), still accept hit.
      if (typeof ny === 'number' && Number.isFinite(ny) && ny < 0.45) continue
      const hitY = fromY - (dist ?? 0)
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
    // Fallback: had hits but all failed normal gate — still use nearest distance.
    if (bestY === null && anyDist != null) {
      bestY = fromY - anyDist
    }
    return bestY
  }

  isKinematicActor(entity: number): boolean {
    return this.actorIsKinematic.has(entity)
  }

  /**
   * Platform PART motion — child/bone hulls moved relative to entity root.
   * Scene-agnostic. Caller already filtered to hulls whose **live world fingerprint changed**.
   *
   * PhysX triangle meshes cannot track child/bone motion via setLocalPose alone
   * (pose is T+R only; residual scale is dropped; SQ bounds lag). PART therefore
   * **re-cooks world-space hulls** for those entities only — not the whole scene.
   *
   * No cook budget: the fingerprint gate is the thrash guard. Capping cooks caused
   * movers to be skipped and left on stale hulls.
   *
   * ROOT solids stay entity-local cook-once + actor T+R (never enter this API).
   *
   * @returns `doneIds` — entities actually updated this call
   */
  applyPartColliderMotions(
    descs: PhysicsColliderDesc[]
  ): { updated: number; cooked: number; doneIds: number[] } {
    if (!descs.length) return { updated: 0, cooked: 0, doneIds: [] }

    const rootOnly: PhysicsColliderDesc[] = []
    const worldCook: PhysicsColliderDesc[] = []
    const doneIds: number[] = []

    for (const desc of descs) {
      if (!desc.shapes?.length) rootOnly.push(desc)
      else worldCook.push(desc)
    }

    let updated = 0
    if (rootOnly.length) {
      const n = this.applyStaticColliderPoseUpdates(rootOnly, {
        force: true,
        forceEntities: new Set(rootOnly.map((d) => d.entity)),
        actorRootOnly: true
      })
      updated += n
      if (n > 0) for (const d of rootOnly) doneIds.push(d.entity)
    }

    let cooked = 0
    if (worldCook.length) {
      // Do NOT wipe parent fps before cook. Deleting staticPoseFp made poseMoved always
      // true → full multi-shape re-expand every PART tick (curtains e541 → 13 FPS).
      // forceRecookOnPoseChange already re-bakes when multiShapePoseFingerprint moves;
      // when idle, pose gate no-ops and hulls stay solid.
      // Do NOT invalidate first — mid-walk soft hole (solids vanish until cook finishes).
      try {
        const result = this.syncStaticColliders(worldCook, {
          cookBudget: worldCook.length,
          freezeRemoval: true,
          forceRecookOnPoseChange: true,
          geometryCache: false,
          skipWorkerStream: true
        })
        // Expanded multi-shape parents live as children only — hasStaticActor, not staticActors.
        // Returning empty doneIds left World.partMotionPoseFp unlatched → re-queue thrash.
        for (const desc of worldCook) {
          if (!this.hasStaticActor(desc.entity)) continue
          doneIds.push(desc.entity)
          if (result.geometryChanged) cooked++
        }
        if (result.geometryChanged) {
          updated += cooked
          // COD: PART cooks use replaceStaticWithCook (addActor) — never forceDynamicTreeRebuild.
          this.invalidateControllerCache()
        } else if (doneIds.length) {
          // Idle/no-op cook still acks PART so World can latch poseFp and stop calling us.
          updated += doneIds.length
        }
      } catch (err) {
        console.warn('[PhysXWorld] PART world hull cook failed', err)
      }
    }

    return { updated, cooked, doneIds }
  }

  /**
   * Ensure multi-shape collider is a **kinematic** rigid dynamic (legacy / root kinematic).
   * PART child/bone motion uses {@link applyPartColliderMotions} instead.
   */
  ensureKinematicMultiShape(desc: PhysicsColliderDesc): boolean {
    if (!desc.shapes?.length || !this.physics || !this.scene) return false
    if (this.actorIsKinematic.has(desc.entity) && this.staticActors.has(desc.entity)) {
      if (this.geomFingerprintMatches(desc) && this.hasShapeBaselines(desc.entity)) return true
    }
    if (this.staticActors.has(desc.entity)) this.removeStatic(desc.entity)
    return this.addMultiShapeKinematic(desc)
  }

  /**
   * Pose kinematic multi-shape (entity T+R + relative shape locals). Prefer
   * {@link applyPartColliderMotions} for Animator PART / child hull motion.
   */
  updateKinematicMultiShapePose(desc: PhysicsColliderDesc): boolean {
    if (!this.ensureKinematicMultiShape(desc)) return false
    const actor = this.staticActors.get(desc.entity)
    if (!actor) return false
    if (!this.matrixHasFinitePose(desc.matrix)) return false
    if (!desc.shapes?.length) return false
    for (const shape of desc.shapes) {
      if (!this.matrixHasFinitePose(shape.localMatrix)) return false
    }
    try {
      let nb = 0
      try {
        nb = actor.getNbShapes()
      } catch {
        return false
      }
      if (nb !== desc.shapes.length) {
        this.removeStatic(desc.entity)
        if (!this.ensureKinematicMultiShape(desc)) return false
      }
      const act = this.staticActors.get(desc.entity)
      if (!act) return false
      if (!this.updateMultiShapeActorPose(act, desc, true, { skipScaleCheck: true })) return false
      this.staticFp.set(desc.entity, desc.fingerprint)
      this.staticPoseFp.set(desc.entity, multiShapePoseFingerprint(desc))
      // Kinematic: setKinematicTarget already set — no static reinsert.
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
    for (const parentId of [...this.multiShapeChildCount.keys()]) {
      this.removeMultiShapeChildren(parentId)
      this.staticFp.delete(parentId)
      this.staticPoseFp.delete(parentId)
    }
    for (const entity of [...this.staticActors.keys()]) {
      if (this.isGltfStaticActor(entity) || entity >= MULTI_SHAPE_CHILD_BASE) {
        this.removeStatic(entity)
      }
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
      if (keepRoads && this.isAoiEmptyLandColliderEntity(entity)) continue
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
      if (this.isAoiEmptyLandColliderEntity(entity)) continue
      this.staticFp.delete(entity)
      this.staticPoseFp.delete(entity)
      n++
    }
    return n
  }

  /** Remove one static actor + sync fingerprints — boot cook always recooks fresh. */
  invalidateStaticCollider(entity: number): void {
    if (entity === INFINITE_GROUND_ENTITY) return
    // Multi-shape parents expand to child actors — drop the whole expansion.
    if (this.multiShapeChildCount.has(entity) || this.staticFp.get(entity)?.startsWith('gltf-entity:')) {
      this.removeMultiShapeChildren(entity)
    }
    if (this.staticActors.has(entity)) this.removeStatic(entity)
    this.staticFp.delete(entity)
    this.staticPoseFp.delete(entity)
    this.actorWorldBaked.delete(entity)
    this.invalidateControllerCache()
  }

  /** True when a cooked actor exists and geometry fingerprint still matches the live desc. */
  geomFingerprintMatches(desc: PhysicsColliderDesc): boolean {
    return this.staticFp.get(desc.entity) === desc.fingerprint
  }

  isWorldBakedStatic(entity: number): boolean {
    // Multi-shape GLTF expands to child actors only — parent still owns actorWorldBaked.
    return this.actorWorldBaked.get(entity) === true && this.hasStaticActor(entity)
  }

  /**
   * Entity world scale baked into verts at cook (entity-local or world-baked multi-shape).
   * Pose slides are T+R only — scale grow (pixelwars tile tween 1e-3→2) must recook.
   */
  hasCookScaleDrift(desc: PhysicsColliderDesc, relTol = 0.04): boolean {
    const cookScale = this.actorCookScale.get(desc.entity)
    if (!cookScale) return false
    if (!this.matrixHasFinitePose(desc.matrix)) return false
    desc.matrix.decompose(this._pos, this._quat, this._scale)
    const rel = (a: number, b: number) => {
      const den = Math.max(Math.abs(a), Math.abs(b), 1e-4)
      return Math.abs(a - b) / den
    }
    return (
      rel(this._scale.x, cookScale.x) > relTol ||
      rel(this._scale.y, cookScale.y) > relTol ||
      rel(this._scale.z, cookScale.z) > relTol
    )
  }

  /** True when live scale is smaller than the cooked hull on any axis (stale solid is a wall). */
  hasCookScaleShrink(desc: PhysicsColliderDesc, relTol = 0.04): boolean {
    const cookScale = this.actorCookScale.get(desc.entity)
    if (!cookScale) return false
    if (!this.matrixHasFinitePose(desc.matrix)) return false
    desc.matrix.decompose(this._pos, this._quat, this._scale)
    const smaller = (live: number, cooked: number) => {
      const den = Math.max(Math.abs(cooked), 1e-4)
      return cooked - live > relTol * den
    }
    return (
      smaller(this._scale.x, cookScale.x) ||
      smaller(this._scale.y, cookScale.y) ||
      smaller(this._scale.z, cookScale.z)
    )
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
    // Multi-shape parents have no single actor — children are the solids.
    if (desc.shapes?.length) {
      if (!this.hasStaticActor(desc.entity)) return false
    } else if (!this.staticActors.has(desc.entity)) {
      return false
    }
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
   *
   * **COD / Explorer:** Static plaza hulls are cooked into SQ once. Unmoved statics must
   * **never** reinsert (already in the tree). `force` does **not** bypass no-op pose skip.
   * PART/kinematic movers update pose without mass static reinsert; boot seal does one rebuild.
   *
   * @param options.actorRootOnly — multi-shape: only set actor global T+R from desc.matrix.
   * @param options.forceEntities — PART shape-motion allow-list only (not “force reinsert”).
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
    let shapeLocalsChanged = false
    for (const desc of descs) {
      if (this.failedCookFp.has(desc.fingerprint)) continue
      if (forceEntities && !forceAll && !forceEntities.has(desc.entity)) continue
      // Shape-motion only for explicit PART allow-list — not forceAll root noise.
      const shapeMotion = !!forceEntities && forceEntities.has(desc.entity) && !actorRootOnly

      if (desc.shapes?.length) {
        if (!this.geomFingerprintMatches(desc)) continue
        const actor = this.staticActors.get(desc.entity)
        if (!actor) continue
        const worldBaked = this.actorWorldBaked.get(desc.entity) === true
        const poseFp = multiShapePoseFingerprint(desc)

        // World-baked: verts fixed in world space at cook. Root-only slides are no-ops.
        if (worldBaked && (actorRootOnly || !shapeMotion)) continue

        if (actorRootOnly || !shapeMotion) {
          // Plaza static ROOT — skip if pose unchanged (force does not reinsert unmoved).
          if (!this.matrixHasFinitePose(desc.matrix)) continue
          if (this.staticPoseFp.get(desc.entity) === poseFp) continue
          // Scale drift cannot be fixed by T+R slide — leave geom unsynced for recook queue.
          if (!worldBaked && this.hasCookScaleDrift(desc)) {
            if (this.staticFp.has(desc.entity)) this.staticFp.delete(desc.entity)
            continue
          }
          if (!worldBaked && !this.isPoseSlideSafe(actor, desc)) {
            if (this.staticFp.has(desc.entity)) {
              this.staticFp.delete(desc.entity)
            }
            // Do not ack poseFp — caller must recook (unsafe slide left soft furniture).
            continue
          }
          try {
            desc.matrix.decompose(this._pos, this._quat, this._scale)
            this._pos.toPxTransform(this.actorPoseTransform)
            this._quat.toPxTransform(this.actorPoseTransform)
            actor.setGlobalPose(this.actorPoseTransform)
            // After seal: no reinsert — mass remove+add thrash softs plaza SQ.
            // Boot only: reinsertStaticActorForSceneQuery is gated by allowStaticReinsert.
            this.reinsertStaticActorForSceneQuery(actor)
            this.staticPoseFp.set(desc.entity, poseFp)
            updated++
          } catch (err) {
            console.warn('[PhysXWorld] multi-shape root pose slide failed:', desc.entity, err)
          }
          continue
        }

        // PART shape-motion only.
        if (this.staticPoseFp.get(desc.entity) === poseFp) continue
        if (!worldBaked && !this.isPoseSlideSafe(actor, desc)) {
          continue
        }
        if (worldBaked && !this.hasShapeBaselines(desc.entity)) continue
        try {
          const kinematic = this.actorIsKinematic.has(desc.entity)
          if (
            !this.updateMultiShapeActorPose(actor, desc, kinematic, {
              skipScaleCheck: worldBaked
            })
          ) {
            continue
          }
          this.staticPoseFp.set(desc.entity, poseFp)
          updated++
          shapeLocalsChanged = true
          // Kinematic: SQ follows setKinematicTarget. Static PART: boot-only reinsert if allowed.
          if (!kinematic) {
            this.reinsertStaticActorForSceneQuery(actor)
          }
        } catch (err) {
          console.warn('[PhysXWorld] multi-shape pose slide failed:', desc.entity, err)
        }
        continue
      }

      if (!this.geomFingerprintMatches(desc)) continue
      const poseFp = matrixFingerprint(desc.matrix)
      // Always skip no-op — force must not reinsert unmoved primitives.
      if (this.staticPoseFp.get(desc.entity) === poseFp) continue
      const actor = this.staticActors.get(desc.entity)
      if (!actor || this.actorWorldBaked.get(desc.entity)) continue
      if (!this.matrixHasFinitePose(desc.matrix)) continue
      // Box/sphere extents are cooked from scale — T+R slide cannot shrink a 1.5 m hull.
      if (this.hasCookScaleDrift(desc)) {
        if (this.staticFp.has(desc.entity)) this.staticFp.delete(desc.entity)
        continue
      }
      try {
        desc.matrix.decompose(this._pos, this._quat, this._scale)
        this._pos.toPxTransform(this.actorPoseTransform)
        this._quat.toPxTransform(this.actorPoseTransform)
        actor.setGlobalPose(this.actorPoseTransform)
        // Boot-only reinsert (allowStaticReinsert). After seal: pose only — no thrash.
        this.reinsertStaticActorForSceneQuery(actor)
        this.staticPoseFp.set(desc.entity, poseFp)
        updated++
      } catch (err) {
        console.warn('[PhysXWorld] primitive pose slide failed:', desc.entity, err)
        this.invalidateStaticCollider(desc.entity)
      }
    }
    if (updated > 0 || shapeLocalsChanged) {
      this.invalidateControllerCache()
    }
    return updated
  }

  /**
   * Sticky demote / origin rebase: world-baked hulls sit at actor identity with
   * verts in the old world. Slide the actor T by the new scene-root offset —
   * never recook (that re-expanded plaza 144-shape GLBs → 6 fps).
   */
  translateWorldBakedColliders(
    descs: PhysicsColliderDesc[],
    dx: number,
    dy: number,
    dz: number
  ): number {
    if (!descs.length) return 0
    if (dx === 0 && dy === 0 && dz === 0) return 0
    const seen = new Set<number>()
    let n = 0
    for (const desc of descs) {
      const childCount = this.multiShapeChildCount.get(desc.entity) ?? 0
      const ids = [desc.entity]
      for (let i = 0; i < childCount; i++) ids.push(multiShapeChildPhysId(desc.entity, i))
      for (const id of ids) {
        if (seen.has(id)) continue
        seen.add(id)
        if (this.translateOneStaticActor(id, dx, dy, dz)) n++
      }
      this.staticPoseFp.set(desc.entity, multiShapePoseFingerprint(desc))
    }
    if (n > 0) this.invalidateControllerCache()
    return n
  }

  private translateOneStaticActor(entity: number, dx: number, dy: number, dz: number): boolean {
    const actor = this.staticActors.get(entity)
    if (!actor) return false
    if (!this.readActorWorldPosition(entity, this._pos)) {
      this._pos.set(0, 0, 0)
    }
    this._pos.x += dx
    this._pos.y += dy
    this._pos.z += dz
    this._quat.set(0, 0, 0, 1)
    try {
      this._pos.toPxTransform(this.actorPoseTransform)
      this._quat.toPxTransform(this.actorPoseTransform)
      actor.setGlobalPose(this.actorPoseTransform)
      this.reinsertStaticActorForSceneQuery(actor)
      return true
    } catch (err) {
      console.warn('[PhysXWorld] world-baked translate failed:', entity, err)
      return false
    }
  }

  /**
   * Runtime no-op after seal. Prefer {@link invalidateControllerCache}.
   * Boot seal owns the single SQ commit (see {@link sealStaticSceneQuery}).
   */
  rebuildStaticSceneQueryTree(): void {
    this.invalidateControllerCache()
  }

  /** True when actor is currently attached to our PhysX scene. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private actorInScene(actor: any): boolean {
    if (!actor || !this.scene) return false
    try {
      const s = typeof actor.getScene === 'function' ? actor.getScene() : null
      if (!s) return false
      // Pointer equality — both wrappers should share ptr when same scene.
      return s === this.scene || s?.ptr === this.scene?.ptr
    } catch {
      return false
    }
  }

  /**
   * Boot-only remove+add so SQ AABBs match after pose slides.
   * After seal this is a no-op — continuous reinsert softs plaza SQ (didHit flip loop).
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private reinsertStaticActorForSceneQuery(actor: any): void {
    if (!this.allowStaticReinsert) return
    if (!this.scene || !actor) return
    try {
      if (this.actorInScene(actor)) {
        this.scene.removeActor(actor)
      }
      this.scene.addActor(actor)
    } catch (err) {
      console.warn('[PhysXWorld] reinsert static actor for SQ failed:', err)
    }
  }

  /**
   * **Boot seal only** — re-add actors missing from the PhysX scene (map orphans).
   * Does **not** remove+add healthy actors (that can leave map-only ghosts on WASM fail).
   * After {@link sealStaticSceneQuery} this is a no-op forever.
   */
  reinsertAllStaticActorsForSceneQuery(): number {
    if (!this.allowStaticReinsert || !this.scene || this.staticSqSealed) return 0
    let inScene = 0
    let readded = 0
    for (const actor of this.staticActors.values()) {
      if (!actor) continue
      if (this.actorInScene(actor)) {
        inScene++
        continue
      }
      try {
        this.scene.addActor(actor)
        readded++
      } catch (err) {
        console.warn('[PhysXWorld] orphan addActor failed', err)
      }
    }
    try {
      if (typeof this.scene.flushQueryUpdates === 'function') {
        this.scene.flushQueryUpdates()
      }
    } catch {
      /* optional API */
    }
    this.invalidateControllerCache()
    console.warn(
      `[PhysXWorld] seal membership — inScene=${inScene} orphansReadded=${readded} map=${this.staticActors.size}`
    )
    return readded
  }

  /**
   * Re-apply open solid query/simulation filters on every static shape.
   * Fixes plaza soft when shapes were cooked under a stale narrow mask.
   */
  reapplySolidShapeFilters(): number {
    if (!this.physics || !this.scene) return 0
    let n = 0
    for (const [entity, actor] of this.staticActors) {
      if (!actor || entity === undefined) continue
      try {
        const nb = actor.getNbShapes?.() ?? 0
        if (nb <= 0) continue
        const buf = new PHYSX.PxArray_PxShapePtr(nb)
        actor.getShapes(buf.begin(), nb, 0)
        // Ground / landscape / GLTF solids — open bilateral. Triggers use a different map.
        const filterData = new PHYSX.PxFilterData(
          entity === INFINITE_GROUND_ENTITY ? Layers.environment.group : Layers.prop.group,
          SOLID_FILTER_OPEN,
          0,
          0
        )
        for (let i = 0; i < nb; i++) {
          const shape = buf.get(i)
          if (!shape) continue
          shape.setQueryFilterData(filterData)
          shape.setSimulationFilterData(filterData)
          n++
        }
        try {
          PHYSX.destroy(buf)
        } catch {
          /* ignore */
        }
      } catch {
        /* skip actor */
      }
    }
    return n
  }

  /**
   * Seal-time SQ diagnostic — raw sweep didHit (no normal gate).
   * Logs filter-open probe so MISS is diagnosable as SQ-dead vs filter vs normal reject.
   * Pass `quiet: true` for the mid-play watchdog (no console spam every 500ms).
   */
  diagnoseSceneQueryAt(
    x: number,
    y: number,
    z: number,
    label = 'sq-diag',
    options?: { quiet?: boolean }
  ): {
    didHit: boolean
    distance: number | null
    normalY: number | null
    inScene: number
    map: number
  } {
    const quiet = options?.quiet === true
    this.ensureCameraSweepGeometry()
    let inScene = 0
    for (const actor of this.staticActors.values()) {
      if (this.actorInScene(actor)) inScene++
    }
    const map = this.staticActors.size
    if (!this.scene || !this.cameraSweepGeometry) {
      if (!quiet) {
        console.warn(`[phys] ${label} — no scene/sweepGeom map=${map} inScene=${inScene}`)
      }
      return { didHit: false, distance: null, normalY: null, inScene, map }
    }

    // Open bilateral filter (never zero words).
    this.applySceneQueryFilter(0)

    this._v1.set(x, y + 2.5, z)
    this._v1.toPxVec3(this.sweepPose.p)
    try {
      this._identityQuat.set(0, 0, 0, 1)
      this._identityQuat.toPxTransform(this.sweepPose)
    } catch {
      /* pose may only expose .p */
    }
    const down = this._pv2
    down.x = 0
    down.y = -1
    down.z = 0

    const hitFlags =
      (PHYSX.PxHitFlagEnum.eDEFAULT ?? 1) |
      (PHYSX.PxHitFlagEnum.ePOSITION ?? 0) |
      (PHYSX.PxHitFlagEnum.eNORMAL ?? 0) |
      (PHYSX.PxHitFlagEnum.eMESH_BOTH_SIDES ?? 0)

    let didHit = false
    let distance: number | null = null
    let normalY: number | null = null
    try {
      didHit = !!this.scene.sweep(
        this.cameraSweepGeometry,
        this.sweepPose,
        down,
        8,
        this.sweepResult,
        hitFlags,
        this.queryFilterData
      )
      if (didHit) {
        const hit = this.sweepResult.getAnyHit(0)
        distance = typeof hit?.distance === 'number' ? hit.distance : null
        normalY = typeof hit?.normal?.y === 'number' ? hit.normal.y : null
      }
    } catch (err) {
      if (!quiet) console.warn(`[phys] ${label} sweep threw`, err)
    }

    // warn only when logging is wanted (seal/health); quiet watchdog stays silent on healthy hits.
    if (!quiet) {
      console.warn(
        `[phys] ${label} didHit=${didHit} dist=${distance != null ? distance.toFixed(3) : 'n/a'} ` +
          `ny=${normalY != null ? normalY.toFixed(2) : 'n/a'} map=${map} inScene=${inScene} ` +
          `buf=${this.sweepResult?.__class__?.name ?? typeof this.sweepResult} ` +
          `at=(${x.toFixed(1)},${y.toFixed(1)},${z.toFixed(1)})`
      )
    }
    return { didHit, distance, normalY, inScene, map }
  }

  /** True when this geom fingerprint already failed cook (skip re-queue thrash). */
  hasFailedCookFingerprint(fingerprint: string): boolean {
    return this.failedCookFp.has(fingerprint)
  }

  isColliderSynced(desc: PhysicsColliderDesc): boolean {
    if (this.failedCookFp.has(desc.fingerprint)) return false
    // Cook-scale mismatch = unsynced even when geom fp + children look live
    // (world-baked multi-shape tile grow left tiny hulls while isColliderSynced stayed true).
    if (this.hasCookScaleDrift(desc)) return false

    if (desc.shapes?.length) {
      const geomFp = desc.fingerprint
      if (this.staticFp.get(desc.entity) !== geomFp) return false
      // Expanded to one actor per shape — every cookable shape must be live.
      // Permanently uncookable children (degenerate trimesh) are not expected:
      // requiring them left boot drain recooking N-1/N forever (stuck at 97%).
      // Do NOT require exact poseFp match: float noise / Animator slides change pose
      // every frame and left the boot cook queue non-empty forever (stuck ~79% load,
      // no logs — main thread re-cooking multi-shape hulls).
      const { expected, live } = this.countCookableMultiShapeLive(desc)
      return expected > 0 && live === expected
    }

    const poseFp = matrixFingerprint(desc.matrix)
    if (this.staticFp.get(desc.entity) !== desc.fingerprint) return false
    if (!this.staticActors.has(desc.entity)) return false
    return this.staticPoseFp.get(desc.entity) === poseFp
  }

  hasStaticActor(entity: number): boolean {
    if (this.staticActors.has(entity)) return true
    return (this.multiShapeChildCount.get(entity) ?? 0) > 0
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
        const { expected: expectedShapes, live: liveShapes } =
          this.countCookableMultiShapeLive(desc)
        const shapeCountOk = expectedShapes > 0 && liveShapes === expectedShapes

        // Scale grow (tile tween) bakes into world-space verts — geom fp stays identical while
        // hull stays at cook-time scale. Must fall through to replaceStatic, not pose-ack.
        const scaleDrift = this.hasCookScaleDrift(desc)
        // PART doors/curtains: bone motion updates shape.localMatrix while geom fps stay
        // identical. forceRecookOnPoseChange must recook when poseFp moved — but NOT every
        // call (that re-expanded 5 curtain actors every frame → 13 FPS). Gate on pose change.
        const forcePoseRecook = options?.forceRecookOnPoseChange === true || bootStyleCook
        const poseMoved = this.staticPoseFp.get(desc.entity) !== poseFp

        // Children live + nothing structural/pose-motion needs work → keep solids.
        if (shapeCountOk && !scaleDrift) {
          if (forcePoseRecook) {
            // PART: only re-bake when multi-shape pose fingerprint actually moved.
            if (!poseMoved && prevGeomFp === geomFp) {
              continue
            }
            // poseMoved or geom string noise → fall through to expand/replace.
          } else if (prevGeomFp === geomFp) {
            this.staticPoseFp.set(desc.entity, poseFp)
            continue
          } else {
            // Geom string noise only: adopt parent fp if per-shape child fps still match.
            let childFpOk = true
            for (let i = 0; i < desc.shapes.length; i++) {
              const shape = desc.shapes[i]!
              if (!shape.geometry) continue
              const childFp = this.staticFp.get(multiShapeChildPhysId(desc.entity, i))
              if (childFp !== undefined && childFp !== shape.fingerprint) {
                childFpOk = false
                break
              }
            }
            if (childFpOk) {
              this.staticFp.set(desc.entity, geomFp)
              this.staticPoseFp.set(desc.entity, poseFp)
              continue
            }
          }
        }

        if (
          prevGeomFp &&
          prevGeomFp !== geomFp &&
          shapeCountOk &&
          !options?.forceRecookOnPoseChange &&
          !bootStyleCook
        ) {
          // Prefer stale solid over mid-walk hole.
          pendingCooks++
          continue
        }
        // Geom fingerprint changed (late GLB attach / re-extract): always fall through to
        // replaceStaticWithCook. Skipping left wrong/empty hulls forever while play mode
        // used forceRecookOnPoseChange:false — walk-through furniture with static=700+ still.

        if (prevGeomFp && prevGeomFp !== geomFp) {
          this.failedCookFp.delete(prevGeomFp)
          this.loggedFailedCookFp.delete(prevGeomFp)
        }
        if (this.failedCookFp.has(geomFp)) {
          if (shapeCountOk) continue
          continue
        }

        if (cooksRemaining <= 0) {
          pendingCooks++
          continue
        }

        // Sticky/PE offset hulls already in SQ (rekey+translate). Expanding them
        // after promote recooked plaza 144-shape GLBs on the main thread (4fps).
        if (
          desc.entity >= SECONDARY_PHYS_BASE &&
          this.hasStaticActor(desc.entity) &&
          !options?.forceRecookOnPoseChange &&
          !bootStyleCook
        ) {
          this.staticPoseFp.set(desc.entity, poseFp)
          if (prevGeomFp !== geomFp) this.staticFp.set(desc.entity, geomFp)
          continue
        }

        try {
          // Expand multi-shape → one single-mesh RigidStatic per shape (CCT-solid path).
          const ok = this.addMultiShapeStatic(desc, {
            persistCook,
            preferPersistedCook,
            skipWorkerStream
          })
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
            // Boot-only reinsert (gated). After seal: pose slide only.
            this.reinsertStaticActorForSceneQuery(actor)
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
      // New cooks reinsert via addActor; full tree rebuild mid-slide can soft the SQ.
      // Prefer CCT cache invalidate (feat/aoi-focus-owner solids-stay).
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
   * COD: never forceDynamicTreeRebuild (docs/STATIC_COLLIDER_COD.md).
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
   * Call once after boot cook. COD (docs/STATIC_COLLIDER_COD.md):
   *
   * 1. Open solid shape filters (bilateral never rejects hulls)
   * 2. Re-add scene orphans only (no mass remove+add)
   * 3. flushQueryUpdates
   * 4. **One** forceDynamicTreeRebuild at seal only (always — commit SQ tree)
   * 5. Freeze thrash forever — post-seal heal must never rebuild (COD E1)
   *
   * Late single-actor cooks still reinsert once inside {@link addStatic}.
   */
  sealStaticSceneQuery(): void {
    this.allowZeroDtWarmSim = false
    this.ensureInfiniteGroundPlane()
    const n = this.staticActors.size

    let orphans = 0
    let filters = 0
    let rebuilt = false
    let probeBefore = 'n/a'
    let probeAfter = 'n/a'

    if (!this.staticSqSealed && this.scene) {
      filters = this.reapplySolidShapeFilters()
      orphans = this.reinsertAllStaticActorsForSceneQuery()
      try {
        if (typeof this.scene.flushQueryUpdates === 'function') {
          this.scene.flushQueryUpdates()
        }
      } catch {
        /* optional */
      }
      this.invalidateControllerCache()

      // Spawn-priority probe point (caller may have set controller already or not).
      const px = this.position?.x ?? 0
      const py = this.position?.y ?? 0
      const pz = this.position?.z ?? 0
      const d0 = this.diagnoseSceneQueryAt(px, py, pz, 'seal-before-rebuild')
      probeBefore = d0.didHit
        ? `hit d=${d0.distance?.toFixed(2)} ny=${d0.normalY?.toFixed(2)}`
        : 'MISS'

      // Always one static rebuild at seal — plaza SQ dies mid-play without a committed tree
      // even when the pre-rebuild probe already hits. Never thrash after this (see heal cooldown).
      try {
        this.scene.forceDynamicTreeRebuild(true, false)
        rebuilt = true
        this.sealRebuildCount = 1
        if (typeof this.scene.flushQueryUpdates === 'function') {
          this.scene.flushQueryUpdates()
        }
      } catch (err) {
        console.warn('[PhysXWorld] seal forceDynamicTreeRebuild failed:', err)
      }
      this.invalidateControllerCache()
      const d1 = this.diagnoseSceneQueryAt(px, py, pz, 'seal-after-rebuild')
      probeAfter = d1.didHit
        ? `hit d=${d1.distance?.toFixed(2)} ny=${d1.normalY?.toFixed(2)}`
        : 'MISS'
    }

    // Freeze thrash forever after the one commit.
    this.allowStaticReinsert = false
    this.staticSqSealed = true
    // Freeze progressive SQ tree mutation. Plaza logs: healthy seal → MISS within seconds
    // while map/inScene stay 1100 — progressive rebuild corrupts the tree mid-play.
    // Late adds still use addActor; post-seal heal must NEVER forceDynamicTreeRebuild (COD E1).
    try {
      if (this.scene && typeof this.scene.setDynamicTreeRebuildRateHint === 'function') {
        this.scene.setDynamicTreeRebuildRateHint(1_000_000)
      }
    } catch {
      /* optional */
    }
    try {
      if (
        this.scene &&
        typeof this.scene.setSceneQueryUpdateMode === 'function' &&
        PHYSX.PxSceneQueryUpdateModeEnum?.eBUILD_DISABLED_COMMIT_DISABLED != null
      ) {
        this.scene.setSceneQueryUpdateMode(
          PHYSX.PxSceneQueryUpdateModeEnum.eBUILD_DISABLED_COMMIT_DISABLED
        )
      }
    } catch {
      /* optional */
    }
    this.pinCctFilters()
    this.invalidateControllerCache()
    console.warn(
      `[PhysXWorld] static SQ sealed — static=${n} filters=${filters} orphans=${orphans} ` +
        `rebuild=${rebuilt ? 'once' : 'skip'} probe=${probeBefore}→${probeAfter} frozen=true sqUpdates=disabled`
    )
  }

  /**
   * After bulk static registration — CCT cache only.
   * NEVER simulate(0) and NEVER forceDynamicTreeRebuild here (both soft plaza solids).
   */
  warmStaticScene(): void {
    if (!this.scene) return
    this.ensureInfiniteGroundPlane()
    void this.allowZeroDtWarmSim
    this.invalidateControllerCache()
  }

  /**
   * Runtime-safe refresh after late cooks / road AOI.
   * Cache invalidate + optional flush — never remove+add thrash / never tree rebuild.
   */
  refreshStaticAfterRuntimeGeometryChange(): void {
    this.ensureInfiniteGroundPlane()
    try {
      if (this.scene && typeof this.scene.flushQueryUpdates === 'function') {
        this.scene.flushQueryUpdates()
      }
    } catch {
      /* optional */
    }
    this.invalidateControllerCache()
  }

  /** COD E1 metrics — sealed once; post-seal rebuilds must stay 0. */
  isStaticSqSealed(): boolean {
    return this.staticSqSealed
  }

  getSealRebuildCount(): number {
    return this.sealRebuildCount
  }

  getPostSealRebuildCount(): number {
    return this.postSealRebuildCount
  }

  /**
   * COD E1 — post-seal soft recovery without tree thrash.
   *
   * Law (docs/STATIC_COLLIDER_COD.md): after sealStaticSceneQuery, never
   * forceDynamicTreeRebuild / reinsert-all. Heal may only re-add map orphans
   * missing from the PhysX scene + pin CCT filters + flush if available.
   * MISS with all actors present is a per-entity cook bug, not a rebuild trigger.
   */
  tryHealPostSealSceneQuery(x: number, y: number, z: number): boolean {
    if (!this.staticSqSealed || !this.scene) return false
    const now = performance.now()
    if (now - this.lastPostSealSqHealMs < PhysXWorld.POST_SEAL_SQ_HEAL_COOLDOWN_MS) return false
    this.lastPostSealSqHealMs = now

    this.pinCctFilters()

    let readded = 0
    for (const actor of this.staticActors.values()) {
      if (!actor || this.actorInScene(actor)) continue
      try {
        this.scene.addActor(actor)
        readded++
      } catch {
        /* skip */
      }
    }
    this.ensureInfiniteGroundPlane()
    try {
      if (typeof this.scene.flushQueryUpdates === 'function') {
        this.scene.flushQueryUpdates()
      }
    } catch {
      /* optional */
    }
    this.pinCctFilters()
    this.invalidateControllerCache()
    if (readded === 0) {
      // No orphans — skip O(static) diagnose (894 actor walk was a 26ms hitch).
      return true
    }
    const d = this.diagnoseSceneQueryAt(x, y, z, 'post-seal-heal')
    console.warn(
      `[PhysXWorld] post-seal SQ heal — readded=${readded} didHit=${d.didHit} rebuild=forbidden ` +
        `cooldown=${PhysXWorld.POST_SEAL_SQ_HEAL_COOLDOWN_MS}ms`
    )
    return d.didHit
  }

  /**
   * Call once after capsule spawn: pin CCT filters + orphan re-add only.
   * COD E1: no second forceDynamicTreeRebuild after seal (was thrashing healthy plaza SQ).
   */
  commitStaticSceneQueryAfterCapsule(): void {
    if (!this.scene || !this.staticSqSealed) return
    this.pinCctFilters()
    const px = this.position?.x ?? 0
    const py = this.position?.y ?? 0
    const pz = this.position?.z ?? 0
    const before = this.diagnoseSceneQueryAt(px, py, pz, 'post-capsule-before')
    let readded = 0
    if (!before.didHit) {
      for (const actor of this.staticActors.values()) {
        if (!actor || this.actorInScene(actor)) continue
        try {
          this.scene.addActor(actor)
          readded++
        } catch {
          /* skip */
        }
      }
      try {
        if (typeof this.scene.flushQueryUpdates === 'function') {
          this.scene.flushQueryUpdates()
        }
      } catch {
        /* optional */
      }
    }
    this.pinCctFilters()
    this.invalidateControllerCache()
    const after =
      readded > 0 ? this.diagnoseSceneQueryAt(px, py, pz, 'post-capsule-after') : before
    console.warn(
      `[PhysXWorld] post-capsule SQ commit — rebuild=forbidden readded=${readded} ` +
        `didHit=${after.didHit} cctFilter=open`
    )
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
    // After primary seal: only ADD new road colliders — never removeStatic thrash.
    // Mass remove+add on AOI refresh killed plaza SQ (healthy at seal → MISS seconds later).
    if (!this.staticSqSealed) {
      for (const entity of this.aoiRoadEntityIds) {
        if (next.has(entity)) continue
        if (!this.isAoiRoadColliderEntity(entity)) {
          console.warn(`[PhysXWorld] AOI bookkeeping had non-road id e${entity} — ignored`)
          continue
        }
        try {
          this.removeStatic(entity)
        } catch (err) {
          console.warn('[PhysXWorld] aoi road collider remove failed', entity, err)
        }
      }
    }
    this.aoiRoadEntityIds = next

    // freezeRemoval:true is mandatory — never prune plaza furniture when road list is partial.
    // After seal: cook only missing road ids (cap budget).
    const toCook = this.staticSqSealed
      ? roadOnly.filter((d) => !this.hasStaticActor(d.entity))
      : roadOnly
    const result = this.syncStaticColliders(toCook, {
      freezeRemoval: true,
      geometryCache: true,
      forceRecookOnPoseChange: false,
      cookBudget: Math.min(24, Math.max(8, toCook.length || 1))
    })
    if (result.geometryChanged) {
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

  // --- Empty-land AOI tree/rock boxes (29.1M band) ---
  private aoiEmptyLandEntityIds = new Set<number>()

  isAoiEmptyLandColliderEntity(entity: number): boolean {
    return (
      entity >= EMPTY_LAND_AOI_COLLIDER_ENTITY_BASE &&
      entity < EMPTY_LAND_AOI_COLLIDER_ENTITY_BASE + EMPTY_LAND_AOI_COLLIDER_ID_SPAN
    )
  }

  syncAoiEmptyLandColliders(descs: PhysicsColliderDesc[]): {
    geometryChanged: boolean
    pendingCooks: number
  } {
    const only = descs.filter((d) => this.isAoiEmptyLandColliderEntity(d.entity))
    if (only.length !== descs.length) {
      console.warn(
        `[PhysXWorld] AOI empty-land sync rejected ${descs.length - only.length} non-empty id(s)`
      )
    }
    const next = new Set(only.map((d) => d.entity))
    // After seal: never remove empty-land colliders on ring refresh (same SQ thrash as roads).
    if (!this.staticSqSealed) {
      for (const entity of this.aoiEmptyLandEntityIds) {
        if (next.has(entity)) continue
        if (!this.isAoiEmptyLandColliderEntity(entity)) continue
        try {
          this.removeStatic(entity)
        } catch (err) {
          console.warn('[PhysXWorld] aoi empty-land collider remove failed', entity, err)
        }
      }
    }
    this.aoiEmptyLandEntityIds = next
    const toCook = this.staticSqSealed
      ? only.filter((d) => !this.hasStaticActor(d.entity))
      : only
    const result = this.syncStaticColliders(toCook, {
      freezeRemoval: true,
      geometryCache: true,
      cookBudget: Math.min(24, toCook.length || 1)
    })
    if (result.geometryChanged) {
      this.refreshStaticAfterRuntimeGeometryChange()
    }
    return result
  }

  clearAoiEmptyLandColliders(): void {
    for (const entity of this.aoiEmptyLandEntityIds) {
      if (!this.isAoiEmptyLandColliderEntity(entity)) continue
      try {
        this.removeStatic(entity)
      } catch {
        /* ignore */
      }
    }
    this.aoiEmptyLandEntityIds.clear()
    this.invalidateControllerCache()
  }

  /**
   * Force-remove specific empty-land AOI colliders (sticky scatter purge at >1km).
   * Unlike ring refresh, purge may run after SQ seal — still remove actors.
   */
  purgeAoiEmptyLandColliders(entityIds: Iterable<number>): void {
    let n = 0
    for (const entity of entityIds) {
      if (!this.isAoiEmptyLandColliderEntity(entity)) continue
      try {
        this.removeStatic(entity)
        n++
      } catch {
        /* ignore */
      }
      this.aoiEmptyLandEntityIds.delete(entity)
    }
    if (n > 0) this.invalidateControllerCache()
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
    if (this.pendingCctOverlapSeparate) {
      this.pendingCctOverlapSeparate = false
      this.separateCctFromOverlappingStatics()
    }

    // Always re-assert y=0 floor before any move (scene cook churn must not strand the avatar).
    this.ensureInfiniteGroundPlane()
    // Re-pin open CCT filter each move (permanent object — not null, not zero words).
    this.pinCctFilters()

    this.pendingCctGroundEntity = null
    this.pendingCctGroundY = Number.NEGATIVE_INFINITY
    this.pendingCctGroundContact = null
    this._cctMoveStart.copy(this.position)

    // Stick-to-ground: pure horizontal moves often omit eCOLLISION_DOWN (PlayerSystem strips
    // gravity while grounded). A tiny downward bias keeps ground hits + wall contacts reliable.
    const stickDown =
      displacement.y > -1e-5 && displacement.y < 0.02
        ? Math.max(0.02, Math.min(0.12, 2.5 * Math.max(1e-3, delta)))
        : 0
    if (stickDown > 0) {
      displacement = this._v2.set(displacement.x, displacement.y - stickDown, displacement.z)
    }

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
    let hitSides = false
    for (let i = 0; i < substeps; i++) {
      const flags = this.controller.move(
        stepDisp.toPxVec3(this._pv2),
        0,
        stepDt,
        this.controllerFilters
      )
      if (flags.isSet(PHYSX.PxControllerCollisionFlagEnum.eCOLLISION_DOWN)) grounded = true
      if (flags.isSet(PHYSX.PxControllerCollisionFlagEnum.eCOLLISION_UP)) hitUp = true
      if (flags.isSet(PHYSX.PxControllerCollisionFlagEnum.eCOLLISION_SIDES)) hitSides = true
    }
    this.syncPlayerTransform()
    this.lastCctHitSides = hitSides

    // High-speed wall slam + mid-frame collider insert can leave the capsule overlapping
    // statics. Unity CharacterController skin-width keeps a legal pose; we finish the
    // same move with an XZ separation so the CCT is never left embedded ("mud").
    const wantedH = Math.hypot(displacement.x, displacement.z)
    const actualH = Math.hypot(this.position.x - this._cctMoveStart.x, this.position.z - this._cctMoveStart.z)
    if (hitSides && wantedH > 0.05 && actualH < 0.012) {
      this.separateCctFromOverlappingStatics()
    }

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
      this.pendingCctGroundContact = {
        entity: INFINITE_GROUND_ENTITY,
        point: new THREE.Vector3(this.position.x, HARD_FLOOR_Y, this.position.z)
      }
    }

    // eCOLLISION_DOWN is a hint only. Explorer-like law: grounded ⇔ walkable support
    // under the capsule so gravity always runs when walking off elevated pads into a gap.
    grounded = this.resolveGroundedFromContacts(grounded)

    return { grounded }
  }

  /**
   * Validate / reject CCT ground. Without this, eCOLLISION_DOWN alone can leave the
   * player "grounded" with stick-down and zero gravity while feet hang over a lower floor
   * (brainrot center hole under elevated tiles).
   */
  private resolveGroundedFromContacts(cctDown: boolean): boolean {
    if (!cctDown) {
      this.lastGroundPhysEntity = null
      this.lastCctShapeContact = null
      return false
    }

    const groundEnt = this.pendingCctGroundEntity
    // DOWN without a walkable shape hit this move → freefall (do not keep last frame's ground).
    if (groundEnt === null) {
      this.lastGroundPhysEntity = null
      this.lastCctShapeContact = null
      return false
    }

    const maxFloat =
      CONTROLLER_STEP_OFFSET + CONTROLLER_CONTACT_OFFSET + this.capsuleRadius + 0.15
    const feetY = this.position.y
    const colR = GROUND_CONTACT_COLUMN_RADIUS
    const colR2 = colR * colR

    // Prefer live contact point from this move (under-column + height).
    const contact = this.pendingCctGroundContact
    if (contact && contact.entity === groundEnt) {
      const dx = contact.point.x - this.position.x
      const dz = contact.point.z - this.position.z
      const underColumn = dx * dx + dz * dz <= colR2
      const supportY = contact.point.y
      const floatGap = feetY - supportY
      // Side graze on a pad while stepping into open air: contact XZ off-column or too low.
      if (!underColumn || floatGap > maxFloat || floatGap < -0.35) {
        this.lastGroundPhysEntity = null
        this.lastCctShapeContact = null
        this.pendingCctGroundEntity = null
        this.pendingCctGroundContact = null
        return false
      }
      this.lastGroundPhysEntity = groundEnt
      this.lastCctShapeContact = contact
      return true
    }

    // Infinite ground / no contact point — AABB top under feet column.
    if (groundEnt === INFINITE_GROUND_ENTITY) {
      if (feetY - HARD_FLOOR_Y > maxFloat) {
        this.lastGroundPhysEntity = null
        return false
      }
      this.lastGroundPhysEntity = INFINITE_GROUND_ENTITY
      return true
    }

    const top = this.physxActorWalkSurfaceTop(groundEnt, this.position)
    if (!top || feetY - top.y > maxFloat || feetY - top.y < -0.35) {
      this.lastGroundPhysEntity = null
      this.lastCctShapeContact = null
      this.pendingCctGroundEntity = null
      this.pendingCctGroundContact = null
      return false
    }
    this.lastGroundPhysEntity = groundEnt
    this.lastCctShapeContact = { entity: groundEnt, point: top.clone() }
    return true
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

  /** GLTF multi-shape parents (or legacy single multi-shape actors) registered in PhysX. */
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
    if (!fp?.startsWith('gltf-entity:')) return false
    // Expanded multi-shape: parent bookkeeping only; children are the RigidStatics.
    if ((this.multiShapeChildCount.get(entity) ?? 0) > 0) return true
    return this.staticActors.has(entity)
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
      // PART stand walk-surface — only if ROOT actor-slide did not already author riding.
      this.commitRidingDelta(desc.entity, this._v1, current)
    }
  }

  /**
   * Seed MeshCollider walk-surface baselines for entities that have never been seen.
   * Do **not** overwrite existing prev — that used to run *after* Transform CRDT apply
   * and zeroed riding Δ (prev and current both post-motion). Live Δ is computed in
   * {@link applyMeshColliderPoseDeltas}, which updates prev at end of each frame.
   */
  snapshotColliderPositions(descs: PhysicsColliderDesc[]): void {
    for (const desc of descs) {
      if (desc.fingerprint.startsWith('gltf-entity:')) continue
      if (this.colliderLastWorldPos.has(desc.entity)) continue
      this.colliderWalkSurfaceAnchor(desc, this._pos)
      this.colliderLastWorldPos.set(desc.entity, this._pos.clone())
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
    this.actorWorldPosBeforeSlide = null
    this.ridingDeltaCommittedEntity = null
    this.platformMotionScopeEntity =
      groundEntity !== null && groundEntity !== INFINITE_GROUND_ENTITY ? groundEntity : null
  }

  /** True if riding Δ was already written this frame (no second author). */
  hasRidingDeltaThisFrame(): boolean {
    return this.ridingDeltaCommittedEntity !== null
  }

  /** Read live PhysX actor world translation (MeshCollider / single rigid). */
  private readActorWorldPosition(entity: number, out: THREE.Vector3): boolean {
    const actor = this.staticActors.get(entity)
    if (!actor || typeof actor.getGlobalPose !== 'function') return false
    try {
      const pose = actor.getGlobalPose()
      const p = pose?.p ?? pose?.get_p?.()
      if (!p) return false
      const x = typeof p.x === 'number' ? p.x : p.get_x?.()
      const y = typeof p.y === 'number' ? p.y : p.get_y?.()
      const z = typeof p.z === 'number' ? p.z : p.get_z?.()
      if (![x, y, z].every((v) => typeof v === 'number' && Number.isFinite(v))) return false
      out.set(x, y, z)
      return true
    } catch {
      return false
    }
  }

  /**
   * Call immediately before ROOT pose slides for the CCT-grounded actor.
   * Enables {@link commitRidingDeltaFromActorSlide} to match collision, not visuals.
   */
  snapshotStandActorBeforeRootSlide(standPhysEntity: number | null): void {
    this.actorWorldPosBeforeSlide = null
    if (standPhysEntity === null || standPhysEntity === INFINITE_GROUND_ENTITY) return
    if (!this.readActorWorldPosition(standPhysEntity, this._pos)) return
    this.actorWorldPosBeforeSlide = { entity: standPhysEntity, pos: this._pos.clone() }
  }

  /**
   * After ROOT PhysX slides — **the** riding Δ for MeshCollider / ROOT movers
   * (docs/RIDING_TRANSFER_LAW.md). One measurement: actor global pose before → after.
   */
  commitRidingDeltaFromActorSlide(standPhysEntity: number | null): void {
    const baseline = this.actorWorldPosBeforeSlide
    this.actorWorldPosBeforeSlide = null
    if (
      standPhysEntity === null ||
      standPhysEntity === INFINITE_GROUND_ENTITY ||
      !baseline ||
      baseline.entity !== standPhysEntity ||
      this.ridingDeltaCommittedEntity !== null
    ) {
      return
    }
    if (!this.readActorWorldPosition(standPhysEntity, this._pos)) return
    this._v1.subVectors(this._pos, baseline.pos)
    if (!isSignificantPlatformDelta(this._v1)) return
    if (!this.isPlausibleRidingDelta(this._v1)) {
      this.logRejectedPlatformDelta('actor-slide', standPhysEntity, this._v1)
      return
    }
    this.commitRidingDelta(standPhysEntity, this._v1, this._pos.clone())
    if (platformMotionDebug.isEnabled()) {
      clientDebugLog.log(
        'motion',
        `riding Δ actor-slide=(${this._v1.x.toFixed(3)},${this._v1.y.toFixed(3)},${this._v1.z.toFixed(3)}) · entity=${standPhysEntity}`,
        { throttleKey: 'riding-actor-slide', throttleMs: 400, alsoConsole: true, level: 'success' }
      )
    }
  }

  private isRidingTransferEntity(entity: number): boolean {
    return this.platformMotionScopeEntity !== null && entity === this.platformMotionScopeEntity
  }

  /**
   * Single riding author for this frame. Subsequent authors no-op.
   * Also records poseMotionDelta for descending-platform head-crush (CCT collision response).
   */
  private commitRidingDelta(entity: number, delta: THREE.Vector3, surface?: THREE.Vector3): void {
    if (!isSignificantPlatformDelta(delta) || !this.isPlausiblePlatformDelta(delta)) return
    if (!this.isRidingTransferEntity(entity)) return
    if (!this.isPlausibleRidingDelta(delta)) return
    if (this.ridingDeltaCommittedEntity !== null) return

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

    let riding = this.platformMotionDelta.get(entity)
    if (!riding) {
      riding = new THREE.Vector3()
      this.platformMotionDelta.set(entity, riding)
    }
    riding.copy(delta)
    this.ridingDeltaCommittedEntity = entity
  }

  /** Pose-only (head-crush overhead) — never writes riding map. */
  private commitPoseMotionOnly(entity: number, delta: THREE.Vector3, surface?: THREE.Vector3): void {
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

    // Bounds probe is not a riding author (law: actor-slide or PART walk-surface only).
    this.commitPoseMotionOnly(groundEntity, this._v1, current)
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
   * Descriptor matrix root Δ — poseMotion only (head-crush). Never authors riding
   * (ROOT riding is commitRidingDeltaFromActorSlide only).
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
      if (!this.isPlausiblePlatformDelta(this._v1)) continue
      this.commitPoseMotionOnly(desc.entity, this._v1, this._pos)
    }
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

    // Contact probe may fill riding only if no author yet (secondary to actor-slide / PART).
    this.commitRidingDelta(entity, this._v1, hit.point)
  }

  /**
   * Track MeshCollider matrix positions for continuity. Riding is **not** authored here —
   * only {@link commitRidingDeltaFromActorSlide} (or PART walk-surface) may set riding Δ.
   */
  applyMeshColliderPoseDeltas(descs: PhysicsColliderDesc[]): void {
    for (const desc of descs) {
      if (desc.fingerprint.startsWith('gltf-entity:')) continue
      this.colliderWalkSurfaceAnchor(desc, this._pos)
      const prev = this.colliderLastWorldPos.get(desc.entity)
      if (!prev) {
        this.colliderLastWorldPos.set(desc.entity, this._pos.clone())
        continue
      }
      prev.copy(this._pos)
    }
  }

  clearStandingPlatform(): void {
    this.standingPlatformEntity = null
    this.lastGroundPhysEntity = null
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

  /**
   * Glue feet to walk-surface tread — **descending-platform head-crush only**
   * (CCT eCOLLISION_UP), not a post-transfer riding correction.
   */
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
   * Riding Δ for the CCT-grounded actor only — this frame’s map, no sticky fallback.
   * @see docs/RIDING_TRANSFER_LAW.md
   */
  getPlatformTransferDelta(): THREE.Vector3 {
    this.platformTransferDisp.set(0, 0, 0)

    const groundEntity = this.platformMotionScopeEntity ?? this.lastGroundPhysEntity
    if (groundEntity === null || groundEntity === INFINITE_GROUND_ENTITY) {
      this.standingPlatformEntity = null
      return this.platformTransferDisp
    }

    const delta = this.platformMotionDeltaForEntity(groundEntity)
    if (!delta || !isSignificantPlatformDelta(delta) || !this.isPlausibleRidingDelta(delta)) {
      this.standingPlatformEntity = null
      return this.platformTransferDisp
    }

    this.standingPlatformEntity = groundEntity
    return this.platformTransferDisp.copy(delta)
  }

  /**
   * Capsule += standing surface Δ once, then CCT move(). No post-transfer snap.
   */
  applyPlatformVelocityTransfer(): boolean {
    const delta = this.getPlatformTransferDelta()
    if (!isSignificantPlatformDelta(delta)) {
      this.standingPlatformEntity = null
      return false
    }
    if (!this.isPlausibleRidingDelta(delta)) {
      this.logRejectedPlatformDelta(
        'transfer',
        this.standingPlatformEntity ?? this.lastGroundPhysEntity ?? -1,
        delta,
        `feet=(${this.position.x.toFixed(2)},${this.position.y.toFixed(2)},${this.position.z.toFixed(2)})`
      )
      this.standingPlatformEntity = null
      return false
    }
    const entity = this.standingPlatformEntity
    if (entity === null || entity !== (this.platformMotionScopeEntity ?? this.lastGroundPhysEntity)) {
      this.standingPlatformEntity = null
      return false
    }
    this._v1.copy(this.position).add(delta)
    this.teleport(this._v1)
    this.invalidateControllerCache()
    if (platformMotionDebug.isEnabled()) {
      clientDebugLog.log(
        'motion',
        `riding transfer Δ=(${delta.x.toFixed(3)},${delta.y.toFixed(3)},${delta.z.toFixed(3)}) · entity=${entity} · feet→(${this.position.x.toFixed(2)},${this.position.y.toFixed(2)},${this.position.z.toFixed(2)})`,
        { throttleKey: 'riding-transfer', throttleMs: 400, alsoConsole: true, level: 'success' }
      )
    }
    return true
  }

  /**
   * Animator GLTF root-origin Δ — only if no riding author yet (PART fallback).
   */
  mergeAnimatorOriginPlatformMotion(
    originDeltas: Map<number, THREE.Vector3>,
    originPositions: Map<number, THREE.Vector3>
  ): void {
    for (const [entity, originDelta] of originDeltas) {
      if (!isSignificantPlatformDelta(originDelta)) continue
      if (!this.isPlausibleRidingDelta(originDelta)) continue
      this.commitRidingDelta(entity, originDelta, originPositions.get(entity))
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

  /** True when last move() reported side collision (wall/prop). */
  getLastCctHitSides(): boolean {
    return this.lastCctHitSides
  }

  /**
   * Legal CCT pose after a wall slam or collider insert: if the capsule overlaps
   * static solids, slide feet on XZ out of the hull (Explorer skin-width).
   * Returns true when the pose was corrected.
   */
  separateCctFromOverlappingStatics(): boolean {
    if (!this.scene || !this.controller || !this.playerCapsuleOverlapGeometry || !this.overlapPose) {
      return false
    }

    const foot = this.footPositionFromController(this._v1)
    const halfHeight = (this.capsuleHeight - this.capsuleRadius * 2) / 2
    const centerY = foot.y + this.capsuleRadius + halfHeight
    this._pos.set(foot.x, centerY, foot.z)
    this._pos.toPxTransform(this.overlapPose)
    this._quat.setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2)
    this._quat.toPxTransform(this.overlapPose)

    this.applySceneQueryFilter(0)
    try {
      this.queryFilterData.flags = new PHYSX.PxQueryFlags(
        PHYSX.PxQueryFlagEnum.eSTATIC | PHYSX.PxQueryFlagEnum.eDYNAMIC
      )
    } catch {
      /* older bindings */
    }
    const didHit = this.scene.overlap(
      this.playerCapsuleOverlapGeometry,
      this.overlapPose,
      this.overlapResult,
      this.queryFilterData
    )
    if (!didHit) return false

    const pad = this.capsuleRadius + CONTROLLER_CONTACT_OFFSET
    let pushX = 0
    let pushZ = 0
    let n = 0
    const nbHits = this.overlapResult.getNbAnyHits()
    for (let i = 0; i < nbHits; i++) {
      const hit = this.overlapResult.getAnyHit(i)
      const actor = hit?.actor
      if (!actor?.ptr) continue
      if (this.triggerEntityByActorPtr.has(actor.ptr)) continue
      const entity = this.staticEntityByActorPtr.get(actor.ptr)
      if (entity === undefined || entity === INFINITE_GROUND_ENTITY) continue
      if (typeof actor.getWorldBounds !== 'function') continue
      let min: { x: number; y: number; z: number }
      let max: { x: number; y: number; z: number }
      try {
        const bounds = actor.getWorldBounds()
        min = bounds.get_minimum()
        max = bounds.get_maximum()
      } catch {
        continue
      }
      if (!min || !max) continue
      // Only hulls that intersect the capsule column (walls / thick props).
      if (max.y < foot.y + 0.15 || min.y > foot.y + this.capsuleHeight) continue
      const cx = Math.min(Math.max(foot.x, min.x), max.x)
      const cz = Math.min(Math.max(foot.z, min.z), max.z)
      let dx = foot.x - cx
      let dz = foot.z - cz
      if (dx * dx + dz * dz < 1e-8) {
        dx = foot.x - (min.x + max.x) * 0.5
        dz = foot.z - (min.z + max.z) * 0.5
      }
      const len = Math.hypot(dx, dz)
      if (len < 1e-5) continue
      const inv = 1 / len
      const need = pad - len
      if (need <= 0) continue
      pushX += dx * inv * need
      pushZ += dz * inv * need
      n++
    }
    if (!n) return false
    const mag = Math.hypot(pushX, pushZ)
    if (mag < 1e-4) return false
    const maxPush = 0.28
    const scale = mag > maxPush ? maxPush / mag : 1
    this.invalidateControllerCache()
    this.position.x += pushX * scale
    this.position.z += pushZ * scale
    this.controller.setFootPosition(this.position.toPxExtVec3())
    this.syncPlayerTransform()
    return true
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

  /**
   * Scene queries — same bilateral contract as CCT.
   * layerMask 0 → player.group + SOLID_FILTER_OPEN (never zero words — zeros reject CCT/SQ).
   * Camera/trigger pass a narrower mask.
   * No ePREFILTER (null callback → MISS everything).
   */
  private applySceneQueryFilter(layerMask: number): void {
    const w0 = Layers.player.group
    const w1 = layerMask === 0 ? SOLID_FILTER_OPEN : layerMask >>> 0
    if (!this.sceneQueryFilterWords) {
      this.sceneQueryFilterWords = new PHYSX.PxFilterData(w0, w1, 0, 0)
    } else {
      this.sceneQueryFilterWords.word0 = w0
      this.sceneQueryFilterWords.word1 = w1
    }
    this.queryFilterData.data = this.sceneQueryFilterWords
    try {
      if (!this.sceneQueryFlags) {
        this.sceneQueryFlags = new PHYSX.PxQueryFlags(
          PHYSX.PxQueryFlagEnum.eSTATIC | PHYSX.PxQueryFlagEnum.eDYNAMIC
        )
      }
      this.queryFilterData.flags = this.sceneQueryFlags
    } catch {
      /* older bindings */
    }
  }

  private ensureCameraSweepGeometry(): void {
    if (this.cameraSweepGeometry || !this.physics) return
    this.cameraSweepGeometry = new PHYSX.PxSphereGeometry(0.2)
  }

  /** Ray-style sweep for third-person camera wall collision (same solid filter as CCT). */
  sweepRay(origin: THREE.Vector3, direction: THREE.Vector3, maxDistance: number): number | null {
    if (!this.scene) return null
    this.ensureCameraSweepGeometry()
    if (!this.cameraSweepGeometry) return null
    const skipNear = Math.min(0.55, maxDistance * 0.06)
    const sweepDist = maxDistance - skipNear
    if (sweepDist <= 0.2) return null

    this._v1.copy(origin).addScaledVector(direction, skipNear)
    this._v1.toPxVec3(this.sweepPose.p)

    // Same OPEN bilateral words as CCT — CAMERA_QUERY_MASK missed plaza hulls
    // (word drift / static=1100) the same way player sweeps used to.
    this.applySceneQueryFilter(0)

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

  /**
   * Cookable multi-shape children: has geometry and is not a permanent cook failure.
   * Degenerate child hulls must not keep `expected` above `live` or boot recooks forever.
   */
  private countCookableMultiShapeLive(desc: PhysicsColliderDesc): {
    expected: number
    live: number
  } {
    let expected = 0
    let live = 0
    const shapes = desc.shapes
    if (!shapes) return { expected, live }
    for (let i = 0; i < shapes.length; i++) {
      const shape = shapes[i]!
      if (!shape.geometry) continue
      if (this.failedCookFp.has(shape.fingerprint)) continue
      expected++
      if (this.staticActors.has(multiShapeChildPhysId(desc.entity, i))) live++
    }
    return { expected, live }
  }

  private logCookFailedOnce(fingerprint: string, message: string, err?: unknown): void {
    this.failedCookFp.add(fingerprint)
    if (this.loggedFailedCookFp.has(fingerprint)) return
    this.loggedFailedCookFp.add(fingerprint)
    if (err !== undefined) console.warn(message, fingerprint, err)
    else console.warn(message, fingerprint)
  }

  /**
   * Expand multi-shape GltfContainer into **one RigidStatic per shape**, using the same
   * single-mesh world-bake path as MeshCollider (debug box / boxes that CCT actually hits).
   * One multi-shape actor was soft for CCT walk surfaces despite correct magenta source tint.
   * Kinematic PART multi-shape remains on {@link addMultiShapeKinematic}.
   */
  private addMultiShapeStatic(
    desc: PhysicsColliderDesc,
    options?: {
      geometryCache?: boolean
      persistCook?: boolean
      preferPersistedCook?: boolean
      skipWorkerStream?: boolean
    }
  ): boolean {
    void options?.geometryCache
    const persistCook = options?.persistCook === true
    const preferPersistedCook = options?.preferPersistedCook === true
    const skipWorkerStream = options?.skipWorkerStream === true
    const shapes = desc.shapes
    if (!shapes?.length || !this.physics || !this.scene) return false

    const _meshWorld = new THREE.Matrix4()
    let attached = 0
    let lastIndex = -1
    const usedSlots = new Set<number>()
    const prevSlotCount = this.multiShapeChildCount.get(desc.entity) ?? 0

    for (let i = 0; i < shapes.length; i++) {
      const shapeDesc = shapes[i]!
      if (!shapeDesc.geometry) continue
      // Permanent child cook failure (degenerate trimesh) — do not re-bake.
      if (this.failedCookFp.has(shapeDesc.fingerprint)) continue
      // mesh world = entity world × shape local (entity-relative extract)
      _meshWorld.copy(desc.matrix).multiply(shapeDesc.localMatrix)
      if (!this.matrixHasFinitePose(_meshWorld)) continue

      const childId = multiShapeChildPhysId(desc.entity, i)
      const childDesc: PhysicsColliderDesc = {
        entity: childId,
        kind: 'geometry',
        fingerprint: shapeDesc.fingerprint,
        matrix: _meshWorld.clone(),
        geometry: shapeDesc.geometry
      }
      // Only hot-swap when a child already exists (geom recook). First cook is plain addStatic.
      const ok = this.staticActors.has(childId)
        ? this.replaceStaticWithCook(childId, () =>
            this.addStatic(childDesc, persistCook, preferPersistedCook, skipWorkerStream)
          )
        : this.addStatic(childDesc, persistCook, preferPersistedCook, skipWorkerStream)
      if (!ok) continue
      // Track per-shape geom fp so thrash guards / isColliderSynced can match children.
      this.staticFp.set(childId, shapeDesc.fingerprint)
      this.staticPoseFp.set(childId, multiShapePoseFingerprint(desc))
      attached++
      lastIndex = i
      usedSlots.add(i)
    }

    if (!attached) {
      this.logCookFailedOnce(desc.fingerprint, '[PhysXWorld] multi-shape cook failed — no shapes attached:')
      return false
    }

    // Drop slots no longer used (shape count shrank) + legacy single multi-shape parent.
    for (let i = 0; i < prevSlotCount; i++) {
      if (usedSlots.has(i)) continue
      const id = multiShapeChildPhysId(desc.entity, i)
      if (this.staticActors.has(id)) this.removeStatic(id)
    }
    if (this.staticActors.has(desc.entity)) this.removeStatic(desc.entity)

    this.multiShapeChildCount.set(desc.entity, Math.max(lastIndex + 1, attached))
    this.staticFp.set(desc.entity, desc.fingerprint)
    this.staticPoseFp.set(desc.entity, multiShapePoseFingerprint(desc))
    this.actorWorldBaked.set(desc.entity, true)
    this.shapeBaselineLocal.set(
      desc.entity,
      shapes.map((shape) => new THREE.Matrix4().copy(desc.matrix).multiply(shape.localMatrix))
    )
    // World-bake embeds full mesh world matrix (incl. scale). Track cook scale so
    // Transform/Tween scale grow can force recook (pose slides cannot resize hulls).
    desc.matrix.decompose(this._pos, this._quat, this._scale)
    this.actorCookScale.set(desc.entity, this._scale.clone())

    const { expected: cookable } = this.countCookableMultiShapeLive(desc)
    if (attached < cookable) {
      console.warn(
        `[PhysXWorld] multi-shape expand partial — parent=${desc.entity} attached=${attached}/${cookable} ` +
          `(per-shape RigidStatic). fp=${desc.fingerprint.slice(0, 80)}`
      )
    } else {
      // Rate-limit: thrash logs made load look 3× slower with no collider gain.
      const now = performance.now()
      const last = this.multiShapeExpandLogAt.get(desc.entity) ?? 0
      if (now - last > 5000) {
        this.multiShapeExpandLogAt.set(desc.entity, now)
        console.info(
          `[PhysXWorld] multi-shape expand — parent=${desc.entity} → ${attached} single-mesh actor(s) (CCT path)`
        )
      }
    }
    // New hulls can spawn overlapping the capsule (Snowdrift run-into-prop). Legal pose.
    // Do not run CCT overlap separate per tile cook — 30 expands at load was a hitch.
    this.invalidateControllerCache()
    this.pendingCctOverlapSeparate = true
    return true
  }

  /** Remove expanded per-shape actors for a multi-shape parent phys id. */
  private removeMultiShapeChildren(parentPhysId: number): void {
    const n = this.multiShapeChildCount.get(parentPhysId) ?? 0
    const limit = Math.max(n, 0)
    for (let i = 0; i < limit; i++) {
      const id = multiShapeChildPhysId(parentPhysId, i)
      if (this.staticActors.has(id)) this.removeStatic(id)
    }
    // Also clear any orphan slots if count was stale (boot thrash).
    if (n === 0) {
      for (let i = 0; i < MULTI_SHAPE_SLOT_STRIDE; i++) {
        const id = multiShapeChildPhysId(parentPhysId, i)
        if (!this.staticActors.has(id)) {
          if (i > 8) break // no dense block — stop early
          continue
        }
        this.removeStatic(id)
      }
    }
    this.multiShapeChildCount.delete(parentPhysId)
    this.actorWorldBaked.delete(parentPhysId)
    this.shapeBaselineLocal.delete(parentPhysId)
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

      // Prop layer + open mask — bilateral never rejects CCT / sweeps.
      const filterData = new PHYSX.PxFilterData(Layers.prop.group, SOLID_FILTER_OPEN, 0, 0)
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
   * Slide actor root + per-shape relative poses — geometry cooked once at baseline.
   * Cook once, move forever: verts stay baked; only actor T+R + shape local pose change.
   *
   * @param kinematic — also seed setKinematicTarget (still setGlobalPose for immediate CCT SQ).
   * @param options.skipScaleCheck — PART path already validated; scale gate can block first slide.
   * @returns false when the actor cannot be slid safely (caller may entity-local recook once).
   */
  private updateMultiShapeActorPose(
    actor: any,
    desc: PhysicsColliderDesc,
    kinematic = false,
    options?: { skipScaleCheck?: boolean }
  ): boolean {
    const shapes = desc.shapes
    if (!shapes?.length) return false
    if (options?.skipScaleCheck) {
      if (!this.matrixHasFinitePose(desc.matrix)) return false
      for (const shape of shapes) {
        if (!this.matrixHasFinitePose(shape.localMatrix)) return false
      }
      try {
        if (actor.getNbShapes() !== shapes.length) return false
      } catch {
        return false
      }
    } else if (!this.isPoseSlideSafe(actor, desc)) {
      return false
    }

    const worldBaked = this.actorWorldBaked.get(desc.entity) === true
    const baselines = this.shapeBaselineLocal.get(desc.entity)

    if (worldBaked) {
      // PART cook model: actor at origin; verts in world space at baseline.
      // shapePose = currentWorld * inv(baselineWorld). Exact when rel is pure T+R.
      this._pos.set(0, 0, 0)
      this._identityQuat.set(0, 0, 0, 1)
      this._pos.toPxTransform(this.actorPoseTransform)
      this._identityQuat.toPxTransform(this.actorPoseTransform)
      actor.setGlobalPose(this.actorPoseTransform)
      if (kinematic && typeof actor.setKinematicTarget === 'function') {
        actor.setKinematicTarget(this.actorPoseTransform)
      }

      const nbShapes = actor.getNbShapes()
      const shapeBuffer = this.ensureShapePtrBuffer(nbShapes)
      const shapesCount = actor.getShapes(shapeBuffer.begin(), nbShapes, 0)
      for (let i = 0; i < shapesCount && i < shapes.length; i++) {
        const pxShape = shapeBuffer.get(i)
        const baseline = baselines?.[i]
        // current world = entityWorld * shapeLocal (force-refreshed from mesh/bone)
        this._worldMatrix.copy(desc.matrix).multiply(shapes[i]!.localMatrix)
        if (baseline) {
          this._shapeRel.copy(baseline).invert()
          this._shapeRel.premultiply(this._worldMatrix)
          this.setPxShapeLocalPose(pxShape, this._shapeRel)
        } else {
          this._pos.set(0, 0, 0)
          this._identityQuat.set(0, 0, 0, 1)
          this._pos.toPxTransform(this.shapeLocalPoseTransform)
          this._identityQuat.toPxTransform(this.shapeLocalPoseTransform)
          pxShape.setLocalPose(this.shapeLocalPoseTransform)
        }
      }
      // World-baked PART: no static reinsert (kinematic preferred; seal rebuild if boot).
      return true
    }

    desc.matrix.decompose(this._pos, this._quat, this._scale)
    this._pos.toPxTransform(this.actorPoseTransform)
    this._quat.toPxTransform(this.actorPoseTransform)
    // Immediate SQ pose — CCT runs scene queries before/without relying on kinematic target apply.
    actor.setGlobalPose(this.actorPoseTransform)
    if (kinematic && typeof actor.setKinematicTarget === 'function') {
      actor.setKinematicTarget(this.actorPoseTransform)
    }

    const nbShapes = actor.getNbShapes()
    const shapeBuffer = this.ensureShapePtrBuffer(nbShapes)
    const shapesCount = actor.getShapes(shapeBuffer.begin(), nbShapes, 0)
    for (let i = 0; i < shapesCount && i < shapes.length; i++) {
      const pxShape = shapeBuffer.get(i)
      const current = shapes[i]!.localMatrix
      const baseline = baselines?.[i]
      if (baseline) {
        // Entity-local: verts baked at baseline local; shape pose = current * inv(baseline).
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
    // Kinematic: target drives SQ. Static: already in tree from cook — no reinsert.
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
    }

    // Shape-local rotation: PhysX PxCapsuleGeometry is along **X**; DCL cylinders are Y-up.
    let shapeLocalQuat: THREE.Quaternion | null = null
    if (geometry) {
      // already built (trimesh)
    } else if (kind === 'sphere') {
      const r = 0.5 * Math.max(this._scale.x, this._scale.y, this._scale.z)
      geometry = new PHYSX.PxSphereGeometry(Math.max(r, 1e-4))
    } else if (kind === 'cylinder') {
      const parts = desc.kind.split(':')
      const unitTop = parseFloat(parts[1] ?? '0.5')
      const unitBot = parseFloat(parts[2] ?? '0.5')
      const radius = Math.max(unitTop, unitBot) * Math.max(Math.abs(this._scale.x), Math.abs(this._scale.z))
      const height = Math.abs(this._scale.y)
      // Flat disks (height ≤ 2R): box matches DCL short cylinder better than a fat capsule.
      if (height <= 2 * radius + 1e-4) {
        geometry = new PHYSX.PxBoxGeometry(
          Math.max(radius, 1e-4),
          Math.max(0.5 * height, 1e-4),
          Math.max(radius, 1e-4)
        )
      } else {
        // Shaft half-length excludes hemispherical caps (total height = 2*halfH + 2*R).
        const halfShaft = Math.max(1e-4, 0.5 * height - radius)
        geometry = new PHYSX.PxCapsuleGeometry(Math.max(radius, 1e-4), halfShaft)
        // Rotate capsule X-axis → world Y (entity up).
        shapeLocalQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2)
      }
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

    if (shapeLocalQuat) {
      const localPose = new PHYSX.PxTransform(PHYSX.PxIDENTITYEnum.PxIdentity)
      this._pos.set(0, 0, 0)
      this._pos.toPxTransform(localPose)
      shapeLocalQuat.toPxTransform(localPose)
      shape.setLocalPose(localPose)
      PHYSX.destroy(localPose)
    }

    const isLandscape = desc.fingerprint.includes(':wall:')
    // GLTF trimesh colliders use prop/env group + open solid mask (CCT blocking).
    const layer = isLandscape ? Layers.environment : Layers.prop
    const filterData = new PHYSX.PxFilterData(layer.group, SOLID_FILTER_OPEN, 0, 0)
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
    this.actorCookScale.set(desc.entity, this._scale.clone())
    // After seal: plain addActor only. NEVER remove+add here — late AOI/road thrash of
    // remove+add killed plaza SQ (didHit=true at seal, didHit=false a few seconds later).
    return true
  }

  /**
   * Primary→secondary demote / secondary→primary promote: rename phys entity ids
   * without remove/recook. Multi-shape children rekey with the parent.
   * @returns number of map entries rekeyed (parent + children)
   */
  rekeyStaticColliderFamily(fromEntity: number, toEntity: number): number {
    if (fromEntity === toEntity) return 0
    if (this.staticActors.has(toEntity) || this.multiShapeChildCount.has(toEntity)) {
      // Target already occupied — fall back to invalidate target first (rare clash).
      this.invalidateStaticCollider(toEntity)
    }
    let n = 0
    const childCount = this.multiShapeChildCount.get(fromEntity) ?? 0
    if (childCount > 0) {
      for (let i = 0; i < childCount; i++) {
        const fromChild = multiShapeChildPhysId(fromEntity, i)
        const toChild = multiShapeChildPhysId(toEntity, i)
        n += this.rekeyStaticColliderOne(fromChild, toChild)
      }
      this.multiShapeChildCount.set(toEntity, childCount)
      this.multiShapeChildCount.delete(fromEntity)
    }
    n += this.rekeyStaticColliderOne(fromEntity, toEntity)
    if (n > 0) this.invalidateControllerCache()
    return n
  }

  /** Move one phys-id map entry; does not touch multi-shape children. */
  private rekeyStaticColliderOne(fromEntity: number, toEntity: number): number {
    if (fromEntity === toEntity) return 0
    let moved = 0
    const actor = this.staticActors.get(fromEntity)
    if (actor) {
      this.staticActors.set(toEntity, actor)
      this.staticActors.delete(fromEntity)
      moved++
    }
    const transferMap = <V>(map: Map<number, V>, from: number, to: number) => {
      if (!map.has(from)) return
      map.set(to, map.get(from)!)
      map.delete(from)
      moved++
    }
    transferMap(this.staticFp, fromEntity, toEntity)
    transferMap(this.staticPoseFp, fromEntity, toEntity)
    transferMap(this.actorWorldBaked, fromEntity, toEntity)
    transferMap(this.shapeBaselineLocal, fromEntity, toEntity)
    transferMap(this.actorCookScale, fromEntity, toEntity)
    transferMap(this.pmeshHandles, fromEntity, toEntity)
    transferMap(this.multiShapeExpandLogAt, fromEntity, toEntity)
    if (this.actorIsKinematic.has(fromEntity)) {
      this.actorIsKinematic.delete(fromEntity)
      this.actorIsKinematic.add(toEntity)
      moved++
    }
    return moved > 0 ? 1 : 0
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

/** Parent multi-shape phys id (20M+ecs) → child actor id for shape slot. */
function multiShapeChildPhysId(parentPhysId: number, shapeIndex: number): number {
  // parentPhysId is GLTF_COLLIDER_ENTITY_BASE + ecsEntity (20_000_000 + ecs).
  const ecs = parentPhysId - 20_000_000
  return MULTI_SHAPE_CHILD_BASE + ecs * MULTI_SHAPE_SLOT_STRIDE + shapeIndex
}

function unitPxMeshScale(): unknown {
  return new PHYSX.PxMeshScale(new PHYSX.PxVec3(1, 1, 1), new PHYSX.PxQuat(0, 0, 0, 1))
}

declare module 'three' {
  interface Vector3 {
    fromPxVec3(pxVec3: { x: number; y: number; z: number }): this
  }
}
