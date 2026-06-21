import { normalizeInboundSceneBinary } from '../sceneSync/sceneBinaryWire'

/** Buffers inbound scene-room payloads until the next sendBinary response. */
export class CommsInboundQueue {
  private readonly pending: Uint8Array[] = []

  pushSceneBinary(sender: string, payload: Uint8Array): void {
    const wrapped = normalizeInboundSceneBinary(sender, payload)
    if (wrapped) this.pending.push(wrapped)
  }

  drain(): Uint8Array[] {
    if (!this.pending.length) return []
    const out = this.pending.slice()
    this.pending.length = 0
    return out
  }

  clear(): void {
    this.pending.length = 0
  }
}