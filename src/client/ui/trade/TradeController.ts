/**
 * In-client P2P trade orchestration:
 * context-menu invite → countdown modal → dual inventory window → offer sync
 * → on-chain settle (EIP-712 sign by inviter, accept() by invitee).
 */

import type { Address } from 'viem'
import { assetUrnFromCompleteUrn } from '../../../avatar/constants'
import {
  clearOwnedMintNumbersCache,
  loadOwnedMintNumbers,
  ownedTokenIdsForAsset,
  resolveDisplayIssueNumber,
  rarityMaxSupply
} from '../settings/backpackProvenance'
import { fetchOwnedWearableUrns, loadBackpackWearables } from '../settings/backpackWearables'
import {
  wearableShortLabel,
  wearableThumbnailUrl
} from '../profile/wearableThumb'
import { clientDebugLog } from '../../debug/ClientDebugLog'
import { polygonPublicClient } from '../../../lootBag/polygonClient'
import type { SessionIdentity } from '../../../network/SessionIdentity'
import type { SocialService } from '../../../social/SocialService'
import {
  getPrivateMessagesService,
  type PrivateMessagesService,
  type TradeDataEvent
} from '../../../social/PrivateMessagesService'
import {
  emptyOffer,
  newTradeSessionId,
  TRADE_INVITE_TTL_MS,
  type TradeItemWire,
  type TradeOfferSnapshot,
  type TradeWireMsg
} from '../../../social/tradeWire'

/** sessionStorage: tokens received via in-client settle (indexes lag badly for new owners). */
const RECEIVED_ITEMS_STORAGE_KEY = 'd3js.trade.receivedItems.v1'
/** sessionStorage: collection contracts we've settled — for ERC721Enumerable bootstrap. */
const TOUCHED_CONTRACTS_STORAGE_KEY = 'd3js.trade.touchedContracts.v1'
import { TradeInviteModal } from './TradeInviteModal'
import { TradeResultModal } from './TradeResultModal'
import { TradeWindow, type TradeInventoryItem } from './TradeWindow'
import { ASSET_TYPE, erc721Abi } from './marketplaceConfig'
import {
  acceptTradeOnChain,
  deserializeSettlePayload,
  prepareLocalApprovals,
  signTradeForSettlement,
  type SettleSignPayload
} from './marketplaceSettle'
import { showHudConfirm } from '../../../player/hudConfirm'

/** Drop catalog ghosts — catalyst/marketplace lag after a settle. */
async function filterInventoryByOnChainOwner(
  owner: string,
  items: TradeInventoryItem[]
): Promise<TradeInventoryItem[]> {
  const want = owner.trim().toLowerCase()
  if (!want || items.length === 0) return items

  const eligible = items.filter(
    (it) =>
      !!it.c &&
      /^0x[a-f0-9]{40}$/.test(it.c) &&
      !!it.tid &&
      /^\d+$/.test(it.tid)
  )
  if (eligible.length === 0) return []

  const BATCH = 40
  const ownedKeys = new Set<string>()
  for (let i = 0; i < eligible.length; i += BATCH) {
    const batch = eligible.slice(i, i + BATCH)
    try {
      const results = await polygonPublicClient.multicall({
        allowFailure: true,
        contracts: batch.map((it) => ({
          address: it.c!.toLowerCase() as Address,
          abi: erc721Abi,
          functionName: 'ownerOf' as const,
          args: [BigInt(it.tid!)] as const
        }))
      })
      for (let j = 0; j < batch.length; j++) {
        const r = results[j]
        if (!r || r.status !== 'success') continue
        const actual = String(r.result).toLowerCase()
        if (actual === want) {
          ownedKeys.add(batch[j]!.key.toLowerCase())
        }
      }
    } catch {
      // Multicall failed — fall back to sequential for this batch.
      for (const it of batch) {
        try {
          const actual = (await polygonPublicClient.readContract({
            address: it.c!.toLowerCase() as Address,
            abi: erc721Abi,
            functionName: 'ownerOf',
            args: [BigInt(it.tid!)]
          })) as string
          if (actual.toLowerCase() === want) ownedKeys.add(it.key.toLowerCase())
        } catch {
          /* not owned / missing */
        }
      }
    }
  }

  return items.filter((it) => ownedKeys.has(it.key.toLowerCase()))
}

export type TradeControllerOptions = {
  session: SessionIdentity
  social: SocialService
  getPeerUrl: () => string
  onPrepareOverlay?: () => void
  /** Optional toast host. */
  pushToast?: (title: string, sub?: string) => void
}

type SessionRole = 'inviter' | 'invitee'

type ActiveSession = {
  id: string
  peer: string
  role: SessionRole
  peerName: string
  peerFaceUrl?: string | null
  localOffer: TradeOfferSnapshot
  peerOffer: TradeOfferSnapshot
}

export class TradeController {
  private readonly pm: PrivateMessagesService
  private unsub: (() => void) | null = null
  private inviteModal: TradeInviteModal | null = null
  private tradeWindow: TradeWindow | null = null
  private resultModal: TradeResultModal | null = null
  private active: ActiveSession | null = null
  /** Outgoing invite waiting for accept/decline. */
  private pendingInvite: {
    id: string
    peer: string
    peerName: string
    expiresAt: number
    timer: number
  } | null = null
  private disposed = false
  private inventoryCache: TradeInventoryItem[] | null = null
  /** Prevent double settle when both sides fire onBothAccepted. */
  private settling = false
  /**
   * Invitee approvals-first prep. Accept waits on this if settle_sign arrives early
   * so we never call accept() before marketplace approvals are confirmed.
   */
  private preApprovePromise: Promise<void> | null = null
  /**
   * URNs / token keys we just transferred out. Catalyst + marketplace lag can still
   * list them for minutes; hide from trade inventory until indexes catch up.
   */
  private recentlyTransferredKeys = new Set<string>()

  constructor(private readonly options: TradeControllerOptions) {
    this.pm = getPrivateMessagesService()
    this.unsub = this.pm.subscribeTrade((ev) => this.onTradeEvent(ev))
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.unsub?.()
    this.unsub = null
    this.clearPendingInvite(false)
    this.closeSessionUi()
    this.resultModal?.dispose()
    this.resultModal = null
    this.active = null
    this.settling = false
    this.preApprovePromise = null
  }

