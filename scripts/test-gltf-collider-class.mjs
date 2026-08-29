#!/usr/bin/env node
/**
 * ADR-215 GltfContainer mesh class — mirrors src/collision/gltfColliderNaming.ts.
 * Repro: L’Impératrice Atelier (126,104) water_cube_wrap_*.glb is a visual Cube
 * with vis=0; inv=3 on one copy must not invent a PhysX hull.
 *
 * Run: node scripts/test-gltf-collider-class.mjs
 */
import * as THREE from 'three'

function isGltfInvisibleColliderName(name) {
  if (!name) return false
  return /_collider/i.test(name)
}

function isGltfInvisibleColliderMesh(mesh, stopBefore) {
  let node = mesh
  while (node && node !== stopBefore) {
    if (isGltfInvisibleColliderName(node.name)) return true
    node = node.parent
  }
  return false
}

function isGltfVisibleClassMesh(mesh, stopBefore) {
  if (isGltfInvisibleColliderName(mesh.name)) return false
  if (stopBefore && isGltfInvisibleColliderMesh(mesh, stopBefore)) return false
  return mesh.name.length > 0
}

function classifyGltfCollisionMesh(mesh, gltfRoot) {
  if (isGltfInvisibleColliderMesh(mesh, gltfRoot)) return 'inv'
  if (isGltfVisibleClassMesh(mesh, gltfRoot)) return 'vis'
  return 'unnamed'
}

function gltfMeshContributesPhysics(mesh, gltfRoot, hasVisiblePhysics, hasInvisiblePhysics) {
  const skinned = mesh.isSkinnedMesh === true
  const kind = classifyGltfCollisionMesh(mesh, gltfRoot)
  if (skinned && kind !== 'inv') return false
  if (kind === 'inv') return hasInvisiblePhysics
  return hasVisiblePhysics
}

let passed = 0
let failed = 0

function assert(label, condition) {
  if (condition) {
    passed += 1
    console.log(`  ok ${label}`)
  } else {
    failed += 1
    console.error(` FAIL ${label}`)
  }
}

function makeMesh(name) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1))
  mesh.name = name
  return mesh
}

function extractShellLike(gltfRoot) {
  const descs = []
  gltfRoot.traverse((node) => {
    if (!node.isMesh) return
    if (!isGltfInvisibleColliderMesh(node, gltfRoot)) return
    descs.push(node.name)
  })
  return descs
}

{
  const root = new THREE.Group()
  root.name = 'Scene'
  const cube = makeMesh('Cube')
  root.add(cube)
  assert('water Cube is vis-class', classifyGltfCollisionMesh(cube, root) === 'vis')
  assert(
    'vis=0 inv=3 Cube does not cook (126,104 waterfall)',
    gltfMeshContributesPhysics(cube, root, false, true) === false
  )
  assert(
    'vis=0 inv=0 Cube does not cook',
    gltfMeshContributesPhysics(cube, root, false, false) === false
  )
  assert(
    'vis physics Cube does cook (invisible_wall vis=2)',
    gltfMeshContributesPhysics(cube, root, true, false) === true
  )
}

{
  const root = new THREE.Group()
  const visual = makeMesh('Stair_floating')
  const hull = makeMesh('Stair_floating_collider')
  root.add(visual)
  visual.add(hull)
  assert('stair visual is vis-class', classifyGltfCollisionMesh(visual, root) === 'vis')
  assert('stair hull is inv-class', classifyGltfCollisionMesh(hull, root) === 'inv')
  assert(
    'vis=0 inv=3 cooks hull only',
    gltfMeshContributesPhysics(visual, root, false, true) === false &&
      gltfMeshContributesPhysics(hull, root, false, true) === true
  )
}

{
  const root = new THREE.Group()
  const group = new THREE.Group()
  group.name = 'HummingBird_collider'
  const leaf = makeMesh('Cube.045')
  root.add(group)
  group.add(leaf)
  assert(
    'ancestry _collider group child is inv-class',
    classifyGltfCollisionMesh(leaf, root) === 'inv'
  )
}

{
  const root = new THREE.Group()
  const unnamed = makeMesh('')
  root.add(unnamed)
  assert('unnamed is unnamed-class', classifyGltfCollisionMesh(unnamed, root) === 'unnamed')
  assert(
    'unnamed cooks only with vis physics',
    gltfMeshContributesPhysics(unnamed, root, false, true) === false &&
      gltfMeshContributesPhysics(unnamed, root, true, false) === true
  )
}

{
  const root = new THREE.Group()
  const art = makeMesh('JRArt_building')
  const floor = makeMesh('Floor_collider')
  const wallGroup = new THREE.Group()
  wallGroup.name = 'Walls_collider'
  const wallLeaf = makeMesh('Cube')
  root.add(art)
  root.add(floor)
  root.add(wallGroup)
  wallGroup.add(wallLeaf)
  const hulls = extractShellLike(root)
  assert(
    'CityTile shell extracts _collider floor + ancestry wall, not vis art',
    hulls.includes('Floor_collider') && hulls.includes('Cube') && !hulls.includes('JRArt_building')
  )
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) process.exit(1)
