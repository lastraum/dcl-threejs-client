/**
 * Meta-tx path ported from Loot Bag admin/src/metaTx.ts.
 * EIP-712 sign via client ethereum provider → forge dcl-meta-tx POST /v1/transactions.
 */
import { encodeFunctionData, type Abi, type Address, type Hex } from 'viem'
import { getEthereumProvider } from '../auth/ethereumProvider'
import { ADDRESSES, CHAIN_ID, META_TX_DOMAINS, META_TX_URL } from './config'
import { polygonPublicClient } from './polygonClient'
import { lootBagPoolAbi } from './abis/GachaPool'
import { mockManaAbi } from './abis/MockMANA'
import { mockWearableAbi } from './abis/MockWearable'

const DOMAIN_TYPE = [
  { name: 'name', type: 'string' },
  { name: 'version', type: 'string' },
  { name: 'verifyingContract', type: 'address' },
  { name: 'salt', type: 'bytes32' }
] as const

const META_TRANSACTION_TYPE = [
  { name: 'nonce', type: 'uint256' },
  { name: 'from', type: 'address' },
  { name: 'functionSignature', type: 'bytes' }
] as const

const GET_NONCE_SELECTOR = '2d0335ab'
const EXECUTE_META_TX_SELECTOR = '0c53c51c'

function to32Bytes(value: number | string): string {
  return value.toString().replace(/^0x/i, '').padStart(64, '0')
}

function getSalt(chainId: number): string {
  return `0x${to32Bytes(chainId.toString(16))}`
}

function normalizeVersion(version: string): string {
  let parsed = parseInt(version, 16)
  if (parsed < 27) parsed += 27
  if (parsed !== 27 && parsed !== 28) {
    throw new Error(`Invalid signature v "${version}" (parsed ${parsed})`)
  }
  return parsed.toString(16)
}

export function getExecuteMetaTransactionData(
  account: string,
  fullSignature: string,
  functionSignature: string
): string {
  const signature = fullSignature.replace(/^0x/, '')
  const r = signature.substring(0, 64)
  const s = signature.substring(64, 128)
  const v = normalizeVersion(signature.substring(128, 130))
  const method = functionSignature.replace(/^0x/, '')
  const signatureLength = (method.length / 2).toString(16)
  const signaturePadding = Math.ceil(method.length / 64)

  return [
    '0x',
    EXECUTE_META_TX_SELECTOR,
    to32Bytes(account),
    to32Bytes('a0'),
    r,
    s,
    to32Bytes(v),
    to32Bytes(signatureLength),
    method.padEnd(64 * signaturePadding, '0')
  ].join('')
}

async function getNonce(account: string, contractAddress: string): Promise<string> {
  const data = (`0x${GET_NONCE_SELECTOR}${to32Bytes(account)}`) as Hex
  const result = await polygonPublicClient.call({
    to: contractAddress as Address,
    data
  })
  if (!result.data) throw new Error(`getNonce empty for ${contractAddress}`)
  return to32Bytes(result.data)
}

type TypedDataPayload = {
  types: {
    EIP712Domain: typeof DOMAIN_TYPE
    MetaTransaction: typeof META_TRANSACTION_TYPE
  }
  domain: {
    name: string
    version: string
    verifyingContract: string
    salt: string
  }
  primaryType: 'MetaTransaction'
  message: {
    nonce: number
    from: string
    functionSignature: string
  }
}

export function getDataToSign(
  account: string,
  nonceHex32: string,
  functionSignature: string,
  verifyingContract: string,
  domainName: string,
  domainVersion: string
): TypedDataPayload {
  return {
    types: {
      EIP712Domain: DOMAIN_TYPE,
      MetaTransaction: META_TRANSACTION_TYPE
    },
    domain: {
      name: domainName,
      version: domainVersion,
      verifyingContract,
      salt: getSalt(CHAIN_ID)
    },
    primaryType: 'MetaTransaction',
    message: {
      nonce: parseInt(nonceHex32, 16),
      from: account,
      functionSignature
    }
  }
}

