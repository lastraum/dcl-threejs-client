# World Environment — Parcel Block, Grass, Trees

How to reproduce the default Decentraland "blank scene" look (red grass parcel, cliffs, bushes, stylized trees) in the Three.js client **without** sand, water, or clouds.

---

## Where this comes from (important)

| Layer | Source | Example in RickRoll screenshot |
|-------|--------|--------------------------------|
| **Scene content** | Deployed entity (`bin/scene.js`) | Color cubes, blue plane, scene logic |
| **Client landscape** | Explorer / Unity client | Red grass block, cliff sides, trees, small bushes |

Landscape is **not** downloaded with the world deployment. Explorer adds it when **Landscape Terrain Enabled** is on (Creator Hub preview default).

Your Three.js client must implement its own **`ParcelLandscape`** system — render this **before** scene entities, on a separate layer/group.

---

## Scene coordinate system

**The SW corner of the scene is always `(0, 0, 0)` in scene space.**

| Axis | Direction |
|------|-----------|
| **Origin** | SW corner of `scene.base` parcel |
| **+X** | East (parcel map **x** increases) |
| **+Y** | Up |
| **+Z** | North (parcel map **y** increases) |
| **Parcel** | 16 m × 16 m; parcel `(px, py)` SW at `((px - baseX) × 16, 0, (py - baseY) × 16)` |

Spawn points, `Transform` positions, and colliders from SDK7 scenes are already expressed in this space — the Three.js bridge must not re-center or offset them.

---

## Landscape padding ring

Empty land is rendered for:

1. **Every deployed scene parcel** (`scene.json` → `scene.parcels`)
2. **A one-parcel-wide border** around the full scene footprint (corners included)

This matches Explorer’s “landscape terrain around the scene.” Padding parcels get the same `ground.glb` + trees/bushes but **no scene script entities**.

### Phase 0 test: 1×1 scene

| Role | Parcels (map coords) | Count |
|------|----------------------|-------|
| Scene | `0,0` | 1 |
| Padding ring | all cells in `[-1..1] × [-1..1]` except already counted | 8 |
| **Total landscape** | 3×3 grid | **9** |

Multi-parcel scenes: compute axis-aligned bounds of `scene.parcels`, expand by 1 in every direction, fill with empty land.

**Code:** `src/dcl/landscape/Utils/ParcelGrid.ts` → `landscapeParcelKeys()`.

### Procedural decoration

Mirrors Unity Explorer: trees from baked parcel data (`TreeData.cs` / `WorldsTrees.bin`), grass from `RenderGroundSystem` + `GrassIndirectRenderer`. We use **parcel-seeded glTF scatter**:

| Role | Trees | Bushes | Rocks | Grass |
|------|-------|--------|-------|-------|
| **scene** (deploy footprint) | none | none | none | none — ground only |
| **padding** (empty ring) | 0–1 | 3–6 | 0–2 | 8–14 |

Implementation: `src/dcl/landscape/ParcelDecorator.ts`

---

## Official assets: `@dcl/asset-packs` → category `"empty land"`

These are the same glTFs Explorer uses for default parcel dressing. Hashes from `catalog.json` (v2.15.x); fetch via Catalyst:

```
https://peer.decentraland.org/content/contents/{hash}
```

### Parcel block (grass + cliff mesh)

| Asset | Catalog name | File | IPFS hash |
|-------|--------------|------|-----------|
| **Ground** | Red Grass - Empty Land | `ground.glb` | `bafybeic34wsg4l2h7qioxndv7zlspscrinewlxqodvumx75bfrf3vvk3jq` |

- Single 16×16 m parcel tile: red/orange grass top + rocky cliff sides
- Place **one instance per landscape parcel** (scene footprint + padding ring — see above)
- Parcel SW corner at world `((px - baseX) × 16, 0, (py - baseY) × 16)`; scene origin remains base SW at `(0, 0, 0)`
- `ground.glb` is authored centered on the origin (±8 m) — offset by `(8, 0, 8)` inside each parcel group so it aligns with SDK7 0–16 bounds

