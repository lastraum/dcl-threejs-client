# Architecture — host world

> **This is the law.** The old dual-runtime (“worker owns the world, main mirrors it”) is void.  
> Parity matrix: [INTEGRATION.md](./INTEGRATION.md) · Scene I/O: `.cursor/rules/worker-input-architecture.mdc`  
> Scene behavior: **scene-bundle-is-law** (official `bin/scene.js` still runs in a Worker).

---

## What this client is

Browser DCL SDK7 explorer: load Worlds/parcels → run official `bin/scene.js` in a **Worker VM** → **host** (`CrdtProjection` + `EntityStore` + `PhysXWorld`) is the world → Three.js presents.

```text
HOST (main)                              GUEST (Worker + official scene.js)
───────────                              ────────────────────────────────
CCT + input + reserved writers
Host store dirty set
CrdtEncoder.encode()  ── inbound ──►     inject via updateFromCrdt (no dirty)
                                         engine.update / onUpdate
                                         getCrdtUpdates() scene-owned only
                 ◄── outbound ──         one crdt-outbound blob
fold → EntityStore / Three / PhysX
present
```

| Layer | Owns |
|-------|------|
| **Host store** | `CrdtProjection` (components), `EntityStore` (Three graph), `PhysXWorld` |
| **Guest VM** | Official `@dcl/ecs` + `scene.js` — systems, react-ecs, `syncEntity`, PET `isPressed` |
| **Clock** | `SceneLoop` — one in-flight play-frame; not a second world |
| **Shell** | HUD, chat, remotes, pets — product, not the store |

No second `@dcl/ecs` `Engine()` on main. No worker-as-source-of-truth.

---

## Law

1. Host store is the world. Scene JS may not win reserved Transform / PPI / EngineInfo wars.
2. Worker is a VM. It returns **scene-owned dirty CRDT only**. Host inject uses `updateFromCrdt` (no `dirtyIterator`).
3. One send per guest tick. No full-store dump. No echo of host-injected values.
4. Pointer inject is the only PE edge. Ui* never rides cooperative CRDT (structured snapshot).
5. `MainCamera` / `InputModifier` stay **scene-authored** (`player-frame`).
6. Scene bundle is law. No scene-name forks. Remotes are product (not this invert).

Reserved host writes each eligible send: PE/Camera Transform, Root PPI / EngineInfo / canvas / RealmInfo, CameraMode, PointerLock.

---

## SceneLoop (clock only)

```text
rAF: CCT + input → send (if !inFlight) → receive guest dirty
     → fold motion → present → spare apply (Gltf/maps only; 0 if idle)
```

Pointer inject / `player-frame` / CCT stay outside the clock.

**Transforms:** sim/comms stay DCL left-handed. Display conversion only at `dclTransform.ts`.

---

## Wire (unchanged product lanes)

| Channel | Direction | Role |
|---------|-----------|------|
| `inject-pointer-click` | main → worker | Authoritative PE edge |
| `play-frame-tick` | main → worker | Guest tick + reserved poses |
| `renderer-inbound-deliver` | main → worker | Host LWW inject |
| `player-frame` / `vc-pose-live` | worker → main | IM/MC / VC (no ack) |
| `crdt-outbound` | worker → main | Scene-owned dirty + UI snapshot |

Do not resurrect `crdt-renderer-push` or a main-thread SDK engine.

---

## Related

| Doc | Role |
|-----|------|
| [AGENTS.md](./AGENTS.md) | scene-bundle-is-law · FocusOwner |
| [FRAME_PIPELINE_COD.md](./FRAME_PIPELINE_COD.md) | leftover async attach pie (not a second store) |
| [MULTI_SCENE_CONTINUITY.md](./MULTI_SCENE_CONTINUITY.md) | FocusOwner · shells |
| [COLLIDER_MOTION_POLICY.md](./COLLIDER_MOTION_POLICY.md) | PART vs ROOT |
| [RIDING_TRANSFER_LAW.md](./RIDING_TRANSFER_LAW.md) | one CCT Δ |
| [STATIC_COLLIDER_COD.md](./STATIC_COLLIDER_COD.md) | cook-once statics |