  /**
   * Start a trade with a remote peer (from avatar context menu).
   */
  async invitePeer(peerAddress: string): Promise<void> {
    const peer = peerAddress.trim().toLowerCase()
    const me = this.localAddress()
    if (!me || !peer || peer === me) return
    if (this.active || this.pendingInvite || this.inviteModal) {
      this.toast('Trade busy', 'Finish or cancel the current trade first.')
      return
    }

    await this.ensurePmConnected()
    if (!this.pm.isConnected()) {
      this.toast('Trade offline', 'Private messages room is not connected.')
      return
    }

    await this.options.social.ensurePeerProfile(peer)
    const peerName =
      this.options.social.getPeerDisplay(peer)?.displayName || peer.slice(0, 10)

    // Soft warning — dual-publish still room-broadcasts, but peer must share the PM room.
    if (!this.pm.hasPeerInRoom(peer)) {
      clientDebugLog.log(
        'social',
        `Trade invite: peer ${peer.slice(0, 10)}… not in PM room yet (will room-broadcast)`,
        { level: 'warn', alsoConsole: true }
      )
    }

    const id = newTradeSessionId()
    const at = Date.now()
    const exp = at + TRADE_INVITE_TTL_MS
    const msg: TradeWireMsg = {
      t: 'invite',
      id,
      from: me,
      to: peer,
      n: this.localDisplayName(),
      exp,
      at
    }

    const sent = await this.pm.sendTrade(msg, peer)
    if (!sent) {
      this.toast(
        'Invite failed',
        this.pm.getLastError() ||
          'Could not reach peer. Both players need private messages online.'
      )
      return
    }

    this.pendingInvite = {
      id,
      peer,
      peerName,
      expiresAt: exp,
      timer: window.setTimeout(() => {
        if (this.pendingInvite?.id === id) {
          this.toast('Trade invite expired', peerName)
          void this.sendSimple('invite_cancel', id, peer)
          this.clearPendingInvite(false)
        }
      }, TRADE_INVITE_TTL_MS)
    }

    this.toast('Trade invite sent', `Waiting for ${peerName}…`)
    clientDebugLog.log('social', `Trade invite → ${peer.slice(0, 10)}… id=${id.slice(0, 8)}`, {
      level: 'info',
      alsoConsole: true
    })
  }

  private onTradeEvent(ev: TradeDataEvent): void {
    if (this.disposed) return
    const { msg } = ev
    const me = this.localAddress()
    if (!me) return
    // fromAddress is LiveKit-authenticated (PM layer overwrites spoofed wire `from`).
    const from = (ev.fromAddress || msg.from || '').toLowerCase()
    if (!from || !/^0x[a-f0-9]{40}$/.test(from)) return
    // Belt-and-suspenders: never process as peer if body still disagrees.
    if (msg.from && msg.from.toLowerCase() !== from) return

    switch (msg.t) {
      case 'invite': {
        const to = (msg.to || '').toLowerCase()
        if (to !== me) {
          clientDebugLog.log(
            'social',
            `Trade invite skipped (to≠me) to=${to.slice(0, 10)}… me=${me.slice(0, 10)}…`,
            { level: 'info', alsoConsole: true }
          )
          return
        }
        // Re-bind invite body to authenticated sender before UI/session use.
        msg.from = from
        void this.onIncomingInvite(msg)
        break
      }
      case 'invite_accept':
        if (this.pendingInvite?.id === msg.id && from === this.pendingInvite.peer) {
          void this.openAsInviter(from)
        }
        break
      case 'invite_decline':
      case 'invite_cancel':
        if (this.pendingInvite?.id === msg.id && from === this.pendingInvite.peer) {
          this.toast(
            msg.t === 'invite_decline' ? 'Trade declined' : 'Trade cancelled',
            this.pendingInvite.peerName
          )
          this.clearPendingInvite(false)
        }
        if (this.inviteModal && this.active?.id === msg.id && from === this.active.peer) {
          this.inviteModal.dispose()
          this.inviteModal = null
        }
        if (this.active?.id === msg.id && msg.t === 'invite_cancel' && from === this.active.peer) {
          this.closeSession('Trade cancelled')
        }
        break
      case 'offer':
        if (this.active?.id === msg.id && from === this.active.peer) {
          this.active.peerOffer = msg.offer
          this.tradeWindow?.setPeerOffer(msg.offer)
          if (msg.offer.accepted && this.active.localOffer.accepted) {
            this.onBothAccepted()
          }
        }
        break
      case 'trade_cancel':
        if (this.active?.id === msg.id && from === this.active.peer) {
          this.settling = false
          // If we already finished, ignore peer cancel noise.
          if (this.tradeWindow?.isTerminal()) break
          this.showTradeFailed('Peer cancelled the trade')
        }
        break
      case 'trade_complete':
        // Only the counterparty (or we ignore self) — must be session peer.
        if (this.active?.id === msg.id && from === this.active.peer) {
          this.settling = false
          const tx = msg.tx ? String(msg.tx).trim() : ''
          this.showTradeSuccess(
            'Trade complete',
            tx && /^0x[a-fA-F0-9]{64}$/.test(tx)
              ? `Items swapped on Polygon · Tx ${tx.slice(0, 12)}…`
              : 'Items swapped on Polygon via marketplace settle.',
            tx
          )
        }
        break
      case 'settle_sign':
        if (this.active?.id === msg.id && from === this.active.peer) {
          // Payload EIP-712 signer must be the authenticated peer (inviter).
          if (!this.settlePayloadSignerMatchesPeer(msg.payload, from)) {
            clientDebugLog.log(
              'social',
              `Trade settle_sign REJECT · payload signer ≠ peer ${from.slice(0, 10)}…`,
              { level: 'warn', alsoConsole: true }
            )
            this.showTradeFailed('Invalid trade signature party — peer identity mismatch')
            break
          }
          this.seedFromIncomingSettlePayload(msg.payload)
          void this.runAcceptorSettle(msg.payload)
        }
        break
      case 'settle_fail':
        if (this.active?.id === msg.id && from === this.active.peer) {
          this.settling = false
          this.showTradeFailed(msg.err || 'Settlement failed')
        }
        break
      default:
        break
    }
  }

  /** True when settle_sign payload's on-chain trade.signer is the LiveKit peer. */
  private settlePayloadSignerMatchesPeer(payload: unknown, peer: string): boolean {
    try {
      const trade = deserializeSettlePayload(payload as SettleSignPayload)
      return trade.signer.toLowerCase() === peer.toLowerCase()
    } catch {
      return false
    }
  }

  private async onIncomingInvite(
    msg: Extract<TradeWireMsg, { t: 'invite' }>
  ): Promise<void> {
    const peer = (msg.from || '').toLowerCase()
    if (!peer) return

    // Already in a trade with someone else — decline.
    if (this.active && this.active.peer !== peer) {
      clientDebugLog.log('social', 'Trade invite auto-decline (busy in other trade)', {
        level: 'info',
        alsoConsole: true
      })
      await this.sendSimple('invite_decline', msg.id, peer)
      return
    }
    if (this.active && this.active.peer === peer) {
      // Already trading this peer — ignore duplicate invite.
      return
    }

    // Mutual invite: both sides sent invites. Pick one session id deterministically
    // so we don't silently auto-decline each other (common production failure).
    if (this.pendingInvite && this.pendingInvite.peer === peer) {
      const ourId = this.pendingInvite.id
      const theirId = msg.id
      clientDebugLog.log(
        'social',
        `Trade mutual invite · ours=${ourId.slice(0, 8)}… theirs=${theirId.slice(0, 8)}…`,
        { level: 'info', alsoConsole: true }
      )
      if (ourId <= theirId) {
        // We stay inviter with our session id; open trade window.
        void this.openAsInviter(peer)
      } else {
        // Their session wins — we become invitee (no modal needed; both intended to trade).
        const peerName = this.pendingInvite.peerName
        const peerFaceUrl = this.options.social.getPeerDisplay(peer)?.faceUrl
        this.clearPendingInvite(false)
        void this.acceptIncoming(theirId, peer, peerName, peerFaceUrl)
      }
      return
    }

    if (this.inviteModal) {
      // Already showing an invite UI — decline this one.
      await this.sendSimple('invite_decline', msg.id, peer)
      return
    }

    // Grace period for clock skew (was hard drop when exp <= now).
    if (msg.exp + 5_000 <= Date.now()) {
      clientDebugLog.log('social', 'Trade invite ignored (expired)', {
        level: 'info',
        alsoConsole: true
      })
      return
    }

    this.options.onPrepareOverlay?.()
    if (document.pointerLockElement) document.exitPointerLock()

    await this.options.social.ensurePeerProfile(peer)
    const display = this.options.social.getPeerDisplay(peer)
    const peerName = msg.n || display?.displayName || peer.slice(0, 10)
    const peerFaceUrl = display?.faceUrl

    clientDebugLog.log(
      'social',
      `Trade invite UI · from=${peerName} id=${msg.id.slice(0, 8)}…`,
      { level: 'success', alsoConsole: true }
    )

    this.inviteModal = new TradeInviteModal({
      peerName,
      peerFaceUrl,
      expiresAt: Math.max(msg.exp, Date.now() + 15_000),
      onAccept: () => {
        this.inviteModal = null
        void this.acceptIncoming(msg.id, peer, peerName, peerFaceUrl)
      },
      onDecline: () => {
        this.inviteModal = null
        void this.sendSimple('invite_decline', msg.id, peer)
      },
      onExpire: () => {
        this.inviteModal = null
        void this.sendSimple('invite_decline', msg.id, peer)
      }
    })
  }

