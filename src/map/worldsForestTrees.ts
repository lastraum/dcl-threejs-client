/**
 * Forest trees: one Meshy cypress GLB, instanced at layout poses.
 * Canonical mesh is ~20 m tall with origin at the base.
 * Instance scale = pose.height / unitHeight. A* still uses trunk discs.
 */
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { layoutStreamTrees, type ForestTreePose } from './worldsForestLayout'

const STREAM_MAX = 420

const GLB_URL = '/forest/trees/cypress-meshy.glb'

function patchSap(mat: THREE.MeshStandardMaterial): void {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = { value: 0 }
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <common>',
      `#include <common>\nuniform float uTime;`
    )
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <emissivemap_fragment>',
      `#include <emissivemap_fragment>
{
  float cyan = max(0.0, diffuseColor.g * 0.32 + diffuseColor.b * 0.68 - diffuseColor.r);
  float pulse = 0.62 + 0.38 * sin(uTime * 2.05);
  totalEmissiveRadiance += vec3(0.22, 0.9, 1.0) * pow(cyan, 1.45) * pulse * 1.6;
}`
    )
    mat.userData.shader = shader
  }
  mat.customProgramCacheKey = () => 'forest-meshy-cypress-v1'
}

function firstMesh(root: THREE.Object3D): THREE.Mesh | null {
  let found: THREE.Mesh | null = null
  root.traverse((obj) => {
    if (found || !(obj instanceof THREE.Mesh) || !obj.geometry) return
    found = obj
  })
  return found
}

export class ForestTrees {
  private readonly group = new THREE.Group()
  private geo: THREE.BufferGeometry | null = null
  private mat: THREE.MeshStandardMaterial | null = null
  private mesh: THREE.InstancedMesh | null = null
  private streamMesh: THREE.InstancedMesh | null = null
  private unitHeight = 20
  private layoutKey = ''
  private streamKey = ''
  private innerPoses: ForestTreePose[] = []
  private streamPoses: ForestTreePose[] = []
  private pending: { poses: ForestTreePose[]; key: string } | null = null
  private loaded = false
  private disposed = false

  constructor(scene: THREE.Scene) {
    this.group.name = 'forest-cypress'
    scene.add(this.group)
    const loader = new GLTFLoader()
    loader.load(
      GLB_URL,
      (gltf) => {
        if (this.disposed) {
          disposeObject3D(gltf.scene)
          return
        }
        const src = firstMesh(gltf.scene)
        if (!src) {
          console.warn('[forest] cypress GLB has no mesh')
          return
        }
        this.geo = src.geometry
        this.geo.computeBoundingBox()
        const bb = this.geo.boundingBox
        if (bb) this.unitHeight = Math.max(0.01, bb.max.y - bb.min.y)
        const raw = Array.isArray(src.material) ? src.material[0] : src.material
        const mat =
          raw instanceof THREE.MeshStandardMaterial
            ? raw
            : new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.82, metalness: 0.02 })
        mat.side = THREE.DoubleSide
        mat.transparent = false
        mat.depthWrite = true
        if (mat.map) {
          mat.map.colorSpace = THREE.SRGBColorSpace
          mat.map.anisotropy = 8
        }
        if (mat.normalMap) mat.normalMap.anisotropy = 8
        patchSap(mat)
        this.mat = mat
        this.loaded = true
        if (this.pending) this.setPoses(this.pending.poses, this.pending.key)
      },
      undefined,
      (err) => {
        console.warn('[forest] cypress GLB failed to load', err)
      }
    )
  }

  setPoses(poses: ForestTreePose[], layoutKey: string): void {
    this.pending = { poses, key: layoutKey }
    if (!this.loaded || !this.geo || !this.mat) return
    if (layoutKey === this.layoutKey && this.mesh) return
    this.layoutKey = layoutKey
    this.innerPoses = poses
    this.clearMesh()
    if (!poses.length) return

    const mesh = new THREE.InstancedMesh(this.geo, this.mat, poses.length)
    mesh.name = 'forest-cypress-instances'
    mesh.frustumCulled = true
    mesh.castShadow = false
    mesh.receiveShadow = false
    writeInstances(mesh, poses, this.unitHeight)
    this.group.add(mesh)
    this.mesh = mesh
  }

  colliders(): ForestTreePose[] {
    return this.innerPoses.concat(this.streamPoses)
  }

  update(time: number, playerX = 0, playerZ = 0): void {
    const sh = this.mat?.userData.shader as { uniforms?: Record<string, { value: number }> } | undefined
    if (sh?.uniforms?.uTime) sh.uniforms.uTime.value = time
    this.syncStream(playerX, playerZ)
  }

  dispose(): void {
    this.disposed = true
    this.clearMesh()
    this.streamMesh?.removeFromParent()
    this.streamMesh = null
    this.group.removeFromParent()
    this.geo?.dispose()
    if (this.mat) disposeMaterialMaps(this.mat)
    this.mat?.dispose()
    this.geo = null
    this.mat = null
  }

  private clearMesh(): void {
    // Do not dispose the InstancedMesh: that would kill the shared geo/mat.
    this.mesh?.removeFromParent()
    this.mesh = null
  }

  private syncStream(playerX: number, playerZ: number): void {
    if (!this.loaded || !this.geo || !this.mat) return
    const key = `${Math.floor(playerX / 24)}:${Math.floor(playerZ / 24)}`
    if (key === this.streamKey && this.streamMesh) return
    this.streamKey = key
    const poses = layoutStreamTrees(playerX, playerZ)
    this.streamPoses = poses
    if (!this.streamMesh) {
      const mesh = new THREE.InstancedMesh(this.geo, this.mat, STREAM_MAX)
      mesh.name = 'forest-cypress-stream'
      mesh.frustumCulled = false
      mesh.castShadow = false
      mesh.receiveShadow = false
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
      this.group.add(mesh)
      this.streamMesh = mesh
    }
    writeInstances(this.streamMesh, poses, this.unitHeight, STREAM_MAX)
  }
}

function writeInstances(
  mesh: THREE.InstancedMesh,
  poses: ForestTreePose[],
  unitHeight: number,
  capacity = poses.length
): void {
  const dummy = new THREE.Object3D()
  const n = Math.min(poses.length, capacity)
  const h = unitHeight
  for (let i = 0; i < n; i++) {
    const t = poses[i]!
    dummy.position.set(t.x, 0, t.z)
    dummy.rotation.set(0, (i * 2.399) % (Math.PI * 2), 0)
    dummy.scale.setScalar(t.height / h)
    dummy.updateMatrix()
    mesh.setMatrixAt(i, dummy.matrix)
  }
  const hidden = new THREE.Matrix4().makeScale(0, 0, 0)
  for (let i = n; i < capacity; i++) mesh.setMatrixAt(i, hidden)
  mesh.instanceMatrix.needsUpdate = true
  mesh.computeBoundingSphere()
}

function disposeMaterialMaps(mat: THREE.MeshStandardMaterial): void {
  const maps = new Set<THREE.Texture | null>([
    mat.map,
    mat.normalMap,
    mat.metalnessMap,
    mat.roughnessMap,
    mat.aoMap,
    mat.emissiveMap
  ])
  for (const tex of maps) tex?.dispose()
}

function disposeObject3D(root: THREE.Object3D): void {
  root.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return
    obj.geometry.dispose()
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material]
    for (const m of mats) {
      if (m instanceof THREE.MeshStandardMaterial) disposeMaterialMaps(m)
      m.dispose()
    }
  })
}
