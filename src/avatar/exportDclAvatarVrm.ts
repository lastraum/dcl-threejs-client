/**
 * DCL → VRM 0.0 export (Three.js).
 *
 * Soft-transform path (matched mesh + bones, no IBM rebind):
 *  1. Compose avatar (no backpack idle mixer)
 *  2. Force bind/rest pose (Forge: stop anims → returnToRest / frame 0)
 *  3. Flatten DCL `Armature` (cm + 90° X) into children — world preserved ⇒ IBMs stay valid
 *  4. Face for VRM via root yaw only (rigid: mesh+bones share parent)
 *  5. Ground (root translate only)
 *  6. GLTFExporter (trs + embedImages) + inject VRM 0.0 humanoid + VRM_USE_GLTFSHADER
 *
 * Do NOT rewrite bone locals to identity or flip geometry + recalculateInverses —
 * that crosses arms and shreds fingers (v4.2). Soft rigid transforms only.
 */
import * as THREE from 'three'
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'
import { composeAvatarFromProfile } from './AvatarComposer'
import { disposeWearableInstance } from './loadWearable'
import { normalizeBoneName } from './emoteBoneMap'
import { syncParallelWearableSkeletons } from './loadWearable'
import type { AvatarProfile } from './types'
import { identityFromAvatarProfile } from './displayName'

export type ExportDclAvatarVrmOptions = {
  profile: AvatarProfile
  address: string
  fileName?: string
  displayName?: string
  download?: boolean
  /**
   * Root yaw after rest pose (radians).
   * Default Math.PI — DCL bind often faces opposite VRM +Z in external viewers.
   * Pass 0 to keep backpack-preview facing.
   */
  faceYaw?: number
}

