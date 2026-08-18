import * as THREE from 'three'
import { avatarOptionsFromUrl, LocalAvatar, mirrorAvatarNameOverride, type PlayEmoteOptions } from '../avatar/LocalAvatar'
import type { ProfileIdentity } from '../avatar/displayName'
import type { AvatarProfile } from '../avatar/types'
import type { MirrorComponents } from '../bridge/mirrorComponents'
import { SDK_RESERVED } from '../bridge/reservedEntities'
import { ReservedEntitiesSync, type EntityPose } from '../bridge/ReservedEntitiesSync'
import { NameTag } from '../client/ui/NameTag'
import { areSceneNameTagsVisible } from '../client/ui/nameTagVisibility'
import { isTextInputFocused } from '../client/ui/textInputFocus'

/** Module latch — Escape is not an IA_* action on the hub. */
let virtualCameraEscapeLatched = false
if (typeof window !== 'undefined') {
  window.addEventListener(
    'keydown',
    (e) => {
      if (e.code === 'Escape' || e.key === 'Escape') virtualCameraEscapeLatched = true
    },
    true
  )
  window.addEventListener(
    'keyup',
    (e) => {
      if (e.code === 'Escape' || e.key === 'Escape') virtualCameraEscapeLatched = false
    },
    true
  )
  window.addEventListener('blur', () => {
    virtualCameraEscapeLatched = false
  })
}
import { cameraCollisionDebug } from '../debug/CameraCollisionDebug'
import type { PhysXWorld } from '../physics/PhysXWorld'
import type { SceneHost } from '../rendering/SceneHost'
import {
  canDoubleJumpLocomotion,
  canGlide,
  canJumpLocomotion,
  canLocomote,
  canVoluntaryEmote,
  defaultLocomotionConfig,
  isModeOnlyLocomotionFreeze,
  jumpHeightForMode,
  readLocomotionFromComponents,
  resolveLocomotionMode,
  speedForMode,
  type LocomotionConfig,
  type LocomotionMode
} from './locomotion'
import {
  applyImpulse,
  dampAndClampExternal,
  effectiveGravityDown,
  forceToAcceleration,
  IMPULSE_LAUNCH_GRACE_SEC,
  integrateForceXZ,
  shouldUngroundFromForce
} from './externalPhysics'
import type { SceneSpawn } from '../dcl/content/types'
import type { MovePlayerToRequest } from './movePlayerTo'
import {
  DCL_PLAYER_ENTITY_Y_OFFSET,
  playerEntityPositionFromThreeFeet,
  resolveMovePlayerToTargetFeetDcl
} from './dclPlayerEntity'
import { clampToWalkBounds, type PlayerWalkBounds } from './SceneBounds'
import { formatWalkBounds, physLog } from '../physics/physicsDiag'
import { normalizeAngle } from '../network/comms/movementCompressed'
import type { SetCameraTransformRequest } from './setCameraTransform'
import {
  dclToThreePos,
  dclToThreeQuat,
  dclToThreeVec,
  threeToDclQuat,
  threeToDclVec,
  threeYawToDclYaw
} from '../bridge/dclTransform'
import type { SceneKeyboardSnapshot } from '../input/SceneInputRelay'
import { PlayerInput } from './PlayerInput'
import type { VirtualCameraBridge } from '../camera/VirtualCameraBridge'
import type { AssetCache } from '../rendering/AssetCache'
import type { ResolvedProfileEmote } from '../avatar/profileEmotes'
import { AVATAR_YAW_OFFSET } from '../avatar/constants'
import { clientSettings } from '../rendering/ClientSettings'
import type { ForcedCameraMode } from '../input/CameraModeAreaSystem'
import { clientDebugLog } from '../client/debug/ClientDebugLog'
import { clearPointerLockAim, setPointerLockAimFromCanvas } from '../input/pointerLockAim'
import { clientCameraNearForBoomDistance } from '../camera/cameraDepthPolicy'

/** PB CameraType — numeric (isolatedModules cannot import const enum). */
const CT_FIRST_PERSON = 0
const CT_THIRD_PERSON = 1

const UP = new THREE.Vector3(0, 1, 0)
const _forward = new THREE.Vector3()
let lastLocomotionDiagMs = 0
const _right = new THREE.Vector3()
const _moveDir = new THREE.Vector3()
const _velocity = new THREE.Vector3()
/** Explorer ExternalVelocity — force XZ + impulses; not walk/jump buffer. */
const _externalVelocity = new THREE.Vector3()
const _displacement = new THREE.Vector3()
const _force = new THREE.Vector3()
const _sceneForce = new THREE.Vector3()
const _sceneImpulse = new THREE.Vector3()
const _forceAccel = new THREE.Vector3()
const _pivot = new THREE.Vector3()
const _lookAt = new THREE.Vector3()
const _offset = new THREE.Vector3()
const _shoulder = new THREE.Vector3()
const _camDir = new THREE.Vector3()
const _camQuat = new THREE.Quaternion()
const _camEuler = new THREE.Euler(0, 0, 0, 'YXZ')

const _camPos = new THREE.Vector3()

const POINTER_LOOK_SPEED = 0.003
/** Boom pivot Y (m above feet) — far 3rd person (chest/shoulders). */
const CAM_PIVOT_HEIGHT_FAR = 1.48
/** Boom pivot when zoomed in — sit higher, behind the head. */
const CAM_PIVOT_HEIGHT_NEAR = 1.72
const CAM_EYE_HEIGHT = 1.82
/** Look-at Y far — upper chest / neck (was 1.15 = mid-shoulders). */
const CAM_LOOK_HEIGHT_FAR = 1.42
/** Look-at Y near zoom — head focus. */
const CAM_LOOK_HEIGHT_NEAR = 1.7
const CAM_DISTANCE_DEFAULT = 4.5
const CAM_DISTANCE_MIN = 0
const CAM_FPV_MAX_DISTANCE = 0.35
const CAM_DISTANCE_MAX = 16
/** Lateral boom offset — taper toward 0 when zoomed in (stay behind head, not shoulder). */
const CAM_SHOULDER_OFFSET = 0.3
const CAM_SHOULDER_CLOSE_DIST = 1.4
const CAM_PITCH_DEFAULT = 0.35
/** Far 3rd-person floor — boom stays on/above the horizontal ring (no look-up into sky). */
const CAM_PITCH_MIN = 0
const CAM_PITCH_MAX = Math.PI / 2 - 0.02
/** Full look-up (toward zenith) when FPV / ultra-close boom. */
const CAM_PITCH_LOOK_UP = -CAM_PITCH_MAX + 0.05
/**
 * Beyond this boom distance (m), pitch cannot go below {@link CAM_PITCH_MIN}
 * (locks sky look-up). Between FPV and this, min pitch lerps FPV look-up → horizontal.
 */
const CAM_PITCH_LOOK_UP_LOCK_DIST = 5.5
/** Zoom closer than this → full near pivot/look (behind head). */
const CAM_HEIGHT_NEAR_DIST = 1.15
/** Zoom farther than this → far pivot/look (classic 3rd person). */
const CAM_HEIGHT_FAR_DIST = 6.0
const ZOOM_WHEEL_SPEED = 0.004

/**
 * Min freecam boom pitch vs zoom distance.
 * Close: allow angling up into the sky (negative boom pitch).
 * Far 3rd-person: lock to horizontal+ only so orbit stays grounded.
 */
function pitchMinForDistance(dist: number): number {
  if (dist <= CAM_FPV_MAX_DISTANCE) return CAM_PITCH_LOOK_UP
  if (dist >= CAM_PITCH_LOOK_UP_LOCK_DIST) return CAM_PITCH_MIN
  const t = (dist - CAM_FPV_MAX_DISTANCE) / (CAM_PITCH_LOOK_UP_LOCK_DIST - CAM_FPV_MAX_DISTANCE)
  const s = t * t * (3 - 2 * t)
  return THREE.MathUtils.lerp(CAM_PITCH_LOOK_UP, CAM_PITCH_MIN, s)
}

/** Pivot + look-at heights vs zoom — close frames the head, far sits behind shoulders. */
function camHeightsForDistance(dist: number): { pivotY: number; lookY: number } {
  if (dist <= CAM_HEIGHT_NEAR_DIST) {
    return { pivotY: CAM_PIVOT_HEIGHT_NEAR, lookY: CAM_LOOK_HEIGHT_NEAR }
  }
  if (dist >= CAM_HEIGHT_FAR_DIST) {
    return { pivotY: CAM_PIVOT_HEIGHT_FAR, lookY: CAM_LOOK_HEIGHT_FAR }
  }
  const t = (dist - CAM_HEIGHT_NEAR_DIST) / (CAM_HEIGHT_FAR_DIST - CAM_HEIGHT_NEAR_DIST)
  const s = t * t * (3 - 2 * t)
  return {
    pivotY: THREE.MathUtils.lerp(CAM_PIVOT_HEIGHT_NEAR, CAM_PIVOT_HEIGHT_FAR, s),
    lookY: THREE.MathUtils.lerp(CAM_LOOK_HEIGHT_NEAR, CAM_LOOK_HEIGHT_FAR, s)
  }
}

/** True when movePlayerTo authors a real cameraTarget (not empty `{}`). */
function hasCameraTargetCoords(
  t: { x?: number; y?: number; z?: number } | null | undefined
): boolean {
  if (!t || typeof t !== 'object') return false
  return (
    (typeof t.x === 'number' && Number.isFinite(t.x)) ||
    (typeof t.y === 'number' && Number.isFinite(t.y)) ||
    (typeof t.z === 'number' && Number.isFinite(t.z))
  )
}
const GRAVITY = 20
const GROUND_ACCEL = 48
const AIR_ACCEL = 22
const GROUND_STOP_DRAG = 14
const AIR_MOMENTUM_DRAG = 0.8
/** Third-person facing follows camera yaw while moving (Hyperfy / DCL pattern). */
const PLAYER_TURN_SMOOTH = 12
const FACING_SPEED_MIN = 0.12
const GROUND_COYOTE_SECONDS = 0.15
const AIR_JUMP_DELAY = 0.2
/** No scene.json spawnPoints — start slightly above y=0 and let CCT fall onto colliders. */
const DEFAULT_SPAWN_FEET_Y = 1

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v))
}

function lerpAngle(from: number, to: number, t: number): number {
  let delta = to - from
  while (delta > Math.PI) delta -= Math.PI * 2
  while (delta < -Math.PI) delta += Math.PI * 2
  return from + delta * t
}

/** Capsule player + DCL-style third-person orbit camera. */
export class PlayerSystem {
  private input: PlayerInput | null = null
  private enabled = false

  /** Orbit yaw — independent of avatar facing. */
  private camYaw = 0
  /** 0 = horizontal ring, π/2 = top-down. */
  private camPitch = CAM_PITCH_DEFAULT
  /** Avatar facing — follows movement direction when walking. */
  private playerYaw = 0
  /** Wire-facing yaw — no turn smoothing (DCL reads this while moving). */
  private networkYaw = 0
  private camDistance = CAM_DISTANCE_DEFAULT
  /**
   * ~system/Testing.setCameraTransform — hold freecam from overwriting the authored lens
   * for a few frames so SDK test runners can assert CameraEntity Transform after nextTick.
   */
  private testingCameraHoldFrames = 0

