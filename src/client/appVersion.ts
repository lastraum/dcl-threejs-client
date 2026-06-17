/** App semver — read from package.json (bumped via release tooling, not every build). */
import pkg from '../../package.json'

declare const __BUILD_DATE__: string

export const APP_VERSION = pkg.version
export const APP_BUILD_DATE = typeof __BUILD_DATE__ !== 'undefined' ? __BUILD_DATE__ : 'dev'
export const APP_VERSION_LABEL = `v${pkg.version} (${APP_BUILD_DATE})`
