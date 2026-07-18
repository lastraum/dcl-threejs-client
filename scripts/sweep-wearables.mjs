#!/usr/bin/env node
/**
 * Wearable compose-pipeline smoke test: samples real wearables from Catalyst and runs
 * them through the ACTUAL prepare/merge functions (via vite ssrLoadModule), headless.
 * Catches the class of bug where an item parses fine but never renders (name-prune,
 * unit-scale, merge/fallback failures).
 *
 * Run: node scripts/sweep-wearables.mjs [l1|2021|2022|...]
 *   l1      — sample the classic ethereum collections-v1 sets (default: 2 items each)
 *   <year>  — sample matic collections-v2 collections created that year
 */
import { createServer } from 'vite'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PEER = 'https://peer.decentraland.org'
const MODE = process.argv[2] ?? '2021'

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
  const loader = new GLTFLoader()

  const bodyBuf = (
    await readFile(path.join(ROOT, 'public/avatar/wearables/BaseMale/BaseMale.glb'))
  ).buffer
  const bodyJsonLen = new DataView(bodyBuf).getUint32(12, true)
  const bodyJson = stripTexturesFromJson(
    JSON.parse(new TextDecoder().decode(new Uint8Array(bodyBuf, 20, bodyJsonLen)))
  )
  const bodyRest = new Uint8Array(bodyBuf, 20 + bodyJsonLen)

  const pointers =
    MODE === 'l1' ? await collectL1Pointers() : await collectV2Pointers(Number(MODE))
  console.log(`sampling ${pointers.length} wearables (mode: ${MODE})\n`)

  const entities = await fetch(`${PEER}/content/entities/active`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pointers })
  }).then((r) => r.json())

  const results = []
  for (const ent of entities) {
    const urn = ent.metadata?.id ?? '?'
    const name = ent.metadata?.name ?? urn.split(':').pop()
    const category = ent.metadata?.data?.category ?? '?'
    const rep = ent.metadata?.data?.representations?.find((r) =>
      r.bodyShapes?.some((s) => s.toLowerCase().includes('basemale'))
    )
    if (!rep) {
      results.push({ name, category, verdict: 'SKIP (no BaseMale rep)' })
      continue
    }
    if (rep.mainFile.endsWith('.png')) {
      results.push({ name, category, verdict: 'SKIP (texture-only)' })
      continue
    }
    const contentFile = ent.content.find(
      (c) => c.file === rep.mainFile || c.file.toLowerCase() === rep.mainFile.toLowerCase()
    )
    if (!contentFile) {
      results.push({ name, category, verdict: 'SKIP (mainFile missing)' })
      continue
    }

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

      const opts = { category, wearableId: urn, bodyRoot: body }
      const target = new THREE.Group()
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
      if (!ok) {
        ok = lw.attachWearableFallback(wear, skeleton, target, opts)
        mode = ok ? 'fallback' : 'no merge, no fallback'
      }

      let extent = 0
      for (const child of target.children) {
        child.updateWorldMatrix(true, false)
        const box = new THREE.Box3().setFromObject(child)
        const size = new THREE.Vector3()
        box.getSize(size)
        extent = Math.max(extent, size.x, size.y, size.z)
      }

      results.push({
        name,
        category,
        verdict: ok
          ? `OK (${mode}${extent > 0 ? `, ${extent.toFixed(2)}m` : ''})`
          : `FAIL (${mode})`
      })
    } catch (err) {
      results.push({
        name,
        category,
        verdict: `ERROR: ${String(err?.message ?? err).slice(0, 70)}`
      })
    }
  }

  console.log('--- RESULTS ---')
  for (const r of results) {
    console.log(`${r.verdict.padEnd(34)} ${r.category.padEnd(12)} ${r.name}`)
  }
  const ok = results.filter((r) => r.verdict.startsWith('OK')).length
  const fail = results.filter(
    (r) => r.verdict.startsWith('FAIL') || r.verdict.startsWith('ERROR')
  ).length
  console.log(`\n${results.length} tested · ${ok} render · ${fail} fail/error`)
  process.exitCode = fail > 0 ? 1 : 0
} finally {
  await server.close()
}
