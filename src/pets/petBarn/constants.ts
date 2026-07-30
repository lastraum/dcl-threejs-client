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

/** Poll while Pet Barn shop is open. */
export const PETBARN_POLL_MS = 30_000

/** Poll catalog after publish until the new listing appears. */
export const PETBARN_PUBLISH_POLL_MS = 5_000

/** Give up waiting for catalog after Worker success (Action + CDN lag). */
export const PETBARN_PUBLISH_TIMEOUT_MS = 6 * 60 * 1000

export const PETBARN_ADDED_STORAGE_KEY = 'dcl-client-petbarn-added'
