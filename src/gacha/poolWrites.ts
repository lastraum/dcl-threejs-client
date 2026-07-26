import { maxUint256, parseEther, type Abi, type Address, type Hex } from 'viem'
import { ADDRESSES, USE_TEST_FULFILL } from './config'
import {
  ensureWalletAddress,
  getManaAllowance,
  getNftApproved,
  isNftApprovedForAll,
  sendContractMetaTx,
  waitReceipt,
  gachaPoolAbi,
  mockManaAbi,
  mockWearableAbi
} from './metaTx'
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
  }
): Promise<Hex> {
  const stepId = api.pushStep(args.label)
  try {
    const hash = await sendContractMetaTx({
      address: args.address,
      abi: args.abi,
      functionName: args.functionName,
      args: args.args,
      from: args.from
    })
    api.finishStep(stepId, { hash, detail: 'Waiting for confirmation…' })
    api.note(`Waiting for receipt ${hash.slice(0, 10)}…`)
    await waitReceipt(hash)
    api.finishStep(stepId, { hash, detail: 'Confirmed' })
    return hash
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    api.finishStep(stepId, { detail: msg, error: true })
    throw e
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
      label: 'NFT setApprovalForAll → pool'
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


