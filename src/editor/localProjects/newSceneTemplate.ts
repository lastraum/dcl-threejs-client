/**
 * Creator Hub–compatible SDK7 scene folder for Local Scenes → New scene.
 * Same starter layout as sdk-commands / Creator Hub: scene.json, package.json,
 * tsconfig.json, src/index.ts (export function main), assets/scene/main.composite.
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

/** UI default max for New scene dialog (editor-friendly). */
export const NEW_SCENE_COLS_MIN = 1
export const NEW_SCENE_COLS_MAX = 20
export const NEW_SCENE_ROWS_MIN = 1
export const NEW_SCENE_ROWS_MAX = 20

/**
 * Absolute max parcels on one axis (Genesis-scale grid ~300 wide).
 * Over this we clamp; full-span axes use SW origin -150 (see parcelsForRect).
 */
export const NEW_SCENE_AXIS_HARD_MAX = 300
/** SW parcel of a full 300-wide Genesis-style span (−150 … +149). */
export const NEW_SCENE_GENESIS_SW = -150

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

export type ParcelRectLayout = {
  /** Always the SW-most parcel of the rect (scene.json `scene.base`). */
  base: string
  baseX: number
  baseZ: number
  cols: number
  rows: number
  parcels: string[]
}

/**
 * Build a cols×rows parcel rectangle.
 *
 * Platform law:
 * - **base is always the SW-most parcel** of the set.
 * - Prefer origin **(0,0)** expanding east/north.
 * - **Hard max 300** on either axis (clamp).
 * - If an axis would exceed that span from 0 (size &gt; 300 before clamp, or
 *   full-width 300), that axis’s SW is **−150** so the range is −150…+149
 *   (300 parcels), matching Genesis-style map extent.
 */
export function parcelsForRect(cols: number, rows: number): ParcelRectLayout {
  const rawC = Number.isFinite(cols) ? Math.floor(cols) : 1
  const rawR = Number.isFinite(rows) ? Math.floor(rows) : 1
  const c = clampParcelSize(rawC, 1, NEW_SCENE_AXIS_HARD_MAX)
  const r = clampParcelSize(rawR, 1, NEW_SCENE_AXIS_HARD_MAX)

  // Over 300 on an axis → clamp + Genesis SW on that axis. Full 300-wide also uses −150.
  const baseX = rawC > NEW_SCENE_AXIS_HARD_MAX || c >= NEW_SCENE_AXIS_HARD_MAX ? NEW_SCENE_GENESIS_SW : 0
  const baseZ = rawR > NEW_SCENE_AXIS_HARD_MAX || r >= NEW_SCENE_AXIS_HARD_MAX ? NEW_SCENE_GENESIS_SW : 0

  const parcels: string[] = []
  for (let z = 0; z < r; z++) {
    for (let x = 0; x < c; x++) {
      parcels.push(`${baseX + x},${baseZ + z}`)
    }
  }
  return {
    base: `${baseX},${baseZ}`,
    baseX,
    baseZ,
    cols: c,
    rows: r,
    parcels
  }
}

/** Spawn near footprint center in **scene-local** meters (base SW = 0,0 in local space). */
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
  const layout = parcelsForRect(spec.size.cols, spec.size.rows)
  const { base, parcels, cols, rows, baseX, baseZ } = layout
  const title = spec.title.trim() || spec.folderName || 'New Scene'
  const body = {
    ecs7: true,
    runtimeVersion: '7',
    display: {
      title,
      description: `Created in ThreejsClient editor · ${cols}×${rows} parcels · base ${base} (SW)`,
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
      createdAt: new Date().toISOString(),
      layout: {
        baseSW: base,
        baseX,
        baseZ,
        cols,
        rows,
        maxAxis: NEW_SCENE_AXIS_HARD_MAX,
        genesisSW: NEW_SCENE_GENESIS_SW
      }
    }
  }
  return `${JSON.stringify(body, null, 2)}\n`
}

