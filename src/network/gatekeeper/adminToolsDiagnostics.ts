/**
 * Admin Tools smart-item gate diagnostics (Explorer parity).
 *
 * Scene `@dcl/asset-packs` shows Admin Tools UI only when:
 *   playersHelper.getPlayer().userId ∈ GET /scene-admin list
 *   OR getRealm().isPreview === true
 *
 * That list comes from signed gatekeeper (owners + delegated admins) — not Places
 * ownerAddresses. This module logs the client surfaces that feed that check.
 *
 * Filter console for `[admin-tools]`.
 */
import type { AuthIdentity } from '@dcl/crypto/dist/types'
import {
  performSignedFetch,
  type SignedFetchSceneContext
} from '../SignedFetchService'
import { GATEKEEPER_URL } from './GatekeeperClient'

export type AdminToolsIdentitySnapshot = {
  wallet: string | null
  /** Same string getUserData should expose as userId. */
  userId: string | null
  /** PlayerIdentityData.address on host projection (feeds getPlayer). */
  playerIdentityAddress: string | null
  isGuest: boolean
  hasAuthIdentity: boolean
  isPreview: boolean
  sceneId: string
  parcel: string
  realmName: string
  isWorld: boolean
}

export type SceneAdminListAnalysis = {
  ok: boolean
  status: number
  adminCount: number
  /** Wallet lowercased is in the list. */
  walletIsAdmin: boolean
  sampleAddresses: string[]
  error?: string
}

function normalizeAddress(addr: string | null | undefined): string | null {
  const t = addr?.trim().toLowerCase()
  return t || null
}

export function isSceneAdminGatekeeperUrl(url: string): boolean {
  try {
    const u = new URL(url)
    return u.hostname.includes('comms-gatekeeper') && u.pathname.includes('scene-admin')
  } catch {
    return /comms-gatekeeper/i.test(url) && /scene-admin/i.test(url)
  }
}

/** Parse GET /scene-admin JSON body into lowercased admin addresses. */
export function parseSceneAdminAddresses(body: unknown): string[] {
  const list = Array.isArray(body)
    ? body
    : body && typeof body === 'object' && Array.isArray((body as { admins?: unknown }).admins)
      ? (body as { admins: unknown[] }).admins
      : body && typeof body === 'object' && Array.isArray((body as { data?: unknown }).data)
        ? (body as { data: unknown[] }).data
        : []

  const out: string[] = []
  for (const row of list) {
    if (!row || typeof row !== 'object') continue
    const o = row as Record<string, unknown>
    const raw =
      (typeof o.admin === 'string' && o.admin) ||
      (typeof o.address === 'string' && o.address) ||
      (typeof o.adminAddress === 'string' && o.adminAddress) ||
      ''
    const n = normalizeAddress(raw)
    if (n && !out.includes(n)) out.push(n)
  }
  return out
}

export function analyzeSceneAdminResponse(
  status: number,
  ok: boolean,
  bodyText: string,
  wallet: string | null
): SceneAdminListAnalysis {
  if (!ok) {
    return {
      ok: false,
      status,
      adminCount: 0,
      walletIsAdmin: false,
      sampleAddresses: [],
      error: bodyText.slice(0, 180) || `http_${status}`
    }
  }
  let parsed: unknown = null
  try {
    parsed = JSON.parse(bodyText || '[]')
  } catch {
    return {
      ok: false,
      status,
      adminCount: 0,
      walletIsAdmin: false,
      sampleAddresses: [],
      error: 'invalid_json'
    }
  }
  const addresses = parseSceneAdminAddresses(parsed)
  const w = normalizeAddress(wallet)
  return {
    ok: true,
    status,
    adminCount: addresses.length,
    walletIsAdmin: !!w && addresses.includes(w),
    sampleAddresses: addresses.slice(0, 6)
  }
}

