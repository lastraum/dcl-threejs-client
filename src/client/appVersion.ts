/**
 * Client version display — **only** source of truth for “which build is this?”
 * - Semver: package.json (release tooling / `npm version`, not progress docs)
 * - Build date: Vite `__BUILD_DATE__` at bundle time
 * Do not derive version from PROGRESS.md, CLAIMS.yaml, or offline fallbacks.
 */
import pkg from '../../package.json'

declare const __BUILD_DATE__: string

export const APP_VERSION = pkg.version
export const APP_BUILD_DATE = typeof __BUILD_DATE__ !== 'undefined' ? __BUILD_DATE__ : 'dev'
export const APP_VERSION_LABEL = `v${pkg.version} (${APP_BUILD_DATE})`