### Trees (3 variants)

| Catalog name | File | Hash |
|--------------|------|------|
| Tree - Empty Land 1 | `tree01.glb` | `bafybeibpse7zmzxuge2l4vk3udmjyu6mzhvm62vmbjby65b6nlxg2v346y` |
| Tree - Empty Land 2 | `tree02.glb` | `bafybeied5cx6vw6p7okstzk5d7fp7kpfujb2lfugte33l6euejajsiydo4` |
| Tree - Empty Land 3 | `tree03.glb` | `bafybeig4v6vn4fdq62ri6ng5e3rd4m7pg4opicwr253t7hmsxxitepyb4y` |

Pink / green / yellow stylized canopies — match Explorer's look.

### Bushes (scatter on grass)

| Catalog name | File | Hash |
|--------------|------|------|
| Bush - Empty Land 1 | `bush01.glb` | `bafybeif42vn5j7cw2q26wirrbe5lbgsv566yrjnuvf4gnn6f5wtv6zc62q` |
| Bush - Empty Land 2 | `bush02.glb` | `bafybeiglwq7pipd2irqowprk7eiiptieavuiejsa5ptaxwdxowubt2d3ju` |

### Grass scatter (empty parcels)

Explorer renders grass via `GrassIndirectRenderer` (GPU instancing). Our MVP uses small glTF clumps:

| Asset | File | Hash |
|-------|------|------|
| Grass clump | `Grass_01.glb` | `bafkreieufo3sbrampmvyhpwdsu546exejvc4xbdyxzglb6okt77ebtqxfa` |
| Grass patch S | `GrassPatchSmall_04.glb` | `bafkreihx2kcslbpasprkgqgmzhajfghsfnmxutnzctiwlji6ab7uyowbf4` |
| Grass patch S | `GrassPatchSmall_05.glb` | `bafkreihegdfhklvbchr2cbpfkpyq2gwm42oegysdd25fqa7uke4x7vpvnu` |
| Grass module 1M | `Grass_Module_1M.glb` | `bafkreifask5jhld5lxtdljy3xsfqlgrhm2gjkleshawbmzgmwns46m6is4` |

Placed randomly on **padding parcels only**; the scene footprint stays clear for deployed content.

### Rocks (padding decoration)

| Catalog name | File | Hash |
|--------------|------|------|
| Rock - Empty Land 1 | `rock01.glb` | `bafybeib6qtdlzenxu3ybnu46jertsgrd73evip3rsmdfrxvjdrly5qbqhu` |
| Rock - Empty Land 2 | `rock02.glb` | `bafybeifg5x73vjufjrcy5ua5v7mxmcweefwteorboulj2njftgritdsysy` |
| Rock - Empty Land 3 | `rock03.glb` | see catalog |

---

## Implementation steps for Three.js client

### Step 1 — `EmptyLandAssetRegistry`

```ts
export const EMPTY_LAND = {
  ground: 'bafybeic34wsg4l2h7qioxndv7zlspscrinewlxqodvumx75bfrf3vvk3jq',
  trees: [
    'bafybeibpse7zmzxuge2l4vk3udmjyu6mzhvm62vmbjby65b6nlxg2v346y',
    'bafybeied5cx6vw6p7okstzk5d7fp7kpfujb2lfugte33l6euejajsiydo4',
    'bafybeig4v6vn4fdq62ri6ng5e3rd4m7pg4opicwr253t7hmsxxitepyb4y',
  ],
  bushes: [/* ... */],
  rocks: [/* ... */],
  grass: [/* Grass_01, GrassPatchSmall, Grass_Module_1M */],
} as const

export function catalystAssetUrl(hash: string) {
  return `https://peer.decentraland.org/content/contents/${hash}`
}
```

Preload all hashes once at boot; cache in `assetCache`.

### Step 2 — `buildParcelLandscape(parcels, baseParcel)`

1. `landscapeParcelKeys(scene.parcels, 1)` → scene cells + 1-parcel padding ring
2. For each key `"x,y"`, parse coords and place parcel SW at `((x - baseX) × 16, 0, (y - baseY) × 16)`
3. Clone cached `ground.glb` → add to `landscapeGroup`
4. Run placement RNG for trees + bushes in local `[0..16]` space

**Render order:** `landscapeGroup` → `sceneGroup` (scene entities on top).

### Step 3 — Deterministic decoration placement

Explorer uses **parcel-coordinate-seeded** pseudo-random placement so the same parcel always gets the same trees. Approximate algorithm:

```ts
function seededRandom(seed: number) {
  // mulberry32 or similar
  return () => { /* ... */ }
}

