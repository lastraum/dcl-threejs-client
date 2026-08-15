#!/usr/bin/env node
/**
 * Contract checks for Hub preview realm parsing (mirrors src/dcl/content/previewRealm.ts).
 * Run: npm run test:preview-realm
 */

const DEFAULT_PREVIEW_REALM = 'http://127.0.0.1:8000'
const DEFAULT_PREVIEW_PORT = 8000

function isTruthyQueryFlag(value) {
  if (!value) return false
  const v = value.trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'yes'
}

function isPreviewLoopbackHost(host) {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase()
  return h === '127.0.0.1' || h === 'localhost' || h === '::1'
}

function decodeMaybe(raw) {
  let text = raw.trim()
  try {
    if (/%[0-9a-f]{2}/i.test(text)) text = decodeURIComponent(text)
  } catch {
    /* keep */
  }
  return text.trim()
}

function parsePreviewRealmUrl(raw) {
  if (!raw) return null
  const text = decodeMaybe(raw).replace(/\/+$/, '')
  if (!text) return null

  let candidate = text
  if (candidate.startsWith('//')) candidate = `http:${candidate}`
  if (!/^https?:\/\//i.test(candidate)) {
    const hostPart = candidate.split('/')[0] ?? candidate
    const hostname = hostPart.replace(/:\d+$/, '').replace(/^\[|\]$/g, '')
    if (!isPreviewLoopbackHost(hostname)) return null
    candidate = `http://${candidate}`
  }

  let url
  try {
    url = new URL(candidate)
  } catch {
    return null
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (!isPreviewLoopbackHost(url.hostname)) return null

  const port = url.port || String(DEFAULT_PREVIEW_PORT)
  return `${url.protocol}//${url.hostname}:${port}`
}

function previewRealmFromSearch(params) {
  const fromRealm = parsePreviewRealmUrl(params.get('realm'))
  if (fromRealm) return fromRealm

  const portRaw = params.get('port')?.trim()
  if (portRaw && /^\d{1,5}$/.test(portRaw)) {
    const port = Number(portRaw)
    if (Number.isInteger(port) && port >= 1 && port <= 65535) {
      return `http://127.0.0.1:${port}`
    }
  }

  return DEFAULT_PREVIEW_REALM
}

function isPreviewQuery(params) {
  if (isTruthyQueryFlag(params.get('preview'))) return true
  if (isTruthyQueryFlag(params.get('local-scene'))) return true
  return parsePreviewRealmUrl(params.get('realm')) !== null
}

let passed = 0
let failed = 0

function assert(label, condition) {
  if (condition) {
    passed += 1
    console.log(`  ok ${label}`)
  } else {
    failed += 1
    console.error(` FAIL ${label}`)
  }
}

function eq(label, actual, expected) {
  assert(`${label} → ${JSON.stringify(actual)}`, actual === expected)
}

console.log('preview realm parse')

eq('default explorer url', parsePreviewRealmUrl('http://127.0.0.1:8000'), 'http://127.0.0.1:8000')
eq('trailing slash', parsePreviewRealmUrl('http://127.0.0.1:8000/'), 'http://127.0.0.1:8000')
eq('bare host:port', parsePreviewRealmUrl('127.0.0.1:8001'), 'http://127.0.0.1:8001')
eq('localhost', parsePreviewRealmUrl('http://localhost:8000'), 'http://localhost:8000')
eq('no port defaults 8000', parsePreviewRealmUrl('http://127.0.0.1'), 'http://127.0.0.1:8000')
eq('encoded url', parsePreviewRealmUrl('http%3A%2F%2F127.0.0.1%3A8000'), 'http://127.0.0.1:8000')
eq('reject custom world host', parsePreviewRealmUrl('worlds.dcl-iwb.co'), null)
eq('reject https remote', parsePreviewRealmUrl('https://peer.decentraland.org'), null)
eq('reject LAN', parsePreviewRealmUrl('http://192.168.1.10:8000'), null)

const defaultParams = new URLSearchParams()
eq('empty search → default', previewRealmFromSearch(defaultParams), DEFAULT_PREVIEW_REALM)
eq('port query', previewRealmFromSearch(new URLSearchParams('port=8001')), 'http://127.0.0.1:8001')
eq(
  'realm query wins over port',
  previewRealmFromSearch(new URLSearchParams('realm=http://127.0.0.1:9000&port=8001')),
  'http://127.0.0.1:9000'
)

assert('preview=true', isPreviewQuery(new URLSearchParams('preview=true')))
assert('local-scene=true', isPreviewQuery(new URLSearchParams('local-scene=true')))
assert('loopback realm is preview', isPreviewQuery(new URLSearchParams('realm=http://127.0.0.1:8000')))
assert('custom world realm is not preview', !isPreviewQuery(new URLSearchParams('realm=worlds.example.com&worldName=x')))

console.log('')
if (failed) {
  console.error(`${failed} failed, ${passed} passed`)
  process.exit(1)
}
console.log(`${passed} passed`)
