import { fetchSceneParticipants } from './gatekeeper/GatekeeperClient'

const LOCK_KEY_PREFIX = 'dcl-wallet-session:'
const LOCK_STALE_MS = 12_000

type WalletSessionLock = {
  tabId: string
  ts: number
}

function tabId(): string {
  const key = 'dcl-client-tab-id'
  let id = sessionStorage.getItem(key)
  if (!id) {
    id = crypto.randomUUID()
    sessionStorage.setItem(key, id)
  }
  return id
}

function lockKey(address: string): string {
  return `${LOCK_KEY_PREFIX}${address.toLowerCase()}`
}

function readLock(address: string): WalletSessionLock | null {
  try {
    const raw = localStorage.getItem(lockKey(address))
    if (!raw) return null
    const parsed = JSON.parse(raw) as WalletSessionLock
    if (!parsed?.tabId || typeof parsed.ts !== 'number') return null
    return parsed
  } catch {
    return null
  }
}

/** One active browser session per wallet — blocks a second tab on the same machine. */
export function acquireWalletSessionLock(address: string): boolean {
  const key = address.toLowerCase()
  if (!/^0x[a-f0-9]{40}$/.test(key)) return true

  const now = Date.now()
  const owner = tabId()
  const existing = readLock(key)
  if (existing && existing.tabId !== owner && now - existing.ts < LOCK_STALE_MS) {
    return false
  }

  try {
    localStorage.setItem(lockKey(key), JSON.stringify({ tabId: owner, ts: now } satisfies WalletSessionLock))
    return true
  } catch {
    return true
  }
}

export function refreshWalletSessionLock(address: string): void {
  const key = address.toLowerCase()
  if (!/^0x[a-f0-9]{40}$/.test(key)) return

  const existing = readLock(key)
  if (!existing || existing.tabId !== tabId()) return

  try {
    localStorage.setItem(lockKey(key), JSON.stringify({ tabId: tabId(), ts: Date.now() } satisfies WalletSessionLock))
  } catch {
    // ignore quota / private mode
  }
}

export function releaseWalletSessionLock(address: string): void {
  const key = address.toLowerCase()
  if (!/^0x[a-f0-9]{40}$/.test(key)) return

  const existing = readLock(key)
  if (!existing || existing.tabId !== tabId()) return

  try {
    localStorage.removeItem(lockKey(key))
  } catch {
    // ignore
  }
}

/** Gatekeeper scene roster — wallet already listed means another client is in-scene. */
export async function isWalletListedInScene(
  pointer: string,
  realmName: string,
  address: string
): Promise<boolean> {
  const key = address.toLowerCase()
  if (!/^0x[a-f0-9]{40}$/.test(key)) return false

  const participants = await fetchSceneParticipants(pointer, realmName)
  return participants.includes(key)
}