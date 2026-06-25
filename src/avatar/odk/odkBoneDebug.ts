import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { normalizeMixamoBoneName, resolveOdkBoneName } from './odkBoneMap'
import { collectBoneNames, getOdkBone, ODK_REQUIRED_BONES } from './odkSkeleton'
import { measureOdkFeetY } from './odkFeetAlign'
import { getOdkRetargetProfile } from './odkRetargetProfile'

/** Mixamo clip bone → VRM humanoid key (same set as mixamoRetarget.ts TO_VRM locomotion bones). */
const MIXAMO_TO_VRM: Record<string, string> = {
  Hips: 'hips',
  Spine: 'spine',
  Spine1: 'chest',
  Spine2: 'upperChest',
  Neck: 'neck',
  Head: 'head',
  LeftShoulder: 'leftShoulder',
  LeftArm: 'leftUpperArm',
  LeftForeArm: 'leftLowerArm',
  LeftHand: 'leftHand',
  RightShoulder: 'rightShoulder',
  RightArm: 'rightUpperArm',
  RightForeArm: 'rightLowerArm',
  RightHand: 'rightHand',
  LeftUpLeg: 'leftUpperLeg',
  LeftLeg: 'leftLowerLeg',
  LeftFoot: 'leftFoot',
  LeftToeBase: 'leftToes',
  RightUpLeg: 'rightUpperLeg',
  RightLeg: 'rightLowerLeg',
  RightFoot: 'rightFoot',
  RightToeBase: 'rightToes'
}

/** Mixamo → VRM → ODK → DCL BaseMale (locomotion humanoid chain). */
const HUMANOID_CHAIN: Array<{
  mixamo: string
  vrm: string
  odk: string
  baseMale: string
}> = [
  { mixamo: 'Hips', vrm: 'hips', odk: 'pelvis', baseMale: 'Avatar_Hips' },
  { mixamo: 'Spine', vrm: 'spine', odk: 'spine_01', baseMale: 'Avatar_Spine' },
  { mixamo: 'Spine1', vrm: 'chest', odk: 'spine_02', baseMale: 'Avatar_Spine1' },
  { mixamo: 'Spine2', vrm: 'upperChest', odk: 'spine_03', baseMale: 'Avatar_Spine2' },
  { mixamo: 'Neck', vrm: 'neck', odk: 'neck_01', baseMale: 'Avatar_Neck' },
  { mixamo: 'Head', vrm: 'head', odk: 'head', baseMale: 'Avatar_Head' },
  { mixamo: 'LeftShoulder', vrm: 'leftShoulder', odk: 'clavicle_l', baseMale: 'Avatar_LeftShoulder' },
  { mixamo: 'LeftArm', vrm: 'leftUpperArm', odk: 'upperarm_l', baseMale: 'Avatar_LeftArm' },
  { mixamo: 'LeftForeArm', vrm: 'leftLowerArm', odk: 'lowerarm_l', baseMale: 'Avatar_LeftForeArm' },
  { mixamo: 'LeftHand', vrm: 'leftHand', odk: 'hand_l', baseMale: 'Avatar_LeftHand' },
  { mixamo: 'RightShoulder', vrm: 'rightShoulder', odk: 'clavicle_r', baseMale: 'Avatar_RightShoulder' },
  { mixamo: 'RightArm', vrm: 'rightUpperArm', odk: 'upperarm_r', baseMale: 'Avatar_RightArm' },
  { mixamo: 'RightForeArm', vrm: 'rightLowerArm', odk: 'lowerarm_r', baseMale: 'Avatar_RightForeArm' },
  { mixamo: 'RightHand', vrm: 'rightHand', odk: 'hand_r', baseMale: 'Avatar_RightHand' },
  { mixamo: 'LeftUpLeg', vrm: 'leftUpperLeg', odk: 'thigh_l', baseMale: 'Avatar_LeftUpLeg' },
  { mixamo: 'LeftLeg', vrm: 'leftLowerLeg', odk: 'calf_l', baseMale: 'Avatar_LeftLeg' },
  { mixamo: 'LeftFoot', vrm: 'leftFoot', odk: 'foot_l', baseMale: 'Avatar_LeftFoot' },
  { mixamo: 'LeftToeBase', vrm: 'leftToes', odk: 'ball_l', baseMale: 'Avatar_LeftToeBase' },
  { mixamo: 'RightUpLeg', vrm: 'rightUpperLeg', odk: 'thigh_r', baseMale: 'Avatar_RightUpLeg' },
  { mixamo: 'RightLeg', vrm: 'rightLowerLeg', odk: 'calf_r', baseMale: 'Avatar_RightLeg' },
  { mixamo: 'RightFoot', vrm: 'rightFoot', odk: 'foot_r', baseMale: 'Avatar_RightFoot' },
  { mixamo: 'RightToeBase', vrm: 'rightToes', odk: 'ball_r', baseMale: 'Avatar_RightToeBase' }
]

