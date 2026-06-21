export type EthereumProvider = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>
  on?: (event: string, handler: (...args: unknown[]) => void) => void
  removeListener?: (event: string, handler: (...args: unknown[]) => void) => void
}

declare global {
  interface Window {
    ethereum?: EthereumProvider
  }
}

let activeProvider: EthereumProvider | null = null

export function setActiveEthereumProvider(provider: EthereumProvider | null): void {
  activeProvider = provider
}

export function getEthereumProvider(): EthereumProvider | null {
  if (typeof window === 'undefined') return null
  return activeProvider ?? window.ethereum ?? null
}

export async function requestWalletAddress(): Promise<string> {
  const provider = getEthereumProvider()
  if (!provider) throw new Error('No Ethereum wallet found — install MetaMask or similar')

  const accounts = (await provider.request({ method: 'eth_requestAccounts' })) as string[]
  const address = accounts[0]?.trim().toLowerCase()
  if (!address || !/^0x[a-f0-9]{40}$/.test(address)) {
    throw new Error('Wallet did not return a valid address')
  }
  return address
}

export async function signPersonalMessage(message: string, address: string): Promise<string> {
  const provider = getEthereumProvider()
  if (!provider) throw new Error('No Ethereum wallet found')

  // Hex-encode the message for broad wallet compatibility (MetaMask, Brave, Opera, etc.)
  const hexMessage = '0x' + Array.from(new TextEncoder().encode(message))
    .map(b => b.toString(16).padStart(2, '0')).join('')

  const signature = (await provider.request({
    method: 'personal_sign',
    params: [hexMessage, address]
  })) as string

  if (!signature || typeof signature !== 'string') {
    throw new Error('Wallet did not return a signature')
  }
  return signature
}
