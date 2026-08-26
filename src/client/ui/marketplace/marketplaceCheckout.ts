import { type Address, type Hex } from 'viem'
import { getGuestPrivateKeyHex } from '../../../auth/guestIdentity'
import { privateKeyToAccount } from 'viem/accounts'
import {
  MARKETPLACE_META_TX_DOMAIN,
  MARKETPLACE_POLYGON,
  POLYGON_MANA,
  POLYGON_MANA_META_TX_DOMAIN,
  ZERO_ADDRESS,
  erc20Abi,
  marketplaceAbi
} from '../trade/marketplaceConfig'
import { sendContractMetaTx, waitReceipt } from '../../../lootBag/metaTx'
import { polygonPublicClient } from '../../../lootBag/polygonClient'
import { fetchTrade, listingPayWei, type CatalogItem } from './marketplaceApi'

const COLLECTION_STORE = '0x214ffC0f0103735728dc66b61A22e4F163e275ae' as Address

const collectionStoreAbi = [
  {
    type: 'function',
    name: 'buy',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: '_itemsToBuy',
        type: 'tuple[]',
        components: [
          { name: 'collection', type: 'address' },
          { name: 'ids', type: 'uint256[]' },
          { name: 'prices', type: 'uint256[]' },
          { name: 'beneficiaries', type: 'address[]' }
        ]
      }
    ],
    outputs: []
  }
] as const

export type CartLine = {
  key: string
  item: CatalogItem
  source: 'store' | 'listing' | 'legacy'
  tradeId?: string | null
  /** Primary mints only. Secondary listings stay at 1. */
  quantity: number
  creatorName?: string
}

function asAddr(s: string): Address {
  return s.toLowerCase() as Address
}

function asBig(v: unknown): bigint {
  if (typeof v === 'bigint') return v
  if (typeof v === 'number') return BigInt(Math.trunc(v))
  if (typeof v === 'string' && v !== '') {
    if (v.startsWith('0x')) return BigInt(v)
    return BigInt(v)
  }
  return 0n
}

function asHex(v: unknown, fallback: Hex = '0x'): Hex {
  if (typeof v === 'string' && v.startsWith('0x')) return v as Hex
  return fallback
}

type Note = (msg: string) => void

async function resolveKey(sessionAddress: string, isGuest: boolean): Promise<Hex | undefined> {
  const want = sessionAddress.toLowerCase()
  const pk = getGuestPrivateKeyHex() as Hex | null
  if (pk) {
    try {
      if (privateKeyToAccount(pk).address.toLowerCase() === want) return pk
    } catch {
      /* ignore */
    }
  }
  if (isGuest) throw new Error('Guest session has no matching local key for checkout')
  return undefined
}

async function ensureManaAllowance(owner: Address, spender: Address, amount: bigint, privateKey?: Hex, note?: Note): Promise<void> {
  if (amount <= 0n) return
  const allowance = (await polygonPublicClient.readContract({
    address: POLYGON_MANA,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [owner, spender]
  })) as bigint
  if (allowance >= amount) return
  note?.('Approve MANA…')
  const hash = await sendContractMetaTx({
    address: POLYGON_MANA,
    abi: erc20Abi,
    functionName: 'approve',
    args: [spender, 2n ** 256n - 1n],
    from: owner,
    domainOverride: POLYGON_MANA_META_TX_DOMAIN,
    calldataField: 'functionSignature',
    executeStyle: 'legacy-rsv',
    privateKey
  })
  await waitReceipt(hash)
}

function patchSentBeneficiary(trade: Record<string, unknown>, beneficiary: Address): Record<string, unknown> {
  const sent = trade.sent
  if (!Array.isArray(sent)) return trade
  return {
    ...trade,
    sent: sent.map((a) => {
      if (!a || typeof a !== 'object') return a
      const asset = a as Record<string, unknown>
      return { ...asset, beneficiary }
    })
  }
}

