import type { Object3D, Vector3 } from 'three'
import { dclToThreePos } from '../../bridge/dclTransform'
import { neighborOriginOffset } from '../aoi/compositeVisuals'
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
 * Live secondary workers author content in **their** scene-local DCL space
 * (SW of neighbor base = 0,0). The Three host graph uses **primary** SW as
 * origin. Without this offset, every secondary dumps meshes on the primary
 * footprint — the classic “rogue GLBs” AOI bug.
 *
 * Tertiary composites / first-frame already apply the same math via
 * {@link neighborOriginOffset}. Keep these in lockstep.
 */
export function applySecondarySceneRootOrigin(
  root: Object3D | null | undefined,
  neighborBase: string,
  primaryBase: string
): void {
  if (!root) return
  const n = neighborBase.trim()
  const p = primaryBase.trim()
  if (!n || !p) {
    root.position.set(0, 0, 0)
    bakeWorldMatrix(root)
    return
  }
  const o = neighborOriginOffset(n, p)
  dclToThreePos(o.x, 0, o.z, root.position)
  bakeWorldMatrix(root)
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

/** Promote handoff — primary must sit at host origin again. */
export function clearSecondarySceneRootOrigin(root: Object3D | null | undefined): void {
  if (!root) return
  root.position.set(0, 0, 0)
  bakeWorldMatrix(root)
}
