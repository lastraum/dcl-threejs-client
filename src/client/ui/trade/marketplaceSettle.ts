/**
 * On-chain P2P settle via DecentralandMarketplacePolygon (EIP-712 Trade + meta-tx accept).
 * Never switches MetaMask network — approvals + accept go through dcl-meta-tx relay.
 *
 * Flow:
 *  1. Signer (trade inviter) approves their assets, signs Trade, sends payload to peer.
 *  2. Acceptor approves their assets, calls accept([trade]) — atomic swap.
 */

import { parseEther, type Address, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { getGuestPrivateKeyHex } from '../../../auth/guestIdentity'
import { getEthereumProvider } from '../../../auth/ethereumProvider'
import { polygonPublicClient } from '../../../lootBag/polygonClient'
import {
  DCL_COLLECTION_V2_META_TX_DOMAIN,
  ensureWalletAddress,
  sendContractMetaTx,
  waitReceipt
} from '../../../lootBag/metaTx'
import type { TradeItemWire, TradeOfferSnapshot } from '../../../social/tradeWire'
import {
  ASSET_TYPE,
  MARKETPLACE_EIP712_NAME,
  MARKETPLACE_EIP712_VERSION,
  MARKETPLACE_META_TX_DOMAIN,
  MARKETPLACE_POLYGON,
  POLYGON_CHAIN_ID,
  POLYGON_MANA,
  POLYGON_MANA_META_TX_DOMAIN,
  SETTLE_TRADE_TTL_SEC,
  TRADE_TYPED_TYPES,
  ZERO_ADDRESS,
  ZERO_BYTES32,
  chainIdSalt,
  erc20Abi,
  erc721Abi,
  marketplaceAbi
} from './marketplaceConfig'

export type MarketplaceAsset = {
  assetType: bigint
  contractAddress: Address
  value: bigint
  beneficiary: Address
  extra: Hex
}

export type MarketplaceChecks = {
  uses: bigint
  expiration: bigint
  effective: bigint
  salt: Hex
  contractSignatureIndex: bigint
  signerSignatureIndex: bigint
  allowedRoot: Hex
  allowedProof: readonly Hex[]
  externalChecks: readonly {
    contractAddress: Address
    selector: Hex
    value: Hex
    required: boolean
  }[]
}

export type MarketplaceTrade = {
  signer: Address
  signature: Hex
  checks: MarketplaceChecks
  sent: MarketplaceAsset[]
  received: MarketplaceAsset[]
}

/** Serializable payload over PM wire (bigint → string). */
export type SettleSignPayload = {
  marketplace: Address
  chainId: number
  trade: {
    signer: string
    signature: string
    checks: {
      uses: string
      expiration: string
      effective: string
      salt: string
      contractSignatureIndex: string
      signerSignatureIndex: string
      allowedRoot: string
      allowedProof: string[]
      externalChecks: {
        contractAddress: string
        selector: string
        value: string
        required: boolean
      }[]
    }
    sent: {
      assetType: string
      contractAddress: string
      value: string
      beneficiary: string
      extra: string
    }[]
    received: {
      assetType: string
      contractAddress: string
      value: string
      beneficiary: string
      extra: string
    }[]
  }
}

export type SettleProgress = (msg: string) => void

type SettleActor = {
  address: Address
  /** Guest local key — when set, never open MetaMask. */
  privateKey?: Hex
  isGuest: boolean
}

/**
 * Resolve who signs for this client:
 * - Browser guest key matching session address → local auto-sign (never MetaMask)
 * - Wallet session → MetaMask only for that address
 *
 * Guest detection is by **private-key address match**, not only the session flag,
 * so a mis-set isGuest flag cannot open MetaMask for Guest-*.
 */
async function resolveSettleActor(
  sessionAddress: string,
  isGuest?: boolean
): Promise<SettleActor> {
  const want = sessionAddress.trim().toLowerCase() as Address
  if (!/^0x[a-f0-9]{40}$/.test(want)) {
    throw new Error('Invalid session address for settle')
  }

  const pk = getGuestPrivateKeyHex() as Hex | null
  if (pk) {
    try {
      const acc = privateKeyToAccount(pk)
      if (acc.address.toLowerCase() === want) {
        return { address: want, privateKey: pk, isGuest: true }
      }
    } catch {
      /* fall through to wallet path */
    }
  }

  if (isGuest) {
    throw new Error(
      'Guest session has no matching local private key in this browser. Re-login as Guest, or use a wallet account for on-chain trade.'
    )
  }

  // Real wallet — only prompt the session account (never a random MetaMask account).
  const address = await ensureWalletAddress(want, { isGuest: false })
  return { address, isGuest: false }
}

function randomSalt(): Hex {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return (`0x${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`) as Hex
}

/**
 * Collection V2 on-chain token packing (DCL wearables-contracts):
 * tokenId = (itemId << 216) | issuedId
 *
 * Critical: the trailing segment of an **asset** URN is itemId, not the ERC-721
 * token id. Using itemId (e.g. 3) as tokenId → "transfer caller is not owner nor approved".
 * Prefer complete instance URNs / explicit tid (packed uint256). Only pack when
 * the short number is known to be issuedId (instance URN or tid) and itemId is present.
 */
const COLLECTION_V2_ISSUED_BITS = 216n

function encodeCollectionV2TokenId(itemId: bigint, issuedId: bigint): bigint {
  return (itemId << COLLECTION_V2_ISSUED_BITS) | issuedId
}

function isDecimalTokenId(s: string): boolean {
  return /^\d+$/.test(s)
}

/**
 * Resolve the ERC-721 tokenId the marketplace will transfer.
 * Prefer full packed id from instance URN (7 segments) or tid; pack short issuedId + itemId when needed.
 * Never treat a 6-segment asset URN's itemId as a token id.
 */
function nftTokenId(item: TradeItemWire): bigint {
  const parts = item.urn.trim().split(':')
  const isV2 = parts[3] === 'collections-v2'
  const itemIdPart = isV2 && parts[5] != null && isDecimalTokenId(parts[5]) ? parts[5] : null
  // Instance URN: …:collections-v2:contract:itemId:tokenOrIssued
  const instanceTail =
    isV2 && parts.length >= 7 && parts[6] && isDecimalTokenId(parts[6]) ? parts[6] : null
  const tid = (item.tid || '').trim()
  const tidOk = tid && isDecimalTokenId(tid) ? tid : null

  // Prefer the longer of instance-tail vs tid when both look numeric (packed wins over short).
  let candidate: string | null = null
  if (instanceTail && tidOk) {
    candidate = instanceTail.length >= tidOk.length ? instanceTail : tidOk
  } else {
    candidate = instanceTail || tidOk
  }

  if (!candidate) {
    // Asset-only URN (…:itemId) — last segment is NOT a token id.
    if (isV2 && parts.length <= 6) {
      throw new Error(
        `Missing on-chain token id for ${item.name || 'item'} — inventory has an asset URN only. ` +
          `Re-open trade inventory (or re-add the item) so the full ERC-721 token id is loaded.`
      )
    }
    throw new Error(`Missing/invalid token id for ${item.name || item.urn}`)
  }

  const last = BigInt(candidate)

  // Already a full packed token id (long decimal or high bits set).
  if (candidate.length > 18 || last >= 1n << COLLECTION_V2_ISSUED_BITS) {
    return last
  }

  // Short numeric = issuedId / edition #. Pack with itemId from URN when V2.
  if (isV2 && itemIdPart != null) {
    const itemId = BigInt(itemIdPart)
    // itemId 0 → packed equals issuedId (no high bits)
    return encodeCollectionV2TokenId(itemId, last)
  }

  return last
}

function nftContract(item: TradeItemWire): Address {
  const c = (item.c || '').trim().toLowerCase()
  if (/^0x[a-f0-9]{40}$/.test(c)) return c as Address
  const m = /collections-v2:(0x[a-fA-F0-9]{40}):/i.exec(item.urn)
  if (m?.[1]) return m[1].toLowerCase() as Address
  throw new Error(`Cannot resolve collection for ${item.name || item.urn}`)
}

async function assertNftOwner(
  collection: Address,
  tokenId: bigint,
  expectedOwner: Address,
  label: string
): Promise<void> {
  let actualOwner: Address
  try {
    actualOwner = (await polygonPublicClient.readContract({
      address: collection,
      abi: erc721Abi,
      functionName: 'ownerOf',
      args: [tokenId]
    })) as Address
  } catch {
    throw new Error(
      `Token not found on-chain for ${label} (id ${tokenId.toString()}). ` +
        `Wrong token id (issue # / itemId used instead of packed ERC-721 id?). Re-add from inventory.`
    )
  }
  if (actualOwner.toLowerCase() !== expectedOwner.toLowerCase()) {
    throw new Error(
      `${label} is not owned by ${expectedOwner.slice(0, 10)}… ` +
        `(on-chain owner ${actualOwner.slice(0, 10)}…, tokenId ${tokenId.toString()}). ` +
        `Re-add the item from inventory and try again.`
    )
  }
}

/** True if marketplace can transfer this token (operator-all or per-token approve). */
async function isMarketplaceApprovedForNft(
  collection: Address,
  tokenId: bigint,
  owner: Address,
  marketplace: Address
): Promise<boolean> {
  const forAll = (await polygonPublicClient.readContract({
    address: collection,
    abi: erc721Abi,
    functionName: 'isApprovedForAll',
    args: [owner, marketplace]
  })) as boolean
  if (forAll) return true
  try {
    const single = (await polygonPublicClient.readContract({
      address: collection,
      abi: erc721Abi,
      functionName: 'getApproved',
      args: [tokenId]
    })) as Address
    return single.toLowerCase() === marketplace.toLowerCase()
  } catch {
    return false
  }
}

async function assertNftOwnerAndApproval(
  collection: Address,
  tokenId: bigint,
  expectedOwner: Address,
  marketplace: Address,
  label: string
): Promise<void> {
  await assertNftOwner(collection, tokenId, expectedOwner, label)
  const approved = await isMarketplaceApprovedForNft(
    collection,
    tokenId,
    expectedOwner,
    marketplace
  )
  if (!approved) {
    throw new Error(
      `Marketplace is not approved to move ${label} ` +
        `(owner ${expectedOwner.slice(0, 10)}…, collection ${collection.slice(0, 10)}…). ` +
        `setApprovalForAll / getApproved missing — retry settle so approvals re-run.`
    )
  }
}

async function assertManaAllowance(
  owner: Address,
  marketplace: Address,
  amount: bigint,
  label: string
): Promise<void> {
  if (amount <= 0n) return
  const allowance = (await polygonPublicClient.readContract({
    address: POLYGON_MANA,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [owner, marketplace]
  })) as bigint
  if (allowance < amount) {
    throw new Error(
      `${label}: MANA allowance too low ` +
        `(need ${amount.toString()}, have ${allowance.toString()}). Retry settle to re-approve.`
    )
  }
}

/** Verify offer items still owned by `owner` and marketplace is approved. */
async function assertOfferReadyToTransfer(
  owner: Address,
  offer: TradeOfferSnapshot,
  marketplace: Address,
  opts?: { requireApproval?: boolean }
): Promise<void> {
  const requireApproval = opts?.requireApproval !== false
  for (const item of offer.items) {
    const collection = nftContract(item)
    const tokenId = nftTokenId(item)
    const label = item.name || 'NFT'
    if (requireApproval) {
      await assertNftOwnerAndApproval(collection, tokenId, owner, marketplace, label)
    } else {
      await assertNftOwner(collection, tokenId, owner, label)
    }
  }
  if (requireApproval && offer.mana > 0) {
    await assertManaAllowance(
      owner,
      marketplace,
      parseEther(String(Math.floor(offer.mana))),
      'Your MANA'
    )
  }
}

/**
 * Verify the **signed** trade payload (exact token ids + approvals that accept() needs).
 * Catches wrong id / missing approval before estimateGas / meta-tx.
 */
async function assertSignedTradeTransferable(
  trade: MarketplaceTrade,
  acceptor: Address,
  marketplace: Address
): Promise<void> {
  for (const a of trade.sent) {
    if (a.assetType === ASSET_TYPE.ERC721) {
      await assertNftOwnerAndApproval(
        a.contractAddress,
        a.value,
        trade.signer,
        marketplace,
        `signer NFT #${a.value.toString().slice(0, 12)}`
      )
    } else if (a.assetType === ASSET_TYPE.ERC20) {
      await assertManaAllowance(trade.signer, marketplace, a.value, "Signer's MANA")
    }
  }
  for (const a of trade.received) {
    if (a.assetType === ASSET_TYPE.ERC721) {
      await assertNftOwnerAndApproval(
        a.contractAddress,
        a.value,
        acceptor,
        marketplace,
        `your NFT #${a.value.toString().slice(0, 12)}`
      )
    } else if (a.assetType === ASSET_TYPE.ERC20) {
      await assertManaAllowance(acceptor, marketplace, a.value, 'Your MANA')
    }
  }
}

/**
 * Convert one side's offer into marketplace assets (NFTs + optional MANA).
 * @param beneficiary Wallet that should receive these assets on settle.
 *   Always set explicitly (never leave 0x0) so a wrong peer identity is visible
 *   in the signed payload and on Polygonscan — not resolved implicitly.
 */
export function offerToAssets(
  offer: TradeOfferSnapshot,
  beneficiary: Address = ZERO_ADDRESS
): MarketplaceAsset[] {
  const assets: MarketplaceAsset[] = []
  const to = (beneficiary || ZERO_ADDRESS).toLowerCase() as Address
  for (const item of offer.items) {
    const urn = item.urn.toLowerCase()
    if (urn.includes(':ethereum:') || urn.includes('collections-v1')) {
      throw new Error(
        `L1 / Ethereum assets are not supported yet (${item.name || 'item'}). Use Polygon wearables.`
      )
    }
    if (urn.includes('off-chain:') || urn.includes('base-avatars')) {
      throw new Error(`Off-chain base wearables cannot be traded (${item.name || 'item'})`)
    }
    assets.push({
      assetType: ASSET_TYPE.ERC721,
      contractAddress: nftContract(item),
      value: nftTokenId(item),
      beneficiary: to,
      extra: '0x'
    })
  }
  if (offer.mana > 0) {
    assets.push({
      assetType: ASSET_TYPE.ERC20,
      contractAddress: POLYGON_MANA,
      value: parseEther(String(Math.floor(offer.mana))),
      beneficiary: to,
      extra: '0x'
    })
  }
  return assets
}

async function readIsApprovedForAll(
  collection: Address,
  owner: Address,
  operator: Address
): Promise<boolean> {
  return (await polygonPublicClient.readContract({
    address: collection,
    abi: erc721Abi,
    functionName: 'isApprovedForAll',
    args: [owner, operator]
  })) as boolean
}

async function ensureNftApproval(
  actor: SettleActor,
  collection: Address,
  operator: Address,
  note: SettleProgress
): Promise<void> {
  if (await readIsApprovedForAll(collection, actor.address, operator)) {
    note(`NFT approval OK · ${collection.slice(0, 10)}…`)
    return
  }
  note(
    actor.isGuest
      ? `Guest auto-approve NFT ${collection.slice(0, 10)}… (meta-tx)`
      : `Approve NFT collection ${collection.slice(0, 10)}… (meta-tx)`
  )
  const hash = await sendContractMetaTx({
    address: collection,
    abi: erc721Abi,
    functionName: 'setApprovalForAll',
    args: [operator, true],
    from: actor.address,
    domainOverride: DCL_COLLECTION_V2_META_TX_DOMAIN,
    calldataField: 'functionSignature',
    executeStyle: 'legacy-rsv',
    privateKey: actor.privateKey
  })
  note(`Waiting for NFT approval ${hash.slice(0, 12)}…`)
  await waitReceipt(hash)
  // Re-read — receipt success does not always mean the approval landed (wrong operator/domain).
  if (!(await readIsApprovedForAll(collection, actor.address, operator))) {
    throw new Error(
      `NFT approval did not stick for ${collection.slice(0, 10)}… ` +
        `(isApprovedForAll still false after meta-tx ${hash.slice(0, 12)}). ` +
        `Check the collection supports meta-tx setApprovalForAll.`
    )
  }
  note(`NFT approval confirmed · ${collection.slice(0, 10)}…`)
}

async function ensureManaApproval(
  actor: SettleActor,
  spender: Address,
  amount: bigint,
  note: SettleProgress
): Promise<void> {
  if (amount <= 0n) return
  const allowance = (await polygonPublicClient.readContract({
    address: POLYGON_MANA,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [actor.address, spender]
  })) as bigint
  if (allowance >= amount) {
    note('MANA allowance OK')
    return
  }
  note(actor.isGuest ? 'Guest auto-approve MANA (meta-tx)' : 'Approve MANA for marketplace (meta-tx)')
  const max = 2n ** 256n - 1n
  const hash = await sendContractMetaTx({
    address: POLYGON_MANA,
    abi: erc20Abi,
    functionName: 'approve',
    args: [spender, max],
    from: actor.address,
    domainOverride: POLYGON_MANA_META_TX_DOMAIN,
    calldataField: 'functionSignature',
    executeStyle: 'legacy-rsv',
    privateKey: actor.privateKey
  })
  note(`Waiting for MANA approval ${hash.slice(0, 12)}…`)
  await waitReceipt(hash)
  const after = (await polygonPublicClient.readContract({
    address: POLYGON_MANA,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [actor.address, spender]
  })) as bigint
  if (after < amount) {
    throw new Error(
      `MANA approval did not stick (allowance ${after.toString()} < ${amount.toString()} ` +
        `after meta-tx ${hash.slice(0, 12)}). Retry settle.`
    )
  }
  note('MANA allowance confirmed')
}

/** Approvals for assets this account will transfer into the trade. */
export async function ensureApprovalsForOffer(
  actor: SettleActor,
  offer: TradeOfferSnapshot,
  note: SettleProgress
): Promise<void> {
  await ensureApprovalsForAssets(actor, offerToAssets(offer), note)
}

/**
 * Approve marketplace for the exact assets that will move (collections + MANA).
 * Prefer this over the local offer snapshot when a signed payload exists.
 */
async function ensureApprovalsForAssets(
  actor: SettleActor,
  assets: MarketplaceAsset[],
  note: SettleProgress
): Promise<void> {
  const marketplace = MARKETPLACE_POLYGON
  const collections = new Set<string>()
  let manaAmount = 0n
  for (const a of assets) {
    if (a.assetType === ASSET_TYPE.ERC721) {
      collections.add(a.contractAddress.toLowerCase())
    } else if (a.assetType === ASSET_TYPE.ERC20 && a.contractAddress.toLowerCase() === POLYGON_MANA.toLowerCase()) {
      manaAmount += a.value
    }
  }
  if (collections.size === 0 && manaAmount <= 0n) {
    note('No assets to approve on your side')
    return
  }
  for (const c of collections) {
    await ensureNftApproval(actor, c as Address, marketplace, note)
  }
  if (manaAmount > 0n) {
    await ensureManaApproval(actor, marketplace, manaAmount, note)
  }
}

function tradeToTypedMessage(trade: {
  checks: MarketplaceChecks
  sent: MarketplaceAsset[]
  received: MarketplaceAsset[]
}) {
  return {
    checks: {
      uses: trade.checks.uses.toString(),
      expiration: trade.checks.expiration.toString(),
      effective: trade.checks.effective.toString(),
      salt: trade.checks.salt,
      contractSignatureIndex: trade.checks.contractSignatureIndex.toString(),
      signerSignatureIndex: trade.checks.signerSignatureIndex.toString(),
      allowedRoot: trade.checks.allowedRoot,
      externalChecks: trade.checks.externalChecks.map((e) => ({
        contractAddress: e.contractAddress,
        selector: e.selector,
        value: e.value,
        required: e.required
      }))
    },
    sent: trade.sent.map((a) => ({
      assetType: a.assetType.toString(),
      contractAddress: a.contractAddress,
      value: a.value.toString(),
      extra: a.extra
    })),
    received: trade.received.map((a) => ({
      assetType: a.assetType.toString(),
      contractAddress: a.contractAddress,
      value: a.value.toString(),
      extra: a.extra,
      beneficiary: a.beneficiary
    }))
  }
}

export function serializeSettlePayload(trade: MarketplaceTrade): SettleSignPayload {
  return {
    marketplace: MARKETPLACE_POLYGON,
    chainId: POLYGON_CHAIN_ID,
    trade: {
      signer: trade.signer,
      signature: trade.signature,
      checks: {
        uses: trade.checks.uses.toString(),
        expiration: trade.checks.expiration.toString(),
        effective: trade.checks.effective.toString(),
        salt: trade.checks.salt,
        contractSignatureIndex: trade.checks.contractSignatureIndex.toString(),
        signerSignatureIndex: trade.checks.signerSignatureIndex.toString(),
        allowedRoot: trade.checks.allowedRoot,
        allowedProof: [...trade.checks.allowedProof],
        externalChecks: trade.checks.externalChecks.map((e) => ({
          contractAddress: e.contractAddress,
          selector: e.selector,
          value: e.value,
          required: e.required
        }))
      },
      sent: trade.sent.map((a) => ({
        assetType: a.assetType.toString(),
        contractAddress: a.contractAddress,
        value: a.value.toString(),
        beneficiary: a.beneficiary,
        extra: a.extra
      })),
      received: trade.received.map((a) => ({
        assetType: a.assetType.toString(),
        contractAddress: a.contractAddress,
        value: a.value.toString(),
        beneficiary: a.beneficiary,
        extra: a.extra
      }))
    }
  }
}

export function deserializeSettlePayload(raw: SettleSignPayload): MarketplaceTrade {
  const t = raw.trade
  return {
    signer: t.signer.toLowerCase() as Address,
    signature: t.signature as Hex,
    checks: {
      uses: BigInt(t.checks.uses),
      expiration: BigInt(t.checks.expiration),
      effective: BigInt(t.checks.effective),
      salt: t.checks.salt as Hex,
      contractSignatureIndex: BigInt(t.checks.contractSignatureIndex),
      signerSignatureIndex: BigInt(t.checks.signerSignatureIndex),
      allowedRoot: t.checks.allowedRoot as Hex,
      allowedProof: (t.checks.allowedProof || []) as Hex[],
      externalChecks: (t.checks.externalChecks || []).map((e) => ({
        contractAddress: e.contractAddress as Address,
        selector: e.selector as Hex,
        value: e.value as Hex,
        required: !!e.required
      }))
    },
    sent: t.sent.map((a) => ({
      assetType: BigInt(a.assetType),
      contractAddress: a.contractAddress as Address,
      value: BigInt(a.value),
      beneficiary: (a.beneficiary || ZERO_ADDRESS) as Address,
      extra: (a.extra || '0x') as Hex
    })),
    received: t.received.map((a) => ({
      assetType: BigInt(a.assetType),
      contractAddress: a.contractAddress as Address,
      value: BigInt(a.value),
      beneficiary: (a.beneficiary || ZERO_ADDRESS) as Address,
      extra: (a.extra || '0x') as Hex
    }))
  }
}

/**
 * Phase 1 — before any trade signature / accept:
 *  1. Ownership of your offer items
 *  2. Read marketplace approvals (NFT + MANA)
 *  3. Meta-tx setApprovalForAll / approve if missing
 *  4. Re-verify ownership + approvals
 *
 * Call this as soon as both sides accept so wallets approve first while the
 * inviter is still preparing the EIP-712 trade.
 */
export async function prepareLocalApprovals(args: {
  sessionAddress: string
  isGuest?: boolean
  offer: TradeOfferSnapshot
  note?: SettleProgress
}): Promise<void> {
  const note = args.note ?? (() => undefined)
  if (args.offer.items.length === 0 && args.offer.mana <= 0) {
    note('No assets on your side — approvals skipped')
    return
  }

  note(
    args.isGuest
      ? 'Approvals first (guest auto meta-tx)…'
      : 'Approvals first (MetaMask only for this session)…'
  )
  const actor = await resolveSettleActor(args.sessionAddress, args.isGuest)

  note('1/3 Verifying you still own each item…')
  await assertOfferReadyToTransfer(actor.address, args.offer, MARKETPLACE_POLYGON, {
    requireApproval: false
  })

  note('2/3 Checking marketplace approvals (NFT + MANA)…')
  await ensureApprovalsForOffer(actor, args.offer, note)

  note('3/3 Re-checking ownership + approvals…')
  await assertOfferReadyToTransfer(actor.address, args.offer, MARKETPLACE_POLYGON, {
    requireApproval: true
  })
  note('Approvals ready — trade can proceed')
}

/**
 * Signer path: **approvals first**, then EIP-712 sign Trade (sent=mine, received=theirs).
 * Never signs the trade until your marketplace approvals are confirmed on-chain.
 */
export async function signTradeForSettlement(args: {
  sessionAddress: string
  isGuest?: boolean
  /** Signer's offer (assets leaving signer). */
  signerOffer: TradeOfferSnapshot
  /** Acceptor's offer (assets leaving acceptor → signer). */
  acceptorOffer: TradeOfferSnapshot
  /** Peer (acceptor) address — used to preflight their NFTs before you sign. */
  acceptorAddress?: string
  note?: SettleProgress
}): Promise<SettleSignPayload> {
  const note = args.note ?? (() => undefined)
  if (
    args.signerOffer.items.length === 0 &&
    args.signerOffer.mana <= 0 &&
    args.acceptorOffer.items.length === 0 &&
    args.acceptorOffer.mana <= 0
  ) {
    throw new Error('Nothing to trade — both offers are empty')
  }

  // ── Phase 1: approvals BEFORE building / signing the trade ──────────────
  await prepareLocalApprovals({
    sessionAddress: args.sessionAddress,
    isGuest: args.isGuest,
    offer: args.signerOffer,
    note
  })

  const actor = await resolveSettleActor(args.sessionAddress, args.isGuest)

  // Peer ownership only (they approve on their side before/during accept).
  const acceptorAddr = (args.acceptorAddress || '').trim().toLowerCase()
  if (acceptorAddr && /^0x[a-f0-9]{40}$/.test(acceptorAddr) && args.acceptorOffer.items.length > 0) {
    note('Verifying peer still owns their offered NFTs…')
    await assertOfferReadyToTransfer(
      acceptorAddr as Address,
      args.acceptorOffer,
      MARKETPLACE_POLYGON,
      { requireApproval: false }
    )
  }

  // ── Phase 2: build + EIP-712 sign (only after approvals OK) ─────────────
  if (!acceptorAddr || !/^0x[a-f0-9]{40}$/.test(acceptorAddr)) {
    throw new Error(
      'Missing counterparty wallet for settle — cannot sign trade without acceptor address'
    )
  }
  if (acceptorAddr === actor.address.toLowerCase()) {
    throw new Error('Counterparty address equals your wallet — aborting settle')
  }

  note('Approvals confirmed — building trade for signature…')
  const [contractSigIdx, signerSigIdx] = await Promise.all([
    polygonPublicClient.readContract({
      address: MARKETPLACE_POLYGON,
      abi: marketplaceAbi,
      functionName: 'contractSignatureIndex'
    }) as Promise<bigint>,
    polygonPublicClient.readContract({
      address: MARKETPLACE_POLYGON,
      abi: marketplaceAbi,
      functionName: 'signerSignatureIndex',
      args: [actor.address]
    }) as Promise<bigint>
  ])

  const now = Math.floor(Date.now() / 1000)
  const checks: MarketplaceChecks = {
    uses: 1n,
    expiration: BigInt(now + SETTLE_TRADE_TTL_SEC),
    effective: 0n,
    salt: randomSalt(),
    contractSignatureIndex: contractSigIdx,
    signerSignatureIndex: signerSigIdx,
    allowedRoot: ZERO_BYTES32,
    allowedProof: [],
    externalChecks: []
  }

  // Explicit beneficiaries: your items → acceptor wallet; their items → you.
  const sent = offerToAssets(args.signerOffer, acceptorAddr as Address)
  const received = offerToAssets(args.acceptorOffer, actor.address)
  note(
    `Trade assets · you→${acceptorAddr.slice(0, 10)}… (${sent.length}) · peer→you (${received.length})` +
      (sent[0]?.assetType === ASSET_TYPE.ERC721
        ? ` · your token ${sent[0].value.toString().slice(0, 16)}…`
        : '') +
      (received[0]?.assetType === ASSET_TYPE.ERC721
        ? ` · peer token ${received[0].value.toString().slice(0, 16)}…`
        : '')
  )

  const typedMessage = tradeToTypedMessage({ checks, sent, received })
  const domain = {
    name: MARKETPLACE_EIP712_NAME,
    version: MARKETPLACE_EIP712_VERSION,
    verifyingContract: MARKETPLACE_POLYGON,
    salt: chainIdSalt(POLYGON_CHAIN_ID)
  }

  const typedPayload = {
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'verifyingContract', type: 'address' },
        { name: 'salt', type: 'bytes32' }
      ],
      ...TRADE_TYPED_TYPES
    },
    domain,
    primaryType: 'Trade' as const,
    message: typedMessage
  }

  let signature: Hex
  if (actor.privateKey) {
    note('Guest auto-signing trade (local key)…')
    const account = privateKeyToAccount(actor.privateKey)
    const types = { ...TRADE_TYPED_TYPES } as Record<
      string,
      readonly { name: string; type: string }[]
    >
    signature = (await account.signTypedData({
      domain: {
        name: domain.name,
        version: domain.version,
        verifyingContract: domain.verifyingContract,
        salt: domain.salt
      },
      types,
      primaryType: 'Trade',
      message: typedMessage as Record<string, unknown>
    })) as Hex
  } else {
    const provider = getEthereumProvider()
    if (!provider?.request) throw new Error('No wallet found — connect MetaMask')
    note('Sign the trade in MetaMask…')
    signature = (await provider.request({
      method: 'eth_signTypedData_v4',
      params: [actor.address, JSON.stringify(typedPayload)]
    })) as Hex
  }

  const trade: MarketplaceTrade = {
    signer: actor.address,
    signature,
    checks,
    sent,
    received
  }

  note('Trade signed — sending to peer for on-chain accept…')
  return serializeSettlePayload(trade)
}

