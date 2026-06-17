import type { PBAvatarShape } from '@dcl/ecs/dist/components/generated/pb/decentraland/sdk/components/avatar_shape.gen'

/** AvatarShape expression triggers loop until cleared (Unity / Explorer parity). */
export const AVATAR_SHAPE_EXPRESSION_LOOP = true

export type AvatarShapeExpressionState = {
  lastTriggerId: string
  /** `undefined` = never seen — allows lamport timestamp `0` on first trigger. */
  lastTimestamp: number | undefined
}

export type AvatarShapeExpressionAction =
  | { type: 'play'; emoteRef: string; loop: boolean }
  | { type: 'stop' }
  | null

/** Resolve `expressionTriggerId` → emote URN or slug (Unity AvatarShape parity). */
export function resolveAvatarShapeEmoteRef(shape: PBAvatarShape): string | null {
  const trigger = shape.expressionTriggerId?.trim()
  if (!trigger) return null

  if (trigger.startsWith('urn:')) return trigger

  const index = Number(trigger)
  if (Number.isInteger(index) && index >= 0 && index < shape.emotes.length) {
    const fromSlot = shape.emotes[index]?.trim()
    if (fromSlot) return fromSlot
  }

  return trigger
}

/**
 * Detect AvatarShape expression trigger changes.
 * Lamport `expressionTriggerTimestamp` starts at 0; id-only updates (no timestamp) also fire.
 */
export function resolveAvatarShapeExpressionAction(
  shape: PBAvatarShape,
  state: AvatarShapeExpressionState
): AvatarShapeExpressionAction {
  const triggerId = shape.expressionTriggerId?.trim() ?? ''
  if (!triggerId) {
    if (state.lastTriggerId || state.lastTimestamp !== undefined) {
      state.lastTriggerId = ''
      state.lastTimestamp = undefined
      return { type: 'stop' }
    }
    return null
  }

  const emoteRef = resolveAvatarShapeEmoteRef(shape)
  if (!emoteRef) return null

  const timestamp = shape.expressionTriggerTimestamp
  const timestampChanged = timestamp !== undefined && timestamp !== state.lastTimestamp
  const idChanged = triggerId !== state.lastTriggerId
  if (!timestampChanged && !idChanged) return null

  state.lastTriggerId = triggerId
  if (timestamp !== undefined) state.lastTimestamp = timestamp

  return { type: 'play', emoteRef, loop: AVATAR_SHAPE_EXPRESSION_LOOP }
}
