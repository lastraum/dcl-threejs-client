/**
 * Collection V2 minter checks + authorize pool as global minter via meta-tx.
 * Stock fails with `_issueToken: CALLER_CAN_NOT_MINT` until the pool is a minter.
 */
import { type Address, type Hex } from 'viem'
import { ADDRESSES } from './config'
import {
  DCL_COLLECTION_V2_META_TX_DOMAIN,
  ensureWalletAddress,
  sendContractMetaTx,
  waitReceipt
} from './metaTx'
import { polygonPublicClient } from './polygonClient'

/** Minimal Collection V2 surface */
export const collectionV2MinterAbi = [
  {
    type: 'function',
    name: 'globalMinters',
    stateMutability: 'view',
    inputs: [{ name: 'minter', type: 'address' }],
    outputs: [{ type: 'bool' }]
  },
  {
    type: 'function',
    name: 'creator',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }]
  },
  {
    type: 'function',
    name: 'isMintingAllowed',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'bool' }]
  },
  {
    type: 'function',
    name: 'setMinters',
    stateMutability: 'nonpayable',
    inputs: [
      { name: '_minters', type: 'address[]' },
      { name: '_values', type: 'bool[]' }
    ],
    outputs: []
  },
  {
    type: 'function',
    name: 'itemMinters',
    stateMutability: 'view',
    inputs: [
      { name: 'itemId', type: 'uint256' },
      { name: 'minter', type: 'address' }
    ],
    outputs: [{ type: 'uint256' }]
  }
] as const

export type CollectionMinterStatus = {
  collection: Address
  pool: Address
  isGlobalMinter: boolean
  /** Remaining per-item allowance (0 if none / unread) */
  itemAllowance: bigint
  canMintItem: boolean
  isCreator: boolean
  mintingAllowed: boolean
  creator: Address | null
}

function isAddr(a: string): a is Address {
  return /^0x[a-fA-F0-9]{40}$/.test(a)
}

function stringifyUnknown(err: unknown): string {
  if (err instanceof Error) return err.message || err.name
  if (typeof err === 'string') return err
  if (err && typeof err === 'object') {
    const o = err as Record<string, unknown>
    if (typeof o.message === 'string') return o.message
    if (typeof o.reason === 'string') return o.reason
    try {
      return JSON.stringify(err)
    } catch {
      return Object.prototype.toString.call(err)
    }
  }
  return String(err)
}

export async function getCollectionMinterStatus(
  collectionRaw: string,
  opts?: { itemId?: number | bigint; account?: string | null }
): Promise<CollectionMinterStatus> {
  const collection = collectionRaw.trim().toLowerCase() as Address
  if (!isAddr(collection)) throw new Error('Invalid collection address')
  const pool = ADDRESSES.lootBagPool.toLowerCase() as Address
  const itemId = opts?.itemId != null ? BigInt(opts.itemId) : null

  let isGlobalMinter = false
  let itemAllowance = 0n
  let creator: Address | null = null
  let mintingAllowed = false

  try {
    isGlobalMinter = (await polygonPublicClient.readContract({
      address: collection,
      abi: collectionV2MinterAbi,
      functionName: 'globalMinters',
      args: [pool]
    })) as boolean
  } catch {
    isGlobalMinter = false
  }

  if (itemId != null) {
    try {
      itemAllowance = (await polygonPublicClient.readContract({
        address: collection,
        abi: collectionV2MinterAbi,
        functionName: 'itemMinters',
        args: [itemId, pool]
      })) as bigint
    } catch {
      itemAllowance = 0n
    }
  }

  try {
    creator = (
      (await polygonPublicClient.readContract({
        address: collection,
        abi: collectionV2MinterAbi,
        functionName: 'creator'
      })) as string
    ).toLowerCase() as Address
  } catch {
    creator = null
  }

  try {
    mintingAllowed = (await polygonPublicClient.readContract({
      address: collection,
      abi: collectionV2MinterAbi,
      functionName: 'isMintingAllowed'
    })) as boolean
  } catch {
    mintingAllowed = true // don't block if view missing
  }

  const account = opts?.account?.trim().toLowerCase() ?? null
  const isCreator = Boolean(creator && account && creator === account)
  const canMintItem = isGlobalMinter || itemAllowance > 0n

  return {
    collection,
    pool,
    isGlobalMinter,
    itemAllowance,
    canMintItem,
    isCreator,
    mintingAllowed,
    creator
  }
}

/**
 * Meta-tx: collection.setMinters([lootBagPool], [true]).
 * EIP-712 domain = Decentraland Collection / 2 (Collection V2).
 * Creator must sign; relay pays gas. Collection must pass dcl-meta-tx allowlist
 * (DCL collections subgraph usually covers published Collection V2).
 */