const LEG_EXTRA_ODK = [
  'thigh_twist_01_l',
  'thigh_twist_02_l',
  'calf_twist_01_l',
  'calf_twist_02_l',
  'thigh_twist_01_r',
  'thigh_twist_02_r',
  'calf_twist_01_r',
  'calf_twist_02_r'
] as const

const SPINE_EXTRA_ODK = ['spine_04', 'spine_05', 'neck_02'] as const

type BoneSnapshot = {
  name: string
  parent: string
  localPos: string
  localRotDeg: string
  worldY: string
}

let sharedLoader: GLTFLoader | null = null
let baseMaleCache: Map<string, BoneSnapshot> | null = null

function getLoader(): GLTFLoader {
  if (!sharedLoader) sharedLoader = new GLTFLoader()
  return sharedLoader
}

function eulerDeg(q: THREE.Quaternion): string {
  const e = new THREE.Euler().setFromQuaternion(q, 'XYZ')
  return [e.x, e.y, e.z].map((r) => ((r * 180) / Math.PI).toFixed(1)).join(',')
}

function snapshotBone(root: THREE.Object3D, bone: THREE.Object3D): BoneSnapshot {
  const world = new THREE.Vector3()
  bone.getWorldPosition(world)
  root.worldToLocal(world)
  return {
    name: bone.name,
    parent: bone.parent?.name ?? '(root)',
    localPos: bone.position.toArray().map((v) => v.toFixed(3)).join(','),
    localRotDeg: eulerDeg(bone.quaternion),
    worldY: world.y.toFixed(3)
  }
}

function findMixamoBone(scene: THREE.Object3D, trackBoneName: string): THREE.Object3D | null {
  return (
    scene.getObjectByName(trackBoneName) ??
    scene.getObjectByName(normalizeMixamoBoneName(trackBoneName)) ??
    null
  )
}

async function loadBaseMaleSnapshots(): Promise<Map<string, BoneSnapshot>> {
  if (baseMaleCache) return baseMaleCache

  const gltf = await getLoader().loadAsync('/avatar/wearables/BaseMale/BaseMale.glb')
  const root = gltf.scene
  root.scale.set(0.01, 0.01, 0.01)
  root.updateWorldMatrix(true, true)

  const map = new Map<string, BoneSnapshot>()
  for (const row of HUMANOID_CHAIN) {
    const bone = root.getObjectByName(row.baseMale)
    if (bone) map.set(row.baseMale, snapshotBone(root, bone))
  }
  baseMaleCache = map
  return map
}

function logOdkSkeletonInventory(avatarRoot: THREE.Object3D): void {
  const names = [...collectBoneNames(avatarRoot)].sort()
  const animatable = names.filter((n) => !n.startsWith('ik_') && n !== 'interaction' && n !== 'center_of_mass')

  console.info(`[odk] skeleton inventory — ${names.length} nodes, ${animatable.length} animatable`)
  console.info('[odk] required locomotion bones:', ODK_REQUIRED_BONES.join(', '))

  const missing = ODK_REQUIRED_BONES.filter((b) => !names.includes(b))
  if (missing.length) console.warn('[odk] MISSING required bones:', missing.join(', '))
  else console.info('[odk] all required locomotion bones present')

  const extra = animatable.filter(
    (n) =>
      !ODK_REQUIRED_BONES.includes(n as (typeof ODK_REQUIRED_BONES)[number]) &&
      !n.includes('thumb_') &&
      !n.includes('index_') &&
      !n.includes('middle_') &&
      !n.includes('ring_') &&
      !n.includes('pinky_') &&
      !n.includes('metacarpal')
  )
  if (extra.length) console.info('[odk] extra non-finger bones:', extra.join(', '))
}

