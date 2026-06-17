#!/usr/bin/env node
/**
 * Tier A unit checks for trigger volume math (mirrors src/input/triggerAreaMath.ts).
 * Run: npm run test:trigger
 */
import * as THREE from 'three'

const TRIGGER_MESH_SPHERE = 1
const _inv = new THREE.Matrix4()
const _local = new THREE.Vector3()

function isPointInsideTriggerLocal(local, mesh) {
  if (mesh === TRIGGER_MESH_SPHERE) {
    return local.lengthSq() <= 0.25
  }
  return Math.abs(local.x) <= 0.5 && Math.abs(local.y) <= 0.5 && Math.abs(local.z) <= 0.5
}

function isPointInsideTriggerVolume(worldPoint, triggerNode, mesh) {
  _inv.copy(triggerNode.matrixWorld).invert()
  _local.copy(worldPoint).applyMatrix4(_inv)
  return isPointInsideTriggerLocal(_local, mesh)
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

function makeNode(position, scale = new THREE.Vector3(1, 1, 1)) {
  const node = new THREE.Group()
  node.position.copy(position)
  node.scale.copy(scale)
  node.updateMatrixWorld(true)
  return node
}

console.log('triggerAreaMath — unit box')
assert('center inside box', isPointInsideTriggerLocal(new THREE.Vector3(0, 0, 0), 0))
assert('face inside box', isPointInsideTriggerLocal(new THREE.Vector3(0.5, 0, 0), 0))
assert('outside box +x', !isPointInsideTriggerLocal(new THREE.Vector3(0.51, 0, 0), 0))
assert('outside box -y', !isPointInsideTriggerLocal(new THREE.Vector3(0, -0.51, 0), 0))

console.log('triggerAreaMath — unit sphere')
assert('center inside sphere', isPointInsideTriggerLocal(new THREE.Vector3(0, 0, 0), TRIGGER_MESH_SPHERE))
assert('surface inside sphere', isPointInsideTriggerLocal(new THREE.Vector3(0.5, 0, 0), TRIGGER_MESH_SPHERE))
assert('outside sphere', !isPointInsideTriggerLocal(new THREE.Vector3(0.51, 0, 0), TRIGGER_MESH_SPHERE))

console.log('triggerAreaMath — world transform')
{
  const node = makeNode(new THREE.Vector3(10, 0, 0), new THREE.Vector3(2, 2, 2))
  assert('world center inside scaled box', isPointInsideTriggerVolume(new THREE.Vector3(10, 0, 0), node, 0))
  assert('world edge inside 2x box', isPointInsideTriggerVolume(new THREE.Vector3(11, 0, 0), node, 0))
  assert('world outside 2x box', !isPointInsideTriggerVolume(new THREE.Vector3(11.1, 0, 0), node, 0))
}

console.log('triggerAreaMath — rotated box')
{
  const node = makeNode(new THREE.Vector3(0, 0, 0))
  node.rotation.y = Math.PI / 4
  node.updateMatrixWorld(true)
  const corner = new THREE.Vector3(0.35, 0, 0.35)
  assert('rotated corner inside', isPointInsideTriggerVolume(corner, node, 0))
}

console.log(`\ntriggerAreaMath: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)