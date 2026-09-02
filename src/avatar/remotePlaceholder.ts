import * as THREE from 'three'
import { clone as cloneSkinnedRoot } from 'three/examples/jsm/utils/SkeletonUtils.js'
import { createGltfLoader, sanitizeWearableRoot } from './loadWearable'
import { normalizeWearableWorldScale } from './wearableSanitize'
import { remapClipToAvatar } from './emoteBoneMap'
import { measureAvatarStance } from './feetAlign'
import { DRAW_LAYER_AVATAR, setLayer } from '../rendering/drawLayers'

/**
 * Shared GPU resources for remote loading stand-ins.
 * Skinned BaseMale + idle clip + neon material. Each peer clones the rig and
 * runs its own AnimationMixer so loading shells idle while wearables compose.
 */

const BASE_MALE_GLB = '/avatar/wearables/BaseMale/BaseMale.glb'
const IDLE_GLB = '/avatar/emotes/idle.glb'

/** Cool electric violet neon shell while Catalyst wearables load. */
const NEON_COLOR = 0x7b2fff
const NEON_EMISSIVE = 0xb24dff

/** Target human height for the neon loading shell (meters). */
const PLACEHOLDER_HEIGHT_M = 1.78

type PlaceholderTemplate = {
  root: THREE.Object3D
  idleClip: THREE.AnimationClip
}

let sharedNeonMat: THREE.MeshStandardMaterial | null = null
let templatePromise: Promise<PlaceholderTemplate | null> | null = null
let sharedTemplate: PlaceholderTemplate | null = null
let pulseRaf = 0
let pulseStartMs = 0

/** Live placeholder mixers — advanced from RemoteAvatarManager each frame. */
const liveMixers = new Set<THREE.AnimationMixer>()

function getSharedNeonMaterial(): THREE.MeshStandardMaterial {
  if (!sharedNeonMat) {
    // three r175+: skinned meshes auto-bind materials (no skinning flag).
    sharedNeonMat = new THREE.MeshStandardMaterial({
      color: NEON_COLOR,
      emissive: NEON_EMISSIVE,
      emissiveIntensity: 1.6,
      metalness: 0.55,
      roughness: 0.22,
      transparent: true,
      opacity: 0.78,
      depthWrite: false,
      side: THREE.FrontSide
    })
    startNeonPulse()
  }
  return sharedNeonMat
}

/** Soft breathing glow so the loading shell reads as "in progress". */
function startNeonPulse(): void {
  if (pulseRaf) return
  pulseStartMs = performance.now()
  const tick = (now: number) => {
    pulseRaf = requestAnimationFrame(tick)
    if (!sharedNeonMat) return
    const t = (now - pulseStartMs) / 1000
    const wave = 0.5 + 0.5 * Math.sin(t * 2.2)
    sharedNeonMat.emissiveIntensity = 0.95 + wave * 1.15
    sharedNeonMat.opacity = 0.62 + wave * 0.22
  }
  pulseRaf = requestAnimationFrame(tick)
}

function applyNeonMaterials(root: THREE.Object3D): void {
  const mat = getSharedNeonMaterial()
  root.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return
    obj.material = mat
    obj.castShadow = false
    obj.receiveShadow = false
    obj.frustumCulled = true
    obj.userData.sharedGpu = true
  })
}

function plantFeetAndFitHeight(root: THREE.Object3D): void {
  root.updateWorldMatrix(true, true)
  const stance = measureAvatarStance(root)
  if (stance) {
    root.position.set(-stance.centerX, -stance.feetY, -stance.centerZ)
  }
  root.updateWorldMatrix(true, true)
  const box = new THREE.Box3().setFromObject(root)
  if (box.isEmpty()) return
  const height = box.max.y - box.min.y
  if (height > 0.01 && Math.abs(height - PLACEHOLDER_HEIGHT_M) / PLACEHOLDER_HEIGHT_M > 0.05) {
    const s = PLACEHOLDER_HEIGHT_M / height
    root.scale.multiplyScalar(s)
    // Re-plant after scale
    root.position.set(0, 0, 0)
    root.updateWorldMatrix(true, true)
    const stance2 = measureAvatarStance(root)
    if (stance2) {
      root.position.set(-stance2.centerX, -stance2.feetY, -stance2.centerZ)
    }
  }
}