function logLegChains(avatarRoot: THREE.Object3D): void {
  avatarRoot.updateWorldMatrix(true, true)

  const logChain = (label: string, bones: string[]): void => {
    console.info(`[odk] ${label} chain:`)
    for (const name of bones) {
      const bone = getOdkBone(avatarRoot, name)
      if (!bone) {
        console.info(`  ${name} — MISSING`)
        continue
      }
      const snap = snapshotBone(avatarRoot, bone)
      console.info(
        `  ${snap.name} parent=${snap.parent} pos=(${snap.localPos}) rot°=(${snap.localRotDeg}) worldY=${snap.worldY}`
      )
    }
  }

  logChain('left leg', [
    'pelvis',
    'thigh_l',
    'thigh_twist_01_l',
    'thigh_twist_02_l',
    'calf_l',
    'calf_twist_01_l',
    'calf_twist_02_l',
    'foot_l',
    'ball_l'
  ])
  logChain('right leg', [
    'thigh_r',
    'thigh_twist_01_r',
    'thigh_twist_02_r',
    'calf_r',
    'calf_twist_01_r',
    'calf_twist_02_r',
    'foot_r',
    'ball_r'
  ])
}

export function isOdkBoneDebugEnabled(): boolean {
  if (typeof window === 'undefined') return true
  const params = new URLSearchParams(window.location.search)
  return !params.has('odkBoneDebug') || params.get('odkBoneDebug') !== '0'
}

/**
 * Console report: Mixamo → VRM → ODK → BaseMale mapping, bind poses, retarget track coverage.
 * Runs on ODK locomotion bind (disable with ?odkBoneDebug=0).
 */
export async function logOdkBoneDiagnostics(
  avatarRoot: THREE.Object3D,
  options: {
    idleClip: THREE.AnimationClip
    walkClip?: THREE.AnimationClip
    mixamoIdleUrl: string
    retargetedTrackCount: number
  }
): Promise<void> {
  if (!isOdkBoneDebugEnabled()) return

  console.info('[odk] ─── bone diagnostics (Mixamo → VRM → ODK → BaseMale) ───')
  const profile = getOdkRetargetProfile()
  console.info(`[odk] retarget profile: ${profile.id} (bindmul upper + world-delta locomotion legs)`)
  console.info(
    '[odk] note: AvatarComposer "composing feet" logs are DCL BaseMale remote avatars — not your ODK body'
  )

  logOdkSkeletonInventory(avatarRoot)
  logLegChains(avatarRoot)

  const feetY = measureOdkFeetY(avatarRoot)
  console.info(`[odk] feet pivot Y (bones + mesh sole): ${feetY?.toFixed(4) ?? 'n/a'}`)

  let baseMale: Map<string, BoneSnapshot>
  try {
    baseMale = await loadBaseMaleSnapshots()
  } catch (err) {
    console.warn('[odk] BaseMale reference load failed — mapping table without DCL bind pose', err)
    baseMale = new Map()
  }

  avatarRoot.updateWorldMatrix(true, true)

  console.info('[odk] humanoid mapping (bind pose comparison):')
  console.table(
    HUMANOID_CHAIN.map((row) => {
      const odkBone = getOdkBone(avatarRoot, row.odk)
      const odkSnap = odkBone ? snapshotBone(avatarRoot, odkBone) : null
      const bmSnap = baseMale.get(row.baseMale)
      return {
        mixamo: row.mixamo,
        vrm: row.vrm,
        odk: row.odk,
        baseMale: row.baseMale,
        odkOK: odkBone ? '✓' : '✗',
        odkRot: odkSnap?.localRotDeg ?? '—',
        odkWorldY: odkSnap?.worldY ?? '—',
        baseMaleRot: bmSnap?.localRotDeg ?? '—',
        baseMaleWorldY: bmSnap?.worldY ?? '—'
      }
    })
  )

  console.info('[odk] ODK-only bones (no Mixamo/VRM equivalent — spine extension + leg twists):')
  for (const name of [...SPINE_EXTRA_ODK, ...LEG_EXTRA_ODK]) {
    const bone = getOdkBone(avatarRoot, name)
    if (!bone) continue
    const snap = snapshotBone(avatarRoot, bone)
    console.info(`  ${snap.name} parent=${snap.parent} rot°=(${snap.localRotDeg}) worldY=${snap.worldY}`)
  }

  let mixamoScene: THREE.Object3D | null = null
  let mixamoClip: THREE.AnimationClip | null = null
  try {
    const gltf = await getLoader().loadAsync(options.mixamoIdleUrl)
    mixamoScene = gltf.scene
    mixamoClip = gltf.animations[0] ?? null
    mixamoScene.updateWorldMatrix(true, true)
  } catch (err) {
    console.warn('[odk] mp-idle load failed — skipping mixamo track report', err)
  }

  const mixamoTracks: string[] = []
  if (mixamoClip) {
    for (const track of mixamoClip.tracks) {
      if (!(track instanceof THREE.QuaternionKeyframeTrack)) continue
      const boneName = track.name.split('.')[0] ?? ''
      if (!boneName || mixamoTracks.includes(boneName)) continue
      mixamoTracks.push(boneName)
    }
  }

  const retargetedBones = new Set(
    options.idleClip.tracks
      .filter((t) => t instanceof THREE.QuaternionKeyframeTrack)
      .map((t) => t.name.split('.')[0] ?? '')
  )

  console.info(
    `[odk] mp-idle retarget coverage — ${options.retargetedTrackCount} tracks on idle clip (leg ✗ = stripped intentionally for standing)`
  )
  if (mixamoScene) {
    console.table(
      HUMANOID_CHAIN.map((row) => {
        const mixamoNames = [`mixamorig:${row.mixamo}`, `mixamorig${row.mixamo}`, row.mixamo]
        const mixamoBone =
          mixamoNames.map((n) => findMixamoBone(mixamoScene!, n)).find(Boolean) ?? null
        const odkResolved = resolveOdkBoneName(row.mixamo)
        const odkBone = odkResolved ? getOdkBone(avatarRoot, odkResolved) : null
        const vrmKey = MIXAMO_TO_VRM[row.mixamo] ?? '—'
        return {
          mixamo: row.mixamo,
          vrm: vrmKey,
          odk: odkResolved ?? '—',
          mixamoRig: mixamoBone ? '✓' : '✗',
          odkRig: odkBone ? '✓' : '✗',
          retargetTrack: odkResolved && retargetedBones.has(odkResolved) ? '✓' : '✗'
        }
      })
    )

    const unmappedMixamo = mixamoTracks.filter((name) => {
      const normalized = normalizeMixamoBoneName(name)
      return !resolveOdkBoneName(normalized) && !resolveOdkBoneName(name)
    })
    if (unmappedMixamo.length) {
      console.info('[odk] mp-idle mixamo tracks with no ODK mapping:', unmappedMixamo.sort().join(', '))
    }
  }

  logOdkRuntimePoseCheck(avatarRoot, options.idleClip, 'idle')
  if (options.walkClip) {
    logOdkRuntimePoseCheck(avatarRoot, options.walkClip, 'walk lower-body')
  }

  console.info('[odk] ─── end bone diagnostics ───')
}