  private async acceptIncoming(
    id: string,
    peer: string,
    peerName: string,
    peerFaceUrl?: string | null
  ): Promise<void> {
    const me = this.localAddress()
    if (!me) return
    await this.sendSimple('invite_accept', id, peer)
    this.active = {
      id,
      peer,
      role: 'invitee',
      peerName,
      peerFaceUrl,
      localOffer: emptyOffer(),
      peerOffer: emptyOffer()
    }
    await this.openTradeWindow()
  }

  private async openAsInviter(peer: string): Promise<void> {
    const pending = this.pendingInvite
    if (!pending || pending.peer !== peer) return
    this.clearPendingInvite(false)
    this.active = {
      id: pending.id,
      peer,
      role: 'inviter',
      peerName: pending.peerName,
      peerFaceUrl: this.options.social.getPeerDisplay(peer)?.faceUrl,
      localOffer: emptyOffer(),
      peerOffer: emptyOffer()
    }
    await this.openTradeWindow()
  }

  private async openTradeWindow(): Promise<void> {
    if (!this.active) return
    this.options.onPrepareOverlay?.()
    if (document.pointerLockElement) document.exitPointerLock()

    // Open chrome immediately — inventory (Catalyst + chain checks) loads in background.
    // Guests were waiting several seconds before seeing the window at all.
    const localName = this.localDisplayName()
    const localFace = this.options.social.getPeerDisplay(this.localAddress() || '')?.faceUrl
    const sessionId = this.active.id

    this.tradeWindow?.dispose()
    this.tradeWindow = new TradeWindow({
      localName,
      localFaceUrl: localFace,
      peerName: this.active.peerName,
      peerFaceUrl: this.active.peerFaceUrl,
      peerAddress: this.active.peer,
      inventory: [],
      inventoryLoading: true,
      onLocalOfferChange: (offer) => {
        void this.publishLocalOffer(offer)
      },
      onClose: () => {
        void this.requestCloseTrade()
      },
      onAcceptTrade: () => {
        // Offer already published with accepted=true; wait for peer mirror.
        if (this.active?.localOffer.accepted && this.active.peerOffer.accepted) {
          this.onBothAccepted()
        }
      }
    })

    this.inventoryCache = null
    void this.loadInventory()
      .then((inventory) => {
        if (!this.active || this.active.id !== sessionId || !this.tradeWindow) return
        this.tradeWindow.setInventory(inventory, false)
      })
      .catch((err) => {
        if (!this.tradeWindow || !this.active || this.active.id !== sessionId) return
        this.tradeWindow.setInventory([], false)
        this.toast(
          'Inventory load failed',
          err instanceof Error ? err.message : String(err)
        )
      })
  }

  /** Confirm before abandoning an open trade (X, backdrop, Escape). */
  private async requestCloseTrade(): Promise<void> {
    if (!this.active && !this.tradeWindow) {
      this.closeSessionUi()
      return
    }
    if (this.settling || this.tradeWindow?.getPhase() === 'settling') {
      this.toast(
        'Settlement in progress',
        'Wait for signing / meta-tx to finish before closing.'
      )
      return
    }
    const ok = await showHudConfirm({
      title: 'Cancel this trade?',
      message:
        'Close the trade window? Your offer will be cancelled and the other player will be notified.',
      confirmLabel: 'Cancel trade',
      cancelLabel: 'Keep trading'
    })
    if (!ok) return
    await this.cancelActive()
  }

  /** Close trade UI without notifying peer (session already finished). */
  private dismissTradeWindow(): void {
    this.settling = false
    this.preApprovePromise = null
    this.closeSessionUi()
    this.active = null
  }

  private showTradeSuccess(_title: string, detail: string, txHash?: string): void {
    this.settling = false
    // Items I sent leave; items peer offered arrive (indexes lag for new owners — seed inventory).
    this.markLocalItemsTransferred()
    this.rememberReceivedFromPeerOffer()
    const me = this.localAddress()
    if (me) clearOwnedMintNumbersCache(me)
    this.inventoryCache = null

    const tx = (txHash || '').trim()
    const validTx = /^0x[a-fA-F0-9]{64}$/.test(tx) ? tx : null
    const short = validTx ? `${validTx.slice(0, 12)}…` : ''
    const fullDetail =
      detail ||
      (short
        ? `Items swapped on Polygon · Tx ${short}`
        : 'Items swapped on Polygon via marketplace settle.')

    // Close the dual-panel trade window; show a compact success modal instead.
    this.dismissTradeWindow()
    this.openResultModal({
      kind: 'success',
      title: 'Trade Success!',
      detail: fullDetail,
      txHash: validTx
    })
    clientDebugLog.log('social', `Trade Success! — ${fullDetail}${validTx ? ` ${validTx}` : ''}`, {
      level: 'success',
      alsoConsole: true
    })
  }

  private openResultModal(opts: {
    kind: 'success' | 'failed'
    title: string
    detail?: string
    txHash?: string | null
  }): void {
    this.resultModal?.dispose()
    this.options.onPrepareOverlay?.()
    if (document.pointerLockElement) document.exitPointerLock()
    this.resultModal = new TradeResultModal({
      kind: opts.kind,
      title: opts.title,
      detail: opts.detail,
      txHash: opts.txHash,
      onClose: () => {
        this.resultModal = null
      }
    })
  }

  /** Remember tokens we sent so the next inventory load doesn't re-offer them. */
  private markLocalItemsTransferred(): void {
    const offer = this.active?.localOffer
    if (!offer) return
    for (const it of offer.items) {
      const urn = (it.urn || '').trim().toLowerCase()
      if (urn) this.recentlyTransferredKeys.add(urn)
      const tid = (it.tid || '').trim()
      const c = (it.c || '').trim().toLowerCase()
      if (c && tid) this.recentlyTransferredKeys.add(`tid:${c}:${tid}`)
      // Also drop from received-seed if we just sold it again.
      if (c && tid) removeRememberedReceivedToken(this.localAddress(), c, tid)
    }
  }

