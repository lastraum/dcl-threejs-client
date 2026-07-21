#!/usr/bin/env node
/**
 * Wearable compose-pipeline smoke test: samples real wearables from Catalyst and runs
 * them through the ACTUAL prepare/merge/fallback functions (via vite ssrLoadModule),
 * headless. Catches the class of bug where an item parses fine but never renders
 * (name-prune, unit-scale, merge/fallback failures, fallback placement).
 *
 * Run: node scripts/sweep-wearables.mjs [mode] [...]
 *   l1                              — sample classic ethereum collections-v1 sets
 *   <year>                          — sample matic collections-v2 collections of that year
 *   wallet <addr> [category] [shape] — sweep a wallet's whole inventory (paginated);
 *                                      optional category filter (e.g. lower_body) also
 *                                      pulls the base-avatars catalog for that category;
 *                                      shape = male (default) | female
 */
import { createServer } from 'vite'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PEER = 'https://peer.decentraland.org'
const MODE = process.argv[2] ?? '2021'
const WALLET = MODE === 'wallet' ? (process.argv[3] ?? '').toLowerCase() : null
const CATEGORY_FILTER = MODE === 'wallet' ? (process.argv[4] || null) : null
const SHAPE = (MODE === 'wallet' ? process.argv[5] : null) === 'female' ? 'female' : 'male'
const SHAPE_MATCH = SHAPE === 'female' ? 'basefemale' : 'basemale'
const BODY_GLB =
  SHAPE === 'female'
    ? 'public/avatar/wearables/BaseFemale/BaseFemale.glb'
    : 'public/avatar/wearables/BaseMale/BaseMale.glb'
const FETCH_POOL = 4

const L1_COLLECTIONS = [
  'halloween_2019',
  'xmas_2019',
  'mch_collection',
  'community_contest',
  'dg_summer_2020',
  'moonshot_2020',
  'wonderzone_meteorchaser',
  'atari_launch',
  'rtfkt_x_atari',
  'cybermike_cybersoldier_set',
  'ml_pekingopera',
  'release_the_kraken'
]

function stripTexturesFromJson(json) {
  delete json.images
  delete json.textures
  delete json.samplers
  for (const m of json.materials ?? []) {
    delete m.emissiveTexture
    delete m.normalTexture
    delete m.occlusionTexture
    if (m.pbrMetallicRoughness) {
      delete m.pbrMetallicRoughness.baseColorTexture
      delete m.pbrMetallicRoughness.metallicRoughnessTexture
    }
  }
  return json
}

function rebuildGlb(json, rest) {
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json))
  const pad = (4 - (jsonBytes.length % 4)) % 4
  const paddedJson = new Uint8Array(jsonBytes.length + pad).fill(0x20)
  paddedJson.set(jsonBytes)
  const out = new Uint8Array(12 + 8 + paddedJson.length + rest.length)
  const dv = new DataView(out.buffer)
  dv.setUint32(0, 0x46546c67, true)
  dv.setUint32(4, 2, true)
  dv.setUint32(8, out.length, true)
  dv.setUint32(12, paddedJson.length, true)
  dv.setUint32(16, 0x4e4f534a, true)
  out.set(paddedJson, 20)
  out.set(rest, 20 + paddedJson.length)
  return out.buffer
}

/** Strip tokenId so entities/active accepts the pointer (mirrors assetUrnFromCompleteUrn). */
function pointerForUrn(urn) {
  const u = urn.toLowerCase()
  const parts = u.split(':')
  if (u.includes('collections-thirdparty') && parts.length === 10) return parts.slice(0, 7).join(':')
  if (parts.length >= 7 && (parts[3] === 'collections-v1' || parts[3] === 'collections-v2')) {
    return parts.slice(0, 6).join(':')
  }
  if (!u.includes('collections-thirdparty') && parts.length > 7) return parts.slice(0, -1).join(':')
  return u
}

async function collectV2Pointers(year) {
  const head = await fetch(
    'https://marketplace-api.decentraland.org/v1/collections?first=1&sortBy=newest'
  ).then((r) => r.json())
  const total = head.total ?? 0
  const cols = []
  // Newest-first API: old years live at the tail — scan from the end.
  for (let skip = Math.max(0, total - 500); skip >= 0 && cols.length < 120; skip -= 500) {
    const page = await fetch(
      `https://marketplace-api.decentraland.org/v1/collections?first=500&skip=${skip}&sortBy=newest`
    ).then((r) => r.json())
    for (const c of page.data ?? []) {
      if (new Date(Number(c.createdAt)).getUTCFullYear() === year) cols.push(c)
    }
    if (skip === 0) break
  }
  const step = Math.max(1, Math.floor(cols.length / 18))
  const sample = cols.filter((_, i) => i % step === 0).slice(0, 18)
  const pointers = []
  for (const c of sample) {
    const items = await fetch(
      `https://marketplace-api.decentraland.org/v1/items?contractAddress=${c.contractAddress}&first=3`
    ).then((r) => r.json())
    const item = (items.data ?? []).find((i) => i.category === 'wearable')
    if (item) pointers.push(item.urn)
  }
  return pointers
}