/** VRM 0.0 humanoid bone → DCL bone name candidates. */
const HUMANOID_BONES: Record<string, string[]> = {
  hips: ['Avatar_Hips', 'Hips', 'hips'],
  spine: ['Avatar_Spine', 'Spine', 'spine'],
  chest: ['Avatar_Spine1', 'Spine1', 'chest'],
  upperChest: ['Avatar_Spine2', 'Spine2', 'upperChest', 'chest_end'],
  neck: ['Avatar_Neck', 'Neck', 'neck'],
  head: ['Avatar_Head', 'Head', 'head'],
  leftShoulder: ['Avatar_LeftShoulder', 'LeftShoulder', 'shoulder.L'],
  leftUpperArm: ['Avatar_LeftArm', 'LeftArm', 'upper_arm.L'],
  leftLowerArm: ['Avatar_LeftForeArm', 'LeftForeArm', 'lower_arm.L'],
  leftHand: ['Avatar_LeftHand', 'LeftHand', 'hand.L'],
  rightShoulder: ['Avatar_RightShoulder', 'RightShoulder', 'shoulder.R'],
  rightUpperArm: ['Avatar_RightArm', 'RightArm', 'upper_arm.R'],
  rightLowerArm: ['Avatar_RightForeArm', 'RightForeArm', 'lower_arm.R'],
  rightHand: ['Avatar_RightHand', 'RightHand', 'hand.R'],
  leftUpperLeg: ['Avatar_LeftUpLeg', 'LeftUpLeg', 'upper_leg.L'],
  leftLowerLeg: ['Avatar_LeftLeg', 'LeftLeg', 'lower_leg.L'],
  leftFoot: ['Avatar_LeftFoot', 'LeftFoot', 'foot.L'],
  leftToes: ['Avatar_LeftToeBase', 'LeftToeBase', 'toes.L'],
  rightUpperLeg: ['Avatar_RightUpLeg', 'RightUpLeg', 'upper_leg.R'],
  rightLowerLeg: ['Avatar_RightLeg', 'RightLeg', 'lower_leg.R'],
  rightFoot: ['Avatar_RightFoot', 'RightFoot', 'foot.R'],
  rightToes: ['Avatar_RightToeBase', 'RightToeBase', 'toes.R'],
  leftThumbProximal: ['Avatar_LeftHandThumb1', 'LeftHandThumb1', 'thumb.proximal.L'],
  leftThumbIntermediate: ['Avatar_LeftHandThumb2', 'LeftHandThumb2', 'thumb.intermediate.L'],
  leftThumbDistal: ['Avatar_LeftHandThumb3', 'LeftHandThumb3', 'Avatar_LeftHandThumb4', 'thumb.distal.L'],
  leftIndexProximal: ['Avatar_LeftHandIndex1', 'LeftHandIndex1', 'index.proximal.L'],
  leftIndexIntermediate: [
    'Avatar_LeftHandIndex2',
    'LeftHandIndex2',
    'Index.intermediate.L',
    'index.intermediate.L'
  ],
  leftIndexDistal: ['Avatar_LeftHandIndex3', 'LeftHandIndex3', 'Avatar_LeftHandIndex4', 'index.distal.L'],
  leftMiddleProximal: ['Avatar_LeftHandMiddle1', 'LeftHandMiddle1', 'middle.proximal.L'],
  leftMiddleIntermediate: ['Avatar_LeftHandMiddle2', 'LeftHandMiddle2', 'middle.intermediate.L'],
  leftMiddleDistal: ['Avatar_LeftHandMiddle3', 'LeftHandMiddle3', 'Avatar_LeftHandMiddle4', 'middle.distal.L'],
  leftRingProximal: ['Avatar_LeftHandRing1', 'LeftHandRing1', 'ring.proximal.L'],
  leftRingIntermediate: ['Avatar_LeftHandRing2', 'LeftHandRing2', 'ring.intermediate.L'],
  leftRingDistal: ['Avatar_LeftHandRing3', 'LeftHandRing3', 'Avatar_LeftHandRing4', 'ring.distal.L'],
  leftLittleProximal: ['Avatar_LeftHandPinky1', 'LeftHandPinky1', 'little.proximal.L'],
  leftLittleIntermediate: ['Avatar_LeftHandPinky2', 'LeftHandPinky2', 'little.intermediate.L'],
  leftLittleDistal: ['Avatar_LeftHandPinky3', 'LeftHandPinky3', 'Avatar_LeftHandPinky4', 'little.distal.L'],
  rightThumbProximal: ['Avatar_RightHandThumb1', 'RightHandThumb1', 'thumb.proximal.R'],
  rightThumbIntermediate: ['Avatar_RightHandThumb2', 'RightHandThumb2', 'thumb.intermediate.R'],
  rightThumbDistal: ['Avatar_RightHandThumb3', 'RightHandThumb3', 'Avatar_RightHandThumb4', 'thumb.distal.R'],
  rightIndexProximal: ['Avatar_RightHandIndex1', 'RightHandIndex1', 'index.proximal.R'],
  rightIndexIntermediate: ['Avatar_RightHandIndex2', 'RightHandIndex2', 'index.intermediate.R'],
  rightIndexDistal: ['Avatar_RightHandIndex3', 'RightHandIndex3', 'Avatar_RightHandIndex4', 'index.distal.R'],
  rightMiddleProximal: ['Avatar_RightHandMiddle1', 'RightHandMiddle1', 'middle.proximal.R'],
  rightMiddleIntermediate: ['Avatar_RightHandMiddle2', 'RightHandMiddle2', 'middle.intermediate.R'],
  rightMiddleDistal: [
    'Avatar_RightHandMiddle3',
    'RightHandMiddle3',
    'Avatar_RightHandMiddle4',
    'middle.distal.R'
  ],
  rightRingProximal: ['Avatar_RightHandRing1', 'RightHandRing1', 'ring.proximal.R'],
  rightRingIntermediate: ['Avatar_RightHandRing2', 'RightHandRing2', 'ring.intermediate.R'],
  rightRingDistal: ['Avatar_RightHandRing3', 'RightHandRing3', 'Avatar_RightHandRing4', 'ring.distal.R'],
  rightLittleProximal: ['Avatar_RightHandPinky1', 'RightHandPinky1', 'little.proximal.R'],
  rightLittleIntermediate: ['Avatar_RightHandPinky2', 'RightHandPinky2', 'little.intermediate.R'],
  rightLittleDistal: [
    'Avatar_RightHandPinky3',
    'RightHandPinky3',
    'Avatar_RightHandPinky4',
    'little.distal.R'
  ]
}

/** Default faceYaw: turn 180° so VRM viewers see the front (Forge X/Z flip intent, rigid). */
const DEFAULT_FACE_YAW = Math.PI

const _m = new THREE.Matrix4()
const _local = new THREE.Matrix4()
const _p = new THREE.Vector3()
const _q = new THREE.Quaternion()
const _s = new THREE.Vector3()