/**
 * Acceptor path: **approvals first** for your assets, then marketplace.accept.
 */
export async function acceptTradeOnChain(args: {
  sessionAddress: string
  isGuest?: boolean
  payload: SettleSignPayload
  /** Acceptor's local offer — used for early approval prep / logging. */
  acceptorOffer: TradeOfferSnapshot
  note?: SettleProgress
}): Promise<Hex> {
  const note = args.note ?? (() => undefined)
  if (args.payload.chainId !== POLYGON_CHAIN_ID) {
    throw new Error(`Unsupported chain ${args.payload.chainId} — expected Polygon ${POLYGON_CHAIN_ID}`)
  }
  if (args.payload.marketplace.toLowerCase() !== MARKETPLACE_POLYGON.toLowerCase()) {
    throw new Error('Unexpected marketplace contract address')
  }

  const trade = deserializeSettlePayload(args.payload)

  // ── Phase 1: approvals BEFORE accept meta-tx ────────────────────────────
  // Prefer signed `received` assets (exact ids accept() will move).
  note(
    args.isGuest
      ? 'Approvals first (guest), then accept…'
      : 'Approvals first (wallet), then accept…'
  )
  const actor = await resolveSettleActor(args.sessionAddress, args.isGuest)
  if (trade.signer.toLowerCase() === actor.address.toLowerCase()) {
    throw new Error('Signer cannot also accept — wait for the other party')
  }

  if (trade.received.length > 0) {
    note('1/3 Verifying you own the NFTs in the signed trade…')
    for (const a of trade.received) {
      if (a.assetType !== ASSET_TYPE.ERC721) continue
      await assertNftOwner(
        a.contractAddress,
        a.value,
        actor.address,
        `your NFT #${a.value.toString().slice(0, 12)}`
      )
    }
    note('2/3 Checking / requesting marketplace approvals…')
    await ensureApprovalsForAssets(actor, trade.received, note)
    note('3/3 Re-checking ownership + approvals on signed trade…')
  } else {
    note('No assets on your side of the signed trade')
  }

  // Signer side must already be approved (they ran prepare before signing).
  note('Verifying both sides ready (ownership + approvals)…')
  await assertSignedTradeTransferable(trade, actor.address, MARKETPLACE_POLYGON)
  note('Approvals confirmed — submitting accept…')

  note(
    actor.isGuest
      ? 'Guest auto-signing accept meta-tx…'
      : 'Sign meta-tx to accept trade (relay pays gas)…'
  )
  const hash = await sendContractMetaTx({
    address: MARKETPLACE_POLYGON,
    abi: marketplaceAbi,
    functionName: 'accept',
    args: [
      [
        {
          signer: trade.signer,
          signature: trade.signature,
          checks: {
            uses: trade.checks.uses,
            expiration: trade.checks.expiration,
            effective: trade.checks.effective,
            salt: trade.checks.salt,
            contractSignatureIndex: trade.checks.contractSignatureIndex,
            signerSignatureIndex: trade.checks.signerSignatureIndex,
            allowedRoot: trade.checks.allowedRoot,
            allowedProof: trade.checks.allowedProof,
            externalChecks: trade.checks.externalChecks
          },
          sent: trade.sent,
          received: trade.received
        }
      ]
    ],
    from: actor.address,
    domainOverride: MARKETPLACE_META_TX_DOMAIN,
    // Marketplace: EIP-712 field `functionData` + executeMetaTransaction(user, data, signature).
    calldataField: 'functionData',
    executeStyle: 'signature-bytes',
    privateKey: actor.privateKey
  })
  note(`Waiting for relay confirmation ${hash.slice(0, 12)}…`)
  await waitReceipt(hash)
  note('On-chain trade settled')
  return hash
}
