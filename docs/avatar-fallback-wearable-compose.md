# Avatar compose: broken-rig wearables and the fallback path

## SESSION OUTCOME (July 20, 2026 — work SHELVED, read this first)

Two days of iteration, ending with the fallback path unresolved. State of the tree
(uncommitted, branch feat/backpack-rarity-colors-sort, mixed with rarity-colors work):

**VERIFIED WINS (worth committing on their own):**
1. `applyBodyShapeVisibility` — hides/replaces of ATTACHED wearables honored; traversal
   skips `wearable:` subtrees (never hides a wearable's own `*_BaseMesh`-named meshes or
   resurrects its pruned junk). Fixed the original "underwear poking through outfits".
2. Profile backfill (resolveProfile/constants) — face/hair only (`BACKFILL_WEARABLE_CATEGORIES`);
   unequipping clothing shows base underwear like the official explorer. Avatar-resolve
   cache key bumped to `dcl-client-avatar-cache-v2` (old entries contain phantom backfill).
3. Category auto-hide CONFIRMED CORRECT and kept (the mid-session removal was a
   misdiagnosis): base parts are authored NARROWER than same-slot fabric (lbody x ±0.204
   vs jeans ±0.198 — measured) and MUST hide under merged same-slot wearables. Verified:
   Short Blue Jeans at parity with official on both body shapes.
4. TOON SHADER — `applyAvatarToonShading` (materials.ts): official 4-band posterize
   (t=(N·view+1)/2; >0.9→×1.2, >0.2→×1.0, else ×0.8; 0.6 albedo-mix), matte clamp
   (metalness 0, roughness ≥0.9, envMap 0) on non-emissive-boosted avatar materials,
   injected via onBeforeCompile before `opaque_fragment`. Opt-out: `?avatarnotoon`.
   This ALSO resolved the "waist gap" perception: identical geometry read as a void in
   PBR because interiors rendered near-black; official's ×0.8 floor doesn't.
5. Debug flags: `?avatarverbose` (compose logs incl. merge skip reasons + fallback
   gates + freeze diag), `?avatarbindpose` (freeze bind pose — separates pose bugs
   from compose bugs), `?avatarnotoon`.
6. `scripts/sweep-wearables.mjs` extended: `wallet <addr> [category] [male|female]`
   mode (paginated inventory + base catalog), fallback placement checks.

**UNRESOLVED — the live bake mystery (why work stopped):**
Broken-rig wearables (bone quality 0.00: Hey Shorty, Duckie, MANA, Turning Red, Budgie)
should render at AUTHORED rest pose (measured: all upright & on-body in their GLBs;
several store collapsed verts that only bone transforms expand — applyBoneTransform is
REQUIRED, pure geometry+matrixWorld is a speck for 4 of 5). The authored-placement
fallback (freeze → sanity gates → Hips-rigid skinning, in attachWearableFallback) works
PERFECTLY headless via vite ssrLoadModule — and collapses to a ~1cm speck in the live
client with byte-identical inputs. Eliminated suspects: SkeletonUtils.clone (bakes fine),
glbSanitizer (byte-identical passthrough), off-thread parse (disabled), cache prep
(prepareWearableCacheRoot — replicated headless, fine), bone STATE (live diag shows the
same bone0 name/scale/pos as node: Avatar_Hips_1, 1e-2, (0,1,0)). The final instrumented
diag (in freezeSkinnedForFallback, `?avatarverbose`) prints `abtY` (applyBoneTransform
bake) vs `manY` (manual boneWorld×boneInverse×bindMatrix bake) vs `inv0Scale` — ONE
Budgie toggle in a wallet that owns it yields the verdict:
- abtY collapsed, manY fine → live three.js SkinnedMesh.applyBoneTransform is patched
  somewhere → switch freeze to the manual math.
- both collapsed, inv0Scale sane (~1e+2) → live bone matrixWorld chain broken despite
  matching locals → bake from locals.
- inv0Scale wrong → clone boneInverses corrupted → trace the clone path.
CURRENT VISIBLE STATE: those five render INVISIBLE (gates reject the collapsed bake) —
worse than the heuristic era, which at least showed something. If shipping before this
is solved, consider relaxing the gates to attach-anyway.