  /**
   * Peer offer items become ours after settle. Catalyst/marketplace often list them
   * under the *old* owner for a long time — seed trade inventory from this snapshot.
   */
  private rememberReceivedFromPeerOffer(): void {
    const me = this.localAddress()
    const offer = this.active?.peerOffer
    if (!me || !offer?.items.length) return
    rememberReceivedItems(me, offer.items)
    rememberTouchedContractsFromOffer(offer)
    rememberTouchedContractsFromOffer(this.active?.localOffer)
    clientDebugLog.log(
      'social',
      `Trade inventory seed +${offer.items.length} received item(s) for ${me.slice(0, 10)}…`,
      { level: 'info', alsoConsole: true }
    )
  }

  /**
   * Invitee: signed trade lists exact ERC-721s moving to us (`sent`).
   * Seed inventory + touched collections even if Catalyst still empty.
   */
  private seedFromIncomingSettlePayload(raw: unknown): void {
    const me = this.localAddress()
    if (!me || !raw || typeof raw !== 'object') return
    try {
      const trade = deserializeSettlePayload(raw as SettleSignPayload)
      const wires: TradeItemWire[] = []
      for (const a of trade.sent) {
        if (a.assetType !== ASSET_TYPE.ERC721) continue
        const c = a.contractAddress.toLowerCase()
        const tid = a.value.toString()
        rememberTouchedContract(c)
        const peerHit = this.active?.peerOffer.items.find(
          (i) =>
            (i.tid && i.tid === tid) ||
            (i.c && i.c.toLowerCase() === c && i.urn?.includes(tid))
        )
        wires.push({
          urn:
            peerHit?.urn ||
            `urn:decentraland:matic:collections-v2:${c}:${(a.value >> 216n).toString()}:${tid}`,
          name: peerHit?.name,
          img: peerHit?.img,
          r: peerHit?.r,
          c,
          tid,
          issue: peerHit?.issue,
          max: peerHit?.max
        })
      }
      if (wires.length) rememberReceivedItems(me, wires)
    } catch {
      /* ignore bad payload */
    }
  }

  private showTradeFailed(detail: string): void {
    this.settling = false
    const msg = (detail || 'Settlement failed').trim()
    this.dismissTradeWindow()
    this.openResultModal({
      kind: 'failed',
      title: 'Trade Failed',
      detail: msg
    })
    clientDebugLog.log('social', `Trade failed — ${msg}`, {
      level: 'error',
      alsoConsole: true
    })
  }

  private async publishLocalOffer(offer: TradeOfferSnapshot): Promise<void> {
    if (!this.active) return
    this.active.localOffer = offer
    const me = this.localAddress()
    if (!me) return
    const msg: TradeWireMsg = {
      t: 'offer',
      id: this.active.id,
      from: me,
      to: this.active.peer,
      offer,
      at: Date.now()
    }
    await this.pm.sendTrade(msg, this.active.peer)
    if (offer.accepted && this.active.peerOffer.accepted) {
      this.onBothAccepted()
    }
  }

  private onBothAccepted(): void {
    if (!this.active || this.settling) return
    this.settling = true
    this.tradeWindow?.setSettling(
      true,
      'Settling…',
      'Approvals first, then on-chain trade — keep this window open.'
    )
    clientDebugLog.log(
      'social',
      `Trade both-accepted → settle id=${this.active.id.slice(0, 8)} role=${this.active.role} local=${this.active.localOffer.items.length} peer=${this.active.peerOffer.items.length}`,
      { level: 'success', alsoConsole: true }
    )
    // Both sides: approvals first. Inviter then EIP-712 signs; invitee waits for settle_sign.
    if (this.active.role === 'inviter') {
      void this.runSignerSettle()
    } else {
      void this.runAcceptorPreApprove()
    }
  }

  /**
   * Invitee: check + set marketplace approvals immediately when both accept,
   * before the inviter's signed trade arrives. Trade accept() only after that.
   */
  private async runAcceptorPreApprove(): Promise<void> {
    const session = this.active
    if (!session || session.role !== 'invitee') return
    const me = this.localAddress()
    if (!me) {
      this.settling = false
      this.preApprovePromise = null
      return
    }
    const run = (async () => {
      this.toast(
        'Approvals first…',
        'Checking ownership + marketplace approvals before the trade (no network switch).'
      )
      await prepareLocalApprovals({
        sessionAddress: me,
        isGuest: this.options.session.isGuest(),
        offer: session.localOffer,
        note: (m) => {
          this.toast('Approvals', m)
          clientDebugLog.log('social', `Trade settle (acceptor prep): ${m}`, {
            level: 'info',
            alsoConsole: true
          })
        }
      })
      // Still in settling — wait for settle_sign from inviter.
      if (!this.active || this.active.id !== session.id) return
      this.toast(
        'Approvals ready — waiting for peer',
        'They sign the trade next; you will meta-tx accept when it arrives.'
      )
    })()
    this.preApprovePromise = run
    try {
      await run
    } catch (err) {
      // Leave preApprovePromise rejected so a racing settle_sign awaits it and aborts.
      const detail = err instanceof Error ? err.message : String(err)
      this.showTradeFailed(detail)
      await this.sendSettleFail(session.id, session.peer, detail)
    }
  }

  private async runSignerSettle(): Promise<void> {
    const session = this.active
    if (!session || session.role !== 'inviter') return
    const me = this.localAddress()
    if (!me) {
      this.settling = false
      this.tradeWindow?.setSettling(false)
      return
    }
    try {
      this.tradeWindow?.setSettling(
        true,
        'Approvals first…',
        'Ownership + marketplace approvals, then you sign the trade.'
      )
      const payload = await signTradeForSettlement({
        sessionAddress: me,
        isGuest: this.options.session.isGuest(),
        signerOffer: session.localOffer,
        acceptorOffer: session.peerOffer,
        acceptorAddress: session.peer,
        note: (m) => {
          this.toast('Settle', m)
          clientDebugLog.log('social', `Trade settle (signer): ${m}`, {
            level: 'info',
            alsoConsole: true
          })
        }
      })
      const msg: TradeWireMsg = {
        t: 'settle_sign',
        id: session.id,
        from: me,
        to: session.peer,
        at: Date.now(),
        payload
      }
      const sent = await this.pm.sendTrade(msg, session.peer)
      if (!sent) throw new Error(this.pm.getLastError() || 'Failed to send signed trade to peer')
      this.toast(
        'Trade signed — waiting for peer',
        'They will meta-tx accept() — keep this window open until complete.'
      )
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      this.showTradeFailed(detail)
      await this.sendSettleFail(session.id, session.peer, detail)
      clientDebugLog.log('social', `Trade settle signer failed: ${detail}`, {
        level: 'error',
        alsoConsole: true
      })
    }
  }

