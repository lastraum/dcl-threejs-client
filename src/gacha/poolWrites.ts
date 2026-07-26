import { maxUint256, parseEther, type Abi, type Address, type Hex } from 'viem'
import { ADDRESSES, MAX_STOCK_PER_TX, USE_TEST_FULFILL } from './config'
import {
  ensureWalletAddress,
  getManaAllowance,
  getNftApproved,
  isNftApprovedForAll,
  sendContractMetaTx,
  waitReceipt,
  DCL_COLLECTION_V2_META_TX_DOMAIN,
  type MetaTxDomain,
  gachaPoolAbi,
  mockManaAbi,
  mockWearableAbi
} from './metaTx'
import {
  collectionV2MinterAbi,
  getCollectionMinterStatus,
  humanizeStockError
} from './collectionMinter'
import { findPendingWinForPurchaser } from './poolReads'
import type { PendingWin } from './types'

const MANA_MAX_APPROVAL = maxUint256
const HIGH_ALLOWANCE = parseEther('1000000000')

export type FlowApi = {
  note: (label: string) => void
  pushStep: (label: string) => string
  finishStep: (id: string, patch?: { hash?: Hex; detail?: string; error?: boolean }) => void
}

async function sendAndWait(
  api: FlowApi,
  args: {
    address: Address
    abi: Abi
    functionName: string
    args?: readonly unknown[]
    from: Address
    label: string
    domainOverride?: MetaTxDomain
  }
): Promise<Hex> {
  const stepId = api.pushStep(args.label)
  try {
    const hash = await sendContractMetaTx({
      address: args.address,
      abi: args.abi,
      functionName: args.functionName,
      args: args.args,
      from: args.from,
      domainOverride: args.domainOverride
    })
    api.finishStep(stepId, { hash, detail: 'Waiting for network…' })
    api.note('Waiting for network confirmation…')
    await waitReceipt(hash)
    api.finishStep(stepId, { hash, detail: 'Done' })
    return hash
  } catch (e) {
    const msg = humanizeStockError(e)
    api.finishStep(stepId, { detail: msg, error: true })
    throw new Error(msg)
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms))
}

export async function runDepositNft(args: {
  sessionAddress?: string | null
  tokenId: bigint
  backingMana: string
  api: FlowApi
}): Promise<Hex> {
  const from = await ensureWalletAddress(args.sessionAddress)
  const pool = ADDRESSES.gachaPool
  const amount = parseEther(args.backingMana || '0')
  if (amount <= 0n) throw new Error('Backing must be greater than 0')

  args.api.note('Checking NFT + mMANA approvals…')
  const [allowance, approved, approvedAll] = await Promise.all([
    getManaAllowance(from, pool),
    getNftApproved(args.tokenId).catch(() => '0x0' as Address),
    isNftApprovedForAll(from, pool)
  ])

  const needNft = !approvedAll && approved.toLowerCase() !== pool.toLowerCase()
  const needMana = allowance < HIGH_ALLOWANCE

  if (needNft) {
    await sendAndWait(args.api, {
      address: ADDRESSES.mockWearable,
      abi: mockWearableAbi,
      functionName: 'setApprovalForAll',
      args: [pool, true],
      from,
      label: 'NFT setApprovalForAll → grab bag'
    })
  } else {
    args.api.note('NFT already approved — skip')
  }

  if (needMana) {
    await sendAndWait(args.api, {
      address: ADDRESSES.mockMana,
      abi: mockManaAbi,
      functionName: 'approve',
      args: [pool, MANA_MAX_APPROVAL],
      from,
      label: 'mMANA approve (unlimited)'
    })
  } else {
    args.api.note('mMANA allowance high — skip')
  }

  args.api.note('Waiting for approvals to settle…')
  for (let i = 0; i < 15; i++) {
    const [a, appr, all] = await Promise.all([
      getManaAllowance(from, pool),
      getNftApproved(args.tokenId).catch(() => '0x0' as Address),
      isNftApprovedForAll(from, pool)
    ])
    const nftOk = all || appr.toLowerCase() === pool.toLowerCase()
    const manaOk = a >= amount
    if (nftOk && manaOk) break
    if (i === 14) {
      throw new Error(
        `Approvals not visible on-chain yet (nftOk=${nftOk} manaOk=${manaOk}). Wait and retry.`
      )
    }
    await sleep(1500)
  }

  return sendAndWait(args.api, {
    address: pool,
    abi: gachaPoolAbi,
    functionName: 'depositNFT',
    args: [ADDRESSES.mockWearable, args.tokenId, amount],
    from,
    label: 'depositNFT'
  })
}

/**
 * Deposit a MANA pack: locks pack prize + backing into the pool.
 * Winner keep → prize; take → backing bid path (same FWA mechanic as scene/admin).
 */
