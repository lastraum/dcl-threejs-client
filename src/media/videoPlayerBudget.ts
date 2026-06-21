import * as THREE from 'three'
import type { Entity } from '@dcl/ecs'
import type { MirrorComponents } from '../bridge/mirrorComponents'
import type { ProjectionView } from '../bridge/ProjectionView'
import { resolveSpatialAudioAttach, type SpatialAudioAnchors } from './spatialAudioParent'

export type VideoBudgetInput = {
  entity: Entity
  ecsWantsPlaying: boolean
  visible: boolean
}

const _worldPos = new THREE.Vector3()
const _camPos = new THREE.Vector3()
const _toEntity = new THREE.Vector3()
const _camForward = new THREE.Vector3()

function getEntityWorldPosition(
  entity: Entity,
  view: ProjectionView,
  Transform: MirrorComponents['Transform'],
  getEntityNodes: () => Map<Entity, THREE.Group>,
  anchors: SpatialAudioAnchors | null,
  out: THREE.Vector3
): boolean {
  const attach = resolveSpatialAudioAttach(entity, view, Transform, getEntityNodes, anchors)
  if (attach) {
    attach.parent.updateWorldMatrix(true, false)
    out.setFromMatrixPosition(attach.parent.matrixWorld)
    return true
  }
  const node = getEntityNodes().get(entity)
  if (!node) return false
  node.getWorldPosition(out)
  return true
}

function estimateScreenSize(
  entity: Entity,
  Transform: MirrorComponents['Transform'],
  getEntityNodes: () => Map<Entity, THREE.Group>
): number {
  const node = getEntityNodes().get(entity)
  if (node) {
    _worldPos.set(node.scale.x, node.scale.y, node.scale.z)
    node.getWorldScale(_worldPos)
    return Math.max(_worldPos.x, _worldPos.y, _worldPos.z)
  }
  if (!Transform.has(entity)) return 1
  const t = Transform.get(entity)
  return Math.max(t.scale.x, t.scale.y, t.scale.z)
}

/** Rank candidates — higher score wins a decode slot. */
export function scoreVideoBudgetCandidate(input: {
  distance: number
  inView: boolean
  screenSize: number
  visible: boolean
  ecsWantsPlaying: boolean
}): number {
  if (!input.visible || !input.ecsWantsPlaying) return -Infinity
  let score = 0
  if (input.inView) score += 10_000
  score += input.screenSize * 500
  score -= input.distance * 20
  return score
}

/** Pick entities allowed to decode this frame (DCL-style budget). */
export function selectBudgetedVideoEntities(
  inputs: VideoBudgetInput[],
  view: ProjectionView,
  Transform: MirrorComponents['Transform'],
  getEntityNodes: () => Map<Entity, THREE.Group>,
  anchors: SpatialAudioAnchors | null,
  camera: THREE.Camera,
  maxActive: number
): Set<Entity> {
  if (maxActive <= 0) return new Set()

  camera.getWorldPosition(_camPos)
  camera.getWorldDirection(_camForward)

  const scored: Array<{ entity: Entity; score: number }> = []

  for (const input of inputs) {
    if (!getEntityWorldPosition(input.entity, view, Transform, getEntityNodes, anchors, _worldPos)) {
      continue
    }

    _toEntity.subVectors(_worldPos, _camPos)
    const distance = _toEntity.length()
    const inView = distance > 0.05 && _toEntity.normalize().dot(_camForward) > 0.2
    const screenSize = estimateScreenSize(input.entity, Transform, getEntityNodes)
    const score = scoreVideoBudgetCandidate({
      distance,
      inView,
      screenSize,
      visible: input.visible,
      ecsWantsPlaying: input.ecsWantsPlaying
    })
    if (!Number.isFinite(score)) continue
    scored.push({ entity: input.entity, score })
  }

  scored.sort((a, b) => b.score - a.score)
  const active = new Set<Entity>()
  for (let i = 0; i < Math.min(maxActive, scored.length); i++) {
    active.add(scored[i]!.entity)
  }
  return active
}