import * as THREE from 'three'
import { avatarOptionsFromUrl, LocalAvatar, mirrorAvatarNameOverride, type PlayEmoteOptions } from '../avatar/LocalAvatar'
import type { ProfileIdentity } from '../avatar/displayName'
import type { MirrorComponents } from '../bridge/mirrorComponents'
import { SDK_RESERVED } from '../bridge/reservedEntities'
import { ReservedEntitiesSync, type EntityPose } from '../bridge/ReservedEntitiesSync'
import { NameTag } from '../client/ui/NameTag'
import type { PhysXWorld } from '../physics/PhysXWorld'
import type { SceneHost } from '../rendering/SceneHost'
import {
  jumpHeightForMode,
  readLocomotionFromComponents,
  resolveLocomotionMode,
  speedForMode,
  type LocomotionMode
} from './locomotion'
import type { SceneSpawn } from '../dcl/content/types'
import type { MovePlayerToRequest } from './movePlayerTo'
import {
  dclPlayerEntityPositionsEqual,
  feetDclToPlayerEntityPosition,
  feetThreeFromPlayerEntityDcl,
  playerEntityPositionFromThreeFeet,
  playerEntityPositionToFeetDcl,
  resolveMovePlayerToTargetPlayerEntity
} from './dclPlayerEntity'
import { clampToWalkBounds, type PlayerWalkBounds } from './SceneBounds'
import { normalizeAngle } from '../network/comms/movementCompressed'
import {
  dclToThreeVec,
  threeToDclQuat,
  threeToDclVec,
  threeYawToDclYaw
} from '../bridge/dclTransform'
import { PlayerInput } from './PlayerInput'
import type { AssetCache } from '../rendering/AssetCache'
import type { ResolvedProfileEmote } from '../avatar/profileEmotes'
import { AVATAR_YAW_OFFSET } from '../avatar/constants'

const UP = new THREE.Vector3(0, 1, 0)
const _forward = new THREE.Vector3()
const _right = new THREE.Vector3()
const _moveDir = new THREE.Vector3()
const _velocity = new THREE.Vector3()
const _displacement = new THREE.Vector3()
const _force = new THREE.Vector3()
const _pivot = new THREE.Vector3()
const _lookAt = new THREE.Vector3()
const _offset = new THREE.Vector3()
const _shoulder = new THREE.Vector3()
const _camDir = new THREE.Vector3()
const _camQuat = new THREE.Quaternion()
const _camEuler = new THREE.Euler(0, 0, 0, 'YXZ')

const _camPos = new THREE.Vector3()

