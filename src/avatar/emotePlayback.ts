import * as THREE from 'three'
import { clone as cloneSkinnedRoot } from 'three/examples/jsm/utils/SkeletonUtils.js'
import type { CachedGltf } from '../rendering/AssetCache'
import { repairSkinnedMesh, stabilizeSkinnedMeshes } from '../rendering/skinnedMeshInstance'
import { normalizeBoneName, resolveBoneName, buildBoneNameSet, isEmoteMechanismBone } from './emoteBoneMap'

/** Wearable-preview: player gets retargeted avatar tracks; emote GLB keeps original skeleton + props. */
export type SplitEmoteClips = {
  avatarClip: THREE.AnimationClip | null
  /** Prop / particle armature tracks only — drives propMixer. */
  propClip: THREE.AnimationClip | null
  emoteSceneClip: THREE.AnimationClip | null
  propTrackTargets: Set<string>
}

function isPropClip(clipName: string): boolean {
  const lower = clipName.toLowerCase()
  return lower.includes('_prop') || lower.endsWith('prop')
}

function isPropBone(targetName: string): boolean {
  return targetName.startsWith('bone_') || /^Armature_Prop/i.test(targetName)
}

function isAvatarTrack(targetName: string, clipCount: number, clipName: string): boolean {
  if (isPropClip(clipName) || isPropBone(targetName)) return false
  return (
    targetName.startsWith('Avatar_') ||
    targetName.startsWith('CTRL_Avatar_') ||
    targetName.startsWith('CTRL_FK_Avatar_') ||
    targetName.startsWith('CTRL_IK_') ||
    clipName.toLowerCase().includes('avatar') ||
    (clipCount === 1 && targetName === 'Armature')
  )
}

/** Embedded avatar preview skeleton in emote GLB (duplicate body + colliders) — not prop armatures. */
function isAvatarPreviewRoot(name: string): boolean {
  return /^Armature(\.\d+)?$/i.test(normalizeBoneName(name))
}

function isEmotePropMesh(name: string): boolean {
  const n = normalizeBoneName(name)
  if (/collider/i.test(n)) return false
  if (n.startsWith('particle_')) return true
  if (/_prop/i.test(n) || n.endsWith('Prop')) return true
  return false
}

/**
 * Clone prop armature scene roots only — skip the embedded Avatar preview `Armature` subtree
 * (body duplicates + `_collider` meshes). Falls back to full clone when props live elsewhere.
 *
 * Uses SkeletonUtils.clone so skinned particle props rebind to cloned bones. Object3D.clone(true)
 * keeps the cached skeleton reference — propMixer animates clones while meshes skin to off-scene bones.
 */
export function cloneEmotePropRoots(gltfRoot: THREE.Object3D): THREE.Group {
  const propRoot = new THREE.Group()
  propRoot.name = 'emote-props'

  for (const child of gltfRoot.children) {
    if (isAvatarPreviewRoot(child.name)) continue
    propRoot.add(cloneSkinnedRoot(child))
  }

  if (propRoot.children.length === 0) {
    const fallback = cloneSkinnedRoot(gltfRoot) as THREE.Group
    fallback.name = 'emote-props'
    stabilizeSkinnedMeshes(fallback)
    return fallback
  }
  stabilizeSkinnedMeshes(propRoot)
  return propRoot
}

/** Parent rigid particle_* meshes to matching bone_* (skip skinned particles — already rigged). */
export function bindEmoteParticleMeshes(propRoot: THREE.Object3D): void {
  propRoot.traverse((obj) => {
    if (!/^Armature_Prop/i.test(obj.name)) return

    const bones = new Map<string, THREE.Object3D>()
    const particles: THREE.Object3D[] = []

    for (const child of obj.children) {
      if (child.name.startsWith('bone_')) bones.set(child.name, child)
      else if (child.name.startsWith('particle_')) particles.push(child)
    }

    for (const particle of particles) {
      if (particle instanceof THREE.SkinnedMesh) continue
      const bone = bones.get(particle.name.replace('particle_', 'bone_'))
      if (bone) bone.attach(particle)
    }
  })
}

/** Hide duplicate body shell + `_collider` meshes; keep prop geometry visible and culled safely. */
const EMOTE_BODY_MESH = /^male$|^female$|bodyshape|basebody|avatar_body|_body_/i

