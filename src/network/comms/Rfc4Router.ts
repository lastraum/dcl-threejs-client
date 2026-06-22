import { Packet } from '@dcl/protocol/out-ts/decentraland/kernel/comms/rfc4/comms.gen'
import {
  tryDecodeRfc4ProfileRequest,
  tryDecodeRfc4ProfileResponse,
  tryDecodeRfc4ProfileVersion,
  tryDecodeRfc4PlayerEmote,
  tryDecodeRfc4TransformPacket,
  describeRfc4Packet
} from './dclRfc4Comms'
import type { CommsSceneOrigin, RealmBounds } from './movementCompressed'
import { parseCommsSceneOrigin } from './movementCompressed'
import { tryDecodeSceneDataPacket, yawFromQuaternion } from './dclSceneData'
import type { TransportType } from './Transport'
import { tryDecodeRfc4ChatPacket, tryParseChatEmoteCommand } from '../../social/dclRfc4Chat'
import { DCM_SCENE_ID } from '../../social/dcmChatMedia'
import { baseEmoteUrn } from '../../avatar/profileEmotes'
import { clientDebugLog } from '../../client/debug/ClientDebugLog'

/** Bevy `CommsMessageType` — first byte prefix on RFC4 Scene payloads. */
export enum CommsMessageType {
  String = 1,
  Binary = 2
}

export type Rfc4RouterHandlers = {
  onPeerTransform: (
    address: string,
    x: number,
    y: number,
    z: number,
    yaw: number,
    transport: TransportType,
    velocity?: { x: number; y: number; z: number },
    locomotion?: { isGrounded?: boolean; isJumping?: boolean; jumpCount?: number }
  ) => void
  onProfileRequest: (address: string, profileVersion: number) => void
  onPeerProfileVersion?: (address: string, profileVersion: number) => void
  onPeerProfile: (address: string, serializedProfile: string, baseUrl: string) => void
  onPeerEmote?: (address: string, urn: string, incrementalId: number) => void
  onSceneBinary: (sceneId: string, sender: string, data: Uint8Array) => void
  onPeerChat?: (address: string, text: string, time: number, transport: TransportType) => void
  onPeerChatMedia?: (address: string, data: Uint8Array, transport: TransportType) => void
}

/** Central RFC4 inbound dispatcher — Bevy `GlobalCrdtPlugin::process_transport_updates`. */
export class Rfc4Router {
  private handlers: Rfc4RouterHandlers | null = null
  private realmBounds: RealmBounds | null = null
  private sceneOrigin: CommsSceneOrigin | null = null

  setHandlers(handlers: Rfc4RouterHandlers | null): void {
    this.handlers = handlers
  }

  setRealmBounds(bounds: RealmBounds | null): void {
    this.realmBounds = bounds
  }

  /** Base parcel — MovementCompressed genesis coords are converted to scene-local. */
  setSceneOrigin(baseParcel: string): void {
    this.sceneOrigin = parseCommsSceneOrigin(baseParcel)
  }

  private firstPeerLogCount = 0

