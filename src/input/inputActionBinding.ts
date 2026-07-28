import { keybinds, formatKeybindCodes } from './keybinds'
import { InputAction, PointerEventType, type InputActionValue, type PointerEventTypeValue } from './pointerConstants'

export type InputActionKeyBinding = {
  action: InputActionValue
  /** Short label for debug logs. */
  label: string
  /** Compact key badge for hover tooltips. */
  badge: string
  preventDefault: boolean
}

const INTERACT_PREVENT_DEFAULT = new Set<InputActionValue>([
  InputAction.IA_PRIMARY,
  InputAction.IA_SECONDARY
])

/** Resolve current keybind for a KeyboardEvent.code → interact/action binding. */
export function keyCodeToInputActionBinding(code: string): InputActionKeyBinding | undefined {
  const actions = keybinds.actionsForCode(code)
  // Prefer interact/hotkey actions over locomotion when a code somehow dual-maps.
  const preferred =
    actions.find(
      (a) =>
        a === InputAction.IA_PRIMARY ||
        a === InputAction.IA_SECONDARY ||
        a === InputAction.IA_ACTION_3 ||
        a === InputAction.IA_ACTION_4 ||
        a === InputAction.IA_ACTION_5 ||
        a === InputAction.IA_ACTION_6 ||
        a === InputAction.IA_JUMP ||
        a === InputAction.IA_WALK
    ) ?? actions[0]
  if (preferred === undefined) return undefined
  return bindingForAction(preferred)
}

export function inputActionBinding(action: InputActionValue): InputActionKeyBinding | undefined {
  return bindingForAction(action)
}

function bindingForAction(action: InputActionValue): InputActionKeyBinding | undefined {
  const id = bindIdForAction(action)
  if (!id) {
    if (action === InputAction.IA_POINTER) {
      return { action, label: 'click', badge: 'click', preventDefault: false }
    }
    return undefined
  }
  const codes = keybinds.getCodes(id)
  const badge = formatKeybindCodes(codes)
  return {
    action,
    label: badge,
    badge,
    preventDefault: INTERACT_PREVENT_DEFAULT.has(action)
  }
}

function bindIdForAction(action: InputActionValue): import('./keybinds').KeybindId | undefined {
  switch (action) {
    case InputAction.IA_FORWARD:
      return 'forward'
    case InputAction.IA_BACKWARD:
      return 'backward'
    case InputAction.IA_LEFT:
      return 'left'
    case InputAction.IA_RIGHT:
      return 'right'
    case InputAction.IA_JUMP:
      return 'jump'
    case InputAction.IA_WALK:
      return 'walk'
    case InputAction.IA_MODIFIER:
      return 'modifier'
    case InputAction.IA_PRIMARY:
      return 'primary'
    case InputAction.IA_SECONDARY:
      return 'secondary'
    case InputAction.IA_ACTION_3:
      return 'action3'
    case InputAction.IA_ACTION_4:
      return 'action4'
    case InputAction.IA_ACTION_5:
      return 'action5'
    case InputAction.IA_ACTION_6:
      return 'action6'
    default:
      return undefined
  }
}

export function inputActionInteractLabel(action: InputActionValue): string {
  const b = inputActionBinding(action)
  if (b) return b.label
  if (action === InputAction.IA_POINTER) return 'click'
  return `button=${action}`
}

export function inputActionKeyBadge(action: InputActionValue): string | null {
  const b = inputActionBinding(action)
  if (!b) return null
  if (action === InputAction.IA_POINTER) return null
  return b.badge
}

/** When to show a hover hint for a PointerEvents entry (Unity hover canvas parity). */
export function shouldShowPointerHoverHint(
  button: InputActionValue,
  eventType: PointerEventTypeValue,
  primaryActionDown: boolean
): boolean {
  if (button === InputAction.IA_ANY) {
    return (
      (primaryActionDown && eventType === PointerEventType.PET_UP) ||
      (!primaryActionDown && eventType === PointerEventType.PET_DOWN)
    )
  }
  if (button === InputAction.IA_PRIMARY) {
    return (
      (eventType === PointerEventType.PET_DOWN && !primaryActionDown) ||
      (eventType === PointerEventType.PET_UP && primaryActionDown)
    )
  }
  if (button === InputAction.IA_POINTER) {
    return eventType === PointerEventType.PET_DOWN && !primaryActionDown
  }
  return eventType === PointerEventType.PET_DOWN
}
