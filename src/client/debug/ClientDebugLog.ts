export type DebugLogLevel = 'info' | 'warn' | 'error' | 'success'

export type DebugLogEntry = {
  id: number
  at: number
  category: string
  level: DebugLogLevel
  message: string
}

export type DebugLogOptions = {
  level?: DebugLogLevel
  /** Collapse repeated lines in UI + console (default key = category). */
  throttleMs?: number
  throttleKey?: string
  alsoConsole?: boolean
}

type Listener = (entries: readonly DebugLogEntry[]) => void

const MAX_ENTRIES = 250

/** Categories silenced to reduce console + listener churn (re-enable when profiling). */
const SILENCED_CATEGORIES = new Set(['comms'])

/** In-memory client log — rendered in the Help debug panel. */
export class ClientDebugLog {
  private entries: DebugLogEntry[] = []
  private nextId = 1
  private listeners = new Set<Listener>()
  private throttleAt = new Map<string, number>()

  log(category: string, message: string, options: DebugLogOptions = {}): void {
    if (SILENCED_CATEGORIES.has(category)) return

    const level = options.level ?? 'info'
    const key = options.throttleKey ?? `${category}:${level}`
    const now = Date.now()

    if (options.throttleMs && options.throttleMs > 0) {
      const last = this.throttleAt.get(key) ?? 0
      if (now - last < options.throttleMs) return
      this.throttleAt.set(key, now)
    }

    const entry: DebugLogEntry = {
      id: this.nextId++,
      at: now,
      category,
      level,
      message
    }

    this.entries.push(entry)
    if (this.entries.length > MAX_ENTRIES) {
      this.entries.splice(0, this.entries.length - MAX_ENTRIES)
    }

    if (options.alsoConsole !== false) {
      const prefix = `[${category}]`
      if (level === 'warn') console.warn(prefix, message)
      else if (level === 'error') console.error(prefix, message)
      else console.log(prefix, message)
    }

    for (const listener of this.listeners) listener(this.entries)
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    listener(this.entries)
    return () => this.listeners.delete(listener)
  }

  clear(): void {
    this.entries = []
    this.throttleAt.clear()
    for (const listener of this.listeners) listener(this.entries)
  }

  getEntries(): readonly DebugLogEntry[] {
    return this.entries
  }

  formatEntriesForCopy(entries: readonly DebugLogEntry[] = this.entries): string {
    if (entries.length === 0) return ''
    return entries
      .map((entry) => {
        const time = formatDebugTime(entry.at)
        const level = entry.level !== 'info' ? ` [${entry.level}]` : ''
        return `${time} ${entry.category}${level} ${entry.message}`
      })
      .join('\n')
  }
}

export const clientDebugLog = new ClientDebugLog()

export function formatDebugTime(at: number): string {
  const d = new Date(at)
  return d.toLocaleTimeString(undefined, {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  })
}
