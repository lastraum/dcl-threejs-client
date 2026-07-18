# Physics parity plan — Unity Explorer vs ThreejsClient

**Status:** Review complete · implementation **not started** (P0+ pending approval)  
**Branch context:** `lastraum`  
**Last updated:** 2026-07-18  

Related code today: [`src/player/PlayerSystem.ts`](../src/player/PlayerSystem.ts) (`applyScenePhysicsCombined`), [`src/player/locomotion.ts`](../src/player/locomotion.ts) (`GLIDING_FORCE_MULTIPLIER`), PhysX CCT in [`src/physics/PhysXWorld.ts`](../src/physics/PhysXWorld.ts).

Official scene API: [Player Physics](https://docs.decentraland.org/creator/scenes-sdk7/interactivity/player-physics).

---

## Goal

Match **Unity Explorer** continuous force + one-shot impulse feel for:

- `Physics.applyForceToPlayer` / `removeForceFromPlayer` / duration / repulsion  
- `Physics.applyImpulseToPlayer` / `applyKnockbackToPlayer`  
- Glider **1.5×** continuous force only  

Scene-side accumulation already matches (SDK writes `PhysicsCombinedForce` 1216 / `PhysicsCombinedImpulse` 1215 on `PlayerEntity`). Parity work is **client integration**.

---

## Shared architecture (both clients)

| Layer | Role |
|--------|------|
| Scene SDK `Physics.*` | Accumulators → PE summary components |
| CRDT | World-space vectors on `PlayerEntity` |
| Client motion | F/m, J/m → velocity → kinematic **CCT** move |

Neither client applies PhysX dynamic forces on the avatar body. Player is a **CharacterController / CCT** driven by displacement each frame.

---

## Unity Explorer reference

Sources (commit `aba4c692…` era paths):

- `SDKExternalPhysicsSystems.cs` — CRDT → per-scene force slots + impulse buffer  
- `ApplyExternalForce.cs` — a = F/m, glide ×1.5, **XZ only** into `ExternalVelocity`  
- `ApplyExternalImpulse.cs` — Δv = J/m; upward impulse ungrounds + zeros falling gravity  
- `ApplyGravity.cs` — `effectiveGravity = |g| - ExternalAcceleration.y`  
- `ApplyExternalVelocityDragAndClamp.cs` — dedicated external drag  
- `CalculateCharacterVelocitySystem.cs` — pipeline order  
- `InterpolateCharacterSystem.cs` — `Move(move + gravity + external) * dt`  
- `CharacterControllerSettings` — mass, glide wind, external drag defaults  

### Pipeline

```mermaid
flowchart TD
  A[SDK PE components] --> B[SDKExternalPhysicsSystems]
  B -->|Force per scene World| C[ExternalForceContributions]
  B -->|Impulse if dirty| D[ExternalImpulse]
  C --> E[ApplyExternalForce]
  E -->|a = F/m · 1.5 if gliding| F[ExternalAcceleration]
  F -->|XZ: v += a*dt| G[ExternalVelocity]
  F -->|Y via effective g| H[ApplyGravity]
  D --> I[ApplyExternalImpulse]
  I -->|Δv = J/m| G
  I -->|J.y > 0: unground + zero fall| H
  M[MoveVelocity] --> J[CC.Move]
  H --> J
  G --> J
```

### Force (continuous)

1. Per **current** scene world: `ExternalForceContributions[world] = force.vector`  
2. Sum → `ExternalForce`  
3. `a = F / CharacterMass` (**default mass = 1**)  
4. If gliding: `a *= GlideWindResponse` (**1.5**)  
5. Integrate **X/Z only** into `ExternalVelocity`  
6. **Y** does **not** go into external velocity — feeds gravity:

   `effectiveGravity = |g| - a_y`  
   - Air: accumulate with direction  
   - Grounded: if `effectiveGravity <= 0` → **unground** (lift)

### Impulse (one-shot)

1. `ExternalVelocity += J / mass` (all axes)  
2. If `J.y > 0`: unground; if `GravityVelocity.y < 0`, **zero** it (jump pads beat fall)  
3. Clear pending impulse  
4. **No** glide multiplier  

### Final displacement

```
Move( MoveVelocity*dt + GravityVelocity*dt + ExternalVelocity*dt + slope )
```

Three velocity channels stay separate.

### Defaults (`CharacterControllerSettings`)

| Setting | Default |
|---------|---------|
| CharacterMass | 1 |
| GlideWindResponse | 1.5 |
| Gravity | −9.8 |
| ExternalEnvDrag | 0.5 (always) |
| ExternalGroundFriction | 4 (grounded) |
| MaxExternalVelocity | 50 |

`ExternalVelocity *= (1 - damping*dt)`; grounded zeros external **Y**; clamp magnitude to 50.

### Multi-scene / stale impulses

- Forces: one contribution slot per scene world; only **current** scene writes  
- Impulses: dirty flags discarded when scene becomes current again (no burst on re-enter)

---

## ThreejsClient today

[`PlayerSystem.applyScenePhysicsCombined`](../src/player/PlayerSystem.ts):

| Behavior | Ours | Unity |
|----------|------|-------|
| Impulse | `eventId` once → `_velocity += J` | `ExternalVelocity += J/m` (m=1) |
| Force | `_velocity += F * mult * dt` all axes | XZ → ExternalVelocity; Y → effective g |
| Glide force ×1.5 | Yes | Yes |
| Velocity split | One buffer (walk + g + external) | Move / Gravity / External |
| Impulse vs fall | No cancel of falling `v.y` | Zero negative gravity velocity |
| Continuous lift off ground | Often blocked (grounded strips Y) | Unground when net accel ≥ g |
| External drag | Shares walk stop/air drag | Env 0.5 + ground friction 4 |
| Max external speed | None | 50 m/s |
| Gravity constant | **20** (arcade jump) | **9.8** |
| Multi-scene forces | Current worker PE only | Sum per World if IsCurrent |
| Stale impulse on re-enter | Not handled | Clear dirty on re-activate |
| Mass | Implicit 1 | CharacterMass 1 |

`eventId` delivery matches protocol (Unity C# also uses dirty wrappers on the same component).

### Gravity mismatch

With `GRAVITY = 20`, continuous upward forces fight **~2×** harder than Explorer (g≈9.8). Same scene force magnitudes feel weaker for lift/wind.

Options:

- **A)** Keep g=20 for jump feel; scale external F/J by ~`20/9.8` for pad/wind parity  
- **B)** Effective-gravity path for force Y using a calibrated base (preferred with channel split)