async function ensureSharedTemplate(): Promise<PlaceholderTemplate | null> {
  if (sharedTemplate) return sharedTemplate
  if (templatePromise) return templatePromise

  templatePromise = (async () => {
    try {
      const loader = createGltfLoader({})
      const [bodyGltf, idleGltf] = await Promise.all([
        loader.loadAsync(BASE_MALE_GLB),
        loader.loadAsync(IDLE_GLB)
      ])
      const avatarRoot = bodyGltf.scene
      avatarRoot.name = 'remote-placeholder-basemale-source'
      sanitizeWearableRoot(avatarRoot)
      normalizeWearableWorldScale(avatarRoot, 'body_shape')
      applyNeonMaterials(avatarRoot)
      plantFeetAndFitHeight(avatarRoot)

      const rawIdle = idleGltf.animations[0]
      if (!rawIdle) {
        console.warn('[avatar] idle.glb has no clips — neon shell stays bind pose')
      }
      const remapped = rawIdle ? remapClipToAvatar(rawIdle, avatarRoot) : null
      // Prefer remapped; fall back to first clip on the body GLB if any.
      const idleClip =
        remapped ??
        bodyGltf.animations[0] ??
        rawIdle ??
        new THREE.AnimationClip('idle-empty', 1, [])

      sharedTemplate = { root: avatarRoot, idleClip }
      return sharedTemplate
    } catch (err) {
      console.warn('[avatar] failed to load BaseMale/idle loading placeholder', err)
      return null
    }
  })()

  return templatePromise
}

function fillPlaceholderBody(root: THREE.Group, template: PlaceholderTemplate): void {
  if (root.userData.disposed) return
  if (root.children.length > 0) return

  const body = cloneSkinnedRoot(template.root) as THREE.Object3D
  body.name = 'remote-placeholder-body'
  // Clones share materials (neon) — good. Re-apply feet offset on the clone root.
  body.position.copy(template.root.position)
  body.scale.copy(template.root.scale)

  root.add(body)
  setLayer(root, DRAW_LAYER_AVATAR)

  if (template.idleClip.tracks.length > 0) {
    const mixer = new THREE.AnimationMixer(body)
    const action = mixer.clipAction(template.idleClip)
    action.enabled = true
    action.setEffectiveWeight(1)
    action.setLoop(THREE.LoopRepeat, Infinity)
    action.play()
    root.userData.placeholderMixer = mixer
    liveMixers.add(mixer)
  }
}

/**
 * Advance all live neon-placeholder idle mixers (call once per RemoteAvatarManager tick).
 */
export function updateRemoteAvatarPlaceholders(dt: number): void {
  if (liveMixers.size === 0 || !(dt > 0)) return
  const safe = Math.min(dt, 0.1)
  for (const mixer of liveMixers) {
    mixer.update(safe)
  }
}

/**
 * Lightweight neon BaseMale stand-in with idle loop while Catalyst / custom compose runs.
 * Returns immediately; mesh+mixer attach when the shared template finishes loading.
 */
export function createRemoteAvatarPlaceholder(_showPill = true): THREE.Group {
  const root = new THREE.Group()
  root.name = 'remote-placeholder'
  root.userData.remotePlaceholder = true
  root.userData.disposed = false

  if (sharedTemplate) {
    fillPlaceholderBody(root, sharedTemplate)
  } else {
    void ensureSharedTemplate().then((tmpl) => {
      if (!tmpl || root.userData.disposed) return
      fillPlaceholderBody(root, tmpl)
    })
  }

  setLayer(root, DRAW_LAYER_AVATAR)
  return root
}

/**
 * Detach a placeholder without disposing shared template / neon material.
 */
export function disposeRemoteAvatarPlaceholder(root: THREE.Object3D): void {
  root.userData.disposed = true
  const mixer = root.userData.placeholderMixer as THREE.AnimationMixer | undefined
  if (mixer) {
    mixer.stopAllAction()
    liveMixers.delete(mixer)
    root.userData.placeholderMixer = null
  }
  root.removeFromParent()
  while (root.children.length > 0) {
    root.remove(root.children[0]!)
  }
}