export async function runDepositManaPack(args: {
  sessionAddress?: string | null
  packPrizeMana: string
  backingMana: string
  api: FlowApi
}): Promise<Hex> {
  const from = await ensureWalletAddress(args.sessionAddress)
  const pool = ADDRESSES.gachaPool
  const prize = parseEther(args.packPrizeMana || '0')
  const back = parseEther(args.backingMana || '0')
  if (prize <= 0n) throw new Error('Pack prize must be greater than 0')
  if (back <= 0n) throw new Error('Pack backing must be greater than 0')
  const total = prize + back

  args.api.note('Checking mMANA allowance for pack deposit…')
  const allowance = await getManaAllowance(from, pool)
  if (allowance < total || allowance < HIGH_ALLOWANCE) {
    await sendAndWait(args.api, {
      address: ADDRESSES.mockMana,
      abi: mockManaAbi,
      functionName: 'approve',
      args: [pool, MANA_MAX_APPROVAL],
      from,
      label: 'mMANA approve (unlimited)'
    })
  } else {
    args.api.note('mMANA allowance high — skip')
  }

  args.api.note('Waiting for allowance…')
  for (let i = 0; i < 15; i++) {
    const a = await getManaAllowance(from, pool)
    if (a >= total) break
    if (i === 14) {
      throw new Error('mMANA allowance not visible on-chain yet. Wait and retry.')
    }
    await sleep(1500)
  }

  return sendAndWait(args.api, {
    address: pool,
    abi: gachaPoolAbi,
    functionName: 'depositManaPack',
    args: [prize, back],
    from,
    label: 'depositManaPack'
  })
}

/**
 * Creator stock: mint Collection V2 items into the pool and open active slots.
 *
 * Meta-tx sign chain (each after receipt may use `waitForContinue` for user-gesture):
 *  1) setMinters([pool], true) on collection — if pool cannot mint yet (creator only)
 *  2) mMANA approve — if allowance low
 *  3) stockFromCollection ×N (chunked if needed)
 */
export async function runStockFromCollection(args: {
  sessionAddress?: string | null
  collection: string
  itemId: number | bigint
  mintCount: number
  avgBackingMana: string
  api: FlowApi
  /** After any async step, prompt a click before the next eth_signTypedData */
  waitForContinue?: (info: {
    needsApprove: boolean
    mintCount: number
    label: string
  }) => Promise<void>
}): Promise<Hex[]> {
  const from = await ensureWalletAddress(args.sessionAddress)
  const pool = ADDRESSES.gachaPool
  const collection = args.collection.trim().toLowerCase() as Address
  if (!/^0x[a-f0-9]{40}$/.test(collection)) {
    throw new Error('Invalid collection address')
  }
  const itemId = BigInt(args.itemId)
  if (itemId < 0n) throw new Error('Invalid item id')
  const mintCount = Math.floor(Number(args.mintCount))
  if (!Number.isFinite(mintCount) || mintCount < 1) {
    throw new Error('Mint count must be at least 1')
  }
  const avgBacking = parseEther(args.avgBackingMana || '0')
  if (avgBacking <= 0n) throw new Error('Avg backing must be greater than 0')

  const totalBacking = avgBacking * BigInt(mintCount)
  args.api.note(`Preparing to stock ${mintCount} items…`)

  let minter = await getCollectionMinterStatus(collection, {
    itemId,
    account: from
  })
  if (!minter.mintingAllowed) {
    throw new Error(humanizeStockError(new Error('MINT_NOT_ALLOWED')))
  }

  let stepNo = 0
  const nextStep = (label: string) => {
    stepNo += 1
    return label
  }

  // ── 1) Authorize minting (setMinters) if needed ──────────────────────────
  if (!minter.canMintItem) {
    if (minter.creator && minter.creator !== from.toLowerCase()) {
      throw new Error(
        `Grab bag cannot mint and you are not the collection creator (${minter.creator.slice(0, 10)}…). ` +
          'Ask the creator to authorize the grab bag as minter.'
      )
    }
    args.api.note('Confirm in wallet: allow the grab bag to mint from your collection')
    await sendAndWait(args.api, {
      address: collection,
      abi: collectionV2MinterAbi as unknown as Abi,
      functionName: 'setMinters',
      args: [[pool], [true]],
      from,
      label: nextStep('Allow grab bag to mint from collection'),
      domainOverride: DCL_COLLECTION_V2_META_TX_DOMAIN
    })

    for (let i = 0; i < 16; i++) {
      minter = await getCollectionMinterStatus(collection, { itemId, account: from })
      if (minter.canMintItem) break
      if (i === 15) {
        throw new Error(
          'Mint permission confirmed but not visible yet — wait a few seconds and retry'
        )
      }
      await sleep(1500)
    }

    if (args.waitForContinue) {
      await args.waitForContinue({
        needsApprove: true,
        mintCount,
        label: 'Mint permission saved. Continue to the next step.'
      })
    }
  }

  if (
    !minter.isGlobalMinter &&
    minter.itemAllowance > 0n &&
    minter.itemAllowance < BigInt(mintCount) &&
    minter.itemAllowance !== maxUint256
  ) {
    throw new Error(
      `Mint allowance is only ${minter.itemAllowance.toString()} — lower the count or raise the allowance.`
    )
  }

  // ── 2) mMANA approve ─────────────────────────────────────────────────────
  const allowance = await getManaAllowance(from, pool)
  if (allowance < totalBacking) {
    args.api.note('Confirm in wallet: allow the grab bag to use your mMANA')
    await sendAndWait(args.api, {
      address: ADDRESSES.mockMana,
      abi: mockManaAbi,
      functionName: 'approve',
      args: [pool, MANA_MAX_APPROVAL],
      from,
      label: nextStep('Allow grab bag to use mMANA')
    })

    for (let i = 0; i < 20; i++) {
      const a = await getManaAllowance(from, pool)
      if (a >= totalBacking) break
      if (i === 19) {
        throw new Error('mMANA allowance not visible on-chain yet. Wait a few seconds and retry.')
      }
      await sleep(1500)
    }

    if (args.waitForContinue) {
      await args.waitForContinue({
        needsApprove: true,
        mintCount,
        label: `mMANA ready. Continue to mint ${mintCount} into the grab bag.`
      })
    }
  } else if (args.waitForContinue && stepNo > 0) {
    await args.waitForContinue({
      needsApprove: false,
      mintCount,
      label: `Continue to mint ${mintCount} into the grab bag.`
    })
  }

  // ── 3) Mint into grab bag ────────────────────────────────────────────────
  const hashes: Hex[] = []
  let remaining = mintCount
  let chunkIdx = 0
  const totalChunks = Math.ceil(mintCount / MAX_STOCK_PER_TX)
  while (remaining > 0) {
    const n = Math.min(remaining, MAX_STOCK_PER_TX)
    chunkIdx += 1
    const stepLabel =
      totalChunks > 1
        ? nextStep(`Mint ${n} into grab bag (${chunkIdx}/${totalChunks})`)
        : nextStep(`Mint ${n} into grab bag`)
    args.api.note(
      totalChunks > 1
        ? `Confirm in wallet: mint batch ${chunkIdx} of ${totalChunks}`
        : `Confirm in wallet: mint ${n} into the grab bag`
    )
    const hash = await sendAndWait(args.api, {
      address: pool,
      abi: gachaPoolAbi,
      functionName: 'stockFromCollection',
      args: [collection, itemId, BigInt(n), avgBacking],
      from,
      label: stepLabel
    })
    hashes.push(hash)
    remaining -= n

    if (remaining > 0 && args.waitForContinue) {
      await args.waitForContinue({
        needsApprove: false,
        mintCount: remaining,
        label: `Batch ${chunkIdx} done. Continue for the next ${remaining}.`
      })
    }
  }

  args.api.note(`Done — ${mintCount} items in the grab bag`)
  return hashes
}

