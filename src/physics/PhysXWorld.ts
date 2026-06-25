import * as THREE from 'three'
import { parseParcelKey } from '../dcl/content/parseParcel'
import { PARCEL_SIZE } from '../dcl/content/types'
import { isSceneParcel, parcelKey } from '../dcl/landscape/Utils/ParcelGrid'
import { parcelWorldOrigin } from '../dcl/landscape/Utils/SceneSpace'
import { physxColliderDebug } from '../debug/PhysxColliderDebug'
import { platformMotionDebug } from '../debug/PlatformMotionDebug'
import { clientDebugLog } from '../client/debug/ClientDebugLog'
import { extendThreePhysX } from './extendThreePhysX'
import { CAMERA_QUERY_MASK, GROUND_QUERY_MASK, Layers, TRIGGER_QUERY_MASK } from './Layers'
import { geometryToPxMesh, type PxMeshHandle } from './geometryToPxMesh'
import { bakeTrimeshGeometry, isTrimeshGeometryCookable } from './bakeTrimeshGeometry'
import { ensureIndexedForCook } from './colliderGeometryPrep'
import { loadPhysX } from './loadPhysX'
import {
  isSignificantPlatformDelta,
  MAX_RIDING_DELTA_HORIZ,
  STAND_SURFACE_CONTACT_TOLERANCE,
  STAND_SURFACE_MAX_BELOW_TREAD,
  STAND_SURFACE_MAX_VERT_GAP
} from './platformMotion'

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

/** Downward ground probe hit — actor origin is capsule feet (y = 0 on player root). */
export type GroundSweepHit = {
  normal: THREE.Vector3
  distance: number
  point: THREE.Vector3
  /** Y offset from feet where the probe started (ray or sphere sweep). */
  probeOffset: number
  /** PhysX static collider entity id — undefined for misses / unmapped actors. */
  physEntity?: number
}

/** Downward probe range for spawn snap / teleport (not locomotion grounded). */
const GROUND_CHECK_DISTANCE = 0.12 + 0.1
const GROUND_PROBE_OFFSET = 0.12
/** Thin vertical ray — avoids fat sphere catching wall corners beside the feet. */
const GROUND_RAY_OFFSET = 0.08
/** Min normal.y to count as walkable floor (steep wall bases are ignored). */
const WALKABLE_NORMAL_Y = 0.55
/** Landscape / MeshCollider boxes only — skip dense GLTF trimesh walls when probing feet. */
const LANDSCAPE_GROUND_MASK = Layers.environment.group | Layers.prop.group
/** GLTF + prop static meshes — prefer over infinite ground when snapping spawn feet. */
const SCENE_MESH_GROUND_MASK = Layers.prop.group | Layers.gltfCollider.group

