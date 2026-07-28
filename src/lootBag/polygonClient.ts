import { createPublicClient, fallback, http } from 'viem'
import { polygon } from 'viem/chains'
import { POLYGON_RPC, POLYGON_RPC_FALLBACKS } from './config'

const rpcUrls = [POLYGON_RPC, ...POLYGON_RPC_FALLBACKS.filter((u) => u !== POLYGON_RPC)]

export const polygonPublicClient = createPublicClient({
  chain: polygon,
  transport: fallback(
    rpcUrls.map((url) =>
      http(url, {
        timeout: 20_000,
        retryCount: 2,
        retryDelay: 400
      })
    ),
    { rank: false }
  )
})
