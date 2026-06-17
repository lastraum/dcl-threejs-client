#!/usr/bin/env node
/**
 * Download base avatar wearables from Catalyst into public/avatar/wearables/{slug}/
 * Run: node scripts/bundle-base-wearables.mjs
 */
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PEER = 'https://peer-ec2.decentraland.org'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT_ROOT = path.join(__dirname, '../public/avatar/wearables')

const POINTERS = [
  'urn:decentraland:off-chain:base-avatars:BaseMale',
  'urn:decentraland:off-chain:base-avatars:BaseFemale',
  'urn:decentraland:off-chain:base-avatars:eyes_00',
  'urn:decentraland:off-chain:base-avatars:eyes_01',
  'urn:decentraland:off-chain:base-avatars:eyes_02',
  'urn:decentraland:off-chain:base-avatars:eyebrows_00',
  'urn:decentraland:off-chain:base-avatars:eyebrows_01',
  'urn:decentraland:off-chain:base-avatars:eyebrows_02',
  'urn:decentraland:off-chain:base-avatars:mouth_00',
  'urn:decentraland:off-chain:base-avatars:mouth_01',
  'urn:decentraland:off-chain:base-avatars:mouth_02',
  'urn:decentraland:off-chain:base-avatars:blue_tshirt',
  'urn:decentraland:off-chain:base-avatars:green_hoodie',
  'urn:decentraland:off-chain:base-avatars:brown_pants',
  'urn:decentraland:off-chain:base-avatars:sneakers',
  'urn:decentraland:off-chain:base-avatars:short_hair',
  'urn:decentraland:off-chain:base-avatars:curly_hair',
  'urn:decentraland:off-chain:base-avatars:f_eyes_00',
  'urn:decentraland:off-chain:base-avatars:f_eyebrows_00',
  'urn:decentraland:off-chain:base-avatars:f_mouth_00',
  'urn:decentraland:off-chain:base-avatars:f_sweater',
  'urn:decentraland:off-chain:base-avatars:f_jeans',
  'urn:decentraland:off-chain:base-avatars:bun_shoes',
  'urn:decentraland:off-chain:base-avatars:standard_hair',
  'urn:decentraland:off-chain:base-avatars:f_simple_yellow_tshirt',
  'urn:decentraland:off-chain:base-avatars:f_brown_trousers',
  'urn:decentraland:off-chain:base-avatars:Espadrilles'
]

function slugFromPointer(pointer) {
  return pointer.split(':').pop()
}

async function downloadFile(hash, dest) {
  const url = `${PEER}/content/contents/${encodeURIComponent(hash)}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`download failed ${url}: ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  await writeFile(dest, buf)
}

async function bundleWearable(entity) {
  const id = entity.metadata?.id
  if (!id || !entity.metadata?.data?.representations?.length) {
    console.warn('skip entity without wearable data', id)
    return
  }

  const slug = slugFromPointer(id)
  const dir = path.join(OUT_ROOT, slug)
  await mkdir(dir, { recursive: true })

  for (const entry of entity.content) {
    const dest = path.join(dir, entry.file)
    await downloadFile(entry.hash, dest)
    console.log(`  ${slug}/${entry.file}`)
  }

  const manifest = {
    id,
    data: {
      category: entity.metadata.data.category,
      hides: entity.metadata.data.hides ?? [],
      replaces: entity.metadata.data.replaces ?? [],
      removesDefaultHiding: entity.metadata.data.removesDefaultHiding ?? [],
      tags: entity.metadata.data.tags ?? [],
      representations: entity.metadata.data.representations.map((rep) => ({
        bodyShapes: rep.bodyShapes,
        mainFile: rep.mainFile,
        contents: rep.contents.map((key) => ({ key, url: key }))
      }))
    }
  }

  await writeFile(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(`bundled ${slug}`)
}

async function main() {
  const res = await fetch(`${PEER}/content/entities/active`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pointers: POINTERS })
  })
  if (!res.ok) throw new Error(`Catalyst failed: ${res.status}`)
  const entities = await res.json()
  console.log(`Fetched ${entities.length}/${POINTERS.length} wearables`)
  for (const entity of entities) {
    await bundleWearable(entity)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