export async function exportDclAvatarToVrm(options: ExportDclAvatarVrmOptions): Promise<Blob> {
  const { profile, address, download = true } = options
  if (!profile) throw new Error('No avatar profile to export')

  const identity = identityFromAvatarProfile(profile, address)
  const title = options.displayName?.trim() || identity.displayName || 'DCL Avatar'
  const fileName =
    options.fileName?.trim() ||
    sanitizeFileName(`${title}-${formatDateStamp(new Date())}.vrm`)
  const faceYaw = options.faceYaw ?? DEFAULT_FACE_YAW

  let avatar: THREE.Group | null = null
  try {
    // --- 1. Compose (no AnimationMixer — pure bind geometry) ---
    avatar = await composeAvatarFromProfile({
      ...profile,
      address,
      fromWallet: true
    })

    try {
      syncParallelWearableSkeletons(avatar)
    } catch {
      /* optional */
    }

    // --- 2. Force bind / T-rest (Forge: stop anims → frame 0 / returnToRest) ---
    const skeletons = collectSkeletons(avatar)
    for (const sk of skeletons) forceBindRestPose(sk)
    avatar.updateMatrixWorld(true)

    // Settle + re-sync (Forge waits ~500ms; we re-apply rest once more).
    try {
      syncParallelWearableSkeletons(avatar)
    } catch {
      /* optional */
    }
    for (const sk of skeletons) forceBindRestPose(sk)
    avatar.updateMatrixWorld(true)

    // --- 3. Flatten Armature (cm + 90°X) into children — world preserved ---
    // Existing boneInverses stay valid. Do NOT calculateInverses().
    bakeArmatureParents(avatar)
    avatar.updateMatrixWorld(true)

    // --- 4. Materials ---
    prepareMaterialsForExport(avatar)

    // --- 5. Face yaw (whole avatar rigid) — mesh + bones share parent, IBM stays valid ---
    if (faceYaw !== 0) {
      avatar.rotation.y += faceYaw
      avatar.updateMatrixWorld(true)
    }

    // Ground: translate only (same rigid rule).
    const box = new THREE.Box3().setFromObject(avatar)
    if (!box.isEmpty()) {
      const c = box.getCenter(new THREE.Vector3())
      avatar.position.x -= c.x
      avatar.position.z -= c.z
      avatar.position.y -= box.min.y
      avatar.updateMatrixWorld(true)
    }

    const meshCount = countSkinnedMeshes(avatar)
    const hip = findBone(avatar, ['Avatar_Hips', 'Hips', 'hips'])
    if (hip) {
      hip.getWorldPosition(_p)
      console.info(
        `[vrm-export] v4.3 soft-rest meshes=${meshCount} skels=${skeletons.length} faceYaw=${faceYaw.toFixed(2)} hipsWorld=(${_p.x.toFixed(3)},${_p.y.toFixed(3)},${_p.z.toFixed(3)})`
      )
    } else {
      console.info(
        `[vrm-export] v4.3 soft-rest meshes=${meshCount} skels=${skeletons.length} faceYaw=${faceYaw.toFixed(2)}`
      )
    }

    // --- 6. Export matched DCL skeleton + meshes ---
    const glb = await exportRootToGlb(avatar)
    const vrmBuffer = injectVrm0Extension(glb, {
      title,
      author: address || 'unknown'
    })

    const embedded = countEmbeddedImages(vrmBuffer)
    console.info(
      `[vrm-export] images=${embedded.images} textures=${embedded.textures} mats=${embedded.materials} bytes=${vrmBuffer.byteLength}`
    )

    const blob = new Blob([vrmBuffer], { type: 'application/octet-stream' })
    if (download) {
      triggerDownload(blob, fileName.endsWith('.vrm') ? fileName : `${fileName}.vrm`)
    }
    return blob
  } finally {
    if (avatar) disposeWearableInstance(avatar)
  }
}

function collectSkeletons(root: THREE.Object3D): THREE.Skeleton[] {
  const seen = new Set<THREE.Skeleton>()
  const out: THREE.Skeleton[] = []
  root.traverse((obj) => {
    if (!(obj instanceof THREE.SkinnedMesh) || !obj.skeleton) return
    if (seen.has(obj.skeleton)) return
    seen.add(obj.skeleton)
    out.push(obj.skeleton)
  })
  return out
}

