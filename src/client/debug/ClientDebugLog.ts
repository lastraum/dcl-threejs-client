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
const CONSOLE_CAPTURE_KEY = 'dcl.debug.consoleCapture'
const ALL_CLIENT_LOGS_KEY = 'dcl.debug.allClientLogs'
/** Master gate: nothing lands in the Help panel unless this is on. */
const PANEL_RECORD_KEY = 'dcl.debug.panelRecord'

/**
 * Browser console is **opt-in only** (Help → Debug “Browser console logs”).
 * Never default on — verbose paths (voice, FPS, odk-net, compose) must stay quiet
 * until the user enables them; logging itself can tank FPS with many remotes.
 */
function defaultConsoleMirror(): boolean {
  return false
}

/**
 * Explicit localStorage wins (`1` / `0`).
 * Unset → on in local DEV, off in production builds.
 */
function readBoolPref(key: string, fallback: boolean): boolean {
  try {
    const raw = localStorage.getItem(key)
    if (raw === '1') return true
    if (raw === '0') return false
  } catch {
    /* ignore */
  }
  return fallback
}

function writeBoolPref(key: string, enabled: boolean): void {
  try {
    localStorage.setItem(key, enabled ? '1' : '0')
  } catch {
    /* ignore */
  }
}

function formatConsoleArgs(args: unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === 'string') return a
      if (a instanceof Error) return a.stack || a.message
      try {
        return JSON.stringify(a)
      } catch {
        return String(a)
      }
    })
    .join(' ')
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
  private consoleMirror = readBoolPref(CONSOLE_MIRROR_KEY, defaultConsoleMirror())
  /**
   * Master gate for the Help → Debug log body. Default **off** so the panel stays
   * quiet until the user opts in.
   */
  private panelRecord = readBoolPref(PANEL_RECORD_KEY, false)
  /**
   * When true (and panel record on), include silenced categories (e.g. comms in prod).
   */
  private allClientLogs = readBoolPref(ALL_CLIENT_LOGS_KEY, false)
  /**
   * When true, hook console.log/warn/error into this panel so ad-hoc logs appear here.
   * Also implies panel recording for those console lines.
   */
  private consoleCapture = readBoolPref(CONSOLE_CAPTURE_KEY, false)
  private consoleHookInstalled = false
  private origConsole: {
    log: typeof console.log
    info: typeof console.info
    warn: typeof console.warn
    error: typeof console.error
  } | null = null
  /** Avoid re-entrancy when our own mirror writes to console. */
  private writingConsole = false

  constructor() {
    if (this.consoleCapture) this.installConsoleHook()
  }

  /** Help → Debug “Browser console logs”. Default on in local DEV, off in prod. */
  setConsoleMirror(enabled: boolean): void {
    this.consoleMirror = !!enabled
    writeBoolPref(CONSOLE_MIRROR_KEY, this.consoleMirror)
  }

  isConsoleMirror(): boolean {
    return this.consoleMirror
  }

  /**
   * Help → Debug “Record client logs” — master panel gate (default off).
   */
  setPanelRecord(enabled: boolean): void {
    this.panelRecord = !!enabled
    writeBoolPref(PANEL_RECORD_KEY, this.panelRecord)
  }

  isPanelRecord(): boolean {
    return this.panelRecord
  }

  /**
   * Help → Debug “All categories” — include normally silenced categories (comms in prod).
   * Only applies when panel recording is on.
   */
  setAllClientLogs(enabled: boolean): void {
    this.allClientLogs = !!enabled
    writeBoolPref(ALL_CLIENT_LOGS_KEY, this.allClientLogs)
  }

  isAllClientLogs(): boolean {
    return this.allClientLogs
  }

  /**
   * Help → Debug “Capture console.log here” — pipe browser console into this panel.
   */
  setConsoleCapture(enabled: boolean): void {
    const next = !!enabled
    if (next === this.consoleCapture) return
    this.consoleCapture = next
    writeBoolPref(CONSOLE_CAPTURE_KEY, next)
    if (next) this.installConsoleHook()
    else this.uninstallConsoleHook()
  }

  isConsoleCapture(): boolean {
    return this.consoleCapture
  }

  log(category: string, message: string, options: DebugLogOptions = {}): void {
    // Silenced categories stay out unless “all categories” is on.
    const silenced = !this.allClientLogs && SILENCED_CATEGORIES.has(category)
    if (silenced) {
      // Still allow console mirror for non-panel path when mirror is on and panel is on?
      return
    }

    const level = options.level ?? 'info'
    const key = options.throttleKey ?? `${category}:${level}`
    const now = Date.now()

    if (options.throttleMs && options.throttleMs > 0) {
      const last = this.throttleAt.get(key) ?? 0
      if (now - last < options.throttleMs) return
      this.throttleAt.set(key, now)
    }

    // Panel stays empty until user opts in (Record client logs).
    if (this.panelRecord) {
      this.pushEntry(category, level, message)
    }

    if (this.consoleMirror) {
      this.writingConsole = true
      try {
        const prefix = `[${category}]`
        if (level === 'warn') console.warn(prefix, message)
        else if (level === 'error') console.error(prefix, message)
        else console.log(prefix, message)
      } finally {
        this.writingConsole = false
      }
    }
  }

  private pushEntry(category: string, level: DebugLogLevel, message: string): void {
    const entry: DebugLogEntry = {
      id: this.nextId++,
      at: Date.now(),
      category,
      level,
      message
    }

    this.entries.push(entry)
    if (this.entries.length > MAX_ENTRIES) {
      this.entries.splice(0, this.entries.length - MAX_ENTRIES)
    }
    for (const listener of this.listeners) listener(this.entries)
  }

  private installConsoleHook(): void {
    if (this.consoleHookInstalled || typeof console === 'undefined') return
    this.origConsole = {
      log: console.log.bind(console),
      info: console.info.bind(console),
      warn: console.warn.bind(console),
      error: console.error.bind(console)
    }
    const capture = (level: DebugLogLevel, args: unknown[]) => {
      if (this.writingConsole || !this.consoleCapture) return
      const msg = formatConsoleArgs(args).slice(0, 2000)
      if (!msg) return
      // Console capture always records into the panel when enabled.
      this.pushEntry('console', level, msg)
    }
    console.log = (...args: unknown[]) => {
      this.origConsole!.log(...args)
      capture('info', args)
    }
    console.info = (...args: unknown[]) => {
      this.origConsole!.info(...args)
      capture('info', args)
    }
    console.warn = (...args: unknown[]) => {
      this.origConsole!.warn(...args)
      capture('warn', args)
    }
    console.error = (...args: unknown[]) => {
      this.origConsole!.error(...args)
      capture('error', args)
    }
    this.consoleHookInstalled = true
  }

  private uninstallConsoleHook(): void {
    if (!this.consoleHookInstalled || !this.origConsole) return
    console.log = this.origConsole.log
    console.info = this.origConsole.info
    console.warn = this.origConsole.warn
    console.error = this.origConsole.error
    this.origConsole = null
    this.consoleHookInstalled = false
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
