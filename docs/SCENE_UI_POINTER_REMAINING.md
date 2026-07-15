# Scene UI pointer — remaining work (RickRoll / camera-operator)

**Branch:** `lastraum`  
**Status:** CREATOR fixed (PE append discard). Play-mode dirty UI snapshots re-enabled for async QR.  
**Scene bundle:** do not modify `camera-operator/scene` — client-only fixes.

## Goal

1. CAM launcher → home modal opens and stays open  
2. CREATOR MODE → presets overlay mounts and stays open  
3. No bandaids — follow `.cursor/rules/worker-input-architecture.mdc`

## Root cause (CREATOR 23→4) — proven by logs

```
CAM:     DOWN mount 4→23 texts=[CREATOR MODE...]  ✓
CREATOR: DOWN mount 4→4  texts=[CAM only]         ✗  worker already closed before click
```

Main still painted home (e574). Worker had already collapsed to CAM-only.

**Mechanism:**
1. Main `writeResult` records `PointerEventsResult` appends (main timestamp clock)
2. inject-only path skipped `encodeAppendsOnly` → appends stayed queued
3. After `pointer-deliver-done`, `flushRendererGrowOnlyAppends` re-delivered those appends
4. Worker inject used worker clock (e.g. 1–2); main appends used main clock (higher)
5. Re-apply → `timestamp > previousFrameMax` → EventSystem **re-fires CAM toggle** → home closes
6. Play-mode cooperative has no UI egress → main still shows home (ghost UI)
7. CREATOR click hits e574 on main; worker entity 574 is recycled / not CREATOR → mount stays 4

## Architecture (sceneUi inject path)

```
1. inject PET_DOWN → engine.update(0)     # onMouseDown + remount
2. fingerprint flush until stable
3. phase-4 structured mount snapshot     # capture open UI HERE
4. inject PET_UP → PlayerEntity only
   engine.update with react-ecs OFF      # clear isPressed, no remount
5. non-ui phase
```

**inject-only:** discard main `PointerEventsResult` recorded appends (worker inject is sole authority).

## Logs to expect

```
[pointer] inject-only — discarded N main PointerEventsResult append(s)
CAM:     DOWN mount 4→23 ... CREATOR MODE
CREATOR: DOWN mount 23→N ... PRESETS / Search presets
```

## Key files

- `src/bridge/CrdtEncoder.ts` — `discardRecordedAppends`
- `src/core/systems/SceneScriptSystem.ts` — inject-only discard
- `src/shim/worker/sceneEngineScheduler.ts` — sceneUi phase order
- `src/shim/worker/injectPointerClick.ts` — sceneUi UP → PlayerEntity
- `.cursor/rules/worker-input-architecture.mdc`

## Scene reference (read-only)

`../camera-operator/scene/src/ui/CameraPanel.tsx`