**Do-not-retry list (tested, failed):**
- Merge binding with wearable-own boneInverses paired to mapped body bones: breaks the
  spring-bone→Head remap (base hair collapses to a flat cap) and did NOT fix
  authored-offset accessories. Tried twice.
- All placement heuristics for fallback (slot regions, Z-up uprighting, fabric
  inflation): superseded by authored placement; they were reconstructing data the GLB
  already has. Dead code for them still in wearableSanitize (SLOT_REGION_Y,
  alignFallbackWearableToSlot, fitWearableWorldExtent fallback usage) — delete when the
  authored path lands.

**Newly catalogued, unfixed:**
- AFK head sign (0x8a7a67c5…:0, top_head): MERGES at quality 1.0 but renders mini at
  the hips — bone names match, bind transforms don't (authored floating above Head).
  Likely wants the authored-rest treatment, i.e. blocked on the same mystery.
- Remote-avatar anomalies seen in passing (peer as placeholder capsule in one browser
  but not the other; a stale orphaned mesh after re-equip) — not investigated.

**Debug methodology that worked (reuse it):**
- Ground truth via official wearable-preview: `?urn=…&bodyShape=…&disableDefaultWearables=true`
  for single items; `?profile=0x…` for a whole deployed avatar. Screenshot and compare.
- Headless truth via vite ssrLoadModule harnesses running the REAL compose functions
  against live catalyst GLBs — measures what renders, no browser needed.
- Two-browser rig: each wallet in its own browser; Claude drives Chrome via extension;
  HMR reaches both from one dev server. Backpack toggle = recompose.
- Distrust screenshots of "fixed" until the user confirms; distrust HMR after many
  rapid edits — hard-refresh before trusting a verdict.

Field notes from debugging invisible / misplaced lower_body wearables (July 2026).
Everything here applies to **any** wearable category — if a hat, mask, or handwear
item shows the same symptoms, start from the "current architecture" section and
skip the dead ends we already burned.

## The two compose paths

Every model wearable goes through `composeFromConfig` (src/avatar/AvatarComposer.ts):

1. **Bone merge** (`mergeWearableMeshes`, src/avatar/loadWearable.ts) — the wearable's
   skinned meshes are re-bound onto the body skeleton by *bone name matching*. This is
   the good path: the wearable deforms with animation. It requires the wearable rig's
   bone names to map onto the DCL rig (`boneMapQuality` ≥ per-category threshold).
2. **Fallback attach** (`attachWearableFallback`) — when merge fails, the wearable is
   placed statically on the avatar. It cannot animate; the goal is "visible, right
   size, right place".

A wearable lands in fallback when its rig bones match nothing — e.g. "Hey Shorty"
ships meshes named `red_dress002_*` on a repurposed rig, bone quality 0.00. The
creator's export is broken; no client-side mapping can animate it.

## Symptoms we saw, and their actual causes

| Symptom | Cause |
| --- | --- |
| Base-body underwear poking through an outfit | `applyBodyShapeVisibility` ignored `hides`/`replaces` when `attachedCategories` was passed — coverage was "did a wearable of that exact category attach", so an upper_body outfit hiding lower_body left the briefs visible |
| Unequipping a slot re-dressed the avatar in default clothes | `buildComposeConfig` backfilled *all* default categories, clothing included. Explorer parity: empty clothing slot ⇒ underwear shows. Only face/hair (`BACKFILL_WEARABLE_CATEGORIES`) may be backfilled |
| Fallback wearable completely invisible, base part also hidden | Two stacked causes: (a) fallback used to parent under a body bone *inside* `bodyRoot`, and the basemesh hide rules (`*lbody_basemesh` etc.) matched the wearable's own meshes — DCL wearables reuse the `*_BaseMesh` naming; (b) the bone's ~0.01 armature world scale collapsed the wearable ~100× |
| Fallback wearable upside-down / sideways | After static-baking, meshes obey node transforms — and DCL rig bones carry ±90°/180° world rotations that skinned meshes used to silently ignore |
| Fallback wearable at the floor / under the pedestal | Every measurement-based placement strategy (bone-scale cancel, basemesh bbox anchor, skinned vertex sampling) — see dead ends below |
| Avatar exploded into scattered parts | A lower_body GLB with a built-in torso that `hides` upper_body, placed by the wrong region |