  private grounded = false
  private groundedLastFrame = false
  private nearGround = false
  private groundCoyote = 0
  private jumping = false
  private jumped = false
  private airJumped = false
  private airJumpPending = false
  private airJumpDelayLeft = 0
  private doubleJumpTriggered = false
  /** Explorer glider — hold Space while airborne after air jumps are spent. */
  private gliding = false
  /**
   * Last PhysicsCombinedImpulse.eventId applied (once per CRDT event).
   * Reset on scene/player re-init and when PE impulse is cleared (stale re-enter).
   */
  private lastImpulseEventId = 0
  /**
   * Last applied LWW Lamport for PE impulse — required for Genesis Plaza parasols which
   * write `eventId: 0` on every bounce (SDK helper uses incrementing eventId ≥ 1).
   */
  private lastImpulseLamport = 0
  /**
   * Seconds remaining where CCT may still report grounded under a trampoline after impulse.
   * Explorer ungrounds on J.y > 0; we only suppress re-stick briefly (not residual drag for seconds).
   */
  private impulseLaunchGrace = 0
  /** Optional: CRDT Lamport for PhysicsCombinedImpulse on PlayerEntity. */
  private getImpulseLamport: (() => number) | null = null
  private jumpCount = 0
  private locomotionMode: LocomotionMode = 'jog'
  private readComponents: MirrorComponents | null = null
  private groundNormal = new THREE.Vector3(0, 1, 0)
  private readonly root = new THREE.Object3D()
  /**
   * Explorer `engine.PlayerEntity` attach point — chest height + PE yaw.
   * Scene entities with `Transform.parent = PlayerEntity` parent here so local offsets
   * match DCL (feet capsule alone leaves PE children at the wrong height/orientation).
   */
  private readonly playerEntityAttach = new THREE.Object3D()
  private avatar: LocalAvatar | null = null
  private nameTag: NameTag | null = null
  /** Latest `loadAvatar` wins — overlapping VRM equips must not each attach a pill. */
  private avatarLoadGen = 0
  private playerIdentity: ProfileIdentity | null = null
  private walkBounds: PlayerWalkBounds | null = null
  private moveTask: {
    from: THREE.Vector3
    to: THREE.Vector3
    elapsed: number
    duration: number
    /** When set, avatar keeps looking at this DCL point while moving (not camera yaw). */
    avatarTarget?: { x?: number; y?: number; z?: number }
    /** Constant travel facing when no avatarTarget — movement direction of the path. */
    travelYaw?: number
  } | null = null
  /**
   * Holds capsule after timed `movePlayerTo` / emote until the player moves.
   * Instant teleports (Flagtag drown-respawn) do not lock — that blocked walk after unfreeze.
   */
  private scenePositionLock = false
  private wasProfileEmoteActive = false
  /** Prior frame locomotion allowed — clear position lock when scene unfreezes. */
  private wasLocomotionAllowed = true
  /**
   * Client gate: World holds locomotion until primary-scene colliders are prepared.
   * Independent of scene InputModifier (many scenes never freeze on load).
   */
  private collidersReadyBlock = true
  /**
   * Feet position to pin while InputModifier.disableAll is active (SpaceRunner map load /
   * fall-reset). Re-running PhysX teleport and accepting positionOut lets CCT slide off
   * spawn while map colliders rebuild → bounce at world edge, never at start.
   */
  private disableAllHoldFeet: THREE.Vector3 | null = null
  /**
   * Last long movePlayerTo feet (Three space). Death→map rebuild freezes, settles on a
   * temporary freeze pad, then unfreezes as the pad is deleted and map colliders are still
   * cooking — re-seat here on unfreeze so we land on spawn, not freefall / edge bounce.
   */
  private lastLongTeleportFeet: THREE.Vector3 | null = null
  private lastLongTeleportAt = 0
  /**
   * When sit/stool freezes walk without playing emote, WASD/Space asks main→worker to clear IM.
   * Not used for disableAll (Flagtag lobby).
   */
  private modeFreezeEscapeHandler: (() => void) | null = null
  private lastModeFreezeEscapeAt = 0
  /** Escape (or host request) — force-clear stuck MainCamera→VirtualCamera theater/VIEW SHOT. */
  private virtualCameraEscapeHandler: (() => void) | null = null
  private lastVirtualCameraEscapeAt = 0
  private virtualCameraEscapeKeyDown = false
  /** DevTools console (not Help panel) — prod mirror may be off. */
  private lastLocomotionBlockedConsoleAt = 0
  /** Stall detect: keys pressed + free locomotion + no feet move (thrash / pin bug). */
  private lastStallFeet = new THREE.Vector3()
  private stallKeysSince = 0
  private lastStallLogAt = 0
  private lastWalkClampLogAt = 0
  private lastFreezeHoldLogAt = 0
  private lastPhysProbeAt = 0
  private virtualCamera: VirtualCameraBridge | null = null
  /**
   * Prior frame VirtualCamera owned the lens. While active we keep freecam yaw/pitch
   * roughly aligned for a smooth unbind; seedFreecamFromLastVcLens runs on release.
   */
  private wasVirtualCameraActive = false
  /** Snap freecam one frame after VC clear so handoff matches last cinematic lens. */
  private freecamSnapAfterVc = false
  /** AvatarModifierArea hide (local mesh). */
  private modifierHidden = false
  /** CameraModeArea force — null when freecam is player-controlled. */
  private forcedCameraMode: ForcedCameraMode | null = null
  private preForceCamDistance: number | null = null
  /** Explorer In-World Camera (photo mode) — dedicated lens owns host.camera. */
  private photoModeActive = false
  /** Tour Focus follower — blocks locomotion + freecam; external controller owns the lens. */
  private tourFocusActive = false
  /**
   * Authored scene.json spawn for PlayerEntity/CameraEntity **before** the CCT exists.
   * Without this, clientPoseProvider reports origin (y≈0) during script boot/hydration and
   * Flagtag drown systems false-trigger then movePlayerTo the tower.
   *
   * CCT is created only in initCapsule after World seals colliders + waitForSpawnFloorReady.
   * Air spawns freefall under gravity onto cooked statics — no mid-air soft-hold park.
   */
  private stagedPlayerPose: EntityPose | null = null
  private stagedCameraPose: EntityPose | null = null
  constructor(
    private readonly host: SceneHost,
    private readonly physics: PhysXWorld
  ) {
    this.root.name = 'player'
    this.playerEntityAttach.name = 'playerEntityAttach'
    this.playerEntityAttach.position.set(0, DCL_PLAYER_ENTITY_Y_OFFSET, 0)
    this.root.add(this.playerEntityAttach)
    this.avatar = new LocalAvatar(this.root)
    this.host.scene.add(this.root)
  }

  /**
   * Keep Three.js PE-child attach at chest (+0.88) with PE yaw.
   * CRDT PlayerEntity position is feet — attach offset is visual hierarchy only.
   */
  private syncPlayerEntityAttach(): void {
    this.playerEntityAttach.position.set(0, DCL_PLAYER_ENTITY_Y_OFFSET, 0)
    // Match getEntityPose() PE rotation: Three yaw quat (before threeToDclQuat).
    this.playerEntityAttach.quaternion.copy(
      ReservedEntitiesSync.playerRotationFromYaw(this.getNetworkYaw())
    )
  }

  /**
   * Publish spawn PE/camera for scene CRDT before the capsule exists.
   * Place the avatar root at spawn feet so nothing reads origin mid-load.
   */
  stageSpawnPoses(player: EntityPose, camera: EntityPose, feetThree: THREE.Vector3): void {
    this.stagedPlayerPose = {
      position: player.position.clone(),
      rotation: player.rotation.clone()
    }
    this.stagedCameraPose = {
      position: camera.position.clone(),
      rotation: camera.rotation.clone()
    }
    this.root.position.copy(feetThree)
    this.syncPlayerEntityAttach()
  }

  clearStagedSpawnPoses(): void {
    this.stagedPlayerPose = null
    this.stagedCameraPose = null
  }

  isCapsuleReady(): boolean {
    return this.enabled
  }

  async initCapsule(
    spawn: SceneSpawn,
    walkBounds: PlayerWalkBounds,
    readComponents: MirrorComponents,
    onProgress?: (msg: string) => void,
    /**
     * Unused for placement (kept for call-site compat). Boot only probes that a surface
     * exists under the column; capsule always starts at authored feet and drops with gravity.
     */
    _floorReadyHint?: THREE.Vector3 | null
  ): Promise<void> {
    void _floorReadyHint
    this.readComponents = readComponents
    this.walkBounds = walkBounds
    this.resetExternalPhysicsState()
    physLog(
      'walk-bounds-init',
      `walkBounds ${formatWalkBounds(walkBounds)} · infiniteGround=y0 (void fall ends on sea-level box, not map height)`,
      0
    )
    this.input = new PlayerInput(this.host.renderer.domElement)
    this.input.setLocomotionBlocked(
      () =>
        this.collidersReadyBlock ||
        this.photoModeActive ||
        this.tourFocusActive ||
        !canLocomote(this.getLocomotionConfig())
    )
    this.input.setLookBlocked(
      () =>
        this.photoModeActive ||
        this.tourFocusActive ||
        this.isSceneVirtualCameraDriving()
    )
    const feetY = spawn.fromSpawnPoints
      ? spawn.y
      : spawn.y <= 0.01
        ? DEFAULT_SPAWN_FEET_Y
        : spawn.y
    // Authored scene.json feet — no CCT settle; gravity lands on cooked colliders.
    const spawnThree = dclToThreeVec(new THREE.Vector3(spawn.x, feetY, spawn.z))
    this.root.position.copy(spawnThree)
    this.physics.spawnPlayer(spawnThree)
    this.physics.warmStaticScene()
    this.grounded = false
    this.groundCoyote = 0
    this.physics.attachCapsuleDebug(this.root)
    this.enabled = true
    this.host.setOrbitEnabled(false)
    this.avatar?.setLocomotionVfxScene(this.host.scene)

    this.camYaw = 0
    this.playerYaw = 0
    this.networkYaw = 0
    this.camPitch = CAM_PITCH_DEFAULT
    this.camDistance = CAM_DISTANCE_DEFAULT

    if (spawn.cameraTarget) {
      this.applyAvatarLookTarget(spawnThree, spawn.cameraTarget)
      this.applyCameraLookTarget(spawnThree, spawn.cameraTarget)
    }

    this.root.position.copy(this.physics.positionOut)
    this.syncPlayerEntityAttach()
    this.syncCamera(true)
    this.clearStagedSpawnPoses()
    const feet = this.physics.positionOut
    console.info(
      `[player] spawn drop-in — feet=(${feet.x.toFixed(1)}, ${feet.y.toFixed(2)}, ${feet.z.toFixed(1)})` +
        ` scene.jsonY=${feetY.toFixed(2)} grounded=false`
    )
    onProgress?.('Player ready')
  }

  getLocalAvatar(): LocalAvatar | null {
    return this.avatar
  }

  setVirtualCameraBridge(bridge: VirtualCameraBridge | null): void {
    this.virtualCamera = bridge
  }

  /**
   * Multi-scene FocusOwner handoff — platform camera continuity:
   * freecam orbit (yaw/pitch/dist) is **player state**, not scene state. Primary swap
   * rebinds the VC bridge and clears MainCamera, but must not reset look.
   * Snap freecam placement to new feet; leave orbit angles untouched.
   */
  notifySceneFocusHandoff(): void {
    this.wasVirtualCameraActive = false
    try {
      this.syncCamera(true, 1 / 60)
    } catch {
      /* host may be mid-teardown */
    }
  }

  async loadAvatar(
    onProgress?: (msg: string) => void,
    profileOverride?: AvatarProfile | null
  ): Promise<void> {
    const gen = ++this.avatarLoadGen
    onProgress?.('Loading avatar…')
    const avatarOptions = avatarOptionsFromUrl()
    // Only trust the override when it belongs to the profile being rendered —
    // a ?profile= URL override must still fetch that other profile.
    const overrideApplies =
      !!profileOverride &&
      (!avatarOptions.profileId ||
        avatarOptions.profileId.toLowerCase() === (profileOverride.address ?? '').toLowerCase())
    try {
      const identity =
        (await this.avatar?.load(
          overrideApplies ? { ...avatarOptions, profile: profileOverride } : avatarOptions
        )) ?? null
      if (gen !== this.avatarLoadGen) return
      this.playerIdentity = identity
    } catch (err) {
      if (gen !== this.avatarLoadGen) return
      console.warn('Avatar load failed — continuing with invisible capsule', err)
      clientDebugLog.log(
        'avatar',
        `load failed — invisible capsule · ${err instanceof Error ? err.message : String(err)}`,
        { alsoConsole: true, level: 'error' }
      )
    }

    if (gen !== this.avatarLoadGen) return
    this.dropNameTag()
    if (this.avatar && this.playerIdentity && areSceneNameTagsVisible()) {
      this.nameTag = NameTag.attach(this.avatar.nameTagAnchor, this.playerIdentity.displayName, {
        textColor: this.playerIdentity.nameColor,
        claimed: this.playerIdentity.hasClaimedName
      })
    }

    this.syncNameTag()
    this.syncCamera(true)
  }

  /** Reload avatar after backpack equip / profile save. Pass session profile so a
   *  just-deployed outfit renders even before Catalyst lambdas propagate it. */
  async reloadAvatar(
    onProgress?: (msg: string) => void,
    profileOverride?: AvatarProfile | null
  ): Promise<void> {
    this.dropNameTag()
    const genBefore = this.avatarLoadGen
    await this.loadAvatar(onProgress, profileOverride)
    // A newer equip started while we awaited — that load owns the tag + visibility.
    if (this.avatarLoadGen !== genBefore + 1) return
    this.forceRefreshBodyVisibility()
  }

  private dropNameTag(): void {
    this.nameTag?.dispose()
    this.nameTag = null
  }

  /**
   * After mesh swap (custom VRM equip), re-apply FPV / modifier visibility so the
   * new model is not left invisible if a prior hide stuck on the old root.
   */
  forceRefreshBodyVisibility(): void {
    if (!this.avatar) return
    const fpv = this.isFirstPerson()
    this.avatar.setBodyVisible(!this.modifierHidden && !fpv)
    this.syncNameTag()
  }

  /** Force-refresh local overhead label (Explorer [N] — with remotes + AvatarShapes). */
  applyNameTagsVisibility(): void {
    this.syncNameTag()
    if (this.nameTag) {
      this.nameTag.object.visible =
        !this.modifierHidden && areSceneNameTagsVisible() && !this.isFirstPerson()
    }
  }

  setAssetCache(cache: AssetCache, peerUrl?: string): void {
    this.avatar?.setAssetCache(cache, peerUrl)
  }

  setLocomotionVfxScene(scene: THREE.Scene): void {
    this.avatar?.setLocomotionVfxScene(scene)
  }

  getLocomotionConfig(): LocomotionConfig {
    if (!this.readComponents) return defaultLocomotionConfig()
    return readLocomotionFromComponents(this.readComponents, SDK_RESERVED.player)
  }

  /**
   * Multi-scene promote — player must read InputModifier/MainCamera from the **new**
   * primary SceneScriptSystem. Leaving the demoted system's MirrorComponents bound
   * freezes locomotion after walk-back (stale disableAll / hold pin).
   */
  setReadComponents(readComponents: MirrorComponents): void {
    this.readComponents = readComponents
  }

