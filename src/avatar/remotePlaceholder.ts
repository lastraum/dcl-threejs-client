import * as THREE from 'three'
import { createGltfLoader, sanitizeWearableRoot } from './loadWearable'
import { normalizeWearableWorldScale } from './wearableSanitize'

/**
 * Shared GPU resources for remote loading stand-ins.
 * BaseMale mannequin (static bind-pose bake) + one neon material for all peers.
 * Each peer gets its own Mesh instances (own transforms) but shared geo/mat.
 */

const BASE_MALE_GLB = '/avatar/wearables/BaseMale/BaseMale.glb'

/** Cool electric violet neon shell while Catalyst wearables load. */
const NEON_COLOR = 0x7b2fff
const NEON_EMISSIVE = 0xb24dff

let sharedGeometries: THREE.BufferGeometry[] | null = null
let sharedNeonMat: THREE.MeshStandardMaterial | null = null
let templatePromise: Promise<THREE.BufferGeometry[] | null> | null = null
let pulseRaf = 0
let pulseStartMs = 0

const _vertex = new THREE.Vector3()

function getSharedNeonMaterial(): THREE.MeshStandardMaterial {
  if (!sharedNeonMat) {
    sharedNeonMat = new THREE.MeshStandardMaterial({
      color: NEON_COLOR,
      emissive: NEON_EMISSIVE,
      emissiveIntensity: 1.6,
      metalness: 0.55,
      roughness: 0.22,
      transparent: true,
      opacity: 0.78,
      depthWrite: false,
      side: THREE.FrontSide
    })
    startNeonPulse()
  }
  return sharedNeonMat
}

/** Soft breathing glow so the loading shell reads as "in progress", not static junk. */
function startNeonPulse(): void {
  if (pulseRaf) return
  pulseStartMs = performance.now()
  const tick = (now: number) => {
    pulseRaf = requestAnimationFrame(tick)
    if (!sharedNeonMat) return
    const t = (now - pulseStartMs) / 1000
    // 0.95 ↔ 2.1 emissive, slight opacity breathe
    const wave = 0.5 + 0.5 * Math.sin(t * 2.2)
    sharedNeonMat.emissiveIntensity = 0.95 + wave * 1.15
    sharedNeonMat.opacity = 0.62 + wave * 0.22
  }
  pulseRaf = requestAnimationFrame(tick)
}

/**
 * Bake BaseMale meshes to static bind-pose geometry in root-local space,
 * feet planted at y=0. Shared across all loading peers.
 */
function bakeBaseMaleGeometries(avatarRoot: THREE.Object3D): THREE.BufferGeometry[] {
  avatarRoot.updateMatrixWorld(true)
  const rootInv = avatarRoot.matrixWorld.clone().invert()
  const geometries: THREE.BufferGeometry[] = []

  avatarRoot.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return
    const srcGeo = obj.geometry
    if (!srcGeo?.attributes?.position) return

    obj.updateMatrixWorld(true)
    if (obj instanceof THREE.SkinnedMesh) {
      obj.skeleton.pose()
      obj.updateMatrixWorld(true)
    }

    const baked = srcGeo.clone()
    const pos = baked.attributes.position as THREE.BufferAttribute
    for (let i = 0; i < pos.count; i++) {
      if (obj instanceof THREE.SkinnedMesh) {
        // World-space skinned bind-pose position.
        obj.getVertexPosition(i, _vertex)
      } else {
        _vertex.fromBufferAttribute(pos, i)
        _vertex.applyMatrix4(obj.matrixWorld)
      }
      _vertex.applyMatrix4(rootInv)
      pos.setXYZ(i, _vertex.x, _vertex.y, _vertex.z)
    }
    baked.computeVertexNormals()
    geometries.push(baked)
  })

  if (geometries.length === 0) return geometries

  let minY = Infinity
  for (const geo of geometries) {
    geo.computeBoundingBox()
    minY = Math.min(minY, geo.boundingBox?.min.y ?? 0)
  }
  if (Number.isFinite(minY) && minY !== 0) {
    for (const geo of geometries) {
      geo.translate(0, -minY, 0)
      geo.computeBoundingBox()
      geo.computeBoundingSphere()
    }
  }

  return geometries
}

async function ensureSharedGeometries(): Promise<THREE.BufferGeometry[] | null> {
  if (sharedGeometries) return sharedGeometries
  if (templatePromise) return templatePromise

  templatePromise = (async () => {
    try {
      const loader = createGltfLoader({})
      const gltf = await loader.loadAsync(BASE_MALE_GLB)
      const avatarRoot = gltf.scene
      avatarRoot.name = 'remote-placeholder-basemale-source'
      sanitizeWearableRoot(avatarRoot)
      normalizeWearableWorldScale(avatarRoot, 'body_shape')

      const geos = bakeBaseMaleGeometries(avatarRoot)
      if (!geos.length) {
        console.warn('[avatar] BaseMale placeholder bake produced no meshes')
        return null
      }
      sharedGeometries = geos
      return geos
    } catch (err) {
      console.warn('[avatar] failed to load BaseMale loading placeholder', err)
      return null
    }
  })()

  return templatePromise
}

function fillPlaceholderBody(root: THREE.Group, geos: THREE.BufferGeometry[]): void {
  if (root.userData.disposed) return
  // Already filled (race: ensure fired twice).
  if (root.children.length > 0) return

  const mat = getSharedNeonMaterial()
  const body = new THREE.Group()
  body.name = 'remote-placeholder-body'

  for (let i = 0; i < geos.length; i++) {
    const mesh = new THREE.Mesh(geos[i]!, mat)
    mesh.name = `remote-placeholder-part-${i}`
    mesh.castShadow = false
    mesh.receiveShadow = false
    mesh.frustumCulled = true
    mesh.userData.sharedGpu = true
    body.add(mesh)
  }

  root.add(body)
}

/**
 * Lightweight neon BaseMale stand-in while the full Catalyst / custom avatar compose runs.
 * Returns immediately; BaseMale mesh attaches when the shared template finishes loading.
 * @param _showPill deprecated — always uses neon BaseMale (kept for call-site compat).
 */
export function createRemoteAvatarPlaceholder(_showPill = true): THREE.Group {
  const root = new THREE.Group()
  root.name = 'remote-placeholder'
  root.userData.remotePlaceholder = true
  root.userData.disposed = false

  if (sharedGeometries) {
    fillPlaceholderBody(root, sharedGeometries)
  } else {
    void ensureSharedGeometries().then((geos) => {
      if (!geos || root.userData.disposed) return
      fillPlaceholderBody(root, geos)
    })
  }

  return root
}

/**
 * Detach a placeholder without disposing shared geometries / neon material.
 */
export function disposeRemoteAvatarPlaceholder(root: THREE.Object3D): void {
  root.userData.disposed = true
  root.removeFromParent()
  while (root.children.length > 0) {
    root.remove(root.children[0]!)
  }
}
