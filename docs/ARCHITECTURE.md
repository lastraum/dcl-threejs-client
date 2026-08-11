# Architecture & tech debt

> Scene I/O model, hard rules, remaining debt, and how this monorepo is layered.  
> **Parity matrix:** [INTEGRATION.md](./INTEGRATION.md) · **Narrative / next:** [PROGRESS.md](./PROGRESS.md)  
> **Input CRDT rules:** `.cursor/rules/worker-input-architecture.mdc` (authoritative for pointer / UI wire)

---

## What this client is

Browser-native DCL SDK7 client: load Worlds/parcels → run `bin/scene.js` in a **Web Worker** shim → mirror ECS to **Three.js** on main → Explorer-style HUD / chat / social shell.

**One repo, two layers** (say which moved when you ship):

| Layer | Owns | Examples |
|-------|------|----------|
| **Platform runtime** | Worker, CRDT, bridges, PhysX, pointer inject, FocusOwner, multi-scene continuity | riding law, PART/ROOT colliders, scene-http, mesh frame law |
| **Client shell / parity+** | Product UI and client-only features that may go beyond Unity Explorer | P2P trade, pets, loot bag, live tools, terrain editor, communities |

Parity target for platform I/O: **Unity Foundation Explorer behavior** — not identical internal architecture.

```text
Main (rAF)                          Worker (scene.js)
──────────                          ────────────────
Three.js + PlayerSystem             @dcl/ecs engine + systems
SceneUiBridge (DOM UI)              react-ecs UI + VirtualCameraRig
PointerEventsSystem                 PointerEventsResult inject
SceneInputRelay (WASD)              inputSystem.isPressed
        │  postMessage lanes        │
        ├─ inject-pointer-click  ──►│ PE edges (authoritative)
        ├─ scene-input-snapshot  ──►│ keyboard PETs on PlayerEntity
        ├─ play-frame-tick       ──►│ unified play frame
        ├─ *-deliver (below)     ──►│ renderer-owned CRDT inbound
        ◄── player-frame ───────────┤ InputModifier + MainCamera (no ack)
        ◄── vc-pose-live ───────────┤ VC Transform during edit flight
        ◄── crdt-outbound ──────────┤ cold world + UI mount snapshot
```

**Transforms:** Logical sim/comms stay in DCL left-handed meters. Display conversion only at the render boundary (`src/bridge/dclTransform.ts`). Landscape uses the same X reflection so author terrain and biome floors align.

**Landscape / terrain editor:** Play client builds empty-land + decoration via `buildParcelLandscape` from `scene.json` → `environment.kind` (+ optional `water` / `desert` / `land` / `space`). The `/editor` workspace rebuilds that same path for live biome preview.

---

## “COD” naming (not a runtime product)

Docs and commits sometimes say **COD** (Call of Duty–level bar). That was a **focus prompt** for continuity and frame discipline — not a separate platform product or scheduler brand.

| Use “COD” for | Do not treat COD as |
|---------------|---------------------|
| Quality bar: no unload voids, coherent systems, measure then land | A second architecture next to “the real one” |
| Frame-pipeline discipline (admit / lanes / peel) in [FRAME_PIPELINE_COD.md](./FRAME_PIPELINE_COD.md) | A shippable feature name in release notes |
| Static-collider cook/seal intensity ([STATIC_COLLIDER_COD.md](./STATIC_COLLIDER_COD.md)) | Something community contributors must implement as “COD mode” |

Prefer plain names in new text: **frame pipeline**, **static collider seal**, **multi-scene continuity**, **platform law**.

---

## Docs in this repo

