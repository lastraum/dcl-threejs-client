import * as THREE from 'three'
import type { Entity } from '@dcl/ecs'
import type { PBVirtualCamera } from '@dcl/ecs/dist/components/generated/pb/decentraland/sdk/components/virtual_camera.gen'
import { dclToThreePos, entityDisplayQuatToThreeCameraQuat } from '../dclTransform'
import { clientDebugLog } from '../../client/debug/ClientDebugLog'
import type { MirrorComponents } from '../mirrorComponents'
import type { ProjectionView } from '../ProjectionView'
import {
  resolveTjsShaderPath,
  tjsValueFingerprint,
  type TjsValue
} from '../../dcl/ecs/tjsComponent'
import { buildShaderCtx, getShaderManager } from '../../vfx/ShaderManager'
import { resolveEntityWorldPose, type EntityWorldTransformDeps } from '../../transform/entityWorldTransform'

const _origin = new THREE.Vector3()
const _dir = new THREE.Vector3()
const _lookAt = new THREE.Vector3()
const _lookDir = new THREE.Vector3()
const _lookRight = new THREE.Vector3()
const _lookUp = new THREE.Vector3()
const _camZ = new THREE.Vector3()
const _worldUp = new THREE.Vector3(0, 1, 0)
const _lookMat = new THREE.Matrix4()
const _targetPos = new THREE.Vector3()
const _targetQuat = new THREE.Quaternion()
const _entityDisplayQuat = new THREE.Quaternion()

const TJS_CAMERA_RT_SIZE = 512
const TJS_CAMERA_FOV = 60
const TJS_CAMERA_FAR = 256

type TjsCameraRuntime = {
  entity: Entity
  rt: THREE.WebGLRenderTarget
  cam: THREE.PerspectiveCamera
}

type TjsProjectionRuntime = {
  entity: Entity
  cameraEntity: Entity
  boundMeshes: THREE.Mesh[]
  savedMaps: WeakMap<THREE.Material, THREE.Texture | null>
}

function collectMeshes(root: THREE.Object3D): THREE.Mesh[] {
  const out: THREE.Mesh[] = []
  root.traverse((obj) => {
    if ((obj as THREE.Mesh).isMesh) out.push(obj as THREE.Mesh)
  })
  return out
}

function bindRtToMeshes(
  meshes: THREE.Mesh[],
  texture: THREE.Texture,
  savedMaps: WeakMap<THREE.Material, THREE.Texture | null>
): void {
  for (const mesh of meshes) {
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    for (const mat of mats) {
      if (!mat) continue
      const mapped = mat as THREE.MeshStandardMaterial
      if (!('map' in mapped)) continue
      if (!savedMaps.has(mat)) savedMaps.set(mat, mapped.map ?? null)
      mapped.map = texture
      mapped.needsUpdate = true
    }
  }
}

function restoreMeshMaps(meshes: THREE.Mesh[], savedMaps: WeakMap<THREE.Material, THREE.Texture | null>): void {
  for (const mesh of meshes) {
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    for (const mat of mats) {
      if (!mat || !savedMaps.has(mat)) continue
      const mapped = mat as THREE.MeshStandardMaterial
      if ('map' in mapped) mapped.map = savedMaps.get(mat) ?? null
      mapped.needsUpdate = true
      savedMaps.delete(mat)
    }
  }
}

function withSubtreeHidden(root: THREE.Object3D | null | undefined, fn: () => void): void {
  if (!root) {
    fn()
    return
  }
  const hidden: THREE.Object3D[] = []
  root.traverse((obj) => {
    if (obj.visible) {
      obj.visible = false
      hidden.push(obj)
    }
  })
  try {
    fn()
  } finally {
    for (const obj of hidden) obj.visible = true
  }
}

/** Same basis as VirtualCameraBridge — local -Z aims at target, world +Y up. */
function cameraLookAtQuat(
  eye: THREE.Vector3,
  target: THREE.Vector3,
  out: THREE.Quaternion
): boolean {
  _camZ.subVectors(eye, target)
  if (_camZ.lengthSq() < 1e-12) return false
  _camZ.normalize()
  _lookRight.crossVectors(_worldUp, _camZ)
  if (_lookRight.lengthSq() < 1e-12) {
    if (Math.abs(_worldUp.z) === 1) _camZ.x += 1e-4
    else _camZ.z += 1e-4
    _camZ.normalize()
    _lookRight.crossVectors(_worldUp, _camZ)
  }
  _lookRight.normalize()
  _lookUp.crossVectors(_camZ, _lookRight)
  _lookMat.makeBasis(_lookRight, _lookUp, _camZ)
  out.setFromRotationMatrix(_lookMat)
  return true
}