  handlePacket(transport: TransportType, address: string, data: Uint8Array): void {
    if (!this.handlers || !address) return

    const rfc4 = tryDecodeRfc4TransformPacket(data, this.realmBounds, this.sceneOrigin)
    if (rfc4.kind === 'transform') {
      if (this.firstPeerLogCount < 5) {
        this.firstPeerLogCount++
        const origin = this.sceneOrigin
        const rawNote =
          rfc4.source === 'compressed' && origin
            ? ` genesis→local origin=(${origin.baseParcelX * 16},${origin.baseParcelY * 16})`
            : ''
        clientDebugLog.log(
          'comms',
          `RFC4 FIRST ← ${transport} ${address.slice(0, 8)}… [${rfc4.source}] scene=(${rfc4.x.toFixed(1)},${rfc4.y.toFixed(1)},${rfc4.z.toFixed(1)})${rawNote}`
        )
      }

      clientDebugLog.log(
        'comms',
        `RFC4 in ← ${transport} ${address.slice(0, 8)}… [${rfc4.source}] x=${rfc4.x.toFixed(1)} y=${rfc4.y.toFixed(1)} z=${rfc4.z.toFixed(1)} yaw=${((rfc4.yaw * 180) / Math.PI).toFixed(0)}°`,
        { throttleMs: 1000, throttleKey: `pos-in:${transport}:${address}` }
      )
      this.emitTransform(address, rfc4.x, rfc4.y, rfc4.z, rfc4.yaw, transport, {
        x: rfc4.vx ?? 0,
        y: rfc4.vy ?? 0,
        z: rfc4.vz ?? 0
      }, {
        isGrounded: rfc4.isGrounded,
        isJumping: rfc4.isJumping,
        jumpCount: rfc4.jumpCount
      })
      return
    }

    const packetKind = describeRfc4Packet(data)
    if (packetKind === 'movementCompressed' && !this.realmBounds) {
      clientDebugLog.log(
        'comms',
        `RFC4 MovementCompressed dropped (no realm bounds) from ${address.slice(0, 8)}…`,
        { throttleMs: 3000, throttleKey: `mc-no-bounds:${address}` }
      )
    } else if (packetKind !== 'unknown' && packetKind !== 'movement' && packetKind !== 'position') {
      clientDebugLog.log(
        'comms',
        `RFC4 in ← ${transport} ${address.slice(0, 8)}… ${packetKind}`,
        { throttleMs: 2000, throttleKey: `pkt-in:${packetKind}:${address}` }
      )
    }

    const profileVersion = tryDecodeRfc4ProfileVersion(data)
    if (profileVersion) {
      this.handlers.onPeerProfileVersion?.(address, profileVersion.profileVersion)
      return
    }

    const profileRequest = tryDecodeRfc4ProfileRequest(data)
    if (profileRequest) {
      this.handlers.onProfileRequest(profileRequest.address, profileRequest.profileVersion)
      return
    }

    const playerEmote = tryDecodeRfc4PlayerEmote(data)
    if (playerEmote) {
      clientDebugLog.log(
        'comms',
        `RFC4 PlayerEmote ← ${transport} ${address.slice(0, 8)}… ${playerEmote.urn.split(':').pop()}`,
        { throttleMs: 500, throttleKey: `emote-in:${address}` }
      )
      this.handlers.onPeerEmote?.(address, playerEmote.urn, playerEmote.incrementalId)
      return
    }

    const chat = tryDecodeRfc4ChatPacket(data)
    if (chat.kind === 'chat') {
      const chatEmote = tryParseChatEmoteCommand(chat.text)
      if (chatEmote) {
        const ref = chatEmote.emoteRef.trim()
        const urn = ref.toLowerCase().startsWith('urn:') ? ref.toLowerCase() : baseEmoteUrn(ref)
        clientDebugLog.log(
          'comms',
          `RFC4 ChatEmote ← ${transport} ${address.slice(0, 8)}… ${urn.split(':').pop()}`,
          { throttleMs: 500, throttleKey: `chat-emote-in:${address}` }
        )
        this.handlers.onPeerEmote?.(address, urn, chatEmote.incrementalId)
        return
      }
      this.handlers.onPeerChat?.(address, chat.text, chat.time, transport)
      return
    }

    const profileResponse = tryDecodeRfc4ProfileResponse(data)
    if (profileResponse) {
      this.handlers.onPeerProfile(address, profileResponse.serializedProfile, profileResponse.baseUrl)
      return
    }

    const scenePacket = tryDecodeRfc4ScenePacket(data)
    if (scenePacket) {
      if (scenePacket.sceneId === DCM_SCENE_ID) {
        this.handlers.onPeerChatMedia?.(address, scenePacket.data, transport)
        return
      }
      this.handlers.onSceneBinary(scenePacket.sceneId, address, scenePacket.data)
      return
    }

    const v3 = tryDecodeSceneDataPacket(data)
    if (v3.kind === 'position') {
      const yaw = yawFromQuaternion(v3.rx, v3.ry, v3.rz, v3.rw)
      this.emitTransform(address, v3.x, v3.y, v3.z, yaw, transport)
    }
  }

  private emitTransform(
    address: string,
    x: number,
    y: number,
    z: number,
    yaw: number,
    transport: TransportType,
    velocity?: { x: number; y: number; z: number },
    locomotion?: { isGrounded?: boolean; isJumping?: boolean; jumpCount?: number }
  ): void {
    this.handlers?.onPeerTransform(address, x, y, z, yaw, transport, velocity, locomotion)
  }
}

export function encodeRfc4SceneBinaryPacket(sceneId: string, payload: Uint8Array): Uint8Array {
  const data = new Uint8Array(1 + payload.length)
  data[0] = CommsMessageType.Binary
  data.set(payload, 1)
  return Packet.encode({
    protocolVersion: 100,
    message: {
      $case: 'scene',
      scene: { sceneId, data }
    }
  }).finish()
}

function tryDecodeRfc4ScenePacket(buf: Uint8Array): { sceneId: string; data: Uint8Array } | null {
  try {
    const packet = Packet.decode(buf)
    if (packet.message?.$case !== 'scene') return null
    const scene = packet.message.scene
    if (!scene.sceneId) return null
    const raw = scene.data ?? new Uint8Array()
    if (raw.length === 0) return { sceneId: scene.sceneId, data: raw }

    const type = raw[0]
    if (type === CommsMessageType.Binary || type === CommsMessageType.String) {
      return { sceneId: scene.sceneId, data: raw.slice(1) }
    }
    return { sceneId: scene.sceneId, data: raw }
  } catch {
    return null
  }
}
