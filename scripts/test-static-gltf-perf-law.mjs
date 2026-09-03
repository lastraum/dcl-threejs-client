#!/usr/bin/env node
/**
 * PhysX compact + clone attach: authored GLB names stay unmerged (modifier targets).
 * Uncookable vis hulls never become CCT actors. No mesh-name forks.
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
  'clone attach does not merge authored names (namedOk: false)',
  /mergeStaticGltfLeaves\(clone,\s*\{\s*namedOk:\s*false\s*\}\)/.test(bridge)
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
    `${m.type}|c:${m.color.getHexString()}|met:${m.metalness.toFixed(3)}|rgh:${m.roughness.toFixed(3)}|op:${m.opacity.toFixed(3)}`
  assert('identical untextured whites share a merge signature', sig(whiteA) === sig(whiteB))
  assert('gold does not share the white merge signature', sig(whiteA) !== sig(gold))
  whiteA.dispose()
  whiteB.dispose()
  gold.dispose()
}

if (failed) {
  console.error(`\n${failed} failure(s)`)
  process.exit(1)
}
console.log('\nall passed')
