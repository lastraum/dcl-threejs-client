/** Collision layers — subset of Hyperfy `Layers.js` for scene + player. */
export const Layers = {
  // Player CCT must NOT mask trigger bit — trigger volumes are overlap-only.
  // Including (1<<5) made bilateral CCT filter block/tangle on TriggerArea spheres.
  //
  // Solid masks use OPEN bits (0xffffffff) so bilateral SQ/CCT never rejects env/prop/gltf
  // hulls due to word drift / stale filter copies (plaza: static=1100, sweep MISS).
  // Trigger layer stays narrow so TriggerArea spheres never block the capsule.
  // mask uses >>> 0 so WASM gets unsigned 0xffffffff (not JS signed -1).
  player: { group: 1 << 1, mask: 0xffffffff >>> 0 },
  environment: { group: 1 << 2, mask: 0xffffffff >>> 0 },
  prop: { group: 1 << 3, mask: 0xffffffff >>> 0 },
  gltfCollider: { group: 1 << 4, mask: 0xffffffff >>> 0 },
  /** SDK TriggerArea volumes — overlap queries only; no simulation blocking. */
  trigger: { group: 1 << 5, mask: 1 << 1 }
} as const

/** Open bilateral filter words — pass every solid SQ hit (not triggers). */
export const SOLID_FILTER_OPEN = 0xffffffff >>> 0

export const ENVIRONMENT_MASK = Layers.environment.group | Layers.prop.group
export const GROUND_QUERY_MASK = Layers.environment.group | Layers.prop.group | Layers.gltfCollider.group
/** Landscape / parcel walls only — scene GLTF trimesh colliders stay on prop and must not pull the camera in. */
export const CAMERA_QUERY_MASK = Layers.environment.group
export const TRIGGER_QUERY_MASK = Layers.trigger.group