export function logAdminToolsIdentitySnapshot(
  snap: AdminToolsIdentitySnapshot,
  label = 'identity'
): void {
  const wallet = normalizeAddress(snap.wallet)
  const userId = normalizeAddress(snap.userId)
  const pid = normalizeAddress(snap.playerIdentityAddress)

  const parityUserId =
    !!wallet && !!userId && wallet === userId
      ? 'ok'
      : `MISMATCH wallet=${wallet?.slice(0, 12) ?? 'null'} userId=${userId?.slice(0, 12) ?? 'null'}`
  const parityPid =
    !!wallet && !!pid && wallet === pid
      ? 'ok'
      : wallet && !pid
        ? 'NO_PLAYER_IDENTITY'
        : `MISMATCH pid=${pid?.slice(0, 12) ?? 'null'}`

  console.warn(
    `[admin-tools] ${label} — ` +
      `wallet=${wallet ? wallet.slice(0, 12) + '…' : 'NONE'} ` +
      `guest=${snap.isGuest} authIdentity=${snap.hasAuthIdentity ? 'yes' : 'NO'} ` +
      `isPreview=${snap.isPreview} ` +
      `sceneId=${snap.sceneId ? snap.sceneId.slice(0, 18) + '…' : 'EMPTY'} ` +
      `parcel=${snap.parcel || '—'} realm=${snap.realmName || '—'} world=${snap.isWorld} ` +
      `userIdParity=${parityUserId} playerIdentityParity=${parityPid}`
  )

  if (snap.isPreview) {
    console.warn(
      '[admin-tools] isPreview=true — asset-packs treats ALL visitors as admin (Explorer preview only)'
    )
  }
  if (!snap.hasAuthIdentity && !snap.isGuest) {
    console.warn(
      '[admin-tools] no AuthIdentity — signed GET /scene-admin will fail; Admin Tools UI stays hidden'
    )
  }
  if (wallet && userId && wallet !== userId) {
    console.warn(
      '[admin-tools] COD: getUserData.userId must equal session wallet (case-insensitive)'
    )
  }
  if (wallet && pid && wallet !== pid) {
    console.warn(
      '[admin-tools] COD: PlayerIdentityData.address must equal session wallet for getPlayer()'
    )
  }
}

export function logSceneAdminAnalysis(
  analysis: SceneAdminListAnalysis,
  wallet: string | null,
  source: string
): void {
  const w = normalizeAddress(wallet)
  if (!analysis.ok) {
    console.warn(
      `[admin-tools] scene-admin FAIL (${source}) status=${analysis.status} ` +
        `error=${analysis.error ?? '?'} — Admin Tools UI will not show for wallet`
    )
    return
  }
  console.warn(
    `[admin-tools] scene-admin OK (${source}) status=${analysis.status} ` +
      `admins=${analysis.adminCount} ` +
      `walletIsAdmin=${analysis.walletIsAdmin} ` +
      `wallet=${w ? w.slice(0, 12) + '…' : 'NONE'} ` +
      `sample=[${analysis.sampleAddresses.map((a) => a.slice(0, 10) + '…').join(', ')}]`
  )
  if (w && !analysis.walletIsAdmin && analysis.adminCount > 0) {
    console.warn(
      '[admin-tools] wallet not in gatekeeper admin list — UI hidden. ' +
        'For worlds, realm.hostname must include worlds-content-server (else gatekeeper ' +
        'resolves Genesis parcel 0,0 land operators instead of the world NAME owner).'
    )
  }
  if (analysis.adminCount === 0) {
    console.warn(
      '[admin-tools] empty admin list — land/world owner may still be missing from gatekeeper for this sceneId'
    )
  }
}

/**
 * One-shot probe after play-ready: same signed GET Admin Tools uses.
 * Does not change product behavior — diagnostics only.
 */
export async function probeSceneAdminForAdminTools(opts: {
  identity: AuthIdentity | null
  sceneContext: SignedFetchSceneContext | null
  wallet: string | null
  isPreview: boolean
}): Promise<SceneAdminListAnalysis | null> {
  const { identity, sceneContext, wallet, isPreview } = opts
  if (isPreview) {
    console.warn('[admin-tools] probe skipped — isPreview (UI would force-show for everyone)')
    return null
  }
  if (!sceneContext?.sceneId) {
    console.warn('[admin-tools] probe skipped — no signedFetch sceneId (context integrity fail)')
    return null
  }
  if (!identity) {
    console.warn('[admin-tools] probe skipped — no AuthIdentity')
    return null
  }

  const url = `${GATEKEEPER_URL}/scene-admin`
  const res = await performSignedFetch({ url }, identity, sceneContext)
  const analysis = analyzeSceneAdminResponse(res.status, res.ok, res.body ?? '', wallet)
  logSceneAdminAnalysis(analysis, wallet, 'play-ready-probe')
  return analysis
}

/** Throttle live scene-admin signedFetch logs from the scene toolkit. */
let lastLiveAdminLogAt = 0
const LIVE_ADMIN_LOG_MIN_MS = 4000

export function maybeLogLiveSceneAdminSignedFetch(
  url: string,
  status: number,
  ok: boolean,
  body: string,
  wallet: string | null
): void {
  if (!isSceneAdminGatekeeperUrl(url)) return
  const now = performance.now()
  if (now - lastLiveAdminLogAt < LIVE_ADMIN_LOG_MIN_MS) return
  lastLiveAdminLogAt = now
  const analysis = analyzeSceneAdminResponse(status, ok, body, wallet)
  logSceneAdminAnalysis(analysis, wallet, 'scene-signedFetch')
}