/** Unity CharacterController defaults — DCL Foundation uses PhysX CCT with similar tuning. */
const DEG2RAD = Math.PI / 180
const CONTROLLER_SLOPE_LIMIT_DEG = 45
const CONTROLLER_STEP_OFFSET = 0.45
const CONTROLLER_CONTACT_OFFSET = 0.08
/** Descending platform overhead — max gap from feet to walk surface to start transfer (≈ capsule). */
const PLATFORM_OVERHEAD_CATCH = 1.6 + CONTROLLER_STEP_OFFSET + 0.35
/** Max foot gap scene-mesh ground-stick will clamp (CCT step-offset overshoot on stairs — never infinite ground). */
const GROUND_STICK_DISTANCE = 0.55
/** Per-frame platform Δ sanity — rejects collider pose glitches (walk surface jumping to far global bbox). */
const MAX_PLATFORM_DELTA_HORIZ = 1.25
const MAX_PLATFORM_DELTA_TOTAL = 2.5
/** Ground-contact tread must stay under the capsule column — not a distant shape on the same actor. */
/** Locomotion ground-stick — tight column avoids grabbing distant elevator treads. */
const MAX_GROUND_CONTACT_HORIZ = 2
/** Spawn / boot probes — entity pivots can sit far from mesh extents (plaza GLTFs). */
const SPAWN_GROUND_PROBE_HORIZ = 48
/** Tread Y must not jump more than this vs baseline (duplicate mesh at lift bottom). */
const MAX_GROUND_CONTACT_VERT = 1.5
/** Always-on floor at y=0 — large thin static box (PxPlane is unsupported by CCT/sweep queries), no render mesh. */
const INFINITE_GROUND_ENTITY = -1
const INFINITE_GROUND_FINGERPRINT = 'infinite-ground-plane'
/** Half-extent of the ground box in X/Z — effectively "infinite" for a single parcel-scale scene. */
const GROUND_BOX_HALF_EXTENT = 5000
/** Half-thickness; box centred at y=-halfHeight so its top face sits exactly at y=0. */
const GROUND_BOX_HALF_HEIGHT = 0.5

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
  private raycastResult: any = null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private queryFilterData: any = null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _pv2: any = null

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private groundSweepGeometry: any = null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private cameraSweepGeometry: any = null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private playerCapsuleOverlapGeometry: any = null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private overlapPose: any = null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private overlapResult: any = null

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
  /** Retain GLTF stand surface over infinite y=0 when CCT down-probe mis-fires. */
  private standSurfaceGroundHint: number | null = null
  private readonly platformTransferDisp = new THREE.Vector3()
  /** Platform we are riding — always the grounded actor when transfer applies. */
  private standingPlatformEntity: number | null = null
  /** Last walkable PhysX actor under the feet (from CCT grounding probes). */
  private lastGroundPhysEntity: number | null = null
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
  /** Cook-time shape local poses — runtime Animator slides use current * baseline⁻¹. */
  private readonly shapeBaselineLocal = new Map<number, THREE.Matrix4[]>()
  /** Fingerprints whose trimesh cook failed — skip retry until fingerprint changes. */
  private readonly failedCookFp = new Set<string>()
  private readonly loggedFailedCookFp = new Set<string>()
  private landscapeFp = ''

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private controllerManager: any = null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private controllerFilters: any = null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private controller: any = null
  private capsuleRadius = 0.3
  private capsuleHeight = 1.6
  private groundSweepRadius = 0.29
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
  private readonly _down = new THREE.Vector3(0, -1, 0)

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
      this.groundSweepGeometry?.release?.()
    } catch {
      // ignore
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
    this.groundSweepGeometry = null
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
    this.raycastResult = new PHYSX.PxRaycastResult()
    this.queryFilterData = new PHYSX.PxQueryFilterData()
    this._pv2 = new PHYSX.PxVec3()
    this.groundSweepGeometry = new PHYSX.PxSphereGeometry(this.groundSweepRadius)
    this.cameraSweepGeometry = new PHYSX.PxSphereGeometry(0.2)
    const capsuleHalfHeight = (this.capsuleHeight - this.capsuleRadius * 2) / 2
    this.playerCapsuleOverlapGeometry = new PHYSX.PxCapsuleGeometry(this.capsuleRadius, capsuleHalfHeight)
    this.overlapPose = new PHYSX.PxTransform(PHYSX.PxIDENTITYEnum.PxIdentity)
    this.overlapResult = new PHYSX.PxOverlapResult()

    this.setupControllerManager()
    this.ensureInfiniteGroundPlane()
  }

  /** Scene-agnostic ground at y=0 — never removed when landscape/walls refresh. */
  private ensureInfiniteGroundPlane(): void {
    if (this.staticActors.has(INFINITE_GROUND_ENTITY) || !this.physics || !this.scene) return

    // Large thin BOX with its top face at y=0 — NOT a PxPlane. PhysX CCT collision and
    // overlap/sweep scene queries do not support PxPlaneGeometry, so a plane leaves the
    // controller ungrounded (cctDown never set) and invisible to the ground probe — the
    // player ends up held only by the position.y<0 backstop and can never rest on or step
    // onto raised colliders. A box behaves like any other static collider.
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

    queueMicrotask(() => {
      if (this.verifyInfiniteGroundAt(0, 2, 0)) return
      console.warn('[PhysXWorld] infinite ground plane not yet queryable — will retry on first snap')
    })
  }

  /** Downward probe — returns true when the infinite ground plane is hittable. */
  verifyInfiniteGroundAt(x: number, y: number, z: number): boolean {
    if (!this.scene) return false
    this._v1.set(x, y, z)
    this.applySceneQueryFilter(GROUND_QUERY_MASK)
    return this.scene.raycast(
      this._v1.toPxVec3(this._pv2),
      this._down.toPxVec3(this.sweepPose.p),
      y + 1,
      this.raycastResult,
      PHYSX.PxHitFlagEnum.eDEFAULT,
      this.queryFilterData
    )
  }

  private setupControllerManager(): void {
    this.controllerManager = PHYSX.PxTopLevelFunctions.prototype.CreateControllerManager(this.scene)
    this.controllerFilters = new PHYSX.PxControllerFilters()
    this.controllerFilters.mFilterData = new PHYSX.PxFilterData(Layers.player.group, Layers.player.mask, 0, 0)
    // Required for CCT move() overlap tests — without eSTATIC, static GLTF/MeshCollider actors are ignored.
    this.controllerFilters.mFilterFlags = new PHYSX.PxQueryFlags(
      PHYSX.PxQueryFlagEnum.eSTATIC | PHYSX.PxQueryFlagEnum.eDYNAMIC
    )

    const cctFilterCallback = new PHYSX.PxControllerFilterCallbackImpl()
    cctFilterCallback.filter = () => true
    this.controllerFilters.mCCTFilterCallback = cctFilterCallback

    // CCT move() uses scene queries — must return eBLOCK or the capsule passes through static trimesh.
    const filterCallback = new PHYSX.PxQueryFilterCallbackImpl()
    filterCallback.simplePreFilter = (queryFilterPtr: number, shapePtr: number) => {
      // PhysX passes PxQueryFilterData — filter bits live in `.data`, not at the pointer root.
      const queryFilter = PHYSX.wrapPointer(queryFilterPtr, PHYSX.PxQueryFilterData)
      const filterData = queryFilter.data
      const shape = PHYSX.wrapPointer(shapePtr, PHYSX.PxShape)
      const shapeFilterData = shape.getQueryFilterData()
      if (filterData.word0 & shapeFilterData.word1 && shapeFilterData.word0 & filterData.word1) {
        return PHYSX.PxQueryHitType.eBLOCK
      }
      return PHYSX.PxQueryHitType.eNONE
    }
    filterCallback.simplePostFilter = () => PHYSX.PxQueryHitType.eBLOCK
    this.controllerFilters.mFilterCallback = filterCallback
  }

  spawnPlayer(position: THREE.Vector3): void {
    if (!this.physics || !this.scene || !this.controllerManager) {
      throw new Error('PhysXWorld not initialised')
    }

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
    // Simulation-only: the player capsule must NOT be a scene-query shape, or the
    // downward ground probe (and camera sweep) self-hit it. The ray starts inside the
    // capsule and exits at its base (= foot), so every probe reported nearestSurface==foot
    // (gap=0) and the ground-stick clamp pinned the player floating at its current height.
    const shapeFlags = new PHYSX.PxShapeFlags(PHYSX.PxShapeFlagEnum.eSIMULATION_SHAPE)
    for (let i = 0; i < shapesCount; i++) {
      const shape = shapeBuffer.get(i)
      shape.setFlags(shapeFlags)
      shape.setQueryFilterData(filterData)
      shape.setSimulationFilterData(filterData)
    }

    this.controller.setFootPosition(position.toPxExtVec3())
    this.syncPlayerTransform()
    this.invalidateControllerCache()
  }

  hasStaticActor(entity: number): boolean {
    return this.staticActors.has(entity)
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
  }

  /** Remove every scene static actor (keeps infinite ground) — manual recook / pose drift reset. */
  clearAllSceneStaticActors(): void {
    for (const entity of [...this.staticActors.keys()]) {
      if (entity === INFINITE_GROUND_ENTITY) continue
      this.removeStatic(entity)
    }
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
   */
  applyStaticColliderPoseUpdates(
    descs: PhysicsColliderDesc[],
    options?: { force?: boolean; forceEntities?: ReadonlySet<number> }
  ): number {
    const forceAll = options?.force === true
    const forceEntities = options?.forceEntities
    let updated = 0
    for (const desc of descs) {
      if (this.failedCookFp.has(desc.fingerprint)) continue
      if (forceEntities && !forceAll && !forceEntities.has(desc.entity)) continue

      if (desc.shapes?.length) {
        if (!this.geomFingerprintMatches(desc)) continue
        const poseFp = multiShapePoseFingerprint(desc)
        if (this.staticPoseFp.get(desc.entity) === poseFp) continue
        const actor = this.staticActors.get(desc.entity)
        if (!actor || this.actorWorldBaked.get(desc.entity)) continue
        this.updateMultiShapeActorPose(actor, desc)
        this.staticPoseFp.set(desc.entity, poseFp)
        updated++
        continue
      }

      if (!this.geomFingerprintMatches(desc)) continue
      const poseFp = matrixFingerprint(desc.matrix)
      if (this.staticPoseFp.get(desc.entity) === poseFp) continue
      const actor = this.staticActors.get(desc.entity)
      if (!actor || this.actorWorldBaked.get(desc.entity)) continue
      desc.matrix.decompose(this._pos, this._quat, this._scale)
      const actorTransform = new PHYSX.PxTransform(PHYSX.PxIDENTITYEnum.PxIdentity)
      this._pos.toPxTransform(actorTransform)
      this._quat.toPxTransform(actorTransform)
      actor.setGlobalPose(actorTransform)
      this.staticPoseFp.set(desc.entity, poseFp)
      updated++
    }
    if (updated > 0) this.invalidateControllerCache()
    return updated
  }

  isColliderSynced(desc: PhysicsColliderDesc): boolean {
    if (this.failedCookFp.has(desc.fingerprint)) return false

    if (desc.shapes?.length) {
      const geomFp = desc.fingerprint
      const poseFp = multiShapePoseFingerprint(desc)
      if (this.staticFp.get(desc.entity) !== geomFp) return false
      const actor = this.staticActors.get(desc.entity)
      return !!actor && this.staticPoseFp.get(desc.entity) === poseFp
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
    }
  ): { geometryChanged: boolean; pendingCooks: number } {
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
          if (actor && this.staticPoseFp.get(desc.entity) === poseFp) continue
          const worldBaked = !!(actor && this.actorWorldBaked.get(desc.entity))
          if (actor && !options?.forceRecookOnPoseChange && !worldBaked) {
            try {
              this.updateMultiShapeActorPose(actor, desc)
              this.staticPoseFp.set(desc.entity, poseFp)
              geometryChanged = true
              continue
            } catch (err) {
              console.warn('[PhysXWorld] multi-shape pose update failed:', desc.entity, err)
            }
          }
          // World-baked pose drift — keep the live actor until cook budget allows atomic swap below.
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
          this.removeStatic(desc.entity)
          if (!this.addMultiShapeStatic(desc, { geometryCache: !bootStyleCook })) {
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
            desc.matrix.decompose(this._pos, this._quat, this._scale)
            const actor = this.staticActors.get(desc.entity)!
            const actorTransform = new PHYSX.PxTransform(PHYSX.PxIDENTITYEnum.PxIdentity)
            this._pos.toPxTransform(actorTransform)
            this._quat.toPxTransform(actorTransform)
            actor.setGlobalPose(actorTransform)
            this.staticPoseFp.set(desc.entity, poseFp)
            geometryChanged = true
            continue
          } catch (err) {
            console.warn('[PhysXWorld] primitive pose update failed:', desc.entity, err)
          }
        }
        // World-baked / missing actor — recook below; keep existing actor until cook budget allows swap.
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
        this.removeStatic(desc.entity)
        if (!this.addStatic(desc)) {
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
   * After bulk static registration, run a zero-dt sim + CCT interaction pass so scene
   * queries and the controller obstacle cache see new actors (same pattern as infinite ground).
   */
  warmStaticScene(): void {
    if (!this.scene) return
    this.scene.simulate(0)
    this.scene.fetchResults(true)
    this.controllerManager?.computeInteractions(0)
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
      if (entity < 0 && entity !== INFINITE_GROUND_ENTITY) this.removeStatic(entity)
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

    const flags = this.controller.move(
      displacement.toPxVec3(this._pv2),
      0,
      delta,
      this.controllerFilters
    )
    let grounded = flags.isSet(PHYSX.PxControllerCollisionFlagEnum.eCOLLISION_DOWN)
    const hitUp = flags.isSet(PHYSX.PxControllerCollisionFlagEnum.eCOLLISION_UP)
    this.syncPlayerTransform()

    if (hitUp && this.correctDescendingPlatformHeadCrush()) {
      grounded = true
    }

    if (this.position.y < 0) {
      this._v1.set(this.position.x, 0, this.position.z)
      this.teleport(this._v1)
      this.invalidateControllerCache()
      grounded = true
    } else if (displacement.y <= 0) {
      const idleOnGround =
        grounded &&
        displacement.lengthSq() < 1e-8 &&
        Math.abs(displacement.y) < 1e-8
      if (!idleOnGround) {
        // Scene meshes only — never snap to the y=0 infinite plane (that yanks feet off stairs).
        const reach = grounded ? GROUND_STICK_DISTANCE + 0.25 : CONTROLLER_CONTACT_OFFSET + 0.35
        const hit = this.probeSceneGroundDown(reach)
        if (hit) {
          const gap = hit.distance - hit.probeOffset
          const shouldSnap = grounded
            ? gap > CONTROLLER_CONTACT_OFFSET + 0.03 && gap <= GROUND_STICK_DISTANCE
            : hit.distance <= hit.probeOffset + CONTROLLER_CONTACT_OFFSET + 0.05
          if (shouldSnap) {
            const targetFeetY = this.feetYFromGroundHit(this.position.y, hit)
            this._v1.set(this.position.x, targetFeetY, this.position.z)
            this.teleport(this._v1)
            grounded = true
          }
          if (hit.physEntity !== undefined) {
            this.lastGroundPhysEntity = this.resolveGroundPhysEntity(hit.physEntity)
          }
        }
      }
    }

    if (grounded) {
      const groundHit = this.probeSceneGroundDown(GROUND_STICK_DISTANCE + 0.35)
      if (groundHit?.physEntity !== undefined) {
        this.lastGroundPhysEntity = this.resolveGroundPhysEntity(groundHit.physEntity)
      }
    } else {
      this.lastGroundPhysEntity = null
      this.standSurfaceGroundHint = null
    }

    return { grounded }
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

  /**
   * Horizontal capsule sweep probe for `?collidersphys` — nearest static hit within `maxDistance`.
   */
  /** Downward probe for spawn diagnostics — nearest walkable hit below feet. */
  debugProbeDownHit(maxDrop = 8): number | null {
    if (!this.scene || !this.controller) return null
    const hit = this.probeWalkableDown(maxDrop)
    return hit?.distance ?? null
  }

  /** Downward probe at an arbitrary feet position — used before the player capsule exists. */
  probeDownAt(feet: THREE.Vector3, maxDrop = 8): number | null {
    if (!this.scene) return null
    const hit =
      this.raycastDownAt(feet, SCENE_MESH_GROUND_MASK, maxDrop) ??
      this.raycastDownAt(feet, GROUND_QUERY_MASK, maxDrop)
    return hit?.distance ?? null
  }

  /** GLTF/prop floor probe at spawn — excludes infinite ground so prewarm waits for scene meshes. */
  probeSceneMeshDownAt(feet: THREE.Vector3, maxDrop = 12, maxHoriz = MAX_GROUND_CONTACT_HORIZ): number | null {
    if (!this.scene) return null
    const hit = this.raycastDownAt(feet, SCENE_MESH_GROUND_MASK, maxDrop, maxHoriz)
    return hit?.distance ?? null
  }

  private raycastDownAt(
    feet: THREE.Vector3,
    mask: number,
    maxDistance: number,
    maxHoriz = MAX_GROUND_CONTACT_HORIZ
  ): GroundSweepHit | null {
    if (!this.scene) return null
    const origin = this._v1.copy(feet)
    this.liftProbeOriginAboveFloor(origin, GROUND_RAY_OFFSET)
    this.applySceneQueryFilter(mask)
    const didHit = this.scene.raycast(
      origin.toPxVec3(this._pv2),
      this._down.toPxVec3(this.sweepPose.p),
      maxDistance,
      this.raycastResult,
      PHYSX.PxHitFlagEnum.eDEFAULT,
      this.queryFilterData
    )
    if (!didHit) return null
    const nbHits = this.raycastResult.getNbAnyHits?.() ?? 1
    return this.pickWalkableGroundHit(
      this.raycastResult,
      nbHits,
      GROUND_RAY_OFFSET,
      feet,
      maxHoriz,
      maxDistance
    )
  }

  private sweepDownAt(
    feet: THREE.Vector3,
    mask: number,
    maxDistance: number,
    maxHoriz = MAX_GROUND_CONTACT_HORIZ
  ): GroundSweepHit | null {
    if (!this.scene) return null
    const origin = this._v1.copy(feet)
    const probeOffset = this.groundSweepRadius + GROUND_PROBE_OFFSET
    this.liftProbeOriginAboveFloor(origin, probeOffset)
    origin.toPxVec3(this.sweepPose.p)
    this.applySceneQueryFilter(mask)
    const didHit = this.scene.sweep(
      this.groundSweepGeometry,
      this.sweepPose,
      this._down.toPxVec3(this._pv2),
      maxDistance,
      this.sweepResult,
      PHYSX.PxHitFlagEnum.eDEFAULT,
      this.queryFilterData
    )
    if (!didHit) return null
    const nbHits = this.sweepResult.getNbAnyHits?.() ?? 1
    return this.pickWalkableGroundHit(
      this.sweepResult,
      nbHits,
      probeOffset,
      feet,
      maxHoriz,
      maxDistance
    )
  }

  debugProbeStaticHit(maxDistance = 2.5): { distance: number | null; staticCount: number; gltfCount: number } {
    const staticCount = this.staticColliderCount
    const gltfCount = this.gltfStaticActorCount
    if (!this.scene || !this.controller) return { distance: null, staticCount, gltfCount }

    const origin = this.probeOriginFromFeet(this._v1)
    origin.y += this.capsuleHeight * 0.5
    origin.toPxVec3(this.sweepPose.p)

    // Match CCT query filter (player group / mask) — same layers the locomotion preFilter accepts.
    this.queryFilterData.data.word0 = Layers.player.group
    this.queryFilterData.data.word1 = Layers.player.mask

    let nearest: number | null = null
    const dirs = [
      new THREE.Vector3(1, 0, 0),
      new THREE.Vector3(-1, 0, 0),
      new THREE.Vector3(0, 0, 1),
      new THREE.Vector3(0, 0, -1)
    ]
    for (const dir of dirs) {
      const didHit = this.scene.sweep(
        this.groundSweepGeometry,
        this.sweepPose,
        dir.toPxVec3(this._pv2),
        maxDistance,
        this.sweepResult,
        PHYSX.PxHitFlagEnum.eDEFAULT,
        this.queryFilterData
      )
      if (!didHit) continue
      const dist = this.sweepResult.getAnyHit(0).distance
      if (nearest === null || dist < nearest) nearest = dist
    }
    return { distance: nearest, staticCount, gltfCount }
  }

  get quaternionOut(): THREE.Quaternion {
    return this.quaternion
  }

  get playerController(): any {
    return this.controller
  }

  sweepDown(maxDistance = GROUND_CHECK_DISTANCE): GroundSweepHit | null {
    return this.probeWalkableDown(maxDistance)
  }

  /**
   * Downward walkable probe for locomotion ground-stick — scene GLTF/prop meshes first
   * (stairs, platforms), then landscape / infinite ground at y=0.
   * Sphere sweep before ray: avoids stair risers blocking a thin ray while the tread is beside the feet.
   */
  private probeWalkableDown(maxDistance: number): GroundSweepHit | null {
    const sceneHit =
      this.sweepDownWithMask(SCENE_MESH_GROUND_MASK, maxDistance) ??
      this.raycastDownWithMask(SCENE_MESH_GROUND_MASK, maxDistance)
    if (sceneHit) return sceneHit

    return (
      this.sweepDownWithMask(LANDSCAPE_GROUND_MASK, maxDistance) ??
      this.raycastDownWithMask(LANDSCAPE_GROUND_MASK, maxDistance) ??
      this.sweepDownWithMask(GROUND_QUERY_MASK, maxDistance) ??
      this.raycastDownWithMask(GROUND_QUERY_MASK, maxDistance)
    )
  }

  /** GLTF / prop floor only — used by ground-stick (excludes infinite y=0 plane). */
  private probeSceneGroundDown(maxDistance: number): GroundSweepHit | null {
    return (
      this.sweepDownWithMask(SCENE_MESH_GROUND_MASK, maxDistance) ??
      this.raycastDownWithMask(SCENE_MESH_GROUND_MASK, maxDistance)
    )
  }

  /** Lift probe origin above the infinite-ground top face so queries don't start inside the box. */
  private liftProbeOriginAboveFloor(origin: THREE.Vector3, extraOffset: number): void {
    origin.y += extraOffset
    const minOriginY = 0.15
    if (origin.y < minOriginY) origin.y = minOriginY
  }

  private probeOriginFromFeet(out: THREE.Vector3): THREE.Vector3 {
    if (!this.controller) return out
    return out.copy(this.controller.getFootPosition())
  }

  private pickWalkableGroundHit(
    hits: {
      getAnyHit(i: number): {
        normal: { x: number; y: number; z: number }
        distance: number
        position: { x: number; y: number; z: number }
        actor?: { ptr: number }
      }
    },
    nbHits: number,
    probeOffset: number,
    feet?: THREE.Vector3,
    maxHoriz = MAX_GROUND_CONTACT_HORIZ,
    maxDrop = GROUND_CHECK_DISTANCE
  ): GroundSweepHit | null {
    let best: GroundSweepHit | null = null
    const maxHorizSq = maxHoriz * maxHoriz
    const spawnProbe = maxHoriz >= SPAWN_GROUND_PROBE_HORIZ
    const maxVertBelow = spawnProbe
      ? Math.max(MAX_GROUND_CONTACT_VERT, maxDrop)
      : MAX_GROUND_CONTACT_VERT
    for (let i = 0; i < nbHits; i++) {
      const hit = hits.getAnyHit(i)
      const normal = new THREE.Vector3(hit.normal.x, hit.normal.y, hit.normal.z)
      if (normal.y < WALKABLE_NORMAL_Y) continue
      const point = new THREE.Vector3(hit.position.x, hit.position.y, hit.position.z)
      if (feet) {
        const dx = point.x - feet.x
        const dz = point.z - feet.z
        if (dx * dx + dz * dz > maxHorizSq) continue
        if (point.y < feet.y - maxVertBelow) continue
        if (point.y > feet.y + MAX_GROUND_CONTACT_VERT + 0.5) continue
      }
      const distance = hit.distance
      const actor =
        hit.actor ??
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ((hit as any).get_actor?.() as { ptr: number } | null | undefined)
      const physEntity =
        actor?.ptr !== undefined ? this.staticEntityByActorPtr.get(actor.ptr) : undefined
      const candidate: GroundSweepHit = {
        normal,
        distance,
        point,
        probeOffset,
        physEntity
      }
      if (!best) {
        best = candidate
        continue
      }
      // Elevators may duplicate tread meshes on one actor — prefer the topmost surface under the column.
      if (feet) {
        if (point.y > best.point.y + 0.02) best = candidate
        else if (Math.abs(point.y - best.point.y) <= 0.02 && distance < best.distance) best = candidate
      } else if (distance < best.distance) {
        best = candidate
      }
    }
    return best
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
    this.standSurfaceGroundHint =
      this.platformMotionScopeEntity !== null ? this.platformMotionScopeEntity : null
  }

  private isRidingTransferEntity(entity: number): boolean {
    return this.platformMotionScopeEntity !== null && entity === this.platformMotionScopeEntity
  }

  /** Prefer animated stand-surface GLTF over the infinite y=0 plane when both probe positive. */
  private resolveGroundPhysEntity(probed: number): number {
    if (
      probed === INFINITE_GROUND_ENTITY &&
      this.standSurfaceGroundHint !== null &&
      this.standSurfaceGroundHint !== INFINITE_GROUND_ENTITY
    ) {
      return this.standSurfaceGroundHint
    }
    return probed
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

  /**
   * When CCT still reports the infinite plane but an animated tread is under the capsule,
   * snap feet onto the live PhysX tread and register the GLTF actor as ground.
   */
  reconcileStandSurfaceGrounding(
    standPhysEntity: number | null,
    descs: PhysicsColliderDesc[],
    feet: THREE.Vector3
  ): boolean {
    if (standPhysEntity === null || standPhysEntity === INFINITE_GROUND_ENTITY) return false
    const desc = descs.find((d) => d.entity === standPhysEntity)
    if (!desc?.fingerprint.startsWith('gltf-entity:')) return false

    const tread = this.gltfShapeWalkSurfaceTop(desc, feet)
    if (!tread) return false

    const gap = feet.y - tread.y
    const onTread =
      gap >= -STAND_SURFACE_CONTACT_TOLERANCE && gap <= STAND_SURFACE_MAX_VERT_GAP + 0.15
    const belowRising =
      gap < -STAND_SURFACE_CONTACT_TOLERANCE && gap >= -STAND_SURFACE_MAX_BELOW_TREAD
    if (!onTread && !belowRising) return false

    const groundIsInfinite = this.lastGroundPhysEntity === INFINITE_GROUND_ENTITY
    const clipThrough = feet.y < tread.y - 0.12
    if (clipThrough || (groundIsInfinite && onTread && feet.y < tread.y - 0.04)) {
      this._v1.set(feet.x, tread.y, feet.z)
      this.teleport(this._v1)
      this.invalidateControllerCache()
    }
    this.lastGroundPhysEntity = standPhysEntity
    this.standSurfaceGroundHint = standPhysEntity
    return true
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

  /** Scene GLTF/prop floor only — optional snap (skips infinite y=0). */
  snapFeetToSceneMesh(feet: THREE.Vector3, maxDrop = 32, maxHoriz = SPAWN_GROUND_PROBE_HORIZ): boolean {
    const hit = this.probeSceneMeshDownAt(feet, maxDrop, maxHoriz)
    if (hit === null) return false
    const targetY = feet.y - hit
    if (Math.abs(targetY - this.position.y) < 0.02) return false
    this._v1.set(this.position.x, targetY, this.position.z)
    this.teleport(this._v1)
    return true
  }

  /** Down tread contact under feet — long reach for lifts (excludes infinite y=0 plane). */
  private probeSceneGroundAt(feet: THREE.Vector3, maxDistance: number): GroundSweepHit | null {
    return (
      this.raycastDownAt(feet, SCENE_MESH_GROUND_MASK, maxDistance) ??
      this.sweepDownAt(feet, SCENE_MESH_GROUND_MASK, maxDistance)
    )
  }

  /**
   * Frame-start PhysX contact under soles — baseline for tread Δ (Explorer-style: stand on the hit triangle).
   */
  snapshotGroundContactBaseline(feet: THREE.Vector3): void {
    const reach = Math.max(20, feet.y + 6)
    const hit = this.probeSceneGroundAt(feet, reach)
    if (!hit?.physEntity || hit.physEntity === INFINITE_GROUND_ENTITY) {
      this.groundContactBaseline = null
      return
    }
    this.groundContactBaseline = { entity: hit.physEntity, point: hit.point.clone() }
  }

  /**
   * Tread contact Δ after collider pose slides — wins for the grounded actor over distant bbox centers.
   */
  applyGroundContactDelta(feet: THREE.Vector3): void {
    const baseline = this.groundContactBaseline
    if (!baseline) return

    const reach = Math.max(20, feet.y + 6)
    const hit = this.probeSceneGroundAt(feet, reach)
    if (!hit?.physEntity || hit.physEntity === INFINITE_GROUND_ENTITY) return

    const entity = hit.physEntity
    const trustEntity =
      entity === baseline.entity ||
      entity === this.lastGroundPhysEntity ||
      entity === this.standingPlatformEntity
    if (!trustEntity) return

    if (Math.abs(hit.point.y - feet.y) > MAX_GROUND_CONTACT_VERT + 0.35) {
      this.logRejectedPlatformDelta(
        'ground-contact-feet-y',
        entity,
        hit.point.clone().sub(baseline.point),
        `feetY=${feet.y.toFixed(2)} hitY=${hit.point.y.toFixed(2)}`
      )
      return
    }

    const horizFromFeetSq =
      (hit.point.x - feet.x) * (hit.point.x - feet.x) +
      (hit.point.z - feet.z) * (hit.point.z - feet.z)
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
      const rejectEntity =
        this.platformMotionScopeEntity ?? this.lastGroundPhysEntity ?? this.standSurfaceGroundHint
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
  }

  /** Scene queries — bilateral layer test (matches CCT preFilter). */
  private applySceneQueryFilter(layerMask: number): void {
    this.queryFilterData.data.word0 = Layers.player.group
    this.queryFilterData.data.word1 =
      layerMask === 0 ? Layers.player.mask : layerMask & Layers.player.mask
  }

  private raycastDownWithMask(mask: number, maxDistance: number): GroundSweepHit | null {
    if (!this.scene || !this.controller) return null
    const origin = this.probeOriginFromFeet(this._v1)
    this.liftProbeOriginAboveFloor(origin, GROUND_RAY_OFFSET)

    this.applySceneQueryFilter(mask)

    const didHit = this.scene.raycast(
      origin.toPxVec3(this._pv2),
      this._down.toPxVec3(this.sweepPose.p),
      maxDistance,
      this.raycastResult,
      PHYSX.PxHitFlagEnum.eDEFAULT,
      this.queryFilterData
    )

    if (!didHit) return null
    const nbHits = this.raycastResult.getNbAnyHits?.() ?? 1
    return this.pickWalkableGroundHit(this.raycastResult, nbHits, GROUND_RAY_OFFSET)
  }

  private sweepDownWithMask(mask: number, maxDistance: number): GroundSweepHit | null {
    if (!this.scene || !this.controller) return null
    const origin = this.probeOriginFromFeet(this._v1)
    const probeOffset = this.groundSweepRadius + GROUND_PROBE_OFFSET
    this.liftProbeOriginAboveFloor(origin, probeOffset)
    origin.toPxVec3(this.sweepPose.p)

    this.applySceneQueryFilter(mask)

    const didHit = this.scene.sweep(
      this.groundSweepGeometry,
      this.sweepPose,
      this._down.toPxVec3(this._pv2),
      maxDistance,
      this.sweepResult,
      PHYSX.PxHitFlagEnum.eDEFAULT,
      this.queryFilterData
    )

    if (!didHit) return null

    const nbHits = this.sweepResult.getNbAnyHits?.() ?? 1
    return this.pickWalkableGroundHit(this.sweepResult, nbHits, probeOffset)
  }

  /** Feet Y so the capsule base rests on the probe hit (actor origin = soles). */
  feetYFromGroundHit(_feetY: number, hit: GroundSweepHit): number {
    // Use the actual contact-point Y. The distance-based form (feetY + probeOffset - distance)
    // returns the sphere CENTRE for the sweep path, which floats the player one sphere radius
    // (groundSweepRadius) above the real surface. The contact point is correct for both the
    // thin ray and the fat sphere sweep.
    return hit.point.y
  }

  /** Drop feet onto walkable geometry below — only used when spawn Y is under the floor (y < 0). */
  snapToGroundBelow(maxDrop = 64, options?: { preferSceneMeshes?: boolean }): boolean {
    const preferScene = options?.preferSceneMeshes !== false
    const hit = preferScene
      ? this.sweepDownWithMask(SCENE_MESH_GROUND_MASK, maxDrop) ??
        this.raycastDownWithMask(SCENE_MESH_GROUND_MASK, maxDrop) ??
        this.probeWalkableDown(maxDrop)
      : this.probeWalkableDown(maxDrop)
    if (!hit) return false
    const feetY = this.feetYFromGroundHit(this.position.y, hit)
    if (Math.abs(feetY - this.position.y) < 0.001) return false
    this._v1.set(this.position.x, feetY, this.position.z)
    this.teleport(this._v1)
    return true
  }

  /** Ray-style sweep for third-person camera wall collision (Hyperfy `simpleCamLerp`). */
  sweepRay(origin: THREE.Vector3, direction: THREE.Vector3, maxDistance: number): number | null {
    if (!this.scene) return null
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
    options?: { geometryCache?: boolean }
  ): boolean {
    const geometryCache = options?.geometryCache !== false
    const shapes = desc.shapes
    if (!shapes?.length || !this.physics || !this.scene) return false

    const handles: PxMeshHandle[] = []
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pxShapes: any[] = []
    let attached = 0
    let actorAtOrigin = false

    for (const shapeDesc of shapes) {
      if (!shapeDesc.geometry) continue
      // Entity-local cook only — actor root carries world pose; no world-baked vertex teleport path.
      const result = this.createLocalTrimeshShape(shapeDesc, handles, desc.matrix, false, geometryCache)
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
    const actorTransform = new PHYSX.PxTransform(PHYSX.PxIDENTITYEnum.PxIdentity)
    this._pos.toPxTransform(actorTransform)
    this._quat.toPxTransform(actorTransform)

    const actor = this.physics.createRigidStatic(actorTransform)
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
    }
    return true
  }

  private cookBakedGeometryToCache(bakedGeo: THREE.BufferGeometry): PxMeshHandle | null {
    if (!isTrimeshGeometryCookable(bakedGeo)) return null
    let handle = geometryToPxMesh(this.cookingParams, bakedGeo, false, { cache: true })
    if (!handle?.value) {
      handle = geometryToPxMesh(this.cookingParams, bakedGeo, true, { cache: true })
    }
    return handle?.value ? handle : null
  }

  private createLocalTrimeshShape(
    shapeDesc: PhysicsColliderShapeDesc,
    handles: PxMeshHandle[],
    actorMatrix: THREE.Matrix4,
    allowWorldFallback: boolean,
    geometryCache = true
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): { shape: any; worldBaked: boolean } | null {
    const geometry = shapeDesc.geometry
    if (!geometry) return null

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cookBakedGeo = (bakedGeo: THREE.BufferGeometry, cache: boolean): any | null => {
      if (!isTrimeshGeometryCookable(bakedGeo)) return null

      const pmeshHandle = cache
        ? this.cookBakedGeometryToCache(bakedGeo)
        : geometryToPxMesh(this.cookingParams, bakedGeo, false, { cache: false })
      let pxGeometry: unknown = null

      if (!pmeshHandle?.value && !cache) {
        const convexHandle = geometryToPxMesh(this.cookingParams, bakedGeo, true, { cache: false })
        if (convexHandle?.value) {
          const meshScale = unitPxMeshScale()
          pxGeometry = new PHYSX.PxConvexMeshGeometry(convexHandle.value, meshScale)
          PHYSX.destroy(meshScale)
          handles.push(convexHandle)
          return pxGeometry
        }
      }

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
        // Boot cook — world-space vertices, actor at origin (matches placed Three.js object).
        this._worldMatrix.copy(actorMatrix).multiply(shapeDesc.localMatrix)
        const worldGeo = bakeTrimeshGeometry(indexed, this._worldMatrix)
        pxGeometry = cookBakedGeo(worldGeo, false)
        if (pxGeometry) worldBaked = true
        worldGeo.dispose()
      } else {
        // Entity-local bake — scale stays in vertices; Animator slides via relative setLocalPose.
        entityLocalGeo = bakeTrimeshGeometry(indexed, shapeDesc.localMatrix)
        pxGeometry = cookBakedGeo(entityLocalGeo, geometryCache)

        if (!pxGeometry && allowWorldFallback) {
          this._worldMatrix.copy(actorMatrix).multiply(shapeDesc.localMatrix)
          const worldGeo = bakeTrimeshGeometry(indexed, this._worldMatrix)
          pxGeometry = cookBakedGeo(worldGeo, false)
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

      const localTransform = new PHYSX.PxTransform(PHYSX.PxIDENTITYEnum.PxIdentity)
      shape.setLocalPose(localTransform)

      return { shape, worldBaked }
    } catch (err) {
      this.logCookFailedOnce(shapeDesc.fingerprint, '[PhysXWorld] local trimesh cook failed:', err)
      return null
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private setPxShapeLocalPose(pxShape: any, matrix: THREE.Matrix4): void {
    matrix.decompose(this._pos, this._quat, this._scale)
    const localTransform = new PHYSX.PxTransform(PHYSX.PxIDENTITYEnum.PxIdentity)
    this._pos.toPxTransform(localTransform)
    this._quat.toPxTransform(localTransform)
    pxShape.setLocalPose(localTransform)
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  /** Slide actor root + per-shape relative poses — geometry baked at cook baseline. */
  private updateMultiShapeActorPose(actor: any, desc: PhysicsColliderDesc): void {
    const shapes = desc.shapes
    if (!shapes?.length) return

    desc.matrix.decompose(this._pos, this._quat, this._scale)
    const actorTransform = new PHYSX.PxTransform(PHYSX.PxIDENTITYEnum.PxIdentity)
    this._pos.toPxTransform(actorTransform)
    this._quat.toPxTransform(actorTransform)
    actor.setGlobalPose(actorTransform)

    if (this.actorWorldBaked.get(desc.entity)) return

    const baselines = this.shapeBaselineLocal.get(desc.entity)
    const nbShapes = actor.getNbShapes()
    if (nbShapes <= 0) return
    const shapeBuffer = new PHYSX.PxArray_PxShapePtr(nbShapes)
    const shapesCount = actor.getShapes(shapeBuffer.begin(), nbShapes, 0)
    for (let i = 0; i < shapesCount && i < shapes.length; i++) {
      const pxShape = shapeBuffer.get(i)
      const current = shapes[i]!.localMatrix
      const baseline = baselines?.[i]
      if (baseline) {
        this._shapeRel.copy(baseline).invert()
        this._shapeRel.premultiply(current)
        this.setPxShapeLocalPose(pxShape, this._shapeRel)
      } else {
        this.setPxShapeLocalPose(pxShape, current)
      }
    }
  }

  private addStatic(desc: PhysicsColliderDesc): boolean {
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
        const cookOpts = { cache: false }
        pmeshHandle = geometryToPxMesh(this.cookingParams, bakedGeo, false, cookOpts)
        if (!pmeshHandle?.value) {
          pmeshHandle = geometryToPxMesh(this.cookingParams, bakedGeo, true, cookOpts)
          if (pmeshHandle?.value) {
            const meshScale = unitPxMeshScale()
            geometry = new PHYSX.PxConvexMeshGeometry(pmeshHandle.value, meshScale)
            PHYSX.destroy(meshScale)
            this.pmeshHandles.set(desc.entity, [pmeshHandle])
          }
        }
        bakedGeo.dispose()
        if (!pmeshHandle?.value) {
          this.logCookFailedOnce(desc.fingerprint, '[PhysXWorld] trimesh cook failed:')
          return false
        }
        if (!geometry) {
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
    this.shapeBaselineLocal.delete(entity)
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
   * Tier B — broadphase overlap of local player capsule against trigger actors.
   * Returns trigger entity ids currently overlapping the player capsule.
   */
  queryTriggerVolumesOverlappingPlayer(out: Set<number>): Set<number> {
    out.clear()
    if (!this.scene || !this.controller || !this.playerCapsuleOverlapGeometry || !this.overlapPose) {
      return out
    }

    const foot = this.probeOriginFromFeet(this._v1)
    const halfHeight = (this.capsuleHeight - this.capsuleRadius * 2) / 2
    const centerY = foot.y + this.capsuleRadius + halfHeight
    this._pos.set(foot.x, centerY, foot.z)
    this._pos.toPxTransform(this.overlapPose)
    // PxCapsuleGeometry is X-aligned — rotate to Y-up (Hyperfy PlayerLocal pattern).
    this._quat.setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2)
    this._quat.toPxTransform(this.overlapPose)

    this.applySceneQueryFilter(TRIGGER_QUERY_MASK)
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

  private addTriggerVolume(desc: TriggerVolumeDesc): boolean {
    if (!this.physics || !this.scene) return false

    desc.matrix.decompose(this._pos, this._quat, this._scale)
    const meshSphere = desc.mesh === 1
    let geometry
    if (meshSphere) {
      const r = 0.5 * Math.max(Math.abs(this._scale.x), Math.abs(this._scale.y), Math.abs(this._scale.z))
      geometry = new PHYSX.PxSphereGeometry(r)
    } else {
      geometry = new PHYSX.PxBoxGeometry(
        0.5 * Math.abs(this._scale.x),
        0.5 * Math.abs(this._scale.y),
        0.5 * Math.abs(this._scale.z)
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
