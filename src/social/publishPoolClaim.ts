/**
 * Publish a Loot Bag claim on the private-messages LiveKit room
 * (topic `d3js-lootbag:claims`). Peers toast; sender does not.
 */
import type { AuthIdentity } from '@dcl/crypto/dist/types'
import { clientDebugLog } from '../client/debug/ClientDebugLog'
import { getPrivateMessagesService } from './PrivateMessagesService'
import type { PoolClaimWireMsg } from './poolClaimWire'

export type PublishPoolClaimArgs = {
  identity: AuthIdentity | null | undefined
  address: string | null | undefined
  displayName?: string | null
  positionId: number
  label: string
  demo?: boolean
  imageUrl?: string | null
  rarity?: string | null
  issueId?: string | null
  itemName?: string | null
  kind?: 'nft' | 'pack' | null
  /** Formatted mMANA (pack prize or take-tokens payout). */
  manaAmount?: string | null
  /** Keep prize vs take MANA. */
  outcome?: 'keep' | 'take' | null
}

export async function publishPoolClaim(args: PublishPoolClaimArgs): Promise<boolean> {
  const addr = args.address?.trim().toLowerCase() ?? ''
  if (!args.identity) {
    clientDebugLog.log('social', 'Pool claim publish aborted — no auth identity', {
      level: 'warn',
      alsoConsole: true
    })
    return false
  }
  if (!/^0x[a-f0-9]{40}$/.test(addr)) {
    clientDebugLog.log(
      'social',
      `Pool claim publish aborted — bad address “${(args.address ?? '').slice(0, 18)}”`,
      { level: 'warn', alsoConsole: true }
    )
    return false
  }
  if (!Number.isFinite(args.positionId) || args.positionId < 1) {
    clientDebugLog.log('social', `Pool claim publish aborted — bad positionId=${args.positionId}`, {
      level: 'warn',
      alsoConsole: true
    })
    return false
  }

  const pm = getPrivateMessagesService()
  // Ensure we're on the shared PM room without stealing another holder's session.
  pm.retain()
  try {
    const ok = await pm.connect(args.identity, addr)
    if (!ok || !pm.isConnected()) {
      const err = pm.getLastError() ?? 'connect returned false'
      clientDebugLog.log('social', `Pool claim publish aborted — PM connect failed: ${err}`, {
        level: 'warn',
        alsoConsole: true
      })
      return false
    }
    const msg: PoolClaimWireMsg = {
      t: 'claim',
      a: addr,
      p: Math.floor(args.positionId),
      l: (args.label || `pos ${args.positionId}`).slice(0, 80),
      at: Date.now(),
      n: args.displayName?.trim().slice(0, 48) || undefined,
      demo: args.demo === true ? true : undefined,
      img: args.imageUrl?.trim().slice(0, 512) || undefined,
      r: args.rarity?.trim().toLowerCase().slice(0, 24) || undefined,
      issue: args.issueId?.trim().slice(0, 24) || undefined,
      name: args.itemName?.trim().slice(0, 80) || undefined,
      k: args.kind === 'pack' || args.kind === 'nft' ? args.kind : undefined,
      mana: args.manaAmount?.trim().slice(0, 32) || undefined,
      out: args.outcome === 'keep' || args.outcome === 'take' ? args.outcome : undefined
    }
    const sent = await pm.sendPoolClaim(msg)
    // Brief hold so reliable SCTP can flush before optional teardown on release.
    if (sent) await new Promise((r) => setTimeout(r, 300))
    return sent
  } finally {
    pm.release()
  }
}
