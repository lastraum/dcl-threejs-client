/**
 * Publish a marketplace purchase on the private-messages LiveKit room
 * (topic `d3js-marketplace:purchases`). Peers toast; sender also gets a local toast.
 */
import type { AuthIdentity } from '@dcl/crypto/dist/types'
import { clientDebugLog } from '../client/debug/ClientDebugLog'
import { getPrivateMessagesService } from './PrivateMessagesService'
import type { MarketplacePurchaseWireMsg } from './marketplacePurchaseWire'

export type PublishMarketplacePurchaseArgs = {
  identity: AuthIdentity | null | undefined
  address: string | null | undefined
  displayName?: string | null
  itemName: string
  contractAddress: string
  itemId: string
  catalogId?: string | null
  imageUrl?: string | null
  rarity?: string | null
}

export async function publishMarketplacePurchase(
  args: PublishMarketplacePurchaseArgs
): Promise<boolean> {
  const addr = args.address?.trim().toLowerCase() ?? ''
  const ca = args.contractAddress?.trim().toLowerCase() ?? ''
  const iid = args.itemId?.trim() ?? ''
  if (!args.identity) {
    clientDebugLog.log('social', 'Marketplace purchase publish aborted — no auth identity', {
      level: 'warn',
      alsoConsole: true
    })
    return false
  }
  if (!/^0x[a-f0-9]{40}$/.test(addr) || !/^0x[a-f0-9]{40}$/.test(ca) || !iid) {
    clientDebugLog.log('social', 'Marketplace purchase publish aborted — bad ids', {
      level: 'warn',
      alsoConsole: true
    })
    return false
  }

  const pm = getPrivateMessagesService()
  pm.retain()
  try {
    const ok = await pm.connect(args.identity, addr)
    if (!ok || !pm.isConnected()) {
      const err = pm.getLastError() ?? 'connect returned false'
      clientDebugLog.log('social', `Marketplace purchase PM connect failed: ${err} — still toasting locally`, {
        level: 'warn',
        alsoConsole: true
      })
    }
    const msg: MarketplacePurchaseWireMsg = {
      t: 'buy',
      a: addr,
      ca,
      iid: iid.slice(0, 80),
      name: (args.itemName || 'Collectible').slice(0, 80),
      at: Date.now(),
      n: args.displayName?.trim().slice(0, 48) || undefined,
      img: args.imageUrl?.trim().slice(0, 512) || undefined,
      id: args.catalogId?.trim().slice(0, 128) || undefined,
      r: args.rarity?.trim().toLowerCase().slice(0, 24) || undefined
    }
    const sent = await pm.sendMarketplacePurchase(msg)
    if (sent) await new Promise((r) => setTimeout(r, 200))
    return sent
  } finally {
    pm.release()
  }
}