function decorateParcel(parcelX: number, parcelY: number, root: THREE.Group) {
  const rng = seededRandom(hashCoords(parcelX, parcelY))
  const treeCount = 2 + Math.floor(rng() * 2)   // 2–3 trees
  const bushCount = 4 + Math.floor(rng() * 6)   // 4–9 bushes

  for (let i = 0; i < treeCount; i++) {
    const treeIdx = Math.floor(rng() * 3)
    const lx = 2 + rng() * 12   // stay inside parcel, away from cliff edge
    const lz = 2 + rng() * 12
    placeClone(EMPTY_LAND.trees[treeIdx], root, lx, 0, lz, rng() * Math.PI * 2)
  }
  // bushes similarly, smaller scale, use InstancedMesh for perf
}
```

Tune counts/positions by comparing side-by-side with Explorer at the same world.

**Phase 0 shortcut:** Fixed layout (corners + center) — ship faster, refine RNG in Phase 1.

### Step 4 — Worlds vs Genesis

| Context | Parcels source | Landscape scope |
|---------|----------------|-----------------|
| **World** (MVP) | `metadata.scene.parcels` + **1-parcel padding ring** | Scene bbox expanded by 1 (Phase 0 test: 1×1 → 3×3) |
| **Genesis open world** (later) | Grid around player | Load/unload radius; same assets per empty parcel |

For Worlds, you only need parcels defined in the deployed scene — not infinite genesis grid.

### Step 5 — What to skip (for now)

| Feature | Defer to |
|---------|----------|
| Ocean / water plane | Phase 6 |
| Distant sand beach | Phase 6 |
| Clouds / skybox extras | Phase 6 (simple gradient sky is enough for MVP) |
| Street tiles between parcels | Genesis Phase 6 |

---

## Alternative: bundle assets locally

Vendor the 6–8 glTFs into `public/assets/empty-land/` to avoid Catalyst dependency at dev time. Hashes stay stable; re-verify on `@dcl/asset-packs` upgrades.

---

## Alternative: simplified procedural fallback

If glTF load fails or for ultra-light preview:

Real `@dcl/asset-packs` glTFs are loaded via Catalyst (see asset table above). Phase 0 uses `ground.glb`, empty-land trees/bushes/rocks, and grass patch glTFs — no placeholder geometry.

---

## Verification checklist

Side-by-side with Explorer at same world (e.g. RickRoll @ `0,-2`):

- [x] SW corner of base parcel is world origin `(0, 0, 0)`
- [x] 1×1 test shows 3×3 landscape (1 scene + 8 padding parcels)
- [x] Grass color / cliff silhouette matches `ground.glb`
- [x] Sparse coral/pink trees on padding parcels (0–1 each)
- [x] Small bushes scattered on padding surface
- [ ] Scene entities render **above** landscape, not z-fighting at y=0 (Phase 1)
- [x] No water/sand visible (intentionally omitted)

Progress log: [`PROGRESS.md`](./PROGRESS.md)

---

## npm dependency option

```bash
npm install @dcl/asset-packs
```

Import `catalog.json`, filter `category === "empty land"`, build hash map programmatically — stays in sync with Creator Hub asset IDs.