  private async runAcceptorSettle(rawPayload: unknown): Promise<void> {
    const session = this.active
    if (!session || session.role !== 'invitee') return
    const me = this.localAddress()
    if (!me) {
      this.settling = false
      return
    }
    if (!rawPayload || typeof rawPayload !== 'object') {
      this.showTradeFailed('Invalid settle payload from peer')
      return
    }
    try {
      this.settling = true
      this.tradeWindow?.setSettling(
        true,
        'Confirming on-chain…',
        'Re-check approvals, then meta-tx accept.'
      )
      // If early approvals are still in flight, wait — never accept before they finish.
      if (this.preApprovePromise) {
        this.toast('Settle', 'Finishing marketplace approvals first…')
        try {
          await this.preApprovePromise
        } catch {
          // prep already showed fail result + settle_fail; abort accept
          return
        }
      }
      const hash = await acceptTradeOnChain({
        sessionAddress: me,
        isGuest: this.options.session.isGuest(),
        payload: rawPayload as SettleSignPayload,
        acceptorOffer: session.localOffer,
        note: (m) => {
          this.toast('Settle', m)
          clientDebugLog.log('social', `Trade settle (acceptor): ${m}`, {
            level: 'info',
            alsoConsole: true
          })
        }
      })
      const complete: TradeWireMsg = {
        t: 'trade_complete',
        id: session.id,
        from: me,
        to: session.peer,
        at: Date.now(),
        tx: hash
      }
      await this.pm.sendTrade(complete, session.peer)
      this.showTradeSuccess(
        'Trade complete',
        `Items swapped on Polygon · Tx ${hash.slice(0, 12)}…`,
        hash
      )
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      this.showTradeFailed(detail)
      await this.sendSettleFail(session.id, session.peer, detail)
      clientDebugLog.log('social', `Trade settle acceptor failed: ${detail}`, {
        level: 'error',
        alsoConsole: true
      })
    }
  }

  private async sendSettleFail(id: string, peer: string, err: string): Promise<void> {
    const me = this.localAddress()
    if (!me) return
    const msg: TradeWireMsg = {
      t: 'settle_fail',
      id,
      from: me,
      to: peer,
      at: Date.now(),
      err
    }
    await this.pm.sendTrade(msg, peer)
  }

  private async cancelActive(): Promise<void> {
    if (!this.active) {
      this.closeSessionUi()
      return
    }
    const { id, peer } = this.active
    await this.sendSimple('trade_cancel', id, peer)
    this.closeSession('Trade closed')
  }

  private closeSession(reason?: string): void {
    if (reason) this.toast(reason)
    this.settling = false
    this.closeSessionUi()
    this.active = null
  }

  private closeSessionUi(): void {
    this.inviteModal?.dispose()
    this.inviteModal = null
    this.tradeWindow?.dispose()
    this.tradeWindow = null
  }

  private clearPendingInvite(sendCancel: boolean): void {
    if (!this.pendingInvite) return
    if (sendCancel) {
      void this.sendSimple('invite_cancel', this.pendingInvite.id, this.pendingInvite.peer)
    }
    window.clearTimeout(this.pendingInvite.timer)
    this.pendingInvite = null
  }

  private async sendSimple(
    t: 'invite_accept' | 'invite_decline' | 'invite_cancel' | 'trade_cancel',
    id: string,
    peer: string
  ): Promise<void> {
    const me = this.localAddress()
    if (!me) return
    const msg: TradeWireMsg = { t, id, from: me, to: peer, at: Date.now() }
    await this.pm.sendTrade(msg, peer)
  }

  private async ensurePmConnected(): Promise<void> {
    const identity = this.options.session.getAuthIdentity()
    const addr = this.localAddress()
    if (!identity || !addr) return
    if (!this.pm.isConnected()) {
      await this.pm.connect(identity, addr)
    }
  }

  private localAddress(): string | null {
    return this.options.session.getAddress()?.toLowerCase() ?? null
  }

  private localDisplayName(): string {
    const addr = this.localAddress()
    if (!addr) return 'You'
    const p = this.options.social.getPeerDisplay(addr)
    return p?.displayName || 'You'
  }