## Dead ends — do not retry these

Chronological; each seemed right and failed for a structural reason.

1. **Extend `fitWearableWorldExtent` to all categories after bone-parenting.**
   Failed: the corrective factor needed under a ~0.01-scale bone is >100, and the
   function's sanity cap rejects factors above 100. Loosening the cap is treating
   the symptom; the parent scale is the disease.
2. **Divide the wearable root's scale by the attach bone's world scale.**
   Failed: the meshes were still *skinned* at that point, and skinned rendering
   ignores node transforms entirely — verts follow the wearable's own skeleton
   bones. Scaling the root moved the measured Box3, not the pixels.
3. **Static-bake, then cancel the bone's world rotation + scale at attach.**
   Half-worked: orientation became correct (this is when the duckie flipped
   right-side-up) but position stayed wrong — the export origin vs bone origin
   offset is arbitrary per creator.
4. **Anchor against the body's basemesh bounding box (`Box3.setFromObject`).**
   Failed: the body basemeshes are SkinnedMesh — `setFromObject` returns raw
   bind-space geometry bounds (hip-origin), not the rendered legs. Everything
   aligned to a phantom region below the floor.
5. **Skinned-aware sampling (`applyBoneTransform` per-vertex × `matrixWorld`).**
   Failed empirically: on the `Avatar_*` rig at compose time this collapses to a
   ~1 cm point (bind matrices + armature scale cancel out in a way that does not
   correspond to the render). Verbose log showed `body=[0..0.01] wear=point@hips`.
   **Lesson: at compose time, do not trust any skeleton-derived measurement.**

## THE BIG FINDING (July 19, late): official renderer does NOT auto-hide base parts

Verified against the official wearable-preview with `disableDefaultWearables=true`:
equipping `f_short_blue_jeans` leaves the **entire base body rendering** — waist and
hips visible right into the shorts' waistband opening. The official renderer layers
wearables OVER the full base body and hides parts only on explicit `hides`/`replaces`
metadata (plus skin-category and hands rules). D3JS's ported "equipping a category
hides its base part" rule was too aggressive: the shorts top at y=0.982, the
upper-body hem at 1.040, and hiding `lBody_BaseMesh` deleted the only mesh covering
that band — the user-visible "gap at the waist". Fixed in bodyShape.ts
(`isHiddenByWearable` no longer treats same-category as hidden). Also measured:
bundled BaseFemale.glb, catalyst BaseFemale, and `f_short_blue_jeans` all share
byte-identical bind skeletons — rig-revision displacement is NOT a thing here.

Architectural note: the official (Babylon) preview never merges wearables onto one
skeleton — each wearable keeps its own armature, animated by bone name. Broken-rig
items therefore degrade gracefully to "renders at authored bind pose on the body".
D3JS's merge-into-one-skeleton design needs the fallback machinery below instead.

## OPEN as of end-of-session July 19

- User verdict: "closer but still unacceptable — items are not properly aligned."
  Merged wearables appear slightly displaced/shrunken relative to the body in D3JS
  vs the official preview (base legs poke through the blue jeans; avatar reads
  stockier than the official render of the same profile).
- Leading UNTESTED hypothesis: the idle/locomotion POSE displaces the skeleton from
  where the official renderer holds it, pulling apart verts weighted to different
  bones (spine-weighted hem vs hips-weighted waistband). Test with the new
  `?avatarbindpose` flag (ClientDebugLog.isAvatarBindPoseDebug — skips all
  locomotion playback, avatar holds bind pose). If bind pose aligns perfectly,
  the bug is in the animation/pose pipeline, not compose.
- Hey Shorty: now renders as worn shorts (upright fix + slot align) but sits low
  with a jagged hem. Budgie Smugglers: its baked full-torso (T-pose arms) overlays
  the avatar — tall hides-union wearables need better handling, possibly "render
  raw GLB as authored" per the official architecture note above.