function countSkinnedMeshes(root: THREE.Object3D): number {
  let n = 0
  root.traverse((obj) => {
    if (obj instanceof THREE.SkinnedMesh && obj.visible) n++
  })
  return n
}

function findBone(root: THREE.Object3D, names: string[]): THREE.Bone | null {
  const want = new Set(names.map((n) => normalizeBoneName(n)))
  let found: THREE.Bone | null = null
  root.traverse((obj) => {
    if (found || !(obj as THREE.Bone).isBone) return
    if (want.has(normalizeBoneName(obj.name))) found = obj as THREE.Bone
  })
  return found
}

/**
 * Forge-equivalent of animation stop + returnToRest:
 * rebuild each bone's local TRS from boneInverses (bind pose), parent-first.
 * Does not change inverse bind matrices.
 */
function forceBindRestPose(skeleton: THREE.Skeleton): void {
  const bones = skeleton.bones
  if (!bones.length || skeleton.boneInverses.length !== bones.length) {
    try {
      skeleton.pose()
    } catch {
      /* ignore */
    }
    skeleton.update()
    return
  }

  const order = bones
    .map((bone, index) => ({ bone, index, depth: boneDepth(bone) }))
    .sort((a, b) => a.depth - b.depth)

  for (const { bone, index } of order) {
    const ibm = skeleton.boneInverses[index]!
    const bindWorld = ibm.clone().invert()
    const parent = bone.parent
    if (parent) {
      parent.updateMatrixWorld(true)
      _local.copy(parent.matrixWorld).invert().multiply(bindWorld)
      _local.decompose(bone.position, bone.quaternion, bone.scale)
    } else {
      bindWorld.decompose(bone.position, bone.quaternion, bone.scale)
    }
    if (bone.scale.x === 0 || bone.scale.y === 0 || bone.scale.z === 0) {
      bone.scale.set(1, 1, 1)
    }
    bone.matrixAutoUpdate = true
    bone.updateMatrix()
    bone.updateMatrixWorld(true)
  }
  skeleton.update()
}

function boneDepth(obj: THREE.Object3D): number {
  let d = 0
  let p: THREE.Object3D | null = obj.parent
  while (p) {
    d++
    p = p.parent
  }
  return d
}

/**
 * Bake non-identity Armature parents into children.
 * Preserves world transforms ⇒ existing boneInverses remain valid.
 */
function bakeArmatureParents(root: THREE.Object3D): void {
  for (let pass = 0; pass < 4; pass++) {
    const targets: THREE.Object3D[] = []
    root.traverse((obj) => {
      if (obj === root) return
      if ((obj as THREE.Bone).isBone) return
      const n = obj.name || ''
      if (n === 'Armature' || n.startsWith('Armature')) {
        obj.updateMatrix()
        if (!isIdentityMatrix(obj.matrix)) targets.push(obj)
      }
    })
    if (!targets.length) break

    targets.sort((a, b) => boneDepth(b) - boneDepth(a))

    for (const parent of targets) {
      parent.updateMatrix()
      if (isIdentityMatrix(parent.matrix)) continue
      for (const child of [...parent.children]) {
        child.updateMatrix()
        _m.multiplyMatrices(parent.matrix, child.matrix)
        _m.decompose(child.position, child.quaternion, child.scale)
        child.updateMatrix()
        child.updateMatrixWorld(true)
      }
      parent.position.set(0, 0, 0)
      parent.quaternion.identity()
      parent.scale.set(1, 1, 1)
      parent.updateMatrix()
      parent.updateMatrixWorld(true)
    }
    root.updateMatrixWorld(true)
  }
}

function isIdentityMatrix(m: THREE.Matrix4): boolean {
  const e = m.elements
  const id = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
  for (let i = 0; i < 16; i++) {
    if (Math.abs(e[i]! - id[i]!) > 1e-5) return false
  }
  return true
}

function prepareMaterialsForExport(root: THREE.Object3D): void {
  root.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material]
    const next = mats.map((m) => toExportMaterial(m))
    obj.material = Array.isArray(obj.material) ? next : next[0]!
    obj.frustumCulled = false
    obj.matrixAutoUpdate = true
  })
}

