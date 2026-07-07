# Scene UI pointer — remaining work (RickRoll / camera-operator)

**Branch:** `lastraum`  
**Status:** WIP committed; **Creator UI click still broken** as of last test.  
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

## Latest client edits (did not fix Creator click)

| Area | Change | Intent |
|------|--------|--------|
| `PointerEventsSystem.writeResult` | UI inject targets = `[targetEntity]` only | Stop scrim ancestor bubble closing modal |
| `SceneUiBridge.pickDomEntity` | Direct-handler pick only; no BLOCK fallback | Don't resolve BLOCK shells to scrim |
| `SceneUiBridge.pointerEventsLookup` | Snapshot fallback gated by worker mount set | Avoid stale PointerEvents on recycled ids |
| `uiPointer` | `hasDirectUiPointerHandler`, `pointerEventsOf` in `collectUiPointerResultTargets` | Pick/inject parity with phase-4 snapshot |
| `sceneEngineScheduler` | Pre-phase-4 `engine.update(0)` | Mount conditional UI before snapshot |

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

## Suggested next steps (when resuming)

1. Add `?sceneuidebug` pick trace at click point (candidates, direct-handler check, chosen entity) — **client only**
2. Log worker inject payload entity list on `inject-pointer-click`
3. Confirm CREATOR card entity id at runtime (not assumed from one session's 574)
4. Compare Explorer pointer tick ordering for UI clicks (single entity vs bubble)
5. If pick is correct but mount still 4: inspect worker react-ecs mount timing relative to phase 4

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