- The merge path now binds with the wearable's own boneInverses/bone order
  (mapped onto body bones) instead of body boneInverses — mathematically identical
  for identical rigs; kept because it's more correct for divergent rigs. The
  legacy body-inverse path remains for unit-baked (applyUnit) feet.

## Current fallback architecture (partially verified)

> Status: duckie floaty renders correctly (waist ring + trunks); Hey Shorty
> upright but imperfect; Budgie unacceptable. Treat as work-in-progress.

All in `attachWearableFallback` + `alignFallbackWearableToSlot`
(src/avatar/loadWearable.ts, src/avatar/wearableSanitize.ts):

1. **`freezeSkinnedForFallback`** — bake every SkinnedMesh to a static Mesh at its
   rest pose (`applyBoneTransform` per vertex, drop skin attributes). The rig can
   never animate anyway (that's why we're in fallback), and static meshes make
   *measured = rendered* true for every downstream step.
2. Normalize scale at the root as before (`prepareWearableForCompose`,
   `normalizeWearableWorldScale`) — truthful now that meshes are static.
3. **Attach to the avatar root, never to a bone.** The root is identity: no
   inherited armature scale, no bone rotations, no skeleton math. Trade-off: the
   item follows the avatar's position but not hip/limb animation. Accepted — it is
   the honest ceiling for an unmappable rig.
4. **Place by fixed slot regions** (`SLOT_REGION_Y`, avatar ≈ 1.75 m, feet at y=0):
   clothing top-aligns to its region's top edge (lower_body → waist 0.95,
   upper_body → shoulders 1.5), feet bottom-align to the floor, head categories
   center at head height. XZ centers on the avatar axis.
5. **Union the regions of everything the wearable `hides`.** A lower_body item
   with a built-in torso that hides upper_body anchors against torso+legs
   combined (neck-down), not into the legs. `hides` is threaded through
   `MergeWearableOptions.hides` from the composer.

Supporting fixes elsewhere (these stay regardless of fallback strategy):

- `applyBodyShapeVisibility` (src/avatar/bodyShape.ts): coverage = hides/replaces
  of wearables that *actually attached* (`effective` set), and the traverse skips
  anything inside a `wearable:` subtree so it can never hide a wearable's own
  meshes or resurrect its pruned junk.
- `BACKFILL_WEARABLE_CATEGORIES` (src/avatar/constants.ts): face/hair only.
- Avatar-resolve cache key bumped to `dcl-client-avatar-cache-v2` because older
  entries contain phantom backfilled clothing.

## Diagnostics

Enable verbose compose logging (read at compose time, no reload needed):

- URL: `?avatarverbose` — or console: `localStorage.setItem('avatarverbose', '1')`

Then re-equip the wearable and read the `[avatar]` lines:

- `merge <cat> <urn> — mesh "X" skipped: bone quality 0.00 < 0.55` → broken rig,
  fallback incoming. Quality between ~0.3–0.55 → maybe fixable with a bone-name
  alias in `emoteBoneMap` instead.
- `merge … MERGED — geomExtent=…` → merged; if geomExtent is wildly off the slot
  size (≪0.1 or ≫3), suspect unit-scale problems, not placement.
- `<cat> fallback attach — <urn>` → took the static path.
- `fallback align <cat>: region=[…] wear=[…] delta=(…) post=[…]` → placement
  math; `post` should sit inside the region. If `wear` reads as a ~0.01-sized
  point, a skinned mesh survived the bake — that's a bug.

## Extending to another category

1. Reproduce with `avatarverbose` and confirm it's the fallback path (see above).
2. Check `SLOT_REGION_Y` has a sensible region for the category; tune there —
   do not reintroduce bone parenting or skeleton measurement.
3. If the item hides other slots, verify the union region covers what its
   geometry actually spans.
4. If many items of one collection fail merge with quality just under the
   threshold, consider a bone-name alias (like the Mixamo/spring-bone remaps in
   `emoteBoneMap`) — that upgrades them to the fully-animated merge path, which
   beats any fallback placement.
