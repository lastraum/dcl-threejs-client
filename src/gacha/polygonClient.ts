import { createPublicClient, http } from 'viem'
import { polygon } from 'viem/chains'
import { POLYGON_RPC } from './config'

export const polygonPublicClient = createPublicClient({
  chain: polygon,
  transport: http(POLYGON_RPC)
})
