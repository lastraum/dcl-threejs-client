import type * as THREE from 'three'
import { renderQuality, type ShadowQuality } from './RenderQualitySettings'

/** Environment casters only inside Shadows Distance. Avatars / remotes are not this list. */
function envCasterKeepM(): number {
  return Math.max(0, renderQuality.getShadowsDistanceM())
}
const ENV_CASTER_CAP: Record<Exclude<ShadowQuality, 'off'>, number> = {
  low: 16,
  medium: 32,
  high: 64,
  ultra: 96
}

type EnvCasterCand = { mesh: THREE.Mesh; distSq: number }
const _envCasterCands: EnvCasterCand[] = []

export type ShadowCastOwner = 'avatar' | 'environment'

/**
 * GltfContainer leaves without Material.castShadows — only cast on Ultra.
 * Lower tiers stay receive-only so plaza-scale maps do not tank FPS.
 * userData key: dclGltfDefaultCaster
 */
export type SetCastShadowOpts = {
  /** Scene GLB default path — cast only when effective shadow quality is ultra. */
  gltfDefaultCaster?: boolean
}

function envCastActiveForMesh(mesh: THREE.Object3D): boolean {
  if (!renderQuality.environmentCastShadowsActive()) return false
  if (mesh.userData.dclGltfDefaultCaster) {
    return renderQuality.getShadowQuality() === 'ultra'
  }
  return true
}

/**
 * Record author/runtime desired cast and apply the avatar vs environment gate.
 * Preferences toggles re-walk meshes that carry these userData keys.
 */
export function setMeshDesiredCastShadow(
  mesh: THREE.Object3D,
  desired: boolean,
  owner: ShadowCastOwner,
  opts?: SetCastShadowOpts
): void {
  mesh.userData.dclDesiredCastShadow = desired
  mesh.userData.dclShadowOwner = owner
  if (opts?.gltfDefaultCaster) {
    mesh.userData.dclGltfDefaultCaster = true
  } else if (opts?.gltfDefaultCaster === false) {
    delete mesh.userData.dclGltfDefaultCaster
  }
  if (!(mesh as THREE.Mesh).isMesh) return
  if (owner === 'avatar') {
    ;(mesh as THREE.Mesh).castShadow = desired && renderQuality.avatarCastShadowsActive()
  } else {
    ;(mesh as THREE.Mesh).castShadow = desired && envCastActiveForMesh(mesh)
  }
}

/** Re-apply cast from stored desired flags (Preferences / adaptive shadow quality). */
export function reapplySceneCastShadows(root: THREE.Object3D): void {
  const avOn = renderQuality.avatarCastShadowsActive()
  root.traverse((obj) => {
    if (!(obj as THREE.Mesh).isMesh) return
    const mesh = obj as THREE.Mesh
    const desired = mesh.userData.dclDesiredCastShadow
    if (typeof desired !== 'boolean') return
    const owner = mesh.userData.dclShadowOwner as ShadowCastOwner | undefined
    if (owner === 'avatar') {
      mesh.castShadow = desired && avOn
    } else if (owner === 'environment') {
      mesh.castShadow = desired && envCastActiveForMesh(mesh)
    }
  })
}

/**
 * Cap environment shadow casters to the nearest N inside Shadows Distance.
 * Does not walk or change `owner === 'avatar'` (local + remotes stay as they are).
 */
export function budgetEnvironmentCasters(root: THREE.Object3D, focusWorld: THREE.Vector3): void {
  if (!renderQuality.environmentCastShadowsActive()) return
  const q = renderQuality.getShadowQuality()
  if (q === 'off') return
  const cap = ENV_CASTER_CAP[q]
  const keep = envCasterKeepM()
  if (keep <= 0) {
    root.traverse((obj) => {
      if (!(obj as THREE.Mesh).isMesh) return
      const mesh = obj as THREE.Mesh
      if (mesh.userData.dclShadowOwner === 'environment') mesh.castShadow = false
    })
    return
  }
  const keepSq = keep * keep
  _envCasterCands.length = 0

  root.traverse((obj) => {
    if (!(obj as THREE.Mesh).isMesh) return
    const mesh = obj as THREE.Mesh
    if (mesh.userData.dclShadowOwner === 'avatar') return
    const desired = mesh.userData.dclDesiredCastShadow
    if (desired !== true || !envCastActiveForMesh(mesh)) {
      if (mesh.userData.dclShadowOwner === 'environment') mesh.castShadow = false
      return
    }
    const e = mesh.matrixWorld.elements
    const dx = e[12]! - focusWorld.x
    const dy = e[13]! - focusWorld.y
    const dz = e[14]! - focusWorld.z
    const distSq = dx * dx + dy * dy + dz * dz
    if (distSq > keepSq) {
      mesh.castShadow = false
      return
    }
    _envCasterCands.push({ mesh, distSq })
  })

  _envCasterCands.sort((a, b) => a.distSq - b.distSq)
  for (let i = 0; i < _envCasterCands.length; i++) {
    _envCasterCands[i]!.mesh.castShadow = i < cap
  }
}
