import type { SendBinaryRequest, SendBinaryResponse } from '../../shim/types'
import { AUTHORITATIVE_SERVER_SENDER, wrapPeerEmitChunk } from './sceneBinaryWire'

export type SceneBinaryTransportDeps = {
  getLocalAddress: () => string | null
  isAuthoritativePeer: () => boolean
  hasRemoteAuthoritativeServer: () => boolean
  /** Worlds with gatekeeper scene rooms use a remote `authoritative-server` — never loopback as it. */
  expectsRemoteAuthoritativeServer: () => boolean
  publishChunks: (chunks: Uint8Array[], targetAddresses: string[]) => Promise<void>
  drainInbound: () => Uint8Array[]
}

function normalizeAddress(value: string): string {
  return value.toLowerCase()
}

function addressesIncludeLocal(addresses: string[], local: string): boolean {
  const key = normalizeAddress(local)
  return addresses.some((entry) => normalizeAddress(entry) === key)
}

function addressesTargetAuthoritativeServer(addresses: string[]): boolean {
  const key = normalizeAddress(AUTHORITATIVE_SERVER_SENDER)
  return addresses.some((entry) => normalizeAddress(entry) === key)
}

function loopbackSender(
  targetAddresses: string[],
  localAddress: string,
  isAuthoritative: boolean
): string {
  if (targetAddresses.length > 0) return AUTHORITATIVE_SERVER_SENDER
  return isAuthoritative ? localAddress : AUTHORITATIVE_SERVER_SENDER
}

/**
 * Routes scene `sendBinary` peerData (sync-systems BinaryMessageBus) over LiveKit RFC4
 * and applies authoritative loopback so solo / same-process server handlers run.
 */
export class SceneBinaryTransport {
  constructor(private readonly deps: SceneBinaryTransportDeps) {}

  async handleSendBinary(body: SendBinaryRequest): Promise<SendBinaryResponse> {
    const localAddress = this.deps.getLocalAddress()
    const isAuthoritative = this.deps.isAuthoritativePeer()
    const loopback: Uint8Array[] = []

    const peerEntries =
      body.peerData?.flatMap((entry) =>
        entry.data.map((chunk) => ({ chunk, addresses: entry.address ?? [] }))
      ) ?? []

    for (const { chunk, addresses } of peerEntries) {
      const broadcast = addresses.length === 0
      const remoteTargets = localAddress
        ? addresses.filter((entry) => normalizeAddress(entry) !== normalizeAddress(localAddress))
        : addresses

      if (broadcast || remoteTargets.length > 0) {
        await this.deps.publishChunks([chunk], broadcast ? [] : remoteTargets)
      }

      const remoteAuthServer = this.deps.hasRemoteAuthoritativeServer()
      const shouldLoopback =
        !!localAddress &&
        ((broadcast && isAuthoritative) ||
          (addresses.length > 0 && addressesIncludeLocal(addresses, localAddress)) ||
          (isAuthoritative &&
            addressesTargetAuthoritativeServer(addresses) &&
            !remoteAuthServer &&
            !this.deps.expectsRemoteAuthoritativeServer()))

      if (!shouldLoopback) continue

      const sender = loopbackSender(addresses, localAddress, isAuthoritative)
      const wrapped = wrapPeerEmitChunk(sender, chunk)
      if (wrapped) loopback.push(wrapped)
    }

    if (body.data?.length) {
      await this.deps.publishChunks(body.data, [])
    }

    const inbound = this.deps.drainInbound()
    if (!loopback.length) return { data: inbound }
    return { data: [...inbound, ...loopback] }
  }
}

/** Wrap a raw inbound RFC4 scene chunk for the worker inbound queue. */
export function wrapInboundSceneChunk(sender: string, chunk: Uint8Array): Uint8Array | null {
  return wrapPeerEmitChunk(sender, chunk)
}