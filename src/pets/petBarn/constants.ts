/** Max GLB for Pet Barn marketplace publish (stricter than local library). */
export const PETBARN_MAX_GLB_BYTES = 2 * 1024 * 1024

/** Max thumbnail after client-side compression. */
export const PETBARN_MAX_THUMB_BYTES = 500 * 1024

export const PETBARN_WORLD = 'petbarn.dcl.eth'

export const PETBARN_CATALOG_URL_DEFAULT =
  'https://raw.githubusercontent.com/lastraum/petbarn/main/catalog.json'

export const PETBARN_WORKER_URL_DEFAULT =
  'https://dcl-petbarn-dispatch.lastraum.workers.dev'

export const PETBARN_CONTENT_BASE_DEFAULT =
  'https://worlds-content-server.decentraland.org/contents/'

/** Poll while Pet Barn shop is open (picks up CI deploys without blocking publish UI). */
export const PETBARN_POLL_MS = 30_000

export const PETBARN_ADDED_STORAGE_KEY = 'dcl-client-petbarn-added'

/** Poll cadence while waiting for a queued publish/update/delete to reach the catalog. */
export const PETBARN_DEPLOY_POLL_MS = 20_000

/**
 * Give up watching a queued action after this long. The raw.githubusercontent
 * CDN adds ~1 min of cache latency on top of the ~1 min Action run, so a healthy
 * deploy confirms in 2–3 minutes; six covers a queue that had to retry.
 */
export const PETBARN_DEPLOY_TIMEOUT_MS = 6 * 60_000
