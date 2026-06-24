import type { ContentFile, ResolvedScene, SceneMetadata, SceneSpawn } from '../../dcl/content/types'
import { layoutFromSceneMetadata } from '../../dcl/content/sceneLayout'
import { BLANK_SCENE_TEMPLATE } from '../../dcl/content/types'
import { walkProjectFiles, readFileText, readFileBytes } from './localFileSystem'
import type { ProjectRoot } from './projectRoot'
import { projectRootLabel } from './projectRoot'

const LOCAL_PREFIX = 'local://'

type LocalAssetEntry = {
  file: string
  blobUrl: string
}

function pickSpawn(metadata: SceneMetadata): SceneSpawn {
  const points = metadata.spawnPoints ?? []
  const def = points.find((p) => p.default) ?? points[0]
  if (!def) return { x: 8, y: 0, z: 8 }
  const pos = def.position
  const px = Array.isArray(pos.x) ? pos.x[0]! : pos.x
  const py = Array.isArray(pos.y) ? pos.y[0]! : pos.y
  const pz = Array.isArray(pos.z) ? pos.z[0]! : pos.z
  const spawn: SceneSpawn = { x: Number(px) || 8, y: Number(py) || 0, z: Number(pz) || 8 }
  if (def.cameraTarget) spawn.cameraTarget = def.cameraTarget
  return spawn
}

function isSceneAssetPath(path: string): boolean {
  const lower = path.toLowerCase()
  return (
    lower.endsWith('.glb') ||
    lower.endsWith('.gltf') ||
    lower.endsWith('.png') ||
    lower.endsWith('.jpg') ||
    lower.endsWith('.jpeg') ||
    lower.endsWith('.webp') ||
    lower.endsWith('.ktx2') ||
    lower.endsWith('.mp3') ||
    lower.endsWith('.wav') ||
    lower.endsWith('.js') ||
    lower.endsWith('.composite') ||
    lower.endsWith('.crdt') ||
    lower === 'scene.json'
  )
}

function mimeForAssetPath(path: string): string {
  const lower = path.toLowerCase()
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  if (lower.endsWith('.webp')) return 'image/webp'
  if (lower.endsWith('.mp3')) return 'audio/mpeg'
  if (lower.endsWith('.wav')) return 'audio/wav'
  if (lower.endsWith('.glb')) return 'model/gltf-binary'
  if (lower.endsWith('.gltf')) return 'model/gltf+json'
  return 'application/octet-stream'
}

export type LocalSceneCache = {
  scene: ResolvedScene
  blobUrls: string[]
  revoke(): void
}

export async function resolveLocalScene(projectId: string, root: ProjectRoot): Promise<LocalSceneCache> {
  const sceneJsonText = await readFileText(root, 'scene.json')
  if (!sceneJsonText) throw new Error('scene.json not found in project folder')

  const metadata = JSON.parse(sceneJsonText) as SceneMetadata
  const { parcels, base: baseParcel } = layoutFromSceneMetadata(metadata)
  const title = metadata.display?.title?.trim() || projectRootLabel(root)

  const paths = await walkProjectFiles(root)
  const assetPaths = paths.filter(isSceneAssetPath)

  const entries: LocalAssetEntry[] = []
  const blobUrls: string[] = []

  for (const file of assetPaths) {
    try {
      const bytes = await readFileBytes(root, file)
      if (!bytes) continue
      const copy = new Uint8Array(bytes.byteLength)
      copy.set(bytes)
      const blob = new Blob([copy], { type: mimeForAssetPath(file) })
      const url = URL.createObjectURL(blob)
      blobUrls.push(url)
      entries.push({ file, blobUrl: url })
    } catch {
      /* skip unreadable */
    }
  }

  const urlByFile = new Map(entries.map((e) => [e.file, e.blobUrl]))
  const content: ContentFile[] = entries.map((e) => ({
    file: e.file,
    hash: `${LOCAL_PREFIX}${e.file}`
  }))

  const mainEntry =
    metadata.main ??
    (content.find((c) => c.file === 'bin/scene.js')?.file ??
      content.find((c) => c.file === 'bin/index.js')?.file ??
      null)

  const assetUrl = (hash: string): string => {
    if (!hash.startsWith(LOCAL_PREFIX)) return hash
    const file = hash.slice(LOCAL_PREFIX.length)
    return urlByFile.get(file) ?? hash
  }

  const scene: ResolvedScene = {
    ...BLANK_SCENE_TEMPLATE,
    title,
    parcels,
    baseParcel,
    spawn: pickSpawn(metadata),
    metadata: { ...metadata, environment: 'none' },
    landscapeEnvironment: 'none',
    skyLighting: { disableSun: false, disableMoon: false },
    content,
    contentsBaseUrl: 'local://project',
    assetUrl,
    source: { kind: 'local', projectId },
    entityId: `local-${projectId}`,
    mainEntry,
    commsPointer: baseParcel
  }

  return {
    scene,
    blobUrls,
    revoke: () => {
      for (const url of blobUrls) URL.revokeObjectURL(url)
    }
  }
}