export type DefaultAnimatorState = Readonly<{
  clip?: string
  playing?: boolean
  loop?: boolean
  speed?: number
  weight?: number
  shouldReset?: boolean
}>

/**
 * DCL default when a GLB has embedded clips but no ECS `Animator`:
 * the first clip auto-plays on loop (Unity Explorer renderer behavior).
 * @see https://docs.decentraland.org/creator/scenes-sdk7/3d-content-essentials/3d-model-animations.md
 */
export function deriveDefaultAnimatorStates(clipNames: readonly string[]): DefaultAnimatorState[] {
  const first = clipNames[0]?.trim()
  if (!first) return []
  return [{ clip: first, playing: true, loop: true, speed: 1, weight: 1 }]
}