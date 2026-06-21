import type { EthereumProvider } from './ethereumProvider'

type MetaMaskSdkModule = typeof import('@metamask/sdk')
type MetaMaskSdkInstance = InstanceType<MetaMaskSdkModule['default']>

let sdkInstance: MetaMaskSdkInstance | null = null
let sdkInitPromise: Promise<MetaMaskSdkInstance> | null = null
let resumeListenerAttached = false

function isMobileDevice(): boolean {
  if (typeof navigator === 'undefined') return false
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)
}

function hasInjectedMetaMask(): boolean {
  if (typeof window === 'undefined') return false
  const eth = window.ethereum as (EthereumProvider & { isMetaMask?: boolean }) | undefined
  return Boolean(eth?.isMetaMask)
}

export function shouldUseMetaMaskSdk(): boolean {
  return isMobileDevice() && !hasInjectedMetaMask()
}

async function getOrInitMetaMaskSdk(): Promise<MetaMaskSdkInstance> {
  if (sdkInstance) return sdkInstance
  if (sdkInitPromise) return sdkInitPromise

  sdkInitPromise = (async () => {
    const { default: MetaMaskSDK } = await import('@metamask/sdk')

    const sdk = new MetaMaskSDK({
      dappMetadata: {
        name: 'Decentraland',
        url: typeof window !== 'undefined' ? window.location.origin : 'https://decentraland.org'
      },
      injectProvider: false,
      extensionOnly: false,
      headless: true,
      useDeeplink: true,
      openDeeplink: (link: string) => {
        window.location.href = link
      },
      checkInstallationImmediately: false
    })

    await sdk.init()
    attachResumeOnVisibility(sdk)
    sdkInstance = sdk
    return sdk
  })()

  return sdkInitPromise
}

function attachResumeOnVisibility(sdk: MetaMaskSdkInstance): void {
  if (resumeListenerAttached || typeof document === 'undefined') return
  resumeListenerAttached = true

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return
    void sdk.resume().catch(() => {
      // Ignore resume errors — connect/sign will retry as needed.
    })
  })
}

export async function getMetaMaskSdkProvider(): Promise<EthereumProvider> {
  const sdk = await getOrInitMetaMaskSdk()
  const provider = sdk.getProvider()
  if (!provider) throw new Error('MetaMask SDK failed to initialize')
  return provider as EthereumProvider
}

export async function connectMetaMaskSdk(): Promise<string[]> {
  const sdk = await getOrInitMetaMaskSdk()
  return sdk.connect()
}

/** Prefer injected MetaMask; on mobile without extension, use SDK deeplink flow. */
export async function ensureMetaMaskProvider(
  onStatus?: (msg: string) => void
): Promise<EthereumProvider> {
  if (hasInjectedMetaMask() && window.ethereum) {
    return window.ethereum
  }

  if (!shouldUseMetaMaskSdk()) {
    throw new Error('MetaMask not found — install the MetaMask extension or mobile app')
  }

  onStatus?.('Opening MetaMask app…')
  const provider = await getMetaMaskSdkProvider()
  await connectMetaMaskSdk()
  return provider
}