  /**
   * Release disableAll foot pin after promote handoff so the player can walk while
   * the new primary hydrates (scene may re-freeze later via legitimate InputModifier).
   */
  releaseSceneFreezeHold(reason = 'promote'): void {
    if (this.disableAllHoldFeet) {
      const f = this.disableAllHoldFeet
      physLog(
        'freeze-hold-clear',
        `disableAll hold force-clear (${reason}) · lastPin=(${f.x.toFixed(1)},${f.y.toFixed(2)},${f.z.toFixed(1)})`,
        0
      )
      console.info(
        `[player] freeze hold force-clear (${reason}) @ (${f.x.toFixed(1)},${f.y.toFixed(2)},${f.z.toFixed(1)})`
      )
    }
    this.disableAllHoldFeet = null
    this.scenePositionLock = false
    this.moveTask = null
    this.wasLocomotionAllowed = true
    this.stallKeysSince = 0
  }

  /**
   * COD multi-scene: if WASD held and feet don't move while locomotion claims free,
   * log the stall and auto-clear stale hold/lock (thrash or pin bug).
   */
  private detectMovementStall(delta: number): void {
    if (!this.input) return
    const keys =
      this.input.keys.w ||
      this.input.keys.a ||
      this.input.keys.s ||
      this.input.keys.d ||
      this.input.spacePressed
    const now = performance.now()
    if (!keys) {
      this.stallKeysSince = 0
      this.lastStallFeet.copy(this.root.position)
      return
    }
    const moved = this.root.position.distanceToSquared(this.lastStallFeet) > 0.01 // ~0.1m
    if (moved) {
      this.stallKeysSince = 0
      this.lastStallFeet.copy(this.root.position)
      return
    }
    if (this.stallKeysSince <= 0) this.stallKeysSince = now
    const stalledMs = now - this.stallKeysSince
    if (stalledMs < 800) return
    // Auto-recover: stale hold / position lock / thrash pin
    if (this.disableAllHoldFeet || this.scenePositionLock) {
      console.warn(
        `[player] STALL RECOVER ${stalledMs.toFixed(0)}ms keys held, feet stuck — clearing hold/lock ` +
          `(hold=${!!this.disableAllHoldFeet} lock=${this.scenePositionLock} collidersBlock=${this.collidersReadyBlock})`
      )
      this.releaseSceneFreezeHold('stall-recover')
    } else if (now - this.lastStallLogAt > 2000) {
      this.lastStallLogAt = now
      const loc = this.getLocomotionConfig()
      console.warn(
        `[player] STALL ${stalledMs.toFixed(0)}ms keys held feet stuck but free ` +
          `disableAll=${loc.disableAll} collidersBlock=${this.collidersReadyBlock} ` +
          `vc=${this.isSceneVirtualCameraDriving()} delta=${(delta * 1000).toFixed(1)}ms ` +
          `pos=(${this.root.position.x.toFixed(1)},${this.root.position.y.toFixed(2)},${this.root.position.z.toFixed(1)})`
      )
    }
  }

  /** Main/World — clear stuck sit mode-freeze when player presses WASD/Space. */
  setModeFreezeEscapeHandler(handler: (() => void) | null): void {
    this.modeFreezeEscapeHandler = handler
  }

  /** Main/World — Escape exits stuck plaza theater / VIEW SHOT VirtualCamera. */
  setVirtualCameraEscapeHandler(handler: (() => void) | null): void {
    this.virtualCameraEscapeHandler = handler
  }

  canPlayVoluntaryEmote(): boolean {
    return canVoluntaryEmote(this.getLocomotionConfig())
  }

  playEmote(emoteId: string, options?: PlayEmoteOptions): Promise<ResolvedProfileEmote | null> {
    return this.avatar?.playEmote(emoteId, options) ?? Promise.resolve(null)
  }

  stopEmote(): void {
    this.avatar?.stopEmote()
  }

  isProfileEmoteActive(): boolean {
    return this.avatar?.isProfileEmoteActive() ?? false
  }

  /** @deprecated Use initCapsule + loadAvatar for social-first boot order. */
  async init(
    spawn: SceneSpawn,
    walkBounds: PlayerWalkBounds,
    readComponents: MirrorComponents,
    onProgress?: (msg: string) => void
  ): Promise<void> {
    await this.initCapsule(spawn, walkBounds, readComponents, onProgress)
    await this.loadAvatar(onProgress)
  }

  dispose(): void {
    this.avatarLoadGen++
    this.resetExternalPhysicsState()
    this.input?.dispose()
    this.input = null
    this.dropNameTag()
    this.avatar?.dispose()
    this.avatar = null
    this.enabled = false
    this.clearStagedSpawnPoses()
    this.host.setOrbitEnabled(true)
  }

  /** Snap third-person camera before the first render after load. */
  snapCamera(): void {
    if (!this.enabled) return
    this.syncCamera(true)
  }

  /**
   * `Transform.get(PlayerEntity).position` — **feet** in scene-relative DCL meters.
   * (Chest attach for PE-parented meshes lives on {@link getPlayerRoot}, not here.)
   */
  getPlayerEntityPositionDcl(): THREE.Vector3 {
    if (!this.enabled && this.stagedPlayerPose) {
      return this.stagedPlayerPose.position.clone()
    }
    return playerEntityPositionFromThreeFeet(this.root.position)
  }

  /** PlayerEntity pose for CRDT / scene reads — position is feet; rotation is wire yaw. */
  getEntityPose(): EntityPose {
    if (!this.enabled && this.stagedPlayerPose) {
      return {
        position: this.stagedPlayerPose.position.clone(),
        rotation: this.stagedPlayerPose.rotation.clone()
      }
    }
    return {
      position: this.getPlayerEntityPositionDcl(),
      rotation: threeToDclQuat(ReservedEntitiesSync.playerRotationFromYaw(this.getNetworkYaw()))
    }
  }

  /**
   * Three.js parent for Transform.parent=PlayerEntity (spatial audio, weapons).
   * Elevated +0.88 so PE-child local offsets match Explorer chest-relative parenting,
   * while CRDT PE position remains feet.
   */
  getPlayerRoot(): THREE.Object3D {
    return this.playerEntityAttach
  }

  /** Capsule feet root (physics / world position). */
  getPlayerFeetRoot(): THREE.Object3D {
    return this.root
  }

  /** Scene-local DCL meters (+X east, +Z north). */
  /** Apply PhysX foot position to the avatar root (after prewarm / teleport snap). */
  syncFromPhysics(): void {
    this.root.position.copy(this.physics.positionOut)
    this.syncPlayerEntityAttach()
    this.syncCamera(true)
  }

  getPosition(): THREE.Vector3 {
    return threeToDclVec(this.root.position)
  }

  /** Three.js world position for renderer raycast distance checks. */
  getWorldPosition(): THREE.Vector3 {
    return this.root.position
  }

  isPointerBlocked(): boolean {
    // Orbit drag blocks some HUD picks; pointer-lock look does not (Explorer parity).
    return this.input?.orbiting ?? false
  }

  isPointerLocked(): boolean {
    return this.input?.pointer.locked ?? false
  }

  /**
   * Explorer In-World Camera mode — blocks avatar locomotion + orbit freecam.
   * World drives host.camera via PhotoCameraController while active.
   */
  setPhotoModeActive(active: boolean): void {
    this.photoModeActive = active
    if (active) {
      this.input?.stopOrbitIfActive()
      if (this.input?.pointer.locked) document.exitPointerLock()
    }
  }

  isPhotoModeActive(): boolean {
    return this.photoModeActive
  }

  /**
   * Tour Focus (follower) — blocks locomotion + freecam look/zoom.
   * {@link TourFocusController} drives host.camera from the leader freecam stream.
   */
  setTourFocusActive(active: boolean): void {
    this.tourFocusActive = active
    if (active) {
      this.input?.stopOrbitIfActive()
      if (this.input?.pointer.locked) document.exitPointerLock()
      this.input?.clearMovementKeys()
    }
  }

  isTourFocusActive(): boolean {
    return this.tourFocusActive
  }

  /** Leader freecam snapshot for Tour Focus wire (yaw/pitch/dist/fp). */
  getFreecamState(): { yaw: number; pitch: number; dist: number; firstPerson: boolean } {
    return {
      yaw: this.camYaw,
      pitch: this.camPitch,
      dist: this.camDistance,
      firstPerson: this.isFirstPerson()
    }
  }

  /**
   * CameraModeArea — force freecam 1st/3rd while inside. Restores prior distance on clear.
   * No-op while a VirtualCamera owns the lens.
   */
  setForcedCameraMode(mode: ForcedCameraMode | null): void {
    if (mode === this.forcedCameraMode) return
    if (mode !== null && this.forcedCameraMode === null) {
      this.preForceCamDistance = this.camDistance
    }
    if (mode === null) {
      if (this.preForceCamDistance !== null) {
        this.camDistance = this.preForceCamDistance
        this.preForceCamDistance = null
      }
      this.forcedCameraMode = null
      return
    }
    this.forcedCameraMode = mode
    if (mode === 'first_person') {
      this.camDistance = 0
    } else if (this.camDistance <= CAM_FPV_MAX_DISTANCE) {
      const restore = this.preForceCamDistance
      this.camDistance =
        restore !== null && restore > CAM_FPV_MAX_DISTANCE ? restore : CAM_DISTANCE_DEFAULT
    }
  }

  getSceneKeyboardSnapshot(): SceneKeyboardSnapshot {
    return (
      this.input?.getSceneKeyboardSnapshot() ?? {
        forward: false,
        backward: false,
        left: false,
        right: false,
        jump: false,
        ctrl: false,
        action3: false,
        action4: false,
        action5: false,
        action6: false
      }
    )
  }

  isSceneRelayBlocked(): boolean {
    return this.input?.isSceneRelayBlocked() ?? true
  }

  isLocomotionBlocked(): boolean {
    return this.collidersReadyBlock || !canLocomote(this.getLocomotionConfig())
  }

  /**
   * World platform gate — walk only after primary colliders are prepared for play.
   * Starts blocked; World calls true after prepareCollidersForPlay + capsule.
   */
  setCollidersReady(ready: boolean): void {
    this.collidersReadyBlock = !ready
    if (ready) {
      this.clearMoveKeys()
    }
  }

  isCollidersReady(): boolean {
    return !this.collidersReadyBlock
  }

  clearMoveKeys(): void {
    this.input?.clearMovementKeys()
  }

  cancelCameraPointer(): void {
    this.input?.cancelCameraPointer()
  }

  setJumpHeld(down: boolean): void {
    this.input?.setJumpHeld(down)
  }

  setOnUserGestureUnlock(callback: () => void): void {
    this.input?.setOnUserGestureUnlock(callback)
  }

  /** Scene chat line shown inside the overhead name-tag pill. */
  /** Nearby-voice bars above local name tag while mic is live. */
  /**
   * AvatarModifierArea AMT_HIDE_AVATARS — hide local body + name tag.
   * Camera still follows; mesh invisible to self and others (local client).
   */
  setModifierHidden(hidden: boolean): void {
    this.modifierHidden = hidden
    this.avatar?.setBodyVisible(!hidden && !this.isFirstPerson())
    if (this.nameTag) {
      this.nameTag.object.visible = !hidden && areSceneNameTagsVisible() && !this.isFirstPerson()
    }
  }

  setNameTagVoiceLevel(level: number): void {
    this.nameTag?.setVoiceLevel(level)
  }

  showNameTagChat(text: string): void {
    if (!areSceneNameTagsVisible()) return
    this.nameTag?.showChat(text)
  }

  /** Local-only private message overhead (outgoing: "Name DM to Peer"). */
  showNameTagDmChat(
    text: string,
    options: { mode: 'outgoing' | 'incoming'; peerName?: string }
  ): void {
    if (!areSceneNameTagsVisible()) return
    this.nameTag?.showDmChat(text, options)
  }

  getPlayerYaw(): number {
    return this.playerYaw
  }

  /**
   * Horizontal locomotion speed (m/s) for leash companions / AFK timers.
   * Uses the same velocity sample as avatar gait.
   */
  getHorizontalSpeed(): number {
    return Math.hypot(_velocity.x, _velocity.z)
  }

  /** Immediate movement/camera facing for RFC4 — DCL scene yaw, not locally smoothed. */
  getNetworkYaw(): number {
    return normalizeAngle(threeYawToDclYaw(this.networkYaw))
  }

  /**
   * Canvas angle for minimap triangle: 0 = tip toward map north (up).
   * Derived from the **same** `playerYaw` that drives `avatar.setYaw` (incl. move snaps).
   */
  getMinimapFacingAngle(): number {
    // Visual body faces bind +Z after setYaw (playerYaw + AVATAR_YAW_OFFSET) — not Object3D -Z.
    const meshYaw = this.playerYaw + AVATAR_YAW_OFFSET
    const fx = Math.sin(meshYaw)
    const fz = Math.cos(meshYaw)
    // Three X is reflected vs DCL; map east = +X dcl = -fx, map north = +Z = fz.
    const east = -fx
    const north = fz
    return Math.atan2(east, north)
  }

  /** RFC4 Movement jump / grounded / glide flags for remote locomotion parity. */
  getLocomotionWireState(): {
    isGrounded: boolean
    isJumping: boolean
    jumpCount: number
    isFalling: boolean
    glideState: number
  } {
    // Prefer visual prop phase (open/close); fall back to physics gliding bit.
    const glideState =
      this.avatar?.getGlideStateWire() ??
      (this.gliding && !this.grounded ? 2 /* GLIDING */ : 0)
    return {
      isGrounded: this.grounded,
      isJumping: this.jumping || this.jumped || this.airJumpPending,
      jumpCount: this.jumpCount,
      isFalling:
        !this.grounded &&
        !this.gliding &&
        !this.jumping &&
        !this.jumped &&
        !this.airJumped &&
        _velocity.y < -1.5,
      glideState
    }
  }

