/**
 * Offline notice only — not the community progress log.
 * Live “what’s been worked on” always comes from GitHub (docs/PROGRESS.md on the docs branch).
 * Client version is never read from this file — use `appVersion.ts` / package.json.
 */
export const PROGRESS_FALLBACK = `## Progress unavailable offline

The dev panel loads **live** milestone notes from GitHub:

[\`docs/PROGRESS.md\`](https://github.com/lastraum/dcl-threejs-client/blob/dev-latest/docs/PROGRESS.md) on branch \`dev-latest\` (override with \`?docsBranch=\`).

This offline notice is **not** a snapshot of project progress and is **not** the client version.

- Client version: \`package.json\` → \`APP_VERSION\`
- Force offline (for testing): \`?docsGithubFetch=0\`
`
