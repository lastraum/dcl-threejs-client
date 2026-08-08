# COD fan-out — terrain biome seeds (Minecraft-like starters)

**Date:** 2026-08-08  
**Branch:** `feat/terrain-seed`  
**Bar:** AGENTS.md COD · editor/play landscape parity · no invent Explorer APIs  
**Agents:** explore (terrain editor stack) · explore (biome catalog / scatter) · plan  

**Status:** Plan only — no implementation on this fan-out.

---

## Platform law (one paragraph)

**Terrain seeds are authoring starters, not a second landscape runtime.**  
Today the product already has two layers: (1) **`environment.kind`** — client biome package (sky, water, empty-land scatter, outer props) written to `scene.json` and rebuilt via the same `buildParcelLandscape` path as play; (2) **author terrain** — sculpted height/splat/grass baked to `assets/terrain/terrain.glb` (+ sidecars) for deploy and physics. A Minecraft-like **biome seed** must **fill layer 2 (and optionally set layer 1)** from a named preset + optional numeric seed, then go through existing save/export. It must **not** invent a parallel floor system, replace parcel-hash scatter without a persisted seed field, or silently wipe sculpt without confirm + undo. Explorer only consumes the baked GLB; grass density and ThreejsClient-only env knobs stay client-local with clear UX expectations.

---

## Diagnosis — what we have vs Minecraft expectation

| Layer | Today | User expects (seed) |
|-------|--------|---------------------|
| **Biome dock** | Emoji rail → `patchEnvironment({ kind })` only | “Start as desert island” = shape + look |
| **Heightfield** | Flat sea floor until hand sculpt (1024²) | Rolling dunes / hills / shore from preset |
| **Scatter RNG** | `hash(parcel)` + `hash(base, 42)` | Optional re-roll / shareable world seed |
| **Shading** | Procedural bands independent of kind | Desert sand / forest grass presets optional |
| **Save** | Explicit Save → GLB + composite | Starter still must bake on Save |

**Key insight:** Changing biome today is **cheap JSON + landscape rebuild**. It does **not** terraform. Seeds must explicitly **write height/splat/grass buffers** (and optionally kind + shading).

---

## Vocabulary (do not collapse)

| Term | Meaning | Persist where |
|------|---------|----------------|
| **Biome kind** | Catalog package: sky/water/scatter | `scene.json` → `environment.kind` |
| **Biome preset** | Kind + optional kind-config (desert density, land color, …) | `environment.desert` / `.land` / … |
| **Height starter** | Procedural or baked fill of sculpt buffers | Draft + eventually `terrain.glb` on Save |
| **Scatter seed** | Creator-controlled RNG salt for props | *Future* `environment.scatterSeed` (not today) |
| **World seed** | Single number driving height + scatter | Product UX; map to height params + optional scatterSeed |

---

## Current hooks (implementation later)

| Concern | Entry |
|---------|--------|
| Biome UI | `TerrainSculptPanel.applyBiomeKind` → `patchEnvironment` |
| Landscape rebuild | `TerrainEditorWorkspace.rebuildClientLandscapePreview` → `buildParcelLandscape` |
| Height buffers | `EditorTerrainSystem.setHeights` / splat / grass; `TerrainSculptUndoStack` |
| Draft | `terrainEditorStore` IndexedDB |
| Save | `saveTerrainToProject` → GLB + composite entity 9001 |
| Catalog | `EnvironmentCatalog.ts` kinds: none, genesis, island, water, land, forest, desert, mountains, space |
| RNG | `SeededRandom.ts` mulberry32 + parcel hash |

---

## Ranked actions (plan agent)

| # | Priority | Action | Risk | Status |
|---|----------|--------|------|--------|
| ① | **P0** | Pure `generateTerrainStarter(templateId, seed, footprint, res)` — heights + optional splat/grass; reuse perlin/simplex/mulberry32 | Med (1024² hitch) | Plan |
| ② | **P0** | Wire apply via `TerrainSculptSession` + **full undo snapshot** + draft persist | Low–med | Plan |
| ③ | **P0** | **Confirm if sculpt dirty**; never wipe without dialog | Low | Plan |
| ④ | **P0** | **Starters UI** — card grid + seed + Re-roll + Apply; optional “Match biome backdrop” (default on) | Low | Plan |
| ⑤ | **P0** | Ship **4 templates**: Flat Land, Rolling Hills, Island, Desert Ridges | Low | Plan |
| ⑥ | **P1** | Human seed strings (`"pizza-island"` → u32); persist last template/seed in IndexedDB draft | Low | Plan |
| ⑦ | **P1** | Optional `environment.scatterSeed` for re-rollable trees (ThreejsClient-only) | Med | Plan |
| ⑧ | **P2** | Card thumbnails / worker-thread gen / masked apply | Med–high | Plan |