  /**
   * DCL `RestrictedActions.movePlayerTo` — `newRelativePosition` is **feet** (not PE chest).
   * Docs: Vector3.create(1, 0, 1) stands on y=0. Flagtag drown-respawn uses tower feet Y.
   */
  movePlayerTo(request: MovePlayerToRequest): boolean {
    if (!this.enabled || !this.walkBounds) return false

    const pos = request.newRelativePosition
    if (!pos) return false

    const currentFeetDcl = threeToDclVec(this.root.position)
    const requestedFeetDcl = new THREE.Vector3(
      pos.x ?? currentFeetDcl.x,
      pos.y ?? currentFeetDcl.y,
      pos.z ?? currentFeetDcl.z
    )
    const targetFeetDcl = resolveMovePlayerToTargetFeetDcl(
      requestedFeetDcl,
      currentFeetDcl,
      request.avatarTarget
    )
    clampToWalkBounds(targetFeetDcl, this.walkBounds)
    const target = dclToThreeVec(targetFeetDcl)
    const reposition =
      Math.hypot(target.x - this.root.position.x, target.z - this.root.position.z) > 1e-3 ||
      Math.abs(target.y - this.root.position.y) > 1e-3

    const avatarTarget = request.avatarTarget
    const from = this.root.position.clone()
    const duration = request.duration ?? 0

    if (!reposition || duration <= 0) {
      if (reposition) {
        // Seat snaps: short move + avatarTarget → trust authored feet (no settle).
        // Long elevated (map↔lobby): authored pose + gravity drop after freeze clears.
        // Ground-level long jumps: one-shot CCT settle when floor already under feet.
        const horiz = Math.hypot(target.x - from.x, target.z - from.z)
        const vert = Math.abs(target.y - from.y)
        const longRespawn = horiz > 2.5 || vert > 2
        const settle = longRespawn || !avatarTarget
        const reqDcl = requestedFeetDcl
        const tgtDcl = threeToDclVec(target)
        clientDebugLog.consoleOnly(
          'info',
          `[player] movePlayerTo · dcl=(${reqDcl.x.toFixed(1)},${reqDcl.y.toFixed(2)},${reqDcl.z.toFixed(1)}) ` +
            `→ three=(${target.x.toFixed(1)},${target.y.toFixed(2)},${target.z.toFixed(1)}) ` +
            `tgtDcl=(${tgtDcl.x.toFixed(1)},${tgtDcl.y.toFixed(2)},${tgtDcl.z.toFixed(1)}) ` +
            `long=${longRespawn} settle=${settle} elevatedDrop=${longRespawn && target.y > 8} ` +
            `fromThree=(${from.x.toFixed(1)},${from.y.toFixed(2)},${from.z.toFixed(1)})`
        )
        this.teleportTo(target, settle, longRespawn)
        if (longRespawn) {
          this.lastLongTeleportFeet = target.clone()
          this.lastLongTeleportAt = performance.now()
        }
        // Pin authored feet while InputModifier.disableAll (map rebuild / load gate).
        // Scene freeze holds pose; on unfreeze gravity drops onto cooked colliders.
        if (!canLocomote(this.getLocomotionConfig())) {
          this.disableAllHoldFeet = (longRespawn ? target : this.root.position).clone()
          const f = this.disableAllHoldFeet
          physLog(
            'freeze-hold-set',
            `disableAll hold set after movePlayerTo · feet three=(${f.x.toFixed(1)},${f.y.toFixed(2)},${f.z.toFixed(1)}) settle=${settle} long=${longRespawn}`,
            0
          )
        }
      }
      // Face/look from the **final** seat pose — not pre-teleport feet (sit rotation was wrong).
      const lookFrom = this.root.position
      if (avatarTarget) {
        this.applyAvatarLookTarget(lookFrom, avatarTarget)
      }
      // Only retarget freecam when the scene authors cameraTarget. Without it, keep orbit
      // angles and immediately re-seat boom on the new feet (do not wait a frame — seat
      // InputModifier freeze + VC unbind left camera under the pad for a full tick).
      if (hasCameraTargetCoords(request.cameraTarget)) {
        this.applyCameraLookTarget(lookFrom, request.cameraTarget!)
        this.placeFreecamBoomOnFeetHard()
      } else if (reposition) {
        this.placeFreecamBoomOnFeetHard()
      }
      if (this.isFirstPerson()) {
        if (request.avatarTarget) {
          this.camYaw = this.playerYaw
        } else if (hasCameraTargetCoords(request.cameraTarget)) {
          this.playerYaw = this.camYaw
        }
      }
      this.avatar?.setYaw(this.playerYaw)
      this.moveTask = null
      // Instant movePlayerTo / look-only / round reset — do NOT lock locomotion.
      // Only timed walks use scenePositionLock (cleared on arrival or unfreeze).
      this.scenePositionLock = false
      return true
    }

    let travelYaw: number | undefined
    if (!avatarTarget) {
      const dx = target.x - from.x
      const dz = target.z - from.z
      if (Math.hypot(dx, dz) > 1e-4) {
        travelYaw = Math.atan2(-dx, -dz)
        this.setAvatarFacing(travelYaw)
      }
    }

    this.moveTask = {
      from,
      to: target,
      elapsed: 0,
      duration,
      avatarTarget,
      travelYaw
    }
    _velocity.set(0, 0, 0)
    _externalVelocity.set(0, 0, 0)
    this.impulseLaunchGrace = 0
    // Timed path only — holds keys until arrival (docs: transition can be interrupted by move).
    this.scenePositionLock = true
    return true
  }

  getCameraEntityPose(): EntityPose {
    if (!this.enabled && this.stagedCameraPose) {
      return {
        position: this.stagedCameraPose.position.clone(),
        rotation: this.stagedCameraPose.rotation.clone()
      }
    }
    return ReservedEntitiesSync.cameraPose(this.host.camera)
  }

  /**
   * ~system/Testing.setCameraTransform — place host camera at the given DCL CameraEntity pose
   * and hold freecam briefly so reserved sync / nextTick assertions see the same transform.
   */
  setTestingCameraTransform(request: SetCameraTransformRequest): boolean {
    const pos = request.position
    const rot = request.rotation
    if (!pos || !rot) return false
    dclToThreePos(pos.x ?? 0, pos.y ?? 0, pos.z ?? 0, this.host.camera.position)
    dclToThreeQuat(rot.x ?? 0, rot.y ?? 0, rot.z ?? 0, rot.w ?? 1, this.host.camera.quaternion)
    this.host.camera.updateMatrixWorld(true)
    // Align freecam orbit so release of the hold does not hard-snap.
    _camEuler.setFromQuaternion(this.host.camera.quaternion, 'YXZ')
    this.camYaw = normalizeAngle(_camEuler.y)
    this.camPitch = clamp(_camEuler.x, pitchMinForDistance(this.camDistance), CAM_PITCH_MAX)
    this.testingCameraHoldFrames = 4
    return true
  }

