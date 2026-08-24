import { encodeCommsBinaryMessage } from './commsBinaryWire'
import { logSyncDrain, logSyncInbound, unwrapCraftedCommsMessage } from './syncDebug'

/**
 * SDK7 BinaryMessageBus message types.
 *
 * **Serverless / default `@dcl/sdk`:** 1–3.
 * **Authoritative server (`@dcl/sdk@auth-server`, Flagtag-class scenes):** 4–9
 * (CRDT/REQ/RES renumbered; plus server/authoritative/custom-event channels).
 * Host is transport-only — forward the type byte as-is; the scene bundle's SDK
 * registers the handlers for whichever enum it was built with.
 */
export const CommsWireMessageType = {
  // Default SDK (serverless multiplayer)
  CRDT: 1,
  REQ_CRDT_STATE: 2,
  RES_CRDT_STATE: 3,
  // Auth-server SDK extensions
  CRDT_SERVER: 4,
  CRDT_AUTHORITATIVE: 5,
  CUSTOM_EVENT: 6,
  AUTH_CRDT: 7,
  AUTH_REQ_CRDT_STATE: 8,
  AUTH_RES_CRDT_STATE: 9
} as const

/**
 * Buffers inbound scene-room payloads until the next sendBinary response.
 *
 * LiveKit carries SDK `craftCommsMessage` bytes: `[messageType:u8][payload…]`.
 * Worker BinaryMessageBus expects `encodeCommsBinaryMessage` envelopes:
 * `[senderLen][sender][messageType][payload…]`.
 *
 * **Ingress hold:** this client boots the scene worker, then drains a LiveKit
 * buffer. Official isolate runs `main()` interleaved with comms. Dumping AUTH_RES
 * before `syncEntity(enumId)` makes SDK `findNetworkId` create a new local entity;
 * the later `syncEntity` throws "already in use". Hold until main has attached
 * network identities, then deliver — same remap the official CRDT system already
 * does when the identity exists first.
 *
 * Hold drains until the host releases after scene main has settled (syncEntity ran).
 *
 * **CUSTOM_EVENT:** official web Explorer connects scene LiveKit *after* the
 * sandbox clock is running, so join/snapshot land after the scene's own 1.5s
 * seed fallback. We reuse a landing room that is already hot, so dumping
 * buffered CUSTOM_EVENT at sandbox t=0 is not that order. Keep those packets
 * queued until the host opens gameplay ingress; AUTH_RES/CRDT still drain
 * when `holdDrain` clears.
 */
function encodedCommsMessageType(buf: Uint8Array): number | null {
  if (buf.byteLength < 2) return null
  const senderLen = buf[0]!
  if (buf.byteLength < 2 + senderLen) return null
  return buf[1 + senderLen]!
}

export class CommsInboundQueue {
  private readonly pending: Uint8Array[] = []
  /** When true, push still accepts but drain returns [] (keeps FIFO for later). */
  private holdDrain = true
  /** Sandbox clock must start before warm-room join/snapshot (Explorer order). */
  private holdCustomEvents = true
  /** Once the 2s sandbox head-start opens events, reconnect must not re-hold them. */
  private customEventsOpened = false
  private holdLogged = false
  private customHoldLogged = false

  /**
   * @param craftedPayload — RFC4 scene-binary body = SDK craftCommsMessage
   *   (`[type][payload]`). Message type is taken from the first byte (not forced CRDT).
   */
  pushSceneBinary(sender: string, craftedPayload: Uint8Array): void {
    const unwrapped = unwrapCraftedCommsMessage(craftedPayload)
    if (!unwrapped) return
    const { messageType, payload } = unwrapped
    logSyncInbound({
      sender,
      messageType,
      payloadBytes: payload.byteLength
    })
    this.pending.push(encodeCommsBinaryMessage(sender, messageType, payload))
  }

  /** @deprecated Prefer pushSceneBinary — type must come from craftCommsMessage. */
  pushSceneBinaryTyped(sender: string, payload: Uint8Array, messageType: number): void {
    logSyncInbound({ sender, messageType, payloadBytes: payload.byteLength })
    this.pending.push(encodeCommsBinaryMessage(sender, messageType, payload))
  }

  /**
   * Hold/release inbound delivery to the scene worker.
   * Default hold=true so early LiveKit AUTH_RES cannot race async main/syncEntity.
   */
  setHoldDrain(hold: boolean): void {
    this.holdDrain = hold
    if (hold) {
      this.holdLogged = false
      // Re-arming CUSTOM_EVENT here on scene-room reconnect dropped teamAssigned /
      // paintTick forever (sandbox already ticking; worker-ready release never re-runs).
      if (!this.customEventsOpened) {
        this.holdCustomEvents = true
        this.customHoldLogged = false
      }
    }
  }

  setHoldCustomEvents(hold: boolean): void {
    this.holdCustomEvents = hold
    if (hold) {
      this.customHoldLogged = false
    } else {
      this.customEventsOpened = true
    }
  }

  isHoldDrain(): boolean {
    return this.holdDrain
  }

  isHoldCustomEvents(): boolean {
    return this.holdCustomEvents
  }

  pendingCount(): number {
    return this.pending.length
  }

  drain(): Uint8Array[] {
    if (this.holdDrain) {
      if (this.pending.length > 0 && !this.holdLogged) {
        this.holdLogged = true
        // One-shot: avoid spam while main() is still settling.
        console.info(
          `[sync] inbound held — ${this.pending.length} packet(s) waiting for scene main/syncEntity`
        )
      }
      return []
    }
    if (!this.pending.length) return []
    let toDrain: Uint8Array[]
    if (this.holdCustomEvents) {
      const crdt: Uint8Array[] = []
      const rest: Uint8Array[] = []
      for (const msg of this.pending) {
        if (encodedCommsMessageType(msg) === CommsWireMessageType.CUSTOM_EVENT) rest.push(msg)
        else crdt.push(msg)
      }
      const hasRes = crdt.some((msg) => {
        const t = encodedCommsMessageType(msg)
        return t === CommsWireMessageType.AUTH_RES_CRDT_STATE || t === CommsWireMessageType.RES_CRDT_STATE
      })
      // Explorer: AUTH_RES makes isRoomReady, then join/team CUSTOM_EVENT. Deliver both
      // in this drain so joinRoster is not queued behind a 2s event hold.
      if (hasRes) {
        this.holdCustomEvents = false
        this.customEventsOpened = true
        this.pending.length = 0
        toDrain = [...crdt, ...rest]
        if (rest.length) {
          console.info(
            `[sync] CUSTOM_EVENT released with AUTH_RES — ${rest.length} event(s) + ${crdt.length} CRDT`
          )
        }
      } else {
        this.pending.length = 0
        this.pending.push(...rest)
        toDrain = crdt
        if (rest.length > 0 && !this.customHoldLogged) {
          this.customHoldLogged = true
          console.info(
            `[sync] CUSTOM_EVENT held — ${rest.length} packet(s) until AUTH_RES / sandbox join`
          )
        }
      }
    } else {
      // Must splice — `toDrain = this.pending; this.pending.length = 0` aliases
      // the same array and returns [] so join/snapshot never reach EventBus.
      toDrain = this.pending.splice(0)
    }
    if (!toDrain.length) return []
    let totalBytes = 0
    for (const m of toDrain) totalBytes += m.byteLength
    logSyncDrain({ count: toDrain.length, totalBytes })
    return toDrain
  }

  clear(): void {
    this.pending.length = 0
    this.customEventsOpened = false
    this.holdCustomEvents = true
    this.customHoldLogged = false
  }
}
