# Scene UI pointer — remaining work (RickRoll / camera-operator)

**Branch:** `lastraum`  
**Status:** sceneUi inject PET_UP always → PlayerEntity (2026-07-15) — retest CREATOR MODE.  
**Scene bundle:** do not modify `camera-operator/scene` — client-only fixes.

## Goal

Match Decentraland Explorer behavior in ThreejsClient for RickRoll (`rickroll.dcl.eth`):

1. Click cam launcher (entity ~562) → home modal opens and stays open — **works**
2. Click **CREATOR MODE** card → `creatorScenePresetsOpen` overlay mounts; menu must **not** collapse — **still broken**
3. No bandaid heuristics; follow `.cursor/rules/worker-input-architecture.mdc`

## Observed failure (latest logs)

After modal open (`mount≈23`, `interactiveDom≈6`):

- Click resolves to **entity 574** (`ui down → entity 574`)
- Pointer deliver completes (no hang): `PET_DOWN` / `PET_UP` on 574
- Phase-4 worker snapshot: `mount=4`, `rows=8`, `PointerEvents=1`
- Main: `UITransformRelease — 19 recycled (23 → 4)` — menu gone, presets never paint
- **No** `→ sending room message preset.list` on the failing click (creator card handler did not run on worker)

When handler *does* run (other sessions), `preset.list` appears but mount still shrinks to launcher-only.

## Architecture in place (this commit)

Pointer interactive tick (`runSceneEnginePointerTick`):

1. `inject PET_DOWN` → `engine.update(0)`
2. `scene.exports.onUpdate(0)` (SDK `onUpdate` runs another `engine.update(0)`)
3. `inject PET_UP` → `engine.update(0)`
4. Extra `engine.update(0)` — react-ecs flush before snapshot
5. `runPointerUiPhase4Egress` → `collectWorkerUiMountSnapshot` (sole UI egress)

Other rules enforced:

- Ui CRDT stripped from cooperative ticks and pointer phases 1–3
- `flushPointerDeferredOutboundsAsync` awaits `crdt-outbound-ack` before `pointer-deliver-done`
- Structured mount snapshot applied on main via `applyWorkerUiMountSnapshot`
- DOM-only hit test; `pointer-events: auto` only for BLOCK / PointerEvents / UiInput / UiDropdown

## Z-ordered pick (2026-07-07 — architectural fix)

**Model:** Scene UI is always above 3D pointer raycasts. At `(clientX, clientY)`:

1. Collect candidates from **hit map** (ECS depth + `zIndex`, deepest first) then DOM `elementsFromPoint`.
2. Walk candidates in stack order. For each layer:
   - `findUiPointerHandlerEntity` (parent walk) → deliver click to that handler only.
   - Else if `pointerFilter: BLOCK` or `onMouseDown`/`onMouseUp` → **stop** (block raycast; do not fall through to scrim/scene).
3. `pickUiRegionHit` uses the same topmost blocking layer to suppress 3D raycasts.

**Removed:** `filterPickRegions` (nested-dialog + header-band heuristics), `hasDirectUiPointerHandler`-only pick (skipped BLOCK parents and fell through to modal scrim `onMouseDown`).

**Retained:** Single-entity UI inject (`writeResult` → `[targetEntity]`), phase-4 mount snapshot egress, `pointerEventsLookup` snapshot fallback.

| Area | Role |
|------|------|
| `SceneUiBridge.collectPickCandidates` | Hit map depth/zIndex + DOM |
| `SceneUiBridge.resolveUiHandlerAtPoint` | Handler walk + BLOCK stop |
| `uiPointer.isUiEntityBlocking` | BLOCK / onPointerDown/Up with snapshot lookup |
| `PointerEventsSystem.writeResult` | UI inject targets = `[targetEntity]` only |

## Open hypotheses (prioritized)

### 1. Wrong pick target (574 is not the CREATOR card handler on worker)

Entity ids are dynamic. In home modal layout, 574 may be a BLOCK panel shell, not the card with `onMouseDown`. Main projection/snapshot may attribute `PointerEvents` to 574 while worker 574 has no react-ecs handler.

**Verify:** `?sceneuidebug` at modal open — log which entities have `PointerEvents` in snapshot vs `interactiveDom`. On Creator click, log `pickDomEntity` candidates at `(clientX, clientY)`.

### 2. Scrim / ancestor handler still fires on worker

