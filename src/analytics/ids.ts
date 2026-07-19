const VISITOR_KEY = 'tjc_analytics_visitor_id'
const SESSION_KEY = 'tjc_analytics_session_id'

function randomId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

function readStorage(storage: Storage | undefined, key: string): string | null {
  if (!storage) return null
  try {
    const v = storage.getItem(key)?.trim()
    return v || null
  } catch {
    return null
  }
}

function writeStorage(storage: Storage | undefined, key: string, value: string): void {
  if (!storage) return
  try {
    storage.setItem(key, value)
  } catch {
    /* quota / private mode */
  }
}

/** Sticky anonymous id (localStorage). */
export function getVisitorId(): string {
  if (typeof window === 'undefined') return randomId()
  const existing = readStorage(window.localStorage, VISITOR_KEY)
  if (existing) return existing
  const id = randomId()
  writeStorage(window.localStorage, VISITOR_KEY, id)
  return id
}

/** Per-tab session id (sessionStorage). */
export function getSessionId(): string {
  if (typeof window === 'undefined') return randomId()
  const existing = readStorage(window.sessionStorage, SESSION_KEY)
  if (existing) return existing
  const id = randomId()
  writeStorage(window.sessionStorage, SESSION_KEY, id)
  return id
}

export function newEventId(): string {
  return randomId()
}

export function newPlaySessionId(): string {
  return randomId()
}