  private async loadInventory(): Promise<TradeInventoryItem[]> {
    if (this.inventoryCache) return this.inventoryCache
    const addr = this.localAddress()
    if (!addr) return []
    const peerUrl = this.options.getPeerUrl().replace(/\/$/, '')
    const lambdasUrl = (
      this.options.session.getLambdasUrl?.() || `${peerUrl}/lambdas`
    ).replace(/\/$/, '')
    try {
      // Parallel: every owned token instance + backpack metadata + marketplace issue #s.
      // Empty catalyst is normal for brand-new owners / some guests — do not throw away.
      const [owned, metaItems, mintMap] = await Promise.all([
        fetchOwnedWearableUrns(addr, lambdasUrl).catch(() => [] as { urn: string; amount?: number }[]),
        loadBackpackWearables(addr, lambdasUrl).catch(() => []),
        loadOwnedMintNumbers(addr).catch(() => new Map<string, string>())
      ])

      const metaByAsset = new Map(
        metaItems.map((m) => [assetUrnFromCompleteUrn(m.urn).toLowerCase(), m] as const)
      )

      // Expand asset-only catalyst rows (no token id) into marketplace instances.
      // wearables-by-owner often returns …:itemId without individualData.
      type InstanceRow = { urn: string }
      const instanceRows: InstanceRow[] = []
      for (const row of owned) {
        const urn = row.urn?.trim()
        if (!urn) continue
        if (urn.includes(':base-avatars:') || urn.includes('off-chain:base-avatars')) continue
        if (urn.includes('basemale') || urn.includes('basefemale')) continue

        const assetUrn = assetUrnFromCompleteUrn(urn)
        const tokenParts = urn.split(':')
        const isV2 = tokenParts[3] === 'collections-v2'
        const contract = parseContract(urn)
        const itemIdSeg = isV2 && tokenParts[5] != null ? tokenParts[5] : undefined
        const isAssetOnly = urn.toLowerCase() === assetUrn.toLowerCase()

        if (!isAssetOnly) {
          instanceRows.push({ urn })
          continue
        }

        // Asset URN only — resolve every owned on-chain token for this item.
        const fromMarket = ownedTokenIdsForAsset(mintMap, assetUrn, {
          contract,
          itemId: itemIdSeg
        })
        if (fromMarket.length > 0) {
          for (const tid of fromMarket) {
            instanceRows.push({ urn: `${assetUrn}:${tid}` })
          }
        } else {
          // No marketplace token id — cannot settle; skip rather than offer a broken item.
          clientDebugLog.log(
            'social',
            `Trade inventory skip (no token id): ${metaByAsset.get(assetUrn.toLowerCase())?.name || assetUrn}`,
            { level: 'warn', alsoConsole: true }
          )
        }
      }

      // Marketplace index keys: prefer instance URNs whose tail is the full ERC-721 id.
      // Keys that only suffix issuedId (…:itemId:2138) are also present and would create a
      // second "copy" of the same NFT in the picker if we took every 7-segment key.
      for (const k of mintMap.keys()) {
        if (!k.startsWith('urn:decentraland:')) continue
        const parts = k.split(':')
        if (parts[3] !== 'collections-v2' || parts.length < 7) continue
        const tail = (parts[parts.length - 1] || '').trim()
        if (!/^\d+$/.test(tail)) continue
        // Skip short issuedId-only tails when we can map them — they'll resolve to the
        // same packed token as the long-tail key and duplicate the card.
        if (tail.length <= 18) {
          const contract = (parts[4] || '').toLowerCase()
          const itemId = parts[5]
          const packed =
            (contract && itemId
              ? mintMap.get(`tok:${contract}:${itemId}:${tail}`)
              : undefined) || (contract ? mintMap.get(`tok:${contract}:${tail}`) : undefined)
          if (packed && packed !== tail) continue
        }
        instanceRows.push({ urn: k })
      }

      const items: TradeInventoryItem[] = []
      /** One card per on-chain NFT: contract + tokenId (not per catalog URN spelling). */
      const seenToken = new Set<string>()
      for (const row of instanceRows) {
        const urn = row.urn?.trim()
        if (!urn) continue

        // Skip items we just settled away (indexes lag for a while).
        if (this.recentlyTransferredKeys.has(urn.toLowerCase())) continue

        const assetUrn = assetUrnFromCompleteUrn(urn)
        const meta = metaByAsset.get(assetUrn.toLowerCase())
        const rarity = (meta?.rarity || 'common').toLowerCase()
        const max = rarityMaxSupply(rarity)
        const tokenParts = urn.split(':')
        const isV2 = tokenParts[3] === 'collections-v2'
        const contract = parseContract(urn)
        const itemIdSeg = isV2 && tokenParts[5] != null ? tokenParts[5] : undefined
        // Instance URN last segment — packed tokenId (or short issuedId to resolve).
        const tail =
          urn.toLowerCase() !== assetUrn.toLowerCase()
            ? (tokenParts[tokenParts.length - 1] || '').trim()
            : ''
        let tokenId = /^\d+$/.test(tail) ? tail : undefined
        const issueFromMap = resolveDisplayIssueNumber(mintMap, urn) ?? undefined

        if (contract && mintMap.size > 0) {
          const packed =
            (issueFromMap && itemIdSeg
              ? mintMap.get(`tok:${contract}:${itemIdSeg}:${issueFromMap}`)
              : undefined) ||
            (issueFromMap ? mintMap.get(`tok:${contract}:${issueFromMap}`) : undefined) ||
            (tokenId && tokenId.length <= 18
              ? mintMap.get(`tok:${contract}:${tokenId}`) ||
                (itemIdSeg
                  ? mintMap.get(`tok:${contract}:${itemIdSeg}:${tokenId}`)
                  : undefined)
              : undefined)
          // Only replace with packed when the short tail is truly an issuedId for this token.
          // Never let a different token's reverse map steal this row's identity.
          if (
            packed &&
            /^\d+$/.test(packed) &&
            tokenId &&
            tokenId.length <= 18 &&
            packed.length >= tokenId.length
          ) {
            tokenId = packed
          } else if (packed && /^\d+$/.test(packed) && !tokenId) {
            tokenId = packed
          }
        }

        // Still no token id — not tradable on-chain.
        if (!tokenId) continue
        if (contract && this.recentlyTransferredKeys.has(`tid:${contract}:${tokenId}`)) continue

        // Critical: two URN spellings (…:issuedId vs …:packedTokenId) = same NFT.
        const tokenKey = `${(contract || '').toLowerCase()}:${tokenId}`
        if (seenToken.has(tokenKey)) continue
        seenToken.add(tokenKey)

        let instanceUrn = urn
        if (
          isV2 &&
          itemIdSeg != null &&
          (urn.toLowerCase() === assetUrn.toLowerCase() ||
            (tail && tail !== tokenId && tail.length < tokenId.length))
        ) {
          instanceUrn = `${assetUrn}:${tokenId}`
        } else if (isV2 && itemIdSeg != null && /^\d+$/.test(tokenId) && !urn.endsWith(`:${tokenId}`)) {
          instanceUrn = `${assetUrn}:${tokenId}`
        }

        const issue =
          issueFromMap ||
          resolveDisplayIssueNumber(mintMap, instanceUrn) ||
          undefined

        items.push({
          key: instanceUrn,
          urn: instanceUrn,
          name: meta?.name || wearableShortLabel(assetUrn),
          img: meta?.thumbnailUrl || wearableThumbnailUrl(assetUrn),
          r: rarity,
          category: meta?.category,
          issue: issue || undefined,
          maxSupply: max != null ? String(max) : undefined,
          c: contract,
          // Full on-chain ERC-721 id (packed Collection V2 when applicable).
          tid: tokenId
        })
      }

      // Flag accidental issue collisions on the same asset (should be rare after map fix).
      const issueKeys = new Map<string, number>()
      for (const it of items) {
        if (!it.issue) continue
        const asset = assetUrnFromCompleteUrn(it.urn).toLowerCase()
        const k = `${asset}#${it.issue}`
        issueKeys.set(k, (issueKeys.get(k) ?? 0) + 1)
      }
      for (const it of items) {
        if (!it.issue) continue
        const asset = assetUrnFromCompleteUrn(it.urn).toLowerCase()
        if ((issueKeys.get(`${asset}#${it.issue}`) ?? 0) > 1 && it.tid) {
          // Disambiguate badge: show mint + short token so copies aren't identical.
          it.issue = `${it.issue}·${shortToken(it.tid)}`
        }
      }

      items.sort((a, b) => {
        const rn = rarityRank(a.r) - rarityRank(b.r)
        if (rn !== 0) return rn
        const nameCmp = (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' })
        if (nameCmp !== 0) return nameCmp
        // Same item name: lowest mint # first (numeric when possible).
        const ia = parseInt(String(a.issue ?? '').replace(/\D.*/, ''), 10)
        const ib = parseInt(String(b.issue ?? '').replace(/\D.*/, ''), 10)
        if (Number.isFinite(ia) && Number.isFinite(ib) && ia !== ib) return ia - ib
        return (a.tid || a.urn).localeCompare(b.tid || b.urn)
      })

      // Seed items received via in-client settle that indexes still attribute to the seller.
      const haveTok = new Set(items.map((i) => `${(i.c || '').toLowerCase()}:${i.tid || ''}`))
      const mergeIn = (extra: TradeInventoryItem[], label: string) => {
        let added = 0
        for (const s of extra) {
          const k = `${(s.c || '').toLowerCase()}:${s.tid || ''}`
          if (!s.tid || !s.c || haveTok.has(k)) continue
          haveTok.add(k)
          items.push(s)
          added++
        }
        if (added > 0) {
          clientDebugLog.log('social', `Trade inventory: ${label} +${added}`, {
            level: 'info',
            alsoConsole: true
          })
        }
      }
      mergeIn(loadRememberedReceivedItems(addr), 'seeded recently-received')

      // Guest / new-owner: Catalyst empty — enumerate collections we've settled.
      // Only pull the peer's full marketplace index when we still have zero contracts
      // to scan (that call is slow and blocked the trade window for invitees).
      const touched = loadTouchedContracts()
      if (items.length === 0 && this.active?.peer && touched.length === 0) {
        try {
          const peerMap = await loadOwnedMintNumbers(this.active.peer)
          for (const k of peerMap.keys()) {
            if (!k.startsWith('tid:')) continue
            const parts = k.split(':')
            if (parts[1] && /^0x[a-f0-9]{40}$/.test(parts[1])) {
              rememberTouchedContract(parts[1])
            }
          }
        } catch {
          /* peer index optional */
        }
      }
      if (items.length === 0 || loadTouchedContracts().length > 0) {
        const enumerated = await enumerateOwnedFromTouchedContracts(addr, metaByAsset)
        mergeIn(enumerated, 'on-chain enumerate')
      }

      // Thumbnails + real names for on-chain / seeded rows (catalogs often skip guests).
      await enrichTradeItemDisplay(items, lambdasUrl)

      // Source of truth: ERC-721 ownerOf. Drops seller-side ghosts; keeps real receives.
      const beforeOwn = items.length
      const ownedOnly = await filterInventoryByOnChainOwner(addr, items)
      const dropped = beforeOwn - ownedOnly.length
      if (dropped > 0) {
        clientDebugLog.log(
          'social',
          `Trade inventory: dropped ${dropped} not-owned token(s) (index lag)`,
          { level: 'warn', alsoConsole: true }
        )
      }
      // Keep session seed in sync with chain (drop sold / never-owned seeds).
      pruneRememberedReceivedToOwned(addr, ownedOnly)

      this.inventoryCache = ownedOnly
      clientDebugLog.log('social', `Trade inventory loaded · ${ownedOnly.length} items`, {
        level: 'info',
        alsoConsole: true
      })
      return ownedOnly
    } catch (err) {
      clientDebugLog.log(
        'social',
        `Trade inventory load failed: ${err instanceof Error ? err.message : String(err)}`,
        { level: 'warn', alsoConsole: true }
      )
      // Last resort: only session-seeded receives (still ownerOf-filtered).
      try {
        const seeded = loadRememberedReceivedItems(addr)
        if (seeded.length === 0) return []
        const ownedOnly = await filterInventoryByOnChainOwner(addr, seeded)
        pruneRememberedReceivedToOwned(addr, ownedOnly)
        this.inventoryCache = ownedOnly
        return ownedOnly
      } catch {
        return []
      }
    }
  }

  private toast(title: string, sub?: string): void {
    // While the trade modal is open, status lives inside the window (above the dimmed
    // backdrop). Global mobile toasts sit under z-index 260 and are invisible.
    if (this.tradeWindow) {
      // Terminal result owns the banner; don't clobber with intermediate toasts.
      if (this.tradeWindow.isTerminal()) return
      const lower = `${title} ${sub ?? ''}`.toLowerCase()
      const tone =
        /fail|error|wrong|cancel|reject/.test(lower)
          ? 'err'
          : /settled|complete|success|signed|accepted/.test(lower)
            ? 'ok'
            : 'info'
      this.tradeWindow.setStatus(title, sub, {
        tone,
        // Keep progress visible during settle; short auto-clear only while idle trading.
        autoClearMs:
          this.tradeWindow.getPhase() === 'settling' || tone === 'err' ? 0 : 8000
      })
    } else {
      this.options.pushToast?.(title, sub)
    }
    clientDebugLog.log('social', sub ? `${title} — ${sub}` : title, {
      level: 'info',
      alsoConsole: true
    })
  }
}

/**
 * Fill name / rarity / thumbnail from Catalyst for rows that only have on-chain ids
 * (guest enumerate often has no backpack metadata → showed bare "3").
 */
async function enrichTradeItemDisplay(
  items: TradeInventoryItem[],
  lambdasUrl: string
): Promise<void> {
  if (items.length === 0) return
  const base = lambdasUrl.replace(/\/$/, '')
  const needMeta = new Map<string, TradeInventoryItem[]>()
  for (const it of items) {
    // Always ensure a thumbnail URL (Catalyst content path works without a prior meta fetch).
    if (!it.img) {
      it.img = wearableThumbnailUrl(it.urn)
    }
    const asset = assetUrnFromCompleteUrn(it.urn).toLowerCase()
    const nameLooksLikeId = !it.name || /^\d+$/.test(it.name.trim())
    if (nameLooksLikeId || !it.r || it.r === 'common') {
      const list = needMeta.get(asset) || []
      list.push(it)
      needMeta.set(asset, list)
    }
  }
  const assets = [...needMeta.keys()]
  if (assets.length === 0) return

  const BATCH = 25
  for (let i = 0; i < assets.length; i += BATCH) {
    const batch = assets.slice(i, i + BATCH)
    const qs = batch.map((u) => `wearableId=${encodeURIComponent(u)}`).join('&')
    try {
      const res = await fetch(`${base}/collections/wearables?${qs}`)
      if (!res.ok) continue
      const raw = (await res.json()) as {
        wearables?: Array<{
          id?: string
          name?: string
          rarity?: string | null
          thumbnail?: string
          data?: { category?: string }
        }>
      }
      for (const hit of raw.wearables ?? []) {
        const id = hit.id?.trim().toLowerCase()
        if (!id) continue
        const list = needMeta.get(id)
        if (!list) continue
        for (const it of list) {
          if (hit.name?.trim()) it.name = hit.name.trim()
          if (hit.rarity) it.r = String(hit.rarity).toLowerCase()
          if (hit.thumbnail?.trim()) it.img = hit.thumbnail.trim()
          else if (!it.img) it.img = wearableThumbnailUrl(it.urn)
          if (hit.data?.category) it.category = hit.data.category
        }
      }
    } catch {
      /* keep fallbacks */
    }
  }
}

/** Short unique tail for token ids (handles both small issuedIds and huge uints). */
function shortToken(tid: string): string {
  const t = tid.trim()
  if (t.length <= 6) return t
  return t.slice(-4)
}

type ReceivedStore = Record<string, TradeInventoryItem[]>

function readReceivedStore(): ReceivedStore {
  try {
    const raw = sessionStorage.getItem(RECEIVED_ITEMS_STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as ReceivedStore
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writeReceivedStore(store: ReceivedStore): void {
  try {
    sessionStorage.setItem(RECEIVED_ITEMS_STORAGE_KEY, JSON.stringify(store))
  } catch {
    /* quota / private mode */
  }
}

function wireToInventoryItem(it: TradeItemWire): TradeInventoryItem | null {
  const tid = (it.tid || '').trim()
  let c = (it.c || '').trim().toLowerCase()
  let urn = (it.urn || '').trim()
  if (!c) {
    const m = /collections-v2:(0x[a-fA-F0-9]{40})/i.exec(urn)
    if (m?.[1]) c = m[1].toLowerCase()
  }
  // Recover packed id from URN tail when tid missing.
  let tokenId = tid
  if (!tokenId && urn) {
    const parts = urn.split(':')
    const tail = parts[parts.length - 1] || ''
    if (/^\d+$/.test(tail) && (tail.length > 18 || parts.length >= 7)) tokenId = tail
  }
  if (!tokenId || !/^\d+$/.test(tokenId)) return null
  if (!c || !/^0x[a-f0-9]{40}$/.test(c)) return null

  // Canonical instance URN so settle packing is stable.
  if (!urn || !urn.includes(tokenId)) {
    try {
      const itemId = (BigInt(tokenId) >> 216n).toString()
      urn = `urn:decentraland:matic:collections-v2:${c}:${itemId}:${tokenId}`
    } catch {
      urn = `urn:decentraland:matic:collections-v2:${c}:0:${tokenId}`
    }
  }

  const assetUrn = assetUrnFromCompleteUrn(urn)
  return {
    key: urn,
    urn,
    name: it.name || wearableShortLabel(assetUrn),
    img: it.img || wearableThumbnailUrl(assetUrn),
    r: (it.r || 'common').toLowerCase(),
    c,
    tid: tokenId,
    issue: it.issue,
    maxSupply: it.max
  }
}

function rememberReceivedItems(owner: string | null, items: TradeItemWire[]): void {
  if (!owner || !items.length) return
  const addr = owner.trim().toLowerCase()
  const store = readReceivedStore()
  const prev = Array.isArray(store[addr]) ? store[addr]! : []
  const byTok = new Map<string, TradeInventoryItem>()
  for (const p of prev) {
    if (p.c && p.tid) byTok.set(`${p.c.toLowerCase()}:${p.tid}`, p)
  }
  for (const raw of items) {
    const it = wireToInventoryItem(raw)
    if (!it?.c || !it.tid) continue
    byTok.set(`${it.c.toLowerCase()}:${it.tid}`, it)
  }
  store[addr] = [...byTok.values()]
  writeReceivedStore(store)
}

function loadRememberedReceivedItems(owner: string): TradeInventoryItem[] {
  const addr = owner.trim().toLowerCase()
  const list = readReceivedStore()[addr]
  return Array.isArray(list) ? list.filter((i) => i?.tid && i?.c && i?.urn) : []
}

function pruneRememberedReceivedToOwned(owner: string, owned: TradeInventoryItem[]): void {
  const addr = owner.trim().toLowerCase()
  const store = readReceivedStore()
  if (!store[addr]?.length) return
  const keep = new Set(
    owned
      .filter((i) => i.c && i.tid)
      .map((i) => `${i.c!.toLowerCase()}:${i.tid}`)
  )
  // Only prune seeds that we can identify; keep seeds still owned on-chain.
  store[addr] = (store[addr] || []).filter(
    (i) => i.c && i.tid && keep.has(`${i.c.toLowerCase()}:${i.tid}`)
  )
  if (store[addr]!.length === 0) delete store[addr]
  writeReceivedStore(store)
}

function removeRememberedReceivedToken(
  owner: string | null,
  contract: string,
  tokenId: string
): void {
  if (!owner) return
  const addr = owner.trim().toLowerCase()
  const store = readReceivedStore()
  const list = store[addr]
  if (!list?.length) return
  const c = contract.toLowerCase()
  const tid = tokenId.trim()
  store[addr] = list.filter((i) => !(i.c?.toLowerCase() === c && i.tid === tid))
  if (store[addr]!.length === 0) delete store[addr]
  writeReceivedStore(store)
}

function rememberTouchedContractsFromOffer(offer: TradeOfferSnapshot | undefined | null): void {
  if (!offer?.items.length) return
  for (const it of offer.items) {
    const c =
      (it.c || '').trim().toLowerCase() ||
      (/collections-v2:(0x[a-fA-F0-9]{40})/i.exec(it.urn || '')?.[1] || '').toLowerCase()
    if (c && /^0x[a-f0-9]{40}$/.test(c)) rememberTouchedContract(c)
  }
}

function rememberTouchedContract(contract: string): void {
  const c = contract.trim().toLowerCase()
  if (!/^0x[a-f0-9]{40}$/.test(c)) return
  try {
    const raw = sessionStorage.getItem(TOUCHED_CONTRACTS_STORAGE_KEY)
    const list: string[] = raw ? (JSON.parse(raw) as string[]) : []
    const set = new Set(Array.isArray(list) ? list.map((x) => String(x).toLowerCase()) : [])
    set.add(c)
    sessionStorage.setItem(TOUCHED_CONTRACTS_STORAGE_KEY, JSON.stringify([...set].slice(0, 64)))
  } catch {
    /* ignore */
  }
}

function loadTouchedContracts(): string[] {
  try {
    const raw = sessionStorage.getItem(TOUCHED_CONTRACTS_STORAGE_KEY)
    if (!raw) return []
    const list = JSON.parse(raw) as string[]
    return Array.isArray(list)
      ? list.map((x) => String(x).toLowerCase()).filter((c) => /^0x[a-f0-9]{40}$/.test(c))
      : []
  } catch {
    return []
  }
}

const erc721EnumAbi = [
  ...erc721Abi,
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ type: 'uint256' }]
  },
  {
    type: 'function',
    name: 'tokenOfOwnerByIndex',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'index', type: 'uint256' }
    ],
    outputs: [{ type: 'uint256' }]
  }
] as const