export async function authorizePoolAsCollectionMinter(args: {
  collection: string
  sessionAddress?: string | null
}): Promise<Hex> {
  const from = await ensureWalletAddress(args.sessionAddress)
  const collection = args.collection.trim().toLowerCase() as Address
  if (!isAddr(collection)) throw new Error('Invalid collection address')
  const pool = ADDRESSES.lootBagPool

  const status = await getCollectionMinterStatus(collection, { account: from })
  if (status.isGlobalMinter) {
    throw new Error('Loot Bag is already a global minter on this collection')
  }
  if (status.creator && status.creator !== from.toLowerCase()) {
    throw new Error(
      `Only the collection creator (${status.creator.slice(0, 8)}…) can call setMinters. Connected: ${from.slice(0, 8)}…`
    )
  }

  const hash = await sendContractMetaTx({
    address: collection,
    abi: collectionV2MinterAbi as unknown as import('viem').Abi,
    functionName: 'setMinters',
    args: [[pool], [true]],
    from,
    domainOverride: DCL_COLLECTION_V2_META_TX_DOMAIN
  })
  await waitReceipt(hash)

  // Confirm on-chain
  for (let i = 0; i < 12; i++) {
    const again = await getCollectionMinterStatus(collection, { account: from })
    if (again.isGlobalMinter) return hash
    await new Promise((r) => setTimeout(r, 1500))
  }
  throw new Error(
    'setMinters confirmed but pool still not globalMinter — wait and retry stock'
  )
}

/** Map RPC / relayer gibberish to actionable stock errors. */
export function humanizeStockError(err: unknown): string {
  const raw = stringifyUnknown(err)
  // Avoid "[object Object]"
  if (!raw || raw === '[object Object]') {
    try {
      return `Wallet / relay error: ${JSON.stringify(err)}`.slice(0, 400)
    } catch {
      return 'Unknown wallet / relay error'
    }
  }
  const lower = raw.toLowerCase()

  if (
    raw.includes('CALLER_CAN_NOT_MINT') ||
    lower.includes('caller_can_not_mint') ||
    lower.includes('_issuetoken: caller_can_not_mint')
  ) {
    return (
      'Loot Bag is not allowed to mint on this collection yet. ' +
      'Stock will prompt setMinters as step 1 (meta-tx) if you are the creator. ' +
      `Loot Bag: ${ADDRESSES.lootBagPool}`
    )
  }

  if (raw.includes('ITEM_EXHAUSTED') || lower.includes('item_exhausted')) {
    return 'Not enough remaining supply on this item for that mint count. Lower the count.'
  }

  if (raw.includes('MINT_NOT_ALLOWED') || lower.includes('mint_not_allowed')) {
    return 'Collection is not approved/completed for minting yet (isMintingAllowed = false).'
  }

  if (raw.includes('onlyCreator') || lower.includes('caller_is_not_creator')) {
    return 'Only the collection creator can authorize the Loot Bag as minter (setMinters).'
  }

  if (raw.includes('UNPREDICTABLE_GAS_LIMIT') || lower.includes('cannot estimate gas')) {
    if (raw.includes('execution reverted:')) {
      const m = raw.match(/execution reverted:\s*([^"\\]+)/i)
      if (m?.[1]) return humanizeStockError(new Error(m[1].trim()))
    }
    if (raw.includes('CALLER_CAN_NOT_MINT')) {
      return humanizeStockError(new Error('CALLER_CAN_NOT_MINT'))
    }
    return (
      'Transaction would revert on-chain (gas estimate failed). ' +
      'Most common: Loot Bag is not a minter — stock flow will try setMinters first. ' +
      `Detail: ${raw.slice(0, 220)}`
    )
  }

  if (raw.includes('ClaimsPaused') || lower.includes('claimspaused')) {
    return 'Claiming is paused — you can still add loot to the bag.'
  }

  if (raw.includes('EnforcedPause') || lower.includes('enforcedpause')) {
    return 'Loot Bag is paused (emergency freeze). Deposits and claims are both blocked.'
  }

  if (lower.includes('user rejected') || lower.includes('user denied') || lower.includes('rejected the request')) {
    return 'Signature / transaction rejected in wallet.'
  }

  if (lower.includes('not allowed') && lower.includes('contract')) {
    return (
      'Relay rejected this collection address. Add it to dcl-meta-tx EXTRA_CONTRACT_ADDRESSES ' +
      'or ensure it is a published DCL Collection V2 (subgraph).'
    )
  }

  return raw
}
