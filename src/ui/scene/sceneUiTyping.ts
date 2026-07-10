import { SCENE_UI_ROOT } from './uiDomPick'

/** Whether `el` is the DOM `<input>` / `<select>` for a UiInput or UiDropdown entity. */
export function isSceneUiFieldDom(el: Element | null | undefined): boolean {
  if (!el || !(el instanceof HTMLElement)) return false
  if (!el.closest(SCENE_UI_ROOT)) return false
  if (el instanceof HTMLInputElement) {
    if (!el.classList.contains('scene-ui-node__input')) return false
    const type = el.type.toLowerCase()
    return type !== 'checkbox' && type !== 'radio' && type !== 'button' && type !== 'submit' && type !== 'reset'
  }
  return el instanceof HTMLSelectElement && el.classList.contains('scene-ui-node__select')
}

export function isSceneUiTypingFocus(): boolean {
  return isSceneUiFieldDom(document.activeElement)
}