const POINTER_LOOK_SPEED = 0.003
const CAM_PIVOT_HEIGHT = 1.45
const CAM_EYE_HEIGHT = 1.82
const CAM_LOOK_HEIGHT = 1.15
const CAM_DISTANCE_DEFAULT = 4.5
const CAM_DISTANCE_MIN = 0
const CAM_FPV_MAX_DISTANCE = 0.35
const CAM_DISTANCE_MAX = 16
const CAM_SHOULDER_OFFSET = 0.3
const CAM_PITCH_DEFAULT = 0.35
const CAM_PITCH_MIN = 0
const CAM_PITCH_MAX = Math.PI / 2 - 0.02
const ZOOM_WHEEL_SPEED = 0.004
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
/** Scene has no spawnPoints / default y=0 — start slightly above and let CCT fall. */
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
  private jumpCount = 0
  private locomotionMode: LocomotionMode = 'jog'
  private readComponents: MirrorComponents | null = null
  private groundNormal = new THREE.Vector3(0, 1, 0)
  private readonly root = new THREE.Object3D()
  private avatar: LocalAvatar | null = null
  private nameTag: NameTag | null = null
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
  /** Holds capsule after scene `movePlayerTo` until emote starts or the player moves. */
  private scenePositionLock = false
  private wasProfileEmoteActive = false

  constructor(
    private readonly host: SceneHost,
    private readonly physics: PhysXWorld
  ) {
    this.root.name = 'player'
    this.avatar = new LocalAvatar(this.root)
    this.host.scene.add(this.root)
  }

  async initCapsule(
    spawn: SceneSpawn,
    walkBounds: PlayerWalkBounds,
    readComponents: MirrorComponents,
    onProgress?: (msg: string) => void
  ): Promise<void> {
    this.readComponents = readComponents
    this.walkBounds = walkBounds
    this.input = new PlayerInput(this.host.renderer.domElement)
    const feetY = spawn.y <= 0.01 ? DEFAULT_SPAWN_FEET_Y : spawn.y
    const spawnThree = dclToThreeVec(new THREE.Vector3(spawn.x, feetY, spawn.z))
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
    this.syncCamera(true)
    onProgress?.('Player ready')
  }

  getLocalAvatar(): LocalAvatar | null {
    return this.avatar
  }

  async loadAvatar(onProgress?: (msg: string) => void): Promise<void> {
    onProgress?.('Loading avatar…')
    const avatarOptions = avatarOptionsFromUrl()
    try {
      this.playerIdentity = (await this.avatar?.load(avatarOptions)) ?? null
    } catch (err) {
      console.warn('Avatar load failed — continuing with invisible capsule', err)
    }

    if (this.avatar && this.playerIdentity) {
      this.nameTag = NameTag.attach(this.avatar.nameTagAnchor, this.playerIdentity.displayName, {
        textColor: this.playerIdentity.nameColor,
        claimed: this.playerIdentity.hasClaimedName
      })
    }

    this.syncNameTag()
    this.syncCamera(true)
  }

  /** Reload avatar after backpack VRM equip / unequip. */
  async reloadAvatar(onProgress?: (msg: string) => void): Promise<void> {
    this.nameTag?.dispose()
    this.nameTag = null
    await this.loadAvatar(onProgress)
  }

  setAssetCache(cache: AssetCache, peerUrl?: string): void {
    this.avatar?.setAssetCache(cache, peerUrl)
  }

  setLocomotionVfxScene(scene: THREE.Scene): void {
    this.avatar?.setLocomotionVfxScene(scene)
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
    this.input?.dispose()
    this.input = null
    this.nameTag?.dispose()
    this.nameTag = null
    this.avatar?.dispose()
    this.avatar = null
    this.enabled = false
    this.host.setOrbitEnabled(true)
  }

  /** Snap third-person camera before the first render after load. */
  snapCamera(): void {
    if (!this.enabled) return
    this.syncCamera(true)
  }

  /** SDK7 `Transform.get(PlayerEntity).position` — chest height in scene-relative DCL meters. */
  getPlayerEntityPositionDcl(): THREE.Vector3 {
    return playerEntityPositionFromThreeFeet(this.root.position)
  }

  /** PlayerEntity pose for CRDT / scene reads — rotation uses immediate wire yaw, not smoothed body turn. */
  getEntityPose(): EntityPose {
    return {
      position: this.getPlayerEntityPositionDcl(),
      rotation: threeToDclQuat(ReservedEntitiesSync.playerRotationFromYaw(this.getNetworkYaw()))
    }
  }

  /** Capsule root — spatial audio parented to PlayerEntity attaches here. */
  getPlayerRoot(): THREE.Object3D {
    return this.root
  }

  /** Scene-local DCL meters (+X east, +Z north). */
  /** Apply PhysX foot position to the avatar root (after prewarm / teleport snap). */
  syncFromPhysics(): void {
    this.root.position.copy(this.physics.positionOut)
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
    return this.input?.orbiting ?? false
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
  showNameTagChat(text: string): void {
    this.nameTag?.showChat(text)
  }

  getPlayerYaw(): number {
    return this.playerYaw
  }

  /** Immediate movement/camera facing for RFC4 — DCL scene yaw, not locally smoothed. */
  getNetworkYaw(): number {
    return normalizeAngle(threeYawToDclYaw(this.networkYaw))
  }

  /** RFC4 Movement jump / grounded flags for remote locomotion parity. */
  getLocomotionWireState(): {
    isGrounded: boolean
    isJumping: boolean
    jumpCount: number
    isFalling: boolean
  } {
    return {
      isGrounded: this.grounded,
      isJumping: this.jumping || this.jumped || this.airJumpPending,
      jumpCount: this.jumpCount,
      isFalling: !this.grounded && !this.jumping && !this.jumped && !this.airJumped && _velocity.y < -1.5
    }
  }

  /** DCL `RestrictedActions.movePlayerTo` — position relative to scene origin. */
  movePlayerTo(request: MovePlayerToRequest): boolean {
    if (!this.enabled || !this.walkBounds) return false

    const pos = request.newRelativePosition
    if (!pos) return false

    const currentPlayerEntityDcl = this.getPlayerEntityPositionDcl()
    const targetPlayerEntityDcl = resolveMovePlayerToTargetPlayerEntity(
      new THREE.Vector3(
        pos.x ?? currentPlayerEntityDcl.x,
        pos.y ?? currentPlayerEntityDcl.y,
        pos.z ?? currentPlayerEntityDcl.z
      ),
      currentPlayerEntityDcl,
      request.avatarTarget
    )
    const targetFeetDcl = playerEntityPositionToFeetDcl(targetPlayerEntityDcl)
    clampToWalkBounds(targetFeetDcl, this.walkBounds)
    targetPlayerEntityDcl.copy(feetDclToPlayerEntityPosition(targetFeetDcl))
    const target = feetThreeFromPlayerEntityDcl(targetPlayerEntityDcl)
    const reposition = !dclPlayerEntityPositionsEqual(targetPlayerEntityDcl, currentPlayerEntityDcl)

    const avatarTarget = request.avatarTarget
    const from = this.root.position.clone()
    /** Face target from current feet — scene passes PlayerEntity.position + avatarTarget for look-only. */
    if (avatarTarget) {
      this.applyAvatarLookTarget(from, avatarTarget)
    }
    if (request.cameraTarget) {
      this.applyCameraLookTarget(from, request.cameraTarget)
    }
    if (this.isFirstPerson()) {
      if (request.avatarTarget) {
        this.camYaw = this.playerYaw
      } else if (request.cameraTarget) {
        this.playerYaw = this.camYaw
      }
    }

    const duration = request.duration ?? 0
    if (!reposition || duration <= 0) {
      if (reposition) {
        this.teleportTo(target)
      }
      this.moveTask = null
      this.scenePositionLock = true
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
    this.scenePositionLock = true
    return true
  }

  getCameraEntityPose(): EntityPose {
    return ReservedEntitiesSync.cameraPose(this.host.camera)
  }

  update(delta: number): void {
    if (!this.enabled || !this.input) return
    delta = Math.min(delta, 1 / 20)

    const emoteActive = this.avatar?.isProfileEmoteActive() ?? false
    if (this.wasProfileEmoteActive && !emoteActive) {
      this.scenePositionLock = false
    }
    this.wasProfileEmoteActive = emoteActive

    const movingKeys =
      this.input.keys.w || this.input.keys.a || this.input.keys.s || this.input.keys.d
    const breakSceneHold = movingKeys || this.input.spacePressed
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
        this.teleportTo(_pivot)
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
          this.moveTask = null
          this.scenePositionLock = true
        }
        return
      }
    }

    if (this.scenePositionLock && !breakSceneHold) {
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

    this.applyCameraInputFromPointer()

    _moveDir.set(0, 0, 0)
    _forward.set(Math.sin(this.camYaw), 0, Math.cos(this.camYaw)).multiplyScalar(-1)
    _right.set(Math.cos(this.camYaw), 0, -Math.sin(this.camYaw))
    if (this.input.keys.w) _moveDir.add(_forward)
    if (this.input.keys.s) _moveDir.sub(_forward)
    if (this.input.keys.a) _moveDir.sub(_right)
    if (this.input.keys.d) _moveDir.add(_right)
    const moving = _moveDir.lengthSq() > 0
    if (moving) _moveDir.normalize()

    if (moving || this.input.spacePressed) {
      this.scenePositionLock = false
      this.avatar?.stopEmote()
    }

    this.groundNormal.copy(UP)

    const onGround = this.grounded || this.groundCoyote > 0

    if (onGround) {
      this.airJumped = false
      this.airJumpPending = false
      this.airJumpDelayLeft = 0
      this.jumpCount = 0
    }

    this.doubleJumpTriggered = false

    if (this.jumped && !this.grounded) {
      this.jumped = false
      this.jumping = true
    }
    if (this.jumping && this.grounded) {
      this.jumping = false
    }

    const locomotion = readLocomotionFromComponents(this.readComponents!, SDK_RESERVED.player)
    this.locomotionMode = resolveLocomotionMode(this.input.keys, locomotion)
    const moveSpeed = speedForMode(this.locomotionMode, locomotion)

    if (!this.grounded && !this.airJumpPending) {
      _velocity.y -= GRAVITY * delta
    }

    if (this.jumping && !this.grounded && _velocity.y <= 0) {
      this.jumping = false
    }

    const accel = this.grounded ? GROUND_ACCEL : AIR_ACCEL
    const steerAlpha = 1 - Math.exp(-accel * delta)

    if (moving) {
      _force.copy(_moveDir).multiplyScalar(moveSpeed)
      _force.y = 0
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

    if (
      onGround &&
      !this.jumping &&
      this.input.spacePressed &&
      !locomotion.disableJump &&
      locomotion.jumpHeight > 0
    ) {
      _velocity.y = Math.sqrt(2 * GRAVITY * jumpHeightForMode(this.locomotionMode, locomotion))
      this.jumped = true
      this.jumpCount = 1
    } else if (
      !this.grounded &&
      !this.airJumped &&
      !this.airJumpPending &&
      this.input.spacePressed &&
      !locomotion.disableDoubleJump &&
      locomotion.doubleJumpHeight > 0
    ) {
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
      }
    }

    _displacement.copy(_velocity).multiplyScalar(delta)
    // Horizontal-only when actually grounded — coyote must keep vertical displacement so gravity
    // can pull the capsule onto stair treads (stripping Y during coyote caused lip stalls).
    if (
      this.grounded &&
      !this.jumping &&
      !this.jumped &&
      !this.airJumpPending &&
      _velocity.y <= 0
    ) {
      _displacement.y = 0
    }

    if (!this.jumping && !this.jumped && !this.airJumpPending && (this.grounded || this.nearGround)) {
      // CCT is kinematic — standing surface moved Δ this frame, so capsule += Δ before move().
      this.physics.applyPlatformVelocityTransfer()
    } else if (!this.grounded && !this.nearGround) {
      this.physics.clearStandingPlatform()
    }

    const moveResult = this.physics.movePlayer(_displacement, delta)
    this.grounded = moveResult.grounded
    if (this.grounded) {
      this.groundCoyote = GROUND_COYOTE_SECONDS
      if (!this.jumping) _velocity.y = 0
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
      if (clampToWalkBounds(dclPos, this.walkBounds)) {
        this.physics.teleport(dclToThreeVec(dclPos))
        this.root.position.copy(this.physics.positionOut)
        _velocity.x = 0
        _velocity.z = 0
      }
    }
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

    this.avatar?.update(delta, {
      horizontalSpeed: moving || horizontalSpeed > 0.2 ? horizontalSpeed : 0,
      targetLocomotionSpeed: moving ? moveSpeed : 0,
      grounded: this.grounded,
      nearGround: this.nearGround,
      verticalVelocity: _velocity.y,
      locomotionMode: this.locomotionMode,
      jumping: this.jumping && !this.airJumped,
      doubleJumping: this.airJumped && !this.grounded,
      doubleJumpTriggered: this.doubleJumpTriggered,
      falling: !this.grounded && !this.jumping && !this.jumped && !this.airJumped && _velocity.y < -1.5,
      moveAxisX,
      moveAxisZ
    })
    this.syncCamera(false, delta)
    this.input.endFrame()
  }

  private isFirstPerson(): boolean {
    return this.camDistance <= CAM_FPV_MAX_DISTANCE
  }

  /** Orbit + zoom from pointer lock / drag — runs even when movement is scene-locked. */
  private applyCameraInputFromPointer(): void {
    if (!this.input) return

    if (this.input.looking) {
      this.camYaw -= this.input.pointer.dx * POINTER_LOOK_SPEED
      this.camYaw = normalizeAngle(this.camYaw)
      const pitchDelta = this.input.pointer.dy * POINTER_LOOK_SPEED
      this.camPitch += this.isFirstPerson() ? -pitchDelta : pitchDelta
      const pitchMin = this.isFirstPerson() ? -CAM_PITCH_MAX + 0.05 : CAM_PITCH_MIN
      this.camPitch = clamp(this.camPitch, pitchMin, CAM_PITCH_MAX)
    }

    const zoomDelta = this.input.scrollDelta + this.input.pinchZoomDelta * 3
    if (zoomDelta !== 0) {
      this.camDistance += zoomDelta * ZOOM_WHEEL_SPEED
      this.camDistance = clamp(this.camDistance, CAM_DISTANCE_MIN, CAM_DISTANCE_MAX)
    }
  }

  private syncCamera(snap: boolean, delta = 0.016): void {
    const fpv = this.isFirstPerson()
    this.avatar?.setBodyVisible(!fpv)
    if (this.nameTag) this.nameTag.object.visible = !fpv

    if (fpv) {
      _pivot.copy(this.root.position)
      _pivot.y += CAM_EYE_HEIGHT + 0.3
      _camEuler.set(this.camPitch, this.camYaw, 0)
      _camQuat.setFromEuler(_camEuler)
      const alpha = snap ? 1 : 1 - Math.exp(-14 * delta)
      this.host.camera.position.lerp(_pivot, alpha)
      this.host.camera.quaternion.slerp(_camQuat, alpha)
      return
    }

    _pivot.copy(this.root.position)
    _pivot.y += CAM_PIVOT_HEIGHT

    _lookAt.copy(this.root.position)
    _lookAt.y += CAM_LOOK_HEIGHT

    const cosPitch = Math.cos(this.camPitch)
    const sinPitch = Math.sin(this.camPitch)
    _offset.set(
      Math.sin(this.camYaw) * cosPitch * this.camDistance,
      sinPitch * this.camDistance,
      Math.cos(this.camYaw) * cosPitch * this.camDistance
    )

    if (this.camPitch < 0.65) {
      _shoulder.set(Math.cos(this.camYaw), 0, -Math.sin(this.camYaw))
      _offset.addScaledVector(_shoulder, CAM_SHOULDER_OFFSET * (1 - this.camPitch / 0.65))
    }

    _camDir.copy(_offset).normalize()
    const maxDist = _offset.length()
    const safeDist = this.resolveCameraDistance(_pivot, _camDir, maxDist)
    _offset.setLength(safeDist)

    _camPos.copy(_pivot).add(_offset)
    const alpha = snap ? 1 : 1 - Math.exp(-14 * delta)

    this.host.camera.position.lerp(_camPos, alpha)
    this.host.camera.lookAt(_lookAt)
  }

  private resolveCameraDistance(pivot: THREE.Vector3, direction: THREE.Vector3, maxDistance: number): number {
    const hitDist = this.physics.sweepRay(pivot, direction, maxDistance)
    if (hitDist === null) return maxDistance
    const occlusionThreshold = maxDistance * 0.82
    if (hitDist >= occlusionThreshold) return maxDistance
    return Math.max(0.8, hitDist - 0.25)
  }

  private syncNameTag(): void {
    if (!this.nameTag || !this.playerIdentity) return

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

  private teleportTo(positionThree: THREE.Vector3): void {
    if (this.walkBounds) {
      const dclPos = threeToDclVec(positionThree)
      clampToWalkBounds(dclPos, this.walkBounds)
      positionThree.copy(dclToThreeVec(dclPos))
    }
    this.physics.teleport(positionThree)
    _velocity.set(0, 0, 0)
    this.root.position.copy(this.physics.positionOut)
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
