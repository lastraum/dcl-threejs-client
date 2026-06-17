import * as THREE from 'three'

const _headWorld = new THREE.Vector3()
const HEAD_BONE = /^head$/i

export function findHeadBone(root: THREE.Object3D): THREE.Bone | null {
  let found: THREE.Bone | null = null
  root.traverse((obj) => {
    if (found) return
    if (!(obj instanceof THREE.Bone)) return
    const boneName = obj.name.replace(/\.\d+$/, '')
    if (HEAD_BONE.test(boneName)) found = obj
  })
  return found
}

/** Small gap above the animated head bone for name tags (Explorer ~0.2 m). */
export const NAME_TAG_HEAD_OFFSET_Y = 0.22

/** Keep a name-tag anchor above the animated head (local to anchor parent). */
export function updateNameTagAnchor(
  anchor: THREE.Object3D,
  model: THREE.Object3D | null,
  fallbackY = 1.72,
  offsetY = NAME_TAG_HEAD_OFFSET_Y
): void {
  if (!model || !anchor.parent) {
    anchor.position.set(0, fallbackY, 0)
    return
  }

  const head = findHeadBone(model)
  if (!head) {
    anchor.position.set(0, fallbackY, 0)
    return
  }

  head.getWorldPosition(_headWorld)
  anchor.parent.worldToLocal(_headWorld)
  anchor.position.set(0, _headWorld.y + offsetY, 0)
}
