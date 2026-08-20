# v4 — city soak (order of attack)

| Field | Value |
| --- | --- |
| **Branch** | `v4` off `origin/dev-latest` |
| **Clock** | SceneLoop 🟢 (v2.2.0). Do **not** start a second invert. |
| **Look (v3)** | Shells on · Landscape/Shadows Distance live · FXAA-when-bloom · GPU warm. Promote **off**. |
| **This chapter** | Prove stacked live-guest FPS, then stand-on promote. Measure goldens. No tag. |
| **Date** | 2026-08-19 |

Named scenes (plaza, CBD, Flagtag, Dead Surge) are **guides / repros**, not law. No `if Flagtag`. Scene bundle is law.

---

## Non-goals (do not “fix” these as v4 scope)

| Park | Why |
| --- | --- |
| PhysX on far shells | Explorer/Bevy law: far = composite, no eval. Colliders arrive with the **live guest**. |
| Bevy `Broken` on timeout | Off by choice. Skip-if-in-flight + 2 s play-frame safety. |
| Main-thread `@dcl/ecs` Engine | Forbidden invert resurrection. |
| Delete `pointer-edge` | Named inject-wakeup. |
| Retune `EXTERNAL_SCENE_SCALE` / `IMPULSE_CLIENT_SCALE` | Closed until a same-vector Explorer delta is pasted. |
| MSAA+bloom / cascades / SSAO | Unity look stack — only after city soak, and only if we want Unity look not Bevy. |
| Saved outfits / keybinds / marketplace catalog | Shell product. |

---

## Order of attack (gates)

Each step has a **gate**. Do not start the next compile-default flip without the gate.

### 1. Stacked live-guest FPS log — **unlocks everything else**

**In tree today:** live guests on; enter `min(Scene Distance, 20 m)`; keep enter+16 m; cap 1/2/4; boot concurrency **4**; SceneLoop 50 ms.

**Do:** one walk plaza → street → a **live** neighbor (scripts on, not just a shell). HUD/`?perfdebug`: p5, live-guest count, present hitch.

**Pass:** p5 ≥ 30 with ≥2 live secondaries on High (or the machine’s High-equivalent). Paste the log in PROGRESS (v4 milestone).

**Fail (p5 < 30):** lower **boot concurrency** first (4 → 2), not live cap, not shells off. Measure again. Do **not** flip promote.

**Not this step:** origin rebase, PhysX on shells, PE scale, goldens.

### 2. Stand-on promote soak — **only after step 1 pass**

**In tree today:** `AOI_STAND_ON_PROMOTE = false`. `World.applyPromoteHandoff` exists. Focus already follows feet onto a live secondary. Soft-route already updates URL/minimap. Origin stays spawn primary.

**Do:** `?aoipromote=1` on a two-parcel walk (leave A, stand on B’s footprint). Check: origin rebase, scene LiveKit is FocusOwner-only, prior primary sticky-demotes (no void), `/reload` still in-play, no parcel warp.

**Pass:** paste walk-log. Then compile-default `AOI_STAND_ON_PROMOTE = true` on `v4`.

**Fail:** keep flag off. Fix the handoff law (bind origin before restore feet). No sticky snap bandaids.

### 3. PE P3 pad/wind — **QA, not a recode**

**In tree today:** P0–P2 🟢. Checklist empty in [`PHYSICS_PARITY_PLAN.md`](./PHYSICS_PARITY_PLAN.md).

**Do:** same official bundle in Explorer and this client. Pad `(0, 50, 0)`, wind X, glide+wind ×1.5 force only, grounded up-force, leave/re-enter latch, teleport reset.

**Pass:** same family of motion. Paste the walk-log block in PHYSICS_PARITY_PLAN.

**Fail:** one **global** factor only (impulse apex → `IMPULSE_CLIENT_SCALE`; wind/lift → `EXTERNAL_SCENE_SCALE`). Never both from one walk. Never a scene-name fork.

### 4. Three goldens — **capture first**

[`PLATFORM_COMPONENT_LAWS.md`](./PLATFORM_COMPONENT_LAWS.md) §10 stays **Open** until one Explorer capture or one unityrenderer commit:

1. Plane UV vs Unity dual-face packing  
2. VirtualCamera lookAt / multi-hop  
3. AvatarAttach local quat vs bone sample  

**Do not** invent extra UV rolls, iso lifts, or attach math from a “looks better” screenshot.

### 5. Graphics leftovers — **optional Unity look, after city**

Numbers already aligned on this branch: Scene Distance default **100** / max **320**; Max Lights **10**.

Still SHORT vs Unity (not Bevy): MSAA+bloom together, shadow cascades, SSAO/SSR/volumetrics/probes, Outline/Jiggle stubs.

**v4 does not require these.** If we pick one look win after soak: cascades **or** MSAA+bloom — not both in one PR.

### 6. Clock observe — **only if a miss shows up**

Invert is 🟢. Observe-only: no-target PET ack **700 ms**; play-frame in-flight safety **2000 ms**.

**Do:** if an official bundle drops an air-click PET, measure the 700 ms race. Do **not** start a second SceneLoop chapter.

---

## Flags (v4)

| Flag | Default | Soak |
| --- | --- | --- |
| `AOI_NEIGHBOR_SHELLS` | true | `?aoishells=0` |
| `AOI_SCENE_DISTANCE_VISUALS` | true | `?aoidisc=0` |
| `AOI_LIVE_GUESTS` | true | `?aoilive=0` |
| `AOI_STAND_ON_PROMOTE` | **false** until step 2 pass | `?aoipromote=1` |
| Scene Distance | default **100 m**, max **320 m** | slider |
| `SECONDARY_LIVE_BOOT_CONCURRENCY` | **4** until step 1 fail | code only |

`?noaoi` still wins.

---

## Exit (v4 chapter, still no tag)

- [ ] Stacked live-guest FPS log pasted (step 1)  
- [ ] Promote either **proven on** or **documented still-off with the fail log** (step 2)  
- [ ] PE P3 checklist filled or explicitly deferred with “no Explorer capture yet”  
- [ ] Goldens still Open unless a capture landed  
- [ ] No product tag (same as v3)

Clock stays 🟢. Far shells stay walk-through.