  update(delta: number): void {
    if (!this.enabled || !this.input) return
    delta = Math.min(delta, 1 / 20)

    // Escape while MainCamera→VC is bound (plaza theater stuck, VIEW SHOT hang).
    this.pollVirtualCameraEscape()

    const locomotion = this.getLocomotionConfig()
    const imBlocked = !canLocomote(locomotion)
    const intentionalDisableAll = locomotion.disableAll === true
    const locomotionAllowed = !this.collidersReadyBlock && !imBlocked
    if (!locomotionAllowed) {
      // COD: always log why we block (prove IM vs colliders vs thrash).
      const blockedMsg =
        `locomotion blocked — collidersReadyBlock=${this.collidersReadyBlock} ` +
        `disableAll=${locomotion.disableAll} walk=${locomotion.disableWalk} ` +
        `jog=${locomotion.disableJog} run=${locomotion.disableRun} ` +
        `holdPin=${!!this.disableAllHoldFeet} vc=${this.isSceneVirtualCameraDriving()}`
      clientDebugLog.log('player', blockedMsg, {
        throttleMs: 2000,
        throttleKey: 'locomotion-blocked'
      })
      const nowBlocked = performance.now()
      if (nowBlocked - this.lastLocomotionBlockedConsoleAt > 2000) {
        this.lastLocomotionBlockedConsoleAt = nowBlocked
        clientDebugLog.consoleOnly('warn', `[player] ${blockedMsg}`)
      }
      // Sit/stool mode-freeze (not disableAll): WASD/Space escapes when scene forgot to unfreeze
      // (handler crashed before triggerSceneEmote — remotes can still sit via Explorer emotes).
      const wantEscape =
        isModeOnlyLocomotionFreeze(locomotion) &&
        (this.input.keys.w ||
          this.input.keys.a ||
          this.input.keys.s ||
          this.input.keys.d ||
          this.input.spacePressed)
      if (wantEscape && this.modeFreezeEscapeHandler) {
        const now = performance.now()
        if (now - this.lastModeFreezeEscapeAt > 350) {
          this.lastModeFreezeEscapeAt = now
          this.modeFreezeEscapeHandler()
          this.scenePositionLock = false
          this.avatar?.stopEmote()
        }
      }
      this.input.clearMovementKeys()
      _velocity.set(0, 0, 0)
      _externalVelocity.set(0, 0, 0)
      _force.set(0, 0, 0)
      // CRITICAL: only pin feet for intentional InputModifier.disableAll (SpaceRunner lobby).
      // collidersReadyBlock / mode freezes / multi-scene thrash must NOT arm the hold pin —
      // that was trapping walk-back with keys still logging and feet teleported every frame.
      if (intentionalDisableAll) {
        if (!this.disableAllHoldFeet) {
          this.disableAllHoldFeet = this.root.position.clone()
          const f = this.disableAllHoldFeet
          physLog(
            'freeze-hold-arm',
            `disableAll hold armed · feet three=(${f.x.toFixed(1)},${f.y.toFixed(2)},${f.z.toFixed(1)}) ` +
              `(intentional disableAll only)`,
            0
          )
          console.info(
            `[player] disableAll hold armed @ (${f.x.toFixed(1)},${f.y.toFixed(2)},${f.z.toFixed(1)})`
          )
        } else if (performance.now() - this.lastFreezeHoldLogAt > 2000) {
          this.lastFreezeHoldLogAt = performance.now()
          const f = this.disableAllHoldFeet
          physLog(
            'freeze-hold-pin',
            `disableAll pinned · feet=(${f.x.toFixed(1)},${f.y.toFixed(2)},${f.z.toFixed(1)})`,
            2000
          )
        }
        this.root.position.copy(this.disableAllHoldFeet)
        this.physics.teleport(this.disableAllHoldFeet)
        this.root.position.copy(this.disableAllHoldFeet)
      } else if (this.disableAllHoldFeet) {
        // Stale pin without disableAll — release (multi-scene false freeze trap).
        console.warn(
          `[player] releasing stale disableAll hold (imBlocked=${imBlocked} collidersBlock=${this.collidersReadyBlock})`
        )
        this.disableAllHoldFeet = null
      }
      this.grounded = true
      this.groundCoyote = 0.12
      this.syncWireYawFromAvatar()
      this.syncPlayerEntityAttach()
      this.syncNameTag()
      this.avatar?.setYaw(this.playerYaw)
      this.avatar?.update(delta, {
        horizontalSpeed: 0,
        grounded: true,
        nearGround: true,
        verticalVelocity: 0,
        locomotionMode: this.locomotionMode,
        jumping: false,
        doubleJumping: false,
        doubleJumpTriggered: false,
        falling: false,
        gliding: false,
        moveAxisX: 0,
        moveAxisZ: 0
      })
      // Freecam always allowed when not VC-bound (multi-scene walk must orbit).
      this.applyCameraInputFromPointer()
      this.syncCamera(false, delta)
      this.input.endFrame()
      this.wasLocomotionAllowed = false
      return
    } else if (!this.wasLocomotionAllowed) {
      // Scene just unfroze (Flagtag join / map load FINISHED) — release freeze pin, but
      // re-seat long respawns: freeze pad under spawn is often deleted the same frame,
      // and map GLTF colliders may still be cooking → freefall / wrong XZ without re-teleport.
      const pin =
        this.disableAllHoldFeet?.clone() ??
        (this.lastLongTeleportFeet && performance.now() - this.lastLongTeleportAt < 12_000
          ? this.lastLongTeleportFeet.clone()
          : null)
      if (this.disableAllHoldFeet) {
        const f = this.disableAllHoldFeet
        physLog(
          'freeze-hold-clear',
          `disableAll hold cleared · lastPin=(${f.x.toFixed(1)},${f.y.toFixed(2)},${f.z.toFixed(1)})`,
          0
        )
      }
      this.scenePositionLock = false
      this.moveTask = null
      this.disableAllHoldFeet = null
      if (pin) {
        const longRecent =
          !!this.lastLongTeleportFeet && performance.now() - this.lastLongTeleportAt < 12_000
        physLog(
          'freeze-hold-reseat',
          `unfreeze re-seat · feet three=(${pin.x.toFixed(1)},${pin.y.toFixed(2)},${pin.z.toFixed(1)}) longRecent=${longRecent}`,
          0
        )
        this.teleportTo(pin, true, longRecent)
      }
    }
    this.wasLocomotionAllowed = locomotionAllowed
    const jumpLocomotionAllowed = canJumpLocomotion(locomotion)
    const doubleJumpLocomotionAllowed = canDoubleJumpLocomotion(locomotion)
    const glideAllowed = canGlide(locomotion)

    const emoteActive = this.avatar?.isProfileEmoteActive() ?? false
    if (this.wasProfileEmoteActive && !emoteActive) {
      this.scenePositionLock = false
    }
    this.wasProfileEmoteActive = emoteActive

    const movingKeys =
      this.input.keys.w || this.input.keys.a || this.input.keys.s || this.input.keys.d
    const breakSceneHold =
      (movingKeys && locomotionAllowed) ||
      (this.input.spacePressed && (jumpLocomotionAllowed || doubleJumpLocomotionAllowed))
    if (breakSceneHold && this.scenePositionLock) {
      this.scenePositionLock = false
      this.avatar?.stopEmote()
    }

    if (this.moveTask) {
      if (breakSceneHold) {
        this.moveTask = null
        this.scenePositionLock = false
      } else {
        this.moveTask.elapsed += delta
        const t = Math.min(1, this.moveTask.elapsed / this.moveTask.duration)
        _pivot.copy(this.moveTask.from).lerp(this.moveTask.to, t)
        // No settle mid-lerp — docs: colliders ignored during duration transition.
        this.teleportTo(_pivot, false)
        if (this.moveTask.avatarTarget) {
          this.applyAvatarLookTarget(_pivot, this.moveTask.avatarTarget)
        } else if (this.moveTask.travelYaw !== undefined) {
          this.setAvatarFacing(this.moveTask.travelYaw)
        }
        const moveSpeed =
          this.moveTask.from.distanceTo(this.moveTask.to) / Math.max(this.moveTask.duration, 1e-6)
        this.syncNameTag()
        this.avatar?.setYaw(this.playerYaw)
        this.avatar?.update(delta, {
          horizontalSpeed: moveSpeed,
          grounded: true,
          nearGround: true,
          verticalVelocity: 0,
          locomotionMode: this.locomotionMode,
          jumping: false,
          doubleJumping: false,
          doubleJumpTriggered: false,
          falling: false
        })
        this.applyCameraInputFromPointer()
        this.syncCamera(false, delta)
        this.input.endFrame()
        if (t >= 1) {
          const dest = this.moveTask.to
          this.moveTask = null
          this.teleportTo(dest, true)
          // Timed walk finished — allow free locomotion (scene can re-freeze via InputModifier).
          this.scenePositionLock = false
        }
        return
      }
    }

    if (this.scenePositionLock && !breakSceneHold) {
      clientDebugLog.log(
        'player',
        'scenePositionLock active — WASD/jump to release (timed movePlayerTo only)',
        { throttleMs: 2500, throttleKey: 'scene-position-lock', alsoConsole: true }
      )
      this.syncWireYawFromAvatar()
      this.physics.step(delta)
      this.root.position.copy(this.physics.positionOut)
      this.syncNameTag()
      this.avatar?.setYaw(this.playerYaw)
      this.avatar?.update(delta, {
        horizontalSpeed: 0,
        grounded: true,
        nearGround: true,
        verticalVelocity: 0,
        locomotionMode: this.locomotionMode,
        jumping: false,
        doubleJumping: false,
        doubleJumpTriggered: false,
        falling: false
      })
      this.applyCameraInputFromPointer()
      this.syncCamera(false, delta)
      this.input.endFrame()
      return
    }

    // Photo mode: freeze locomotion input; dedicated PhotoCameraController owns the lens.
    if (this.photoModeActive) {
      this.physics.step(delta)
      this.root.position.copy(this.physics.positionOut)
      this.syncNameTag()
      this.avatar?.setYaw(this.playerYaw)
      this.avatar?.update(delta, {
        horizontalSpeed: 0,
        grounded: this.grounded,
        nearGround: this.nearGround,
        verticalVelocity: 0,
        locomotionMode: this.locomotionMode,
        jumping: false,
        doubleJumping: false,
        doubleJumpTriggered: false,
        falling: false,
        gliding: false,
        moveAxisX: 0,
        moveAxisZ: 0
      })
      this.input.endFrame()
      return
    }

    // Tour Focus (follower): freeze locomotion; TourFocusController owns the lens.
    if (this.tourFocusActive) {
      this.physics.step(delta)
      this.root.position.copy(this.physics.positionOut)
      this.syncNameTag()
      this.avatar?.setYaw(this.playerYaw)
      this.avatar?.update(delta, {
        horizontalSpeed: 0,
        grounded: this.grounded,
        nearGround: this.nearGround,
        verticalVelocity: 0,
        locomotionMode: this.locomotionMode,
        jumping: false,
        doubleJumping: false,
        doubleJumpTriggered: false,
        falling: false,
        gliding: false,
        moveAxisX: 0,
        moveAxisZ: 0
      })
      this.input.endFrame()
      return
    }

    this.applyCameraInputFromPointer()

    _moveDir.set(0, 0, 0)
    // Bound VirtualCamera owns the lens — WASD from camera world basis (matrix columns).
    // Using quaternion alone after X-reflect lookAt can leave A/D feeling yaw-mirrored.
    if (this.isSceneVirtualCameraDriving()) {
      this.host.camera.updateMatrixWorld(true)
      const e = this.host.camera.matrixWorld.elements
      // +X column → right; -Z column → look / forward
      _right.set(e[0], 0, e[2])
      _forward.set(-e[8], 0, -e[10])
      if (_forward.lengthSq() < 1e-8) {
        _forward.set(Math.sin(this.camYaw), 0, Math.cos(this.camYaw)).multiplyScalar(-1)
      } else {
        _forward.normalize()
      }
      if (_right.lengthSq() < 1e-8) {
        _right.set(Math.cos(this.camYaw), 0, -Math.sin(this.camYaw))
      } else {
        _right.normalize()
      }
      // Keep freecam yaw aligned so unbind does not snap locomotion facing.
      this.camYaw = Math.atan2(-_forward.x, -_forward.z)
    } else {
      _forward.set(Math.sin(this.camYaw), 0, Math.cos(this.camYaw)).multiplyScalar(-1)
      _right.set(Math.cos(this.camYaw), 0, -Math.sin(this.camYaw))
    }
    if (locomotionAllowed) {
      if (this.input.keys.w) _moveDir.add(_forward)
      if (this.input.keys.s) _moveDir.sub(_forward)
      if (this.input.keys.a) _moveDir.sub(_right)
      if (this.input.keys.d) _moveDir.add(_right)
    }
    const moving = locomotionAllowed && _moveDir.lengthSq() > 0
    if (moving) _moveDir.normalize()

    const jumpPressedForLocomotion =
      this.input.spacePressed && (jumpLocomotionAllowed || doubleJumpLocomotionAllowed)
    if (moving || jumpPressedForLocomotion) {
      this.scenePositionLock = false
      this.avatar?.stopEmote()
    }

    this.groundNormal.copy(UP)

    // Coyote counts as “can jump from floor” so first Space always registers.
    // Only true grounded resets air/glide — coyote must not cancel mid-glide.
    const canGroundJump = this.grounded || this.groundCoyote > 0
    if (this.grounded) {
      this.airJumped = false
      this.airJumpPending = false
      this.airJumpDelayLeft = 0
      this.jumpCount = 0
      this.gliding = false
    }

    this.doubleJumpTriggered = false

    if (this.jumped && !this.grounded) {
      this.jumped = false
      this.jumping = true
    }
    if (this.jumping && this.grounded) {
      this.jumping = false
    }

    this.locomotionMode = resolveLocomotionMode(this.input.keys, locomotion)
    let moveSpeed = speedForMode(this.locomotionMode, locomotion)
    if (moving && (locomotion.disableJog || locomotion.disableRun || locomotion.disableWalk)) {
      const now = performance.now()
      if (now - lastLocomotionDiagMs > 2500) {
        lastLocomotionDiagMs = now
        console.info(
          `[player] locomotion mode=${this.locomotionMode} speed=${moveSpeed.toFixed(1)} ` +
            `disable walk=${locomotion.disableWalk} jog=${locomotion.disableJog} run=${locomotion.disableRun} all=${locomotion.disableAll}`
        )
      }
    }

    if (this.jumping && !this.grounded && _velocity.y <= 0) {
      this.jumping = false
    }

    // Explorer: jump → air jump (twirl) → hold Space while falling to glide
    // (glide only after air jumps are spent — JumpCount > MaxAirJumpCount).
    const airJumpsExhausted = this.airJumped || !doubleJumpLocomotionAllowed
    if (
      this.grounded ||
      !this.input?.keys.space ||
      !glideAllowed ||
      this.airJumpPending
    ) {
      if (this.grounded || !this.input?.keys.space) this.gliding = false
    } else if (
      !this.grounded &&
      this.input.keys.space &&
      _velocity.y <= 0.35 &&
      airJumpsExhausted
    ) {
      this.gliding = true
    }

    if (this.gliding) {
      moveSpeed = locomotion.glidingSpeed
      // Cap fall only — continuous upward forces can still lift (docs).
      if (_velocity.y < -locomotion.glidingFallingSpeed) {
        _velocity.y = -locomotion.glidingFallingSpeed
      }
    }

    // Gravity after glide state is known so force Y uses 1.5× when gliding.
    // Continuous PE force Y → effective gravity (Unity ApplyExternalForce / ApplyGravity).
    // XZ force + impulses live on _externalVelocity (see applyScenePhysicsCombined).
    // Air spawns / post-teleport: freefall onto cooked colliders — no mid-air soft-hold.
    {
      const forceAy = this.sampleSceneForceAccelY(this.gliding)
      if (shouldUngroundFromForce(GRAVITY, forceAy)) {
        this.grounded = false
        this.groundCoyote = 0
      }
      const gDown = effectiveGravityDown(GRAVITY, forceAy)
      if (!this.grounded && !this.airJumpPending && !this.gliding) {
        _velocity.y -= gDown * delta
      } else if (this.gliding && !this.grounded) {
        // Glider still feels gravity but is hard-capped on descent (Explorer glidingFallingSpeed).
        _velocity.y -= gDown * delta * 0.35
      }
    }

    // Glider needs snappy diagonal steer (W+A → NW); slightly damp normal air only.
    const accel = this.grounded ? GROUND_ACCEL : this.gliding ? AIR_ACCEL * 1.45 : AIR_ACCEL
    const steerAlpha = 1 - Math.exp(-accel * delta)

    if (moving) {
      _force.copy(_moveDir).multiplyScalar(moveSpeed)
      _force.y = 0
      // Camera-relative: W+A already combines into one normalized NW dir — apply fully.
      _velocity.x += (_force.x - _velocity.x) * steerAlpha
      _velocity.z += (_force.z - _velocity.z) * steerAlpha
    } else if (this.grounded) {
      const stop = Math.max(0, 1 - GROUND_STOP_DRAG * delta)
      _velocity.x *= stop
      _velocity.z *= stop
      if (_velocity.lengthSq() < 1e-8) _velocity.set(0, 0, 0)
    } else {
      const drag = Math.max(0, 1 - AIR_MOMENTUM_DRAG * delta)
      _velocity.x *= drag
      _velocity.z *= drag
    }

    // Scene Physics.applyImpulseToPlayer / applyForceToPlayer (PlayerEntity CRDT summary).
    // After walk/gravity so impulse same-frame can cancel fall; before jump so pads win.
    this.applyScenePhysicsCombined(delta, this.gliding)

    // Ground jump — floor or coyote (so first Space is never dropped).
    if (canGroundJump && !this.jumping && this.input.spacePressed && jumpLocomotionAllowed) {
      _velocity.y = Math.sqrt(2 * GRAVITY * jumpHeightForMode(this.locomotionMode, locomotion))
      this.jumped = true
      this.jumpCount = 1
      this.gliding = false
    } else if (
      !canGroundJump &&
      !this.airJumped &&
      !this.airJumpPending &&
      this.input.spacePressed &&
      doubleJumpLocomotionAllowed &&
      !this.gliding
    ) {
      // Second Space in air → double-jump twirl (before glide).
      this.airJumpPending = true
      this.airJumpDelayLeft = AIR_JUMP_DELAY
    }

    if (this.airJumpPending) {
      this.airJumpDelayLeft -= delta
      if (this.airJumpDelayLeft <= 0) {
        _velocity.y = Math.sqrt(2 * GRAVITY * locomotion.doubleJumpHeight)
        this.airJumped = true
        this.jumping = true
        this.airJumpPending = false
        this.jumpCount = 2
        this.doubleJumpTriggered = true
        this.gliding = false
      }
    }

    // Explorer: MoveVelocity + GravityVelocity + ExternalVelocity (we fold move+g into _velocity).
    // Continuous PE force Y re-sampled here for lift stick (pad still pushing after impulse).
    const forceAyMove = this.sampleSceneForceAccelY(this.gliding)
    const forceLifting = shouldUngroundFromForce(GRAVITY, forceAyMove)
    if (forceLifting) {
      this.grounded = false
      this.groundCoyote = 0
    }

    dampAndClampExternal(_externalVelocity, this.grounded, delta)
    _displacement.copy(_velocity).add(_externalVelocity).multiplyScalar(delta)
    // Grounded: don't apply jump/up velocity into the CCT, but keep a small downward stick so
    // horizontal move on ramps/stairs follows the surface. Zeroing Y entirely left the capsule
    // floating as the deck dropped away → grounded flicker → fall/float-down animation.
    // Coyote (not grounded): keep full vertical so gravity can catch stair lips.
    // Do not stick when external lift/impulse or continuous pad force is upward.
    if (
      this.grounded &&
      !this.jumping &&
      !this.jumped &&
      !this.airJumpPending &&
      _velocity.y <= 0 &&
      _externalVelocity.y <= 1e-4 &&
      !forceLifting
    ) {
      const horiz = Math.hypot(_velocity.x, _velocity.z)
      // ~45° slope follow: need |dY| ≈ horiz * tan(45°) * delta ≈ horiz * delta, plus a base.
      const stick = Math.max(0.08, horiz * delta * 1.15) + 0.12 * delta
      _displacement.y = -stick
    }

    if (!this.jumping && !this.jumped && !this.airJumpPending && (this.grounded || this.nearGround)) {
      // CCT is kinematic — standing surface moved Δ this frame, so capsule += Δ before move().
      this.physics.applyPlatformVelocityTransfer()
    } else if (!this.grounded && !this.nearGround) {
      this.physics.clearStandingPlatform()
    }

    const moveResult = this.physics.movePlayer(_displacement, delta)
    this.grounded = moveResult.grounded
    if (this.impulseLaunchGrace > 0) {
      this.impulseLaunchGrace = Math.max(0, this.impulseLaunchGrace - delta)
    }
    // Continuous pad force still lifts (effective-g ≤ 0). Brief impulse grace only —
    // Explorer always zeros ExternalVelocity.y when grounded; do not re-unground for
    // residual drag (extY>2.5 used to loft 3–6s and made pads feel 2×+ stronger).
    const forceAyLift = this.sampleSceneForceAccelY(this.gliding)
    const stillLifting =
      shouldUngroundFromForce(GRAVITY, forceAyLift) ||
      (this.impulseLaunchGrace > 0 && _externalVelocity.y > 0.5)
    if (this.grounded && stillLifting) {
      this.grounded = false
      this.groundCoyote = 0
    } else if (this.grounded) {
      this.groundCoyote = GROUND_COYOTE_SECONDS
      if (!this.jumping) _velocity.y = 0
      // Explorer: grounded clears external Y (drag already damped XZ).
      _externalVelocity.y = 0
      this.impulseLaunchGrace = 0
      // Land — clear voluntary jump state so bounce pads don't leave jump emote on idle.
      this.jumping = false
      this.jumped = false
      this.airJumpPending = false
      this.airJumpDelayLeft = 0
      if (!this.groundedLastFrame) {
        // Air land — refresh CCT obstacle cache so elevated GLTF treads block immediately.
        this.physics.warmStaticScene()
      }
    } else {
      this.groundCoyote = Math.max(0, this.groundCoyote - delta)
    }
    this.groundedLastFrame = this.grounded
    this.physics.step(delta)

    this.nearGround = this.grounded || this.groundCoyote > 0

    const horizontalSpeed = Math.hypot(_velocity.x, _velocity.z)
    let targetYaw: number | null = null
    if (horizontalSpeed > FACING_SPEED_MIN) {
      targetYaw = Math.atan2(-_velocity.x, -_velocity.z)
    } else if (moving) {
      targetYaw = Math.atan2(-_moveDir.x, -_moveDir.z)
    }
    const locomoting = moving || horizontalSpeed > FACING_SPEED_MIN
    if (locomoting && targetYaw !== null) {
      // Snap body + CRDT wire yaw to travel direction — no turn lag behind position.
      this.setAvatarFacing(targetYaw)
    } else if (locomoting && this.isFirstPerson()) {
      this.setAvatarFacing(this.camYaw)
    } else if (targetYaw !== null) {
      const turnAlpha = 1 - Math.exp(-PLAYER_TURN_SMOOTH * delta)
      this.playerYaw = lerpAngle(this.playerYaw, targetYaw, turnAlpha)
      this.syncWireYawFromAvatar()
    } else {
      this.syncWireYawFromAvatar()
    }

    this.root.position.copy(this.physics.positionOut)
    if (this.walkBounds) {
      const dclPos = threeToDclVec(this.root.position)
      const beforeX = dclPos.x
      const beforeZ = dclPos.z
      if (clampToWalkBounds(dclPos, this.walkBounds)) {
        const now = performance.now()
        if (now - this.lastWalkClampLogAt > 600) {
          this.lastWalkClampLogAt = now
          physLog(
            'walk-clamp',
            `WALK BOUNDS clamp · feet dcl (${beforeX.toFixed(1)},${dclPos.y.toFixed(1)},${beforeZ.toFixed(1)})` +
              ` → (${dclPos.x.toFixed(1)},${dclPos.y.toFixed(1)},${dclPos.z.toFixed(1)}) · ` +
              formatWalkBounds(this.walkBounds) +
              ` · (soft invisible wall — not scene mesh)`,
            600
          )
          if (now - this.lastPhysProbeAt > 1500) {
            this.lastPhysProbeAt = now
            const three = this.root.position
            this.physics.logStaticCollidersNear(three.x, three.y, three.z, 14, 'walk-clamp-probe')
          }
        }
        this.physics.teleport(dclToThreeVec(dclPos))
        this.root.position.copy(this.physics.positionOut)
        _velocity.x = 0
        _velocity.z = 0
      }
    }
    // Wanted horizontal move but barely moved while grounded → likely wall / thick collider.
    if (
      moving &&
      this.grounded &&
      horizontalSpeed < 0.35 &&
      performance.now() - this.lastPhysProbeAt > 1200
    ) {
      this.lastPhysProbeAt = performance.now()
      const p = this.root.position
      physLog(
        'stuck-move',
        `wanted move but nearly still · grounded feet three=(${p.x.toFixed(1)},${p.y.toFixed(2)},${p.z.toFixed(1)}) ` +
          `speed=${horizontalSpeed.toFixed(2)} · probing statics`,
        1200
      )
      this.physics.logStaticCollidersNear(p.x, p.y, p.z, 12, 'stuck-move-probe')
    }
    this.syncPlayerEntityAttach()
    this.syncNameTag()
    this.avatar?.setYaw(this.playerYaw)
    let moveAxisX = 0
    let moveAxisZ = 0
    if (moving) {
      const yaw = this.playerYaw + AVATAR_YAW_OFFSET
      const cos = Math.cos(yaw)
      const sin = Math.sin(yaw)
      moveAxisX = _moveDir.x * cos + _moveDir.z * sin
      moveAxisZ = -_moveDir.x * sin + _moveDir.z * cos
    }

    // Include external channel so pad/bounce air poses match real vertical motion (not just jump buffer).
    const animVy = _velocity.y + _externalVelocity.y
    this.avatar?.update(delta, {
      horizontalSpeed: moving || horizontalSpeed > 0.2 ? horizontalSpeed : 0,
      targetLocomotionSpeed: moving ? moveSpeed : 0,
      grounded: this.grounded,
      nearGround: this.nearGround,
      verticalVelocity: animVy,
      locomotionMode: this.locomotionMode,
      // Space jump only — PE impulse / bounce pads use falling/air, not jump emote.
      jumping: this.jumping && !this.airJumped && !this.gliding,
      doubleJumping: this.airJumped && !this.grounded && !this.gliding,
      doubleJumpTriggered: this.doubleJumpTriggered,
      falling:
        !this.grounded &&
        !this.gliding &&
        !this.jumping &&
        !this.jumped &&
        !this.airJumped &&
        animVy < -1.5,
      gliding: this.gliding && !this.grounded,
      moveAxisX,
      moveAxisZ
    })
    this.syncCamera(false, delta)
    this.syncPointerLockAim()
    this.syncCameraModeAndPointerLockEcs()
    // Multi-scene COD: detect keys-held + free locomotion + zero feet delta.
    this.detectMovementStall(delta)
    this.input.endFrame()
  }