export function supportsMetaTx(address: Address): boolean {
  return address.toLowerCase() in META_TX_DOMAINS
}

async function requestAccounts(): Promise<Address> {
  const provider = getEthereumProvider()
  if (!provider?.request) {
    throw new Error('No Ethereum wallet found — connect MetaMask or similar')
  }
  let accounts: string[] = []
  try {
    const existing = (await provider.request({ method: 'eth_accounts' })) as string[]
    if (Array.isArray(existing) && existing.length > 0) accounts = existing
  } catch {
    /* fall through */
  }
  if (accounts.length === 0) {
    accounts = (await provider.request({ method: 'eth_requestAccounts' })) as string[]
  }
  if (!accounts?.length) throw new Error('No account returned — unlock wallet and connect')
  return accounts[0].toLowerCase() as Address
}

async function ethSignTypedDataV4(account: string, dataToSign: TypedDataPayload): Promise<string> {
  const provider = getEthereumProvider()
  if (!provider?.request) throw new Error('No Ethereum wallet found')

  return (await provider.request({
    method: 'eth_signTypedData_v4',
    params: [account, JSON.stringify(dataToSign)]
  })) as string
}

/** EIP-712 domain for NativeMetaTransaction (name + version). */
export type MetaTxDomain = { name: string; version: string }

/**
 * DCL Collection V2 / wearables-contracts — all Collection V2 proxies share this domain.
 * @see ERC721BaseCollectionV2 _initializeEIP712('Decentraland Collection', '2')
 */
export const DCL_COLLECTION_V2_META_TX_DOMAIN: MetaTxDomain = {
  name: 'Decentraland Collection',
  version: '2'
}

/**
 * Sign + relay a call on a NativeMetaTransaction contract.
 * Does NOT switch MetaMask network.
 * @param domainOverride — e.g. Collection V2 (`DCL_COLLECTION_V2_META_TX_DOMAIN`) when address is not in META_TX_DOMAINS
 */
export async function sendContractMetaTx(args: {
  address: Address
  abi: Abi
  functionName: string
  args?: readonly unknown[]
  from?: Address
  domainOverride?: MetaTxDomain
}): Promise<Hex> {
  const from = ((args.from || (await requestAccounts())) as string).toLowerCase() as Address

  const domain =
    args.domainOverride ?? META_TX_DOMAINS[args.address.toLowerCase()]
  if (!domain) {
    throw new Error(`Contract ${args.address} has no meta-tx domain configured`)
  }

  const functionSignature = encodeFunctionData({
    abi: args.abi,
    functionName: args.functionName,
    args: args.args as never
  })

  const contract = args.address
  const nonce = await getNonce(from, contract)
  const dataToSign = getDataToSign(
    from,
    nonce,
    functionSignature,
    contract,
    domain.name,
    domain.version
  )

  const signature = await ethSignTypedDataV4(from, dataToSign)
  const txData = getExecuteMetaTransactionData(from, signature, functionSignature)

  const body = {
    transactionData: {
      from,
      params: [contract, txData] as [string, string]
    }
  }

  let res: Response
  try {
    res = await fetch(META_TX_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body)
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    throw new Error(
      `Meta-tx relay unreachable (${META_TX_URL}). Ensure nginx/Vite proxies /api/meta-tx → transactions.lastslice.co. ${msg}`
    )
  }

  const raw = await res.text()
  const contentType = res.headers.get('content-type') || ''
  const looksHtml =
    contentType.includes('text/html') ||
    /^\s*<(!doctype|html)\b/i.test(raw) ||
    /405 Not Allowed/i.test(raw)

  // SPA fallback catching /api/meta-tx → GET 200 HTML / POST 405 HTML
  if (looksHtml || res.status === 405) {
    throw new Error(
      `Meta-tx proxy missing on this host (HTTP ${res.status} for ${META_TX_URL}). ` +
        `Nginx must proxy /api/meta-tx/ → https://transactions.lastslice.co/ ` +
        `(see remote/decentraland.social). Reload nginx after updating the site config.`
    )
  }

  let json: { ok?: boolean; txHash?: string; message?: string } = {}
  try {
    json = raw ? (JSON.parse(raw) as typeof json) : {}
  } catch {
    throw new Error(
      `Meta-tx relay returned non-JSON HTTP ${res.status}: ${raw.slice(0, 180)}`
    )
  }

  if (!res.ok || json.ok === false || !json.txHash) {
    throw new Error(
      json.message ||
        `Meta-tx relay failed HTTP ${res.status}: ${JSON.stringify(json).slice(0, 240)}`
    )
  }

  return json.txHash as Hex
}

