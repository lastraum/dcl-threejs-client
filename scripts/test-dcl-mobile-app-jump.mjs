/**
 * Official DCL mobile app scheme (mirrors src/client/ui/landing/dclMobileAppJump.ts).
 * Run: node scripts/test-dcl-mobile-app-jump.mjs
 */
import assert from 'node:assert/strict'

function schemeHref(route) {
  if (route.kind === 'world') {
    if (route.customServer) return null
    return `decentraland://?realm=${encodeURIComponent(route.worldName)}`
  }
  if (route.kind === 'coords') {
    return `decentraland://?position=${route.x},${route.y}`
  }
  return null
}

assert.equal(
  schemeHref({ kind: 'world', worldName: 'genesis.dcl.eth' }),
  'decentraland://?realm=genesis.dcl.eth'
)
assert.equal(
  schemeHref({ kind: 'coords', x: -16, y: 124 }),
  'decentraland://?position=-16,124'
)
assert.equal(schemeHref({ kind: 'world', worldName: 'x.dcl.eth', customServer: 'https://worlds.example' }), null)
assert.equal(schemeHref({ kind: 'localpreview', origin: 'http://127.0.0.1:8000' }), null)

console.log('ok dcl mobile app scheme urls')