  /**
   * Wire PE impulse Lamport reader so eventId=0 scene writes (Genesis Plaza bounce parasols)
   * re-fire on each CRDT put, not only when eventId increments.
   */
  setImpulseLamportProvider(provider: (() => number) | null): void {
    this.getImpulseLamport = provider
  }

  /**
   * Clear external velocity channel.
   * @param consumeCurrentImpulse — when true (teleport / long respawn), mark the PE impulse
   *   currently on PlayerEntity as already applied. Resetting latches to 0 re-fires the last
   *   bounce pad (SpaceRunner death→spawn then `extY=59` sky launch).
   */
  private resetExternalPhysicsState(consumeCurrentImpulse = false): void {
    _externalVelocity.set(0, 0, 0)
    this.impulseLaunchGrace = 0
    if (consumeCurrentImpulse) {
      const ecs = this.readComponents
      if (ecs?.PhysicsCombinedImpulse.has(SDK_RESERVED.player)) {
        const imp = ecs.PhysicsCombinedImpulse.get(SDK_RESERVED.player)
        this.lastImpulseEventId = imp.eventId ?? 0
        this.lastImpulseLamport = this.getImpulseLamport?.() ?? 0
        return
      }
    }
    this.lastImpulseEventId = 0
    this.lastImpulseLamport = 0
  }

  /**
   * Continuous PE force → acceleration Y (Three), for effective gravity this frame.
   * XZ are integrated in applyScenePhysicsCombined.
   */
  private sampleSceneForceAccelY(gliding: boolean): number {
    const ecs = this.readComponents
    if (!ecs?.PhysicsCombinedForce.has(SDK_RESERVED.player)) return 0
    const force = ecs.PhysicsCombinedForce.get(SDK_RESERVED.player)
    const v = force.vector
    if (!v) return 0
    dclToThreeVec(_sceneForce.set(v.x ?? 0, v.y ?? 0, v.z ?? 0), _sceneForce)
    forceToAcceleration(_sceneForce, gliding, _forceAccel)
    return _forceAccel.y
  }

  /**
   * Scene-authored PhysicsCombinedForce + PhysicsCombinedImpulse (PlayerEntity CRDT).
   * Explorer: ExternalVelocity gets force XZ + impulse; force Y is effective-g only.
   *
   * Frame order (P2): gravity already applied → impulse (cancel fall) → force XZ
   * → jump (caller) → damp external → move. Matches Unity “impulse before final move”.
   */
  private applyScenePhysicsCombined(delta: number, gliding: boolean): void {
    const ecs = this.readComponents
    if (!ecs) return
    const pe = SDK_RESERVED.player

    // Scene freeze pin: never apply bounce impulses (stale pad or re-enter during map rebuild).
    const holdBlocked = this.disableAllHoldFeet != null

    // P2 stale impulse: if component gone, re-arm for next pad.
    if (!ecs.PhysicsCombinedImpulse.has(pe)) {
      this.lastImpulseEventId = 0
      this.lastImpulseLamport = 0
    } else if (holdBlocked) {
      // Keep latch in sync with live component so unfreeze doesn't treat it as a new put.
      const imp = ecs.PhysicsCombinedImpulse.get(pe)
      this.lastImpulseEventId = imp.eventId ?? 0
      this.lastImpulseLamport = this.getImpulseLamport?.() ?? this.lastImpulseLamport
      _externalVelocity.set(0, 0, 0)
    } else {
      const imp = ecs.PhysicsCombinedImpulse.get(pe)
      const eventId = imp.eventId ?? 0
      const v = imp.vector
      const lamport = this.getImpulseLamport?.() ?? 0
      // Plaza bounce_parasol writes { eventId: 0, vector: (0,25,0) } every enter — only LWW
      // Lamport advances. Without a Lamport provider, fall back to non-zero eventId edges.
      const isNewPut =
        lamport > 0
          ? lamport !== this.lastImpulseLamport
          : eventId !== 0 && eventId !== this.lastImpulseEventId
      if (isNewPut && v) {
        this.lastImpulseLamport = lamport
        this.lastImpulseEventId = eventId
        const mag = Math.hypot(v.x ?? 0, v.y ?? 0, v.z ?? 0)
        if (mag > 1e-6) {
          // World impulse before scale — check raw Y for unground / glide exit.
          dclToThreeVec(_sceneImpulse.set(v.x ?? 0, v.y ?? 0, v.z ?? 0), _sceneImpulse)
          const rawUp = _sceneImpulse.y
          applyImpulse(_externalVelocity, _sceneImpulse)
          if (rawUp > 0) {
            // Explorer: unground + zero falling gravity velocity so pads beat freefall.
            this.grounded = false
            this.groundCoyote = 0
            this.impulseLaunchGrace = IMPULSE_LAUNCH_GRACE_SEC
            if (_velocity.y < 0) _velocity.y = 0
            if (rawUp > 0.5) this.gliding = false
          }
          clientDebugLog.log(
            'player',
            `PE impulse applied eventId=${eventId} lamport=${lamport} ` +
              `raw=(${(v.x ?? 0).toFixed(1)},${(v.y ?? 0).toFixed(1)},${(v.z ?? 0).toFixed(1)}) ` +
              `extY=${_externalVelocity.y.toFixed(1)} grace=${IMPULSE_LAUNCH_GRACE_SEC}`,
            { level: 'info', alsoConsole: true, throttleMs: 200, throttleKey: 'pe-impulse' }
          )
        }
      }
    }

    // Single-scene PE (this client): only current worker PlayerEntity force slot.
    // Multi-scene World sum is N/A until multi-worker force writers exist (P2.10).
    if (ecs.PhysicsCombinedForce.has(pe)) {
      const force = ecs.PhysicsCombinedForce.get(pe)
      const v = force.vector
      if (v) {
        dclToThreeVec(_sceneForce.set(v.x ?? 0, v.y ?? 0, v.z ?? 0), _sceneForce)
        forceToAcceleration(_sceneForce, gliding, _forceAccel)
        integrateForceXZ(_externalVelocity, _forceAccel, delta)
        // Force Y already handled via sampleSceneForceAccelY → effective gravity.
        if (shouldUngroundFromForce(GRAVITY, _forceAccel.y)) {
          this.grounded = false
          this.groundCoyote = 0
        }
        if (Math.abs(v.y ?? 0) > 0.01 || Math.hypot(v.x ?? 0, v.z ?? 0) > 0.01) {
          clientDebugLog.log(
            'player',
            `PE force raw=(${(v.x ?? 0).toFixed(1)},${(v.y ?? 0).toFixed(1)},${(v.z ?? 0).toFixed(1)}) ` +
              `aY=${_forceAccel.y.toFixed(1)} lift=${shouldUngroundFromForce(GRAVITY, _forceAccel.y)}`,
            { level: 'info', alsoConsole: true, throttleMs: 800, throttleKey: 'pe-force' }
          )
        }
      }
    }
  }