**Invariant:** Biome emoji dock stays backdrop-only. Starters never auto-run on biome click.

---

## Recommended first UX (Minecraft-adjacent)

```text
┌ Biomes (existing emoji rail) ─┐  environment.kind only — never wipes height
└───────────────────────────────┘

┌ Starters (new section) ───────────────────────────────────┐
│  [ Flat ] [ Hills ] [ Island ] [ Desert ]                   │
│  Seed  [ 48291     ]  [↻ Re-roll]  [Apply starter]          │
│  ☑ Match biome backdrop to template                         │
│  Hint: Replace sculpt · Undo restores · Save bakes GLB      │
└─────────────────────────────────────────────────────────────┘

Apply sequence:
  1. Dirty buffers? → Confirm (Cancel = no-op)
  2. undoStack.pushSnapshot (full heights/splat/lava/grass)
  3. generateTerrainStarter → write buffers
  4. Optional patchEnvironment({ kind }) + landscape preview
  5. Draft persist + status “Applied Hills · seed 48291”
  6. User sculpts; Save still bakes terrain.glb (unchanged)
```

**Not first:** caves/ores, auto-Save on re-roll, re-roll on biome icon, runtime world-gen in play.

---

## Height gen sketch (platform law: stay local, deterministic)

```text
heights[i] = f(seed, template, ix, iz, footprintMeters)
  — mulberry32 / hash already in landscape Utils
  — template params: baseY, amplitude, frequency, ridge, islandFalloff, clamp 0…120
  — splat: optional band by height (sand low / grass mid / rock high)
  — grass density: optional low noise on grass band only
```

Must respect `GENESIS_HEIGHTMAP_MAX_METERS` (120) and sea floor Y=0.

---

## Kill-list

- Parallel “fake floor” that is not `buildParcelLandscape` / not author GLB  
- Biome switch **auto-wiping** height without confirm  
- Claiming Explorer reads grass density or scatterSeed  
- Per-frame terrain regen in play  
- Scene-name forks (`if Mementos`)  
- Shipping multi-MB height bins without user Save path  
- Rescaling 1024² mid-session without migration plan  

---

## Pass/fail QA

| Check | Pass |
|-------|------|
| Apply Rolling Hills on empty project | Non-flat mesh; undo restores flat |
| Apply Desert starter | Kind desert + dune-ish heights; landscape preview gold |
| Same seed twice | Identical height buffer |
| Re-roll seed | Different shape; undo still works |
| Save → play | `terrain.glb` matches editor silhouette |
| Dirty sculpt → Apply | Confirm dialog; cancel no-op |
| Large multi-parcel | Gen finishes &lt; few seconds; export still works |
| Explorer deploy | Walkable mesh; no dependency on client-only grass |

---

## Suggested PR slices

1. **`docs + types`** — COD doc (this), `TerrainStarterTemplate` types, no UI  
2. **`height starters P0`** — pure functions + unit tests (seed determinism)  
3. **`Starters UI`** — dock cards + seed + confirm + undo + apply  
4. **`kind+preset bundle`** — apply also sets environment.kind / desert defaults  
5. **`scatterSeed` optional** — if product wants shareable prop layout  

---

## Agents summary

| Agent | Finding |
|-------|---------|
| Explore editor | Sculpt pipeline mature; biome ≠ height; undo/draft exist |
| Explore catalog | 9 kinds; scatter parcel-seeded; no height templates |
| Plan | P0 = template catalog + apply/confirm/seed; bake on existing Save |

---

## Related paths

- `src/editor/ui/TerrainSculptPanel.ts` — biome dock  
- `src/editor/TerrainEditorWorkspace.ts` — patch env + landscape rebuild  
- `src/editor/terrain/EditorTerrainSystem.ts` — height buffers  
- `src/dcl/landscape/EnvironmentCatalog.ts` — kinds  
- `src/dcl/landscape/Utils/SeededRandom.ts` — deterministic RNG  
