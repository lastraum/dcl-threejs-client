#!/usr/bin/env node
/**
 * Quick parity check for equipped wearable URN → Catalyst pointer normalization.
 * Mirrors src/avatar/constants.ts assetUrnFromCompleteUrn.
 */
function normalizeUrn(urn) {
  return urn.replace(/^dcl:\/\/base-avatars\//, 'urn:decentraland:off-chain:base-avatars:').toLowerCase()
}

function assetUrnFromCompleteUrn(completeUrn) {
  const urn = normalizeUrn(completeUrn)
  const parts = urn.split(':')
  const thirdParty = 'collections-thirdparty'

  if (urn.includes(thirdParty) && parts.length === 10) {
    return parts.slice(0, 7).join(':')
  }
  if (parts.length >= 7 && parts[3] === 'collections-v1') {
    return parts.slice(0, 6).join(':')
  }
  if (parts.length >= 7 && parts[3] === 'collections-v2') {
    return parts.slice(0, 6).join(':')
  }
  if (!urn.includes(thirdParty) && parts.length > 7) {
    return parts.slice(0, -1).join(':')
  }
  return urn
}

const cases = [
  {
    input: 'urn:decentraland:ethereum:collections-v1:community_contest:cw_monocle_eyewear:5423',
    expected: 'urn:decentraland:ethereum:collections-v1:community_contest:cw_monocle_eyewear'
  },
  {
    input: 'urn:decentraland:ethereum:collections-v1:halloween_2020:hwn_2020_cat_eyes:2419',
    expected: 'urn:decentraland:ethereum:collections-v1:halloween_2020:hwn_2020_cat_eyes'
  },
  {
    input: 'urn:decentraland:matic:collections-v2:0xabc:item:99',
    expected: 'urn:decentraland:matic:collections-v2:0xabc:item'
  },
  {
    input: 'urn:decentraland:off-chain:base-avatars:green_hoodie',
    expected: 'urn:decentraland:off-chain:base-avatars:green_hoodie'
  }
]

let failed = 0
for (const { input, expected } of cases) {
  const got = assetUrnFromCompleteUrn(input)
  if (got !== expected) {
    failed++
    console.error(`FAIL\n  input:    ${input}\n  expected: ${expected}\n  got:      ${got}`)
  } else {
    console.log(`ok ${expected}`)
  }
}

if (failed) {
  console.error(`\n${failed} case(s) failed`)
  process.exit(1)
}

console.log(`\n${cases.length} URN cases passed`)