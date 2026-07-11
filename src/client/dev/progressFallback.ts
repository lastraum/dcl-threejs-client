/**
 * Offline PROGRESS.md snapshot for the dev panel when GitHub fetch is disabled.
 * Bundled at build/dev time via Vite `?raw` — does not rewrite this file on `npm run build`.
 */
import progressMd from '../../../docs/PROGRESS.md?raw'

const PROGRESS_FALLBACK_MAX_CHARS = 24_000

export const PROGRESS_FALLBACK =
  progressMd.length > PROGRESS_FALLBACK_MAX_CHARS
    ? `${progressMd.slice(0, PROGRESS_FALLBACK_MAX_CHARS)}\n\n… (truncated — see GitHub PROGRESS.md)`
    : progressMd