Even with single-entity inject on main, worker `getClick` may still process other `PointerEventsResult` rows if CRDT append path is active, or if inject payload still carries multiple entities in some code paths.

**Verify:** Worker log inject body: `entity`, `downEntities`, `upEntities`. Confirm length is 1 for UI clicks.

### 3. react-ecs / system order — state changes after phase-4 snapshot

Creator card sets `creatorScenePresetsOpen=true` on PET_DOWN, but `CreatorScenePresetsOverlay` may not mount until a later react-ecs pass. Extra pre-phase-4 update was added; still insufficient in testing.

**Verify:** Worker log after DOWN inject (before phase 4): `getEntitiesWith(UiTransform).length` or temporary log of `state.creatorScenePresetsOpen` if a debug hook is added (client-only probe, not scene bundle).

### 4. `onUpdate(0)` between DOWN and UP resets UI state

SDK `onUpdate` runs `engine.seal()` + `engine.update(0)` + `pollEvents`. Network/poll side effects might reset modal flags.

**Verify:** Trace whether `creatorScenePresetsOpen` is true after step 2 but false before phase 4.

### 5. DOM ↔ yoga mismatch for CREATOR card

Card may not receive `scene-ui-node--interactive` if `PointerEvents` row missing from mount snapshot when `mount=23` (only ~5 `PointerEvents` for ~23 entities). Click falls through to BLOCK region.

**Verify:** `[scene-ui] interactiveDom` count vs entities with `PointerEvents` in snapshot when modal open.

## Fix applied (2026-07-15)

**Scene UI inject clicks (`sceneUi: true` on inject payload):**

1. PET_UP always targets `PlayerEntity` (not only when mount grew).
2. Inject-only UI path (post-DOWN flush, skip `onUpdate`, fingerprint flush) is gated on
   `body.sceneUi` — not on “any split inject” — so 3D mesh clicks keep entity UP + getClick.

CREATOR MODE sets `homeModalOpen=false` + `creatorScenePresetsOpen=true` on DOWN — mount often
**shrinks**. Old heuristic `openedOnDown = mountAfter > mountBefore` was false, so UP reused the
click entity id after react-ecs recycle → scrim/close handlers re-fired → phase-4 mount=4.

Worker logs to expect on CREATOR click:

- `pointer ui click — entity=N sceneUi=1`
- `post-DOWN mount A→B (sceneUi — UP always → PlayerEntity)`
- `pointer UP → PlayerEntity only (sceneUi inject; down was eN)`
- `pointer ui snapshot — mount=…` (presets size, not launcher-only ~4)

## Suggested retest

1. RickRoll CAM → open home modal → CREATOR MODE — presets overlay must stay open
2. Confirm worker logs above; `?sceneuidebug` pick should target the CREATOR card handler
3. If still broken: phase-4 mount still ~4 → pick/handler path; if presets paint then collapse → cooperative shrink

## Key files (this workstream)

- `.cursor/rules/worker-input-architecture.mdc`
- `src/shim/worker/sceneEngineScheduler.ts` — pointer tick pipeline
- `src/shim/worker/sceneWorker.ts` — deliver, defer, flush
- `src/shim/worker/workerSceneUiCrdtOutbound.ts` — `collectWorkerUiMountSnapshot`
- `src/shim/worker/injectPointerClick.ts` — split DOWN/UP inject
- `src/core/systems/SceneScriptSystem.ts` — outbound batch, mount commit, pointer flush
- `src/input/PointerEventsSystem.ts` — DOM pointer, inject payload
- `src/ui/scene/SceneUiBridge.ts` — pick, paint, mount snapshot ingest
- `src/ui/scene/uiPointer.ts`, `uiDomPick.ts`, `SceneUiDomRenderer.ts`

## Scene reference (read-only)

`../camera-operator/scene/src/ui/CameraPanel.tsx`:

- Home modal: `homeModalOpen` — scrim `onMouseDown` closes modal; CREATOR card `onMouseDown` sets `creatorScenePresetsOpen=true`, `homeModalOpen=false`, `remoteRef.listPresets()`
- Deployed bundle (~1203 KB) may differ slightly from local source

## Noise (ignore)

- MetaMask / ObjectMultiplex extension warnings
- `Floor_Sand01.png.png` 404, `/api/analytics/login` 404, `/api/mirror-scene-bundle` 404
- social.decentraland.org 530