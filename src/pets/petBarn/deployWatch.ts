import { fetchPetBarnCatalog } from './catalog'
import {
  PETBARN_DEPLOY_POLL_MS,
  PETBARN_DEPLOY_TIMEOUT_MS
} from './constants'
import type { PetBarnListing } from './types'

export type BarnDeployAction = 'create' | 'update' | 'delete'

export type BarnDeploySnapshot = Pick<
  PetBarnListing,
  'glbCid' | 'thumbnailCid' | 'petName' | 'type' | 'deployedAt'
>

export type BarnDeployWatchInput = {
  action: BarnDeployAction
  /** Listing id (update/delete) or the Worker queue id (create). */
  targetId: string
  /** update only — confirm when any of these fields change. */
  prev?: BarnDeploySnapshot
  signal?: AbortSignal
}

export type BarnDeployOutcome = 'deployed' | 'timeout'

function listingChanged(hit: PetBarnListing, prev: BarnDeploySnapshot | undefined): boolean {
  if (!prev) return true
  return (
    hit.glbCid !== prev.glbCid ||
    hit.thumbnailCid !== prev.thumbnailCid ||
    hit.petName !== prev.petName ||
    hit.type !== prev.type ||
    hit.deployedAt !== prev.deployedAt
  )
}

/** Poll catalog until create/update/delete is visible. Never rejects. */
export async function watchBarnDeploy(input: BarnDeployWatchInput): Promise<BarnDeployOutcome> {
  const deadline = Date.now() + PETBARN_DEPLOY_TIMEOUT_MS
  for (;;) {
    if (input.signal?.aborted) return 'timeout'
    await sleep(PETBARN_DEPLOY_POLL_MS, input.signal)
    if (input.signal?.aborted) return 'timeout'
    try {
      // Shared inflight fetch — don't attach this watch's abort (would cancel the shop poll).
      const catalog = await fetchPetBarnCatalog()
      const hit = catalog.pets.find((p) => p.id === input.targetId)
      if (input.action === 'delete' && !hit) return 'deployed'
      if (input.action === 'create' && hit) return 'deployed'
      if (input.action === 'update' && hit && listingChanged(hit, input.prev)) return 'deployed'
    } catch {
      if (input.signal?.aborted) return 'timeout'
    }
    if (Date.now() >= deadline) return 'timeout'
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve()
      return
    }
    const t = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t)
        resolve()
      },
      { once: true }
    )
  })
}