function resolveCctvLensPose(
  entity: Entity,
  ecs: MirrorComponents,
  deps: EntityWorldTransformDeps
): { position: THREE.Vector3; quaternion: THREE.Quaternion } | null {
  const { VirtualCamera } = ecs
  if (!VirtualCamera.has(entity)) return null
  if (!ecs.Transform.has(entity)) return null

  const world = resolveEntityWorldPose(entity, deps, {
    position: _targetPos,
    rotation: _entityDisplayQuat
  })
  if (!world) return null

  const spec = VirtualCamera.getOrNull(entity) as PBVirtualCamera | null
  const lookAt = spec?.lookAtEntity
  const { CameraEntity } = deps.view

  if (
    lookAt !== undefined &&
    lookAt !== null &&
    lookAt !== 0 &&
    lookAt !== (entity as number) &&
    lookAt !== (CameraEntity as number)
  ) {
    const targetWorld = resolveEntityWorldPose(lookAt as Entity, deps)
    if (targetWorld && cameraLookAtQuat(_targetPos, targetWorld.position, _targetQuat)) {
      return { position: _targetPos, quaternion: _targetQuat }
    }
  }

  _lookDir.set(0, 0, 1).applyQuaternion(_entityDisplayQuat)
  if (_lookDir.lengthSq() < 1e-12) {
    entityDisplayQuatToThreeCameraQuat(_entityDisplayQuat, _targetQuat)
    return { position: _targetPos, quaternion: _targetQuat }
  }
  _lookDir.normalize()
  _lookAt.copy(_targetPos).addScaledVector(_lookDir, 8)
  if (cameraLookAtQuat(_targetPos, _lookAt, _targetQuat)) {
    return { position: _targetPos, quaternion: _targetQuat }
  }
  entityDisplayQuatToThreeCameraQuat(_entityDisplayQuat, _targetQuat)
  return { position: _targetPos, quaternion: _targetQuat }
}

/**
 * Host apply for mirrored `tjs` LWW — shaders via ShaderManager / AbilityManager,
 * CCTV via VirtualCamera viewpoint + camera RT + projection screen bind.
 */
export class SceneTjsBridge {
  private readonly shaderFireFp = new Map<Entity, string>()
  private readonly declared = new Set<string>()
  private readonly cameras = new Map<Entity, TjsCameraRuntime>()
  private readonly projections = new Map<Entity, TjsProjectionRuntime>()

  constructor(
    private readonly ecs: MirrorComponents,
    private readonly worldScene: THREE.Scene,
    private readonly renderer: THREE.WebGLRenderer,
    private readonly getNodes: () => Map<Entity, THREE.Group> | undefined,
    private readonly getWorldDeps: () => EntityWorldTransformDeps | null
  ) {
    getShaderManager().setScene(worldScene)
  }

  sync(view: ProjectionView): void {
    const { Tjs } = this.ecs
    const seen = new Set<Entity>()

    for (const [entity] of view.getEntitiesWith(Tjs)) {
      seen.add(entity)
      const row = Tjs.getOrNull(entity) as TjsValue | null
      if (!row?.kind) continue
      const kind = row.kind.trim().toLowerCase()
      if (kind === 'shader') this.syncShader(entity, row)
      else if (kind === 'camera') this.syncCamera(entity, row)
      else if (kind === 'projection') this.syncProjection(entity, row)
    }

    for (const entity of [...this.cameras.keys()]) {
      if (!seen.has(entity)) this.teardownCamera(entity)
    }
    for (const entity of [...this.projections.keys()]) {
      if (!seen.has(entity)) this.teardownProjection(entity)
    }
    for (const entity of [...this.shaderFireFp.keys()]) {
      if (!seen.has(entity)) this.shaderFireFp.delete(entity)
    }
  }

  update(dt: number): void {
    const step = Math.min(0.05, Math.max(0, dt))
    getShaderManager().update(step)
    if (this.cameras.size === 0) return
    const nodes = this.getNodes()
    const deps = this.getWorldDeps()
    if (!nodes || !deps) return
    const prevTarget = this.renderer.getRenderTarget()
    const prevAutoClear = this.renderer.autoClear
    this.renderer.autoClear = true
    for (const runtime of this.cameras.values()) {
      if (!this.ecs.VirtualCamera.has(runtime.entity)) continue
      const pose = resolveCctvLensPose(runtime.entity, this.ecs, deps)
      if (!pose) continue
      runtime.cam.position.copy(pose.position)
      runtime.cam.quaternion.copy(pose.quaternion)
      const lensNode = nodes.get(runtime.entity)
      withSubtreeHidden(lensNode, () => {
        this.renderer.setRenderTarget(runtime.rt)
        this.renderer.clear()
        this.renderer.render(this.worldScene, runtime.cam)
      })
    }
    this.renderer.setRenderTarget(prevTarget)
    this.renderer.autoClear = prevAutoClear
  }

  dispose(): void {
    for (const entity of [...this.projections.keys()]) this.teardownProjection(entity)
    for (const entity of [...this.cameras.keys()]) this.teardownCamera(entity)
    this.projections.clear()
    this.cameras.clear()
    this.shaderFireFp.clear()
    this.declared.clear()
    getShaderManager().dispose()
  }