---

## Implementation plan

### P0 — Correctness (do first)

1. Split **`_externalVelocity`** from locomotion `_velocity`.  
2. **Impulse:** `external += J/m`; if `J.y > 0` → unground + clear negative vertical fall.  
3. **Force:**  
   - XZ → `external.xz += (F/m)*mult*dt`  
   - Y → effective gravity / unground when net upward (not `v.y += F.y*dt` on shared buffer).  
4. **Displacement:** `move(locomotion + gravity + external) * dt` into existing CCT `movePlayer`.  
5. **External drag/clamp** only on external: env 0.5, ground friction 4, max 50; grounded clear external Y.  
6. Keep: eventId once, glide ×1.5 on force only, DCL→Three vectors, strong upward impulse exits glide.

### P1 — Calibration

7. Decide g vs force scale (A or B); constants next to `GRAVITY` / `GLIDING_FORCE_MULTIPLIER`.  
8. Continuous upward force must break grounded (no Y-strip eating lift).

### P2 — Edge cases

9. Stale impulse when leaving/re-entering a scene.  
10. Multi-scene PE if multiple force writers ever exist.  
11. Order vs jump same frame: impulse after gravity cancel, before final move.

### P3 — Verify

12. Manual checklist vs Explorer:  
    - Launch pad impulse `(0, 50, 0)`  
    - Wind tunnel continuous force X  
    - Glide + wind → 1.5×  
    - Updraft while gliding lifts  
    - Grounded continuous up force lifts off  
    - Knockback / repulsion (scene helpers; PE sum already)

### Likely files

- `src/player/PlayerSystem.ts` — main integration  
- `src/player/locomotion.ts` — external drag / mass / max-v constants  
- Optional `src/player/externalPhysics.ts` — pure math for unit tests  
- Docs: this file + `INTEGRATION.md` / `PROGRESS.md` when verified  

**PhysXWorld** stays kinematic CCT — no dynamic actor forces on the capsule.

---

## Recommendation

Implement **P0 fully** first (channel split + force Y via effective g + impulse fall cancel + external drag). Then calibrate g/force scale with a pad/wind scene.

Default implementation choices when starting:

- mass = 1  
- Unity external drag numbers  
- effective-g for force Y  
- no global `GRAVITY` change until P1 A/B decision  

---

## Out of scope (for this plan)

- Free camera / C key  
- Full locomotion curve parity (acceleration curves, wall slide, edge slip)  
- Remote players simulating the same local forces (forces are local-only by design)