export async function runPull(args: {
  sessionAddress?: string | null
  acquisitionFee: bigint
  api: FlowApi
}): Promise<{ hash: Hex; win: PendingWin | null }> {
  const from = await ensureWalletAddress(args.sessionAddress)
  const pool = ADDRESSES.gachaPool
  const maxFee = args.acquisitionFee + parseEther('1')

  args.api.note('Checking mMANA allowance for pull fee…')
  const allowance = await getManaAllowance(from, pool)
  if (allowance < maxFee || allowance < HIGH_ALLOWANCE) {
    await sendAndWait(args.api, {
      address: ADDRESSES.mockMana,
      abi: mockManaAbi,
      functionName: 'approve',
      args: [pool, MANA_MAX_APPROVAL],
      from,
      label: 'mMANA approve (unlimited)'
    })
  } else {
    args.api.note('mMANA allowance already high — skip')
  }

  if (!USE_TEST_FULFILL) {
    throw new Error('Production VRF pull is not wired in client yet — use test fulfill pool')
  }

  const rand = BigInt(Math.floor(Math.random() * 1e12))
  const hash = await sendAndWait(args.api, {
    address: pool,
    abi: gachaPoolAbi,
    functionName: 'requestAndFulfillForTest',
    args: [maxFee, rand],
    from,
    label: 'requestAndFulfillForTest (pull)'
  })

  args.api.note('Looking up pending win…')
  const win = await findPendingWinForPurchaser(from)
  return {
    hash,
    win: win ? { positionId: win.positionId, position: win.position } : null
  }
}

export async function runSettle(args: {
  sessionAddress?: string | null
  positionId: number
  keepPrize: boolean
  api: FlowApi
}): Promise<Hex> {
  const from = await ensureWalletAddress(args.sessionAddress)
  return sendAndWait(args.api, {
    address: ADDRESSES.gachaPool,
    abi: gachaPoolAbi,
    functionName: 'settle',
    args: [BigInt(args.positionId), args.keepPrize],
    from,
    label: args.keepPrize ? 'settle (keep prize)' : 'settle (take MANA)'
  })
}

export async function runWithdrawRewards(args: {
  sessionAddress?: string | null
  api: FlowApi
}): Promise<Hex> {
  const from = await ensureWalletAddress(args.sessionAddress)
  return sendAndWait(args.api, {
    address: ADDRESSES.gachaPool,
    abi: gachaPoolAbi,
    functionName: 'withdrawRewards',
    from,
    label: 'withdrawRewards'
  })
}


