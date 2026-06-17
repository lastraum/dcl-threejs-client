#!/usr/bin/env node
/**
 * Cut a release on `main` and push a semver git tag.
 *
 * Branch flow:
 *   lastraum → dev-latest (QA) → main (release)
 *
 * Usage:
 *   node scripts/release.mjs 0.1.0
 *   node scripts/release.mjs 0.1.0 --push
 *
 * With --push: commits version bump (if needed), tags v<version>, pushes main + tag.
 * Without --push: dry-run — validates, bumps package.json, builds, prints next steps.
 */

import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const PKG_PATH = join(ROOT, 'package.json')

function run(cmd, opts = {}) {
  const out = execSync(cmd, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: opts.silent ? 'pipe' : 'inherit',
    ...opts
  })
  return (out ?? '').trim()
}

function runSilent(cmd) {
  return run(cmd, { silent: true })
}

const semverRe = /^\d+\.\d+\.\d+(-[\w.]+)?$/
const version = process.argv[2]
const push = process.argv.includes('--push')

if (!version || !semverRe.test(version)) {
  console.error('Usage: node scripts/release.mjs <semver> [--push]')
  console.error('Example: node scripts/release.mjs 0.1.0 --push')
  process.exit(1)
}

const tag = `v${version}`
const branch = runSilent('git branch --show-current')

if (branch !== 'main') {
  console.error(`Release must be cut from main (current: ${branch}).`)
  console.error('  git checkout main && git merge dev-latest')
  process.exit(1)
}

const dirty = runSilent('git status --porcelain')
if (dirty) {
  console.error('Working tree is not clean. Commit or stash changes first.')
  process.exit(1)
}

try {
  runSilent(`git rev-parse ${tag}`)
  console.error(`Tag ${tag} already exists locally.`)
  process.exit(1)
} catch {
  /* ok */
}

const pkg = JSON.parse(readFileSync(PKG_PATH, 'utf8'))
if (pkg.version !== version) {
  pkg.version = version
  writeFileSync(PKG_PATH, `${JSON.stringify(pkg, null, 2)}\n`)
  console.log(`package.json → ${version}`)
}

console.log('Running build…')
run('SKIP_VERSION_BUMP=1 npm run build')

const statusAfter = runSilent('git status --porcelain')
if (statusAfter) {
  run(`git add package.json`)
  run(`git commit -m "Release ${tag}."`)
}

run(`git tag -a ${tag} -m "Release ${tag}"`)

console.log(`\nTagged ${tag} on main.`)

if (push) {
  run('git push origin main')
  run(`git push origin ${tag}`)
  console.log(`\nPushed main and ${tag}. GitHub Actions will attach dist/ to the release.`)
} else {
  console.log('\nDry run complete. To publish:')
  console.log(`  node scripts/release.mjs ${version} --push`)
  console.log(`  # or: git push origin main && git push origin ${tag}`)
}