/**
 * Resolve the address that will sign meta-tx (MetaMask / injected wallet).
 *
 * Guest login has a browser-only key for DCL identity — it does **not** sign
 * Polygon loot bag txs. Meta-tx always uses the injected wallet. We therefore:
 * - reject guest sessions for paid pool writes (caller should pass isGuest)
 * - require MetaMask account === session wallet when a preferred address is set
 *   (never silently use a different connected account)
 */
export async function ensureWalletAddress(
  preferred?: string | null,
  opts?: { isGuest?: boolean }
): Promise<Address> {
  if (opts?.isGuest) {
    throw new Error(
      'Guest accounts cannot claim or deposit on Loot Bag. ' +
        'Log in with MetaMask (wallet) — guest identity is for chat/avatar only and has no Polygon mMANA. ' +
        'If MetaMask popped up while you were a guest, the tx was signed by that MetaMask account, not Guest.'
    )
  }

  const connected = await requestAccounts()
  if (preferred && /^0x[a-fA-F0-9]{40}$/.test(preferred)) {
    const want = preferred.toLowerCase() as Address
    if (connected.toLowerCase() === want) return connected
    throw new Error(
      `Wrong wallet in MetaMask. This session is ${want.slice(0, 6)}…${want.slice(-4)} ` +
        `but the connected account is ${connected.slice(0, 6)}…${connected.slice(-4)}. ` +
        `Switch MetaMask to the session account, or log out of Guest and log in with that wallet.`
    )
  }
  return connected
}

export async function getManaAllowance(owner: Address, spender: Address): Promise<bigint> {
  return polygonPublicClient.readContract({
    address: ADDRESSES.mockMana,
    abi: mockManaAbi,
    functionName: 'allowance',
    args: [owner, spender]
  }) as Promise<bigint>
}

/** Wallet mMANA balance (wei). Always re-read before paid pulls — UI snapshot can be stale/0. */
export async function getManaBalance(owner: Address): Promise<bigint> {
  return polygonPublicClient.readContract({
    address: ADDRESSES.mockMana,
    abi: mockManaAbi,
    functionName: 'balanceOf',
    args: [owner]
  }) as Promise<bigint>
}

export async function getNftApproved(
  collection: Address,
  tokenId: bigint
): Promise<Address> {
  return polygonPublicClient.readContract({
    address: collection,
    abi: mockWearableAbi,
    functionName: 'getApproved',
    args: [tokenId]
  }) as Promise<Address>
}

export async function isNftApprovedForAll(
  collection: Address,
  owner: Address,
  operator: Address
): Promise<boolean> {
  return polygonPublicClient.readContract({
    address: collection,
    abi: mockWearableAbi,
    functionName: 'isApprovedForAll',
    args: [owner, operator]
  }) as Promise<boolean>
}

/** EIP-712 domain for NFT meta-tx approve (Mock vs DCL Collection V2). */
export function nftMetaTxDomain(collection: Address): MetaTxDomain {
  const key = collection.toLowerCase()
  if (META_TX_DOMAINS[key]) return META_TX_DOMAINS[key]!
  return DCL_COLLECTION_V2_META_TX_DOMAIN
}

/** Wait for receipt; throw if reverted */
export async function waitReceipt(hash: Hex): Promise<void> {
  const receipt = await polygonPublicClient.waitForTransactionReceipt({
    hash,
    timeout: 180_000,
    confirmations: 1
  })
  if (receipt.status === 'reverted') {
    throw new Error(`Transaction reverted on-chain: ${hash}`)
  }
}

export { lootBagPoolAbi, mockManaAbi, mockWearableAbi }
