import { fetchPetBarnCatalog } from './catalog'
import {
  PETBARN_DEPLOY_POLL_MS,
  PETBARN_DEPLOY_TIMEOUT_MS
} from './constants'

export type BarnDeployAction = 'create' | 'update' | 'delete'

export type BarnDeployWatchInput = {
  action: BarnDeployAction
  /** Listing id (update/delete) or the queue id the Worker returned (create). */
  targetId: string
  /** update only: the glbCid before the update — deploy is confirmed when it changes. */
  prevGlbCid?: string
}

export type BarnDeployOutcome = 'deployed' | 'timeout'

/**
 * Poll the catalog until a queued Barn action is visible in it.
 *
 * "Queued" from the Worker only means the request reached the deploy pipeline;
 * the GitHub Action then builds, deploys to the Worlds server, and commits the
 * catalog — or fails and rolls back, which the submitter otherwise never sees.
 * The catalog is the single source of truth, so confirmation = the expected
 * state change appearing there:
 *
 *   create → the new listing id exists
 *   update → the target's glbCid differs from what it was at submit time
 *   delete → the target id is gone
 *
 * Resolves 'deployed' or 'timeout' (never rejects — a transient fetch error
 * just waits for the next poll).
 */
export async function watchBarnDeploy(input: BarnDeployWatchInput): Promise<BarnDeployOutcome> {
  const deadline = Date.now() + PETBARN_DEPLOY_TIMEOUT_MS
  for (;;) {
    await sleep(PETBARN_DEPLOY_POLL_MS)
    try {
      const catalog = await fetchPetBarnCatalog()
      const hit = catalog.pets.find((p) => p.id === input.targetId)
      if (input.action === 'delete' && !hit) return 'deployed'
      if (input.action === 'create' && hit) return 'deployed'
      if (input.action === 'update' && hit && hit.glbCid !== (input.prevGlbCid ?? '')) {
        return 'deployed'
      }
    } catch {
      /* transient — next poll retries */
    }
    if (Date.now() >= deadline) return 'timeout'
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
