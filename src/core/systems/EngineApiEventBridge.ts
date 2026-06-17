import type { EngineApiEvent } from '../../shim/engine/engineApiEvents'
import { createCommsEngineApiEvent } from '../../shim/engine/engineApiEvents'

/** Main-thread bridge: tracks worker subscriptions and pushes renderer events into the worker queue. */
export class EngineApiEventBridge {
  private readonly subscriptions = new Set<string>()
  private postEvents: ((events: EngineApiEvent[]) => void) | null = null

  bind(postEvents: (events: EngineApiEvent[]) => void): void {
    this.postEvents = postEvents
  }

  dispose(): void {
    this.postEvents = null
    this.subscriptions.clear()
  }

  onWorkerSubscribe(eventId: string): void {
    this.subscriptions.add(eventId)
  }

  onWorkerUnsubscribe(eventId: string): void {
    this.subscriptions.delete(eventId)
  }

  isSubscribed(eventId: string): boolean {
    return this.subscriptions.has(eventId)
  }

  /** Legacy message-bus string (CommunicationsController.send / topic `comms`). */
  pushCommsMessage(message: string, sender: string): void {
    if (!this.subscriptions.has('comms')) return
    this.pushEvents([createCommsEngineApiEvent(message, sender)])
  }

  pushEvents(events: ReadonlyArray<EngineApiEvent>): void {
    if (!events.length || !this.postEvents) return
    this.postEvents([...events])
  }
}
