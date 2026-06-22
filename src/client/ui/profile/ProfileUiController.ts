import type { SessionIdentity } from '../../../network/SessionIdentity'
import type { SocialService } from '../../../social/SocialService'
import { findInteractiveNameTagNear, isClientOverlayTarget } from '../overlayHitTest'
import { setNameTagContextMenuHandler } from '../NameTag'
import { UserContextMenu, type UserContextMenuAction } from './UserContextMenu'
import { UserProfileModal, type UserProfileModalTarget } from './UserProfileModal'

export type ProfileUiControllerOptions = {
  session: SessionIdentity
  social: SocialService
  getPeerUrl: () => string
  onOpenChat?: () => void
  onPrepareOverlay?: () => void
}

/** Central hub for user pill context menus and the shared profile modal. */
export class ProfileUiController {
  private readonly contextMenu: UserContextMenu
  private readonly profileModal: UserProfileModal

  constructor(private readonly options: ProfileUiControllerOptions) {
    this.contextMenu = new UserContextMenu({
      onAction: (action, address) => this.handleContextAction(action, address)
    })
    this.profileModal = new UserProfileModal(
      options.session,
      options.social,
      options.getPeerUrl
    )
    setNameTagContextMenuHandler((address, x, y) => this.openContextMenu(address, x, y))
    document.addEventListener('contextmenu', this.onDocumentContextMenu, true)
  }

  dispose(): void {
    document.removeEventListener('contextmenu', this.onDocumentContextMenu, true)
    setNameTagContextMenuHandler(null)
    this.contextMenu.dispose()
    this.profileModal.dispose()
  }

  openProfile(target: UserProfileModalTarget): void {
    this.prepareOverlay()
    this.contextMenu.hide()
    void this.profileModal.show(target)
  }

  openProfileForAddress(address: string): void {
    const local = this.options.session.getAddress()?.toLowerCase()
    if (local && address.toLowerCase() === local) {
      this.openProfile({ kind: 'local' })
      return
    }
    this.openProfile({ kind: 'remote', address: address.toLowerCase() })
  }

  openContextMenu(address: string, clientX: number, clientY: number): void {
    this.prepareOverlay()
    const key = address.toLowerCase()
    void this.options.social.ensurePeerProfile(key).then(() => {
      const peer = this.options.social.getPeerDisplay(key)
      this.contextMenu.show(key, peer, clientX, clientY)
    })
  }

  private prepareOverlay(): void {
    this.options.onPrepareOverlay?.()
    if (document.pointerLockElement) document.exitPointerLock()
  }

  /** Right-click on canvas near a remote pill — Explorer opens profile options from avatar vicinity. */
  private onDocumentContextMenu = (e: MouseEvent): void => {
    if (isClientOverlayTarget(e.target)) return
    const canvas = document.querySelector('#app canvas')
    if (!canvas || e.target !== canvas) return
    const hit = findInteractiveNameTagNear(e.clientX, e.clientY)
    if (!hit) return
    e.preventDefault()
    e.stopPropagation()
    this.openContextMenu(hit.address, e.clientX, e.clientY)
  }

  private handleContextAction(action: UserContextMenuAction, address: string): void {
    switch (action) {
      case 'view-profile':
        this.openProfileForAddress(address)
        break
      case 'chat':
        this.options.onOpenChat?.()
        console.info(`[profile] Chat with ${address} — open scene chat`)
        break
      case 'add-friend':
      case 'call':
      case 'hush':
      case 'gift':
      case 'report':
      case 'block':
        console.info(`[profile] ${action} — coming soon (${address})`)
        break
      default:
        break
    }
  }
}