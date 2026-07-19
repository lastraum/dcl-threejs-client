/**
 * Build photo metadata from the dedicated photo-mode camera view.
 *
 * Unity Explorer: ScreenshotMetadataBuilder tests avatar colliders against a
 * frustum scaled by FRAME_SCALE (same crop as the viewfinder). We use Three.js
 * Frustum + sphere tests on avatar roots.
 */

import * as THREE from 'three'
import { PHOTO_FRAME_SCALE } from './constants'

export type PhotoWearableRef = {
  urn: string
}

export type PhotoVisiblePerson = {
  userName: string
  userAddress: string
  isGuest: boolean
  isEmoting: boolean
  hasClaimedName?: boolean
  nameColor?: string
  faceUrl?: string | null
  /** Equipped wearable URNs (excluding base body when filtered at resolve time). */
  wearables: string[]
}

export type PhotoSceneMeta = {
  name: string
  parcelX: number
  parcelY: number
}

export type PhotoMetadata = {
  userName: string
  userAddress: string
  /** Unix seconds (Explorer Camera Reel style). */
  dateTime: string
  realm: string
  scene: PhotoSceneMeta
  visiblePeople: PhotoVisiblePerson[]
  camera: {
    position: { x: number; y: number; z: number }
    fov: number
  }
}

export type PhotoPersonSample = {
  address: string
  displayName: string
  isGuest?: boolean
  isEmoting?: boolean
  hasClaimedName?: boolean
  nameColor?: string
  faceUrl?: string | null
  wearables?: string[]
  /** World-space center of the avatar (approx torso). */
  worldPosition: THREE.Vector3
  /** Rough bounding radius for frustum test (m). */
  radius?: number
}

const _proj = new THREE.Matrix4()
const _frustum = new THREE.Frustum()
const _sphere = new THREE.Sphere()

/**
 * Frustum matching the on-screen crop frame (scaled FOV, same aspect).
 * Unity temporarily shrinks FOV via atan(tan(fov/2)*scale)*2 for plane tests.
 */
export function setPhotoFrameFrustum(camera: THREE.PerspectiveCamera, frameScale = PHOTO_FRAME_SCALE): THREE.Frustum {
  const origFov = camera.fov
  const half = THREE.MathUtils.degToRad(origFov) * 0.5
  const scaledFov = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(half) * frameScale))
  camera.fov = scaledFov
  camera.updateProjectionMatrix()
  camera.updateMatrixWorld(true)
  _proj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
  _frustum.setFromProjectionMatrix(_proj)
  camera.fov = origFov
  camera.updateProjectionMatrix()
  return _frustum
}

export function peopleInPhotoFrustum(
  camera: THREE.PerspectiveCamera,
  people: readonly PhotoPersonSample[],
  frameScale = PHOTO_FRAME_SCALE
): PhotoVisiblePerson[] {
  const frustum = setPhotoFrameFrustum(camera, frameScale)
  const out: PhotoVisiblePerson[] = []
  for (const p of people) {
    const r = p.radius ?? 0.9
    _sphere.center.copy(p.worldPosition)
    // Center sphere on torso (feet → mid body)
    _sphere.center.y += 0.9
    _sphere.radius = r
    if (!frustum.intersectsSphere(_sphere)) continue
    out.push({
      userName: p.displayName || 'Unknown',
      userAddress: p.address,
      isGuest: !!p.isGuest,
      isEmoting: !!p.isEmoting,
      hasClaimedName: !!p.hasClaimedName,
      nameColor: p.nameColor,
      faceUrl: p.faceUrl ?? null,
      wearables: p.wearables ? [...p.wearables] : []
    })
  }
  return out
}

export function buildPhotoMetadata(args: {
  selfName: string
  selfAddress: string
  realm: string
  sceneName: string
  parcelX: number
  parcelY: number
  camera: THREE.PerspectiveCamera
  visiblePeople: PhotoVisiblePerson[]
}): PhotoMetadata {
  const pos = args.camera.position
  return {
    userName: args.selfName,
    userAddress: args.selfAddress,
    dateTime: String(Math.floor(Date.now() / 1000)),
    realm: args.realm,
    scene: {
      name: args.sceneName,
      parcelX: args.parcelX,
      parcelY: args.parcelY
    },
    visiblePeople: args.visiblePeople,
    camera: {
      position: { x: pos.x, y: pos.y, z: pos.z },
      fov: args.camera.fov
    }
  }
}

/** "July 18, 2026" from unix seconds string. */
export function formatPhotoDate(dateTimeUnix: string | number): string {
  const sec = Number(dateTimeUnix)
  const d = Number.isFinite(sec) && sec > 0 ? new Date(sec * 1000) : new Date()
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
}

/** Marketplace item page for collections-v2 URNs; null for base/off-chain. */
export function marketplaceItemUrl(urn: string): string | null {
  const match =
    /^urn:decentraland:(?:matic|ethereum):collections-v2:(0x[a-fA-F0-9]{40}):(\d+)/i.exec(urn.trim())
  if (!match) return null
  const contract = match[1].toLowerCase()
  const itemId = match[2]
  return `https://decentraland.org/marketplace/contracts/${contract}/items/${itemId}`
}