function toExportMaterial(mat: THREE.Material | null | undefined): THREE.Material {
  if (!mat) {
    return new THREE.MeshStandardMaterial({
      color: 0xcccccc,
      metalness: 0,
      roughness: 0.9,
      side: THREE.DoubleSide
    })
  }
  if ((mat as THREE.MeshStandardMaterial).isMeshStandardMaterial) {
    const src = mat as THREE.MeshStandardMaterial
    const out = new THREE.MeshStandardMaterial()
    out.name = src.name || 'material'
    out.color.copy(src.color)
    out.map = src.map
    out.normalMap = src.normalMap
    out.emissive.copy(src.emissive)
    out.emissiveMap = src.emissiveMap
    out.emissiveIntensity = Math.min(Math.max(src.emissiveIntensity || 1, 0), 8)
    out.metalness = typeof src.metalness === 'number' ? src.metalness : 0
    out.roughness = Math.max(typeof src.roughness === 'number' ? src.roughness : 0.9, 0.4)
    out.transparent = src.transparent
    out.opacity = src.opacity
    out.alphaTest = src.alphaTest
    out.side = THREE.DoubleSide
    out.alphaMap = src.alphaMap
    out.aoMap = src.aoMap
    out.roughnessMap = src.roughnessMap
    out.metalnessMap = src.metalnessMap
    if (out.map) {
      out.map.colorSpace = THREE.SRGBColorSpace
      out.map.needsUpdate = true
    }
    out.onBeforeCompile = () => {}
    out.needsUpdate = true
    return out
  }
  if ((mat as THREE.MeshBasicMaterial).isMeshBasicMaterial) {
    const src = mat as THREE.MeshBasicMaterial
    const out = new THREE.MeshStandardMaterial()
    out.name = src.name || 'material'
    out.color.copy(src.color)
    out.map = src.map
    out.transparent = src.transparent
    out.opacity = src.opacity
    out.side = THREE.DoubleSide
    out.metalness = 0
    out.roughness = 0.9
    if (out.map) {
      out.map.colorSpace = THREE.SRGBColorSpace
      out.map.needsUpdate = true
    }
    return out
  }
  return new THREE.MeshStandardMaterial({
    name: mat.name || 'material',
    color: 0xcccccc,
    metalness: 0,
    roughness: 0.9,
    side: THREE.DoubleSide
  })
}

async function exportRootToGlb(root: THREE.Object3D): Promise<ArrayBuffer> {
  root.updateMatrixWorld(true)
  root.traverse((obj) => {
    obj.matrixAutoUpdate = true
    obj.updateMatrix()
  })
  root.updateMatrixWorld(true)

  const exporter = new GLTFExporter()
  return new Promise((resolve, reject) => {
    exporter.parse(
      root,
      (result) => {
        if (result instanceof ArrayBuffer) resolve(result)
        else reject(new Error('GLTFExporter returned JSON — expected binary'))
      },
      (err) => reject(err instanceof Error ? err : new Error(String(err))),
      {
        binary: true,
        onlyVisible: true,
        embedImages: true,
        trs: true,
        maxTextureSize: 2048,
        animations: []
      }
    )
  })
}

type VrmMetaInput = { title: string; author: string }
type GltfNode = {
  name?: string
  children?: number[]
  translation?: number[]
  rotation?: number[]
  scale?: number[]
  matrix?: number[]
  mesh?: number
  skin?: number
}