function tradeArgFromApi(raw: Record<string, unknown>, beneficiary: Address): Record<string, unknown> {
  const t = (raw.trade as Record<string, unknown> | undefined) ?? raw
  const checksRaw = (t.checks as Record<string, unknown> | undefined) ?? {}
  const patched = patchSentBeneficiary(t, beneficiary)
  const sent = (patched.sent as Record<string, unknown>[]) ?? []
  const received = (Array.isArray(t.received) ? t.received : []) as Record<string, unknown>[]
  const mapAsset = (a: Record<string, unknown>) => ({
    assetType: asBig(a.assetType),
    contractAddress: asAddr(String(a.contractAddress ?? a.contract ?? ZERO_ADDRESS)),
    value: asBig(a.value ?? a.itemId ?? a.tokenId ?? a.amount ?? 0),
    beneficiary: asAddr(String(a.beneficiary || ZERO_ADDRESS)),
    extra: asHex(a.extra, '0x')
  })
  return {
    signer: asAddr(String(t.signer ?? raw.signer ?? ZERO_ADDRESS)),
    signature: asHex(t.signature ?? raw.signature),
    checks: {
      uses: asBig(checksRaw.uses ?? 1),
      expiration: asBig(checksRaw.expiration ?? 0),
      effective: asBig(checksRaw.effective ?? 0),
      salt: asHex(checksRaw.salt, '0x0000000000000000000000000000000000000000000000000000000000000000'),
      contractSignatureIndex: asBig(checksRaw.contractSignatureIndex ?? 0),
      signerSignatureIndex: asBig(checksRaw.signerSignatureIndex ?? 0),
      allowedRoot: asHex(
        checksRaw.allowedRoot,
        '0x0000000000000000000000000000000000000000000000000000000000000000'
      ),
      allowedProof: Array.isArray(checksRaw.allowedProof) ? checksRaw.allowedProof : [],
      externalChecks: Array.isArray(checksRaw.externalChecks) ? checksRaw.externalChecks : []
    },
    sent: sent.map(mapAsset),
    received: received.map(mapAsset)
  }
}

export async function checkoutBatchableCart(args: {
  lines: CartLine[]
  beneficiary: Address
  sessionAddress: string
  isGuest: boolean
  note?: Note
}): Promise<Hex[]> {
  const batchable = args.lines.filter((l) => l.source !== 'legacy')
  if (batchable.length === 0) throw new Error('Nothing in this cart can be bought in one transaction')
  const from = asAddr(args.sessionAddress)
  const pk = await resolveKey(args.sessionAddress, args.isGuest)
  const note = args.note ?? (() => undefined)
  const hashes: Hex[] = []

  const withTrade = batchable.filter((l) => l.tradeId)
  const storeOnly = batchable.filter((l) => !l.tradeId && l.source === 'store')

  let manaNeed = 0n
  for (const l of batchable) {
    const qty = BigInt(Math.max(1, l.quantity || 1))
    const unit = l.source === 'store' ? asBig(l.item.price) : asBig(listingPayWei(l.item))
    manaNeed += unit * qty
  }

  if (withTrade.length > 0) {
    await ensureManaAllowance(from, MARKETPLACE_POLYGON, manaNeed, pk, note)
    const trades = []
    for (const line of withTrade) {
      const api = await fetchTrade(line.tradeId!)
      const nested = (api as { trade?: { signature?: string } } | null)?.trade?.signature
      if (!api || (!api.signature && !nested)) {
        throw new Error(`Could not load signed trade for ${line.item.name}`)
      }
      trades.push(tradeArgFromApi(api, args.beneficiary))
    }
    note(`Accept ${trades.length} listing${trades.length === 1 ? '' : 's'}…`)
    const hash = await sendContractMetaTx({
      address: MARKETPLACE_POLYGON,
      abi: marketplaceAbi,
      functionName: 'accept',
      args: [trades],
      from,
      domainOverride: MARKETPLACE_META_TX_DOMAIN,
      calldataField: 'functionData',
      executeStyle: 'signature-bytes',
      privateKey: pk
    })
    await waitReceipt(hash)
    hashes.push(hash)
  }

  if (storeOnly.length > 0) {
    await ensureManaAllowance(from, COLLECTION_STORE, manaNeed, pk, note)
    const itemsToBuy = storeOnly.map((l) => {
      const n = Math.max(1, l.quantity || 1)
      const id = asBig(l.item.itemId)
      const price = asBig(l.item.price)
      return {
        collection: asAddr(l.item.contractAddress),
        ids: Array.from({ length: n }, () => id),
        prices: Array.from({ length: n }, () => price),
        beneficiaries: Array.from({ length: n }, () => args.beneficiary)
      }
    })
    const units = storeOnly.reduce((s, l) => s + Math.max(1, l.quantity || 1), 0)
    note(`Mint ${units} from creator store…`)
    const hash = await sendContractMetaTx({
      address: COLLECTION_STORE,
      abi: collectionStoreAbi as unknown as import('viem').Abi,
      functionName: 'buy',
      args: [itemsToBuy],
      from,
      domainOverride: { name: 'Decentraland Collection Store', version: '1' },
      calldataField: 'functionSignature',
      executeStyle: 'legacy-rsv',
      privateKey: pk
    })
    await waitReceipt(hash)
    hashes.push(hash)
  }

  return hashes
}
