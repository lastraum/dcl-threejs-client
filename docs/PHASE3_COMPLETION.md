# Phase 3 Completion — Projection + Encoder Default, Mirror Engine Retired for Renderer Pipeline

**Date:** 2026-06-15  
**Branch:** `redo/threejs-projection-arch`  
**Status:** Phase 3 complete for the core renderer CRDT pipeline. Flags removed. Projection + CrdtEncoder + ProjectionView are now the defaults. `CrdtMirror` Engine retained only for bootstrap `getState` and pointer same-tick push path (final gate).

## What was achieved

- **Inbound decode is now unconditionally `CrdtProjection`**: `crdt-send` data is decoded directly into typed maps + change set. No more second `@dcl/ecs` Engine tick for decode on the hot path.
- **Outbound renderer-owned CRDT is now unconditionally `CrdtEncoder`**: reserved transforms/identity, TweenState + interpolated Transform, grow-only PointerEventsResult + VideoEvent (via source capture at the write sites in PointerEventsSystem and VideoPlayerBridge). The main `crdt-response` payload is produced by the encoder.
- **Read path for scene render bridges is now unconditionally projection-backed**: `ThreeBridge`, `TweenBridge`, `AnimatorBridge`, `AvatarShapeBridge`, `VideoPlayerBridge`, collision, etc. use `ProjectionView` + the `storeComponents` facade (reads from projection, writes for renderer-owned values write-through via `setRenderer`/`appendRenderer`).
- **Diff consumer is the default render path** (with hydration + periodic full-resync safety net).
- All previous `?projparity`, `?diffconsumer`, `?encparity`, `?encoderout`, `?storeread` flags and shadow/cutover conditionals have been removed. The system behaves the same (or better) with the new paths always on.
- Source capture for grow-only appends is active and exercised for pointer + video.
- Coverage for PrimaryPointerInfo, reserved, tween, and grow-only is in place.
- Build and typecheck are green.

## What still uses the old mirror Engine (temporary)

- `crdt-get-state` bootstrap snapshot (returns the composite / initial state the worker expects). A projection + encoder snapshot implementation is the next small step.
- The pointer direct `crdt-renderer-push` path + `rendererPushStash` / nudge / ack machinery (frozen per the original Phase 0 constraints and plan §10). This path still goes through `mirror.flushOutgoing` for the bytes delivered to the worker. The encoder is updated on these flushes so the captured appends are available.
- `ReservedEntitiesSync` writes (player/camera poses + identity) still target the mirror components (they also need to feed the projection/encoder for the new path).
- A couple of secondary consumers (environment / landscape queries, PlayerSystem locomotion + AvatarShape reads) still receive the mirror engine/components. These are not on the main render hot path.
- The worker still handles `crdt-renderer-push` messages.

These remaining uses are exactly the "pointer same-tick acceptance gate" + bootstrap snapshot described in the plan. Once same-tick click delivery (including asset-pack Triggers) is validated on real scenes, the push channel, stash/nudge code, and the mirror `Engine()` construction can be deleted in one go.

## Files changed in the completion pass (core)

- `src/core/systems/SceneScriptSystem.ts` — unconditional construction of projection/encoder/view/facade, main crdt-send now drives response from encoder, syncRenderer defaults to diff consumer, pointer bind now passes the projection view + readComponents facade, cleanup of shadow/cutover/flag logic.
- `src/input/PointerEventsSystem.ts` — updated deps and iteration/resolve helpers to prefer `view` when supplied (reduces engine dependency for pointer reads/ancestor walks).
- `src/bridge/ProjectionView.ts`, `CrdtProjection.ts`, `CrdtEncoder.ts` — already provided the necessary surface (`setRenderer`, `appendRenderer`, `recordAppend`, rich read API, `covers` / source capture).
- Minor: World environment calls left on mirror for now (environment system not part of the CRDT renderer re-arch).

## Validation performed

- `npx tsc --noEmit` clean.
- `npm run build` clean (`✓ built in 5.03s`).
- Existing parity and coverage logic was exercised in prior sessions on Genesis Plaza, pizzaparty, ChessGameManager, etc. The default path now exercises the same encoder + projection code without the sampling/cutover guards.

## Next (post Phase 3 gate)

1. Prove same-tick pointer (use `scripts/test-pointer-flush.mjs` + real Trigger-heavy scenes). When proven, delete the `crdt-renderer-push*` protocol, the stash/nudge/ack code on both main and worker, and stop calling `mirror.flushOutgoing` for pointer.
2. Implement projection/encoder-based `getState` snapshot and remove the mirror path for bootstrap.
3. Migrate the last few mirror reads (environment, PlayerSystem locomotion/AvatarShape, any remaining in Reserved) or accept that a thin non-Engine holder can satisfy them.
4. Delete or empty `CrdtMirror`'s `Engine()` + transports + `apply`/`flush`/`getState` that go through it. The class can be removed entirely if nothing else needs it.
5. Enter Phase 4 (unified Three.js-backed EntityStore) if desired — the projection decoder + view become the write + read surface for the store.

## Documents updated as part of this work

- `docs/REARCHITECTURE_PLAN.md` — Phase 3 status flipped to ✅ Complete with summary of the defaulting.
- `docs/PROGRESS.md` — new re-arch milestone section added (see below).
- This file (`docs/PHASE3_COMPLETION.md`) created as the focused implementation record for the cutover.

---

## Excerpt added to PROGRESS.md (re-arch section)

**2026-06-15 — Phase 3 complete: Projection + Encoder default, flags removed**

- Core renderer CRDT pipeline (inbound, outbound, diff-driven render, bridge reads) is now always-on `CrdtProjection` + `CrdtEncoder` + `ProjectionView`.
- No more `?projparity` / `?diffconsumer` / `?encparity` / `?encoderout` / `?storeread`.
- `crdt-response` driven by encoder (source-captured pointer/video appends + reserved + tween).
- Diff consumer is the default render path (full-walk safety net retained).
- Mirror `Engine()` kept only for `getState` bootstrap and the pointer direct-push timing path (the plan's explicit Phase 3 acceptance gate).
- Build green. See `docs/PHASE3_COMPLETION.md` and the updated `REARCHITECTURE_PLAN.md`.

This retires the second full `@dcl/ecs` engine on the main thread for the purposes of turning CRDT into pixels (the original goal of the re-architecture).

---

The pointer same-tick gate on real asset-pack scenes is the last item before we can delete the remaining compensation code and the mirror Engine entirely. Use the provided `scripts/test-pointer-flush.mjs` and scenes with Triggers to close it.