function injectVrm0Extension(glb: ArrayBuffer, meta: VrmMetaInput): ArrayBuffer {
  const { json, binary } = parseGlb(glb)
  const nodes: GltfNode[] = Array.isArray(json.nodes) ? (json.nodes as GltfNode[]) : []

  for (const node of nodes) {
    if (node.matrix && (node.translation || node.rotation || node.scale)) {
      delete node.matrix
    } else if (node.matrix) {
      decomposeMatrixToTrs(node)
    }
  }

  const byNorm = new Map<string, number>()
  for (let i = 0; i < nodes.length; i++) {
    const name = nodes[i]?.name
    if (!name) continue
    const n = normalizeBoneName(name)
    byNorm.set(n, i)
    byNorm.set(n.replace(/^Avatar_/, ''), i)
    byNorm.set(name, i)
  }

  const humanBones: Array<{ bone: string; node: number; useDefaultValues: boolean }> = []
  for (const [vrmBone, candidates] of Object.entries(HUMANOID_BONES)) {
    let idx = -1
    for (const c of candidates) {
      const hit =
        byNorm.get(c) ??
        byNorm.get(normalizeBoneName(c)) ??
        byNorm.get(normalizeBoneName(c).replace(/^Avatar_/, ''))
      if (hit !== undefined) {
        idx = hit
        break
      }
    }
    if (idx >= 0) humanBones.push({ bone: vrmBone, node: idx, useDefaultValues: true })
  }

  if (!humanBones.some((b) => b.bone === 'hips')) {
    throw new Error('Export failed: hips bone not found for VRM humanoid')
  }

  const hips = humanBones.find((b) => b.bone === 'hips')!
  console.info(
    `[vrm-export] hips node=${hips.node} name=${nodes[hips.node]?.name} t=${JSON.stringify(nodes[hips.node]?.translation)} r=${JSON.stringify(nodes[hips.node]?.rotation)}`
  )

  const materials: unknown[] = Array.isArray(json.materials) ? json.materials : []
  for (const m of materials) (m as Record<string, unknown>).doubleSided = true

  const materialProperties = materials.map((material, index) => {
    const m = material as { name?: string }
    const materialName = m.name || `material_${index}`
    const n = materialName.toLowerCase()
    const renderQueue = n.includes('eye') ? 2000 : n.includes('hair') ? 2151 : 2450
    return {
      name: materialName,
      shader: 'VRM_USE_GLTFSHADER',
      renderQueue,
      floatProperties: {},
      vectorProperties: {},
      textureProperties: {},
      keywordMap: {},
      tagMap: {}
    }
  })

  const used: string[] = Array.isArray(json.extensionsUsed) ? [...json.extensionsUsed] : []
  if (!used.includes('VRM')) used.push('VRM')
  json.extensionsUsed = used
  json.extensionsRequired = (
    Array.isArray(json.extensionsRequired) ? json.extensionsRequired : []
  ).filter((e: string) => e !== 'VRM')

  const extensions =
    json.extensions && typeof json.extensions === 'object'
      ? (json.extensions as Record<string, unknown>)
      : {}

  extensions.VRM = {
    exporterVersion: 'ThreejsClient VRM Exporter 4.3',
    specVersion: '0.0',
    meta: {
      title: meta.title.slice(0, 64),
      version: '1.0',
      author: meta.author.slice(0, 64),
      contactInformation: '',
      reference: 'https://decentraland.org',
      texture: -1,
      allowedUserName: 'OnlyAuthor',
      violentUssageName: 'Disallow',
      sexualUssageName: 'Disallow',
      commercialUssageName: 'Disallow',
      otherPermissionUrl: '',
      licenseName: 'Redistribution_Prohibited',
      otherLicenseUrl: ''
    },
    humanoid: {
      humanBones,
      armStretch: 0.05,
      legStretch: 0.05,
      upperArmTwist: 0.5,
      lowerArmTwist: 0.5,
      upperLegTwist: 0.5,
      lowerLegTwist: 0.5,
      feetSpacing: 0,
      hasTranslationDoF: false
    },
    firstPerson: {
      firstPersonBone: humanBones.find((b) => b.bone === 'head')?.node ?? hips.node,
      firstPersonBoneOffset: { x: 0, y: 0.06, z: 0 },
      meshAnnotations: [],
      lookAtTypeName: 'Bone',
      lookAtHorizontalInner: { curve: [0, 0, 0, 1, 1, 1, 1, 0], xRange: 90, yRange: 10 },
      lookAtHorizontalOuter: { curve: [0, 0, 0, 1, 1, 1, 1, 0], xRange: 90, yRange: 10 },
      lookAtVerticalDown: { curve: [0, 0, 0, 1, 1, 1, 1, 0], xRange: 90, yRange: 10 },
      lookAtVerticalUp: { curve: [0, 0, 0, 1, 1, 1, 1, 0], xRange: 90, yRange: 10 }
    },
    blendShapeMaster: { blendShapeGroups: [] },
    secondaryAnimation: { boneGroups: [], colliderGroups: [] },
    materialProperties
  }
  json.extensions = extensions

  if (json.asset && typeof json.asset === 'object') {
    ;(json.asset as Record<string, string>).generator = 'ThreejsClient VRM Exporter 4.3'
  }
  if (Array.isArray(json.buffers) && json.buffers[0] && typeof json.buffers[0] === 'object') {
    ;(json.buffers[0] as { byteLength: number }).byteLength = binary.byteLength
  }

  return createGlb(json, binary)
}