  /**
   * Fixed on-screen aim while locked (above center) — reticle + raycasts share it.
   * Does not track the avatar in screen space (stays put as you look around).
   */
  private syncPointerLockAim(): void {
    if (!this.input?.pointer.locked) {
      clearPointerLockAim()
      return
    }

    const rect = this.host.renderer.domElement.getBoundingClientRect()
    if (rect.width < 1 || rect.height < 1) {
      clearPointerLockAim()
      return
    }

    setPointerLockAimFromCanvas(rect)
    this.input.syncReticleLayout()
  }

  private isFirstPerson(): boolean {
    if (this.forcedCameraMode === 'first_person') return true
    if (this.forcedCameraMode === 'third_person') return false
    return this.camDistance <= CAM_FPV_MAX_DISTANCE
  }

  /** Report freecam mode + pointer lock to scene (CameraEntity). */
  private syncCameraModeAndPointerLockEcs(): void {
    if (!this.readComponents) return
    const mode = this.isFirstPerson() ? CT_FIRST_PERSON : CT_THIRD_PERSON
    this.readComponents.CameraMode.createOrReplace(SDK_RESERVED.camera as never, { mode })
    this.readComponents.PointerLock.createOrReplace(SDK_RESERVED.camera as never, {
      isPointerLocked: this.input?.pointer.locked ?? false
    })
  }

  /**
   * Scene FocusOwner VirtualCamera owns the lens only when the bridge is **actively**
   * resolving a VC. MainCamera.virtualCameraEntity alone (hydrate lag) must NOT steal
   * freecam — that caused "camera reset mode" on multi-scene promote.
   */
  private isSceneVirtualCameraDriving(): boolean {
    return this.virtualCamera?.isActive() === true
  }

  /** True while MainCamera→VC is bound or the bridge is actively driving the lens. */
  isSceneVirtualCameraBoundOrDriving(): boolean {
    return this.isSceneVirtualCameraDriving() || this.virtualCamera?.isMainCameraVcBound() === true
  }

  private pollVirtualCameraEscape(): void {
    if (!this.virtualCameraEscapeHandler) return
    if (!this.isSceneVirtualCameraBoundOrDriving()) {
      this.virtualCameraEscapeKeyDown = false
      return
    }
    if (isTextInputFocused()) return
    const down = this.isEscapeKeyPhysicallyDown()
    if (down && !this.virtualCameraEscapeKeyDown) {
      const now = performance.now()
      if (now - this.lastVirtualCameraEscapeAt > 400) {
        this.lastVirtualCameraEscapeAt = now
        this.virtualCameraEscapeHandler()
      }
    }
    this.virtualCameraEscapeKeyDown = down
  }

  private isEscapeKeyPhysicallyDown(): boolean {
    return virtualCameraEscapeLatched
  }

  private releaseFreecamLookForVirtualCamera(): void {
    if (!this.input) return
    this.input.stopOrbitIfActive()
    if (this.input.pointer.locked) {
      document.exitPointerLock()
    }
  }

  /**
   * Player freecam orbit / zoom when scene VC is not actively driving.
   * InputModifier freezes avatar locomotion only — does not gate player look.
   * Freecam yaw/pitch/dist are durable player state (survive FocusOwner handoff).
   */
  private applyCameraInputFromPointer(): void {
    if (!this.input) return
    if (this.isSceneVirtualCameraDriving()) {
      this.releaseFreecamLookForVirtualCamera()
      return
    }

    if (this.input.looking) {
      const look = POINTER_LOOK_SPEED * clientSettings.getMouseSensitivityScale()
      this.camYaw -= this.input.pointer.dx * look
      this.camYaw = normalizeAngle(this.camYaw)
      const pitchDelta = this.input.pointer.dy * look
      // FPV mouse-up looks up; 3rd mouse-up raises boom (look down ring).
      // Distance still gates how far you can look into the sky (pitchMinForDistance).
      this.camPitch += this.isFirstPerson() ? -pitchDelta : pitchDelta
    }

    const zoomDelta = this.input.scrollDelta + this.input.pinchZoomDelta * 3
    if (zoomDelta !== 0 && this.forcedCameraMode === null) {
      this.camDistance += zoomDelta * ZOOM_WHEEL_SPEED
      this.camDistance = clamp(this.camDistance, CAM_DISTANCE_MIN, CAM_DISTANCE_MAX)
    } else if (this.forcedCameraMode === 'first_person') {
      this.camDistance = 0
    } else if (this.forcedCameraMode === 'third_person') {
      this.camDistance = clamp(
        Math.max(this.camDistance, CAM_FPV_MAX_DISTANCE + 0.15),
        CAM_FPV_MAX_DISTANCE + 0.15,
        CAM_DISTANCE_MAX
      )
    }

    // Re-clamp after look + zoom so zooming out while sky-gazing locks pitch up.
    this.camPitch = clamp(
      this.camPitch,
      pitchMinForDistance(this.camDistance),
      CAM_PITCH_MAX
    )
  }

  /**
   * After a cinematic VirtualCamera clears, invert last lens → freecam boom so the
   * handoff stays at the final flyover pose (near player) instead of snapping to
   * default distance / stale orbit.
   *
   * Freecam model: lens = pivot + boom(yaw, pitch, distance) [+ small shoulder].
   * We ignore shoulder on invert (small lateral error, stable yaw/pitch/distance).
   */
  private seedFreecamFromLastVcLens(): void {
    const cam = this.host.camera
    const h = camHeightsForDistance(this.camDistance)
    _pivot.copy(this.root.position)
    _pivot.y += h.pivotY
    _offset.copy(cam.position).sub(_pivot)
    const dist = _offset.length()

    // Prefer boom invert from lens position (matches Space Runner end keyframe).
    if (dist >= 0.55 && cam.position.y >= this.root.position.y + 0.45) {
      _offset.multiplyScalar(1 / dist)
      const seedDist = clamp(dist, CAM_FPV_MAX_DISTANCE + 0.2, CAM_DISTANCE_MAX)
      this.camDistance = seedDist
      this.camPitch = clamp(
        Math.asin(THREE.MathUtils.clamp(_offset.y, -1, 1)),
        pitchMinForDistance(seedDist),
        CAM_PITCH_MAX
      )
      this.camYaw = Math.atan2(_offset.x, _offset.z)
    } else {
      // Under-floor / on-pivot VC lens — do not seed freecam from it (poker sit under-table).
      _forward.set(0, 0, -1).applyQuaternion(cam.quaternion)
      if (_forward.lengthSq() > 1e-8 && cam.position.y >= this.root.position.y + 0.45) {
        _forward.normalize()
        this.camYaw = Math.atan2(-_forward.x, -_forward.z)
        if (dist >= 0.55) {
          this.camDistance = clamp(dist, CAM_FPV_MAX_DISTANCE + 0.2, CAM_DISTANCE_MAX)
        } else {
          this.camDistance = CAM_DISTANCE_DEFAULT
        }
        if (_forward.y <= 0.15) {
          const lookPitch = Math.asin(THREE.MathUtils.clamp(_forward.y, -1, 1))
          this.camPitch = clamp(-lookPitch, pitchMinForDistance(this.camDistance), CAM_PITCH_MAX)
        } else {
          this.camPitch = CAM_PITCH_DEFAULT
        }
      } else {
        // Keep prior freecam yaw when possible; force safe pitch/distance.
        this.camPitch = CAM_PITCH_DEFAULT
        this.camDistance = CAM_DISTANCE_DEFAULT
      }
    }

    // Forced camera mode areas still win after seed.
    if (this.forcedCameraMode === 'first_person') {
      this.camDistance = 0
    } else if (this.forcedCameraMode === 'third_person') {
      this.camDistance = clamp(
        Math.max(this.camDistance, CAM_FPV_MAX_DISTANCE + 0.15),
        CAM_FPV_MAX_DISTANCE + 0.15,
        CAM_DISTANCE_MAX
      )
    }

    clientDebugLog.log(
      'vc-lens',
      `freecam seed after VC — yaw=${((this.camYaw * 180) / Math.PI).toFixed(0)}° ` +
        `pitch=${((this.camPitch * 180) / Math.PI).toFixed(0)}° dist=${this.camDistance.toFixed(1)} ` +
        `lens=(${cam.position.x.toFixed(1)},${cam.position.y.toFixed(1)},${cam.position.z.toFixed(1)}) ` +
        `pivot=(${_pivot.x.toFixed(1)},${_pivot.y.toFixed(1)},${_pivot.z.toFixed(1)})`,
      { level: 'info', alsoConsole: true }
    )
  }

  /**
   * Place freecam boom on current feet **now** (hard snap). Keeps camYaw/pitch/distance
   * unless the resulting lens would sit under the avatar (then safe third-person defaults).
   */
  private placeFreecamBoomOnFeetHard(): void {
    // If a VirtualCamera still owns the lens, only arm snap for unbind — do not fight VC.
    if (this.isSceneVirtualCameraDriving() || this.virtualCamera?.isMainCameraVcBound()) {
      this.freecamSnapAfterVc = true
      return
    }
    this.wasVirtualCameraActive = false
    this.freecamSnapAfterVc = false

    if (this.forcedCameraMode === 'first_person' || this.camDistance <= CAM_FPV_MAX_DISTANCE) {
      _pivot.copy(this.root.position)
      _pivot.y += CAM_EYE_HEIGHT + 0.3
      _camEuler.set(this.camPitch, this.camYaw, 0)
      _camQuat.setFromEuler(_camEuler)
      this.host.camera.position.copy(_pivot)
      this.host.camera.quaternion.copy(_camQuat)
      return
    }

    let pitch = this.camPitch
    let dist = clamp(this.camDistance, CAM_FPV_MAX_DISTANCE + 0.2, CAM_DISTANCE_MAX)
    const pitchMin = pitchMinForDistance(dist)
    pitch = clamp(pitch, pitchMin, CAM_PITCH_MAX)
    const h = camHeightsForDistance(dist)
    _pivot.copy(this.root.position)
    _pivot.y += h.pivotY
    let cosPitch = Math.cos(pitch)
    let sinPitch = Math.sin(pitch)
    let camY = _pivot.y + sinPitch * dist
    // Refuse under-floor freecam after seat teleports — do not kill intentional close look-up.
    const floorY = this.root.position.y + 0.35
    if (camY < floorY && pitch > pitchMin + 0.02) {
      pitch = Math.max(pitchMin, CAM_PITCH_DEFAULT)
      dist = Math.max(dist, CAM_DISTANCE_DEFAULT)
      this.camPitch = pitch
      this.camDistance = dist
      cosPitch = Math.cos(pitch)
      sinPitch = Math.sin(pitch)
      camY = _pivot.y + sinPitch * dist
    }
    this.camPitch = pitch

    _offset.set(
      Math.sin(this.camYaw) * cosPitch * dist,
      sinPitch * dist,
      Math.cos(this.camYaw) * cosPitch * dist
    )
    if (pitch < 0.65 && dist > CAM_SHOULDER_CLOSE_DIST) {
      const shoulderScale =
        (1 - pitch / 0.65) *
        Math.min(1, (dist - CAM_SHOULDER_CLOSE_DIST) / (CAM_HEIGHT_FAR_DIST - CAM_SHOULDER_CLOSE_DIST))
      _shoulder.set(Math.cos(this.camYaw), 0, -Math.sin(this.camYaw))
      _offset.addScaledVector(_shoulder, CAM_SHOULDER_OFFSET * shoulderScale)
    }
    _camPos.copy(_pivot).add(_offset)
    _lookAt.copy(this.root.position)
    _lookAt.y += h.lookY
    this.host.camera.position.copy(_camPos)
    this.host.camera.lookAt(_lookAt)
    this.applyCameraNearForBoom(dist)
    this.host.camera.updateMatrixWorld(true)
  }

  /** Tighten near plane when over-shoulder so hair/face/hands are not near-clipped. */
  private applyCameraNearForBoom(dist: number): void {
    const near = this.isFirstPerson()
      ? 0.05
      : clientCameraNearForBoomDistance(dist)
    if (Math.abs(this.host.camera.near - near) > 1e-4) {
      this.host.camera.near = near
      this.host.camera.updateProjectionMatrix()
    }
  }

