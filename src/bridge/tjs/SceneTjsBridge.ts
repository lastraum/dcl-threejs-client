import * as THREE from 'three'
import type { Entity } from '@dcl/ecs'
import { dclToThreePos } from '../dclTransform'
import { clientDebugLog } from '../../client/debug/ClientDebugLog'
import type { MirrorComponents } from '../mirrorComponents'
import type { ProjectionView } from '../ProjectionView'
import {
  resolveTjsShaderPath,
  tjsValueFingerprint,
  type TjsValue
} from '../../dcl/ecs/tjsComponent'
import { buildShaderCtx, getShaderManager } from '../../vfx/ShaderManager'

const _origin = new THREE.Vector3()
const _dir = new THREE.Vector3()
const _lookAt = new THREE.Vector3()
const _quat = new THREE.Quaternion()

/** Same shader name spammed via tjs.create — coalesce to the latest put. */
const SHADER_BURST_MS = 100

type CctvRuntime = {
  entity: Entity
  cameraEntity: Entity
  rt: THREE.WebGLRenderTarget
  cam: THREE.PerspectiveCamera
  lookAtEntity: Entity | null
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

/**
 * Host apply for mirrored `tjs` LWW — shaders via ShaderManager / AbilityManager,
 * CCTV texture feeds via per-entity RenderTarget.
 */
export class SceneTjsBridge {
  private readonly shaderFireFp = new Map<Entity, string>()
  private readonly shaderLastPutAt = new Map<string, number>()
  private readonly shaderCoalesceLatest = new Map<
    string,
    { entity: Entity; row: TjsValue; fp: string }
  >()
  private readonly shaderCoalesceTimer = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly declared = new Set<string>()
  private readonly cctv = new Map<Entity, CctvRuntime>()

  constructor(
    private readonly ecs: MirrorComponents,
    private readonly worldScene: THREE.Scene,
    private readonly renderer: THREE.WebGLRenderer,
    private readonly getNodes: () => Map<Entity, THREE.Group> | undefined
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
      else if (kind === 'texture') this.syncTexture(entity, row)
    }

    for (const entity of [...this.cctv.keys()]) {
      if (!seen.has(entity)) this.teardownCctv(entity)
    }
    for (const entity of [...this.shaderFireFp.keys()]) {
      if (!seen.has(entity)) this.shaderFireFp.delete(entity)
    }
  }

  update(dt: number): void {
    const step = Math.min(0.05, Math.max(0, dt))
    getShaderManager().update(step)
    if (this.cctv.size === 0) return
    const nodes = this.getNodes()
    if (!nodes) return
    const prevTarget = this.renderer.getRenderTarget()
    const prevAutoClear = this.renderer.autoClear
    this.renderer.autoClear = true
    for (const runtime of this.cctv.values()) {
      const cameraNode = nodes.get(runtime.cameraEntity)
      if (!cameraNode) continue
      cameraNode.updateWorldMatrix(true, false)
      cameraNode.getWorldPosition(_origin)
      cameraNode.getWorldQuaternion(_quat)
      runtime.cam.position.copy(_origin)
      runtime.cam.quaternion.copy(_quat)
      if (runtime.lookAtEntity != null) {
        const lookNode = nodes.get(runtime.lookAtEntity)
        if (lookNode) {
          lookNode.updateWorldMatrix(true, false)
          lookNode.getWorldPosition(_lookAt)
          runtime.cam.lookAt(_lookAt)
        }
      }
      this.renderer.setRenderTarget(runtime.rt)
      this.renderer.clear()
      this.renderer.render(this.worldScene, runtime.cam)
    }
    this.renderer.setRenderTarget(prevTarget)
    this.renderer.autoClear = prevAutoClear
  }

  dispose(): void {
    for (const entity of [...this.cctv.keys()]) this.teardownCctv(entity)
    this.cctv.clear()
    this.clearShaderCoalesce()
    this.shaderFireFp.clear()
    this.shaderLastPutAt.clear()
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

    const now = performance.now()
    const lastPut = this.shaderLastPutAt.get(name) ?? 0
    this.shaderLastPutAt.set(name, now)
    if (now - lastPut >= SHADER_BURST_MS) {
      this.clearShaderCoalesce(name)
      this.fireShaderSpawn(entity, row, name)
      return
    }
    this.shaderCoalesceLatest.set(name, { entity, row, fp })
    this.armShaderCoalesceFlush(name)
  }

  private armShaderCoalesceFlush(name: string): void {
    const existing = this.shaderCoalesceTimer.get(name)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => this.flushShaderCoalesce(name), SHADER_BURST_MS)
    this.shaderCoalesceTimer.set(name, timer)
  }

  private flushShaderCoalesce(name: string): void {
    const timer = this.shaderCoalesceTimer.get(name)
    if (timer) clearTimeout(timer)
    this.shaderCoalesceTimer.delete(name)
    const pending = this.shaderCoalesceLatest.get(name)
    this.shaderCoalesceLatest.delete(name)
    if (!pending) return
    this.fireShaderSpawn(pending.entity, pending.row, name)
  }

  private clearShaderCoalesce(name?: string): void {
    if (name !== undefined) {
      const timer = this.shaderCoalesceTimer.get(name)
      if (timer) clearTimeout(timer)
      this.shaderCoalesceTimer.delete(name)
      this.shaderCoalesceLatest.delete(name)
      return
    }
    for (const timer of this.shaderCoalesceTimer.values()) clearTimeout(timer)
    this.shaderCoalesceTimer.clear()
    this.shaderCoalesceLatest.clear()
  }

  private fireShaderSpawn(entity: Entity, row: TjsValue, name: string): void {
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
    getShaderManager().trigger(name, 'spawn', ctx)
  }

  private syncTexture(entity: Entity, row: TjsValue): void {
    const name = row.name.trim().toLowerCase()
    if (name !== 'cctv') return
    if (!row.enabled) {
      this.teardownCctv(entity)
      return
    }
    const cameraEntity = row.camera as Entity
    if (!cameraEntity) {
      clientDebugLog.log('scene', `tjs cctv e${entity as number} missing camera entity`, {
        level: 'warn',
        alsoConsole: true
      })
      return
    }
    const nodes = this.getNodes()
    const screenNode = nodes?.get(entity)
    const cameraNode = nodes?.get(cameraEntity)
    if (!screenNode || !cameraNode) return

    const { VirtualCamera } = this.ecs
    const vc = VirtualCamera?.getOrNull(cameraEntity) as { lookAtEntity?: number } | null
    const lookAtEntity =
      vc?.lookAtEntity !== undefined && vc.lookAtEntity !== null
        ? (vc.lookAtEntity as Entity)
        : null

    let runtime = this.cctv.get(entity)
    if (
      runtime &&
      (runtime.cameraEntity !== cameraEntity || runtime.lookAtEntity !== lookAtEntity)
    ) {
      this.teardownCctv(entity)
      runtime = undefined
    }
    if (!runtime) {
      const rt = new THREE.WebGLRenderTarget(512, 512, {
        depthBuffer: true,
        stencilBuffer: false
      })
      rt.texture.colorSpace = THREE.SRGBColorSpace
      const cam = new THREE.PerspectiveCamera(60, 1, 0.1, 256)
      const meshes = collectMeshes(screenNode)
      const savedMaps = new WeakMap<THREE.Material, THREE.Texture | null>()
      bindRtToMeshes(meshes, rt.texture, savedMaps)
      runtime = {
        entity,
        cameraEntity,
        rt,
        cam,
        lookAtEntity,
        boundMeshes: meshes,
        savedMaps
      }
      this.cctv.set(entity, runtime)
      clientDebugLog.log(
        'scene',
        `tjs cctv on e${entity as number} camera=e${cameraEntity as number}`,
        { alsoConsole: true }
      )
    }
  }

  private teardownCctv(entity: Entity): void {
    const runtime = this.cctv.get(entity)
    if (!runtime) return
    restoreMeshMaps(runtime.boundMeshes, runtime.savedMaps)
    runtime.rt.dispose()
    this.cctv.delete(entity)
    clientDebugLog.log('scene', `tjs cctv off e${entity as number}`, { alsoConsole: true })
  }
}