function decomposeMatrixToTrs(node: GltfNode): void {
  if (!node.matrix || node.matrix.length !== 16) return
  _m.fromArray(node.matrix)
  _m.decompose(_p, _q, _s)
  delete node.matrix
  if (_p.lengthSq() > 1e-12) node.translation = _p.toArray()
  if (
    Math.abs(_q.x) > 1e-6 ||
    Math.abs(_q.y) > 1e-6 ||
    Math.abs(_q.z) > 1e-6 ||
    Math.abs(Math.abs(_q.w) - 1) > 1e-6
  ) {
    node.rotation = _q.toArray()
  }
  if (Math.abs(_s.x - 1) > 1e-6 || Math.abs(_s.y - 1) > 1e-6 || Math.abs(_s.z - 1) > 1e-6) {
    node.scale = _s.toArray()
  }
}

function parseGlb(buffer: ArrayBuffer): { json: Record<string, unknown>; binary: ArrayBuffer } {
  if (buffer.byteLength < 20) throw new Error('Invalid GLB')
  const view = new DataView(buffer)
  if (view.getUint32(0, true) !== 0x46546c67) throw new Error('Invalid GLB magic')
  let offset = 12
  const jsonChunkLength = view.getUint32(offset, true)
  offset += 4
  if (view.getUint32(offset, true) !== 0x4e4f534a) throw new Error('Expected JSON chunk')
  offset += 4
  const jsonBytes = new Uint8Array(buffer, offset, jsonChunkLength)
  let jsonEnd = jsonBytes.length
  while (jsonEnd > 0 && jsonBytes[jsonEnd - 1] === 0x20) jsonEnd--
  const json = JSON.parse(new TextDecoder().decode(jsonBytes.subarray(0, jsonEnd))) as Record<
    string,
    unknown
  >
  offset += jsonChunkLength
  let binary = new ArrayBuffer(0)
  if (offset + 8 <= buffer.byteLength) {
    const binLen = view.getUint32(offset, true)
    offset += 4
    if (view.getUint32(offset, true) !== 0x004e4942) throw new Error('Expected BIN chunk')
    offset += 4
    binary = buffer.slice(offset, offset + binLen)
  }
  return { json, binary }
}

function createGlb(json: Record<string, unknown>, binary: ArrayBuffer): ArrayBuffer {
  const jsonData = new TextEncoder().encode(JSON.stringify(json))
  const jsonPadding = (4 - (jsonData.byteLength % 4)) % 4
  const jsonChunkLength = jsonData.byteLength + jsonPadding
  const binPadding = (4 - (binary.byteLength % 4)) % 4
  const binChunkLength = binary.byteLength + binPadding
  const total = 12 + 8 + jsonChunkLength + 8 + binChunkLength
  const out = new ArrayBuffer(total)
  const view = new DataView(out)
  const bytes = new Uint8Array(out)
  let o = 0
  view.setUint32(o, 0x46546c67, true)
  o += 4
  view.setUint32(o, 2, true)
  o += 4
  view.setUint32(o, total, true)
  o += 4
  view.setUint32(o, jsonChunkLength, true)
  o += 4
  view.setUint32(o, 0x4e4f534a, true)
  o += 4
  bytes.set(jsonData, o)
  o += jsonData.byteLength
  for (let i = 0; i < jsonPadding; i++) bytes[o++] = 0x20
  view.setUint32(o, binChunkLength, true)
  o += 4
  view.setUint32(o, 0x004e4942, true)
  o += 4
  bytes.set(new Uint8Array(binary), o)
  o += binary.byteLength
  for (let i = 0; i < binPadding; i++) bytes[o++] = 0x00
  return out
}

function countEmbeddedImages(glb: ArrayBuffer): {
  images: number
  textures: number
  materials: number
} {
  try {
    const { json } = parseGlb(glb)
    return {
      images: Array.isArray(json.images) ? json.images.length : 0,
      textures: Array.isArray(json.textures) ? json.textures.length : 0,
      materials: Array.isArray(json.materials) ? json.materials.length : 0
    }
  } catch {
    return { images: 0, textures: 0, materials: 0 }
  }
}

function triggerDownload(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000)
}

function sanitizeFileName(name: string): string {
  return (
    name
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '') || 'avatar.vrm'
  )
}

function formatDateStamp(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}