/**
 * When Catalyst/marketplace lag, list NFTs we actually hold on collections used in trades.
 */
async function enumerateOwnedFromTouchedContracts(
  owner: string,
  metaByAsset: Map<string, { name?: string; thumbnailUrl?: string; rarity?: string; category?: string }>
): Promise<TradeInventoryItem[]> {
  const contracts = loadTouchedContracts()
  if (contracts.length === 0) return []
  const ownerAddr = owner.toLowerCase() as Address
  const out: TradeInventoryItem[] = []

  for (const c of contracts) {
    const collection = c as Address
    let bal = 0n
    try {
      bal = (await polygonPublicClient.readContract({
        address: collection,
        abi: erc721EnumAbi,
        functionName: 'balanceOf',
        args: [ownerAddr]
      })) as bigint
    } catch {
      continue
    }
    const n = Number(bal > 40n ? 40n : bal)
    for (let i = 0; i < n; i++) {
      try {
        const tokenId = (await polygonPublicClient.readContract({
          address: collection,
          abi: erc721EnumAbi,
          functionName: 'tokenOfOwnerByIndex',
          args: [ownerAddr, BigInt(i)]
        })) as bigint
        const tid = tokenId.toString()
        const itemId = (tokenId >> 216n).toString()
        const issuedId = (tokenId & ((1n << 216n) - 1n)).toString()
        const urn = `urn:decentraland:matic:collections-v2:${c}:${itemId}:${tid}`
        const assetUrn = `urn:decentraland:matic:collections-v2:${c}:${itemId}`
        const meta = metaByAsset.get(assetUrn.toLowerCase())
        out.push({
          key: urn,
          urn,
          name: meta?.name || wearableShortLabel(assetUrn),
          img: meta?.thumbnailUrl || wearableThumbnailUrl(assetUrn),
          r: (meta?.rarity || 'common').toLowerCase(),
          category: meta?.category,
          issue: issuedId,
          c,
          tid
        })
        // Learn contract for next sessions even if seed was empty.
        rememberTouchedContract(c)
      } catch {
        break
      }
    }
  }
  return out
}

function parseContract(urn: string): string | undefined {
  const m = /collections-v2:(0x[a-fA-F0-9]{40}):/i.exec(urn)
  return m?.[1]?.toLowerCase()
}

function rarityRank(r?: string): number {
  const order = [
    'unique',
    'mythic',
    'exotic',
    'legendary',
    'epic',
    'rare',
    'uncommon',
    'common',
    'base'
  ]
  const i = order.indexOf((r || 'common').toLowerCase())
  return i === -1 ? 50 : i
}