| Doc | Role |
|-----|------|
| [PROGRESS.md](./PROGRESS.md) | **Current next** + shipped milestones (source of truth for “what’s open”) |
| [INTEGRATION.md](./INTEGRATION.md) + `integrationRegistry.ts` | Parity checklist |
| [CLAIMS.yaml](./CLAIMS.yaml) | Community claims (GitHub issues) |
| [AGENTS.md](./AGENTS.md) | AI / contributor onboarding (scene-bundle-is-law · refactor-the-law) |
| [MULTI_SCENE_CONTINUITY.md](./MULTI_SCENE_CONTINUITY.md) | FocusOwner · sticky demote · AOI · promote order |
| [FRAME_PIPELINE_COD.md](./FRAME_PIPELINE_COD.md) | Main-thread admit / lanes / peel (name is historical) |
| [COLLIDER_MOTION_POLICY.md](./COLLIDER_MOTION_POLICY.md) | PhysX PART vs ROOT pose sync |
| [RIDING_TRANSFER_LAW.md](./RIDING_TRANSFER_LAW.md) | CCT ride: one stand-actor Δ · grounded under capsule |
| [STATIC_COLLIDER_COD.md](./STATIC_COLLIDER_COD.md) | Cook-once statics · never forceDynamicTreeRebuild |
| [WORKER_SYSTEM_PIE_V2.md](./WORKER_SYSTEM_PIE_V2.md) | WSP — meters shipped; systems pie **parked / decide** |
| [CONTRIBUTOR_TESTING.md](./CONTRIBUTOR_TESTING.md) | How to test before PR |
| [DEPLOYMENT.md](./DEPLOYMENT.md) | Build / host / smoke · `/api/scene-http` |
| [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md) | Original phase sketch (**historical**) |
| [PR_CHECKLIST.md](./PR_CHECKLIST.md) | PR gate |
| [REPO_MANAGEMENT.md](./REPO_MANAGEMENT.md) | Branches, release, community |
| [TASKS.yaml](./TASKS.yaml) | Re-arch history — **not** a pickup queue |

Gaps and claims live in the **integration registry** + GitHub issues — not extra design docs.

---

## Design principles

1. **Scene owns InputModifier / MainCamera writes** — shim transports; does not invent freeze policy.  
2. **Hot path without ack** — IM/MC/`vc-pose-live` never wait on main CRDT ack.  
3. **Pointer UI has one egress** — structured mount snapshot only (no Ui\* CRDT on cooperative wire).  
4. **No belt-and-suspenders** — fix the phase boundary; do not re-apply opposing state. Same for locomotion: **one** riding Δ, grounded under feet — never sticky/snap/pull-down recovery.  
4b. **Scene bundle is law** — never invent scene APIs/geometry; implement Explorer-parity client only.  
4c. **Generic scene HTTP egress** — absolute third-party worker/SignedFetch URLs via `/api/scene-http/...` (one proxy), not per-game nginx.  
5. **Flight = engine systems + keyboard PETs** — not full SDK `onUpdate`/pollEvents.  
6. **Ignore extension console noise** (e.g. MetaMask) when diagnosing.  
7. **One repo** — when documenting a ship, tag **platform** vs **shell/parity+**.

---

## Main → worker deliver channels (I/O map)

These are **not** two competing full runtimes. They are specialized postMessage types that grew as we fixed freezes and same-tick delivery. Some residual dualism is real hygiene debt (below).

| Channel | Direction | Role today |
|---------|-----------|------------|
| **`inject-pointer-click`** | main → worker | **Authoritative PE edge** (down/up). Opens deliver-done session. `injectOnly: true`. |
| **`pointer-crdt-deliver`** | main → worker | Light inbound for **non-edge** renderer CRDT: grow-only appends (TriggerArea, VideoEvent), RaycastResult LWW, some ambient LWW. Does **not** post deliver-done. Name is historical — not “pointer only.” |
| **`renderer-inbound-deliver`** | main → worker | General renderer inbound (e.g. GltfContainerLoadingState, reserved snapshot paths). Avoids pointer pause path mid-boot. |
| **`tween-state-deliver`** | main → worker | TweenState only (ambient textureMove / sequence complete). |
| **`scene-input-snapshot` / `play-frame-tick`** | main → worker | Keyboard PETs + unified play frame. |
| **`player-frame` / `vc-pose-live` / `crdt-outbound`** | worker → main | Hot IM/MC, VC pose, cold world + UI mount. |

**Pointer PE law (settled):** inject is the only authoritative PE edge. Main **never-records** `PointerEventsResult` into the encoder (`recordRendererAppend` gates 1063). Inject flush still discards PE appends as a safety belt (warn if any). See `flushPendingPointerCrdt` + `.cursor/rules/worker-input-architecture.mdc`.

**Hygiene status (2026-08-11, `feat/io-leftovers-hygiene`):**

| Item | Status |
|------|--------|
| `pointerResponseStash` | ✅ Removed (e7 leftover) |
| PE never-record on main | ✅ Gate on `recordRendererAppend` |
| Discard PE on inject flush | ✅ Safety belt + warn if non-zero |
| `pointer-crdt-deliver` name | Kept on wire; documented as **light renderer inbound** (not PE) |
| Gltf LWW → `renderer-inbound-deliver` | Intentional (boot-safe; no pointer pause) |
| Grow-only / raycast / tween flush timers | Correct specialization — do not merge |

Do **not** resurrect `crdt-renderer-push` / dual main-thread ECS engines.

---

## Architecture debt (priority)

