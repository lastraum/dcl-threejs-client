/**
 * Minimal Creator Hub–compatible scene folder for Local Scenes → New scene.
 * Enough for the terrain editor (scene.json + empty main.composite).
 */
import { PARCEL_SIZE } from '../../dcl/content/types'

export type NewSceneSize = {
  /** Parcel columns on X (east). */
  cols: number
  /** Parcel rows on Z (north). */
  rows: number
}

export type NewSceneSpec = {
  title: string
  /** Folder name under Scenes root (sanitized). */
  folderName: string
  size: NewSceneSize
}

export const NEW_SCENE_COLS_MIN = 1
export const NEW_SCENE_COLS_MAX = 20
export const NEW_SCENE_ROWS_MIN = 1
export const NEW_SCENE_ROWS_MAX = 20

/** Safe folder segment for File System Access. */
export function sanitizeSceneFolderName(raw: string): string {
  const cleaned = raw
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^\.+/, '')
    .slice(0, 64)
    .trim()
  return cleaned || 'New Scene'
}

export function clampParcelSize(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min
  return Math.max(min, Math.min(max, Math.floor(n)))
}

/** Parcels for a cols×rows rectangle with base at SW 0,0. */
export function parcelsForRect(cols: number, rows: number): { base: string; parcels: string[] } {
  const c = clampParcelSize(cols, NEW_SCENE_COLS_MIN, NEW_SCENE_COLS_MAX)
  const r = clampParcelSize(rows, NEW_SCENE_ROWS_MIN, NEW_SCENE_ROWS_MAX)
  const parcels: string[] = []
  for (let z = 0; z < r; z++) {
    for (let x = 0; x < c; x++) {
      parcels.push(`${x},${z}`)
    }
  }
  return { base: '0,0', parcels }
}

/** Spawn near footprint center (scene-local meters). */
function spawnForSize(cols: number, rows: number) {
  const cx = (cols * PARCEL_SIZE) / 2
  const cz = (rows * PARCEL_SIZE) / 2
  const half = Math.min(4, PARCEL_SIZE / 4)
  return {
    name: 'spawn1',
    default: true,
    position: {
      x: [cx - half, cx + half],
      y: [0, 0],
      z: [cz - half, cz + half]
    },
    cameraTarget: { x: cx, y: 1, z: cz + 4 }
  }
}

export function buildNewSceneJson(spec: NewSceneSpec): string {
  const cols = clampParcelSize(spec.size.cols, NEW_SCENE_COLS_MIN, NEW_SCENE_COLS_MAX)
  const rows = clampParcelSize(spec.size.rows, NEW_SCENE_ROWS_MIN, NEW_SCENE_ROWS_MAX)
  const { base, parcels } = parcelsForRect(cols, rows)
  const title = spec.title.trim() || spec.folderName || 'New Scene'
  const body = {
    ecs7: true,
    runtimeVersion: '7',
    display: {
      title,
      description: `Created in ThreejsClient editor · ${cols}×${rows} parcels`,
      navmapThumbnail: 'images/scene-thumbnail.png',
      favicon: 'favicon_asset'
    },
    owner: '',
    contact: { name: '', email: '' },
    main: 'bin/index.js',
    tags: [],
    scene: { base, parcels },
    spawnPoints: [spawnForSize(cols, rows)],
    requiredPermissions: [],
    featureToggles: {
      voiceChat: 'enabled',
      portableExperiences: 'enabled',
      nearbyVoiceChat: 'enabled'
    },
    // Client landscape default — terrain sculpt / starters work well on land.
    environment: {
      kind: 'land'
    },
    skyboxConfig: {},
    source: {
      origin: 'threejs-client-editor',
      createdAt: new Date().toISOString()
    }
  }
  return `${JSON.stringify(body, null, 2)}\n`
}

/** Empty inspector composite — terrain Save merges into this later. */
export function buildEmptyMainComposite(): string {
  return `${JSON.stringify({ version: 1, components: [] }, null, 2)}\n`
}

export function buildPlaceholderPackageJson(title: string): string {
  const name = sanitizeSceneFolderName(title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'new-scene'
  return `${JSON.stringify(
    {
      name,
      version: '1.0.0',
      private: true,
      description: 'Scene created in ThreejsClient editor',
      scripts: {
        build: 'echo \"Open in Creator Hub or add SDK7 toolchain to build bin/index.js\"',
        start: 'echo \"Use ThreejsClient Local Scenes → Open for terrain editor\"'
      },
      engines: { node: '>=18' }
    },
    null,
    2
  )}\n`
}

export type NewSceneFile = { path: string; text: string }

/** Full file set written into the new scene folder. */
export function buildNewSceneFiles(spec: NewSceneSpec): NewSceneFile[] {
  return [
    { path: 'scene.json', text: buildNewSceneJson(spec) },
    { path: 'assets/scene/main.composite', text: buildEmptyMainComposite() },
    { path: 'package.json', text: buildPlaceholderPackageJson(spec.title) },
    {
      path: 'README.md',
      text:
        `# ${spec.title.trim() || spec.folderName}\n\n` +
        `Created with **ThreejsClient → Local Scenes → New scene**.\n\n` +
        `- Footprint: **${spec.size.cols}×${spec.size.rows}** parcels (base \`0,0\`)\n` +
        `- Open in Local Scenes to sculpt terrain / set biome\n` +
        `- Add SDK7 \`src\` + build for full deploy, or keep as terrain-only project\n`
    }
  ]
}
