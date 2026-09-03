import type { Object3D, Vector3 } from 'three'
import { dclToThreePos } from '../../bridge/dclTransform'
import { neighborOriginOffset } from '../aoi/compositeVisuals'
import { GENESIS_CITY_FILL_ORIGIN } from '../aoi/parcelAoi'
import type { EntityPose } from '../../bridge/ReservedEntitiesSync'

/**
 * Force-bake local TRS → matrix even when matrixAutoUpdate is false.
 * Tertiary LOD freezes auto-update; without this, demote retarget is a no-op and
 * the prior primary appears to "unload" (stuck at old SW while player is restored
 * to the new primary footprint).
 */
function bakeWorldMatrix(root: Object3D): void {
  root.updateMatrix()
  root.updateMatrixWorld(true)
}

/**
 * Scene graphs author content in **their** scene-local DCL space (SW = 0,0).
 * The Three / PhysX world is **Genesis-stable** (parcel 0,0). Offset the entity
 * root by (sceneBase − 0,0) so hulls never move on FocusOwner promote.
 */
export function applyGenesisSceneRootOrigin(
  root: Object3D | null | undefined,
  sceneBase: string
): void {
  applySecondarySceneRootOrigin(root, sceneBase, GENESIS_CITY_FILL_ORIGIN)
}

/**
 * @param primaryBase Ignored for pose — kept so call sites that still pass the
 *   FocusOwner base compile. Offset is always vs genesis 0,0.
 */
export function applySecondarySceneRootOrigin(
  root: Object3D | null | undefined,
  neighborBase: string,
  _primaryBase?: string
): void {
  if (!root) return
  const n = neighborBase.trim()
  if (!n) {
    root.position.set(0, 0, 0)
    bakeWorldMatrix(root)
    return
  }
  const o = neighborOriginOffset(n, GENESIS_CITY_FILL_ORIGIN)
  dclToThreePos(o.x, 0, o.z, root.position)
  bakeWorldMatrix(root)
}

/**
 * Three.js world delta to keep genesis-baked PhysX/meshes in place when FocusOwner
 * SW jumps `oldPrimaryBase` → `newPrimaryBase`. Same math as a demoted root offset
 * (`dclToThree(old − new)`). Apply **once** to every world-baked hull that lived in
 * the old frame — incoming primary, demoted primary, and other residents.
 */
export function originRebaseThreeDelta(
  oldPrimaryBase: string,
  newPrimaryBase: string
): { x: number; y: number; z: number } {
  const o = neighborOriginOffset(oldPrimaryBase.trim(), newPrimaryBase.trim())
  const v = dclToThreePos(o.x, 0, o.z)
  return { x: v.x, y: v.y, z: v.z }
}

/**
 * Host feet/camera are FocusOwner-local DCL. Each live scene.js wants
 * coordinates relative to *its* SW: host − (neighbor − hostBase)×16.
 */
export function hostPoseToSceneLocal(
  pose: EntityPose,
  neighborBase: string,
  hostBase: string
): EntityPose {
  const n = neighborBase.trim()
  const p = hostBase.trim()
  if (!n || !p || n === p) return pose
  const o = neighborOriginOffset(n, p)
  const position = pose.position.clone() as Vector3
  position.x -= o.x
  position.z -= o.z
  return { position, rotation: pose.rotation }
}

/** @deprecated Genesis-stable roots stay put on promote — do not zero the graph. */
export function clearSecondarySceneRootOrigin(_root: Object3D | null | undefined): void {
  /* genesis-stable: no-op */
}
