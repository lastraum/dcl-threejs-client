import * as THREE from 'three'
import { isGltfInvisibleColliderMesh, isGltfInvisibleColliderName } from '../collision/gltfColliderNaming'
import { resolveDclAssetUrl } from './DclTextureResolver'
import { createExplorerPondWaterMaterial, tickExplorerPondWater } from './explorerPondWaterMaterial'

/**
 * Platform water visual (Explorer parity) — never show `*_collider` hulls.
 *
 * Official plaza `water_surface.glb` is a pointer/physics disk named
 * `water_surface_collider` with no maps. Sibling `water.png` is the albedo.
 * The collider stays hidden. The renderer adds a **visible-class** display
 * mesh (same geo, not named `_collider`) and applies Explorer Pond.mat
 * (caustics + refraction/spec + dual UV crawl) using sibling `water.png`.
 *
 * Same convention as `_collider` naming: filename / sibling `water.png`, not a
 * scene-name fork.
 */

const WATER_SURFACE_RE = /water_surface/i
const WATER_ALBEDO_LEAF = 'water.png'
/** Visible display child — must not match `/_collider/i`. */
export const DCL_WATER_VISUAL_NAME = 'dclWaterVisual'

export function isGltfWaterSurfaceSrc(src: string | undefined | null): boolean {
  return !!src && WATER_SURFACE_RE.test(src)
}

/** Hash-only load URLs have no filename — detect the collider node instead. */
export function isGltfWaterSurfaceRoot(root: THREE.Object3D | undefined | null): boolean {
  if (!root) return false
  let found = false
  root.traverse((node) => {
    if (found) return
    if (WATER_SURFACE_RE.test(node.name || '')) found = true
  })
  return found
}

function findExistingWaterVisual(root: THREE.Object3D): THREE.Mesh | null {
  let hit: THREE.Mesh | null = null
  root.traverse((node) => {
    if (hit) return
    if (!(node instanceof THREE.Mesh)) return
    if (node.name === DCL_WATER_VISUAL_NAME || node.userData.dclWaterVisual === true) {
      hit = node
    }
  })
  return hit
}

function collectWaterHullMeshes(root: THREE.Object3D): THREE.Mesh[] {
  const hulls: THREE.Mesh[] = []
  root.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) return
    if (node.userData.dclWaterVisual === true || node.name === DCL_WATER_VISUAL_NAME) return
    if (
      isGltfInvisibleColliderName(node.name) ||
      isGltfInvisibleColliderMesh(node, root)
    ) {
      hulls.push(node)
    }
  })
  return hulls
}

function collectUntexturedVisibleWaterMeshes(root: THREE.Object3D): THREE.Mesh[] {
  const out: THREE.Mesh[] = []
  root.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) return
    if (isGltfInvisibleColliderName(node.name) || isGltfInvisibleColliderMesh(node, root)) return
    if (node.userData.dclWaterVisual === true || node.name === DCL_WATER_VISUAL_NAME) {
      out.push(node)
      return
    }
    const name = node.name ?? ''
    if (!/water/i.test(name) || /leaf|lily|pad/i.test(name)) return
    const mats = Array.isArray(node.material) ? node.material : [node.material]
    const textured = mats.some((m) => !!(m as THREE.MeshStandardMaterial | undefined)?.map)
    if (!textured) out.push(node)
  })
  return out
}

function ensureVisibleWaterMesh(root: THREE.Object3D): THREE.Mesh | null {
  const existing = findExistingWaterVisual(root)
  if (existing) {
    existing.visible = true
    return existing
  }

  const authoredVisible = collectUntexturedVisibleWaterMeshes(root)
  if (authoredVisible.length) return authoredVisible[0]!

  const hulls = collectWaterHullMeshes(root)
  const src = hulls[0]
  if (!src?.geometry) return null

  const visual = new THREE.Mesh(src.geometry, new THREE.MeshPhysicalMaterial())
  visual.name = DCL_WATER_VISUAL_NAME
  visual.userData.dclWaterVisual = true
  visual.userData.dclWaterSurface = true
  visual.visible = true
  visual.frustumCulled = false
  visual.matrixAutoUpdate = true
  src.updateWorldMatrix(true, false)
  visual.position.set(0, 0, 0)
  visual.quaternion.identity()
  visual.scale.set(1, 1, 1)
  // Parent to the hull's parent so local geo lines up; hull stays hidden.
  const parent = src.parent ?? root
  parent.add(visual)
  return visual
}

/**
 * Bind sibling `water.png` onto **visible** water meshes only.
 * Collider hulls stay hidden — never unhide `*_collider`.
 */
export function bindGltfWaterSurface(
  root: THREE.Object3D,
  src: string,
  loadTexture: (url: string) => Promise<THREE.Texture>
): void {
  if (
    !isGltfWaterSurfaceSrc(src) &&
    !isGltfWaterSurfaceSrc(root.name) &&
    !isGltfWaterSurfaceRoot(root)
  ) {
    return
  }

  // Law: collider class stays invisible even when this GLB is the water disk.
  root.traverse((node) => {
    if (isGltfInvisibleColliderName(node.name) || isGltfInvisibleColliderMesh(node, root)) {
      node.visible = false
    }
  })

  const visual = ensureVisibleWaterMesh(root)
  if (!visual) return

  const url = resolveDclAssetUrl(WATER_ALBEDO_LEAF)
  if (!url || url === WATER_ALBEDO_LEAF) return

  void loadTexture(url)
    .then((tex) => {
      if (visual.userData.dclPondWaterBound === true) return
      visual.material = createExplorerPondWaterMaterial(tex)
      visual.userData.dclPondWaterBound = true
    })
    .catch(() => {
      /* sibling water.png missing — leave authored material */
    })
}

/** Advance Explorer pond water time (caustics dual-scroll). */
export function tickGltfWaterSurfaces(dt: number): void {
  tickExplorerPondWater(dt)
}
