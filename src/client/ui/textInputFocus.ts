/**
 * True when keyboard focus is in a text field the user is typing into
 * (client chat dock, preferences, scene UI fields, contenteditable, etc.).
 * Highest-priority gate for locomotion / scene key relay.
 */
export function isTextInputFocused(): boolean {
  const el = document.activeElement
  if (!el || !(el instanceof HTMLElement)) return false
  if (!el.isConnected) return false
  if (el.closest('[hidden]')) return false

  const style = window.getComputedStyle(el)
  if (style.display === 'none' || style.visibility === 'hidden') return false

  if (el instanceof HTMLInputElement) {
    if (el.disabled || el.readOnly) return false
    const type = el.type.toLowerCase()
    return (
      type !== 'checkbox' &&
      type !== 'radio' &&
      type !== 'button' &&
      type !== 'submit' &&
      type !== 'reset' &&
      type !== 'file' &&
      type !== 'range' &&
      type !== 'color'
    )
  }
  if (el instanceof HTMLTextAreaElement) return !el.disabled && !el.readOnly
  if (el instanceof HTMLSelectElement) return !el.disabled
  if (el.isContentEditable) return true
  return false
}
