import * as THREE from 'three'

/** Three.js ↔ PhysX vector helpers (from Hyperfy `extendThreePhysX.js`). */
export function extendThreePhysX(): void {
  if (!globalThis.PHYSX) throw new Error('PHYSX not initialised')
  if ((THREE.Vector3.prototype as THREE.Vector3 & { fromPxVec3?: unknown }).fromPxVec3) return

  const _pxVec3 = new PHYSX.PxVec3()
  const _pxExtVec3 = new PHYSX.PxExtendedVec3()

  THREE.Vector3.prototype.fromPxVec3 = function (pxVec3: { x: number; y: number; z: number }) {
    this.x = pxVec3.x
    this.y = pxVec3.y
    this.z = pxVec3.z
    return this
  }

  THREE.Vector3.prototype.toPxVec3 = function (pxVec3: { x: number; y: number; z: number } = _pxVec3) {
    pxVec3.x = this.x
    pxVec3.y = this.y
    pxVec3.z = this.z
    return pxVec3
  }

  THREE.Vector3.prototype.toPxExtVec3 = function (
    pxExtVec3: { x: number; y: number; z: number } = _pxExtVec3
  ) {
    pxExtVec3.x = this.x
    pxExtVec3.y = this.y
    pxExtVec3.z = this.z
    return pxExtVec3
  }

  THREE.Vector3.prototype.toPxTransform = function (pxTransform: { p: { x: number; y: number; z: number } }) {
    pxTransform.p.x = this.x
    pxTransform.p.y = this.y
    pxTransform.p.z = this.z
  }

  THREE.Quaternion.prototype.toPxTransform = function (pxTransform: {
    q: { x: number; y: number; z: number; w: number }
  }) {
    pxTransform.q.x = this.x
    pxTransform.q.y = this.y
    pxTransform.q.z = this.z
    pxTransform.q.w = this.w
  }
}

declare module 'three' {
  interface Vector3 {
    fromPxVec3(pxVec3: { x: number; y: number; z: number }): this
    toPxVec3(pxVec3?: unknown): unknown
    toPxExtVec3(pxExtVec3?: { x: number; y: number; z: number }): unknown
    toPxTransform(pxTransform: { p: { x: number; y: number; z: number } }): void
  }
  interface Quaternion {
    toPxTransform(pxTransform: { q: { x: number; y: number; z: number; w: number } }): void
  }
}
