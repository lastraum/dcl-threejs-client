---
name: scene-bundle-is-law
description: >
  Scene bundle is source of truth — never invent scene APIs, hit geometry, or
  input semantics. Client implements Explorer-parity platform laws only; for any
  scene-specific bug (pointer, VFX, move, UI, audio), fetch the catalyst
  bin/index.js (or local bundle) and read the real call sites before coding.
  Use when debugging scene behavior, pointer/VFX/click-to-move, "what does the
  scene use", inventing getClick/hit.position, or when the user says scene
  bundle / catalyst / parcel pointer is law. Also /scene-bundle-is-law.
---

# Scene bundle is law

## Absolute rules

1. **Never invent scene behavior.**  
   Do not assume `getClick`, invented ground PE hits, scene-name forks, or
   “what most scenes do” without reading the bundle that is running.

2. **The deployed scene bundle is source of truth.**  
   Catalyst content for the parcel pointer (or the worker-evaluated `bin/index.js`)
   beats chat hypotheses, prior session guesses, and comments that were never
   verified against the bundle.

3. **The client lives by platform laws we already have** — not by per-scene hacks.  
   Examples: COD frame pipeline, FocusOwner, inject-only pointer edges, reserved
   poses (Player/Camera/PPI), admit seal, depth bands, no scene-name forks.  
   Platform implements **Explorer parity APIs** so *any* bundle can run.  
   Scene logic decides *which* of those APIs it calls.

4. **If the scene’s code path is unknown — stop coding and open the bundle.**  
   No “probably getClick” fix loop.

## When a scene misbehaves (required sequence)

```text
1. Identify parcel / scene entity (logs, pointer, realm).
2. Fetch entity from catalyst (or local content cache).
3. Download bin/index.js (or main entry from scene.json).
4. Grep/read REAL call sites: isPressed, isTriggered, getInputCommand,
   getClick, PrimaryPointerInfo, CameraEntity, Raycast, MeshRenderer, etc.
5. Write down the scene law in one short block (arm → ray → act → VFX).
6. Map that law onto existing platform APIs / docs (FRAME_PIPELINE_COD, etc.).
7. Fix the *client* only where it violates Explorer parity for that API.
8. Do not invent a fake PE mesh, fake getClick pair, or scene-name branch
   unless the bundle literally requires a renderer feature Explorer provides
   and we lack it — then implement the feature as platform law, not a fork.
```

### Catalyst fetch (Genesis City)

```bash
# Entity for pointer
curl -sS "https://peer.decentraland.org/content/entities/scene?pointer=-16,124" -o /tmp/scene-entity.json

# Entry file hash from content[] (usually bin/index.js)
# Download:
curl -sS "https://peer.decentraland.org/content/contents/<hash>" -o /tmp/scene-index.js
```

Then search the JS for the APIs the client actually must feed.

## Forbidden inventions (recurring failures)

| Invention | Why forbidden |
|-----------|----------------|
| Assuming **getClick** is the move/VFX path | Many RTS/strategy scenes use **isPressed** + **Camera × PPI** only |
| Inventing **y=0 PE mesh hits** as the aim law | Scene may ignore PE hit and ray from CameraEntity + PrimaryPointerInfo |
| **Scene-name forks** (`if DecentraCraft`) | Platform law is universal; bundle chooses APIs |
| **Bandaid reassert** of zero-hit PET_DOWN every frame | Breaks real press/release / getInputCommand pairing |
| Fixing peel/visibility before proving **scene created** the entity | Count MeshRenderer/CRDT on worker after the edge the scene actually uses |
| Logging-only “fixes” while ignoring bundle | Diagnostics support law; they do not replace it |

## Platform vs scene (who owns what)

| Layer | Owns |
|-------|------|
| **Scene bundle** | Which systems run; isPressed vs getClick; when to spawn VFX; match/UI gates |
| **Client platform** | Correct PET edges, PPI, CameraEntity pose under VC, CRDT egress, material/depth peel, inject path without inventing hit semantics |
| **Neither** | Guessing the other’s job |

## Worked example (must re-verify if bundle changes)

**Parcel `-16,124` (DecentraCraft-class RTS)** — verified from catalyst `bin/index.js`:

- **Not** getClick for ground move/VFX.
- **isPressed(IA_POINTER)** arms press; release fires **onGroundClick**.
- Ground = **PrimaryPointerInfo.worldRayDirection** × **CameraEntity.position** ∩ plane **y=0**.
- Selectable check = **getInputCommand(IA_POINTER, PET_DOWN)?.hit?.entityId** vs unit colliders.
- Empty ground **hit.entityId = 0** (not PlayerEntity).
- VFX cylinder only if **units already selected** (`nQ` early-returns otherwise).

See [references/decentracraft-pointer-law.md](references/decentracraft-pointer-law.md).

## Related platform docs (do not replace bundle)

- `docs/AGENTS.md` — COD bar, FocusOwner  
- `docs/FRAME_PIPELINE_COD.md` — admit / lanes / peel / depth  
- `docs/ARCHITECTURE.md` — worker / CRDT I/O  

## Agent checklist before shipping a “scene input” fix

- [ ] Bundle entry fetched and grepped for the failing feature  
- [ ] Scene law written in ≤10 lines (no guesses)  
- [ ] Client change maps to a **named Explorer-parity** gap or platform law  
- [ ] No new scene-name branch  
- [ ] Logs prove the bundle path (isPressed / PPI / cam / CRDT Δ), not a fabricated path  
