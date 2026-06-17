import { EngineApiEventType, type EngineApiEvent } from './engineApiEvents'

type EngineApiEventStateOptions = {
  onSubscribe?: (eventId: string) => void
  onUnsubscribe?: (eventId: string) => void
}

/** Worker-side queue drained by `EngineApi.sendBatch` (SDK `pollEvents`). */
export class EngineApiEventState {
  private readonly subscriptions = new Set<string>()
  private readonly pending: EngineApiEvent[] = []

  constructor(private readonly options: EngineApiEventStateOptions = {}) {}

  subscribe(eventId: string): void {
    if (this.subscriptions.has(eventId)) return
    this.subscriptions.add(eventId)
    this.options.onSubscribe?.(eventId)
  }

  unsubscribe(eventId: string): void {
    if (!this.subscriptions.delete(eventId)) return
    this.options.onUnsubscribe?.(eventId)
  }

  isSubscribed(eventId: string): boolean {
    return this.subscriptions.has(eventId)
  }

  enqueue(event: EngineApiEvent): void {
    if (event.type === EngineApiEventType.GENERIC) {
      const eventId = event.generic?.eventId
      if (!eventId || !this.subscriptions.has(eventId)) return
    }
    this.pending.push(event)
  }

  enqueueMany(events: ReadonlyArray<EngineApiEvent>): void {
    for (const event of events) this.enqueue(event)
  }

  drainEvents(): EngineApiEvent[] {
    if (!this.pending.length) return []
    return this.pending.splice(0)
  }
}

export function createEngineApiEventState(options?: EngineApiEventStateOptions): EngineApiEventState {
  return new EngineApiEventState(options)
}
