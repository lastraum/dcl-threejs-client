import * as THREE from 'three'

const _tmp = new THREE.Vector3()
const FOOT_BONE = /^(Avatar_)?(Left|Right)(Foot|ToeBase)$/i
const HIPS_BONE = /^(Avatar_)?(Hips|hip)$/i

export type AvatarStance = {
  /** Lowest foot bone Y in root-local space. */
  feetY: number
  /** Average foot XZ (or hips) in root-local space — use for disc centering. */
  centerX: number
  centerZ: number
}

/** Lowest foot/toe bone Y in avatar-root local space (bind / idle pose). */
export function measureAvatarFeetY(avatarRoot: THREE.Object3D): number | null {
  return measureAvatarStance(avatarRoot)?.feetY ?? null
}

/**
 * Foot stance in root-local space. XZ is the midpoint of left/right feet so props
 * (swords, etc.) don't pull the mesh AABB off the ground disc.
 */
export function measureAvatarStance(avatarRoot: THREE.Object3D): AvatarStance | null {
  avatarRoot.updateWorldMatrix(true, true)
  const feet: THREE.Vector3[] = []
  let hipsX = 0
  let hipsY = 0
  let hipsZ = 0
  let hasHips = false

  avatarRoot.traverse((obj) => {
    if (!(obj instanceof THREE.Bone)) return
    const boneName = obj.name.replace(/\.\d+$/, '')
    obj.getWorldPosition(_tmp)
    avatarRoot.worldToLocal(_tmp)
    if (FOOT_BONE.test(boneName)) {
      feet.push(_tmp.clone())
    } else if (!hasHips && HIPS_BONE.test(boneName)) {
      hipsX = _tmp.x
      hipsY = _tmp.y
      hipsZ = _tmp.z
      hasHips = true
    }
  })

  if (feet.length > 0) {
    let sx = 0
    let sz = 0
    let lowest = feet[0]!.y
    for (const f of feet) {
      sx += f.x
      sz += f.z
      if (f.y < lowest) lowest = f.y
    }
    return { feetY: lowest, centerX: sx / feet.length, centerZ: sz / feet.length }
  }

  if (hasHips) {
    return { feetY: hipsY, centerX: hipsX, centerZ: hipsZ }
  }

  return null
}

/**
 * Shift the *model* under the yaw pivot so soles sit on the PhysX capsule base
 * (player root y = 0). Offset must not live on the pivot — setYaw rotates the pivot,
 * which would turn local XZ into world "behind" offset.
 */
export function applyAvatarPivotOffset(pivot: THREE.Object3D, model?: THREE.Object3D | null): void {
  pivot.position.set(0, 0, 0)
  const avatar =
    model ??
    (pivot.children.find((child) => child.name === 'dcl-avatar') as THREE.Object3D | undefined) ??
    pivot.children[0] ??
    null

  if (!avatar) return
  avatar.position.set(0, 0, 0)
  const stance = measureAvatarStance(avatar)
  if (!stance) return
  avatar.position.set(-stance.centerX, -stance.feetY, -stance.centerZ)
}

/** @deprecated Use applyAvatarPivotOffset on the avatar pivot instead. */
export function alignAvatarFeetToGround(avatarRoot: THREE.Object3D): number {
  return measureAvatarFeetY(avatarRoot) ?? 0
}
