export type EthereumProvider = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>
  on?: (event: string, handler: (...args: unknown[]) => void) => void
  removeListener?: (event: string, handler: (...args: unknown[]) => void) => void
}

type InjectedProviderFlags = {
  isMetaMask?: boolean
  isPhantom?: boolean
  isBraveWallet?: boolean
  providers?: InjectedProviderFlags[]
  request?: EthereumProvider['request']
}

declare global {
  interface Window {
    ethereum?: EthereumProvider & InjectedProviderFlags
  }
}

const MAINNET_CHAIN_ID = '0x1'

let activeProvider: EthereumProvider | null = null

export function setActiveEthereumProvider(provider: EthereumProvider | null): void {
  activeProvider = provider
}

/** Pick the real MetaMask provider when multiple wallets share `window.ethereum`. */
export function resolveMetaMaskProvider(): EthereumProvider | null {
  if (typeof window === 'undefined') return null
  const eth = window.ethereum
  if (!eth?.request) return null

  if (Array.isArray(eth.providers) && eth.providers.length > 0) {
    const metaMask = eth.providers.find(
      (p) => p.isMetaMask && !p.isPhantom && !p.isBraveWallet && p.request
    )
    if (metaMask?.request) return metaMask as EthereumProvider
  }

  if (eth.isMetaMask && !eth.isPhantom && !eth.isBraveWallet) {
    return eth
  }

  return null
}

export function getEthereumProvider(): EthereumProvider | null {
  if (typeof window === 'undefined') return null
  return activeProvider ?? resolveMetaMaskProvider() ?? window.ethereum ?? null
}

function wrapWalletError(err: unknown): Error {
  const msg = err instanceof Error ? err.message : String(err)
  if (/15 significant digits/i.test(msg) || /BigNumber Error/i.test(msg)) {
    return new Error(
      'MetaMask hit a fee-calculation error. Switch to Ethereum Mainnet in MetaMask, then try signing in again.'
    )
  }
  if (/user rejected|denied|cancelled|canceled/i.test(msg)) {
    return new Error('Connection cancelled in wallet.')
  }
  return err instanceof Error ? err : new Error(msg)
}

export async function ensureEthereumMainnet(provider: EthereumProvider): Promise<void> {
  const chainId = (await provider.request({ method: 'eth_chainId' })) as string
  if (chainId?.toLowerCase() === MAINNET_CHAIN_ID) return

  try {
    await provider.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: MAINNET_CHAIN_ID }]
    })
  } catch (err) {
    const code = (err as { code?: number })?.code
    if (code === 4902) {
      throw new Error('Please add Ethereum Mainnet to MetaMask and try again.')
    }
    throw wrapWalletError(err)
  }

  const after = (await provider.request({ method: 'eth_chainId' })) as string
  if (after?.toLowerCase() !== MAINNET_CHAIN_ID) {
    throw new Error(
      'MetaMask must be on Ethereum Mainnet to sign in. Open MetaMask, switch to Mainnet, then try again.'
    )
  }
}

function normalizeAddress(address: string): string {
  const normalized = address.trim().toLowerCase()
  if (!/^0x[a-f0-9]{40}$/.test(normalized)) {
    throw new Error('Wallet did not return a valid address')
  }
  return normalized
}

function toHexMessage(message: string): string {
  return (
    '0x' +
    Array.from(new TextEncoder().encode(message))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
  )
}

async function requestAccounts(provider: EthereumProvider): Promise<string[]> {
  let accounts: string[] = []
  try {
    const existing = (await provider.request({ method: 'eth_accounts' })) as string[]
    if (Array.isArray(existing) && existing.length > 0) {
      accounts = existing
    }
  } catch {
    // Fall through to eth_requestAccounts.
  }

  if (accounts.length === 0) {
    accounts = (await provider.request({ method: 'eth_requestAccounts' })) as string[]
  }

  return Array.isArray(accounts) ? accounts : []
}

export async function requestWalletAddress(): Promise<string> {
  const provider = getEthereumProvider()
  if (!provider) throw new Error('No Ethereum wallet found — install MetaMask or similar')

  try {
    await ensureEthereumMainnet(provider)
    const accounts = await requestAccounts(provider)
    const address = normalizeAddress(accounts[0] ?? '')
    return address
  } catch (err) {
    throw wrapWalletError(err)
  }
}

async function tryPersonalSign(
  provider: EthereumProvider,
  message: string,
  address: string
): Promise<string> {
  const signature = (await provider.request({
    method: 'personal_sign',
    params: [message, address]
  })) as string

  if (!signature || typeof signature !== 'string') {
    throw new Error('Wallet did not return a signature')
  }
  return signature
}

export async function signPersonalMessage(message: string, address: string): Promise<string> {
  const provider = getEthereumProvider()
  if (!provider) throw new Error('No Ethereum wallet found')

  const normalized = normalizeAddress(address)
  const hexMessage = toHexMessage(message)

  const attempts: Array<[string, string]> = [
    [hexMessage, normalized],
    [message, normalized]
  ]

  try {
    await ensureEthereumMainnet(provider)
  } catch (err) {
    throw wrapWalletError(err)
  }

  let lastError: unknown
  for (const [msg, addr] of attempts) {
    try {
      return await tryPersonalSign(provider, msg, addr)
    } catch (err) {
      lastError = err
      const msgText = err instanceof Error ? err.message : String(err)
      if (/user rejected|denied|cancelled|canceled/i.test(msgText)) {
        throw wrapWalletError(err)
      }
    }
  }

  throw wrapWalletError(lastError)
}