  private syncCamera(snap: boolean, delta = 0.016): void {
    // Testing hold: keep the authored Testing.setCameraTransform lens for a few frames.
    if (this.testingCameraHoldFrames > 0) {
      this.testingCameraHoldFrames--
      this.avatar?.setBodyVisible(!this.modifierHidden)
      if (this.nameTag) {
        this.nameTag.object.visible = !this.modifierHidden && areSceneNameTagsVisible()
      }
      return
    }
    // FocusOwner primary may drive lens via active VirtualCamera only.
    // Do **not** write freecam orbit from VC — orbit is continuous player state.
    if (this.virtualCamera?.apply(delta)) {
      this.wasVirtualCameraActive = true
      // Keep freecam yaw/pitch roughly aligned while VC drives (distance seeded on unbind).
      _forward.set(0, 0, -1).applyQuaternion(this.host.camera.quaternion)
      if (_forward.lengthSq() > 1e-8) {
        _forward.normalize()
        this.camYaw = Math.atan2(-_forward.x, -_forward.z)
        // freecam camPitch is boom elevation (positive = above); look-down has negative forward.y.
        // Never seed a looking-up VC into negative boom (under-floor freecam on unbind).
        if (_forward.y <= 0.15) {
          const lookPitch = Math.asin(THREE.MathUtils.clamp(_forward.y, -1, 1))
          this.camPitch = clamp(
            -lookPitch,
            pitchMinForDistance(this.camDistance),
            CAM_PITCH_MAX
          )
        } else {
          this.camPitch = CAM_PITCH_DEFAULT
        }
      }
      this.avatar?.setBodyVisible(!this.modifierHidden)
      if (this.nameTag) {
        this.nameTag.object.visible = !this.modifierHidden && areSceneNameTagsVisible()
      }
      return
    }
    // MainCamera still points at a VC but bridge inactive (missing Transform this frame) —
    // hold last lens pose; do not let freecam/orbit steal the shot.
    if (this.virtualCamera?.isMainCameraVcBound()) {
      this.wasVirtualCameraActive = true
      this.avatar?.setBodyVisible(!this.modifierHidden)
      if (this.nameTag) {
        this.nameTag.object.visible = !this.modifierHidden && areSceneNameTagsVisible()
      }
      return
    }

    // VC just released — freecam resumes with existing yaw/pitch/dist (no reseed from VC pose).
    const vcJustReleased = this.wasVirtualCameraActive
    if (this.wasVirtualCameraActive) {
      this.wasVirtualCameraActive = false
      this.seedFreecamFromLastVcLens()
      this.freecamSnapAfterVc = true
    }

    // Snap once after VC release or explicit handoff so boom re-seats on feet without lerp ghost.
    const hardSnap = snap || this.freecamSnapAfterVc || vcJustReleased
    if (this.freecamSnapAfterVc) this.freecamSnapAfterVc = false

    const fpv = this.isFirstPerson()
    this.avatar?.setBodyVisible(!this.modifierHidden && !fpv)
    if (this.nameTag) {
      this.nameTag.object.visible = !this.modifierHidden && areSceneNameTagsVisible() && !fpv
    }

    if (fpv) {
      _pivot.copy(this.root.position)
      _pivot.y += CAM_EYE_HEIGHT + 0.3
      _camEuler.set(this.camPitch, this.camYaw, 0)
      _camQuat.setFromEuler(_camEuler)
      const alpha = hardSnap ? 1 : 1 - Math.exp(-14 * delta)
      this.host.camera.position.lerp(_pivot, alpha)
      this.host.camera.quaternion.slerp(_camQuat, alpha)
      this.applyCameraNearForBoom(0)
      return
    }

    const h = camHeightsForDistance(this.camDistance)
    _pivot.copy(this.root.position)
    _pivot.y += h.pivotY

    _lookAt.copy(this.root.position)
    _lookAt.y += h.lookY

    const cosPitch = Math.cos(this.camPitch)
    const sinPitch = Math.sin(this.camPitch)
    _offset.set(
      Math.sin(this.camYaw) * cosPitch * this.camDistance,
      sinPitch * this.camDistance,
      Math.cos(this.camYaw) * cosPitch * this.camDistance
    )

    if (this.camPitch < 0.65 && this.camDistance > CAM_SHOULDER_CLOSE_DIST) {
      const shoulderScale =
        (1 - this.camPitch / 0.65) *
        Math.min(
          1,
          (this.camDistance - CAM_SHOULDER_CLOSE_DIST) /
            (CAM_HEIGHT_FAR_DIST - CAM_SHOULDER_CLOSE_DIST)
        )
      _shoulder.set(Math.cos(this.camYaw), 0, -Math.sin(this.camYaw))
      _offset.addScaledVector(_shoulder, CAM_SHOULDER_OFFSET * shoulderScale)
    }

    _camDir.copy(_offset).normalize()
    const maxDist = _offset.length()
    // First freecam frame after VC: keep cinematic lens — wall occlusion would pull in and pop.
    const safeDist = hardSnap ? maxDist : this.resolveCameraDistance(_pivot, _camDir, maxDist)
    _offset.setLength(safeDist)

    _camPos.copy(_pivot).add(_offset)
    const alpha = hardSnap ? 1 : 1 - Math.exp(-14 * delta)

    this.host.camera.position.lerp(_camPos, alpha)
    this.host.camera.lookAt(_lookAt)
    this.applyCameraNearForBoom(this.camDistance)
  }

  private resolveCameraDistance(pivot: THREE.Vector3, direction: THREE.Vector3, maxDistance: number): number {
    // Default on — `?nocamerasweep` or Help panel to disable.
    if (!cameraCollisionDebug.isWallOcclusionEnabled()) return maxDistance
    const hitDist = this.physics.sweepRay(pivot, direction, maxDistance)
    if (hitDist === null) return maxDistance
    const occlusionThreshold = maxDistance * 0.82
    if (hitDist >= occlusionThreshold) return maxDistance
    return Math.max(0.8, hitDist - 0.25)
  }

  private syncNameTag(): void {
    if (!this.playerIdentity) return
    if (!areSceneNameTagsVisible()) {
      this.dropNameTag()
      return
    }
    if (!this.nameTag) {
      if (!this.avatar) return
      this.nameTag = NameTag.attach(this.avatar.nameTagAnchor, this.playerIdentity.displayName, {
        textColor: this.playerIdentity.nameColor,
        claimed: this.playerIdentity.hasClaimedName
      })
    }

    const { AvatarShape } = this.readComponents ?? {}
    const mirrorName =
      AvatarShape?.has(SDK_RESERVED.player)
        ? mirrorAvatarNameOverride(AvatarShape.get(SDK_RESERVED.player).name)
        : undefined

    const identity = mirrorName
      ? { ...this.playerIdentity, displayName: mirrorName }
      : this.playerIdentity

    this.nameTag.setText(identity.displayName)
    this.nameTag.setStyle({
      textColor: identity.nameColor,
      claimed: identity.hasClaimedName
    })
  }

  /**
   * @param settle — try a one-shot CCT settle onto floor near authored Y (drown-respawn /
   *   ground snaps). Mid-duration movePlayerTo lerps pass false; seat snaps pass false
   *   (trust authored). Timed-walk arrival passes true.
   * @param longRespawn — long elevated jump (map↔lobby / map restart). Stay at authored
   *   feet and freefall under gravity once scene freeze clears — do not CCT-settle onto a
   *   temporary freeze-pad MeshCollider and do not soft-hold mid-air.
   */
  private teleportTo(positionThree: THREE.Vector3, settle = true, longRespawn = false): void {
    if (this.walkBounds) {
      const dclPos = threeToDclVec(positionThree)
      clampToWalkBounds(dclPos, this.walkBounds)
      positionThree.copy(dclToThreeVec(dclPos))
    }
    this.physics.teleport(positionThree)
    _velocity.set(0, 0, 0)
    // Zero external Δv and mark any PE impulse already on the player as consumed.
    // Re-arming to 0 re-applies the last bounce (death→spawn + extY≈59 sky launch).
    this.resetExternalPhysicsState(true)
    this.jumped = false
    this.jumping = false
    this.airJumped = false
    this.airJumpPending = false
    this.gliding = false

    const elevatedLong = longRespawn && positionThree.y > 8
    if (settle && !elevatedLong) {
      // Ground-level / short snaps: optional one-shot CCT settle. Miss → freefall from target.
      this.physics.warmStaticScene()
      const settled = this.physics.settleSpawnOntoFloor(positionThree.y)
      this.grounded = settled
      this.groundCoyote = settled ? 0.12 : 0
      if (!settled) {
        this.physics.teleport(positionThree)
      }
      // Round-reset teleports must not leave a prior timed-walk lock armed.
      this.scenePositionLock = false
      this.moveTask = null
      const locomotion = this.getLocomotionConfig()
      const locOk = canLocomote(locomotion)
      const out = this.physics.positionOut
      const outDcl = threeToDclVec(out)
      clientDebugLog.consoleOnly(
        'info',
        `[player] teleport settle — three=(${out.x.toFixed(1)},${out.y.toFixed(2)},${out.z.toFixed(1)}) ` +
          `dcl=(${outDcl.x.toFixed(1)},${outDcl.y.toFixed(2)},${outDcl.z.toFixed(1)}) ` +
          `targetY=${positionThree.y.toFixed(2)} grounded=${settled} drop=${!settled} ` +
          `lock=cleared locomotion=${locOk ? 'allowed' : 'blocked'} ` +
          `all=${locomotion.disableAll} walk=${locomotion.disableWalk} ` +
          `jog=${locomotion.disableJog} run=${locomotion.disableRun}`
      )
    } else if (settle && elevatedLong) {
      // Elevated long (SpaceRunner map↔lobby): authored pose only. Scene disableAll pins
      // during load; on unfreeze gravity drops onto cooked colliders. Never soft-hold.
      this.grounded = false
      this.groundCoyote = 0
      this.scenePositionLock = false
      this.moveTask = null
      const locomotion = this.getLocomotionConfig()
      const locOk = canLocomote(locomotion)
      const out = this.physics.positionOut
      const outDcl = threeToDclVec(out)
      // Diagnose "spawn not high enough" vs "no lobby floor": probe under authored feet.
      this.physics.warmStaticScene()
      const probeUnder = this.physics.probeWalkSurfaceFeetY(
        out.x,
        out.z,
        positionThree.y + 1.2,
        16,
        positionThree.y
      )
      clientDebugLog.consoleOnly(
        'info',
        `[player] teleport elevated drop — three=(${out.x.toFixed(1)},${out.y.toFixed(2)},${out.z.toFixed(1)}) ` +
          `dcl=(${outDcl.x.toFixed(1)},${outDcl.y.toFixed(2)},${outDcl.z.toFixed(1)}) ` +
          `targetY=${positionThree.y.toFixed(2)} grounded=false ` +
          `floorProbe=${probeUnder != null ? probeUnder.toFixed(2) : 'none'} ` +
          `locomotion=${locOk ? 'allowed' : 'blocked'} ` +
          `all=${locomotion.disableAll} walk=${locomotion.disableWalk} ` +
          `jog=${locomotion.disableJog} run=${locomotion.disableRun}`
      )
      if (probeUnder == null) {
        // No walk surface under lobby/map spawn — colliders missing/late, not a feet-offset bug.
        this.physics.logStaticCollidersNear(out.x, positionThree.y, out.z, 18, 'elevated-drop')
      }
    } else {
      // Authored seat / mid-lerp — treat as grounded so sit emote doesn't freefall off the bench.
      this.grounded = true
      this.groundCoyote = 0.12
    }

    this.root.position.copy(this.physics.positionOut)
    this.syncPlayerEntityAttach()
  }

  /** Avatar body yaw (Three.js space) + wire yaw for CRDT / RFC4 — not camera orbit. */
  private setAvatarFacing(yaw: number): void {
    this.playerYaw = normalizeAngle(yaw)
    this.networkYaw = this.playerYaw
  }

  /** Keep CRDT PlayerEntity rotation aligned with visible avatar facing. */
  private syncWireYawFromAvatar(): void {
    this.networkYaw = normalizeAngle(this.playerYaw)
  }

  private applyAvatarLookTarget(
    from: THREE.Vector3,
    targetDcl: { x?: number; y?: number; z?: number }
  ): void {
    const { dx, dz } = this.lookTargetDelta(from, targetDcl)
    if (Math.hypot(dx, dz) < 1e-4) return
    this.setAvatarFacing(Math.atan2(-dx, -dz))
  }

  private applyCameraLookTarget(
    from: THREE.Vector3,
    targetDcl: { x?: number; y?: number; z?: number }
  ): void {
    const fromDcl = threeToDclVec(from)
    const { dx, dz } = this.lookTargetDelta(from, targetDcl)
    if (Math.hypot(dx, dz) < 1e-4) return
    this.camYaw = Math.atan2(-dx, -dz)
    const dy = (targetDcl.y ?? fromDcl.y + CAM_EYE_HEIGHT) - (fromDcl.y + CAM_EYE_HEIGHT)
    const dist = Math.hypot(dx, dz)
    this.camPitch = clamp(Math.atan2(dy, dist), -CAM_PITCH_MAX + 0.05, CAM_PITCH_MAX)
  }

  private lookTargetDelta(
    from: THREE.Vector3,
    targetDcl: { x?: number; y?: number; z?: number }
  ): { dx: number; dz: number } {
    const fromDcl = threeToDclVec(from)
    const targetThree = dclToThreeVec(
      new THREE.Vector3(
        targetDcl.x ?? fromDcl.x,
        targetDcl.y ?? fromDcl.y,
        targetDcl.z ?? fromDcl.z
      )
    )
    return { dx: targetThree.x - from.x, dz: targetThree.z - from.z }
  }
}
