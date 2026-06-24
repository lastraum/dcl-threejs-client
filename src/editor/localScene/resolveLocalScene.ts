import type { ContentFile, ResolvedScene, SceneMetadata, SceneSpawn } from '../../dcl/content/types'
import { BLANK_SCENE_TEMPLATE } from '../../dcl/content/types'
import { walkProjectFiles, readFileText } from './localFileSystem'

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
    lower.endsWith('.mp3') ||
    lower.endsWith('.wav') ||
    lower.endsWith('.js') ||
    lower.endsWith('.composite') ||
    lower.endsWith('.crdt') ||
    lower === 'scene.json'
  )
}

export type LocalSceneCache = {
  scene: ResolvedScene
  blobUrls: string[]
  revoke(): void
}

export async function resolveLocalScene(
  projectId: string,
  root: FileSystemDirectoryHandle
): Promise<LocalSceneCache> {
  const sceneJsonText = await readFileText(root, 'scene.json')
  if (!sceneJsonText) throw new Error('scene.json not found in project folder')

  const metadata = JSON.parse(sceneJsonText) as SceneMetadata
  const parcels = metadata.scene?.parcels ?? ['0,0']
  const baseParcel = metadata.scene?.base ?? parcels[0] ?? '0,0'
  const title = metadata.display?.title?.trim() || root.name

  const paths = await walkProjectFiles(root)
  const assetPaths = paths.filter(isSceneAssetPath)

  const entries: LocalAssetEntry[] = []
  const blobUrls: string[] = []

  for (const file of assetPaths) {
    try {
      const parts = file.split('/')
      let dir = root
      for (let i = 0; i < parts.length - 1; i++) {
        dir = await dir.getDirectoryHandle(parts[i]!)
      }
      const fh = await dir.getFileHandle(parts[parts.length - 1]!)
      const blob = await fh.getFile()
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