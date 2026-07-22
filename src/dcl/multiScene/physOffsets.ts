/**
 * PhysX entity id namespaces so primary / secondary / PE colliders never clash.
 * Primary uses native ids (mesh entity + GLTF_COLLIDER_ENTITY_BASE 20M).
 * Roads use ROAD_AOI 21M.
 */
export const SECONDARY_PHYS_BASE = 30_000_000
export const PE_PHYS_BASE = 50_000_000
/** Max phys ids reserved per multi-scene slot (mesh + gltf range). */
export const MULTI_SCENE_PHYS_STRIDE = 2_000_000

export function secondaryPhysOffset(slotIndex: number): number {
  return SECONDARY_PHYS_BASE + slotIndex * MULTI_SCENE_PHYS_STRIDE
}

export function pePhysOffset(slotIndex: number): number {
  return PE_PHYS_BASE + slotIndex * MULTI_SCENE_PHYS_STRIDE
}
