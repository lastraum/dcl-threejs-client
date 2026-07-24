/**
 * ADR-208 private DMs are not stored server-side. This module pins open DM
 * threads + recent text history in localStorage so the rail and transcript
 * survive reloads (per wallet).
 */

import type { ChatLine, ChatTextLine } from './types'
import { isChatImageLine, isChatTextLine } from './types'

const STORAGE_PREFIX = 'dcl-dm-local-v1:'
const STORE_VERSION = 1 as const
/** Cap open/pinned DM threads per wallet. */
export const DM_LOCAL_MAX_THREADS = 40
/** Cap stored text lines per thread. */
export const DM_LOCAL_MAX_LINES = 80

export type StoredDmTextLine = {
  id: string
  text: string
  time: number
  self?: boolean
  senderAddress?: string
  senderName?: string
}

export type StoredDmThread = {
  address: string
  displayName: string
  updatedAt: number
  lines: StoredDmTextLine[]
}

type StoreFile = {
  version: typeof STORE_VERSION
  threads: StoredDmThread[]
}

const ETH_RE = /^0x[a-f0-9]{40}$/

function storageKey(localAddress: string): string {
  return `${STORAGE_PREFIX}${localAddress.trim().toLowerCase()}`
}

function emptyFile(): StoreFile {
  return { version: STORE_VERSION, threads: [] }
}

function readFile(localAddress: string): StoreFile {
  const key = localAddress.trim().toLowerCase()
  if (!ETH_RE.test(key)) return emptyFile()
  try {
    const raw = localStorage.getItem(storageKey(key))
    if (!raw) return emptyFile()
    const parsed = JSON.parse(raw) as Partial<StoreFile>
    if (parsed.version !== STORE_VERSION || !Array.isArray(parsed.threads)) return emptyFile()
    const threads: StoredDmThread[] = []
    for (const t of parsed.threads) {
      if (!t || typeof t !== 'object') continue
      const address = String(t.address ?? '')
        .trim()
        .toLowerCase()
      if (!ETH_RE.test(address)) continue
      const displayName =
        typeof t.displayName === 'string' && t.displayName.trim()
          ? t.displayName.trim()
          : `${address.slice(0, 6)}…${address.slice(-4)}`
      const updatedAt =
        typeof t.updatedAt === 'number' && Number.isFinite(t.updatedAt) ? t.updatedAt : 0
      const lines: StoredDmTextLine[] = []
      if (Array.isArray(t.lines)) {
        for (const line of t.lines) {
          if (!line || typeof line !== 'object') continue
          const text = typeof line.text === 'string' ? line.text.trim() : ''
          if (!text) continue
          const id = typeof line.id === 'string' && line.id ? line.id : `stored-${lines.length}`
          const time =
            typeof line.time === 'number' && Number.isFinite(line.time)
              ? line.time
              : Date.now() / 1000
          lines.push({
            id,
            text,
            time,
            self: line.self === true,
            senderAddress:
              typeof line.senderAddress === 'string' ? line.senderAddress.toLowerCase() : undefined,
            senderName: typeof line.senderName === 'string' ? line.senderName : undefined
          })
          if (lines.length >= DM_LOCAL_MAX_LINES) break
        }
      }
      threads.push({ address, displayName, updatedAt, lines })
      if (threads.length >= DM_LOCAL_MAX_THREADS) break
    }
    // Most recently updated first.
    threads.sort((a, b) => b.updatedAt - a.updatedAt)
    return { version: STORE_VERSION, threads }
  } catch {
    return emptyFile()
  }
}

function writeFile(localAddress: string, file: StoreFile): void {
  const key = localAddress.trim().toLowerCase()
  if (!ETH_RE.test(key)) return
  try {
    const threads = [...file.threads]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, DM_LOCAL_MAX_THREADS)
      .map((t) => ({
        ...t,
        lines: t.lines.slice(-DM_LOCAL_MAX_LINES)
      }))
    localStorage.setItem(storageKey(key), JSON.stringify({ version: STORE_VERSION, threads }))
  } catch {
    /* quota / private mode */
  }
}

