/**
 * Fetch with a hard wall-clock timeout. Clears the timer when the response settles.
 * Does not implement byte inactivity timeouts (Phase D) — only total request budget.
 */

export const DEFAULT_FETCH_TIMEOUT_MS = 20_000
export const CATALYST_FETCH_TIMEOUT_MS = 15_000
export const PROFILE_FETCH_TIMEOUT_MS = 12_000
export const ABOUT_FETCH_TIMEOUT_MS = 10_000

export class FetchTimeoutError extends Error {
  readonly name = 'FetchTimeoutError'
  constructor(
    readonly url: string,
    readonly timeoutMs: number
  ) {
    super(`fetch_timeout ${timeoutMs}ms: ${url}`)
  }
}

export type FetchWithTimeoutInit = RequestInit & {
  /** Wall-clock timeout; default {@link DEFAULT_FETCH_TIMEOUT_MS}. */
  timeoutMs?: number
}

/**
 * Like `fetch`, but aborts after `timeoutMs` if the request has not completed.
 * Composes with an existing `signal` via AbortSignal.any when available.
 */
export async function fetchWithTimeout(
  input: string | URL | Request,
  init: FetchWithTimeoutInit = {}
): Promise<Response> {
  const timeoutMs = init.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS
  const { timeoutMs: _drop, signal: userSignal, ...rest } = init
  const url =
    typeof input === 'string' ? input : input instanceof URL ? input.href : input.url

  const controller = new AbortController()
  let timedOut = false
  const timer = window.setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)

  const onUserAbort = () => controller.abort()
  if (userSignal) {
    if (userSignal.aborted) controller.abort()
    else userSignal.addEventListener('abort', onUserAbort, { once: true })
  }

  try {
    const res = await fetch(input, { ...rest, signal: controller.signal })
    return res
  } catch (err) {
    if (timedOut || controller.signal.aborted) {
      if (timedOut) throw new FetchTimeoutError(url, timeoutMs)
    }
    throw err
  } finally {
    window.clearTimeout(timer)
    userSignal?.removeEventListener('abort', onUserAbort)
  }
}
