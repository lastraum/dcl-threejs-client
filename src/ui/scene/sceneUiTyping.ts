/** Whether `el` is a scene ECS UiInput / UiDropdown DOM field. */
export function isSceneUiFormField(el: Element | null | undefined): boolean {
  if (!el || !(el instanceof HTMLElement)) return false
  if (!el.closest('#scene-ui-root')) return false
  if (el instanceof HTMLInputElement) {
    if (!el.classList.contains('scene-ui-node__input')) return false
    const type = el.type.toLowerCase()
    return type !== 'checkbox' && type !== 'radio' && type !== 'button' && type !== 'submit' && type !== 'reset'
  }
  return el instanceof HTMLSelectElement && el.classList.contains('scene-ui-node__select')
}

export function isSceneUiTypingFocus(): boolean {
  return isSceneUiFormField(document.activeElement)
}