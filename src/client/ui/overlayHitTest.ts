/** True when the event target is an interactive client overlay (name pill, profile UI). */
export function isClientOverlayTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  return !!target.closest(
    '.avatar-name-tag--interactive, .user-context-menu, .user-context-menu-backdrop, .user-profile-modal, .user-profile-modal-backdrop'
  )
}