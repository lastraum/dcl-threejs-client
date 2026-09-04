#!/usr/bin/env node
/**
 * Static GLTF perf law:
 * - Merge by material *content* (Hub duplicate whites), not uuid.
 * - Named leaves merge when the entity has no GltfNodeModifiers.path.
 * - Named modifier paths keep the authored graph (Updates banners).
 * - Merged kits instance up to MAX_MERGED_INSTANCER_LEAVES.
 * - PhysX compact still drops uncookable vis hulls. No mesh-name forks.
 *
 * Run: node scripts/test-static-gltf-perf-law.mjs
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'

const root = process.cwd()
const mergeSrc = readFileSync(join(root, 'src/rendering/mergeStaticGltfLeaves.ts'), 'utf8')
const bridge = readFileSync(join(root, 'src/bridge/ThreeBridge.ts'), 'utf8')
const instancer = readFileSync(join(root, 'src/rendering/SceneGltfInstancer.ts'), 'utf8')
const modifiers = readFileSync(join(root, 'src/bridge/GltfNodeModifiersSync.ts'), 'utf8')
const extractor = readFileSync(join(root, 'src/collision/GltfColliderExtractor.ts'), 'utf8')
const compact = readFileSync(join(root, 'src/collision/compactGltfColliderShapes.ts'), 'utf8')
const video = readFileSync(join(root, 'src/media/VideoPlayerBridge.ts'), 'utf8')

let failed = 0
function assert(label, cond) {
  if (cond) console.log(`  ok ${label}`)
  else {
    failed++
    console.error(` FAIL ${label}`)
  }
}

console.log('static gltf perf law')

assert(
  'merge keys materials by content signature, not uuid',
  /export function materialMergeKey/.test(mergeSrc) &&
    /materialMergeKey\(mesh\.material/.test(mergeSrc) &&
    !/function materialKey\(mat[\s\S]*return mat\.uuid/.test(mergeSrc)
)
assert(
  'named-leaf merge is cached per template (ensureMergedStaticGltfRoot)',
  /export function ensureMergedStaticGltfRoot/.test(mergeSrc) &&
    /export function mergeStaticGltfInPlace/.test(mergeSrc) &&
    /namedOk:\s*true/.test(mergeSrc)
)
assert(
  'cache merge is in-place on the loaded scene graph',
  /mergeStaticGltfInPlace\(entry\.root\)/.test(
    readFileSync(join(root, 'src/rendering/AssetCache.ts'), 'utf8')
  )
)
assert(
  'first high-leaf kit does not force-clone when it can instance after merge',
  /if \(attachNow && !this\.canInstanceAttach\(entity, template\)\)/.test(bridge)
)
assert(
  'empty Creator Hub Animator does not block GPU instance',
  /Creator Hub stamps empty Animator/.test(bridge) &&
    !/if \(this\.ecs\.Animator\.has\(entity\)\) return false/.test(bridge)
)
assert(
  'named merge is gated on GltfNodeModifiers.path (not a scene-name fork)',
  /entityAllowsNamedStaticMerge/.test(bridge) &&
    /gltfNodeModifiersHaveNamedPath/.test(bridge) &&
    /export function gltfNodeModifiersHaveNamedPath/.test(modifiers)
)
assert(
  'clone attach always merges; namedOk follows namedMerge (empty Animator does not skip)',
  /mergeStaticGltfLeaves\(clone,\s*\{\s*namedOk:\s*namedMerge\s*\}/.test(bridge) &&
    /hasAnimClips/.test(bridge)
)
assert(
  'materialMergeKey does not uuid-trap default onBeforeCompile',
  !/custom:\$\{mat\.uuid\}/.test(mergeSrc) && !/onBeforeCompile !== THREE\.Material\.prototype/.test(mergeSrc)
)
assert(
  'scene GLB load warms a merged static root',
  /mergeStaticGltfInPlace\(entry\.root\)/.test(
    readFileSync(join(root, 'src/rendering/AssetCache.ts'), 'utf8')
  )
)
assert(
  'instance attach uses merged renderRoot and original collider graph',
  /instancer\.attach\(/.test(bridge) &&
    /staticGltfUnmergedRoot\(template\.root\)/.test(bridge) &&
    /cloneGltfInstance\(renderRoot\)/.test(bridge)
)
assert(
  'merged kits may instance beyond the 12-leaf unmerged cap',
  /MAX_MERGED_INSTANCER_LEAVES\s*=\s*64/.test(instancer) &&
    /templateIsInstancable\(merged,\s*MAX_MERGED_INSTANCER_LEAVES\)/.test(bridge)
)
assert(
  'no Curve* mesh-name fork in merge or collider compact',
  !/Curve\d+/.test(mergeSrc) && !/Curve\d+/.test(compact) && !/Curve\d+/.test(extractor)
)
assert(
  'extractor compacts static hulls and skips Animator PART',
  /filterAndMaybeCompactGltfColliderShapes/.test(extractor) &&
    /const compactStatic = !ecs\.Animator\?\.has\(entity\)/.test(extractor)
)
assert(
  'compact drops uncookable then merges vis/inv',
  /isSourceTrimeshCookable/.test(compact) && /compactClass\('vis'/.test(compact)
)
assert(
  'video material rebind is once per play\/idle+src, not every frame',
  /materialsBoundKey/.test(video) && /notifyMaterialsForVideo/.test(video)
)

const MIN_TRIANGLE_AREA_SQ = 1e-12
function isCookable(geometry) {
  const position = geometry.attributes.position
  const index = geometry.index
  if (!position || !index || position.count < 3 || index.count < 3) return false
  const pos = position.array
  const indices = index.array
  for (let i = 0; i < index.count; i += 3) {
    const i0 = indices[i] * 3
    const i1 = indices[i + 1] * 3
    const i2 = indices[i + 2] * 3
    const ax = pos[i1] - pos[i0]
    const ay = pos[i1 + 1] - pos[i0 + 1]
    const az = pos[i1 + 2] - pos[i0 + 2]
    const bx = pos[i2] - pos[i0]
    const by = pos[i2 + 1] - pos[i0 + 1]
    const bz = pos[i2 + 2] - pos[i0 + 2]
    const cx = ay * bz - az * by
    const cy = az * bx - ax * bz
    const cz = ax * by - ay * bx
    if (cx * cx + cy * cy + cz * cz > MIN_TRIANGLE_AREA_SQ) return true
  }
  return false
}

{
  const deg = new THREE.BufferGeometry()
  deg.setAttribute(
    'position',
    new THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 2, 0, 0]), 3)
  )
  deg.setIndex([0, 1, 2])
  assert('degenerate collinear tri is not cookable', isCookable(deg) === false)
  deg.dispose()
}

{
  const box = new THREE.BoxGeometry(1, 1, 1)
  assert('box trimesh is cookable', isCookable(box) === true)
  const a = box.clone()
  a.applyMatrix4(new THREE.Matrix4().makeTranslation(-2, 0, 0))
  const b = box.clone()
  b.applyMatrix4(new THREE.Matrix4().makeTranslation(2, 0, 0))
  const merged = mergeGeometries([a, b], false)
  assert('two vis boxes merge into one cookable hull', !!merged && isCookable(merged) === true)
  a.dispose()
  b.dispose()
  box.dispose()
  merged?.dispose()
}

{
  const whiteA = new THREE.MeshStandardMaterial({ color: 0xffffff })
  const whiteB = new THREE.MeshStandardMaterial({ color: 0xffffff })
  const gold = new THREE.MeshStandardMaterial({ color: 0xd4ad36 })
  assert('two white Hub materials are different uuids', whiteA.uuid !== whiteB.uuid)
  const sig = (m) =>
    `${m.type}|${m.side}|c:${m.color.getHexString()}|em:${m.emissive.getHexString()}|met:${m.metalness.toFixed(3)}|rgh:${m.roughness.toFixed(3)}|op:${m.opacity.toFixed(3)}`
  assert('identical untextured whites share a merge signature', sig(whiteA) === sig(whiteB))
  assert('gold does not share the white merge signature', sig(whiteA) !== sig(gold))
  assert(
    'default MeshStandardMaterial is not a custom:uuid trap',
    !sig(whiteA).startsWith('custom:')
  )

  // Named Hub bricks (LeftWall_*) with duplicate whites collapse to 2 draws, not 6.
  // `_collider` stays a separate leaf (PhysX naming law).
  const kit = new THREE.Group()
  for (let i = 0; i < 5; i++) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), i % 2 ? whiteA : whiteB)
    mesh.name = `LeftWall_${i}`
    mesh.position.x = i * 2
    kit.add(mesh)
  }
  const trim = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), gold)
  trim.name = 'GoldTrim'
  trim.position.x = 12
  kit.add(trim)
  const hull = new THREE.Mesh(new THREE.BoxGeometry(2, 0.2, 2), whiteA)
  hull.name = 'floor_collider'
  kit.add(hull)
  kit.updateMatrixWorld(true)

  const buckets = new Map()
  kit.traverse((node) => {
    if (!node.isMesh) return
    if (/_collider/i.test(node.name)) return
    const key = sig(node.material)
    const list = buckets.get(key) || []
    list.push(node)
    buckets.set(key, list)
  })
  assert('named kit buckets into white + gold (not 6 uuids)', buckets.size === 2)
  let mergedDraws = 0
  for (const meshes of buckets.values()) {
    if (meshes.length === 1) {
      mergedDraws++
      continue
    }
    const geos = meshes.map((mesh) => {
      const geo = mesh.geometry.clone()
      geo.applyMatrix4(mesh.matrixWorld)
      return geo
    })
    const merged = mergeGeometries(geos, false)
    assert('named same-material bricks merge into one cookable mesh', !!merged && isCookable(merged) === true)
    mergedDraws++
    merged?.dispose()
    for (const geo of geos) geo.dispose()
  }
  assert('named kit render draws = 2 (white hull + gold trim), collider excluded', mergedDraws === 2)
  assert('collider leaf still present on the kit', kit.getObjectByName('floor_collider') instanceof THREE.Mesh)

  whiteA.dispose()
  whiteB.dispose()
  gold.dispose()
}

if (failed) {
  console.error(`\n${failed} failure(s)`)
  process.exit(1)
}
console.log('\nall passed')