/** Empty inspector composite — terrain Save merges into this later. */
export function buildEmptyMainComposite(): string {
  return `${JSON.stringify({ version: 1, components: [] }, null, 2)}\n`
}

export function buildPackageJson(title: string): string {
  const name = sanitizeSceneFolderName(title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'new-scene'
  return `${JSON.stringify(
    {
      name,
      version: '1.0.0',
      description: 'SDK7 scene created in ThreejsClient editor',
      scripts: {
        start: 'sdk-commands start',
        deploy: 'sdk-commands deploy',
        build: 'sdk-commands build',
        'upgrade-sdk': 'npm install --save-dev @dcl/sdk@latest',
        'upgrade-sdk:next': 'npm install --save-dev @dcl/sdk@next'
      },
      devDependencies: {
        '@dcl/js-runtime': 'latest',
        '@dcl/sdk': 'latest'
      },
      engines: {
        node: '>=16.0.0',
        npm: '>=6.0.0'
      }
    },
    null,
    2
  )}\n`
}

/** Matches Creator Hub / sdk7-scene-template — sdk-commands compiles src → bin/index.js. */
export function buildTsconfigJson(): string {
  return `${JSON.stringify(
    {
      compilerOptions: {
        allowJs: true,
        strict: true,
        skipLibCheck: true,
        resolveJsonModule: true,
        baseUrl: '.',
        paths: {
          '@dcl/asset-packs/*': ['node_modules/@dcl/inspector/node_modules/@dcl/asset-packs/*']
        }
      },
      include: ['src/**/*.ts', 'src/**/*.tsx', 'assets/**/*.ts', 'assets/**/*.tsx'],
      extends: '@dcl/sdk/types/tsconfig.ecs7.json'
    },
    null,
    2
  )}\n`
}

/**
 * SDK7 entry. Creator Hub / sdk-commands always compile `src/index.ts`.
 * Load-time entities stay in assets/scene/main.composite — main() is runtime logic.
 */
export function buildIndexTs(): string {
  return (
    `// Empty imports so editor auto-complete works as expected.\n` +
    `import {} from '@dcl/sdk/math'\n` +
    `import {} from '@dcl/sdk/ecs'\n` +
    `\n` +
    `export function main() {\n` +
    `  // Composite / editor entities are loaded. Add runtime logic here.\n` +
    `}\n`
  )
}

/** Standard SDK7 deploy ignore list (sdk7-scene-template). */
export function buildDclIgnore(): string {
  return [
    '.*',
    'bin/*.map',
    'package-lock.json',
    'yarn-lock.json',
    'build.json',
    'export',
    'tsconfig.json',
    'tslint.json',
    'node_modules',
    '*.ts',
    '*.tsx',
    '.vscode',
    'Dockerfile',
    'dist',
    'README.md',
    '*.blend',
    '*.fbx',
    '*.zip',
    '*.rar',
    '*.md',
    'src',
    ''
  ].join('\n')
}

export type NewSceneFile = { path: string; text: string }

/** Full file set written into the new scene folder. */
export function buildNewSceneFiles(spec: NewSceneSpec): NewSceneFile[] {
  return [
    { path: 'scene.json', text: buildNewSceneJson(spec) },
    { path: 'assets/scene/main.composite', text: buildEmptyMainComposite() },
    { path: 'package.json', text: buildPackageJson(spec.title) },
    { path: 'tsconfig.json', text: buildTsconfigJson() },
    { path: 'src/index.ts', text: buildIndexTs() },
    { path: '.dclignore', text: buildDclIgnore() },
    {
      path: 'README.md',
      text:
        `# ${spec.title.trim() || spec.folderName}\n\n` +
        `Created with **ThreejsClient → Local Scenes → New scene**.\n\n` +
        `- Footprint: **${spec.size.cols}×${spec.size.rows}** parcels (base \`0,0\`)\n` +
        `- Open in Local Scenes to sculpt terrain / set biome\n` +
        `- Scene code: \`src/index.ts\` (\`export function main()\`) — \`npm i && npm run build\`\n`
    }
  ]
}
