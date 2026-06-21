import * as THREE from 'three'
import type { Entity } from '@dcl/ecs'
import { dclToThreePos, dclToThreeQuat, type DclTransformValues } from '../bridge/dclTransform'
import type { MirrorComponents } from '../bridge/mirrorComponents'
import type { ProjectionView } from '../bridge/ProjectionView'

export type SpatialAudioAnchors = {
  getPlayerRoot: () => THREE.Object3D | null
  getCamera: () => THREE.Camera | null
}

export type SpatialAudioAttach = {
  parent: THREE.Object3D
  localTransform?: DclTransformValues
}

const _pos = new THREE.Vector3()
const _quat = new THREE.Quaternion()
const _scale = new THREE.Vector3(1, 1, 1)
const _matA = new THREE.Matrix4()
const _matB = new THREE.Matrix4()
const _matOut = new THREE.Matrix4()

const IDENTITY_TRANSFORM: DclTransformValues = {
  position: { x: 0, y: 0, z: 0 },
  rotation: { x: 0, y: 0, z: 0, w: 1 },
  scale: { x: 1, y: 1, z: 1 }
}

function dclTransformToMatrix(t: DclTransformValues, out = _matA): THREE.Matrix4 {
  dclToThreePos(t.position.x, t.position.y, t.position.z, _pos)
  dclToThreeQuat(t.rotation.x, t.rotation.y, t.rotation.z, t.rotation.w, _quat)
  _scale.set(t.scale.x, t.scale.y, t.scale.z)
  return out.compose(_pos, _quat, _scale)
}

function matrixToDclTransform(mat: THREE.Matrix4): DclTransformValues {
  mat.decompose(_pos, _quat, _scale)
  return {
    position: { x: -_pos.x, y: _pos.y, z: _pos.z },
    rotation: { x: -_quat.x, y: _quat.y, z: _quat.z, w: -_quat.w },
    scale: { x: _scale.x, y: _scale.y, z: _scale.z }
  }
}

function multiplyDclTransforms(parent: DclTransformValues, local: DclTransformValues): DclTransformValues {
  _matOut.multiplyMatrices(dclTransformToMatrix(parent, _matA), dclTransformToMatrix(local, _matB))
  return matrixToDclTransform(_matOut)
}

function findReservedAnchorKind(
  entity: Entity,
  view: ProjectionView,
  Transform: MirrorComponents['Transform']
): 'player' | 'camera' | null {
  let current: Entity = entity
  while (true) {
    if (current === view.PlayerEntity) return 'player'
    if (current === view.CameraEntity) return 'camera'
    const t = Transform.getOrNull(current)
    if (!t?.parent || t.parent === view.RootEntity) return null
    current = t.parent as Entity
  }
}

function composeLocalTransformToAnchor(
  entity: Entity,
  anchorEntity: Entity,
  Transform: MirrorComponents['Transform']
): DclTransformValues | null {
  if (entity === anchorEntity) return IDENTITY_TRANSFORM
  if (!Transform.has(entity)) return null

  const t = Transform.get(entity) as DclTransformValues
  const parent = t.parent as Entity | undefined
  if (parent === anchorEntity) {
    return {
      position: t.position,
      rotation: t.rotation,
      scale: t.scale
    }
  }
  if (!parent || !Transform.has(parent)) return null

  const parentLocal = composeLocalTransformToAnchor(parent, anchorEntity, Transform)
  if (!parentLocal) return null
  return multiplyDclTransforms(parentLocal, t)
}

/** Resolve THREE parent for spatial audio — scene nodes, or player/camera anchors when ECS parent is reserved. */
export function resolveSpatialAudioAttach(
  entity: Entity,
  view: ProjectionView,
  Transform: MirrorComponents['Transform'],
  getEntityNodes: () => Map<Entity, THREE.Group>,
  anchors: SpatialAudioAnchors | null
): SpatialAudioAttach | null {
  const anchorKind = findReservedAnchorKind(entity, view, Transform)

  if (anchorKind === 'player') {
    const root = anchors?.getPlayerRoot()
    if (!root) return null
    const local = composeLocalTransformToAnchor(entity, view.PlayerEntity, Transform)
    return local ? { parent: root, localTransform: local } : null
  }

  if (anchorKind === 'camera') {
    const camera = anchors?.getCamera()
    if (!camera) return null
    const local = composeLocalTransformToAnchor(entity, view.CameraEntity, Transform)
    return local ? { parent: camera, localTransform: local } : null
  }

  const node = getEntityNodes().get(entity)
  return node ? { parent: node } : null
}