### P0 — Scene I/O correctness

| Debt | Direction |
|------|-----------|
| Over-shimmed InputModifier | ✅ Latch re-apply removed; scene owns IM |
| Pointer session vs keyboard | ✅ Flight keys apply immediately |
| pollEvents defer while frozen | Keep; re-evaluate if UI stalls |
| Async play-frame vs rAF | Apply pending player-frame at **start** of locomotion tick |
| Ui mount vs DOM hit-map drift | ✅ Hit regions from Yoga layoutBoxes + layoutToScreen |
| Edit-flight IM / VC residual | Retest MOVE/WASD/STOP; strip invent-policy |
| PE / deliver channel hygiene | ✅ never-record PE · stash removed · channels documented |

### P1 — Performance / multi-scene

| Debt | Notes |
|------|--------|
| **CBD multi-scene FPS** | Continuity law landed; density budget still 🟡 — next hard push after 1.8 cut |
| Mesh frame law | Bytes-only content-map warm; no cold parse/clone on rAF; parse concurrency 1 |
| Worker CRDT acks on cold path | Play-mode fire-and-forget; verify no stalls |
| Full UI mount on growth | Dirty-only default |
| Third-person camera + foliage jitter | Not MOVE CAMERA |
| Avatar profile `localStorage` quota | ✅ Pruned (`profileStorage.ts`) |
| GLTF instancing | Partial — static multi-hash; motion promotes private clone |
| Graphics P3 distance culls | Prefs stubs still open (P4 bloom/HDR shipped) |

### P2 — Product / shell (see PROGRESS)

| Area | Status |
|------|--------|
| In-scene ECS UI | 🟢 smoke-pass — one-off scene bugs only |
| Social | Multi-room + cast · 2D chat FAB · community voice (start/join/mod) · dual-path **discovery** (PM + Social WS) · create/invites **open** |
| Live tools / pets / loot bag | 🟢 v1.7 |
| P2P in-world trade | 🟢 on tip (1.8 headline, unreleased) |
| Backpack | Wearables/emotes 🟢 · saved outfits + shell marketplace browse **open** |
| Play HUD / minimap / Camera Reel | 🟢 · gallery multi-page open |
| Portable experiences | Panel exists · polish open |
| Keybinds | Sensitivity live · rebinding **open** |
| Multi-scene / AOI | FocusOwner + sticky demote + secondary anim 🟢 · **CBD FPS 🟡** |
| PART/ROOT · riding · scene-http · TextShape width · lighting | 🟢 on tip (1.8 platform stack) |

### P3 — Hygiene / deferred architecture

| Debt | Action |
|------|--------|
| Deliver-channel naming / PE encoder discard | Collapse when QA-green (see I/O map) |
| **WSP systems pie** | **Parked (2026-08-11)** — meters stay; pie off until systems ms dominates ([WORKER_SYSTEM_PIE_V2.md](./WORKER_SYSTEM_PIE_V2.md)) |
| Archipelago adapter | Stub — LiveKit primary |

---

## Release posture (2026-08)

| Item | State |
|------|--------|
| **`main`** | **v1.7.0** |
| **`dev-latest` tip** | **1.8 candidate** — world-feel platform + ECS UI smoke-pass + P2P trade |
| **1.8 cut** | **Not yet** — planned for **~2‑month anniversary** (do not cut mid-stack) |
| **After 1.8 cut** | Multi-scene FPS / density pass; shell gaps (outfits / create-community / keybinds) as chosen |

---

## Suggested engineering order (until / after 1.8 cut)

1. **Hold 1.8 cut** for anniversary — stop stacking unrelated headlines; finish QA on tip.  
2. ~~**Decide WSP**~~ → **parked** (meters only).  
3. ~~**I/O hygiene**~~ → never-record PE · stash removed · channels documented.  
4. **Multi-scene density / FPS** (AOI radius · live secondary budget · CBD ring) — continuity laws written; re-attack with tip perf stack.  
5. Shell picks (create-community / outfits / keybinds) — one at a time.  
6. Optional: P3 culls, MSAA+bloom concurrent, Social WS reliability, SyncEntities auth-host.  
7. Keep INTEGRATION + PROGRESS updated on each ship; tag **platform** vs **shell**.

---

## Non-goals

- Treating “COD” as a product or second runtime  
- Changing camera-operator scene bundle  
- Rewriting Three.js renderer  
- Matching Unity internal scheduling exactly  
- Fixing MetaMask content-script warnings  
- Re-introducing `crdt-renderer-push` / dual main-thread ECS engines  