/** Text-only lines suitable for localStorage (skip blob image messages). */
export function chatLinesToStored(lines: readonly ChatLine[]): StoredDmTextLine[] {
  const out: StoredDmTextLine[] = []
  for (const line of lines) {
    if (isChatImageLine(line)) continue
    if (!isChatTextLine(line)) continue
    const text = line.text.trim()
    if (!text) continue
    out.push({
      id: line.id,
      text,
      time: line.time,
      self: line.self === true,
      senderAddress: line.senderAddress?.toLowerCase(),
      senderName: line.senderName
    })
    if (out.length >= DM_LOCAL_MAX_LINES) {
      // Keep the newest slice.
      out.splice(0, out.length - DM_LOCAL_MAX_LINES)
    }
  }
  return out.slice(-DM_LOCAL_MAX_LINES)
}

export function storedLinesToChat(lines: readonly StoredDmTextLine[]): ChatTextLine[] {
  return lines.map((line) => ({
    kind: 'text' as const,
    id: line.id,
    text: line.text,
    time: line.time,
    self: line.self,
    senderAddress: line.senderAddress,
    senderName: line.senderName
  }))
}

/** Load all pinned DM threads for a wallet. */
export function loadDmLocalThreads(localAddress: string): StoredDmThread[] {
  return readFile(localAddress).threads
}

/**
 * Upsert one thread (pin + history). Pass `lines` to replace history; omit to keep existing lines.
 */
export function upsertDmLocalThread(
  localAddress: string,
  peerAddress: string,
  displayName: string,
  lines?: readonly ChatLine[]
): void {
  const me = localAddress.trim().toLowerCase()
  const peer = peerAddress.trim().toLowerCase()
  if (!ETH_RE.test(me) || !ETH_RE.test(peer) || peer === me) return
  const file = readFile(me)
  const name =
    displayName.trim() ||
    file.threads.find((t) => t.address === peer)?.displayName ||
    `${peer.slice(0, 6)}…${peer.slice(-4)}`
  const existing = file.threads.find((t) => t.address === peer)
  const nextLines =
    lines != null ? chatLinesToStored(lines) : existing?.lines ?? []
  const next: StoredDmThread = {
    address: peer,
    displayName: name,
    updatedAt: Date.now(),
    lines: nextLines
  }
  const rest = file.threads.filter((t) => t.address !== peer)
  writeFile(me, { version: STORE_VERSION, threads: [next, ...rest] })
}

/** Remove a pinned DM (rail dismiss). */
export function removeDmLocalThread(localAddress: string, peerAddress: string): void {
  const me = localAddress.trim().toLowerCase()
  const peer = peerAddress.trim().toLowerCase()
  if (!ETH_RE.test(me) || !ETH_RE.test(peer)) return
  const file = readFile(me)
  const threads = file.threads.filter((t) => t.address !== peer)
  if (threads.length === file.threads.length) return
  writeFile(me, { version: STORE_VERSION, threads })
}

/** Snapshot every open thread from SocialService maps. */
export function saveAllDmLocalThreads(
  localAddress: string,
  threads: ReadonlyArray<{ address: string; displayName: string; lines: readonly ChatLine[] }>
): void {
  const me = localAddress.trim().toLowerCase()
  if (!ETH_RE.test(me)) return
  const now = Date.now()
  const stored: StoredDmThread[] = []
  for (const t of threads) {
    const address = t.address.trim().toLowerCase()
    if (!ETH_RE.test(address) || address === me) continue
    stored.push({
      address,
      displayName: t.displayName.trim() || `${address.slice(0, 6)}…${address.slice(-4)}`,
      updatedAt: now,
      lines: chatLinesToStored(t.lines)
    })
    if (stored.length >= DM_LOCAL_MAX_THREADS) break
  }
  writeFile(me, { version: STORE_VERSION, threads: stored })
}
