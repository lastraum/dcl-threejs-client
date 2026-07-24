import type { Object3D } from 'three'
import { dclToThreePos } from '../../bridge/dclTransform'
import { neighborOriginOffset } from '../aoi/compositeVisuals'

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
    root.updateMatrixWorld(true)
    return
  }
  const o = neighborOriginOffset(n, p)
  dclToThreePos(o.x, 0, o.z, root.position)
  root.updateMatrixWorld(true)
}

/** Promote handoff — primary must sit at host origin again. */
export function clearSecondarySceneRootOrigin(root: Object3D | null | undefined): void {
  if (!root) return
  root.position.set(0, 0, 0)
  root.updateMatrixWorld(true)
}
