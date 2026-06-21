import { InputAction, PointerEventType, type InputActionValue, type PointerEventTypeValue } from './pointerConstants'

export type InputActionKeyBinding = {
  action: InputActionValue
  /** Short label for debug logs. */
  label: string
  /** Compact key badge for hover tooltips. */
  badge: string
  preventDefault: boolean
}

const BINDINGS: ReadonlyArray<InputActionKeyBinding & { codes: readonly string[] }> = [
  { codes: ['KeyE'], action: InputAction.IA_PRIMARY, label: 'E', badge: 'E', preventDefault: true },
  { codes: ['KeyF'], action: InputAction.IA_SECONDARY, label: 'F', badge: 'F', preventDefault: true },
  { codes: ['Digit1', 'Numpad1'], action: InputAction.IA_ACTION_3, label: '1', badge: '1', preventDefault: false },
  { codes: ['Digit2', 'Numpad2'], action: InputAction.IA_ACTION_4, label: '2', badge: '2', preventDefault: false },
  { codes: ['Digit3', 'Numpad3'], action: InputAction.IA_ACTION_5, label: '3', badge: '3', preventDefault: false },
  { codes: ['Digit4', 'Numpad4'], action: InputAction.IA_ACTION_6, label: '4', badge: '4', preventDefault: false },
  { codes: ['Space'], action: InputAction.IA_JUMP, label: 'Space', badge: 'Spc', preventDefault: false },
  { codes: ['ControlLeft', 'ControlRight'], action: InputAction.IA_WALK, label: 'Ctrl', badge: 'Ctrl', preventDefault: false }
]

const codeToBinding = new Map<string, InputActionKeyBinding>()
for (const entry of BINDINGS) {
  for (const code of entry.codes) {
    codeToBinding.set(code, entry)
  }
}

export function keyCodeToInputActionBinding(code: string): InputActionKeyBinding | undefined {
  return codeToBinding.get(code)
}

export function inputActionBinding(action: InputActionValue): InputActionKeyBinding | undefined {
  for (const entry of BINDINGS) {
    if (entry.action === action) return entry
  }
  return undefined
}

export function inputActionInteractLabel(action: InputActionValue): string {
  for (const entry of BINDINGS) {
    if (entry.action === action) return entry.label
  }
  if (action === InputAction.IA_POINTER) return 'click'
  return `button=${action}`
}

export function inputActionKeyBadge(action: InputActionValue): string | null {
  for (const entry of BINDINGS) {
    if (entry.action === action) return entry.badge
  }
  return null
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
