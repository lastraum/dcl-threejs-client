# Loot Pack 3D (img2threejs track)

Reference: `public/media/lootbag/lootpack.png`

## What was generated

| Path | Purpose |
| --- | --- |
| `src/lootBag/three/createLootPackModel.ts` | Production factory + claim animation API |
| `dev/lootpack-3d/assessment.json` | Visual pre-spec from the reference |
| `dev/lootpack-3d/preview.html` | Standalone orbit + claim preview |
| `dev/lootpack-3d/intake/` | img2threejs admission / detail-zone scaffolds |

## Preview

**Do not open** `http://localhost:5179/` — that is the full client `index.html`, which loads `src/main.ts`. Static servers often serve `.ts` as `video/mp2t` (MPEG-TS), so the browser rejects it with a MIME error.

Use the **preview page only**:

```bash
# from repo root
npx --yes serve . -p 5179
# exact URL:
open http://localhost:5179/dev/lootpack-3d/preview.html
```

Or one-shot:

```bash
npx --yes serve . -p 5179 -n
# then visit: http://localhost:5179/dev/lootpack-3d/preview.html
```

The preview is a standalone HTML file (Three via CDN + inline factory). Favicon 404s on that server are harmless.

Buttons:

- **Play claim** — tear top seal → pack falls (mirrors current 2D canvas timings)
- **Reset sealed** — idle pose + bob

## Wire into Loot Bag claim

Today `LootBagView.playPackTearAnimation()` draws the PNG on a 2D canvas. Swap path:

1. Mount a small WebGL canvas in the pack stage (or replace `data-pack-canvas`).
2. `const pack = await createLootPackModelAsync({ scale: 1 })`
3. On claim: `await playLootPackClaimAnimation(pack)` instead of the 2D tear.
4. Keep prize DOM under the stage; hide pack root when `phase === 'revealed'`.

Runtime surface:

```ts
const rt = pack.userData.sculptRuntime
rt.animation.openTear(t)   // 0..1
rt.animation.fallAway(t)   // 0..1
rt.animation.idleTick(t)
rt.sockets.tearPivot
rt.sockets.fallRoot
```

## Honesty / limits

- Single front view: back is mirrored foil, no rear graphic.
- Soft pillow volume is approximate (not cloth sim).
- Logo is procedural geometry matching the mark; optional photo map can go on `bodyFront` via `createLootPackModelAsync`.
- Full img2threejs multi-pass Divine Eye loop not closed yet (no browser screenshot gate). Geometry + claim API are ready for product integration.
