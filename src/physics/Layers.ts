/** Collision layers — subset of Hyperfy `Layers.js` for scene + player. */
export const Layers = {
  player: { group: 1 << 1, mask: (1 << 2) | (1 << 3) | (1 << 4) },
  environment: { group: 1 << 2, mask: (1 << 1) | (1 << 2) | (1 << 3) },
  prop: { group: 1 << 3, mask: (1 << 1) | (1 << 2) | (1 << 3) },
  gltfCollider: { group: 1 << 4, mask: (1 << 1) | (1 << 2) | (1 << 3) }
} as const

export const ENVIRONMENT_MASK = Layers.environment.group | Layers.prop.group
export const GROUND_QUERY_MASK = Layers.environment.group | Layers.prop.group | Layers.gltfCollider.group
export const CAMERA_QUERY_MASK = Layers.environment.group | Layers.prop.group