  private syncShader(entity: Entity, row: TjsValue): void {
    const path = resolveTjsShaderPath(row)
    const name = row.name.trim().toLowerCase()
    if (!name) return
    const mgr = getShaderManager()
    if (path) {
      const declKey = `${name}:${path}`
      if (!this.declared.has(declKey)) {
        mgr.declare(name, path)
        this.declared.add(declKey)
        clientDebugLog.log('scene', `tjs declare shader '${name}' path=${path}`, { alsoConsole: true })
      }
    }
    if (!row.enabled) return
    const fp = tjsValueFingerprint(row)
    if (this.shaderFireFp.get(entity) === fp) return
    this.shaderFireFp.set(entity, fp)
    const nodes = this.getNodes()
    const node = nodes?.get(entity) ?? null
    if (node) node.updateWorldMatrix(true, false)
    const params: Record<string, string> = {
      origin: `${row.ox},${row.oy},${row.oz}`,
      direction: `${row.dx},${row.dy},${row.dz}`,
      distance: String(row.dist > 0 ? row.dist : 32),
      sync: row.sync ? 'true' : 'false'
    }
    const ctx = buildShaderCtx(entity as number, 'spawn', params, node)
    ctx.sync = row.sync
    if (row.ox !== 0 || row.oy !== 0 || row.oz !== 0) {
      dclToThreePos(row.ox, row.oy, row.oz, _origin)
      ctx.origin.copy(_origin)
    }
    if (row.dx !== 0 || row.dy !== 0 || row.dz !== 0) {
      dclToThreePos(row.dx, row.dy, row.dz, _dir)
      _dir.y = 0
      if (_dir.lengthSq() > 1e-8) ctx.direction.copy(_dir.normalize())
    }
    if (row.dist > 0) ctx.distance = row.dist
    clientDebugLog.log(
      'scene',
      `tjs shader spawn e${entity as number} name=${name} sync=${row.sync}`,
      { alsoConsole: true }
    )
    mgr.trigger(name, 'spawn', ctx)
  }

  private syncCamera(entity: Entity, row: TjsValue): void {
    if (!row.enabled) {
      this.teardownCamera(entity)
      return
    }
    if (!this.ecs.VirtualCamera.has(entity)) return
    if (this.cameras.has(entity)) return
    const rt = new THREE.WebGLRenderTarget(TJS_CAMERA_RT_SIZE, TJS_CAMERA_RT_SIZE, {
      depthBuffer: true,
      stencilBuffer: false
    })
    rt.texture.colorSpace = THREE.SRGBColorSpace
    const cam = new THREE.PerspectiveCamera(TJS_CAMERA_FOV, 1, 0.1, TJS_CAMERA_FAR)
    this.cameras.set(entity, { entity, rt, cam })
    clientDebugLog.log('scene', `tjs camera on e${entity as number}`, { alsoConsole: true })
  }

  private syncProjection(entity: Entity, row: TjsValue): void {
    if (!row.enabled) {
      this.teardownProjection(entity)
      return
    }
    const cameraEntity = row.camera as Entity
    if (!cameraEntity) return
    const cameraRt = this.cameras.get(cameraEntity)
    if (!cameraRt) return
    const nodes = this.getNodes()
    const screenNode = nodes?.get(entity)
    if (!screenNode) return

    let runtime = this.projections.get(entity)
    if (runtime && runtime.cameraEntity !== cameraEntity) {
      this.teardownProjection(entity)
      runtime = undefined
    }
    if (!runtime) {
      const meshes = collectMeshes(screenNode)
      const savedMaps = new WeakMap<THREE.Material, THREE.Texture | null>()
      bindRtToMeshes(meshes, cameraRt.rt.texture, savedMaps)
      runtime = { entity, cameraEntity, boundMeshes: meshes, savedMaps }
      this.projections.set(entity, runtime)
      clientDebugLog.log(
        'scene',
        `tjs projection on e${entity as number} camera=e${cameraEntity as number}`,
        { alsoConsole: true }
      )
      return
    }
    const sample = runtime.boundMeshes[0]?.material
    const currentMap = sample
      ? ((Array.isArray(sample) ? sample[0] : sample) as THREE.MeshStandardMaterial)
      : null
    if (currentMap?.map !== cameraRt.rt.texture) {
      bindRtToMeshes(runtime.boundMeshes, cameraRt.rt.texture, runtime.savedMaps)
    }
  }

  private teardownCamera(entity: Entity): void {
    const runtime = this.cameras.get(entity)
    if (!runtime) return
    runtime.rt.dispose()
    this.cameras.delete(entity)
    clientDebugLog.log('scene', `tjs camera off e${entity as number}`, { alsoConsole: true })
  }

  private teardownProjection(entity: Entity): void {
    const runtime = this.projections.get(entity)
    if (!runtime) return
    restoreMeshMaps(runtime.boundMeshes, runtime.savedMaps)
    this.projections.delete(entity)
    clientDebugLog.log('scene', `tjs projection off e${entity as number}`, { alsoConsole: true })
  }
}
