import * as THREE from 'three'

const _headWorld = new THREE.Vector3()

/** DCL / Mixamo / CTRL rig head bone aliases (see emoteBoneMap Head variants). */
const HEAD_BONE_NAMES = new Set(
  ['Head', 'Avatar_Head', 'CTRL_Avatar_Head', 'CTRL_FK_Avatar_Head', 'mixamorigHead'].map((name) =>
    name.toLowerCase()
  )
)

export function findHeadBone(root: THREE.Object3D): THREE.Bone | null {
  let found: THREE.Bone | null = null
  root.traverse((obj) => {
    if (found) return
    if (!(obj instanceof THREE.Bone)) return
    const boneName = obj.name.replace(/\.\d+$/, '')
    if (HEAD_BONE_NAMES.has(boneName.toLowerCase())) found = obj
  })
  return found
}

/** Gap above the animated head bone for name tags (Explorer ~0.4 m + client lift). */
export const NAME_TAG_HEAD_OFFSET_Y = 0.62

/** Keep a name-tag anchor above the animated head (local to anchor parent). */
export function updateNameTagAnchor(
  anchor: THREE.Object3D,
  model: THREE.Object3D | null,
  fallbackY = 1.72,
  offsetY = NAME_TAG_HEAD_OFFSET_Y
): void {
  const tagY = fallbackY + offsetY
  if (!model || !anchor.parent) {
    anchor.position.set(0, tagY, 0)
    return
  }

  model.updateWorldMatrix(true, false)
  anchor.parent.updateWorldMatrix(true, false)

  const head = findHeadBone(model)
  if (!head) {
    anchor.position.set(0, tagY, 0)
    return
  }

  head.updateWorldMatrix(true, false)
  head.getWorldPosition(_headWorld)
  anchor.parent.worldToLocal(_headWorld)
  anchor.position.set(0, _headWorld.y + offsetY, 0)
}