async function collectL1Pointers() {
  const pointers = []
  for (const slug of L1_COLLECTIONS) {
    const id = `urn:decentraland:ethereum:collections-v1:${slug}`
    try {
      const res = await fetch(
        `${PEER}/lambdas/collections/wearables?collectionId=${encodeURIComponent(id)}`
      ).then((r) => r.json())
      for (const w of (res.wearables ?? []).filter((x) => x.data?.category).slice(0, 2)) {
        pointers.push(w.id)
      }
    } catch {
      console.log(`collection fetch failed: ${slug}`)
    }
  }
  return pointers
}

/** Full wallet inventory via lambdas (paginated — >100-item wallets lose items otherwise). */
async function collectWalletPointers(addr) {
  const rows = []
  for (let pageNum = 1; pageNum <= 50; pageNum++) {
    const res = await fetch(
      `${PEER}/lambdas/users/${addr}/wearables?pageSize=100&pageNum=${pageNum}`
    )
    if (!res.ok) break
    const raw = await res.json()
    if (Array.isArray(raw)) {
      rows.push(...raw)
      break
    }
    if (!Array.isArray(raw.elements)) break
    rows.push(...raw.elements)
    const total = typeof raw.totalAmount === 'number' ? raw.totalAmount : rows.length
    if (raw.elements.length < 100 || rows.length >= total) break
  }
  const pointers = new Set()
  for (const row of rows) {
    const urn = row.urn ?? row.definition?.id ?? row.id
    if (typeof urn === 'string' && urn.trim()) pointers.add(pointerForUrn(urn))
  }
  return [...pointers]
}

async function collectBasePointers(category) {
  const res = await fetch(
    `${PEER}/lambdas/collections/wearables?collectionId=${encodeURIComponent(
      'urn:decentraland:off-chain:base-avatars'
    )}`
  ).then((r) => r.json())
  return (res.wearables ?? [])
    .filter((w) => !category || w.data?.category === category)
    .map((w) => w.id.toLowerCase())
}

async function mapPool(items, size, fn) {
  const results = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i], i)
    }
  })
  await Promise.all(workers)
  return results
}

const server = await createServer({
  root: ROOT,
  configFile: false,
  logLevel: 'error',
  server: { middlewareMode: true },
  optimizeDeps: { noDiscovery: true, include: [] }
})

