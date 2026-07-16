# Architecture & tech debt

> Scene I/O model, hard rules, and remaining debt.  
> **Parity matrix:** [INTEGRATION.md](./INTEGRATION.md) · **Narrative:** [PROGRESS.md](./PROGRESS.md)  
> **Input CRDT rules:** `.cursor/rules/worker-input-architecture.mdc` (authoritative)

---

## What this client is

Browser-native DCL SDK7 client: load Worlds/parcels → run `bin/scene.js` in a **Web Worker** shim → mirror ECS to **Three.js** on main → HUD / chat / social shell.

```text
Main (rAF)                          Worker (scene.js)
──────────                          ────────────────
Three.js + PlayerSystem             @dcl/ecs engine + systems
SceneUiBridge (DOM UI)              react-ecs UI + VirtualCameraRig
PointerEventsSystem                 PointerEventsResult inject
SceneInputRelay (WASD)              inputSystem.isPressed
        │  postMessage lanes        │
        ├─ inject-pointer-click  ──►│ priority deliver queue
        ├─ scene-input-snapshot  ──►│ PETs on PlayerEntity
        ├─ pump-scene-engine-tick──►│ flight engine.update
        ├─ play-frame-tick       ──►│ unified play frame
        ◄── player-frame ───────────┤ InputModifier + MainCamera (no ack)
        ◄── vc-pose-live ───────────┤ VC Transform during edit flight
        ◄── crdt-outbound ──────────┤ cold world + UI mount snapshot
```

**Parity target:** Unity Foundation Explorer behavior for scene I/O — not identical internal architecture.

**Transforms:** Logical sim/comms stay in DCL left-handed meters. Display conversion only at the render boundary (`src/bridge/dclTransform.ts`).

---

## Docs in this repo

| Doc | Role |
|-----|------|
| [PROGRESS.md](./PROGRESS.md) | Shipped milestones + “what’s next” |
| [INTEGRATION.md](./INTEGRATION.md) + `integrationRegistry.ts` | Parity checklist |
| [CLAIMS.yaml](./CLAIMS.yaml) | Community claims (GitHub issues) |
| [AGENTS.md](./AGENTS.md) | AI / contributor onboarding |
| [CONTRIBUTOR_TESTING.md](./CONTRIBUTOR_TESTING.md) | How to test before PR |
| [DEPLOYMENT.md](./DEPLOYMENT.md) | Build / host / smoke |
| [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md) | Original phase sketch (historical) |
| [PR_CHECKLIST.md](./PR_CHECKLIST.md) | PR gate |
| [REPO_MANAGEMENT.md](./REPO_MANAGEMENT.md) | Branches, release, community |
| [TASKS.yaml](./TASKS.yaml) | Re-arch history — **not** a pickup queue |

Gaps and claims live in the **integration registry** + GitHub issues — not extra design docs.

---

## Design principles

1. **Scene owns InputModifier / MainCamera writes** — shim transports; does not invent freeze policy.  
2. **Hot path without ack** — IM/MC/`vc-pose-live` never wait on main CRDT ack.  
3. **Pointer UI has one egress** — structured mount snapshot only.  
4. **No belt-and-suspenders** — fix the phase boundary; do not re-apply opposing state.  
5. **Flight = engine systems + keyboard PETs** — not full SDK `onUpdate`/pollEvents.  
6. **Ignore extension console noise** (e.g. MetaMask) when diagnosing.

---

## Architecture debt (priority)

### P0 — Scene I/O correctness

| Debt | Direction |
|------|-----------|
| Over-shimmed InputModifier | ✅ Latch re-apply removed; scene owns IM |
| Pointer session vs keyboard | ✅ Flight keys apply immediately |
| pollEvents defer while frozen | Keep; re-evaluate if UI stalls |
| Async play-frame vs rAF | Apply pending player-frame at start of locomotion tick |
| Ui mount vs DOM hit-map drift | Single authority: mount snapshot + yoga |
| Edit-flight IM / VC residual | Retest MOVE/WASD/STOP; strip invent-policy |

### P1 — Performance

| Debt | Notes |
|------|--------|
| Mesh frame law | Bytes-only content-map warm; no cold parse/clone on rAF; parse concurrency 1 |
| Worker CRDT acks on cold path | Play-mode fire-and-forget; verify no stalls |
| Full UI mount on growth | Dirty-only default |
| Third-person camera + foliage jitter | Not MOVE CAMERA |
| Avatar profile `localStorage` quota | ✅ Pruned (`profileStorage.ts`) |

### P2 — Product / parity (see PROGRESS header)

| Area | Status |
|------|--------|
| Scene UI | Partial — Creator modal / hit-map polish |
| Social | Multi-room + cast ✅; nearby voice + Explorer interop ✅ (spatial 3D next); DMs · in-world `/goto` open |
| Play HUD | Location pill + circular Genesis minimap (parcels) ✅; worlds pill-only |
| Backpack | Wearables/emotes/colors ✅; outfits + marketplace open |
| Graphics P3/P4 | Distance culls + bloom/HDR stubs |
| NftShape, AvatarModifierArea, GltfContainerLoadingState | Not started |

### P3 — Hygiene

| Debt | Action |
|------|--------|
| Dual defensive CRDT/pointer paths | Prefer one path when QA-green |

---

## Suggested next engineering order

1. Edit-flight IM/VC cleanup → retest MOVE / WASD / STOP.  
2. Product: spatial voice (3D) · in-world `/goto` · community DMs.  
3. Mesh frame-law / instancing follow-through.  
4. Optional: SyncEntities P4 auth-host; graphics P3 distance culls.  
5. Keep INTEGRATION registry + PROGRESS updated on each ship.

---

## Non-goals

- Changing camera-operator scene bundle  
- Rewriting Three.js renderer  
- Matching Unity internal scheduling exactly  
- Fixing MetaMask content-script warnings  
