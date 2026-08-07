import type { RemoteAvatarManager } from '../../../network/RemoteAvatarManager'
import type { SessionIdentity } from '../../../network/SessionIdentity'
import type { SocialService } from '../../../social/SocialService'
import { PeerPillHover } from '../PeerPillHover'
import {
  findPeerPillAtPointer,
  isClientOverlayTarget,
  setPeerContextMenuHandler,
  setPeerPillHitTestOptions
} from '../overlayHitTest'
import { setNameTagContextMenuHandler } from '../NameTag'
import { UserContextMenu, type UserContextMenuAction } from './UserContextMenu'
import { UserProfileModal, type UserProfileModalTarget } from './UserProfileModal'

export type ProfileUiControllerOptions = {
  session: SessionIdentity
  social: SocialService
  getPeerUrl: () => string
  getRemoteAvatars?: () => RemoteAvatarManager | null
  getCamera?: () => import('three').Camera | null
  onOpenChat?: () => void
  onPrepareOverlay?: () => void
  /** AvatarModifierArea AMT_DISABLE_PASSPORTS — block profile UI for this peer. */
  isPassportDisabled?: (address: string) => boolean
  /** P2P trade invite (from avatar context menu). */
  onTrade?: (address: string) => void
}

/** Central hub for user pill context menus and the shared profile modal. */
export class ProfileUiController {
  private readonly contextMenu: UserContextMenu
  private readonly profileModal: UserProfileModal
  private readonly pillHover: PeerPillHover
  private swallowNextContextMenu = false

  constructor(private readonly options: ProfileUiControllerOptions) {
    this.pillHover = new PeerPillHover({
      getRemoteAvatars: () => options.getRemoteAvatars?.() ?? null,
      getCamera: () => options.getCamera?.() ?? null
    })
    this.pillHover.install()
    setPeerPillHitTestOptions({
      getRemoteAvatars: () => options.getRemoteAvatars?.() ?? null,
      getCamera: () => options.getCamera?.() ?? null
    })
    setPeerContextMenuHandler((address, clientX, clientY) => this.openContextMenu(address, clientX, clientY))

    this.contextMenu = new UserContextMenu({
      onAction: (action, address) => this.handleContextAction(action, address),
      onHide: () => this.onOverlayDismissed()
    })
    this.profileModal = new UserProfileModal(
      options.session,
      options.social,
      options.getPeerUrl,
      () => this.onOverlayDismissed()
    )
    setNameTagContextMenuHandler((address, x, y) => this.openContextMenu(address, x, y))
    document.addEventListener('contextmenu', this.onDocumentContextMenu, true)
  }

  dispose(): void {
    document.removeEventListener('contextmenu', this.onDocumentContextMenu, true)
    setPeerPillHitTestOptions(null)
    setPeerContextMenuHandler(null)
    setNameTagContextMenuHandler(null)
    this.pillHover.dispose()
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
    if (this.options.isPassportDisabled?.(address)) return
    this.openProfile({ kind: 'remote', address: address.toLowerCase() })
  }

  openContextMenu(address: string, clientX: number, clientY: number): void {
    if (this.options.isPassportDisabled?.(address)) return
    // Windows fires `contextmenu` on mouse *up*, after the pointerdown that
    // opened this menu. When the peer is cached the menu is already up by then,
    // and that trailing event lands on the backdrop, which dismisses it.
    this.swallowNextContextMenu = true
    this.prepareOverlay()
    const key = address.toLowerCase()
    void this.options.social.ensureFriendshipSnapshot().then(() => {
      void this.options.social.ensurePeerProfile(key).then(() => {
        const peer = this.options.social.getPeerDisplay(key)
        const relation = this.options.social.getFriendshipRelation(key)
        this.contextMenu.show(key, peer, clientX, clientY, relation)
      })
    })
  }

  private prepareOverlay(): void {
    this.pillHover.setBlocked(true)
    this.options.onPrepareOverlay?.()
    if (document.pointerLockElement) document.exitPointerLock()
  }

  private onOverlayDismissed(): void {
    this.swallowNextContextMenu = false
    this.pillHover.setBlocked(false)
    this.pillHover.refresh()
  }

  /** Right-click on canvas near a remote pill — Explorer opens profile options from avatar vicinity. */
  private onDocumentContextMenu = (e: MouseEvent): void => {
    if (this.swallowNextContextMenu) {
      this.swallowNextContextMenu = false
      e.preventDefault()
      e.stopPropagation()
      return
    }
    if (isClientOverlayTarget(e.target)) return
    const canvas = document.querySelector('#app canvas')
    if (!canvas || e.target !== canvas) return
    const hit = findPeerPillAtPointer(e.clientX, e.clientY)
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
      case 'trade':
        this.options.onTrade?.(address)
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