try {
  const THREE = await server.ssrLoadModule('three')
  const { GLTFLoader } = await server.ssrLoadModule('three/examples/jsm/loaders/GLTFLoader.js')
  const lw = await server.ssrLoadModule('/src/avatar/loadWearable.ts')
  const ws = await server.ssrLoadModule('/src/avatar/wearableSanitize.ts')
  const loader = new GLTFLoader()

  const bodyBuf = (await readFile(path.join(ROOT, BODY_GLB))).buffer
  const bodyJsonLen = new DataView(bodyBuf).getUint32(12, true)
  const bodyJson = stripTexturesFromJson(
    JSON.parse(new TextDecoder().decode(new Uint8Array(bodyBuf, 20, bodyJsonLen)))
  )
  const bodyRest = new Uint8Array(bodyBuf, 20 + bodyJsonLen)

  let pointers
  if (MODE === 'wallet') {
    if (!WALLET) {
      console.error('usage: node scripts/sweep-wearables.mjs wallet <address> [category] [shape]')
      process.exit(2)
    }
    pointers = await collectWalletPointers(WALLET)
    if (CATEGORY_FILTER) pointers.push(...(await collectBasePointers(CATEGORY_FILTER)))
    pointers = [...new Set(pointers)]
  } else if (MODE === 'l1') {
    pointers = await collectL1Pointers()
  } else {
    pointers = await collectV2Pointers(Number(MODE))
  }
  console.log(
    `sampling ${pointers.length} pointers (mode: ${MODE}${CATEGORY_FILTER ? `, filter: ${CATEGORY_FILTER}` : ''}, shape: ${SHAPE})\n`
  )

  const entities = []
  for (let i = 0; i < pointers.length; i += 40) {
    const chunk = pointers.slice(i, i + 40)
    const batch = await fetch(`${PEER}/content/entities/active`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pointers: chunk })
    }).then((r) => r.json())
    if (Array.isArray(batch)) entities.push(...batch)
  }

  const candidates = entities.filter(
    (ent) => !CATEGORY_FILTER || ent.metadata?.data?.category === CATEGORY_FILTER
  )
  console.log(`${entities.length} entities resolved, ${candidates.length} after category filter\n`)

  const results = await mapPool(candidates, FETCH_POOL, async (ent) => {
    const urn = ent.metadata?.id ?? '?'
    const name = ent.metadata?.name ?? urn.split(':').pop()
    const category = ent.metadata?.data?.category ?? '?'
    const hides = ent.metadata?.data?.hides ?? []
    const rep = ent.metadata?.data?.representations?.find((r) =>
      r.bodyShapes?.some((s) => s.toLowerCase().includes(SHAPE_MATCH))
    )
    if (!rep) return { name, category, verdict: `SKIP (no ${SHAPE} rep)` }
    if (rep.mainFile.endsWith('.png')) return { name, category, verdict: 'SKIP (texture-only)' }
    const contentFile = ent.content.find(
      (c) => c.file === rep.mainFile || c.file.toLowerCase() === rep.mainFile.toLowerCase()
    )
    if (!contentFile) return { name, category, verdict: 'SKIP (mainFile missing)' }

    try {
      const buf = await fetch(`${PEER}/content/contents/${contentFile.hash}`).then((r) =>
        r.arrayBuffer()
      )
      const magic = new DataView(buf).getUint32(0, true)
      let parseInput
      if (magic === 0x46546c67) {
        const jsonLen = new DataView(buf).getUint32(12, true)
        const json = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 20, jsonLen)))
        parseInput = rebuildGlb(stripTexturesFromJson(json), new Uint8Array(buf, 20 + jsonLen))
      } else {
        // JSON glTF (2021 Builder exports) — GLTFLoader.parse accepts the text directly.
        const json = JSON.parse(new TextDecoder().decode(buf))
        parseInput = JSON.stringify(stripTexturesFromJson(json))
      }

      const gltf = await loader.parseAsync(parseInput, '')
      const wear = gltf.scene
      const bodyGltf = await loader.parseAsync(rebuildGlb(structuredClone(bodyJson), bodyRest), '')
      const body = bodyGltf.scene
      const skeleton = lw.findSkeleton(body)

      const opts = { category, wearableId: urn, bodyRoot: body, hides }
      const target = new THREE.Group()
      target.add(body)
      let mode = 'merge'
      let ok
      if (category === 'feet') {
        // Mirror AvatarComposer: raw-first so foot/Hips bind weights stay valid.
        lw.pruneWearableDisplayMeshes(wear, { extentCheck: false })
        ok = lw.mergeWearableMeshes(wear, skeleton, target, opts)
        if (!ok) {
          lw.prepareWearableForCompose(wear, body, category)
          ok = lw.mergeWearableMeshes(wear, skeleton, target, opts)
        }
      } else {
        lw.prepareWearableForCompose(wear, body, category)
        ok = lw.mergeWearableMeshes(wear, skeleton, target, opts)
      }
      let placement = ''
      if (!ok) {
        ok = lw.attachWearableFallback(wear, skeleton, target, opts)
        mode = ok ? 'fallback' : 'no merge, no fallback'
        if (ok) {
          // Placement check: the statically-placed wearable must sit in its slot band.
          wear.updateWorldMatrix(true, true)
          const box = new THREE.Box3().setFromObject(wear)
          const region = ws.fallbackSlotRegion(category, hides)
          if (box.isEmpty()) {
            ok = false
            placement = ' EMPTY BOX'
          } else if (region) {
            const size = box.getSize(new THREE.Vector3())
            const center = box.getCenter(new THREE.Vector3())
            const overlaps = box.max.y >= region.min - 0.25 && box.min.y <= region.max + 0.25
            const grounded = box.min.y > -0.35
            const centered = Math.hypot(center.x, center.z) < 0.6
            const sane = Math.max(size.x, size.y, size.z) <= 3.6
            placement = ` y=[${box.min.y.toFixed(2)}..${box.max.y.toFixed(2)}]`
            if (!(overlaps && grounded && centered && sane)) {
              ok = false
              placement += ` MISPLACED vs [${region.min}..${region.max}]${centered ? '' : ' off-axis'}${sane ? '' : ' oversize'}`
            }
          }
        }
      } else {
        let extent = 0
        for (const child of target.children) {
          if (child === body) continue
          child.updateWorldMatrix(true, false)
          const box = new THREE.Box3().setFromObject(child)
          if (box.isEmpty()) continue
          const size = box.getSize(new THREE.Vector3())
          extent = Math.max(extent, size.x, size.y, size.z)
        }
        placement = extent > 0 ? ` ${extent.toFixed(2)}m` : ''
        if (extent > 3.6 || (extent > 0 && extent < 0.02)) {
          ok = false
          placement += ' BAD EXTENT'
        }
      }

      return {
        name,
        category,
        verdict: ok ? `OK (${mode}${placement})` : `FAIL (${mode}${placement})`
      }
    } catch (err) {
      return { name, category, verdict: `ERROR: ${String(err?.message ?? err).slice(0, 70)}` }
    }
  })

  console.log('--- RESULTS ---')
  for (const r of results) {
    console.log(`${r.verdict.padEnd(44)} ${r.category.padEnd(12)} ${r.name}`)
  }
  const ok = results.filter((r) => r.verdict.startsWith('OK')).length
  const fallback = results.filter((r) => r.verdict.includes('(fallback')).length
  const fail = results.filter(
    (r) => r.verdict.startsWith('FAIL') || r.verdict.startsWith('ERROR')
  ).length
  console.log(
    `\n${results.length} tested · ${ok} render (${fallback} via fallback) · ${fail} fail/error`
  )
  process.exitCode = fail > 0 ? 1 : 0
} finally {
  await server.close()
}
