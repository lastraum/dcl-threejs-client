import * as THREE from 'three'

const _footLocal = new THREE.Vector3()
const FOOT_BONE = /^(Avatar_)?(Left|Right)(Foot|ToeBase)$/i

/** Lowest foot/toe bone Y in avatar-root local space (bind / idle pose). */
export function measureAvatarFeetY(avatarRoot: THREE.Object3D): number | null {
  avatarRoot.updateWorldMatrix(true, true)
  let lowest: number | null = null

  avatarRoot.traverse((obj) => {
    if (!(obj instanceof THREE.Bone)) return
    const boneName = obj.name.replace(/\.\d+$/, '')
    if (!FOOT_BONE.test(boneName)) return

    obj.getWorldPosition(_footLocal)
    avatarRoot.worldToLocal(_footLocal)
    if (lowest === null || _footLocal.y < lowest) lowest = _footLocal.y
  })

  return lowest
}

/** Shift avatar pivot so soles meet the PhysX capsule base (y = 0 on player root). */
export function applyAvatarPivotOffset(pivot: THREE.Object3D, model?: THREE.Object3D | null): void {
  const avatar =
    model ??
    (pivot.children.find((child) => child.name === 'dcl-avatar') as THREE.Object3D | undefined) ??
    pivot.children[0] ??
    null

  const feetY = avatar ? measureAvatarFeetY(avatar) : null
  pivot.position.y = feetY !== null ? -feetY : 0
}

/** @deprecated Use applyAvatarPivotOffset on the avatar pivot instead. */
export function alignAvatarFeetToGround(avatarRoot: THREE.Object3D): number {
  return measureAvatarFeetY(avatarRoot) ?? 0
}