export function prepareEmotePropRoot(propRoot: THREE.Object3D, propTrackTargets: Set<string>): void {
  propRoot.traverse((obj) => {
    if (/collider/i.test(obj.name)) {
      obj.visible = false
      return
    }

    if (obj instanceof THREE.SkinnedMesh) {
      obj.visible = true
      repairSkinnedMesh(obj)
      obj.skeleton?.update()
      return
    }

    if (!(obj instanceof THREE.Mesh)) return

    obj.frustumCulled = false
    const name = normalizeBoneName(obj.name)
    if (propTrackTargets.has(name) || isEmotePropMesh(obj.name)) {
      obj.visible = true
      return
    }

    if (EMOTE_BODY_MESH.test(obj.name)) {
      obj.visible = false
      return
    }

    // Static sit anchors / collision proxies (e.g. sittingChair2 "Cube") — hide unless animated prop.
    obj.visible = false
  })
}

/** @deprecated Use prepareEmotePropRoot */
export function hideEmoteBodyDuplicates(emoteRoot: THREE.Object3D, propTrackTargets: Set<string>): void {
  prepareEmotePropRoot(emoteRoot, propTrackTargets)
}

export function emoteNeedsPropScene(gltf: CachedGltf, propTrackTargets: Set<string>): boolean {
  if (propTrackTargets.size > 0) return true
  let found = false
  gltf.root.traverse((obj) => {
    if (found || !(obj instanceof THREE.Mesh)) return
    if (/collider/i.test(obj.name)) return
    if (obj instanceof THREE.SkinnedMesh && EMOTE_BODY_MESH.test(obj.name)) return
    if (obj.name.startsWith('Avatar_')) return
    if (isEmotePropMesh(obj.name)) found = true
  })
  return found
}

export function splitEmoteClips(gltf: CachedGltf, avatarRoot: THREE.Object3D): SplitEmoteClips {
  const avatarBones = buildBoneNameSet(avatarRoot)
  const emoteBones = buildBoneNameSet(gltf.root)
  const clipCount = gltf.animations.length
  const avatarTracks: THREE.KeyframeTrack[] = []
  const emoteSkeletonTracks: THREE.KeyframeTrack[] = []
  const propTracks: THREE.KeyframeTrack[] = []
  const propTrackTargets = new Set<string>()
  let duration = 0

  for (const clip of gltf.animations) {
    duration = Math.max(duration, clip.duration)
    for (const track of clip.tracks) {
      const dot = track.name.indexOf('.')
      if (dot <= 0) continue
      const targetName = normalizeBoneName(track.name.slice(0, dot))
      const property = track.name.slice(dot + 1)
      if (isEmoteMechanismBone(targetName)) continue

      const looksLikeAvatar =
        targetName.startsWith('Avatar_') ||
        targetName.startsWith('CTRL_Avatar_') ||
        targetName.startsWith('CTRL_FK_Avatar_') ||
        targetName.startsWith('CTRL_IK_')

      if (isAvatarTrack(targetName, clipCount, clip.name)) {
        const boneName = resolveBoneName(targetName, avatarBones)
        if (boneName) {
          const cloned = track.clone()
          cloned.name = `${boneName}.${property}`
          avatarTracks.push(cloned)
        }
        if (emoteBones.has(targetName)) {
          emoteSkeletonTracks.push(track.clone())
        }
      } else if (looksLikeAvatar && !isPropBone(targetName)) {
        // Avatar bone tracks inside prop-named clips: route to avatar (and emote scene)
        // but NOT to propTracks — propRoot doesn't have these bones.
        const boneName = resolveBoneName(targetName, avatarBones)
        if (boneName) {
          const cloned = track.clone()
          cloned.name = `${boneName}.${property}`
          avatarTracks.push(cloned)
        }
        if (emoteBones.has(targetName)) {
          emoteSkeletonTracks.push(track.clone())
        }
      } else if (emoteBones.has(targetName)) {
        propTrackTargets.add(targetName)
        propTracks.push(track.clone())
      }
    }
  }

  const emoteSceneTracks = [...emoteSkeletonTracks, ...propTracks]

  return {
    avatarClip: avatarTracks.length
      ? new THREE.AnimationClip('emote-avatar', duration, avatarTracks)
      : null,
    propClip: propTracks.length ? new THREE.AnimationClip('emote-props', duration, propTracks) : null,
    emoteSceneClip: emoteSceneTracks.length
      ? new THREE.AnimationClip('emote-scene', duration, emoteSceneTracks)
      : null,
    propTrackTargets
  }
}
