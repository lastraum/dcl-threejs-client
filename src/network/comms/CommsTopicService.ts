import { base64ToBytes, bytesToBase64 } from './commsBinaryWire'

export type CommsTopicMessage = {
  sender: string
  data: string
}

/** In-memory topic pub/sub — backed by LiveKit data topics on CommsService. */
export class CommsTopicService {
  private readonly subscriptions = new Set<string>()
  private readonly queues = new Map<string, CommsTopicMessage[]>()

  subscribe(topic: string): void {
    const key = topic.trim()
    if (!key) return
    this.subscriptions.add(key)
    if (!this.queues.has(key)) this.queues.set(key, [])
  }

  unsubscribe(topic: string): void {
    this.subscriptions.delete(topic.trim())
  }

  isSubscribed(topic: string): boolean {
    return this.subscriptions.has(topic.trim())
  }

  enqueue(topic: string, sender: string, payload: Uint8Array): void {
    const key = topic.trim()
    if (!key || !this.subscriptions.has(key)) return
    const queue = this.queues.get(key) ?? []
    queue.push({ sender, data: bytesToBase64(payload) })
    this.queues.set(key, queue)
  }

  consume(topic: string): CommsTopicMessage[] {
    const key = topic.trim()
    const queue = this.queues.get(key) ?? []
    this.queues.set(key, [])
    return queue
  }

  decodePublishPayload(data: string): Uint8Array {
    return base64ToBytes(data)
  }

  clear(): void {
    this.subscriptions.clear()
    this.queues.clear()
  }
}