/** Sample clip on a cloned root — foot bones + skinned sole vs bind. */
function logOdkRuntimePoseCheck(
  avatarRoot: THREE.Object3D,
  clip: THREE.AnimationClip,
  label: string
): void {
  const root = avatarRoot.clone(true)
  const bindSnaps = new Map<string, BoneSnapshot>()
  for (const name of ['foot_l', 'ball_l', 'calf_l', 'thigh_l', 'pelvis']) {
    const bone = getOdkBone(root, name)
    if (bone) bindSnaps.set(name, snapshotBone(root, bone))
  }

  const sample = (t: number): void => {
    const probe = root.clone(true)
    const mixer = new THREE.AnimationMixer(probe)
    mixer.clipAction(clip).play()
    mixer.setTime(t)
    mixer.update(0)
    probe.updateWorldMatrix(true, true)

    const rows: Record<string, string | number>[] = []
    for (const name of ['pelvis', 'thigh_l', 'calf_l', 'foot_l', 'ball_l', 'thigh_r', 'calf_r', 'foot_r']) {
      const bone = getOdkBone(probe, name)
      const bind = bindSnaps.get(name)
      if (!bone || !bind) continue
      const snap = snapshotBone(probe, bone)
      rows.push({
        bone: name,
        bindRot: bind.localRotDeg,
        animRot: snap.localRotDeg,
        bindY: bind.worldY,
        animY: snap.worldY
      })
    }
    console.info(`[odk] runtime ${label} pose t=${t} (bone bind vs animated):`)
    console.table(rows)
  }

  sample(0)
  sample(0.5)
}