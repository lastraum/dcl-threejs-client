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
  /**
   * Legacy flag — ignored for console output.
   * Browser console is controlled only by {@link ClientDebugLog.setConsoleMirror}
   * (Help → Debug checkbox; default on in Vite DEV, off in prod builds).
   */
  alsoConsole?: boolean
}

type Listener = (entries: readonly DebugLogEntry[]) => void

const MAX_ENTRIES = 250

/**
 * Categories silenced in production builds only (panel + console churn).
 * Local DEV keeps them so archipelago / LiveKit / gatekeeper lines show again.
 */
const SILENCED_CATEGORIES: ReadonlySet<string> =
  import.meta.env.DEV === true ? new Set() : new Set(['comms'])

const CONSOLE_MIRROR_KEY = 'dcl.debug.consoleMirror'

/** Local `vite` / `import.meta.env.DEV` — mirror client logs to DevTools by default. */
function defaultConsoleMirror(): boolean {
  return import.meta.env.DEV === true
}

/**
 * Explicit localStorage wins (`1` / `0`).
 * Unset → on in local DEV, off in production builds.
 */
function readConsoleMirrorPref(): boolean {
  try {
    const raw = localStorage.getItem(CONSOLE_MIRROR_KEY)
    if (raw === '1') return true
    if (raw === '0') return false
  } catch {
    /* ignore */
  }
  return defaultConsoleMirror()
}

/** In-memory client log — rendered in the Help debug panel. */
export class ClientDebugLog {
  private entries: DebugLogEntry[] = []
  private nextId = 1
  private listeners = new Set<Listener>()
  private throttleAt = new Map<string, number>()
  /**
   * When false, never print to browser console — Help panel only.
   * Default: on in local DEV, off in prod (unless checkbox / localStorage).
   */
  private consoleMirror = readConsoleMirrorPref()

  /** Help → Debug “Browser console logs”. Default on in local DEV, off in prod. */
  setConsoleMirror(enabled: boolean): void {
    this.consoleMirror = !!enabled
    try {
      // Persist both states so DEV default-on can still be turned off and stick.
      localStorage.setItem(CONSOLE_MIRROR_KEY, enabled ? '1' : '0')
    } catch {
      /* ignore */
    }
  }

  isConsoleMirror(): boolean {
    return this.consoleMirror
  }

  log(category: string, message: string, options: DebugLogOptions = {}): void {
    const silenced = SILENCED_CATEGORIES.has(category)
    if (silenced) return

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
    for (const listener of this.listeners) listener(this.entries)

    if (this.consoleMirror) {
      const prefix = `[${category}]`
      if (level === 'warn') console.warn(prefix, message)
      else if (level === 'error') console.error(prefix, message)
      else console.log(prefix, message)
    }
  }

  /**
   * Optional browser-console line (boot/noise). No-ops unless console mirror is on
   * (default on in local DEV).
   * Prefer {@link log} so lines also land in the Help panel.
   */
  consoleOnly(level: 'log' | 'info' | 'warn' | 'error', ...args: unknown[]): void {
    if (!this.consoleMirror) return
    if (level === 'warn') console.warn(...args)
    else if (level === 'error') console.error(...args)
    else console.info(...args)
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

/** Avatar compose spam — only when `?avatarverbose` or localStorage.avatarverbose=1. */
export function isAvatarVerbose(): boolean {
  try {
    if (typeof window === 'undefined') return false
    if (new URLSearchParams(window.location.search).has('avatarverbose')) return true
    return localStorage.getItem('avatarverbose') === '1'
  } catch {
    return false
  }
}
