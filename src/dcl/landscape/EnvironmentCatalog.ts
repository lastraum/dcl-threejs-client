import { EMPTY_LAND } from './Data/EmptyLandCatalog'

/** Landscape biomes — read from scene.json `environment` (URL override until scenes ship the field). */
export type LandscapeEnvironmentKind =
  | 'none'
  | 'island'
  | 'water'
  | 'space'
  | 'mountains'
  | 'desert'
  | 'land'
  | 'forest'

export type LandscapeDecorationMode = 'parcel' | 'perlin-instanced' | 'sparse' | 'none'

export type LandscapeEnvironmentProfile = {
  kind: LandscapeEnvironmentKind
  /** Ground mesh on deployed scene parcels. */
  sceneGround: string
  /** Ground mesh on padding ring (ignored when infiniteGround is on). */
  paddingGround: string
  showWater: boolean
  /** Tile one GLB across a large grid (land biome). */
  infiniteGround: boolean
  decoration: LandscapeDecorationMode
  trees: readonly string[]
  rocks: readonly string[]
  bushes: readonly string[]
  grass: readonly string[]
  /** Large props scattered on padding parcels (mountains biome). */
  backdropProps?: readonly string[]
  /** Dark void sky — hides Genesis dome tint. */
  spaceSky?: boolean
  /** Blank / authoring — no sky dome or cubemap; sun/moon/hemi lights only. */
  voidSky?: boolean
  /** Padding ring width in parcel cells around the deployed footprint. */
  borderPadding: number
  /** Circular procedural shore (island) — Genesis-style height + sand coloring. */
  circularShore?: boolean
  /** Single flat sandy-gold disc (desert) — no per-parcel sand tiles or sky gaps. */
  proceduralDesertPlane?: boolean
  /** ez-tree grass blades on empty parcels (land / forest). */
  ezTreeGrass?: boolean
  /** Full-span Water.js plane — no landscape ground (water biome). */
  openOcean?: boolean
}

const RED_GRASS = EMPTY_LAND.ground
/** Genesis City — Sand floor (16×16 m, matches parcel size). Pirates beach tile is only 10 m. */
const BEACH_SAND = 'bafkreibvm4n7sfk4fi3mo7kwm5cjkutt6fvidzmc3d6old5yjs2xo422zy'
/** Pirates — Desert sand floor. */
const DESERT_SAND = 'bafkreifnv7h7asugpejqzxx4lyrx2ubv4z3s43jcp7vallcof6y324scry'
/** Sci-fi — Spaceship Platform (dark metal deck). */
const SPACE_PLATFORM = 'bafkreiazjhmdiekcdfmgcmoch3kdbuhibpdrtygvnclxsgcto2hwbtxcla'

const MOUNTAIN_PROPS = [
  'bafkreigfdr6qxozer7wi2z2v3j7dudpvnb2syj7dgun7jyh7pzumfe5vw4',
  'bafkreig2mx3lftzq4wevwkvlpcjktenyzhtsemhd7yy4cjagmkky5yq7ju',
  'bafkreifv4sn2dj3s5qtumhy27z4wba3pnhcd6lkpcz6v6pfgeja5ddlly4'
] as const

const SANDY_ROCKS = [
  'bafkreiaspfy2m5pgdtgyviwklmpgjaifz7553nva5syd5sfl3yogyqpgxq',
  'bafkreie56x2bctcmj7demg6qfgwrxx44nx2n75hnlg6xnmno5h5bc2ccxe',
  'bafkreiepm62jouozy2v66d2qfvceth7n6g4p3jdpgcmdga53yisvvx2zoq'
] as const

export const LANDSCAPE_ENVIRONMENTS: Record<LandscapeEnvironmentKind, LandscapeEnvironmentProfile> = {
  none: {
    kind: 'none',
    sceneGround: RED_GRASS,
    paddingGround: RED_GRASS,
    showWater: false,
    infiniteGround: false,
    decoration: 'none',
    borderPadding: 0,
    voidSky: true,
    trees: [],
    rocks: [],
    bushes: [],
    grass: []
  },
  island: {
    kind: 'island',
    sceneGround: RED_GRASS,
    paddingGround: BEACH_SAND,
    showWater: true,
    infiniteGround: false,
    decoration: 'none',
    borderPadding: 1,
    circularShore: true,
    trees: [],
    rocks: [],
    bushes: [],
    grass: []
  },
  water: {
    kind: 'water',
    sceneGround: RED_GRASS,
    paddingGround: RED_GRASS,
    showWater: true,
    openOcean: true,
    infiniteGround: false,
    decoration: 'none',
    borderPadding: 0,
    trees: [],
    rocks: [],
    bushes: [],
    grass: []
  },
  land: {
    kind: 'land',
    sceneGround: RED_GRASS,
    paddingGround: RED_GRASS,
    showWater: false,
    infiniteGround: true,
    decoration: 'none',
    borderPadding: 1,
    ezTreeGrass: true,
    trees: [],
    rocks: [],
    bushes: [],
    grass: []
  },
  forest: {
    kind: 'forest',
    sceneGround: RED_GRASS,
    paddingGround: RED_GRASS,
    showWater: false,
    infiniteGround: true,
    decoration: 'parcel',
    borderPadding: 2,
    ezTreeGrass: true,
    trees: EMPTY_LAND.trees,
    rocks: EMPTY_LAND.rocks,
    bushes: EMPTY_LAND.bushes,
    grass: []
  },
  desert: {
    kind: 'desert',
    sceneGround: DESERT_SAND,
    paddingGround: DESERT_SAND,
    showWater: false,
    infiniteGround: false,
    decoration: 'sparse',
    borderPadding: 1,
    proceduralDesertPlane: true,
    trees: [],
    rocks: SANDY_ROCKS,
    bushes: [],
    grass: []
  },
  mountains: {
    kind: 'mountains',
    sceneGround: RED_GRASS,
    paddingGround: RED_GRASS,
    showWater: true,
    infiniteGround: false,
    decoration: 'parcel',
    borderPadding: 1,
    trees: [EMPTY_LAND.trees[2]!],
    rocks: EMPTY_LAND.rocks,
    bushes: EMPTY_LAND.bushes.slice(0, 1),
    grass: EMPTY_LAND.grass.slice(0, 2),
    backdropProps: MOUNTAIN_PROPS
  },
  space: {
    kind: 'space',
    sceneGround: SPACE_PLATFORM,
    paddingGround: SPACE_PLATFORM,
    showWater: false,
    infiniteGround: false,
    decoration: 'none',
    borderPadding: 1,
    trees: [],
    rocks: [],
    bushes: [],
    grass: [],
    spaceSky: true
  }
}

export function landscapeEnvironmentProfile(kind: LandscapeEnvironmentKind): LandscapeEnvironmentProfile {
  return LANDSCAPE_ENVIRONMENTS[kind]
}

/** Ocean ring — island (+ mountains) only; never land/forest/desert/space. */
export function allHashesForProfile(profile: LandscapeEnvironmentProfile): string[] {
  const set = new Set<string>([
    profile.sceneGround,
    profile.paddingGround,
    ...profile.trees,
    ...profile.rocks,
    ...profile.bushes,
    ...profile.grass,
    ...(profile.backdropProps ?? [])
  ])
  return [...set]
}