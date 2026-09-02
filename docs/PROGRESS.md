# Three.js DCL Client — Progress Log

> Living document. Update after each meaningful milestone.  
> **Pick-up backlog:** [TASKS.yaml](./TASKS.yaml) — claim tasks via [CONTRIBUTING.md](../CONTRIBUTING.md).  
> **Last updated:** 2026-09-02  
> **Current phase:** **`tjs` shaders/CCTV** + **plaza open-world three rings** on **`dev-latest`**. **v2.2.0** on `main`. QA: https://dev.decentraland.social  
> **Shipped:** **`tjs` ECS shaders/CCTV** · **plaza rings** 200 m look · 64 m collide toggle · ~22 m live JS (cap 4) · nested plaza first-class · **v2.2.0** one guest clock · plaza Cast Line walk-log · Genesis sky · Explore live search · **v2.1.0** `/localpreview` · stay-in-play reload · shaders off until Jump In · preview tabs · **v2.0.0** host present · guest VM · instanced city · live neighbors · riding · ECS UI · P2P trade · auth-server join/paint · **v1.7.0** community voice · live polls/Q&A/trivia · pets/Pet Barn · loot bag · AudioAnalysis · FocusOwner · **v1.6.0** Camera Reel · admin tools · **v1.5.0** PART/ROOT · Animator · tours · cast · **v1.4.0** worlds map · AOI · shell.  

> **After 2.2 (`v3` butter — historical):** neighbor composite **shells on** · Landscape + Shadows Distance live · FXAA when bloom is on · GPU warm covers shadow+bloom · stacked live-guest FPS measure. Superseded for open-world policy by plaza rings on `dev-latest` (2026-09-01).  
> **After 2.0 (parked shell):** RTS box-select / pad-drag · saved outfits · create-community / invites · gallery multi-page · Social WS reliability · PE P3 pad/wind QA · multi-shape GLTF `40M+` riding. Scene UI = **one-off bugs only**. Shell marketplace browse ≠ **P2P peer trade**.  

> **Note:** in-world `/goto` via 3D chat is wired (full scene reload). PM LiveKit survives teleports. Community voice LiveKit survives Jump In.  
> **Graphics next (`v3`):** Scene Distance already wired. Landscape + Shadows Distance were stubs — live on `v3`. P4 bloom/HDR shipped; FXAA when bloom kills MSAA. Outdoor washout rebalance is in-tree.  
> **Physics motion:** [COLLIDER_MOTION_POLICY.md](./COLLIDER_MOTION_POLICY.md) · **Riding law:** [RIDING_TRANSFER_LAW.md](./RIDING_TRANSFER_LAW.md) · **Static COD:** [STATIC_COLLIDER_COD.md](./STATIC_COLLIDER_COD.md) · **Multi-scene continuity:** [MULTI_SCENE_CONTINUITY.md](./MULTI_SCENE_CONTINUITY.md) · **PE force plan:** [PHYSICS_PARITY_PLAN.md](./PHYSICS_PARITY_PLAN.md)  
> **Integration checklist:** [INTEGRATION.md](./INTEGRATION.md) · **Community claims:** [CLAIMS.yaml](./CLAIMS.yaml) · **Place analytics:** [CREATOR_ANALYTICS.md](./CREATOR_ANALYTICS.md)
>
> **Toast convention:** Each shipped milestone starts with `### What's new` + short user-facing bullets.
> Version toast shows the **latest** block when `APP_VERSION` changes.
> `WHATS_NEW_PERSIST_ACK = true` — dismiss writes `threejs-client:lastSeenVersion`.

---

## Milestone — `tjs` ECS component (2026-09-02)

**Status: on `dev-latest`.** Scene-defined custom component `tjs` for shaders and projection screens. Scene API: [README Shaders](../README.md#shaders).

### What's new

- **`tjs` component** — one mirrored LWW component; `kind` is a string: `shader`, `texture`, `camera`, `projection`
- **Shaders** — load when the row appears; ice / meteor / hail use `name`; fire with `enabled: true` (new row per one-shot cast)
- **Projection screens** — lens: Transform + SDK `VirtualCamera` + `kind: camera` (`layers` "0,1,2", `fov`, `background` Color4). Screen: Transform + `kind: projection` with `camera` = the **lens entity** (not a number). UI: `UiBackground.texture.src = tjs:${cam}`. Each camera is a full extra world render (keep the count small). Toggle `tjs.getMutable(screen).enabled`.
- **`texture` kind** — reserved; unused for CCTV

| Area | Status | Notes |
| ---- | ------ | ----- |
| **tjs mirror + bridge** | 🟢 | `src/dcl/ecs/tjsComponent.ts` + `SceneTjsBridge` |
| **Shader one-shot** | 🟢 | `enabled: true` fires once per distinct payload |
| **CCTV camera + projection** | 🟢 | layers 0,1,2; fov; Color4 background; world plane + UI tjs:src; extra cameras cost FPS |

---

## ✅ Milestone — Plaza open-world three rings (2026-09-01)

**Status: on `dev-latest`** — squash-merge PR #73 (`f14c7f34`). Product law for Genesis CBD / nested plaza walks.

Open-world loading is **three rings**. Distance is always **player → that scene’s occupied footprint** (empty land and roads excluded). Nested plaza parcels (Hockey, BrandonManus, Spring in the Snow, Jarod, …) are first-class — no `coveredSkip` hiding inner estates.

### What's new

- **200 m look** — neighbor scene GLBs load with their textures (not on-demand beige shells). Scene Distance preference no longer clips Winterfest / nested plaza neighbors to the collide arm.
- **64 m collide** — enable/disable already-cooked PhysX hulls. No recook, no compact, no first-walk expand of 16+ shape families into hundreds of shapes. Walk inside a plaza must not hitch on PhysX expand.
- **~22 m live JS, cap 4** — under-feet always runs. Nested plaza scenes are live guests. **Parcel count never gates JS.** Boot concurrency 1; closer guests win the cap (Spring at ~7 m beats Mewland at ~22 m). First-frame sampling does not consume a live slot. Reconcile retries after the exclusive boot slot frees. LiveKit hold on same-primary plaza walk (no remount/rejoin). Splash ghost overlay after unmount is purged.

| Area | Status | Notes |
| ---- | ------ | ----- |
| **Look ring** | 🟢 200 m | `AOI_VISUAL_LOOK_RADIUS_M` · GLBs + textures · nested plazas not skipped |
| **Collide ring** | 🟢 64 m toggle | `NEIGHBOR_SCENE_PHYS_COLLIDE_RADIUS_M` · cooked hulls enable/disable only |
| **Live JS ring** | 🟢 ~22 m enter, cap 4 | `secondaryLiveEnterRadiusM()` · boot concurrency 1 · nearest footprint wins |
| **Parcel-count gate** | 🟢 off | Budget = distance + cap + boot slot — never parcel size |
| **Stand-on promote** | 🟢 on | `AOI_STAND_ON_PROMOTE` · handoff + sticky demote · origin rebind |
| **SceneLoop clock** | 🟢 | Unchanged since v2.2.0 |

**QA:** https://dev.decentraland.social — walk plaza → nested Spring in the Snow (~7 m) → confirm `[multi-scene] secondary live "Spring in the Snow"` · Winterfest / neighbors visible to 200 m with textures · no PhysX hitch on first plaza step · same-primary walk does not bounce LiveKit.

**Open leftovers (honest):** small PhysX CCT parent→1 expands still log (not a merge stopper). Official `npm run build` `tsc` `noUnusedLocals` cleanup (`ROAD_PHYS_RADIUS_M`, unused `key`/`px`/`py`) may still be in flight on a local Mac — not claimed merged here.

**Tip:** Three rings are **our** open-world implementation on `dev-latest`. Older docs that say shells-only / promote-off / 80 m cliff describe pre–PR #73 state.

---

## ✅ Milestone — v3 Explorer butter (shells · P3 distances · AA · warm) (2026-08-19)

**Status: historical (`v3` branch era).** Superseded for open-world policy by plaza three rings on `dev-latest` (2026-09-01). Post-2.2 city/look butter. Clock stays 🟢.

### What's new (parity / implementation — no version toast)

- **Docs tell the truth** — SceneLoop 🟢 / v2.2.0 shipped; live guests on; shells on `v3`; P3 landscape/shadows were stubs
- **Landscape + Shadows Distance** — sliders persist and drive grass LOD + sun ortho / caster keep
- **FXAA when bloom is on** — MSAA still zeros on the Unreal path; edges via FXAA. Bloom mode is honored
- **Adaptive quality default off** — no look-pop from one 28 FPS window. FPS Max is display rAF
- **GPU warm** — dummy presents run shadow + bloom so first orbit is not a new program
- **Neighbor shells default-on** — `AOI_NEIGHBOR_SHELLS = true`; `?aoishells=0` / `?noaoi` remain. One clone per leftover drain
- **FPS soak** — protocol only; boot concurrency stays 4 until a pasted p5 < 30

| Area | Status | Notes |
| ---- | ------ | ----- |
| **SceneLoop** | 🟢 | Unchanged since v2.2.0 |
| **Neighbor shells** | 🟢 default-on | Walk-through extract; no PhysX |
| **Stand-on promote** | ⬜ off (2026-08-19) | Superseded — on `dev-latest` since PR #73 |
| **Stacked FPS** | measure-only | No cap flip without a log |
| **P3 Landscape / Shadows Distance** | 🟢 | Scene Distance was already live |

**QA:** `?aoishells=0` dirt vs shells on · Landscape/Shadows sliders change grass pop and shadow reach · bloom on is not smeared · Jump In first orbit.

**Tip:** Do not retune PE scale. Do not flip promote on this branch.

---

## 🎉 Milestone — v2.2.0 release (one guest clock) (2026-08-19)

**Status: release cut** — `dev-latest` → `main` · tag `v2.2.0`.

v2.1 shipped preview and shaders and left the invert clock yellow. v2.2 is that clock: after the first play-frame, only named sources `play-frame` | `pointer-edge` start `engine.update(dt > 0)`. Proven on Genesis Plaza Cast Line. Also in this cut: sky, Jump Zone text, Explore people search, wallet display name, and the 2.1.x official-scene QA that was already on `dev-latest`.

### What's new

- **One guest clock** — scene JS ticks on SceneLoop only (`play-frame` | `pointer-edge`)
- **Pointer + Tweens + timers** — Cast Line, bobber, and Fishing_Idle run on real guest `dt`
- **Genesis sky** — camera-ray skybox; no zenith meridians; moon disc clipped
- **Jump Zone text** — TextShape hang, plane UVs, emissive blend
- **Explore search** — live players by name; Jump In goes to them
- **3D menu** — Explore 2nd, Map 3rd; Places lives on Explore
- **Wallet display name** — edit on settings and passport; guests stay Guest-xxxx
- **Plaza / Snow Drift / `/goto`** — UI borders, snow step, avatar GPU cache, ability VFX prime

| Area | Status | Notes |
| ---- | ------ | ----- |
| **SceneLoop invert clock** | 🟢 | Walk-log 2026-08-19 plaza Cast Line e3385 + `Fishing_Idle` + `BITING STEP`. Dual-clock landmine sealed (PR-2). [SCENELOOP_COMPLETION.md](./SCENELOOP_COMPLETION.md) |
| **Local preview / shaders (2.1)** | 🟢 | Unchanged |
| **Host world (2.0)** | 🟢 | Unchanged |
| **Stacked-neighbor FPS** | measure-only | Not the 2.2 headline |

**QA:** plaza Cast Line (`?sceneloop=1`) · Snow Drift walk · Explore name search · wallet name edit · Genesis sky look-up.

**Known leftover:** plaza `beggar_rod.glb` hash miss (fishing still casts). CCT unstick after a wall slam is new in this cut.

**Tip:** `v2.2.0` on `main`. Neighbor FPS / residency stay on `dev-latest`.

---

## ✅ Milestone — SceneLoop invert clock proven (2026-08-19)

**Status: folded into v2.2.0.** Dual-clock landmine sealed (PR-2 / #66). Walk-log pasted on Genesis Plaza (`?sceneloop=1`): Cast Line PET on authored entity `3385`, bobber at the hit, `Fishing_Idle` ~1 s later, `BITING STEP` at +11 s. No `dt=0.000`. Sources only `play-frame` | `pointer-edge`. [SCENELOOP_COMPLETION.md](./SCENELOOP_COMPLETION.md).

### What's new (parity / implementation — no version toast)

- **SceneLoop 🟢** — one guest clock proven on an official bundle (pointer + Tween/timer path + named sources)

| Area | Status | Notes |
| ---- | ------ | ----- |
| **SceneLoop invert clock** | 🟢 | Walk-log 2026-08-19 plaza Cast Line e3385 + `Fishing_Idle` + `BITING STEP`. Landmine sealed. |
| **Release** | 🟢 | Shipped as **v2.2.0** |

**Tip:** Proof record. The product cut is the v2.2.0 milestone above.

---

## ✅ Milestone — platform QA after 2.1 (Snow Drift · plaza · `/goto` · VFX warm) (2026-08-18)

**Status: folded into v2.2.0.** Official-scene QA after the 2.2 clock PRs (#64–#69). SceneLoop flipped 🟢 on the 2026-08-19 walk-log.

### What's new (parity / implementation — no version toast)

- **Yoga / scene UI** — Explorer-only borders when width > 0; visibility is `display` + opacity (no off-canvas Yoga hide); Layer `showFrom` hold + paint follow-up
- **Snow Drift walk** — MeshRenderer-only snow cubes recook on shrink; tile GLB 0.5 m floors; CCT step 0.55; do not cook MeshRenderer primitives as physics
- **Plaza** — mural `Texture.Common` ST reset; hair slot-wide tint; chat bubble above name; emote prop meshes shown; `?sceneloop` log throttle
- **`/goto` avatar** — drop parsed AssetCache GPU objects when the play renderer dies; wearable/emote cache keys isolated; `dclAvatarMatte` skips outdoor remap / COLOR_0
- **Play shader warm** — `compileAsync` after play lighting/fog/IBL; first-orbit hitch reduced
- **Ability VFX** — prime ice/meteor on the overlay (Ability groups only — no second grass compile); pool 50; **no client fire gate** (scene spawn is law)

| Area | Status | Notes |
| ---- | ------ | ----- |
| **SceneLoop invert clock** | 🟢 | Walk-log pasted 2026-08-19 (see milestone above). Dual-clock landmine sealed. |
| **`/goto` local avatar** | 🟢 | GPU epoch invalidate on World dispose |
| **Ice / Cinder first cast** | 🟢 overlay prime | First Ice may still hitch once if world mats first see VFX PointLights |
| **Release** | 🟢 | Folded into **v2.2.0** |

**QA:** Snow Drift UI swipe + snow step · plaza mural / hair / chat / Zaara props · `/goto lastraum` avatar stays textured · Ice Storm first click after load · Cinder mash (scene owns spam; pool recycles at 50).

**Tip:** Historical 2.1 QA cut. SceneLoop later proven 2026-08-19.

---

## 🎉 Milestone — v2.1.0 release (local preview · shaders) (2026-08-17)

**Status: release cut** — `dev-latest` → `main` · tag `v2.1.0`.

Create in the tab. Same host world as 2.0. New: stay-in-play reload, preview rooms, and Tag-driven shaders on this client.

### What's new

- **`/localpreview`** — jump straight into play; no 2D landing bounce
- **Hot reload stays in play** — Creator Hub / sdk-commands recycle the current parcel (Unity-style, not a teardown)
- **In-place `/reload`** — same recycle
- **Preview tabs** — extra tab, guest avatar, same-session identity; RFC-5 `ws-room` only when `/about` says so
- **Shaders** — Tag create is the cast; `tjs.ice.spawn(ox, oy, oz, dx, dy, dz, dist)` is `ability.spawn`
- **Shaders default local** — add sibling Tag `tjs.sync` if other ThreejsClient tabs should see that one shot. Not `syncEntity`. Not Unity/Bevy.
- **Shaders stay off until Jump In** — landing does not load World / AbilityManager; only named `tjs.shader` / `tjs.vfx` ids boot
- **Compact debug panel**

| Area | Status | Notes |
| ---- | ------ | ----- |
| **Local preview / reload** | 🟢 | Stay in play · current-parcel recycle |
| **Tags shaders** | 🟢 this client | Load + spawn Tags; `tjs.sync` opt-in |
| **Preview comms** | 🟢 | RFC-5 when advertised; prod stays LiveKit |
| **SceneLoop invert clock** | 🟡 | Dual-clock landmine sealed (PR-2). Play-frame `source`/`dt` log + HUD last guest dt in (PR-3). Walk-log **not pasted** — do not flip 🟢. [V2.2_BEVY_PARITY.md](./V2.2_BEVY_PARITY.md) · [SCENELOOP_COMPLETION.md](./SCENELOOP_COMPLETION.md) |
| **Host world (2.0)** | 🟢 | Unchanged |

**QA:** `/localpreview` two tabs · ice/cinder/hailwraith after hot reload · Genesis walk · plaza clicks · published-world `/reload`.

**Tip:** `v2.1.0` on `main`. Shaders are this client only.

---

## 🎉 Milestone — v2.0.0 release (host world · city walk) (2026-08-14)

**Status: release cut** — `dev-latest` → `main` · tag `v2.0.0`.

Two months after the July “full client in a tab” post. Same SDK7 scenes. The tab is now the one you walk without thinking about the client.

### What's new

- **Walk feels finished** — Genesis and Worlds stay up; plaza is not a slideshow
- **Host world** — one present path; scene JS is a guest VM on a host clock
- **Instanced city** — static GLBs instance; no 2,000-mesh autoplay clone storm
- **Live neighbors** — composite shells + live guests; Focus follows feet; textures per scene
- **Community voice** — join muted, raise hand, mods; Jump In keeps the room
- **Live polls / Q&A / trivia** — plus CSV when a session ends
- **Pets + Pet Barn** · **Loot bags** · **AudioAnalysis**
- **Stay in the city** when you cross parcels (FocusOwner, no full unload)
- **Platform riding** · **CCT ground** (walk off a pad, you fall) · **doors that open**
- **In-scene ECS UI** smoke-pass
- **In-world P2P wearable trade** — invite → dual offer → on-chain settle
- **Chat that survives teleports** · **custom VRM**
- **Auth-server games** — mid-round maze, colliders, join, and paint
- Terrain editor, 2D shell, and contribute-from-inside-the-client still here

| Area | Status | Notes |
| ---- | ------ | ----- |
| **Host present / guest VM** | 🟢 | [ARCHITECTURE.md](./ARCHITECTURE.md) |
| **City instancing + residency** | 🟢 | Shells + live guests · Focus = feet |
| **World-feel** | 🟢 | Riding · CCT · PART · lighting |
| **Social / tools (1.7)** | 🟢 | Voice · live tools · pets · loot |
| **P2P trade** | 🟢 | Not shell marketplace catalog |
| **Auth-server join/paint** | 🟢 | CUSTOM_EVENT drain + reserved identity |
| **Stacked-neighbor FPS** | 🟡 | Density pass after this cut |
| **RTS box-select / pad-drag** | 🟡 | Edge |

**QA:** Genesis walk + neighbor parcels · plaza FPS · community voice Jump In · P2P trade two wallets · PixelWars mid-round maze + paint + walk flip · Worlds Jump In.

**Tip:** `v2.0.0` on `main`. Quote the July tab post; this is month two.

---

## ✅ Milestone — PART thrash + plaza polish + UI smoke-pass → `dev-latest` (2026-08-10)

**Status: on `dev-latest` — not a product release.** In-scene ECS UI marked **production / smoke-pass** (structure complete; one-off scene bugs only). PART curtain/door hulls + collider cook thrash closed; plaza marquee / JUMP IN / sit hips.

### What's new (parity / implementation — no version toast)

- **In-scene ECS UI → 🟢** — Yoga + DOM path is smoke-pass; matrix no longer tracks Ui* as partial platform work
- **PART curtains/doors** — settle after Open · multi-shape doneIds via `hasStaticActor` · no pose-fp wipe thrash · walk-through when open without 13 FPS re-expand
- **Primitive MeshCollider cook** — drain no longer drops box/sphere/etc. as “empty” (e568 Missing-actors loop)
- **Plaza** — NeonScreen TextureMove pause hold · JUMP IN L–R corners · MeshRenderer marquee UVs · sit emote hip retarget
- **Plaza FPS baseline** — bloom/adaptive cook give-up (with thrash kill above)

| Area | Status | Notes |
| ---- | ------ | ----- |
| **In-scene ECS UI** | 🟢 smoke-pass | One-off bugs only |
| **PART / cook thrash** | 🟢 | Curtains e541 · primitive e568 |
| **Plaza boards / sit** | 🟢 | Marquee · JUMP IN · hips |
| **Release** | ⬜ not yet | `main` stays **v1.7.0** |

**QA:** PIP curtains open → walk through · no `Missing actors ids=[568]` loop · plaza marquee pause · JUMP IN readable · sit on bench · FPS with `?colliders` stable.

**Tip:** On `dev-latest`. **Not** tagged for release.

---

## ✅ Milestone — In-world P2P wearable trade → `dev-latest` (2026-08)

**Status: on `dev-latest` — parity+ headline for 1.8** (not Explorer-required; ThreejsClient differentiator). Full peer trade loop in-client — not a shell marketplace catalog.

### What's new

- **P2P in-world trade** — context-menu invite → countdown → dual inventory offer window → offer sync over PM · **on-chain settle** (EIP-712 sign by inviter, `accept()` by invitee)
- **Marketplace index assist** — Foundation index brief for settle path (`marketplaceSettle` / config)
- **Received-item cache** — session storage for post-settle inventory lag

| Area | Status | Notes |
| ---- | ------ | ----- |
| **Invite + dual offer UI** | 🟢 | `TradeController` · `TradeWindow` · modals |
| **Wire / PM sync** | 🟢 | `tradeWire` + private-messages path |
| **On-chain settle** | 🟢 | Polygon settle path |
| **Shell marketplace browse** | ⬜ separate | Outfits / catalog shop still open product |

**QA:** two wallets in-world → invite trade → both lock offers → settle → wearables move · inventory reflects after settle.

**Files:** `src/client/ui/trade/*` · `src/social/tradeWire.ts` · `docs/dcl-foundation-marketplace-index-gap.md`

**Tip:** Headline **1.8** feature alongside world-feel stack — not “misc social+.”

---

## ✅ Milestone — Platform riding + lighting + scene-http parity gaps → `dev-latest` (2026-08-09)

**Status: merged to `dev-latest` — not a product release.** Closes Explorer-parity implementation gaps (MeshCollider movers, CCT ground, CORS egress, TextShape measure, outdoor washout). Repro class: parent-driven MeshCollider floors (e.g. `brainrot.dcl.eth` — scene is a repro, not a fork).

### What's new (parity / implementation — no version toast)

- **MeshCollider platform riding (law)** — stand surface treats raw ECS MeshCollider phys ids; ROOT transform dirty expands to collider-bearing descendants; **one** stand-actor slide Δ before CCT `move()` ([RIDING_TRANSFER_LAW.md](./RIDING_TRANSFER_LAW.md))
- **No sticky / snap / pull-down** — removed multi-frame sticky Δ, residual feet snap, and post-float pull-down (bandaids deleted; law refactored)
- **Cylinder / sphere CCT cook** — DCL cylinder → Y-up capsule (or box if flat); half-height excludes caps; `nonWalkableMode = PREVENT_CLIMBING_AND_FORCE_SLIDING`
- **Grounded ⇔ walkable support under capsule** — `eCOLLISION_DOWN` alone is not enough; freefall + gravity when walking off elevated pads over lower floors
- **Generic scene HTTP egress** — `/api/scene-http/<https|http>/<host>/<path>` for worker `fetch` + SignedFetch (leaderboards etc.); one nginx block, not per-game APIs ([DEPLOYMENT.md](./DEPLOYMENT.md))
- **TextShape width law** — content-size when width omitted; no invented 1 m cap that clips long HUD text
- **Outdoor washout close** — solid neon keeps toneMapped + emissive cap; bloom FAST_THRESHOLD **0.92**; softer day hemi/equator; default exposure/sun rebalance ([COD_LIGHTING_PARITY_FANOUT.md](./COD_LIGHTING_PARITY_FANOUT.md))
- **PointerEvents PE pose** — refresh PE pose path for elevated / pedestal targets
- **Terrain biome seeds** (same branch stack) — full-footprint starters, water seafloor, archipelago, reset heights / paint clear

| Area | Status | Notes |
| ---- | ------ | ----- |
| **Platform riding** | 🟢 gap closed | Parent→child MeshCollider bob; single actor Δ |
| **CCT ground law** | 🟢 gap closed | Walk off elevated → freefall; no air-hover |
| **scene-http proxy** | 🟢 | Dev Vite + prod nginx; `sceneHttpProxy.ts` |
| **TextShape measure** | 🟢 | Content width; no fake 1 m |
| **Lighting washout** | 🟢 gap closed | Neon + bloom + ambient; Explorer midday closer |
| **Multi-shape GLTF 40M+ ride** | 🟡 follow-up | Not required for MeshCollider pad class |
| **PE P3 pad/wind QA** | 🟡 open | Manual vs Explorer still open |
| **Release** | ⬜ not yet | No version cut / toast; `main` stays **v1.7.0** |

**QA (platform, not scene-named):** bobbing MeshCollider floors track tread (no multi-meter loft) · walk off elevated pad lands lower floor · PLAY / PE on pedestal · SignedFetch leaderboard via scene-http · long TextShape HUD readable · Genesis midday less chalk.

**Docs:** [RIDING_TRANSFER_LAW.md](./RIDING_TRANSFER_LAW.md) · [PLAN_MESHCOLLIDER_PLATFORM_RIDING.md](./PLAN_MESHCOLLIDER_PLATFORM_RIDING.md) · [COD_BRAINROT_PLATFORM_FANOUT.md](./COD_BRAINROT_PLATFORM_FANOUT.md) · [COLLIDER_MOTION_POLICY.md](./COLLIDER_MOTION_POLICY.md) · [COD_LIGHTING_PARITY_FANOUT.md](./COD_LIGHTING_PARITY_FANOUT.md) · [AGENTS.md](./AGENTS.md) (refactor-the-law + scene-bundle-is-law)

**Tip:** On `dev-latest` after merge. **Not** tagged for release.

---

## 🎉 Milestone — v1.7.0 release (Community voice · live tools · pets · AOI) (2026-07-31)

**Status: release cut** — `dev-latest` → `main` · tag `v1.7.0`.

Explorer **parity** + ThreejsClient **parity+** since **v1.6.0**. Tour photos / Camera Reel already shipped in **1.6** (not re-listed as new).

### What's new

- **Community voice chat** — start / join muted / request to speak / promote / demote / reject / kick / end
- **Last-mod leave ends** the voice room for everyone
- **Realtime voice discovery** — PM LiveKit topic + Social WS (no REST poll); gatekeeper fallback
- **Jump In keeps community voice**; **PM LiveKit kept across teleports**
- **Live polls** — place-owner host opens multi-choice polls in-world; guests vote from the place
- **Live Q&A** — host runs an open question inbox; guests ask from the scene
- **Live trivia** — host runs multi-question trivia rounds with guest answers
- **CSV download logs** when ending any live-tools session (`poll-stats` / `qa-stats` / `trivia-stats`)
- **Multiplayer pets** + **Pet Barn marketplace** — walk/fly follow, catalog, publish dispatch
- **Loot Bag** — deposit grid, multi-item NFT bundles, 3D pack model
- **`~system/EnvironmentApi`** + **`~system/Testing`** — real modules (no empty Proxy)
- **AudioAnalysis (1212)** — host FFT for AudioSource / Stream / progressive video
- **Multi-scene FocusOwner continuity** — promote handoff + sticky demote; secondary Animator pump
- **Primary full-rate animators** (+ Graphics Advanced toggle) · **AOI warm band** polish
- **Tour** leader keep-alive, force-end, rejoin, Focus camera snap

| Area | Status | Notes |
| ---- | ------ | ----- |
| **Community voice** | 🟢 | Social v2 + gatekeeper · dual-path discovery · 2D pill + in-play card |
| **Live tools** | 🟢 | Polls · Q&A · trivia · end-session CSV |
| **Pets / Pet Barn** | 🟢 | MP companions · marketplace · publish Worker |
| **Loot Bag** | 🟢 | Deposits · bundles · 3D pack |
| **EnvironmentApi / Testing** | 🟢 | Last ~system gaps closed |
| **AudioAnalysis** | 🟢 | Host FFT 1212 |
| **AOI / multi-scene anim** | 🟢 | Continuity + full-rate primary + secondary pump |
| **Tour photos / gallery** | 🟢 | Already in **v1.6.0** |

**QA (release smoke):** community voice start/join/promote/Jump In keep · live poll vote + end CSV · Q&A + trivia session · pets + Pet Barn catalog · loot bag claim · Genesis walk secondary anim · plaza solids.

**Tip:** `v1.7.0` on `main`. **1.8** targets scene UI + PE polish.

---

## ✅ Milestone — Community voice parity → `dev-latest` (2026-07-31)

**Status: merged `feat/community-voice-parity` → `dev-latest`** (`6be3a9d`) — Explorer-aligned community voice end-to-end.

### What's new

- **Join as listener** — Social v2 + gatekeeper; everyone joins **muted** (unmute from UI)
- **Request to speak / lower hand** · **Mods: Accept / Reject / Promote / Demote / Kick**
- **Start / End for everyone** · **last remaining mod Leave ends stream** (even if non-mod listeners remain)
- **Realtime discovery (no active-stream poll)** — dual path:
  1. **PM LiveKit** topic `d3js-community-voice` (guest + wallet; same room as pool claims)
  2. **Social WS** `SubscribeToCommunityVoiceChatUpdates` (best-effort; reconnect on dead transport)
- **Instant fan-out** — toast · ACTIVE VOICE row · modal Join without REST polling
- **2D floating pill** — bottom-anchored mute / volume / leave · participant roster popup with mod actions
- **In-play voice card** — independent purple card above chat (pets chrome); accordion Speakers/Listeners horizontal avatars; chat height shrinks; rail = chat only
- **Jump In keeps session** — community voice LiveKit is separate from World; pill hidden in 3D; controls on chat card
- **PM LiveKit across teleports** — play-session retain (earlier on branch)
- **Loading overlay** above all scene UI + voice chrome

| Area | Status | Notes |
| ---- | ------ | ----- |
| **Social v2 RPCs** | 🟢 | start · join · request · promote · demote · reject · kick · mute · end |
| **PM dual-path discovery** | 🟢 | wire `communityVoiceWire` · bus publish/retransmit |
| **Social WS bus** | 🟢 | shared singleton; invalidate zombie RPC on drop |
| **Gatekeeper fallback** | 🟢 | signed-fetch create/join + speak/speaker/kick REST |
| **2D UI** | 🟢 | floating bar · communities browse ACTIVE VOICE · modal roster |
| **3D UI** | 🟢 | `ChatPanel` voice card (purple) · mute-on-join |
| **Teleport / Jump In** | 🟢 | PM retain · community voice keep · bar hide in-play |

### Remaining community / voice gaps (not this ship)

| Gap | Notes |
| --- | ----- |
| **Create community / invites** | Shell CTAs still “coming soon” |
| **Social WS long-lived streams** | Still flaps (`RPC Transport closed`); PM dual-path covers voice **discovery**; friend connectivity retries |
| **Service Bearer gatekeeper** | OpenAPI lists Bearer for some GK routes; client uses signed-fetch + Social RPC (working path) |
| **Spatial community voice** | Nearby voice is spatial; community voice is flat LiveKit media room (Explorer-like) |

**QA:** Two clients (wallet + guest) → start voice → other sees toast + ACTIVE VOICE → Join listener muted → promote → last-mod Leave ends for all → Jump In keeps audio · open chat for in-play card.

**Tip:** `6be3a9d` on `dev-latest`.

---

## ✅ Milestone — AudioAnalysis host fill (1212) (2026-07-31)

**Status: landed on `dev-latest`** — last incomplete non-UI ECS write path closed.

### What's new

- **`AudioAnalysisBridge`** — same-entity as AudioSource / AudioStream / VideoPlayer
- Parallel **WebAudio AnalyserNode** on `THREE.Audio.gain` (pre-panner; audible path unchanged)
- **MODE_RAW** + **MODE_LOGARITHMIC** with docs gains (5 / 0.05); quantize + dirty-only LWW
- **HLS / LiveKit video → zeros** (Explorer parity)
- Cap **8** active analysers; FocusOwner media mute clears taps

| Area | Status | Notes |
| ---- | ------ | ----- |
| **AudioSource / Stream** | 🟢 | FFT while PLAYING |
| **Progressive Video** | 🟢 | Spatial or analysis WebAudio graph |
| **HLS / LiveKit** | 🟢 | zeros (Explorer) |
| **Encoder + inject 1212** | 🟢 | Host LWW path |

---

## ✅ Milestone — ~system EnvironmentApi + Testing (2026-07-31)

**Status: landed on `dev-latest`** — closes the last two backburner `~system` modules.

### What's new

- **`~system/EnvironmentApi`** (SDK6-compat) — `getBootstrapData`, `isPreviewMode`, `getPlatform`, `areUnsafeRequestAllowed`, `getCurrentRealm`, `getExplorerConfiguration`, `getDecentralandTime` from scene boot + realm RPC
- **`~system/Testing`** — real module for `@dcl/sdk/testing`: `plan`, `logTestResult` (console), `setCameraTransform` host RPC + freecam hold + reserved CameraEntity inject; `takeAndCompareScreenshot` stub (`storedSnapshotFound: false`)

| Area | Status | Notes |
| ---- | ------ | ----- |
| **EnvironmentApi** | 🟢 | No longer empty Proxy fallback |
| **Testing** | 🟢 | Screenshot compare deferred (no baseline store) |
| **Registry** | 🟢 | `sys:environment-api` / `sys:testing` → render |

**Tip:** Integration matrix — zero `~system` gaps.

---

## ✅ Milestone — Multi-scene FocusOwner continuity → `dev-latest` (2026-07-26)

**Status: merged `feat/aoi-focus-owner` → `dev-latest`** — continuity contract landed; FPS still hardening under dual secondary load. Shipped in **v1.7.0**.

### What's new (platform)

- **No unload on parcel walk** — promote = handoff + sticky demote only (never dispose + seamless jump for stand-on-parcel)
- **Resident modes** — primary FocusOwner · secondary muted full scripts · tertiary scripts-off LOD (leave-ring / cap only)
- **No parcel-size gate** — parcel count never refuses secondary boot or forces tertiary
- **Sticky colliders kept** — remapped PhysX one-shot; dirty-once + `allRegisteredPhysIds` (no wipe/recook 3fps death spiral)
- **Origin rebind** — `bindSceneTarget` before feet restore (soft-route warp fixed)
- **AOI continuity** — default ground everywhere non-road; no scatter on real/resident parcels
- **Freecam durable** — player orbit survives promote; VC never reseeds freecam
- **AvatarModifier / CameraMode primary-only** — demote clears hide + forced camera

| Area | Status | Notes |
| ---- | ------ | ----- |
| **Sticky demote** | 🟢 | Always secondary on demote; never dispose prior primary |
| **Promote handoff** | 🟢 | Live secondary adopt + origin rebind + settle window |
| **Tertiary LOD** | 🟢 | Ring/cap only — no parcel-size tertiary |
| **Sticky PhysX keep** | 🟢 | Dirty-once + registered-id tracking |
| **Freecam / FocusOwner** | 🟢 | Durable freecam · primary-only modifiers |
| **CBD ring FPS** | 🟡 | Cap ≤3 + serial boot; dual live still expensive |
| **Docs** | 🟢 | [MULTI_SCENE_CONTINUITY.md](./MULTI_SCENE_CONTINUITY.md) · [STATIC_COLLIDER_COD.md](./STATIC_COLLIDER_COD.md) |
| **Static COD seal** | 🟢 | Never `forceDynamicTreeRebuild` / reinsert-all; extract once + cook missing; seal freezes thrash |

**QA (branch smoke):** CBD → nested scene → CBD colliders + freecam · soft parcel URL · no tree scatter on plaza · no continuous Missing-actors thrash · plaza `sweepFeetY` not MISS after seal.

**Tip:** Continuity in [MULTI_SCENE_CONTINUITY.md](./MULTI_SCENE_CONTINUITY.md); static cook-once in [STATIC_COLLIDER_COD.md](./STATIC_COLLIDER_COD.md). Branch: `feat/aoi-focus-owner`.

---

## 🎉 Milestone — v1.5.0 release (Collider PART platform · Animator · avatar compose · social) (2026-07-23)

**Status: release cut** — `dev-latest` → `main` · tag `v1.5.0`.

### What's new

- **Collider motion platform** — two sources only: **Transform → ROOT** (cook once, actor T+R) · **Animator → PART** (world-cook when hull pose changes). See [COLLIDER_MOTION_POLICY.md](./COLLIDER_MOTION_POLICY.md)
- **Ice-rink doors** — bone/`_collider` panels track open/close; CCT walks through when open
- **Genesis Plaza solids** — no soft-floor thrash; PART only when a clip is running and coarse hull fp moves
- **Animator** — Explorer-style open/close hold; no SyncEntity snap-to-end; playing=false holds correct keyframe
- **Landing** — LiveKit cast stream **audio** on 2D stage; Manage place (streams / bans / multiplayer storage)
- **Avatar / perf** — crowd path, adaptive quality, jump mesh pin, remote stagger; **compose hides + face-only backfill** (Explorer underwear slots)
- **Social** — community follow tours, Tour Focus POV, tour flag/roster, smoother remotes

| Area | Status | Notes |
| ---- | ------ | ----- |
| **PART / ROOT colliders** | 🟢 | `applyPartColliderMotions` · coarse fp gate · running-clip only |
| **Plaza soft regression** | 🟢 | No unbounded live-bake; RAM settles after load |
| **Animator hold / SyncEntity** | 🟢 | Door hold + network re-dirty safe |
| **Cast landing audio** | 🟢 | 2D stage LiveKit playback |
| **Follow tours** | 🟢 | Leader flag · Focus POV · roster |
| **Avatar crowd + compose** | 🟢 | Stagger · hide attached wearables · face/hair backfill only |

**QA (release smoke):** Genesis Plaza solids · ice-rink door · PE pads · 2D cast audio · jump/remotes · follow tour when available ✅

**Tip:** `v1.5.0` on `main`.

---

## 🎉 Milestone — v1.4.0 release (Custom worlds · Worlds map · AOI · shell UI) (2026-07-22)

**Status: release cut** — `dev-latest` → `main` · tag `v1.4.0`.

### What's new

- **Custom worlds** — deep links (`?realm=` + `worldName=`), solo/LiveKit, custom landing labels, favourites, load reliability
- **Worlds map** — Explorer-style A–Z world grid next to Genesis Plaza; View hover + red Jump In modal
- **Area of Interest** — Genesis multi-scene AOI with surrounding scene visibility (roads + first-frame secondaries)
- **Notifications + credits** — sidebar notifications inbox and marketplace weekly rewards panel
- **Emote wheel / backpack** — rarity gradients, thumbnails, E opens Emotes; wearables-parity emote grid
- **Shell UI** — overlay/backpack redesign, 2D↔3D toggle, auth reliability fixes
- **Avatar / graphics** — opt-in toon shading, skeleton/hides polish, brow + facial hair colors
- **Place analytics** — public landing stats (`build:prod`); plain build keeps analytics off

| Area | Status | Notes |
| ---- | ------ | ----- |
| **Custom worlds** | 🟢 | Routing · LiveKit optional · deploy-meta landing · env defaults |
| **Worlds map + modal** | 🟢 | Places catalog · live occupancy · Jump In → world |
| **Genesis AOI** | 🟢 | Multi-scene visibility · Explorer roads |
| **Notifications / credits** | 🟢 | Signed notifications API · seasons/credits |
| **Emote wheel** | 🟢 | Rarity · thumbs · E→backpack emotes |
| **PE HUD flash** | 🟢 | Paint thrash + force-dismiss fixes |
| **Place analytics** | 🟢 | Landing charts · prod flag |

**QA (release smoke):** custom world deep link + Jump In · Worlds map View→modal · Genesis AOI neighbors · notifications/credits wallet · emote wheel + E · plaza load · auth 2D/3D.

**Tip:** `v1.4.0` on `main`.

---

## 🎉 Milestone — Public place analytics (landing stats) → `dev-latest` (2026-07-19)

**Status: merged `lastraum` → `dev-latest`** — opt-in presence analytics (no Privy MAU), public stats on scene landing, Node/JSONL ingest + optional Supabase mirror.

### What's new

- **Landing bar-chart control** — next to owner settings gear; **anyone** can open place stats (not creator-only)
- **Metrics** — landing views, uniques, jump-ins, jump-in rate, median time on landing + in world, multi-visit, 7d dual bars (landings / jump-ins) with hover counts
- **Client emit** — `npm run build:prod` enables analytics; plain `npm run build` keeps it off (staging/local)
- **Dwell** — landing page time (`landing_leave`) and in-world session time (`scene_leave` + heartbeats)
- **Backend** — `POST /api/analytics/events`, `GET /api/analytics/places/:placeKey/summary`; Vite dev middleware; prod PM2 + nginx → `:8787`
- **Optional Supabase** — service-role mirror of `place_events` (browser never holds secrets)

| Area | Status | Notes |
| ---- | ------ | ----- |
| **Landing stats UI** | 🟢 | `ScenePlaceStatsModal` · public aggregates only |
| **Event pipeline** | 🟢 | `src/analytics/*` · login / landing / jump-in / goto / dwell |
| **Ingest + summary** | 🟢 | JSONL source of truth · `scripts/analytics-core.mjs` |
| **Supabase mirror** | 🟡 | Optional env · schema `server/sql/place_events.sql` |
| **Prod deploy** | 🟡 | PM2 ecosystem + nginx `/api/analytics/` · build with flag |

**QA:** enable flag → open world landing → chart icon → counts move on revisit; uniques stick per browser; jump-in raises enters; local flag off does not POST.

**Design / ops:** [docs/CREATOR_ANALYTICS.md](./CREATOR_ANALYTICS.md) · flat FTP: `analytics.mjs` + `analytics-core.mjs` + `ecosystem.config.cjs`.

**Tip:** Forge/Privy not on the visit path — reserved for later game-logic lane.

---

## 🎉 Milestone — v1.3.0 release (Plaza / Poker parity · PE physics · UI tint · chat translate) (2026-07-19)

**Status: release cut** — `dev-latest` → `main` · tag `v1.3.0`.

### What's new

- **Genesis Plaza bounce parasols** — TriggerArea → PE impulse; Explorer-raw Δv
- **Store / event banners** — GltfNodeModifiers paths · poster CORS/webp · player spatial audio
- **Planes & TextShape** — docs-order UVs · Poker Night `scale.x=-1` boards read L→R
- **Scene UI colors** — Color4 × texture (dark/green panels, not white flash)
- **Chat translate** — optional auto/manual translation + channel prefs
- **Quiet console** — browser logs off by default; Help → Debug to enable

| Area | Status | Notes |
| ---- | ------ | ----- |
| **PE force + impulse** | 🟢 | force arcade scale · impulse Explorer-raw |
| **TriggerArea pads** | 🟢 | CCT + parent-first world matrix |
| **TextShape / plane UV** | 🟢 | Dead Surge + Poker leaderboards |
| **UiBackground multiply** | 🟢 | Poker welcome / tinted buttons |
| **Chat translation** | 🟡 | UI shipped · provider keys env-dependent |

**QA (release smoke):** plaza bounce · banners · Dead Surge BACK/NEXT · Poker welcome dark · Poker leaderboard · Help console default off ✅

**Tip:** `v1.3.0` on `main`.

---

## 🎉 Milestone — Plaza / Poker parity · PE physics · scene UI tint · chat translate → `dev-latest` (2026-07-19)

**Status: merged `lastraum` → `dev-latest`** (fast-forward `8aa5830`) — Genesis Plaza playability, Explorer-style PE force/impulse, TextShape/plane UV parity, UiBackground color×texture, optional chat translation, quieter default logging.

### What's new

- **Genesis Plaza bounce parasols** — TriggerArea enter → PE impulse `(0,25,0)`; Explorer-raw Δv (no arcade g-scale on impulse); continuous force still arcade-scaled for jump feel
- **Store / event banners** — GltfNodeModifiers Group→mesh path resolve; event poster CORS/webp MIME; spatial audio on player
- **Planes & TextShape** — docs-order UVs (Dead Surge BACK/NEXT + leaderboards); TextShape FrontSide; **Poker Night** `scale.x=-1` map U flip so casual boards read L→R
- **Scene UI colors** — UiBackground multiplies Color4 × texture (white nine-slice × dark/green); instant solid tint (no white flash)
- **Chat** — channel menu prefs + optional auto/manual translation UI
- **Debug** — browser console **off by default**; Help → Debug checkbox mirrors logs; throttle CRDT/video spam; avatar feet logs only with `?avatarverbose`

| Area | Status | Notes |
| ---- | ------ | ----- |
| **PE force + impulse channel** | 🟢 | `externalPhysics.ts` · force × `20/9.8` · impulse raw · drag/clamp · land latch reset |
| **TriggerArea CCT** | 🟢 | Parent-first world matrix · PE gates · immediate append flush |
| **GltfNodeModifiers banners** | 🟢 | Named Group path + mesh leaves · static map U flip when UV L–R mirrored |
| **TextShape / plane UV** | 🟢 | Docs corner maps · FrontSide · scale.x mirror compensation |
| **UiBackground color×texture** | 🟢 | Canvas multiply + solid first paint · nine-slice |
| **Chat translation** | 🟡 | Settings + per-line controls · provider path; production provider keys TBD |
| **Console log gate** | 🟢 | `ClientDebugLog` mirror default off |

**QA (1.3.0 smoke):** Genesis plaza bounce height vs Explorer · store banners load · event board poster · Dead Surge BACK/NEXT · Poker Night welcome dark + green buttons · Poker leaderboard L→R · chat translate optional · Help console checkbox off by default.

**Tip commits:** `afaf367` / `7ecd8a9` / `8aa5830` on `dev-latest`.

**Release note:** Candidate for **v1.3.0** after smoke QA — not cut yet (`package.json` remains `1.2.0` until `main` release).

---

## 🎉 Milestone — v1.2.0 release (Camera Reel · biomes · backpack hides) (2026-07-18)

**Status: release cut** — `dev-latest` → `main` · tag `v1.2.0`.

### What's new

- **In-World Camera (C)** — fly lens, Space shutter, review rail, **Save to Decentraland gallery**
- **Gallery (K)** — photo previews, public/private, copy reels link, hover ⋮ menu, delete
- **Hide UI (U)** · **name tags (N)** · chat image lightbox
- **Terrain editor biomes** — desert dunes, land plane, space sky (`scene.json` environment)
- **Backpack hides** — “Hidden by” badges, forceRender override, large-wallet inventory
- **Avatar pipeline** — glTF wearables, emissive polish, peer refresh after equip

| Area | Status | Notes |
| ---- | ------ | ----- |
| **Camera Reel save/list** | 🟢 | Signed Camera Reel API · wallet required |
| **Photo fly mode** | 🟢 | Dedicated lens · FOV scroll · pointer-lock look |
| **Terrain biomes** | 🟢 | Editor + play `environment.kind` parity |
| **Backpack forceRender / inventory** | 🟢 | ADR-239 hides · pagination · peer announce |
| **Gallery pagination** | ⬜ | API max 100/page |

**QA (release smoke):** C → Space → Save → K gallery · ⋮ public/link/delete · U/N · backpack hide/equip · `/editor` desert or land · second client sees outfit · Genesis load.

**Tip:** `v1.2.0` on `main`.

---

## 🎉 Milestone — In-World Camera + Camera Reel gallery → `dev-latest` (2026-07-18)

**Status: merged `lastraum` → `dev-latest`** — Explorer-style photo fly mode, post-capture review, signed gallery upload, Settings Gallery parity.

### What's new

- **In-World Camera (C)** — dedicated fly lens (not orbit freecam); pointer-lock look + hidden cursor; WASD/R·F height; scroll FOV
- **Space shutter** — 1920×1080 crop + people-in-frame metadata (frustum)
- **Review rail (3/4 · 1/4)** — place, people accordion (non-default wearables + BUY), Scrap / Share / Download / **Save to Camera Reel**
- **Gallery (K)** — month grid, larger thumbs, hover ⋮ menu (public / copy link / share X / download / delete), detail same 3/4·1/4 layout
- **U / N chrome** (prior on branch) — hide all UI; name tags local+remote+AvatarShape; chat image lightbox

| Area | Status | Notes |
| ---- | ------ | ----- |
| **Photo fly camera** | 🟢 | `PhotoCameraController` · blocks locomotion/freecam; VC-blocked when scene owns lens |
| **Capture + metadata** | 🟢 | Frame crop · frustum people · placeId via Places API |
| **Save → Camera Reel** | 🟢 | Signed `POST /api/images` · wallet required · no auto-download on Save |
| **Gallery list/detail** | 🟢 | Compact list + metadata detail · public toggle · delete · reels link |
| **Thumb ⋮ menu** | 🟢 | Public / Share X / Copy Link / Download / Delete |
| **Gallery pagination** | ⬜ | API max 100/page — multi-page later |

**QA:** C → FOV scroll → Space → Save (wallet) → K Gallery sees photo · ⋮ public/link/delete · detail rail people · Esc/scrap · C exit.

**Tip commits:** `a3f010a` / `8e5497b` on `lastraum` (photo + gallery + docs).

---

## 🎉 Milestone — Terrain editor biomes + landscape parity → `dev-latest` (2026-07-18)

**Status: merged `lastraum` → `dev-latest`** (`85d7256`) — floating terrain UI, `scene.json` environment.kind biomes, and client-identical landscape preview in the editor.

### What's new

- **Floating terrain dock** — sculpt / paint / Ez Grass / biome / ocean icons; secondary rails for shading + biome picker (no side panel)
- **Biome rail** — none · genesis · island · water · land · forest · desert · space (mountains icon hidden for now)
- **Desert** — horizon sand plane, Perlin **dunes** (height / width / length / wind / ripple), outer rocks, dust storm + tumbleweeds (`environment.desert`)
- **Land** — single solid-color ground plane under the scene at y≈−0.01 (`environment.land.groundColor`) — no red-grass GLB tint
- **FFTOCEAN / space sky** — dallapozza knobs + reset; space atmosphere (stars, rim, fog) in editor + play
- **Editor = play landscape** — `buildParcelLandscape` for biome preview; local scenes honor `environment.kind`
- **Landscape X alignment** — infinite ground / scatter match author terrain (`dclToThree` X reflection)

| Area | Status | Notes |
| ---- | ------ | ----- |
| **TerrainSculptPanel float UI** | 🟢 | Dock + flyouts · `editorStyles.ts` |
| **sceneEnvironmentIO** | 🟢 | kind / water / space / desert / land / mountains merge to `scene.json` |
| **Desert dunes + atmosphere** | 🟢 | `DesertGoldGround` · `DesertAtmosphere` · outer rock scatter |
| **Land color plane** | 🟢 | `LandColorGround.ts` · pure material color |
| **Client landscape in editor** | 🟢 | `TerrainEditorWorkspace.rebuildClientLandscapePreview` |
| **Space sky** | 🟢 | `SpaceSkyField` · `EnvironmentSystem` |
| **Mountains dock icon** | ⬜ | Panel code kept; icon hidden |

**QA:** `/editor` · switch 🏜/🌾/🚀 · dune height · land color picker matches floor · desert rocks to horizon · FFTOCEAN on island · play local scene with `environment.kind: "desert"`.

**Tip commit:** `85d7256` on `dev-latest`.

---

## 🎉 Milestone — Backpack wearable hides + avatar pipeline fixes → `dev-latest` (2026-07-18)

**Status: landed on `dev-latest`** (`c23209e`, from PR [#27](https://github.com/lastraum/dcl-threejs-client/pull/27)) — ADR-239 hide UI, large-wallet inventory reliability, and multiplayer profile announce after deploy.

### What's new

- **Hidden-by badges** — dimmed equipped slots with eye-slash + “Hidden by X”; click toggles `forceRender` override (saves on deploy)
- **Large inventories** — paginated wearables fetch · batched metadata · duplicate tokens collapse to ×N cards
- **JSON glTF wearables** — 2021 Builder `.gltf` assets render (not only binary GLB)
- **Emissive sheen** — stop washing faint authored emissives to full neon
- **Post-deploy avatar** — session profile rebuild (with existing seed cache) + **peer re-announce** so other clients see outfit swaps live

| Area | Status | Notes |
| ---- | ------ | ----- |
| **computeHiddenBy / forceRender UI** | 🟢 | `slots.ts` · `BackpackView` · deploy fingerprint |
| **Pagination + batch + dupe collapse** | 🟢 | `backpackWearables.ts` |
| **JSON glTF path** | 🟢 | `glbSanitizer.ts` |
| **Emissive threshold** | 🟢 | `materials.ts` |
| **Session profile + peer announce** | 🟢 | merged with prior `0aa1173` seed cache |

**QA:** Metafox Shade + helmet hide/override · wallet with 100+ items · Builder glTF wearable · equip hat → second client updates · faint-emissive boots keep albedo.

**Tip commit:** `c23209e` on `dev-latest` (PR #27 closed after rebased merge).

---

## 🎉 Milestone — v1.1.0 production beta (multiplayer + play loop) (2026-07-17)

**Status: release cut** — `dev-latest` → `main` · tag `v1.1.0` · tip includes `7a56512` Genesis play-loop batch + prior 1.x milestones on `dev-latest`.

### What's new

- **3D chat works after Jump In** (landing → world handoff fixed)
- **Nearby voice you can actually hear** (autoplay unlock)
- **Island chat/peers match your parcel** (archipelago seed)
- **Explorer-style location minimap** (collapse/expand)
- **Communities** chat/voice + HUD toasts
- **Bloom / HDR** for authored emissives
- **Glider** (hold Space after double-jump)
- **Backpack equip updates the in-world avatar**
- **SDK6 parcels error clearly** instead of hanging

| Area | Status | Notes |
| ---- | ------ | ----- |
| **3D chat handoff** | 🟢 | Shell dispose no longer clears World `chatHandler` |
| **HTML nearby voice** | 🟢 | Gesture unlock + play retry; spatial deferred |
| **Archipelago seed** | 🟢 | Bound parcel genesis, not `(0,0,0)` |
| **Location map stack** | 🟢 | Glass + caret; single canvas ring |
| **HUD RestrictedActions** | 🟢 | `changeRealm` / `openExternalUrl` confirm modal |
| **SDK6 gate** | 🟢 | Fail-fast UI for classic Builder scenes |
| **Glider / bloom / communities** | 🟢 | Prior milestones on `dev-latest` |

**QA:** Genesis Jump In chat + voice · Angzaar hard refresh island · minimap caret · backpack equip · SDK7 world · SDK6 error path · glider hold-Space · bloom on Dead Surge.

**Tip commit:** `7a56512` on `dev-latest`.

---

## 🎉 Milestone — Explorer glider parity + wearable hotfixes → `dev-latest` (2026-07-17)

**Status: merged to `dev-latest`** (`0aa1173` tip of ship) — full Explorer-style glider (physics + prop mesh + body hold + multiplayer state) plus avatar compose/reload fixes.

### What's new

- **PhysicsCombined** force/impulse on `PlayerEntity` (continuous + `eventId` one-shot; 1.5× force while gliding)
- **Glider sequence** — jump → double-jump twirl → hold Space (air jumps spent) → glide; W+A diagonals; release closes
- **GliderProp.glb** — Explorer prop, open/close clips (`gliderClips.json`), rotor spin; offset to hands
- **Glide_Avatar** — DCL body arms-on-handles (upper-body hold pose; hips stripped for stability)
- **Remote glide** — RFC4 `Movement.glideState` encode/decode; `RemoteAvatarManager` attaches prop per peer
- **castShadows default true** — material.proto / MeshRenderer / GltfContainer parity; material `castShadows:false` + Graphics shadows off
- **Wearables** — unit-scale explode fixed (unknown armature ≠ 1.0); geometry not baked into AssetCache share; skin/hair tint clones mats
- **Backpack → world** — equip/save reloads in-world mesh from **session** profile (not stale Catalyst lambdas)

| Area | Status | Notes |
| ---- | ------ | ----- |
| **Force / Impulse** | 🟢 | 1216 / 1215 on PE |
| **Local glider prop + open/close** | 🟢 | `GliderProp.ts` + `public/avatar/glider/` |
| **Body hold pose** | 🟢 | `Glide_Avatar` upper-body clamp |
| **Remote glider** | 🟢 | RFC4 glideState; remotes no wind trails |
| **Wind streaks** | ⬜ | Deferred (prefab ParticleSystem / VFX Graph) |
| **Wearable merge / backpack reload** | 🟢 | session seed + unit-scale clamp |

**QA:** deadsurge / wind zones · jump → space again → hold Space glide · W+A NW · second client sees prop · backpack equip → world mesh updates · RTFKT/L1 feet not giant.

**Tip commits:** `f04437e` glider · `449fce5` wearable scale · `0aa1173` backpack reload.

---

## 🎉 Milestone — Graphics P4 emissive bloom / HDR → `dev-latest` (2026-07-17)

**Status: on `dev-latest`** (`aeda9fa`) — Explorer-style soft glow for authored emissives without washing sky or x-raying through props.

### What's new

- **Emissive-driven bloom** — extract only glTF `emissiveFactor` × `emissiveIntensity` (+ emissiveMap / additive VFX Basic); lights zeroed so lit albedo does not bloom
- **Depth occlusion** — non-emissive meshes stay as black occluders during extract (no NEW GAME through obelisks)
- **Sky excluded** — Genesis dome `dclBloomExclude` (clouds do not bloom)
- **HDR buffer** — HalfFloat composer RT for bright muzzle / neon without clipping
- **Pipeline** — extract → full scene + ACES `OutputPass` → additive pure-bloom composite (`BloomPipeline` + `UnrealBloomPass`)
- **Preferences → Graphics** — Bloom + HDR toggles live; Medium/High/Ultra default on, Low off
- **Material-safe extract** — never nulls maps (blood splat alpha intact)

| Area | Status | Notes |
| ---- | ------ | ----- |
| **BloomPipeline** | 🟢 | `src/rendering/BloomPipeline.ts` · material radiance · depth occluders |
| **HDR + prefs** | 🟢 | HalfFloat · `GraphicsSettingsView` Bloom/HDR |
| **Untextured VFX base** | 🟢 | additive MeshBasic (GunVFX) + bloom halo |
| **Distance culls (P3)** | ⬜ | still open |
| **MSAA + bloom together** | ⬜ | MSAA skipped while bloom active |

**QA:**  
- Preferences → Bloom on · Dead Surge muzzle + neon signs soft-halo · sky clean · signs occluded by solid props · blood splats transparent.  
- Bloom off → no post glow (additive Basic still self-lit).

**Tip commit:** `aeda9fa` on `dev-latest` / `lastraum`.

---

## 🎉 Milestone — Dead Surge combat + VC/PE attach → `dev-latest` (2026-07-17)

**Status: on `dev-latest`** (`6ca5deb` … `aeda9fa`) — large multi-MB worlds (deadsurge.dcl.eth) boot, VirtualCamera combat freecam lock, PlayerEntity weapon attach, projectile hits, death coins, muzzle + bloom.

### What's new

- **Large-bundle boot** — multi-MB scene worker boot + needle-based react-ecs / engine-loop patches (no hang on Dead Surge-scale `bin/index.js`)
- **VirtualCamera combat** — freecam orbit lock while MainCamera is VC-bound; world-basis WASD; aim via `camera.lookAt` (no hard-coded iso/lift offsets)
- **PlayerEntity weapon attach** — reserved PE parent + chest attach root reparent so equip mid-match sticks
- **Projectile hits** — worker bundle rewrite: XZ segment–cylinder swept hits + origin snapshot (end-point samples no longer tunnel past zombies)
- **Reliable combat events** — auth-server CUSTOM_EVENT reliable + pin to authoritative-server
- **Death coins** — Transform bob/spin; GPU instances promote to private clones under sustained motion
- **Muzzle / untextured VFX** — additive `MeshBasicMaterial` glow for emissiveFactor-only GLBs (GunVFX ShootVFX)
- **Animator re-fire** — LWW identical `shouldReset` still restarts one-shots (muzzle morph / gun shot)
- **Scene UI** — hit-map from Yoga boxes · real nine-slice · TextShape fit/repaint · flex enum center progress

| Area | Status | Notes |
| ---- | ------ | ----- |
| **Large-bundle worker** | 🟢 | `patchEngineSystemLoop` · `reactEcsOnce` needle · `mainThreadYield` |
| **VirtualCamera + PE attach** | 🟢 | `VirtualCameraBridge` · reserved PE anchors · VC orbit lock |
| **Swept projectile hits** | 🟢 | `patchProjectileSweptHits` + pointerEventColliderChecker patch |
| **CUSTOM_EVENT reliable** | 🟢 | CommsService / LiveKit · auth pin |
| **Motion-promoted instances** | 🟢 | 3× Transform churn → SkeletonUtils clone |
| **Untextured emissive glow** | 🟢 | additive Basic + P4 bloom halo |
| **Full-scene bloom/HDR** | 🟢 | emissive extract · depth occlude · prefs (see milestone above) |

**QA:**  
- `deadsurge.dcl.eth` → boot past LOADING · VC freecam · equip gun on chest · shoot zombies (hits register) · death coins bob/spin · muzzle flash + soft bloom.  
- Flagtag / plaza — static tiles still instanced; no regression on elevated spawn.

**Tip commit:** `6ca5deb` combat · `aeda9fa` bloom — both on `dev-latest` / `lastraum`.

---

## 🎉 Milestone — Scene UI hit-map + nine-slice → `lastraum` (2026-07-16)

**Status: merged → `dev-latest`** (`9f384cf` … `6ca5deb`) — in-scene ECS UI pointer regions track Yoga; UiBackground nine-slice works for scene + CDN art.

### What's new

- **Scene UI hit-map** — pointer pick from Yoga `LayoutBox` + viewport mapping (not nested DOM rects)
- **UiBackground nine-slice** — real `border-image` for authored slices; HTTP/CDN allowed; borders sized from image natural pixels × UI scale
- **Dev Progress + What's new** — repo link at the top → [github.com/lastraum/dcl-threejs-client](https://github.com/lastraum/dcl-threejs-client)

| Area | Status | Notes |
| ---- | ------ | ----- |
| **Hit regions** | 🟢 | `layoutToScreen` from canvas-absolute Yoga boxes |
| **Nine-slice** | 🟢 | `uiBackgroundStyle` · slices present · natural size probe |
| **Text measure polish** | 🟡 | line-height measure vs paint still open |

**Tip commit:** `9f384cf` on `lastraum`.

---

## 🎉 Milestone — 2D chat FAB + social polish + spawn settle → `dev-latest` (2026-07-16)

**Status: on `dev-latest`** (`b5b22e3` and follow-ups) — 2D social shell chat expands from a bottom-right FAB; elevated towers (e.g. Flagtag) ground onto authored deck; RestrictedActions filled out.

### What's new

- **2D chat FAB** — large bottom-right icon expands / collapses the social chat dock (desktop + mobile)
- **Restore last view** — reopening the FAB returns to the prior thread or channel list (not always the list)
- **Scene tab × on Explore** — closable multi-room scene chats when not on that scene’s landing page
- **Idle empty state** — “Visit a scene for scene chat” plain centered text (no chip chrome)
- **Community HUD** — announce/start-voice mod gates · top-center toasts · community chat open · voice end-for-everyone · instant WS voice toasts
- **RestrictedActions** — `teleportTo` · `changeRealm` · `copyToClipboard` (plus existing movePlayerTo / emotes / URLs)
- **Elevated spawn settle** — CCT + probe prefer surface near authored feet Y (deck, not roof); PE staged before script boot (no false drown at origin)

| Area | Status | Notes |
| ---- | ------ | ----- |
| **SocialChatDock FAB** | 🟢 | `SocialChatDock` + `scene-chat-fab` / dock `__fab`; dock bottom clears FAB |
| **View restore** | 🟢 | `panelOpen` independent of `threadOpen` |
| **Closable scene tabs** | 🟢 | × only hidden on current `scene-landing-route` |
| **Community mod + toasts** | 🟢 | owner/mod/admin · `CommunityHudToastWatcher` · Social WS |
| **RestrictedActions** | 🟢 | Full set in shim + main handlers |
| **Spawn floor wait / settle** | 🟢 | `waitForSpawnFloorReady` · `settleSpawnOntoFloor` · plausible Y band · preferNearY probe |

**QA:**  
- Explore → open FAB → visit scene landing → chat auto/open → back to Explore → × on scene tab · reopen FAB shows last thread.  
- Empty chat (no scenes/communities) → centered idle text, no border.  
- Flagtag (or any high spawn) → stand on deck, no hover/dip; no drown UI during load.  
- Scene script `teleportTo` / `changeRealm` / `copyToClipboard` (when exercised).

**Tip commit:** `b5b22e3` on `dev-latest`.

---

## 🎉 Release — v1.0.0 (2026-07-16)

**Status: `dev-latest` → `main` · tag `v1.0.0`** — first major under a **core play loop production beta** contract (not full DCL parity).

### What 1.0 means

We stand behind the **core loop** in production while the product stays **beta**:

- Load world or Genesis parcel · landing · **Jump In**  
- Walk · multiplayer presence · scene chat · **nearby voice** (browser ↔ Explorer)  
- Leave · map / explore · jump again  
- Location pill + **circular Genesis minimap** (parcels) · wallet + guest  

**Not in 1.0 (1.x / open):** full Explorer parity · spatial 3D voice · in-world `/goto` · community DMs · backpack outfits/marketplace · scene UI polish · graphics P3/P4 · every ECS surface.

Definition also in [REPO_MANAGEMENT.md](./REPO_MANAGEMENT.md) (Release tagging).

### What's new (since v0.9.0)

- **Nearby voice + Explorer interop** — Speak / hold T · worlds + Genesis parcels · mute until in-play · name-tag bars  
- **Circular Genesis minimap** — satellite basemap under location pill · click opens in-world Map on your parcel  
- Landing card height / events spacing polish  

### Known limitations (release notes)

- No spatial (distance) voice yet — flat nearby audio  
- No in-world `/goto` teleport (chat `/goto` stability only)  
- No community private messages  
- Scene UI, NftShape, graphics distance/post-FX incomplete  
- Some DEPLOYMENT matrix items still open (browser spot-check, etc.)

**Changelog:** https://github.com/lastraum/dcl-threejs-client/compare/v0.9.0...v1.0.0

---

## 🎉 Milestone — Circular Genesis minimap → `dev-latest` (2026-07-16)

**Status: on `dev-latest`** (`7536715`) — parcel play HUD shows a circular satellite minimap under the location pill.

### What's new

- **Circular minimap** — same lod-0/3 Genesis basemap as the full map panel, hard white ring, player at center  
- **Under the location pill** — pill width matches the circle; no overlap  
- **Click opens in-world Map** — settings Map tab (stays in play; no 2D `/map` social shell) centered on you  
- **Parcels only** — worlds keep the location pill only (no city basemap)  
- **Landing card** — scene thumbnail constrained to viewport; gap above Upcoming events  

| Area | Status | Notes |
| ---- | ------ | ----- |
| **Minimap basemap** | 🟢 | `mapTileUrl` / `visibleTiles` — Unity-parity lod-0/3 |
| **Hard circle + white ring** | 🟢 | Canvas clip + stroke |
| **Layout under pill** | 🟢 | `placeBelow` + ResizeObserver; matching 224/192 width |
| **Open map panel** | 🟢 | Settings overlay Map · `embedded` (no GENESIS PLAZA HUD) |
| **Center on player** | 🟢 | `initialCenter` from live parcel |
| **World scenes** | 🟢 | Minimap hidden; pill only |
| **Landing card height** | 🟢 | Fixed card height; absolute-fill thumbnail |

**QA:**  
- Jump into a Genesis parcel → pill + circle aligned · green player dot · click → Map panel on your parcel.  
- World scene → no minimap.  
- Mobile → both hidden (existing chrome rules).  
- Scene landing → card fits viewport; space above Upcoming events.

**Not in this slice:** compass/heading arrow · peer dots on minimap · soft alpha fade (hard ring by design).

**Tip commit:** `7536715` on `dev-latest` / `lastraum`.

---

## 🎉 Milestone — Nearby voice + Explorer interop → `dev-latest` (2026-07-16)

**Status: on `dev-latest`** (`74e4c56` and follow-ups) — LiveKit nearby voice works **worlds + Genesis parcels**, including **browser → Explorer**.

### What's new

- **Nearby voice panel** (Explorer layout) — Hear others · volume · **Speak** · hold **T**
- **Speak** = hot mic; **hold T** = momentary; green talking border + **3 bars on name tags**
- **Mute until in play** — no mic/remote audio during landing load
- **Mute mic in background** when tab hidden
- **Worlds** — voice on world LiveKit room (browser ↔ Explorer ✅)
- **Genesis parcels** — voice on **island + scene** rooms; archipelago **genesis Z** fixed so we co-cluster with Explorer
- **Jump In handoff** — keep landing LiveKit (no kill/reconnect); same participant session into play

| Area | Status | Notes |
| ---- | ------ | ----- |
| **Panel UI** | 🟢 | Explorer NEARBY VOICE layout |
| **Mic publish** | 🟢 | Speak + hold T · LiveKit display name |
| **Remote hear** | 🟢 | Subscribe + HTMLAudio host · `startAudio()` |
| **Worlds ↔ Explorer** | 🟢 | World room only |
| **Parcels ↔ Explorer** | 🟢 | Island + scene publish/subscribe; correct archipelago position |
| **Landing → play handoff** | 🟢 | `keepLiveKit` + transfer; no mid-load disconnect |
| **Name-tag voice bars** | 🟢 | 3 green bars from ActiveSpeakers |
| **Spatial 3D audio** | ⬜ | Next — PositionalAudio on remote avatar |

### Implementation notes (comms)

| Path | Voice LiveKit rooms |
| ---- | ------------------- |
| **Worlds** | `world` only (scene room = Cast/video) |
| **Parcels** | `island` + `scene` when both up (Explorer nearby still needs island co-location) |

| Bug | Fix |
| --- | --- |
| Empty island / no Explorer bars on parcels | Archipelago heartbeat used **extra Z flip** on already-DCL positions → mirrored map coords |
| Different LiveKit participant after Jump In | `teardownScene` → `disconnectLiveKit()` killed landing session before handoff |
| Silent until spawn | `setInPlay(false)` until play chrome; then unlock |
| Mic stack overflow on PTT | `micSyncDepth` guard on `refreshRooms` ↔ publish |

**QA:**  
- **World:** two clients or browser + Explorer · Speak / hold T · bars + audio.  
- **Genesis parcel:** next to Explorer · island remotes ≥ 1 · Speak · Explorer bars + audio.  
- Jump In from landing: console `handoff OK` / `REUSE landing LiveKit` (no disconnect).  
- Load: no remote voice until in play.

**Not in this slice:** full 3D spatialization (distance falloff / PositionalAudio), community/private voice rooms.

**Tip commits:** `74e4c56` (interop + archipelago Z + handoff) · earlier phase-1 panel/PTT stack on `dev-latest`.

---

## 🎉 Milestone — Nearby voice phase 1 UI → `dev-latest` (2026-07-16)

**Status: superseded by interop milestone above** — initial panel + PTT wiring; Genesis Explorer parity completed in the following block.

### What's new (phase 1)

- Nearby voice panel · Speak / hold T · remote HTMLAudio · mute-in-background

---

## 🎉 Release — v0.9.0 (2026-07-15)

**Status: cut from `dev-latest` → `main` · tag `v0.9.0`** — mid-July product minor after **v0.8.0**.

| Area | Notes |
| ---- | ----- |
| **Multi-room chat + live cast** | Scene tabs stay joined; guest Join Live; mute; stream end → landing; LiveKit/VideoPlayer hardens |
| **Double-jump twirl + name tags** | Explorer-style air-jump spin (DCL/VRM); `featureToggles.nameTags` |
| **Terrain shell** | Top nav **Terrain** → `/editor`; hub with site bg + shell nav; no chat dock |
| **What's new** | Version toast + profile menu; localStorage persist ack on |
| **World props / teleports** | Instanced hide + tween matrices; floor land; UI tick resume |
| **`/goto` stability** | Dispose-order crash fixed (not full Phase 4 in-world goto) |

**Changelog:** https://github.com/lastraum/dcl-threejs-client/compare/v0.8.0...v0.9.0

---

## 🎉 Milestone — Post-v0.8.0 rollup → `dev-latest` / **v0.9.0** (2026-07-15)

**Status: released as v0.9.0** — multi-room chat + live cast, avatar polish, scene UI/live stream reliability, instanced world props, terrain shell, and version highlights. Detail tables live in the section milestones below; this block is the **toast / release notes** surface.

### What's new

- **Double-jump twirl** — Explorer-style full-body spin on air-jump (DCL + VRM/ODK); optional `double_jump.glb`  
- **Live streams & cast** — Join Live as guest or wallet; mute; stream end returns to landing; LiveKit handoff + VideoPlayer stability  
- **Multi-room chat** — keep scene tabs connected while you navigate; channel notifications; 2D @-mentions  
- **Name tags** — hide overhead labels via scene.json `featureToggles.nameTags` (or `?nameTags=`)  
- **Terrain** in top nav — local projects hub with site backdrop + shell nav (no chat dock on editor)  
- **What's new** — update toast + profile menu highlights anytime  
- **World props** — pickups hide correctly; instanced coins/props tween again; better teleport / floor land  
- **`/goto` stability** — leaving a scene no longer crashes (CameraModeArea dispose order)  

| Theme | Status | Pointer |
| ----- | ------ | ------- |
| **Multi-room chat + cast / live video** | 🟢 | Milestone below (2026-07-14) + hot-fix live-stream merge `#25` |
| **Double-jump twirl + nameTags** | 🟢 | Milestone below (2026-07-15) |
| **Instanced props, teleports, UI ticks** | 🟢 | Milestone below (2026-07-15) |
| **Scene UI modals / CAM / inject** | 🟢 | CAM stay-open, modal flash, UiText/UiBackground ids, async paints |
| **Live stream VideoPlayer / LiveKit** | 🟢 | ECS authority, handoff, bind reliability (`4816b2b`, `e113432`) |
| **Map satellite basemap** | 🟢 | Unity-parity basemap + close-zoom parcels (`ea336f1`) |
| **What's new + Terrain shell** | 🟢 | Toast, profile entry, Terrain tab, hub chrome, chat off on editor |
| **`/goto` dispose crash** | 🟢 | `39c10e1` — not full Phase 4 in-world goto |
| **Post-round InputModifier freeze** | 🟡 | Client latch fixed; some worlds may still leave walk/jog/run off |

**Still open (product):** Phase 4 **in-world `/goto`** · I'm live CTA (HLS) · community PM · **spatial** voice (3D falloff) · backpack outfits/marketplace · graphics P3/P4.

**QA (release smoke):** double-jump twirl DCL+VRM · Join Live cast guest · multi-room chat A→B · nameTags off · Terrain hub + no chat · toast dismiss stays dismissed · pickup vanish + coin spin · `/goto` leave scene · elevated respawn.

**Branch tip:** `dev-latest` (see git log `v0.8.0..HEAD`).

**Released as:** **v0.9.0** (minor). Persist ack **on**. Tag from `main` after merge.

---

## 🎉 Milestone — Instanced props, teleports & scene UI ticks → `dev-latest` (2026-07-15)

**Status: merged `lastraum` → `dev-latest`** — scene-agnostic GPU instance lifecycle, teleport/spawn reliability, UI tick resume, chat dock polish.

### What's new

- Pickups and shared props **disappear correctly** when removed or hidden (no ghost meshes)
- **Tweened props animate** again when GPU-instanced (spin, bob, slide)
- Scene UI and timers keep updating after big UI remounts and teleports
- More reliable **floor land / respawn** after `movePlayerTo` (feet-based, authored colliders)
- Chat dock: better expand/collapse height, hide list when a thread is open, clearer icons

**Parked:** Some worlds still leave the player frozen after a round reset via scene `InputModifier` — client no longer re-applies a stale freeze after the scene unlocks; remaining freezes need scene (or Explorer-compare) follow-up.

| Area | Status | Notes |
| ---- | ------ | ----- |
| **Instanced Gltf hide/remove** | 🟢 | Detach GPU slot + clear clone when `GltfContainer` deleted; Visibility zeros instance matrices |
| **Instanced transform tweens** | 🟢 | After TweenBridge pose, rewrite InstancedMesh matrices every frame |
| **UI mount LWW** | 🟢 | Clear only snapshot entity rows — no full wipe without re-seed |
| **Mount-lag tick resume** | 🟢 | Force-resume worker ticks after ~1.2s lag / on `movePlayerTo` |
| **Scene freeze latch** | 🟢 | Drop scene IM latch when live cleared — do not re-freeze after unlock |
| **Spawn / teleport** | 🟢 | Pure authored floor settle; `movePlayerTo` feet; locomotion flag logs |
| **Chat rail** | 🟢 | Dock heights, hide list on thread, unique scene-chat icons |
| **Post-round freeze** | 🟡 | Client latch fixed; scene may still leave walk/jog/run disabled |

**QA:** Collectable pickups vanish · instanced tweens spin · elevated drown/respawn · multi-room chat expand/thread · any world that freezes on round reset (compare Explorer).

**Branch:** `lastraum` → `dev-latest` (`ae78b01` code · progress docs).

---

## 🎉 Milestone — Name tags toggle + double-jump twirl → `dev-latest` (2026-07-15)

**Status: merged `lastraum` → `dev-latest`** — scene.json name-tag hide + Explorer-style clockwise double-jump for all avatar rigs.

### What's new

- **Double-jump twirl** — full-body clockwise spin on air-jump (DCL body + VRM/ODK)  
- Hide **name tags** via scene.json `featureToggles.nameTags` (or `?nameTags=` for QA)  

| Area | Status | Notes |
| ---- | ------ | ----- |
| **`featureToggles.nameTags`** | 🟢 | `"disabled"` hides local + remote + AvatarShape overhead labels; top-level `nameTags` alias |
| **URL QA override** | 🟢 | `?nameTags=0` / `disabled` / `1` / `enabled` (wins over scene.json) |
| **Double-jump twirl (DCL)** | 🟢 | Hard-coded full-body **clockwise** Y spin (~0.68s) + jump pose when no `double_jump.glb` (no more jump.glb fallback oneshot) |
| **Double-jump twirl (VRM / ODK)** | 🟢 | Same shared `DoubleJumpTwirl` — replaces Mixamo/MML flip clips for air-jump |
| **Optional clip** | 🟢 | If `/avatar/emotes/double_jump.glb` is bundled, DCL plays that oneshot instead of procedural twirl |

**QA:** Deploy `featureToggles.nameTags: "disabled"` · open without URL override · confirm no pills. Double-jump DCL + custom VRM/ODK — clockwise spin.

**Branch:** `lastraum` → `dev-latest` (`2208209` merge · `c883d6f` nameTags · `a851d0c` twirl).

---

## 🎉 Milestone — Multi-room chat + cast / live video → `dev-latest` (2026-07-14)

**Status: merged `lastraum` → `dev-latest`** (+ live-stream hotfixes) — companion-style multi-room LiveKit chat, guest cast watch, landing UX, VideoPlayer/LiveKit reliability. Closes main Watch Lite / 2D chat dock parity gaps from social merge plan (removed) Phase 3.

### What's new

- **Multi-room scene chat** — stay joined to open tabs while you navigate  
- **Join Live / cast video** as guest or wallet; mute; clean end-of-stream → landing  
- **@-mentions** in 2D chat; channel-aware notifications  

| Area | Status | Notes |
| ---- | ------ | ----- |
| **Multi-room LiveKit chat** | 🟢 | `SceneChatRoomPool` — open scene tabs stay joined when navigating (dcl-companion multi-text-chats pattern); no single-room “history only — rejoin” dead-end |
| **Adapter resolve without thrash** | 🟢 | `resolveSceneChatAdapter` — world signed-login / parcel gatekeeper; primary CommsService for landing cast, pool for background rooms |
| **Channel-aware notifications** | 🟢 | Mobile banners label scene/community; suppress only when that thread is open; guest toasts work |
| **Close tabs** | 🟢 | × / swipe leaves that LiveKit room; **current landing scene tab has no ×** (stay connected until navigate away) |
| **2D @-mentions** | 🟢 | Purple highlight for self-mentions; live peer list includes world transport + chat history |
| **Guest cast watch** | 🟢 | Wallet **or guest** identity + gatekeeper → stream-key video (mobile + desktop) |
| **Mobile LIVE · CAST CTA** | 🟢 | Stacked full-width above Jump in (≤960px) |
| **Cast mute toggle** | 🟢 | Speaker button toggles mute; LiveKit reattach no longer stomps volume |
| **Stream end → details** | 🟢 | Publisher gone clears host + restores scene landing card (not blank stage) |
| **LiveKit handoff / VideoPlayer** | 🟢 | Scene jump handoff, ECS VideoPlayer authority, reliable bind (`e113432`, `4816b2b`, PR `#25`) |
| **Island / wearable shadows** | 🟢 | Island shore MeshStandard receives shadows; wearables cast |
| **scene.json water** | 🟢 | `environment.water` FFT ocean knobs (FFT ocean scene.json knobs) |
| **Stable browser guest** | 🟢 | Guest wallet + Catalyst profile for chat/cast without MetaMask |

**Resolved gaps (was 🟡 / open):** single-room chat drop on scene switch · history-only rejoin UX · wallet-only stream-key watch · blank cast stage after OBS stop · landing chat “partial” without multi-room · flaky cast video bind.

**Still open:** I'm live CTA (HLS listings) · community text / PM router · spatial voice (3D) · Phase 4 in-world `/goto` · backpack outfits/marketplace.

**QA focus:** Scene A chat → navigate B → A still live + notifications · guest Join Live cast · mute/unmute · stop OBS → return to landing card · mobile LIVE above Jump in · VideoPlayer in-scene streams.

**Branch:** `lastraum` → `dev-latest` (`0e3d3bb` merge) + live-stream follow-ups on `dev-latest`.

---

## 🎉 Release — v0.8.0 (2026-07-14)

**Status: cut from `dev-latest` → `main` · tag `v0.8.0`** — landing Cast/stream keys, backpack colors, media + environment fixes.

| Area | Notes |
| ---- | ----- |
| **Landing stream keys + Join Live** | OBS RTMP via gatekeeper; scene LiveKit detect; cast stage; go-live after landing open |
| **World realm room match** | Lowercase gatekeeper realm so stream-key ingress matches Join Live room (`e798eb0`) |
| **Backpack** | Base eyes/body shape (#23) + eye/hair/skin colors (#24) + Catalyst deploy |
| **VideoPlayer** | Continuous play; HLS `play()` abort storm + ECS seek fixes |
| **Planes / ocean** | L–R under DCL X reflection; FFT cutouts (#19); outdoor light intensity (#21) |

**Changelog:** https://github.com/lastraum/dcl-threejs-client/compare/v0.7.2...v0.8.0

---

## ✨ Beyond Explorer parity — client improvements

Features that **go past Unity Explorer parity** — new workflows, smaller deploys, or tooling the official client does not ship. Parity gaps and bridge work stay in [INTEGRATION.md](./INTEGRATION.md) and milestone sections below.

| Improvement | Status | Why it matters |
| ----------- | ------ | -------------- |
| **In-browser terrain editor** (`/editor`) | 🟢 | Floating dock UI; sculpt / splat / Ez Grass; shading rails; fly camera + viewport HUD |
| **scene.json landscape biomes** | 🟢 | `environment.kind` + desert dunes / land color plane / space sky / FFTOCEAN — editor preview uses same `buildParcelLandscape` as play |
| **Deploy-sized terrain export** | 🟢 | Per-parcel meshes (small scenes) or **merged footprint mesh** (\>512 parcels); configurable density (default **64 segs**); 5×5 ~**4–5 MB** |
| **Visible-mesh physics** | 🟢 | `CL_PHYSICS` on `terrain_mesh_*` only — no duplicate `_collider` layer (matches genesis-games DCL pattern) |
| **Non-square footprints** | 🟢 | L-shaped / sparse parcel layouts export one plane per parcel, not a full bounding-box fill |
| **Local scenes (browser)** | 🟢 | **Link Scenes folder** — pick `~/Documents/DCL-Scenes` (Documents/Downloads/Desktop); Rescan + drag-drop |
| **Companion 2D social shell** | 🟢 | `/` = Explorer (no WebGL) · `/<segment>` = scene landing · Jump in = only 3D entry · Leave returns to landing |
| **2D shell nav + pages** | 🟢 | **Explore · Communities · Events** tabs on all non-play surfaces; `/communities`, `/events`, `/map`, full-screen `/profile` |
| **2D social chat dock** | 🟢 | Multi-room LiveKit (`SceneChatRoomPool`); channel list + thread; mobile FAB/sheet; channel notifications; community thumbs; **3D in-world chat** unchanged |
| **Scene landing hub** | 🟢 | Hero, crowd, owner, description, events banner; companion-style **Jump in** progress bar (sidebar/HUD deferred until handoff) |
| **Landing stream keys + Join Live** | 🟢 | Owner gear → OBS RTMP keys; live detect; cast stage (guest OK); mute toggle; stream-end → details; mobile LIVE stacked above Jump in; **I'm live** CTA deferred |
| **Community thumbnails** | 🟢 | `communityDisplayImageUrl` + proxy passthrough; detail-fetch fallback on image 404 |
| **Dev panel in-app suggestions** | 🟢 | `</>` → **💡 Suggest** — form in panel; auto-attaches DCL name + route; files GitHub issues labeled `suggestion` via Cloudflare Worker (prod) or vite proxy (local dev) |
| **VirtualCamera bind reliability** | 🟢 | Scene-agnostic MainCamera→VC hydrate; locked shots use worker world pose; follow is f(player)+local; live Transform exclusive while bound |
| **Skybox time authority** | 🟢 | Scene fixed → session custom (tab) → Auto cycle; Night/Day panel respects scene lock |
| **scene.json skyboxConfig sun/moon** | 🟢 | Creator sun/moon intensity + colors from `skyboxConfig` / environment (#17) |
| **Unity outdoor lighting parity** | 🟢 | Trilight ambient, soft sun/moon shadows, anim intensity, soft PBR; crescent moon + night fill |
| **Graphics prefs (P0–P2)** | 🟢 | Preset L/M/H/Custom · shadows · lights · res scale · FPS · **MSAA**; Resolution/Fullscreen/VSync hidden or stub |
| **Graphics P3 distances** | ⬜ | **Not started** — Scene Distance / Landscape Distance / Shadows Distance still gray stubs (no cull backend) |
| **Graphics P4 post-FX** | 🟢 **partial** | Bloom / HDR **shipped** (selective emissive); avatar outline still open |
| **Multi-provider auth (DCL auth-dapp)** | 🟢 | Google / Discord / Apple / X / WalletConnect / MetaMask via Explorer auth-dapp + verification code; profile menu + Jump In |
| **2D backpack equip + Catalyst deploy** | 🟡 **partial** | Wearables + emotes + base eyes/body + colors + **hide badges / forceRender** + large-wallet pagination; deploy + peer announce; outfits/marketplace still open |
| **Custom VRM / OSA library** | 🟢 | Device library + open-source avatars tab (client-only; beyond Unity Explorer) |
| **scene.json nameTags hide** | 🟢 | `featureToggles.nameTags` + `?nameTags=` — ThreejsClient overhead label gate |
| **Dev texture proxy host fix** | 🟢 | `/api/texture` routes to encoded host (not hard-coded arweave) — PR #10 |

**Try it:** `http://localhost:5173/` → browse places → **Visit** → scene landing → **Jump in** for 3D. Or `/communities` / `/events` from top nav. Terrain editor: **`/editor`**. Suggestions: dev panel → **💡 Suggest**. Stream: owner gear → stream keys → OBS → **Join Live**.

---

## 🎉 Milestone — Scene stream watch → `dev-latest` (2026-07-14)

**Status: merged `lastraum` → `dev-latest` (`3b2f40f`)** — companion-parity stream keys + Join Live; cast room identity fixed for release.

| Area | Status | Notes |
| ---- | ------ | ----- |
| **Owner stream settings gear** | 🟢 | Wallet ∈ `ownerAddresses` (Places + NAME NFT); live `getLogin` after sign-in |
| **Stream keys (OBS)** | 🟢 | Gatekeeper `scene-stream-access` RTMP/key mint; click-to-copy; not Cast 2.0 watcher-token |
| **Live detect** | 🟢 | Scene LiveKit remote video pubs; continuous poll after landing open |
| **World realm room match** | 🟢 | Gatekeeper realm always lowercased (companion) — fixes OBS in wrong room vs `RickRoll.dcl.eth` about casing (`e798eb0`) |
| **Join Live CTA** | 🟢 | Shown only when cast video is actually live (not mere room ready) |
| **Join Live cast stage** | 🟢 | Full-viewport player, scene info pill, mute toggle + volume, fullscreen, X exits FS then closes; **stream end returns to scene details** |
| **Video attach stability** | 🟢 | Same-SID no remount; hard pause/mute on close; clear host when publisher leaves |
| **Guest cast watch** | 🟢 | Guest or wallet signed gatekeeper join (post multi-room milestone) |
| **Jump In gate** | 🟢 | Hidden until LiveKit up / scene.json blocks chat / guest terminal |
| **I'm live CTA** | ⬜ | Intentionally removed for now (HLS / cast listing UI deferred) |
| **Plaza marquee / TextureMove** | 🟡 | UV + wall-clock `engine.update` dt fixes; NeonScreen `pauseDuration` still flaky |

**Also on this slice (post-v0.7.2):** backpack base eyes/body + avatar colors (#23/#24); VideoPlayer continuous play / HLS abort storm; plane L–R under DCL X reflection; FFT ocean cutouts (#19) + outdoor light intensity (#21).

**QA (owner-confirmed):** RickRoll landing → stream keys → OBS go live (incl. after landing open) → **Join Live** detects remote video.

**Branch:** `lastraum` → `dev-latest` → **`main` as v0.8.0**.

---

## 🎉 Milestone — Backpack base wearables + avatar colors → `dev-latest` (2026-07-14)

**Status: merged PRs [#23](https://github.com/lastraum/dcl-threejs-client/pull/23) + [#24](https://github.com/lastraum/dcl-threejs-client/pull/24)** (`c660f7f`) — base-avatars eyes/body shape + eye/hair/skin picker.

| Area | Status | Notes |
| ---- | ------ | ----- |
| **Base eyes tab + body shape** | 🟢 | PR #23 — base-avatars parity for eyes inventory + body-shape switching |
| **Eye / hair / skin colors** | 🟢 | PR #24 — color picker + iris tinting; Catalyst deploy includes colors + bodyShape |
| **Deploy fix** | 🟢 | `bodyShape` + skin/hair/eye colors dirty key + profile deploy |

**Still open:** saved outfits · marketplace · mobile emotes sheet · continuous Catalyst sync while equipping.

**QA focus:** Backpack → Eyes → pick base eye → Hair/Skin color → close settings → deploy → reload colors. Switch body shape (male/female) → recompose.

---

## 🎉 Milestone — Avatar facial features backfill → `dev-latest` (2026-07-13)

**Status: merged PR [#22](https://github.com/lastraum/dcl-threejs-client/pull/22)** (supersedes closed #20) — wallet profiles get default facial wearables + face texture orientation fixes.

| Area | Status | Notes |
| ---- | ------ | ----- |
| **Default wearable backfill** | 🟢 | Wallet profiles missing eyes/eyebrows/mouth filled from base catalog |
| **Face texture orientation** | 🟢 | Texture clone + head-hide coverage review fixes |
| **Review follow-ups** | 🟢 | Head-hide, texture clone, coverage (`4b80a77`) |

---

## 🎉 Milestone — scene.json skyboxConfig sun/moon → `dev-latest` (2026-07-13)

**Status: merged PR [#17](https://github.com/lastraum/dcl-threejs-client/pull/17)** — creator lighting from `scene.json` environment / `skyboxConfig`.

| Area | Status | Notes |
| ---- | ------ | ----- |
| **skyboxConfig sun/moon** | 🟢 | Intensity + color knobs for sun/moon from scene metadata |
| **Creator lighting path** | 🟢 | Moved outdoor lighting config under scene.json environment |

---

## 🎉 Milestone — Dev texture proxy host fix → `dev-latest` (2026-07-09)

**Status: merged PR [#10](https://github.com/lastraum/dcl-threejs-client/pull/10)** — `/api/texture` uses the encoded host instead of hard-coded `arweave.net`.

| Area | Status | Notes |
| ---- | ------ | ----- |
| **Texture proxy routing** | 🟢 | Correct upstream host from encoded URL; fixes broken IPFS/Arweave thumbs in local/dev |

---

## 🎉 Milestone — Backpack emotes + input → `dev-latest` (2026-07-13)

**Status: merged `lastraum` → `dev-latest`** (`7890e17`) — Explorer-style emotes tab + WASD after tab blur.

| Area | Status | Notes |
| ---- | ------ | ----- |
| **Emotes tab UI** | 🟢 | Wheel slots 1–9/0, paginated inventory, detail panel; select slot then equip |
| **Emote inventory metadata** | 🟢 | Wallet `/users/{addr}/emotes` + base catalog; Catalyst name/rarity/thumbnail (same pattern as wearables) |
| **Equip / unequip / play** | 🟢 | Assign to profile wheel slots; Play preview on avatar; dirty profile deploys with wearables |
| **WASD after background tab** | 🟢 | Clear keys on blur/visibility/focus; blur chat composer on world click |

**Still open:** saved outfits · marketplace · full filter/sort · mobile emotes sheet · continuous Catalyst sync while equipping.

**QA focus:** Backpack → Emotes → equip custom NFT emote to slot → Play preview → close settings → deploy → reload wheel. Tab away 1 min → return → click world → WASD.

---

## 🎉 Milestone — Auth + backpack → `dev-latest` (2026-07-12)

**Status: merged `lastraum` → `dev-latest`** (`9f6eae4`) — multi-provider sign-in, wearable backpack equip/deploy, mobile inventory, base-hair compose fix.

### Shipped

| Area | Status | Notes |
| ---- | ------ | ----- |
| **Auth-dapp providers** | 🟢 | Google, Discord, Apple, X, WalletConnect, MetaMask; new-tab login (not popup); verification code in client while polling |
| **Auth reliability** | 🟢 | No false “login tab closed”; sign-in after sign-out; guest “Sign in to chat” only when chat opens |
| **Backpack wearables** | 🟢 | Wallet inventory + equipped slots; equip/unequip into session profile; 3D preview (drag orbit, zoom, foot stance) |
| **Catalyst profile deploy** | 🟢 | Deploy wearables on settings close when dirty; ownership URNs via `/users/{addr}/wearables` individualData; saving/error/success UX |
| **Mobile backpack** | 🟢 | Full-height avatar; Equipped sheet; Inventory sheet with search + category filter + full detail + equip |
| **Base-avatar hairs** | 🟢 | All **33** free base hairs bundled; spring-bone → Head remapping so mohawks/default hairs compose (no more bald defaults) |
| **Wallet copy** | 🟢 | Profile menu address click-to-copy (desktop + mobile) |
| **Explore mobile padding** | 🟢 | Place cards no longer clipped by side padding |
| **Non-commercial license** | 🟢 | `LICENSE` + README — all branches; commercial use needs written permission |

### Parity gaps still open (expected)

These are **known incomplete** vs full Explorer / product polish — not blockers for this merge, good follow-ups:

| Gap | Notes |
| --- | ----- |
| **Backpack emotes mobile sheet** | Desktop emotes tab shipped; mobile bottom-sheet for emotes still TBD |
| **Saved outfits** | Mid-tab “Saved outfits” not implemented |
| **Marketplace / buy flow** | Buttons present but disabled / “coming soon” |
| **Filter & sort** | Desktop filter button hidden on mobile; no full Explorer sort (rarity, newest, etc.) |
| **Live profile sync** | Deploy on panel close, not continuous Catalyst sync while equipping |
| **NFT / L1 wearables edge cases** | Most GLB wearables compose; odd L1 bone/export cases may still skip or fallback |
| **Facial feature inventory polish** | Eyes/eyebrows/mouth work via profile; backpack category UX may lag Explorer |
| **AvatarModifierArea / AvatarBase ECS** | Still ⬜ in integration matrix |
| **Graphics P3/P4** | Distance culls + bloom/HDR stubs (unchanged) |
| **2D social chat** | 🟢 multi-room LiveKit + notifications (2026-07-14) — community text / DMs still open |

**QA focus:** Sign in with Google or MetaMask → open Backpack → equip base hair + wearable → close settings → confirm deploy → reload profile hair/clothes. Mobile: Inventory search/filter → detail → equip; Equipped unequip.

**Branch:** `lastraum` → `dev-latest`. License already on `main`.

---

## 🎉 Release — v0.7.0 (2026-07-12)

**Status: cut from `dev-latest` → `main` · tag `v0.7.0`** — post-0.6.0 lighting, graphics prefs, Genesis reliability, camera/input ECS.

### Highlights since v0.6.0

| Area | Notes |
| ---- | ----- |
| **Unity outdoor lighting** | Trilight ambient, soft sun/moon shadows, crescent moon, night fill, lighting sliders + Reset |
| **Graphics prefs P0–P2** | Preset L/M/H, shadows, scene lights, res scale, FPS, **MSAA**; VSync hidden; Fullscreen stub |
| **Genesis / comms** | `realm-provider-ea` /about, archipelago when adapter empty, genesis sky + quiet ground (no empty-land GLB) |
| **Physics / mesh** | y=0 ground clamp; instanced GLB + shared template colliders |
| **Auth** | Jump In requires Guest or wallet |
| **Chat** | People count → inline roster; WASD not stolen while typing |
| **Controls** | Mouse sensitivity 10–200% |
| **Camera ECS** | **CameraMode**, **CameraModeArea**, **PointerLock** + RMB look lock + fixed elevated reticle |

### Still open (not blocking 0.7.0)

| Gap | Notes |
| --- | ----- |
| **Graphics P3/P4** | Distance culls + bloom/HDR stubs |
| **MOVE CAMERA residual** | Edit-flight shim debt |
| **Watch Lite / `/goto`** | Product phases |
| **NftShape / AvatarModifierArea** | Deferred ECS |

**Changelog:** https://github.com/lastraum/dcl-threejs-client/compare/v0.6.0...v0.7.0

---

## 🎉 Milestone — Unity lighting + moon parity (2026-07-11)

**Status: shipped in v0.7.0** (was on `dev-latest` post-0.6.0) — outdoor light/shadow/moon closer to Unity Explorer.

| Area | Status | Notes |
| ---- | ------ | ----- |
| **Trilight ambient** | 🟢 | Hemisphere sky+ground + **equator AmbientLight** (`indirectEquator`) — soft fill on vertical planes |
| **Soft directional shadows** | 🟢 | Day sun + night moon; PCF ortho map follows camera (`directionalSunShadow.ts`) |
| **Intensity curve** | 🟢 | SunCycle **m_Intensity** peak **2.72**, `SUN_BRIGHTNESS` **1.0** (no double boost) |
| **Outdoor PBR softness** | 🟢 | Lower metal / higher roughness floor / reduced specular on scene materials |
| **Sun disc visual** | 🟢 | Small warm disc; look **decoupled** from scene light power; **Reset lighting** in Preferences |
| **Moon disc** | 🟢 | Unity-style **crescent** (disc + offset bite) + companion; small visual size |
| **Night fill** | 🟢 | Stronger night hemi/equator + moon key so PNG planes read at 23:59 |
| **Skybox authority** | 🟢 | (already on v0.6.0) scene → session → auto |

**Docs:** [INTEGRATION.md](./INTEGRATION.md) · [INTEGRATION.md](./INTEGRATION.md)

**QA:** Reset lighting · noon plane soft not silhouette · look up small sun · 23:59 crescent moon + soft purple fill + shadows · Night/Day scrub.

**Still open:** MOVE CAMERA residual · Watch Lite / `/goto` · multi-cascade shadow polish · post-FX bloom/HDR · distance culls (P3).

**On `main` as of v0.7.0.**

---

## 🎉 Milestone — CameraMode / CameraModeArea / PointerLock (2026-07-12)

**Status: shipped in v0.7.0** — freecam mode report + area force + pointer-lock look + fixed reticle.

| Component / UX | Status | Notes |
| -------------- | ------ | ----- |
| **PointerLock** (1074) | 🔵 | Written on CameraEntity; **right-click** (or Tab) toggles lock; locked mouse movement = look; left-click does not orbit when locked |
| **Pointer-lock reticle** | 🟢 | Fixed elevated aim mark (above canvas center); clicks/raycasts share same point — Explorer-style |
| **CameraMode** (1072) | 🔵 | Written on CameraEntity each frame — 1st/3rd from freecam distance (area force overrides) |
| **CameraModeArea** (1071) | 🟢 | DCL volume from Transform + `area` size; forces FPV/TPV while inside; restores distance on leave |

**Not done:** GltfNodeModifiers · PhysicsCombinedForce/Impulse · graphics P3 distances.

**Also shipped:** GltfContainerLoadingState (1049) host LWW · **NftShape (1040)** framed planes + `openNftDialog`.

**QA:** Right-click lock → reticle fixed above center → move mouse orbits without LMB; unlock Esc/Tab/right-click; CameraModeArea FPV zone snaps to first person; leave restores third.

---

## 🎉 Milestone — UI polish → `dev-latest` (2026-07-12)

**Status: shipped on `dev-latest`** (`bcd1253`, via `lastraum`) — chat presence + controls after graphics P0–P2 batch.

| Area | Status | Notes |
| ---- | ------ | ----- |
| **Chat people count** | 🟢 | Scene chat header pill `N people` → inline roster (you + LiveKit peers); row opens profile; Back to chat |
| **Mouse sensitivity** | 🟢 | Preferences → **Controls** · 10–200% · persisted `clientSettings` · scales pointer look in `PlayerSystem` |

**Not in this ship / still open for graphics:**

| Item | Status |
| ---- | ------ |
| **P3 — Scene Distance** | ⬜ UI stub only — no draw/cull distance backend |
| **P3 — Landscape Distance** | ⬜ UI stub only |
| **P3 — Shadows Distance** | ⬜ UI stub only (shadow *quality* is live; range slider is not) |
| **P4 — Bloom / HDR / outline** | ⬜ UI stubs only |

---

## 🎉 Milestone — lastraum batch → `dev-latest` (2026-07-11)

**Status: merged `lastraum` → `dev-latest`** — graphics prefs P0–P2 plus Genesis/product reliability after lighting milestone.

### Graphics prefs (P0–P2) — done

| Control | Status | Notes |
| ------- | ------ | ----- |
| **Graphics Preset** | 🟢 | Preferences: **Low / Medium / High / Custom** (Ultra bundle remains in store; not offered in UI) |
| **Shadows Quality** | 🟢 | Off + Low→Ultra map size |
| **Scene lights** | 🟢 | Enable + max 0–20 |
| **Resolution Scale** | 🟢 | 50–200% × devicePixelRatio |
| **FPS Limit** | 🟢 | 30 / 60 / 120 / Max |
| **MSAA** | 🟢 | Off / 2x / 4x / 8x — WebGL2 multisample RT → blit (`SceneHost`) |
| **Resolution dropdown** | ⬜ | stub (browser owns window size) |
| **Fullscreen** | ⬜ | stub (hidden/disabled for now) |
| **VSync** | — | **hidden** — browsers always rAF-composite; no free-run/tear |

### Graphics P3 / P4 — **not done**

| Control | Status | Notes |
| ------- | ------ | ----- |
| **Scene Distance** | ⬜ | Preferences slider present; **no runtime cull** |
| **Landscape Distance** | ⬜ | Preferences slider present; **no runtime cull** |
| **Shadows Distance** | ⬜ | Preferences slider present; **no shadow range backend** |
| **Bloom / HDR / Avatar Outline** | ⬜ | Preferences stubs → **P4** post-FX stack |

**Persist (quality):** `localStorage` `dcl-render-quality`.

**Files:** `RenderQualitySettings.ts`, `SceneHost.ts`, `GraphicsSettingsView.ts`, `LightManager.ts`, shadow helpers, `detectPerformanceTier.ts`, `integrationRegistry.ts`

**QA:** P → Graphics — Low vs High (scale + FPS + MSAA); MSAA Off vs 8x on building edges; Custom when diverging; Resolution/Fullscreen greyed; confirm distance sliders still do nothing.

### Product / reliability (same branch + follow-ups)

| Area | Notes |
| ---- | ----- |
| **Auth gate** | Jump In requires Guest or wallet |
| **y=0 ground** | Thick infinite ground + fall-through clamp |
| **Instanced GLB colliders** | Shared template shapes + dual-path extract |
| **Comms / archipelago** | `realm-provider-ea` primary Genesis `/about`; island join when adapter empty |
| **Genesis default env** | Sky + quiet ground; no empty-land GLB under genesis |
| **Chat keyboard** | WASD not stolen when chat/text focused |
| **Chat people list** | See **UI polish** milestone (2026-07-12) |
| **Mouse sensitivity** | See **UI polish** milestone (2026-07-12) |

**Next graphics:** **P3** wire Scene / Landscape / Shadows Distance → cull backends · **P4** bloom/HDR EffectComposer path.

---

## 🎉 Milestone — Graphics prefs P2 MSAA (2026-07-11)

**Status: shipped on `dev-latest`** (via lastraum batch) — multisample main pass.

| Control | Status | Backend |
| ------- | ------ | ------- |
| **MSAA** | 🟢 | Off / 2x / 4x / 8x via WebGL2 multisample `WebGLRenderTarget` → blit to canvas (`antialias: false` on context) |
| **VSync** | — | Store default only; **UI hidden** (browser rAF limit) |
| **Fullscreen** | ⬜ | Preferences stub |

**Presets (store):** Low 0× · Medium/High 4× · Ultra 8× (clamped to `renderer.capabilities.maxSamples`). Preferences offers Low/Medium/High only.

**QA:** P → Graphics → MSAA Off vs 8x (edges on buildings/sky); Low preset forces MSAA Off.

---

## 🎉 Milestone — Graphics prefs P0+P1 (2026-07-11)

**Status: shipped on `dev-latest`** — Preferences → Graphics wires into existing render backends (no new post-FX).

| Control | Status | Backend |
| ------- | ------ | ------- |
| **Graphics Preset** | 🟢 | Low / Medium / High (+ Custom) → `renderQuality` bundle |
| **Shadows Quality** | 🟢 | Off + Low→Ultra map size / soft radius; sun + spots |
| **Enable Scene Lights** | 🟢 | `LightManager` master switch |
| **Max Lights in a Scene** | 🟢 | Cap 0–20 (preset defaults 4/6/10/16) |
| **Resolution Scale** | 🟢 | `devicePixelRatio × scale%` (50–200%) |
| **FPS Limit** | 🟢 | 30 / 60 / 120 / Max — throttle in `SceneHost` |
| **FOV + lighting sliders** | 🟢 | already live |
| **MSAA** | 🟢 | see **P2** milestone above |
| **Bloom / HDR / distances** | ⬜ | labeled stubs only |

**Persist:** `localStorage` key `dcl-render-quality`. Auto perf defaults skip when user has saved prefs.

**Files:** `RenderQualitySettings.ts`, `SceneHost.ts`, `LightManager.ts`, `directionalSunShadow.ts`, `spotLightShadow.ts`, `GraphicsSettingsView.ts`, `detectPerformanceTier.ts`

**QA:** P → Graphics — switch Low vs High (pixel ratio + FPS); Off shadows; Max lights 0; toggle scene lights; confirm Custom when diverging; Debug panel tier still works.

---

## 🎉 Release — v0.6.0 (2026-07-11)

**Status: cut from `dev-latest` → `main` · tag `v0.6.0`** — reliability + parity batch after companion social **v0.5.0**.

### Highlights since v0.5.0

| Area | Notes |
| ---- | ----- |
| **Scene UI + pointer** | [#11](https://github.com/lastraum/dcl-threejs-client/pull/11) — stack, z-order pick, play-mode gate |
| **Mesh P0** | [#12](https://github.com/lastraum/dcl-threejs-client/pull/12) — hash drain, instancing, no bulk soft-prime |
| **VirtualCamera** | [#16](https://github.com/lastraum/dcl-threejs-client/pull/16) — bind hydrate, PE-follow, HUD above scene UI |
| **Materials** | [#13](https://github.com/lastraum/dcl-threejs-client/pull/13) + follow-up — empty Creator Hub slots; stop re-apply thrash; AUTO cutout = Unity (alphaMap only) |
| **Sun azimuth** | [#15](https://github.com/lastraum/dcl-threejs-client/pull/15) — celestial negate-X matches scene `dclTransform` |
| **Skybox authority** | Scene fixed → session custom → Auto cycle |
| **Windows yoga** | [#14](https://github.com/lastraum/dcl-threejs-client/pull/14) — nbind path filter; fixes black screen |
| **Dev panel** | In-app suggestions; version from `package.json`; progress live from GitHub |

### Known limitations (not blocking 0.6.0)

| Gap | Notes |
| --- | ----- |
| **MOVE CAMERA** edit-flight residual | Avatar freeze OK; WASD/STOP still shim-debt — [ARCHITECTURE.md](./ARCHITECTURE.md) |
| **Sun intensity / directional shadows** | **Addressed on `dev-latest` post-release** — see [Unity lighting + moon parity](#-milestone--unity-lighting--moon-parity-2026-07-11) |
| **Watch Lite / `/goto`** | Companion Phase 3–4 still open |
| **Graphics post-FX stubs** | Bloom/HDR still UI-only; **MSAA** live (P2); VSync hidden; Fullscreen stub; preset/shadows/lights/res/FPS live |

### Smoke (pre-cut)

Genesis spawn walk · VC character-select/follow · `threejs.dcl.eth` materials + ~07:30 sun side · Night/Day authority · Windows yoga if available.

**Changelog:** https://github.com/lastraum/dcl-threejs-client/compare/v0.5.0...v0.6.0

---

## 🎉 Milestone — Materials + sun azimuth + skybox authority (2026-07-11)

**Status: shipped on `dev-latest`** — community materials/sun PRs merged and QA’d; AUTO cutout matched to Unity; skybox clock priority fixed.

| Area | Status | Notes |
| ---- | ------ | ----- |
| **Material empty slots + re-apply** | 🟢 | [#13](https://github.com/lastraum/dcl-threejs-client/pull/13) — Creator Hub empty `alphaTexture`/`emissiveTexture`/`bumpTexture` `src` ignored; textured materials fingerprint after apply (no per-frame shader recompile thrash) |
| **AUTO alpha vs Unity** | 🟢 | Follow-up `98f830b` — do **not** cut out from albedo PNG alpha alone; dedicated `alphaMap` only (black plate matches Explorer on `threejs.dcl.eth`) |
| **Sun/moon azimuth** | 🟢 | [#15](https://github.com/lastraum/dcl-threejs-client/pull/15) — `unityQuatToThreeDirection` uses same YZ/negate-X as `dclTransform` (was 180° azimuth off); QA morning light on vertical plane |
| **Skybox time authority** | 🟢 | `f112671` — (1) scene.json / ECS `SkyboxTime` (2) session custom TOD in `sessionStorage` (3) Auto 60× cycle; scene lock always syncs and preempts custom |
| **Night/Day panel** | 🟢 | Auto disabled while scene-locked; custom slider respects authority |

**Docs:** [INTEGRATION.md](./INTEGRATION.md) · [INTEGRATION.md](./INTEGRATION.md)

**QA:** `threejs.dcl.eth` — black plate like Unity · pin ~07:30 front-lit plane same side as Explorer · Auto vs custom session survives reload in-tab · no material.version thrash after load.

**Follow-up:** intensity + sun/moon shadows + moon disc shipped in [Unity lighting + moon parity](#-milestone--unity-lighting--moon-parity-2026-07-11). Yoga Windows shipped in **v0.6.0** ([#14](https://github.com/lastraum/dcl-threejs-client/pull/14)).

---

## 🎉 Milestone — VirtualCamera bind + PE-follow reliability (2026-07-11)

**Status: shipped on `dev-latest`** ([#16](https://github.com/lastraum/dcl-threejs-client/pull/16)) — scene-agnostic VirtualCamera / player-frame work so cinematic and third-person rigs stay correct under load.

| Area | Status | Notes |
| ---- | ------ | ----- |
| **`vc-bind-hydrate`** | 🟢 | Structural package before `player-frame`: VirtualCamera + Transform (+ ancestors when needed) when MainCamera bind **graph** changes |
| **Locked / cinematic shots** | 🟢 | Worker `getWorldPosition` / rotation under Root — main does not rebuild incomplete parent trees |
| **Third-person follow** | 🟢 | Classic `parent === lookAt` → main `f(PlayerEntity) + local` every frame; no lag fallback to stale cameraParent CRDT |
| **Hydrate spam / hitch flicker** | 🟢 | Follow graph key is **structure-only** (not moving parent pose); live lane rejects cold Transform while held |
| **WASD with VC active** | 🟢 | Move relative to lens; right = forward × world up (matches freecam) |
| **Player-frame hot path** | 🟢 | `InputModifier` + `MainCamera` only; pose on `vc-pose-live` |
| **Client HUD stack** | 🟢 | Sidebar / location pill + circular minimap / chat above scene ECS UI (`--z-client-hud` > `--z-scene-ui`) |
| **Splash removal** | 🟢 | No full-screen splash; session resume + explorer auth sheet |

**Docs:** [ARCHITECTURE.md](./ARCHITECTURE.md) · [ARCHITECTURE.md](./ARCHITECTURE.md) · [ARCHITECTURE.md](./ARCHITECTURE.md)

**QA:** Jump in → character-select or cinematic VC shows stage content (not freecam at spawn) · gameplay follow tracks player under FPS dips · A/D not inverted under VC · HUD above dense scene UI · no hydrate spam in console on follow.

**Not in this PR:** MOVE CAMERA edit-flight STOP polish (see player-frame progress), Watch Lite voice, in-world `/goto`.

---

## 🎉 Milestone — Dev panel in-app suggestions (2026-07-07)

**Status: shipped on `dev-latest`** — in-client feedback loop without leaving the app or opening GitHub manually.

| Area | Status | Notes |
| ---- | ------ | ----- |
| **Suggest form** | 🟢 | Dev panel header **💡 Suggest** → summary, category, details; alphabetized categories |
| **Author context** | 🟢 | Auto-attaches wallet DCL display name + route + client version |
| **GitHub issues** | 🟢 | Creates `[suggestion]` issues with `suggestion` label |
| **Production** | 🟢 | [Cloudflare Worker](https://dcl-threejs-client-suggestions.lastraum.workers.dev) — baked into prod builds (`githubDocs.SUGGESTION_WORKER_URL`) |
| **Local dev** | 🟢 | `POST /api/suggestions` via vite middleware + `SUGGESTION_DISPATCH_TOKEN` |
| **Issue template** | 🟢 | `.github/ISSUE_TEMPLATE/suggestion.yml` for manual GitHub filing |

**QA:** `npm run dev` with token → submit → issue appears on GitHub. Prod build → same from live site. No new-tab redirect.

---

## 🎉 Milestone — Companion social shell merge (2026-07-07)

**Status: shipped on `dev-latest`** (`c53af86`) — `decentraland-social-merge` fast-forward merge (5 commits, 50 files, ~11k LOC). Implements social merge plan (removed) Phases **1**, **2**, **2.5**, and **partial 3**.

| Area | Status | Notes |
| ---- | ------ | ----- |
| **Phase 1 — Explorer at `/`** | 🟢 | Cold `/` shows `ExplorerView` + `PlacesView`; no scene load; inline wallet/guest auth; card **Visit** → `/<segment>` landing |
| **Phase 2 — Scene landing** | 🟢 | `SceneLandingView` info hub; `AppMode` landing ↔ play; **Jump in** / **Leave** on same URL; events banner + `EventModal` |
| **Phase 2.5 — Shell nav** | 🟢 | `SocialShellTopNav` on explorer, landing, events, communities, map, profile; `/communities` browse grid + `CommunityModal` |
| **Phase 3 — 2D chat dock** | 🟢 (later) | Multi-room pool + Watch Lite cast shipped 2026-07-14; original merge was partial dock only |
| **Profile page** | 🟢 | Full-screen `ProfilePageView` — wearables, communities, social shell parity |
| **Map page** | 🟢 | `MapPageView` — Genesis map outside in-world settings overlay |
| **Jump-in loading UX** | 🟢 | Companion-style top progress bar + status on landing; `ClientShell` hidden until world handoff; comms preserved across Jump in |
| **2D sign-out** | 🟢 | `signOutFrom2dShell()` — full comms disconnect + chat dock dispose (guest + wallet) |
| **Community thumbnails** | 🟢 | `communityThumbnailProxy`, `communityThumbnails`, enriched `memberCommunities`; wired in browse, profile, modal, chat dock |

**Commits:** `33bf03d` · `3a7232d` · `f6bf4d8` · `b1a8a38` · `c53af86`  
**Branch:** `decentraland-social-merge` → merged `dev-latest` (fast-forward, no conflicts)

**Not in this merge (at the time):** Phase 3 Watch Lite full LiveKit, Phase 4 `/goto`. **Later:** multi-room + cast → `dev-latest` 2026-07-14; `/goto` + voice still open.

**QA:** `/` no WebGL · Visit → landing not play · Jump in loads 3D with deferred sidebar · Leave → landing · Explore/Communities/Events tabs · chat dock sign-out · community thumb 404 fallback · landing title matches in-world chat.

---

## 🎉 Milestone — Terrain editor UX polish (2026-07-02)

**Status: shipped on `dev-latest`** (`6888496`) — `editor-update` merge: sculpt preview accuracy, biome shading, and creator scale references.

| Area | Status | Notes |
| ---- | ------ | ----- |
| **Height shading** | 🟢 | Water, sand, grass, rock use **Color + From/To/Blend** height bands; rock by elevation (not slope); draft migration for legacy fields |
| **Heightmap probe** | 🟢 | U sampling aligned with mesh — fixes wrong height HUD and vertex colors on mountains |
| **Water preview** | 🟢 | Removed fixed Y=5 preview plane; water tint from height bands only (matches deploy shading) |
| **Fly camera** | 🟢 | Space up · Shift down · Q/E yaw · Alt sprint · right-drag orbit |
| **Viewport stack** | 🟢 | Right-aligned zoom +/−, camera reset, keyboard-hint popover; terrain height HUD under cursor |
| **Max height guide** | 🟢 | Toggle **G** — axis to terrain peak |
| **Avatar scale guides** | 🟢 | Baked static **BaseMale** bind-pose mannequins via `InstancedMesh`; heightmap placement (no raycasts); **1–256 per parcel** density slider; toggle **B** |

**Commits:** `6888496`  
**Branch:** `editor-update` → merged `dev-latest`

**QA:** sculpt on sloped terrain — height HUD matches brush; toggle mannequins at 1 / 64 / 256 density; water/sand/grass transitions at configured From/To; save + reload draft.

---

## 🎉 Milestone — Terrain editor large-scene performance (2026-07-02)

**Status: shipped on `dev-latest`** — `editor-update` follow-up: 300×300 parcel scenes stay usable (~200 MB tab RAM vs multi‑GB OOM).

| Area | Status | Notes |
| ---- | ------ | ----- |
| **Avatar guides memory** | 🟢 | Lazy GLB/GPU init on toggle **B** only; freed when hidden; **8k** instance cap with parcel stride (slider keeps per-parcel density) |
| **Parcel grid** | 🟢 | Lazy alloc + Viewport checkbox; fixed 1 m division math; off by default on huge footprints |
| **Camera overview** | 🟢 | Large-footprint framing + extended far plane — fixes invisible terrain on 4800×4800 m scenes |
| **Merged export** | 🟢 | \>512 parcels → single capped footprint mesh in `terrain.glb` (avoids 90k-plane save OOM) |

**Branch:** `editor-update` → merged `dev-latest`

**QA:** open 300×300 project — terrain + composite visible on load; toggle mannequins, drag density slider (16 vs 64 changes layout); Save without ArrayBuffer OOM.

---

## 🎉 Milestone — Genesis spawn physics + chat/avatar polish (2026-06-27)

**Status: shipped on `dev-latest`** (`f266be4`) — `lastraum` fast-forward merge after plaza spawn QA.

| Area | Status | Notes |
| ---- | ------ | ----- |
| **Genesis Plaza spawn** | 🟢 | CCT created **after** collider seal + `warmStaticScene()`; unsafe pose slides invalidate + recook instead of leaving stale actors |
| **Collider runtime** | 🟢 | Entity-local boot cooks + incremental pose slides (6147e7e pipeline); no per-frame O(scene) PhysX walks at play time |
| **Pointer raycast perf** | 🟢 | `preparePointerRaycast` syncs **CL_POINTER** MeshColliders only; GLTF targets use live scene graph (no PhysX extractor walk) |
| **Chat timestamps (Explorer)** | 🟢 | RFC4 Chat `protocol_version` 100 + unix timestamp — fixes ~1970 dates in Unity Explorer (`4089a2c`) |
| **RTFKT / L2 feet** | 🟢 | Hips-only shoe rig merge, cm→m bake, nested armature scale flatten (`4089a2c`) |

**Commits:** `4089a2c` · `777762f` · `f266be4`  
**Branch:** `lastraum` → merged `dev-latest`

**QA before `main`:** Genesis Plaza spawn + short walk, RickRoll pointer clicks, Explorer chat timestamp cross-check, RTFKT feet if equipped.

---

## 🎉 Milestone — Terrain editor & deploy export (2026-06-24)

**Status: shipped on `dev-latest`** — browser terrain sculpt for local scenes + deployable `assets/terrain/terrain.glb`.

| Area | Status | Notes |
| ---- | ------ | ----- |
| **Editor hub** | 🟢 | `/editor` project list; **Link Scenes folder** (FSA) — scenes in Documents/Downloads, not `~/Library` |
| **Sculpt session** | 🟢 | Height + splat brushes, undo/redo, procedural shading, max-height guide, fly camera |
| **Draft storage** | 🟢 | 1024² height/splat/lava in IndexedDB per project (not deployed) |
| **Deploy export** | 🟢 | `terrain.glb` + `main.composite` entity 9001; baked 512² albedo for Unity Explorer |
| **Export density** | 🟢 | Panel option: **32 / 64 / 96 / 128** segments per 16 m parcel (default **64**) |
| **Runtime** | 🟢 | Author terrain skips default landscape ground; `LandscapeAssetSanitizer` unlit vertex-color path |
| **Collision** | 🟢 | `visibleMeshesCollisionMask: CL_PHYSICS`; invisible collider meshes removed from export |

**Deploy size (approx., 5×5 parcels):** 128 segs ~17 MB · **64 segs ~4–5 MB** · 32 segs ~1–2 MB (sculpt preview stays full resolution).

**Files:** `src/editor/**`, `terrainComposite.ts`, `sceneAuthorTerrain.ts`, `RenderGroundSystem.ts`, `LandscapeAssetSanitizer.ts`, `vite-plugins/localProjectsBridge.ts`

**Branch:** `terrain-editor` → merged `dev-latest`

---

## 🎉 Milestone — dev-latest rollup (2026-06-22)

**Status: shipped on `dev-latest`** (`43aad5c`) — consolidates the June 22 `lastraum` → `dev-latest` merge batch. Dev panel **Shipped** + **Full status** tabs load this file from `dev-latest` at runtime.

| Area | Status | Notes |
| ---- | ------ | ----- |
| **Media ECS** | 🟢 | **AudioSource** + **AudioStream** + **VideoPlayer** production paths; **Billboard** + **Animator** + **ParticleSystem** GPU sprites |
| **Preferences → Sounds** | 🟢 | Master, UI SFX, voice/streams, in-world, avatar-emote volume sliders wired (`58893b1`) |
| **Genesis sky** | 🟢 | Camera-centered dome rays + correct far-plane depth — fixes pinwheel clouds + gray-sky regression (`43aad5c`) |
| **Low-end perf** | 🟢 | Client tier detection → relaxed scene-worker abort/interval + adaptive backoff (`43aad5c`) |
| **DCM chat images** | 🟢 | Drag-drop, auto-resize \< 1 MiB, animated GIF, inline chat display (`e19a32e`) |
| **Environments** | 🟢 | Landscape parcels, **FFT ocean**, Perlin scatter foliage, outdoor lighting (`50c6021`) |
| **Boot / hydration** | 🟢 | `main.crdt` seed, unified GLB pipeline, composite preload, fast onStart CRDT path, warm-scene load restore |
| **Profile & pills** | 🟢 | User/remote pill hover, badges row, right-click profile menu, shared profile modal |
| **Settings shell** | 🟢 | Events calendar, Places, Gallery restored; location pill + circular minimap (parcels); fatal load errors |
| **Scene stability** | 🟢 | React-heavy deploy engine capture; emote camera orbit while scene-locked |

**Merged:** `lastraum` → `dev-latest` (2026-06-22, tip `43aad5c`)

---

## 🎉 Milestone — scene glTF alpha-blend parity (2026-06-22)

**Status: shipped on `dev-latest`** (`e16fe81`) — faint blue elevator tube at **La Cantina `-150,95`** matches Unity Explorer.

| Area | Status | Notes |
| ---- | ------ | ----- |
| **Scene GLTF transparency** | 🟢 | `sanitizeSceneGltfMaterials` no longer forces foliage alpha-cutout on creator meshes |
| **Landscape foliage** | 🟢 | `tuneFoliageMaterial` stays on `sanitizeLandscapeGltf` only (empty-land tree cards) |

**Root cause:** `tuneFoliageMaterial` ran inside `simplifyMaterial` for every scene GLB — transparent / low-opacity materials were rewritten to `alphaTest` cutout instead of glTF **alpha blend**.

**Files:** `LandscapeAssetSanitizer.ts`

**Branch:** `hotfix-transparent-textures` → merged `dev-latest`

---

## 🎉 Milestone — DCM v1 chat images (2026-06-22)

**Status: shipped** — inline images in scene chat (separate wire from 140-char text chat).

| Area | Status | Notes |
| ---- | ------ | ----- |
| **Protocol** | 🟢 | `dcl.chat.media` over RFC4 `Packet.scene`, chunked ~12 KiB for LiveKit |
| **Prepare** | 🟢 | Static → WebP/JPEG; animated GIF preserved; oversized GIF downscale via `ImageDecoder` + `gifenc` |
| **UI** | 🟢 | Chat panel drag-drop; image lines render inline in chat box |
| **Size cap** | 🟢 | Auto-resize to \< 1 MiB before send |

**Files:** `dcmChatMedia.ts`, `prepareChatImage.ts`, `Rfc4Router.ts`, `CommsService.ts`, `LiveKitCommsSession.ts`, `SocialService.ts`, `ChatPanel.ts`

**Merged:** `e19a32e` → `dev-latest`

---

## 🎉 Milestone — Environments: landscapes, FFT ocean, Perlin scatter (2026-06-22)

**Status: shipped** — Genesis / island outdoor stack beyond the procedural skydome.

| Area | Status | Notes |
| ---- | ------ | ----- |
| **Landscape parcels** | 🟢 | `LandscapeSystem` + terrain model; parcel grid padding |
| **FFT ocean** | 🟢 | `FftOceanWater`, island/open ocean rings, perf stats hook |
| **Perlin scatter** | 🟢 | `EzTreeGrassField` + foliage wind on supported scenes |
| **Outdoor lighting** | 🟢 | Sun/moon/hemi hybrid with ECS light budget dimming |
| **Walk bounds** | 🟢 | Island circular bounds + scene footprint view distance |

**Files:** `LandscapeSystem.ts`, `FftOceanWater.ts`, `OpenOceanWater.ts`, `IslandWater.ts`, `OceanRing.ts`, `resolveLandscapeEnvironment.ts`, `World.ts`

**Merged:** `50c6021` → `dev-latest`

---

## 🎉 Milestone — Boot & hydration performance (2026-06-22)

**Status: shipped** — cold Genesis loads and warm revisits after unified GLB pipeline.

| Area | Status | Notes |
| ---- | ------ | ----- |
| **main.crdt seed** | 🟢 | Renderer snapshot before worker eval — fixes 0/0 GLTF hydration stalls |
| **Unified GLB pipeline** | 🟢 | Bytes-only prefetch, parse pool, budgeted attach on main thread |
| **Worker boot** | 🟢 | Main-thread script fetch; eval CRDT deadlock fix; composite preload after eval |
| **onStart CRDT** | 🟢 | Fast path during scene `onStart`; hydration unblocked after bundle eval |
| **Warm scenes** | 🟢 | Restored load times after unified pipeline (`cbdca8d`) |

**Files:** `SceneScriptSystem.ts`, `AssetCache.ts`, `glbFetchPool.ts`, `sceneWorker.ts`, `ThreeBridge.ts`, `World.ts`

---

## 🎉 Milestone — Render bridges: Billboard, Animator, ParticleSystem (2026-06-22)

**Status: shipped** — Phase 1b/6 sprite and animation paths used by Genesis Plaza and deploy scenes.

| Area | Status | Notes |
| ---- | ------ | ----- |
| **Billboard** (1090) | 🟢 | `BillboardBridge` — live ECS scan + post-tween reconcile |
| **Animator** (1042) | 🟢 | `AnimatorBridge` — GLTF clip states |
| **ParticleSystem** (1217) | 🟢 | `ParticleSystemBridge` — GPU-instanced billboard sprites, DCL gravity/blend |
| **VideoPlayer** (1043) | 🟢 | See milestone below — RickRoll + scene screens |
| **TextShape** (1030) | 🟢 | Canvas texture planes |

**Files:** `BillboardBridge.ts`, `AnimatorBridge.ts`, `ParticleSystemBridge.ts`, `bridge/particles/*`, `SceneScriptSystem.ts`

---

## 🎉 Milestone — Profile, settings shell & social UI (2026-06-22)

**Status: shipped** — Explorer-style chrome restored and extended.

| Area | Status | Notes |
| ---- | ------ | ----- |
| **Location pill** | 🟢 | Top-left scene name + parcel coords; pairs with circular minimap on parcels |
| **Profile pills** | 🟢 | Hover state, badges row, right-click → profile menu |
| **User pill menu** | 🟢 | Shared profile modal; overlay visibility fixes |
| **Settings → Events** | 🟢 | DCL Events API weekly/calendar — full-height layout |
| **Settings → Places** | 🟢 | Explore tab + CORS proxy; category filters |
| **Settings → Gallery** | 🟢 | Camera Reel month grid |
| **Name tags** | 🟢 | Raised offset; hidden on nameless `AvatarShape`; emote chat filter |
| **Load errors** | 🟢 | Fatal scene load surfaced in UI |

**Files:** `ClientShell.ts`, `LocationCard.ts`, `ProfileModal.ts`, `EventsView.ts`, `PlacesView.ts`, `GalleryView.ts`, `NameTagRenderer.ts`, `formatSceneLoadError.ts`

---

## 🎉 Milestone — Low-end perf + Genesis sky dome fix (2026-06-22)

**Status: shipped** — Windows 10 / weak Chrome no longer spam-abort `onUpdate` or show broken skies.

| Area | Status | Notes |
| ---- | ------ | ----- |
| **Performance tier** | 🟢 | `detectPerformanceTier()` — CPU/RAM/GPU heuristic + `?perf=low` override |
| **Scene worker** | 🟢 | Low/medium play-ready abort + interval; adaptive backoff; single-flight `onUpdate` |
| **Render defaults** | 🟢 | Low tier → quality Low + pixel ratio cap |
| **Sky dome** | 🟢 | Model-space view rays + `clipPos.xyww` far plane; full camera follow |

**Files:** `detectPerformanceTier.ts`, `sceneWorker.ts`, `DclGenesisSky.ts`, `EnvironmentSystem.ts`, `World.ts`

**Merged:** `43aad5c` → `dev-latest`

---

## 🎉 Milestone — Audio ECS + Preferences Sounds (2026-06-18)

**Status: shipped** — Cantina Fashion + scene deploys load AudioSource/AudioStream; volume categories wired in preferences.

| Area | Status | Notes |
| ---- | ------ | ----- |
| **AudioSource** (1020) | 🟢 | `AudioSourceBridge` + `SceneAudioPlayer` — buffer clips, spatial/global, in-world vs player-parented emote gain |
| **AudioStream** (1021) | 🟢 | `AudioStreamBridge` + `SceneAudioStreamPlayer` — HTTP/HLS, voice-chat volume category |
| **AudioEvent** (1105) | 🟢 | Grow-only `MediaState` → worker (source + stream entities) |
| **Shared listener** | 🟢 | One `AudioListener` on camera; master volume from preferences |
| **Preferences → Sounds** | 🟡 **partial** | **Live:** master, UI SFX, voice/streams, in-world, avatar-emote categories; **pending:** mic device + mute-in-background (needs voice UI) |
| **Natural end sync** | 🟢 | AudioSource writes `playing:false` LWW on clip end |

**Files:** `AudioSourceBridge.ts`, `SceneAudioPlayer.ts`, `AudioStreamBridge.ts`, `SceneAudioStreamPlayer.ts`, `AudioBufferCache.ts`, `SoundSettings.ts`, `SoundsSettingsView.ts`, `MicDeviceService.ts`, `mirrorComponents.ts`, `CrdtEncoder.ts`, `SceneScriptSystem.ts`

**Merged:** `lastraum` → `dev-latest` (`c608dbc`, 2026-06-18)

---

## 🎉 Milestone — Lighting & skybox polish (2026-06-18)

**User-confirmed working (opbadge / night mode):** scene LED strips read warm emissive (not flat white); skybox clouds white at midday; preferences panel opens over live world (orbit + WASD still work).

| Area | Status | Notes |
| ---- | ------ | ----- |
| **Preferences panel (P / ⚙)** | ✅ | Separate from main overlay — Graphics, Sounds, Controls, Chat tabs; right rail; no pointer-lock exit |
| **User lighting sliders** | 🟡 **partial** | **Scene Sun Light**, **Exposure** (day), **Scene Moon Light**, **Moon Exposure** (night) — persisted in `SunEnvironmentSettings` |
| **Skydome sun look** | ✅ | Locked to small disc / no corona (former 0% sliders removed) |
| **Skybox clouds** | ✅ | HDR cloud gradient tint + screen brighten + sun-facing lift; `toneMapped: false` on sky shader |
| **Scene GLTF emissives** | 🟡 **partial** | DCL model: clamp emissive RGB → `emissiveIntensity` (KHR strength 2–80+); named neon mats (`LightLED`, etc.) — **decent, room to improve** |
| **Baked emissive maps** | ✅ | Floor/wall bake mats skipped — no blowout |
| **Graphics quality prefs** | 🟢 | Preset L/M/H, shadows, lights, res scale, FPS, MSAA live; VSync hidden; Fullscreen stub; bloom/HDR stubs |
| **Custom skybox worlds** | 🟡 | User sliders affect Genesis path only; cubemap `/about` scenes hide `DclGenesisSky` |

**Files:** `PreferencesPanel.ts`, `SunEnvironmentSettings.ts`, `DclGenesisSky.ts`, `EnvironmentSystem.ts`, `sceneGltfEmissives.ts`, `GraphicsSettingsView.ts`

**Merged:** `lastraum` → `dev-latest` (2026-06-18)

---

## 🎉 Milestone — VideoPlayer ECS parity (2026-06-18)

**User-confirmed working:** `rickroll.dcl.eth` screen — auto-play on load, video texture on plane, pointer play/pause toggle, end-of-video replay on first click, pause/resume from current frame.

| Area | Status | Notes |
| ---- | ------ | ----- |
| Decoder | ✅ | `WebVideoPlayer` — HTMLVideoElement + `THREE.VideoTexture` (HLS via hls.js) |
| ECS bridge | ✅ | `VideoPlayerBridge` — projection ↔ decoder; grow-only `VideoEvent` outbound |
| Scene toggle | ✅ | Worker `VideoPlayer.getMutable().playing = !playing` via pointer CRDT |
| End-of-video | ✅ | Natural end syncs `playing:false` + LWW inject; click replays from start |
| Material | ✅ | Video texture binds at metadata; material pass on `onTextureReady` |
| Worker inject | ✅ | `VideoPlayer` LWW + `VideoEvent` append via renderer inject path |

**Files:** `WebVideoPlayer.ts`, `VideoPlayerBridge.ts`, `videoTextureOrientation.ts`, `injectRendererLwwPuts.ts`, `injectRendererGrowOnlyAppends.ts`, `CrdtEncoder.ts` (LWW capture)

---

## 🎉 Milestone — TriggerArea Tier A parity (2026-06-17)

**User-confirmed working:** box + sphere `TriggerArea` volumes fire scene `onTriggerEnter` / `onTriggerExit` callbacks; grow-only `TriggerAreaResult` CRDT delivery to the scene worker.

| Area | Status | Notes |
| ---- | ------ | ----- |
| Detection | ✅ | DCL-native math probes (default); optional PhysX Tier B via `?triggerParity` |
| CRDT path | ✅ | `TriggerAreaSystem` → `CrdtEncoder` → worker inject + awaited engine tick |
| Bundled scenes | ✅ | `patchSceneBundle` captures correct engine at `addTransport(renderer)` |
| Debug | ✅ | `?triggerverbose` probes · `npm run test:trigger` (11/11) |

**Files:** `TriggerAreaSystem.ts`, `triggerAreaMath.ts`, `triggerAreaEmit.ts`, `injectTriggerAreaAppends.ts`, `SceneScriptSystem.updateTriggerAreas()`

**PR:** [#2](https://github.com/lastraum/dcl-threejs-client/pull/2) → `dev-latest` (closes [#1](https://github.com/lastraum/dcl-threejs-client/issues/1))

---

## 🎉 Milestone — AvatarAttach Tier B parity (2026-06-17)

**User-confirmed working:** entities with `AvatarAttach` follow local player, remote peers, and `AvatarShape` NPC bones — SDK-parity avatar-relative `Transform` on the worker + composed world pose on the renderer.

| Area | Status | Notes |
| ---- | ------ | ----- |
| Bone sampling | ✅ | All `AvatarAnchorPointType` anchors; name-tag offset |
| Transform model | ✅ | `playerTransform ⊗ relativeTransform` — not raw world-matrix copy |
| Main thread | ✅ | `AvatarAttachBridge` — `projection.setRenderer` + EntityStore world apply |
| Worker batch | ✅ | `avatar-attach-transforms` message per frame |
| Targets | ✅ | LocalAvatar, RemoteAvatarManager, AvatarShapeBridge |
| Conflicts | ✅ | Attach wins over inbound Transform apply + Tween |

**Files:** `AvatarAttachBridge.ts`, `avatarAttachMath.ts`, `avatarAttachAnchors.ts`, `applyAvatarAttachTransforms.ts`, `World.bindAvatarAttachTargets()`

---

## 🎉 Milestone — Explorer visual parity (2026-06-12)

**Confirmed working:** side-by-side with Unity Explorer on `rickroll.dcl.eth` — scene layout, NPC positions, dancer rows, and environment props now match (no X-axis mirror).

### Root cause

DCL SDK7 uses a **left-handed** scene space (+X east, +Y up, +Z north). Three.js is **right-handed** with the same axis labels. Copying ECS transform bytes directly into `Object3D.position` / `quaternion` mirrored the entire scene on X vs Explorer.

### Fix — `src/bridge/dclTransform.ts`

Conversion at the **render boundary only** (simulation, comms wire, minimap, CRDT mirror stay in DCL meters):


| DCL (logical) | Three.js (display) |
| ------------- | ------------------ |
| position `(x, y, z)` | `(-x, y, z)` |
| quaternion `(x, y, z, w)` | `(-x, y, z, -w)` |
| yaw | negated |

Applied consistently to:

- `ThreeBridge` / `applyDclLocalTransform` — all ECS entities
- `PlayerSystem` — PhysX capsule display + bounds; `getPosition()` returns DCL for wire/minimap
- `ReservedEntitiesSync` — player/camera poses written back to CRDT in DCL space
- Landscape + water + PhysX ground tiles
- `RemoteAvatarManager` — inbound comms positions/yaws converted for display

**Do not** use `scale.x = -1` on a scene root (breaks normals / backface culling).

### Also shipped (same push)


| Area | Status | Notes |
| ---- | ------ | ----- |
| RFC4 movement encode/decode | 🟡 aligned | Bevy `global_crdt` + Unity Foundation wire — position X pass-through, velocity Z negated, yaw via `(yaw - π)` degrees |
| Comms plugin architecture | ✅ | Bevy-shaped `CommsService` — archipelago path, Scene packet routing |
| LiveKit session scaffold | ✅ | `LiveKitCommsSession` + movement broadcast loop |
| Remote avatar placeholders | ✅ | blank body → Catalyst profile swap + lerp |

### Next up — **social comms integration**

Goal: see other players in-scene **and** in the social layer (voice/presence) like Explorer — building on the coordinate fix so positions are trustworthy.


| Priority | Task |
| -------- | ---- |
| 1 | End-to-end peer visibility on realm comms (Two clients, same scene, correct positions) |
| 2 | Profile broadcast + remote avatar load on join |
| 3 | Voice / presence (LiveKit or realm adapter — match deployed `rickroll.dcl.eth` comms adapter) |
| 4 | Gatekeeper / signed-login if realm requires it |

**Comms references:** Bevy inbound · Unity Foundation outbound · dcl-companion LiveKit patterns.

---

## Glossary (SDK terms vs client status)

| Term | What it is | Client status |
| ---- | ---------- | ------------- |
| **Tags** | ECS component — string labels on entities (`Tags.tags: string[]`). Scenes query with `engine.getEntitiesByTag("door")` instead of hard-coded entity ids. Not a separate “tag” API on Transform. | ✅ **Mirror CRDT sync** — `getEntitiesByTag()` works when tags are set in scene or composite. |
| **`EngineApi.sendBatch`** | Legacy kernel API drained each frame by SDK `pollEvents()`. **SDK7 only consumes `comms` generic events** — other observables use ECS in the worker. | ✅ **SDK7 parity** — `comms` topic → queue → `onCommsMessage`. |
| **`EngineApi.subscribe`** | Scene registers interest in an `eventId`. We implement **`comms` only** (matches `@dcl/sdk` `pollEvents`). | ✅ **Implemented** — paired with `sendBatch`. |
| **`PET_PROXIMITY_*`** | `PointerEventType.PET_PROXIMITY_ENTER` / `PET_PROXIMITY_LEAVE` on **`PointerEvents`** — fires when the **player avatar walks within range** of an entity (no cursor ray). Distinct from **`TriggerArea`** (volume component + `TriggerAreaResult`). | ⬜ **Not implemented** — cursor hover/down/up only (`PointerEventsSystem`). |

---

## 🎉 Milestone — PhysX + LightSource FPS (2026-06-13)

**Confirmed working:** Genesis Plaza + RickRoll — local player feet on ground (matching NPCs/remotes), PhysX capsule debug aligned with avatar, **major FPS improvement** from LightSource culling in light-heavy scenes.

### PhysX / player grounding ✅

| Fix | Notes |
| --- | ----- |
| Capsule ↔ avatar alignment | Bone-based `feetAlign.ts` — soles at player root; removed wrong hardcoded pivot offset |
| Local player floating | Tighter ground sweep (0.22 m Hyperfy parity), feet snap on spawn/teleport/grounded frame; spawn Y defaults → 0 |
| PhysX debug toggles | Help panel — flat checkboxes for MeshCollider / GLTF / local capsule wireframes |
| Ground colliders | Per-parcel landscape boxes at y=0 — **no** infinite fallback plane |

### LightSource system ✅ (see INTEGRATION / PROGRESS lighting milestones)

| Area | Status | Notes |
| ---- | ------ | ----- |
| Intensity / range / spot aim | ✅ | Candelas `/4000`, range clamp, spot target, decay=2 |
| `LightManager` | ✅ | 40 m cull · tier caps 4/6/10 · 3 spot shadow flags |
| Quality hook | ✅ | Debug panel tier + `renderQuality` API |
| Genesis Plaza FPS | ✅ | User-confirmed huge improvement vs uncapped lights |

### Pre-live blockers ✅ **CLEARED** (2026-06-13)

| Blocker | Status | Notes |
| ------- | ------ | ----- |
| **Emote GLB props** | ✅ **confirmed** | `SkeletonUtils.clone()` rebinds skinned particle props; Money/Clap/Kiss/Champagne props visible local + remote + AvatarShape |
| **Sun / skybox** | ✅ **confirmed** | Stronger sun + skydome halo; cloud blend fix (no blue speckle); shadows + tone mapping — see INTEGRATION / PROGRESS lighting milestones |

---

## 🎉 Milestone — Emote GLB props (2026-06-13)

**User-confirmed working:** profile emote wheel props (Money, Clap, Kiss, etc.) render and animate.

### Root cause

`Object3D.clone(true)` on emote GLBs left `SkinnedMesh` skeletons pointing at the **cached AssetCache root**, while `propMixer` animated **cloned bones** under the avatar — props never moved with visible meshes.

### Fix

- `SkeletonUtils.clone()` in `cloneEmotePropRoots()` — proper skinned-mesh rebind
- `propRoot` parented on avatar pivot; emote loads skip landscape material sanitizer (MASK particles)
- Scene-emote URNs resolve from scene manifest (not Catalyst profile path)

**Files:** `emotePlayback.ts`, `AvatarAnimations.ts`, `AssetCache.ts`, `profileEmotes.ts`

---

## Summary

Phase 0 **done**. Phase 1 **closed** (**GltfContainer ✅** — `ThreeBridge` + `AssetCache` on all GLTF scenes). **Phase 1b render bridges wired** (LightSource ✅ + LightManager, TextShape, Billboard, Animator). Phase 2a player **done** (PhysX grounding ✅, **GLTF `_collider` trimesh blocking ✅**). Phase 2c reserved entities **done**. Phase 4a–4c + 4b avatar **done** — **emote GLB props ✅**, **double-jump VFX ✅**, **`AvatarEmoteCommand` bridge ✅**. Phase 3 motion **`Tween` bridge ✅** — transform + textureMove + **Genesis blimp orbit (`TweenSequence`) ✅**. Phase 3a environment **closed** (sun + clouds ✅, **moon fill + night exposure ✅**). **Phase 3b `PointerEvents` ✅** — camera raycast + hover tooltips + CRDT results + **Explorer parity (2026-06-14)**: button icons, green/red highlight, per-entry distance, E/F/click/1–4/Space/Ctrl, scene `console.log` → client debug. Client chrome **expanded** (map, events, chat nav links + @mentions, **world location card**, **dev progress panel**, loading hold + **hydration elapsed timer (count-up)**). **Session GLB cache ✅** — survives teleports. **Explorer layout parity ✅**. Phase 5 **position sync aligned** + scene chat ✅ (140 char, nav links, @mention bubble highlight; Explorer dates ⬜). **Companion social shell ✅ (2026-07-07)** — Explorer `/`, scene landing, shell nav, 2D chat dock partial, profile/map pages on `dev-latest`. **Pre-live blockers cleared** — browser push candidate.

**Run:** `npm run dev` → `http://localhost:5173`

### Implementation principle — reference parity

Prefer **Unity Foundation Client / DCL Explorer** behavior for WASM (PhysX, comms codecs), Three.js rendering optimizations, LOD/asset streaming, and camera patterns. See **Reference parity** in [`IMPLEMENTATION_PLAN.md`](./IMPLEMENTATION_PLAN.md). Document MVP shortcuts (grass scatter, no scene LOD) so they can be closed against Unity source later.


| Route                 | Result                                                 |
| --------------------- | ------------------------------------------------------ |
| `/`                   | **Explorer** — places/worlds grid (no WebGL)           |
| `/communities`        | Communities browse + shell nav                         |
| `/events`             | Events calendar page                                   |
| `/map`                | Genesis map (2D shell)                                   |
| `/profile`            | Full-screen profile (signed-in)                        |
| `/<segment>`          | **Scene landing** (cold) or **3D play** (after Jump in) |
| `/rickroll.dcl.eth`   | RickRoll — landing hub → Jump in for 3D                |
| `/name`               | Normalizes to `name.dcl.eth`                           |
| `/80,-1`              | Parcel coords (stub — throws)                          |
| `?world=name.dcl.eth` | Legacy query fallback                                  |
| `?orbit=1`            | Orbit camera (debug) instead of first-person player    |
| `?colliders=1`        | Wireframe MeshCollider debug overlay                   |
| `?profile=0x…`        | Catalyst profile — wearables, name tag, nameColor               |
| `?body=female`        | Default body shape when no profile                              |


**Try:** `http://localhost:5173/rickroll.dcl.eth?profile=0xC3E3…` — WASD move, jump, AvatarShape NPCs with name tags.

---

## Phase 0 — Landscape viewer ✅ **CLOSED**


| Area                           | Status | Notes                                                              |
| ------------------------------ | ------ | ------------------------------------------------------------------ |
| Vite + TS + Three.js scaffold  | ✅ Done | `package.json`, `vite.config.ts`, `tsconfig.json`                  |
| Scene resolution               | ✅ Done | `resolveSceneFromRoute` — about → entity → content manifest        |
| Path routing                   | ✅ Done | `route.ts` — `/:world.dcl.eth`, `/:x,y` stub, SPA fallback         |
| Render stats HUD               | ✅ Done | `RenderStats.ts` — FPS/MS panel, top-center                        |
| Coordinate system              | ✅ Done | SW corner = `(0,0,0)`; +X east, +Z north; 16 m parcels             |
| ECS → Three.js handedness      | ✅ Done | `dclTransform.ts` — LH DCL → RH Three at render boundary (2026-06-12) |
| Padding ring                   | ✅ Done | `ParcelGrid.landscapeParcelKeys()` — 1×1 → 3×3 grid                |
| Ground tiling                  | ✅ Done | `ground.glb` per parcel; **+8 m offset** (mesh is ±8 centered)     |
| Scene vs padding roles         | ✅ Done | Scene parcel = ground only; padding = scatter props                |
| External glTF textures         | ✅ Done | `DclTextureResolver.ts` — `FanstasyPack_TX.png`, `file1.png`, etc. |
| Asset loading                  | ✅ Done | `AssetCache` — GLTF + DRACO, dedup, texture preload                |
| Collider stripping             | ✅ Done | `LandscapeAssetSanitizer.ts` — hides `/_collider/i` meshes (not deleted) |
| Trees / bushes / rocks / grass | ✅ Done | `ParcelDecorator.ts` — parcel-seeded RNG                           |
| Tree appearance                | ✅ Done | Coral/pink tree01 + tree02 only; colliders hidden; alpha foliage   |
| Tree density                   | ✅ Done | 0–1 tree per padding parcel (~sparse Explorer-like ring)           |
| Compass HUD                    | ⬜ Removed | Replaced by circular minimap (no scene compass overlay)          |
| Basic scene lighting           | ✅ Done | Hemi + directional sun + fog (MVP — not day/night cycles)          |
| Orbit camera                   | ✅ Done | `SceneHost.ts` — spawn focus, shadows, damping                     |
| Unity Explorer structure       | ✅ Done | `src/dcl/landscape/` mirrors `DCL/Landscape/` layout               |
| Build                          | ✅ Done | `npm run build` passes                                             |


### Phase 0 success criteria

- [x] World loads from path `/name.dcl.eth` or legacy `?world=` (entity + content manifest)
- [x] Parcel ground blocks render under scene footprint + padding
- [x] glTF assets load without texture 404s (shared atlas resolver)
- [x] Stable orbit viewer on static landscape (render stats HUD)
- [x] Side-by-side parity check vs Unity Explorer — **layout + NPC positions ✅** (2026-06-12)

---

## Key fixes (2026-06-12 session)

### Parcel alignment

`ground.glb` is authored at **mesh center (±8 m)**, not SW corner. Parcel roots sit at SW; ground now gets `(8, 0, 8)` offset via `SceneSpace.ts` so tiles and props share SDK7 0–16 m bounds.

### Missing textures

Many DCL glTFs reference bare filenames (`FanstasyPack_TX.png`). `LoadingManager.setURLModifier` maps them to Catalyst IPFS hashes from `@dcl/asset-packs/catalog.json`.

### Broken trees

Empty-land tree glTFs include **collider meshes** (`Tree01_LOD01_collider`, `Sphere_collider`) that rendered as dark ovoids. Sanitizer hides `/_collider/i` meshes (kept for physics extraction) and fixes foliage `alphaTest`.

### Too many / wrong-colored trees

Reduced to **0–1 tree per padding parcel**. Scatter pool uses **tree01 (coral) + tree02 (pink)** only — skips teal tree03.

### Routing + world fetch

- `**route.ts`** — `/:segment` parses as parcel coords or ENS world name
- `**resolveSceneFromRoute**` — `GET /world/{name}/about` → entity id → `GET /contents/{id}` → parcels, spawn, content[], main entry
- HUD shows entity id, file counts, and `bin/scene.js` hash
- Vite `appType: 'spa'` for deep links

### Render stats

mrdoob **stats.js** panel top-center — closes out Phase 0 perf/viewer checkmark.

---

## Deferred: lighting & environment cycles ⏸️ **Partial**

| When | What | Status |
| ---- | ---- | ------ |
| **Now** | GenesisSky dome (DCL textures + cloud scroll) | ✅ `DclGenesisSky` |
| **Now** | Purple night sky, moon, stars, moon fill light | ✅ `moonLightIntensity()` + night hemi; user **Moon Light** / **Moon Exposure** sliders (2026-06-18) |
| **Now** | `SkyboxTime` ECS on RootEntity + `scene.json` fixedTime | ✅ mirror + smooth transition |
| **Now** | World `/about` + `display.skybox` custom textures | ✅ cubemap / equirect when provided |
| **Now** | Animated water plane under landscape | ✅ `WaterPlane.ts` — 1024 m+ ocean, no square horizon clip |
| **Now** | Skybox default midday (12:00) on load | ✅ `MIDDAY_SECONDS = 43200` |
| **Now** | DCL cubemap clouds (near/far/horizon/top) | ✅ white midday puffs — HDR tint + screen blend (2026-06-18) |
| **Now** | FPV camera zoom (scroll to first person) | ✅ 1.82 m eye height, inverted pitch, hide body + tag |
| **Now** | Sun directional brightness | ✅ `SUN_BRIGHTNESS = 1.55` + user **Scene Sun Light** slider |
| **Now** | Sun shadow sweep disabled | ✅ no moving diagonal ground shadow from sun cycle |
| **Now** | `LightSource` ECS + `LightManager` culling | ✅ intensity/range/spot + 40 m cull + quality tiers — **FPS win in Genesis Plaza** |
| **Now** | PhysX player grounding + capsule debug | ✅ feet on y=0; bone-based pivot; debug panel toggles |
| **Now** | Sun / ECS hybrid + ACES exposure | ✅ hybrid dim + tier exposure; user day/night exposure sliders |
| **Now** | Scene GLTF neon / LED emissives | 🟡 DCL color×intensity split — warm LEDs at night; not full Explorer parity |
| **Now** | Preferences → Graphics + Controls + chat people | 🟢 P0–P2 quality + mouse sens + chat roster on `dev-latest`; **P3 distances + P4 bloom not started** |
| **Pre-live** | Emote GLB props | ✅ `SkeletonUtils.clone` + scene-emote URNs (2026-06-13) |
| Full Explorer ShaderGraph parity (bloom, dual sun logo) | ⬜ polish |
| Per-layer cloud tint gradients (Explorer Far/Near) | ⬜ single global `uCloudsColor` today |
| **Phase 6** | Post-processing, probe env maps | ⬜ deferred |

Default sky time: **midday (12:00)** on load. Day/night cycle still available when `SkyboxTime` is not fixed — **60 DCL-seconds per real second** (24-minute full cycle).

---

## Phase 3a — Environment & skybox ✅ **CLOSED**

| Task | Status |
|------|--------|
| Procedural skydome (DCL GenesisSky shader port) | ✅ |
| Sun + moon directional lights + hemisphere ambient | ✅ ramps from `SkyboxRenderController` |
| Sun/moon paths from `SunCycle24h.anim` quaternions | ✅ `sunCycle24h.ts` + slerp sampler |
| Fog + background color synced to sky | ✅ |
| DCL day/night cycle (24 min) | ✅ when no `SkyboxTime` on RootEntity |
| `SkyboxTime` mirror + smooth transition | ✅ forward/backward `TransitionMode` |
| `scene.json` `skyboxConfig.fixedTime` | ✅ parsed from entity metadata |
| World `/about` `configurations.skybox.textures` | ✅ optional cubemap / panorama |
| `display.skybox` / `skyboxTexture` in scene metadata | ✅ resolved via content manifest |

---

## Client chrome (Explorer sidebar) ✅ **CLOSED**

| Task | Status |
|------|--------|
| Left vertical panel 2% width | ✅ `#client-shell` |
| Skybox NIGHT/DAY popup (auto + custom slider 0–23:59) | ✅ anchors to skybox button |
| Top stack: profile, notifications, credits, events, map, … | ✅ profile face from Catalyst |
| Circular minimap (top-left, 224×224) | ✅ scene parcels only + player dot |
| **World location card** (replaces minimap in worlds) | ✅ `WorldLocationCard.ts` — name, live coords, **Jump back to Genesis City** → `0,0` |
| Debug panel (right-anchored, hidden by default) | ✅ toggled from Help icon; live scene-local + world position HUD |
| Settings overlay (tabbed) | ✅ Events, Places, Communities, Map, Backpack, Gallery |
| **Preferences panel (P / ⚙)** | ✅ Graphics quality + lighting live · **Sounds partial** · Controls/Chat stubs |
| **Dev progress panel** | ✅ `</>` sidebar — TASKS.yaml + PROGRESS.md from GitHub + integration registry |
| **Map tab** — Genesis City stitched tiles | ✅ click mini-map / **M** — parcel popup + Jump In + peer sidebar (dcl-neurolink parity) |
| **Events tab** — calendar + weekly views | ✅ DCL Events API · Weekly (4 day columns) / Calendar toggle · Today + Create Event stub |
| Chat sidebar unread badge | ✅ count when panel closed; clears on open |
| Emote wheel (B key) | ✅ SVG radial menu — `EmoteWheelPanel.ts` |
| Backpack view | ✅ avatar preview, equipped thumbnails, inventory grid, item detail |
| Scene compass overlay | ⬜ removed — minimap replaces it |

---

## Source layout (current)

```
src/
├── main.ts
├── client/
│   ├── bootstrap.ts
│   └── ui/
│       ├── Minimap.ts
│       ├── WorldLocationCard.ts
│       ├── DebugPanel.ts
│       ├── EmoteWheelPanel.ts
│       ├── NameTag.ts
│       ├── NameTagRenderer.ts
│       ├── RenderStats.ts
│       └── shell/          ClientShell, SidebarButton, SkyboxPanel, SettingsOverlay, BackpackView
├── core/
│   ├── World.ts
│   └── systems/
│       ├── LandscapeSystem.ts
│       └── SceneScriptSystem.ts
├── dcl/
│   ├── content/          route, resolveScene, parseParcel, types
│   ├── ecs/registry.ts   component → phase map
│   └── landscape/        …
├── physics/              loadPhysX, PhysXWorld, Layers, vendor/
├── player/
│   ├── PlayerSystem.ts   capsule, camera, velocity rotation
│   ├── PlayerInput.ts
│   └── locomotion.ts     walk/jog/run, mirror settings
├── avatar/
│   ├── AvatarComposer.ts, LocalAvatar.ts, SceneAvatar.ts
│   ├── AvatarAnimations.ts, avatarShapeProfile.ts
│   ├── headAnchor.ts, displayName.ts
│   ├── peerApi.ts, slots.ts, bodyShape.ts, face.ts, materials.ts
│   └── constants.ts, types.ts
├── environment/
│   ├── EnvironmentSystem.ts, DclGenesisSky.ts, WaterPlane.ts
│   ├── sunCycle24h.ts, sunCycleSampler.ts, skyboxTime.ts
├── bridge/
│   ├── CrdtMirror.ts, ThreeBridge.ts, AvatarShapeBridge.ts
│   ├── dclTransform.ts, ReservedEntitiesSync.ts, mirrorComponents.ts
│   └── material/, primitiveShapes.ts
├── input/                PointerEventsSystem, PointerHoverFeedback, PointerHighlightFeedback, pointerConstants, inputActionBinding
├── shim/                 sceneWorker, system stubs, types
└── rendering/            SceneHost, AssetCache, DclTextureResolver, …
```

---

## Decoration profile (padding parcels)


| Prop   | Count per padding parcel |
| ------ | ------------------------ |
| Trees  | 0–1 (tree01 + tree02)    |
| Bushes | 3–6                      |
| Rocks  | 0–2                      |
| Grass  | 8–14                     |


Scene footprint parcels: **ground only** (no scatter).

---

## Phase 2a — PhysX player + DCL camera ✅ **CLOSED**


| Task                                           | Status                                                |
| ---------------------------------------------- | ----------------------------------------------------- |
| PhysX WASM loader (Hyperfy port)               | ✅ lazy dynamic import — not at page startup           |
| `PhysXWorld` — static colliders + capsule      | ✅ scene `MeshCollider` + GLTF `_collider` trimesh  |
| GLTF collider → PhysX trimesh                  | ✅ per-instance cook (no shared-cache bug); degenerate meshes skipped |
| PhysX WASM memory API                          | ✅ `_webidl_malloc` / `_webidl_free`                   |
| `PlayerSystem` — WASD, DCL walk/jog/run/jump | ✅ Ctrl walk · Shift run · Space / double jump |
| DCL-style third-person camera                  | ✅ lock/unlock, 360° orbit, pitch 0→top-down, scroll zoom |
| FPV (scroll to min distance)                   | ✅ eye height 1.82 m, inverted look Y, body hidden         |
| Landscape ground physics                       | ✅ thin box per parcel so player does not fall through |
| Player feet snap / ground sweep                | ✅ Hyperfy 0.22 m sweep + `stickFeetToGround` — local player no longer floats |
| PhysX collider debug (Help panel)              | ✅ flat toggles — MeshCollider / GLTF / local capsule wireframes |
| Padding parcel outer wall colliders            | ✅ 500 m tall thin boxes on outside edges of empty padding parcels |
| Scene `MeshCollider` → PhysX sync              | ✅ `CollisionSystem.getPhysicsColliders()`             |


**Controls (DCL desktop):** WASD move · **Ctrl** walk · **Shift** run · default jog · **Space** jump · **Space** in air double jump · click lock · Tab/right-click/Esc unlock · scroll zoom

---

## Phase 2c — Reserved ECS entities ✅ **CLOSED**


| Task | Status |
|------|--------|
| `RootEntity` (0) transform at scene origin | ✅ mirror seed + CRDT getState |
| `PlayerEntity` (1) client-owned transform | ✅ `ReservedEntitiesSync` ← PhysX capsule |
| `PlayerEntity` identity for `getPlayer()` | ✅ `PlayerIdentityData` + `AvatarBase` + `AvatarEquippedData` on mirror CRDT |
| `CameraEntity` (2) client-owned transform | ✅ synced from active Three.js camera |
| `MainCamera` on CameraEntity | ✅ registered in mirror |
| CRDT round-trip on scene sync | ✅ player/camera pushed before each `crdt-send` response |
| `movePlayerTo` / parcel clamp | ✅ Phase 2b — worker RPC + bounds clamp |

SDK7 reserved IDs: `RootEntity=0`, `PlayerEntity=1`, `CameraEntity=2`. Scene entities still parent to `RootEntity`; ThreeBridge skips rendering the reserved trio.

---

## Phase 1 — ECS shim + scene.js ✅ **CLOSED**


| Task                                                        | Status                                                         |
| ----------------------------------------------------------- | -------------------------------------------------------------- |
| ECS component registry + docs                               | ✅ `[INTEGRATION.md](./INTEGRATION.md)`, `registry.ts`    |
| `CrdtMirror` (@dcl/ecs renderer transport)                  | ✅ stable @ 120fps on RickRoll                                 |
| `sceneWorker` + ~system stubs                               | ✅ `onStart` + `onUpdate` loop; see **no-ops** below            |
| `ThreeBridge` — Transform hierarchy + parent order          | ✅ `dclTransform.ts` — depth-sorted parents + LH→RH conversion   |
| `ThreeBridge` — MeshRenderer primitives                     | ✅ box/sphere/cylinder/plane — **plane vertical + double-sided**; **box/plane custom `uvs`** |
| `ThreeBridge` — Material (PBR/unlit, textures, alpha)     | ✅ `MaterialApplier.ts` + scene GLTF blend preserved (`e16fe81`) |
| `ThreeBridge` — GltfContainer, Visibility                   | ✅ reload on src change — all GLTF scenes (Plaza, RickRoll, parcels) |
| Phase 1b — `LightSource`, `TextShape`                       | ✅ `LightSourceSync.ts` + `LightManager` culling + quality tiers |
| Phase 1b — `Billboard`, `Animator`                          | ✅ `BillboardBridge.ts`, `AnimatorBridge.ts` in `SceneScriptSystem` |
| `SceneScriptSystem` wired in `World`                        | ✅                                                              |
| RickRoll `/rickroll.dcl.eth` validation                     | ✅ scene script + CRDT + meshes confirmed                       |


**Architecture:** Scene bundle runs in worker → CRDT RPC → main-thread mirror engine → ThreeBridge.

### Phase 1 fidelity fixes (2026-06-12 evening)

| Fix | Status | Notes |
|-----|--------|-------|
| Transform parent-before-local apply | ✅ | `sortEntitiesByTransformDepth` + `applyDclLocalTransform` |
| Plane orientation | ✅ | Removed erroneous `rotateX(-π/2)` — matches DCL `CreatePlane` (vertical XY) |
| Plane double-sided rendering | ✅ | `THREE.DoubleSide` — matches DCL `sideOrientation: 2` |
| AvatarShape NPC facing | ✅ | Removed fixed `AVATAR_YAW_OFFSET` on `SceneAvatar` — ECS Transform drives facing |
| Local player yaw offset | ✅ | `LocalAvatar` still uses `AVATAR_YAW_OFFSET` for locomotion |

### Phase 1 fidelity fixes (2026-06-12 late night) — **Explorer parity**

| Fix | Status | Notes |
|-----|--------|-------|
| Full-scene X mirror vs Explorer | ✅ | DCL LH → Three RH: negate X on position; quat `(-x,y,z,-w)` |
| Player / landscape / remote avatars | ✅ | Same conversion at every visual boundary |
| CRDT + comms stay in DCL space | ✅ | `threeToDcl*` on mirror write + movement broadcast |

---

## Phase 2b — Player APIs ✅ **CLOSED**

| Task | Status |
|------|--------|
| Scene spawn from `scene.json` metadata | ✅ `pickSpawn()` → `PlayerSystem.init()` |
| Spawn `cameraTarget` → initial look yaw/pitch | ✅ `applyLookTarget()` |
| Parcel boundary clamp (soft wall) | ✅ `SceneBounds` + post-physics teleport |
| `RestrictedActions.movePlayerTo` | ✅ worker ↔ main RPC; instant + interpolated |
| Player spawns before scene script | ✅ `prepare()` then player, then worker boot |

---

## Phase 5 — Social comms 🟡 **IN PROGRESS**

| Task | Status |
|------|--------|
| **Companion 2D shell (Phases 1–2.5)** | ✅ Explorer `/`, scene landing, shell nav, communities/events/map/profile pages — `decentraland-social-merge` → `dev-latest` (`c53af86`) |
| **2D social chat dock (multi-room)** | ✅ `SocialChatDock` + `SceneChatRoomPool` — many LiveKit rooms stay joined; channel notifications; close background tabs; in-world `ChatPanel` unchanged |
| **Scene landing Jump in UX** | ✅ Progress bar + `ClientShell` defer/hide; comms handoff on world load |
| **2D sign-out** | ✅ `signOutFrom2dShell` — disconnect comms, dispose dock, reset social |
| **Community thumbnails** | ✅ `communityDisplayImageUrl` + proxy + 404 detail enrichment |
| **Scene display title parity** | ✅ Deployed `display.title` before Places API — landing + chat agree |
| Splash login screen | ❌ Removed — explorer auth sheet + session resume (companion UX) |
| `@dcl/crypto` AuthIdentity + localStorage | ✅ `AuthClient` + `identityStore` |
| Stable browser guest wallet | ✅ `guestIdentity` + Catalyst profile for chat/cast |
| `SessionIdentity` — Catalyst profile connect | ✅ post-login profile fetch |
| `CommsService` + RFC4 room client | ✅ `setCommunicationsAdapter` worker bridge |
| Bevy-shaped comms plugin + Scene routing | ✅ archipelago path scaffold |
| Movement wire codec (Bevy/Unity alignment) | ✅ genesis/world DCL coords outbound; inbound → scene-local |
| `RemoteAvatarManager` transform sync | ✅ blank placeholder → profile + lerp (display coords converted) |
| `CommunicationsController` / `UserIdentity` stubs | ✅ worker ↔ main RPC |
| **Peer visibility — two clients same scene** | ✅ confirmed working |
| Scene chat UI + RFC4 encode/decode | ✅ ChatPanel + LiveKit reliable chat publish |
| Chat UX (140 char, links, @mentions, `/goto` styling) | ✅ `chatMentions.ts`, `linkifyText.ts`, `chatNavigationLinks.ts` — nav links teleport in-client |
| **Scene chat outbound (LiveKit)** | ✅ dcl-companion wire + multi-room pool for 2D; 3D fan-out scene/world |
| **Scene chat timestamps in Unity Explorer** | ✅ OLE Automation outbound + unix encode; inbound accepts legacy |
| Scene-mode rail transparency | ✅ rail hidden in scene mode until hover/pin |
| Member communities rail (Signed Social API) | ✅ `fetchMemberCommunitiesSigned` |
| Session identity expiry in localStorage | ✅ `identityStore` + resume / re-auth via explorer sheet |
| Avatar spawn after social/comms load | ✅ `initCapsule` → comms → social → `loadAvatar` |
| **Watch Lite on landing (Phase 3)** | ✅ Gatekeeper + LiveKit chat/cast without WebGL; guest cast; multi-room keep-alive |
| Profile on join + remote avatar parity | ⬜ |
| Community text (PM router) | ⬜ stub — local echo only |
| Voice / presence (LiveKit / realm adapter) | ⬜ |
| Direct messages channel | ⬜ placeholder in rail |
| **I'm live CTA / HLS listings** | ⬜ deferred |
| **`/goto` in 3D play mode (Phase 4)** | ⬜ teleport in-place; no SPA route change |

---

## Phase 4a — DCL avatar compose ✅ **CLOSED**


| Task | Status |
|------|--------|
| Catalyst profile + wearable fetch | ✅ `peerApi.ts` — peer-ec2, collections-v2 URN strip |
| ADR-239 slot resolution | ✅ `slots.ts` |
| Body shape + wearables GLB load | ✅ skeleton rebind + merge fallback |
| Attach to player capsule | ✅ `LocalAvatar` on `PlayerSystem` root |
| Profile wallet persistence | ✅ `?profile=0x…` + `localStorage` address |
| Full avatar cache (URN fingerprint) | ✅ `profileStorage.ts` — wearables + profile blob |

---

## Phase 4b — Avatar polish ✅ **CLOSED**


| Task | Status |
|------|--------|
| Base mesh hiding (Forge `body.ts`) | ✅ category + hides/replaces + hands |
| Wearable emissives (visor, neon trim) | ✅ Forge 4× factor + intensity 12 — tune in `constants.ts` |
| Idle + walk emote animations | ✅ DCL `idle.glb` / `walk.glb` on Avatar_ rig |
| Facial features (eyes/eyebrows/mouth) | ✅ `face.ts` — texture + mask emissive |
| Smooth third-person rotation | ✅ velocity-facing + exp lerp (no camera-lock skating) |
| `AvatarShape` ECS mirror + scene compose | ✅ `AvatarShapeBridge` — NPC entities; local player stays profile URL |
| Avatar name tags | ✅ CSS2D pill labels — head-tracked, profile name + nameColor |
| Emissive 1:1 parity (Explorer bloom) | ⬜ deferred — needs post-process bloom pass |

---

## Phase 4c — Locomotion emotes ✅ **CLOSED**


| Task | Status |
|------|--------|
| Run emote (Shift sprint) | ✅ DCL `run.glb` at run speed |
| Jump + double jump emotes | ✅ First jump `jump.glb` loop · second jump shared clockwise Y twirl (DCL/VRM/ODK) + spin puff; optional `double_jump.glb` |
| Locomotion VFX puffs | ✅ `AvatarLocomotionVfx` — foot dust (walk/jog/run cadence) + air-jump burst |
| Air-jump delay | ✅ 0.2s hold before second impulse (Explorer `AirJumpDelay`) |
| DCL speed defaults | ✅ walk 1.5 · jog 8 · run 10 m/s — `AvatarLocomotionSettings` from scene |
| Velocity-based avatar rotation | ✅ smooth facing; no strafe skating |
| Glider | ⬜ skipped |
| Fall pose | ✅ idle while airborne (no Avatar_ fall clip in catalog) |
| Directional walk/jog GLBs | ⬜ deferred — Mixamo rig; rotate-to-move instead |
| Profile emote playback | ✅ wheel + `triggerEmote` — bundled defaults + Catalyst fallback; remote RFC4 `PlayerEmote` |

---

## Shipped this session (2026-06-13 — late evening)

**Assets / rendering**
- **Session GLB cache** — `getSessionAssetCache()` singleton per tab; survives parcel/world teleports; `disposeSessionAssetCache()` on sign-out only — `AssetCache.ts`, `World.ts`
- **SkinnedMesh scene GLTF clone** — `SkeletonUtils.clone()` in `cloneGltfInstance()` — fixes frustum-cull crashes + broken skinned instances (RickRoll dancers, emote props) — `skinnedMeshInstance.ts`

**Environment / worlds / chat / login**
- **Moon fill at night** — moon directional decoupled from sun anim curve; boosted `MOON_BRIGHTNESS`, night hemi + ground bounce, dynamic exposure; midnight quaternion wrap fix — avatars readable at 23:59
- **World location card** — in worlds hide minimap; show world name, live floor coords, **Jump back to Genesis City** (teleport `0,0`); card width −10%
- **Chat UX** — 140 char cap; blue URL links; `/goto` input styling; @-mention autocomplete (scene peers from gatekeeper + LiveKit)
- **Chat nav links** — parcel coords (`80,-1`), `.dcl.eth` names, Decentraland play URLs → in-client teleport (not new tab) — `chatNavigationLinks.ts`, `linkifyText.ts`
- **Chat @mention highlight** — purple `is-mentioned` on **bubble only** (not whole row) when message @-mentions local user — `chatMentionDetection.ts`, `ChatPanel.ts`
- **Login** — removed **Sign in with Decentraland** (auth-server popup); wallet connect remains primary path
- **Dev progress panel** — `</>` → community claims + Progress log **live from GitHub** (`dev-latest` docs). Client version chip is **`package.json` only**. Offline (`?docsGithubFetch=0`) shows a placeholder notice, not a progress snapshot.

**ECS bridges**
- **`TweenBridge`** — wired in `SceneScriptSystem` + `mirrorComponents` (`Tween`, `TweenState`); move/rotate/scale/moveRotateScale + continuous modes; 31 easing curves; writes `TweenState` for worker `tweenCompleted()` — see **Tween status** below

**PointerEvents (2026-06-14)**
- **Hover tooltips** — scene `hoverText` + DCL button icons (E, F, mouse, 1–4, Spc, Ctrl) — `PointerHoverFeedback.ts`, `inputActionBinding.ts`
- **Mesh highlight** — green/red outline from `showHighlight` + per-entry distance — `PointerHighlightFeedback.ts`
- **Input actions** — `IA_POINTER` left click · `IA_PRIMARY` E only · `IA_SECONDARY` F · `IA_ACTION_3`–`IA_ACTION_6` (1–4) · `IA_JUMP` Space · `IA_WALK` Ctrl — `PointerEventsSystem.ts`
- **Distance** — camera `maxDistance` first, then player fallback (same entry’s fields only)
- **Scene logs** — worker `console.*` → client debug log — `sceneWorker.ts`, `SceneScriptSystem.ts`

**Next:** voice / LiveKit audio · `UiTransform` · `TriggerArea` · parcel routes

---

## Tween status — ✅ **WORKING** (2026-06-14)

**Do we have tweens?** **YES** — transform + texture UV interpolation + **`TweenSequence` loop** validated on Genesis Plaza blimp orbit.

| Layer | File | Status |
| ----- | ---- | ------ |
| Renderer bridge | `src/bridge/TweenBridge.ts` | ✅ move, rotate, scale, moveRotateScale, moveContinuous, rotateContinuous, **textureMove**, **textureMoveContinuous** |
| Wiring | `SceneScriptSystem.ts` — `pumpMotionBridges()` on sync frame + hydration ticks | ✅ (fixes async-busy skip that froze tweens in heavy scenes) |
| Mirror CRDT | `mirrorComponents.ts` — `Tween` (1102), `TweenState` (1103), **`TweenSequence` (1104)** | ✅ |
| Registry | `dcl/ecs/registry.ts` | ✅ Tween render · TweenState client-only · **TweenSequence render** |
| Scene worker | `@dcl/ecs` `createTweenSystem()` — `tweenCompleted()`, sequence/yoyo | ✅ runs in worker; depends on `TweenState` round-trip |

**Implemented vs Unity / DCL Explorer**

| Feature | Client | Notes |
| ------- | ------ | ----- |
| Move / rotate / scale tweens | ✅ | Lerp + slerp on `Transform`; `faceDirection` on move |
| `moveRotateScale` combined | ✅ | Single eased progress |
| Continuous move / rotate | ✅ | Speed × delta while `playing` |
| **`textureMove` / `textureMoveContinuous`** | ✅ | UV offset/tiling on `map` / `emissiveMap` / `alphaMap` — **GLTF + MeshRenderer** |
| Easing (31 `EasingFunction` values) | ✅ | `@tweenjs/tween.js` mapping |
| Pause (`playing: false`) | ✅ | `TweenState.state = 2` |
| `TweenState` + `currentTime` write-back | ✅ | Mirror → worker CRDT for `tweenCompleted()` |
| **`TweenSequence` loop (RESTART / YOYO)** | ✅ | Genesis Plaza blimp — 90s rotate orbit via scene script |
| Progress reset on target change | ✅ | Signature includes mode payload; `justReset` on change |
| Material UV animation parity | ✅ | MeshRenderer custom shape UVs + Material offset/tiling; tweens no longer reset each frame |

**QA reference:** Genesis `0,0` blimp (`blimp.glb`) — rotate `Tween` + `TweenSequence` on pivot entity (`hO = 90000` ms full orbit). Loading screen shows **hydration elapsed timer** (count-up from 0:00; timeout at 3:00 default, 1:30 on teleport; orange at timeout; green on ready).

---

## Shipped this session (2026-06-14)

**Scene hydration / loading**
- **Count-up elapsed timer** — loading screen ticks from 0:00 (replaces countdown); final time shown on ready or timeout fallback
- **Attach stall + hard timeout** — 20s stall detector + 180s backstop; `gltfAbandoned` excluded from gate; skip 5s post-load hold on timeout
- **Attach throughput** — hydration multi-pass burst, priority queue, budget only on successful attach; failed GLBs not cached as empty placeholders

**Remote avatars**
- **Wearable texture resolver** — merge all wearable mappings at compose time; `.png` ↔ `.png.png` aliasing; Catalyst leaf-name lookup — fixes `Avatar_*SkinBase` / `Image_0.png` 404 spam

**Files:** `sceneHydration.ts`, `LoadingScreen.ts`, `ThreeBridge.ts`, `AssetCache.ts`, `DclTextureResolver.ts`, `AvatarComposer.ts`, `loadWearable.ts`, `peerApi.ts`

---

## Shipped this session (2026-06-13 — afternoon / evening)

**PhysX + lighting**
- Local player grounding: spawn Y=0, 0.22 m ground sweep, feet snap — matches NPCs/remotes on y=0 floor
- Bone-based avatar pivot (`feetAlign.ts`) — capsule debug pill aligns with body
- PhysX debug panel: flat MeshCollider / GLTF / capsule toggles (removed broken master gate)
- `LightSource` quick wins + `LightManager` (40 m cull, tier 4/6/10, shadow cap flags)
- Intensity `/4000` restored after overexposure regression — **Genesis Plaza FPS hugely improved**

**Map + events + chat UI**
- Full Genesis map in settings (tiles from genesis.city, peer markers, parcel popup, Jump In)
- Events tab: DCL Events API, Weekly/Calendar views, highlight panel, 4 scrollable day columns
- Chat sidebar unread badge when panel closed
- Orbit: left-drag orbits without toggling pointer lock; right-click / Esc toggle capture
- AvatarShape emotes: trigger detection fix + loop until `expressionTriggerId` cleared

**Docs**
- [INTEGRATION.md](./INTEGRATION.md) — implemented vs outstanding Explorer gaps

---

## Shipped this session (2026-06-13 — morning)

**Profile emotes (Phase 4d — expanded)**
- **Bundled defaults:** 15 profile emotes + idle/walk/run/jump in `public/avatar/emotes/` (Forge + Catalyst fetch); `profileEmotes.ts` prefers local paths, Catalyst `base-emotes` fallback
- **Profile-owned emotes:** Lambda `avatar.emotes[]` slots 0–9 parsed in `peerApi.ts`; wheel shows equipped URNs via `buildEmoteWheelSlots(profile)`
- **Local playback:** wheel / `triggerEmote` → `World.playLocalEmote` → resolve + `AssetCache` → `AvatarAnimations.playProfileEmote`; WASD/jump cancels emote
- **Remote sync:** outbound RFC4 `PlayerEmote` (`encodeRfc4PlayerEmotePacket`) on scene/world/island LiveKit rooms; inbound `Rfc4Router` → `RemoteAvatarManager.playPeerEmote` — **no separate subscribe API** (Unity parity)
- Emote wheel wedge styling — gray segments (was dark purple)

**Profile emotes (Phase 4d — initial)**
- Emote wheel (B / sidebar) → `World.playLocalEmote` → `LocalAvatar.playEmote`
- `AvatarAnimations.playProfileEmote` — one-shot override, returns to idle/walk on `finished`
- `RestrictedActions.triggerEmote` stub wired (worker RPC → same playback path; respects Catalyst `loop` flag)

**Deferred: third-person camera jitter**
- **Root cause (user-confirmed):** orbital / third-person camera lerp near **alpha-tested tree foliage** — not sync-frame physics or LOD
- **FPV has hardly any stutter** — fix deferred; tune camera smoothing vs alpha foliage draw order / depth prepass later

**Collision / physics**
- GLTF collider extraction: hide `/_collider/i` meshes in sanitizer (not delete) — geometry kept for PhysX
- Ported Hyperfy `geometryToPxMesh` — `PHYSX.CreateTriangleMesh` with local geometry + shape transforms
- GLTF colliders as simulation + query shapes on static rigidbodies
- Fixed PhysX WASM memory API (`_webidl_malloc` / `_webidl_free`)
- Reverted broken stream-based trimesh cooking; AABB fallback was interim

**Multiplayer / position sync**
- `MovementCompressed` decode: expanded realm bounds + base parcel origin offset for scene-local coords
- Outbound movement: send genesis/world DCL coords on Movement wire (matching Bevy/Unity)
- Inbound Movement converts genesis → scene-local — remote players align with DCL official client
- Local player visible when moving in DCL

**UI**
- Emote wheel (B key, SVG radial menu — `EmoteWheelPanel.ts`)
- Settings overlay with tabs (Events, Places, Communities, Map, Backpack, Gallery, Settings)
- Backpack view: avatar preview, category equipped thumbnails, inventory grid, item detail
- Debug panel: live scene-local + world position HUD above network log

**Performance**
- Lazy-load PhysX WASM via dynamic import (not at page startup)
- `forceContextLoss` on renderer dispose

---

## Shipped this session (2026-06-12)

**Morning / core**
- Reserved entities CRDT sync (Root / Player / Camera + MainCamera)
- DCL locomotion: Ctrl walk, Shift run, double jump, air steering
- AvatarShape ECS → composed NPC avatars in scene
- Name tags: head-tracked CSS2D pills, Catalyst `name` + `nameColor`, verified badge
- Player rotation: velocity-facing with exp lerp

**Evening / fidelity + polish**
- Transform port: parent hierarchy depth sort + direct quaternion mapping
- Plane primitives: vertical orientation + double-sided materials (DJ screen parity ✅)
- AvatarShape NPC facing: ECS Transform drives rotation (no spurious 180° offset)
- 500 m outer wall colliders on padding parcel edges
- Water shader plane + ocean-toned fog (no cyan void)
- Skybox defaults to midday; sun ground shadow sweep removed
- Minimap (top-left), debug panel (Help toggle, right side), compass removed

**Late evening / Explorer parity pass**
- DCL cubemap clouds: near, far, horizon, top layers from unity-explorer assets
- FPV zoom: scroll to first person, eye-height camera, local avatar hidden
- Name tags: head offset tuned (2.14 m above bone)
- Water plane expanded to 1024 m+ (no visible square edge at horizon)
- Minimap shows **scene parcels only** (no padding ring)

**Night / camera + tuning**
- FPV eye height raised to 1.82 m; pitch inverted in first person
- Sun +20% brighter (`SUN_BRIGHTNESS`)
- ECS_COMPONENTS.md + `registry.ts` synced to actual implementation status

**Late night / Explorer parity + comms prep**
- **Fixed full-scene X mirror** — `dclTransform.ts` LH→RH at render boundary; confirmed vs Unity Explorer on RickRoll
- Player, landscape, water, PhysX ground, remote avatars, CRDT mirror boundaries updated
- RFC4 movement codec aligned to Bevy inbound / Unity outbound (position, velocity Z, yaw degrees)
- Comms plugin refactor (Bevy-shaped architecture, Scene packet routing, LiveKit session scaffold)

---

## Phase 3b — PointerEvents ✅ **CLOSED** (2026-06-14)

Unity Explorer splits this into **four pieces** — we combine the raycast + result writer into one class (no separate ECS system module needed on the renderer):

| Unity (legacy renderer) | ThreejsClient |
| --- | --- |
| `PointerEventsHandler` — PB → internal component | Scene worker `@dcl/ecs` `pointerEventsSystem` writes `PointerEvents` CRDT |
| `OnPointerEventColliders` — mesh colliders on pointer layer | `PointerEventsSystem.collectPointerTargets()` — glTF `_collider`, `MeshCollider`, **MeshRenderer** primitives |
| `PointerEventsController` — physics ray → `lastPointerRayHit` | `THREE.Raycaster` from camera + mouse NDC (center when pointer-locked) |
| `ECSPointerInputSystem` — hover/down/up → `PointerEventsResult` | Same class writes grow-only `PointerEventsResult` + `PrimaryPointerInfo` on mirror → CRDT round-trip |
| `IECSInteractionHoverCanvas` — button icon + hover text | `PointerHoverFeedback.ts` + `inputActionBinding.ts` |

| Task | Status |
| --- | --- |
| Mirror register `PointerEvents`, `PointerEventsResult`, `PrimaryPointerInfo` | ✅ `mirrorComponents.ts` |
| Camera raycast + priority + distance (per-entry `maxDistance` / `maxPlayerDistance`) | ✅ `PointerEventsSystem.ts` |
| Hover enter/leave + pointer down/up (CRDT on `crdt-send`) | ✅ |
| Hover tooltips (`showFeedback` + `hoverText` + button icons) | ✅ `PointerHoverFeedback.ts` |
| Mesh highlight (`showHighlight` green/red in/out of range) | ✅ `PointerHighlightFeedback.ts` |
| Input actions — click, E, F, 1–4, Space, Ctrl | ✅ `inputActionBinding.ts` |
| Scene worker `console.log` → client debug | ✅ `sceneWorker.ts` |
| Frame loop wiring | ✅ `World.ts` + `SceneScriptSystem.ts` |
| CRDT back to scene worker | ✅ via existing `crdt-send` round-trip |
| Manual QA (custom scenes + Genesis interactives) | ✅ 2026-06-14 |

**Not yet:** proximity events (`PET_PROXIMITY_*`), UI entity pointers.

---

## Phase 3c — EngineApi event queue ✅ **CLOSED** (2026-06-14)

SDK7 scenes call `EngineApi.subscribe("comms")` then drain via `sendBatch` inside `pollEvents()` each frame. That is the **only** sendBatch path `@dcl/sdk` uses today.

| Task | Status |
| --- | --- |
| Worker `subscribe` / `unsubscribe` + subscription set | ✅ `EngineApiEventState.ts` |
| Worker `sendBatch` → `drainEvents()` | ✅ `createSystemStubs.ts` |
| Main-thread bridge (subscription sync + enqueue) | ✅ `EngineApiEventBridge.ts` + `SceneScriptSystem.ts` |
| Inbound LiveKit topic `comms` → queue | ✅ `World.ts` → `pushCommsMessage` |
| Outbound `CommunicationsController.send` | ✅ worker RPC → `publishTopicData('comms', …)` |
| **Tags** mirror CRDT | ✅ `mirrorComponents.ts` + full `getState` dump |

**Pending (out of SDK7 sendBatch scope):**

| Item | Status | Notes |
| ---- | ------ | ----- |
| **`videoEvent`** observable / sendBatch | 🟢 **VideoEvent outbound** | Grow-only append to worker; SDK `videoEventsSystem` callbacks — **`getActiveVideoStreams`** still pending |
| Legacy typed events (`position_changed`, etc.) | ⬜ not planned | SDK7 uses ECS transforms, not sendBatch |
| Other LiveKit topics via sendBatch | ⬜ not planned | Use **`CommsApi.subscribeToTopic` + `consumeMessages`** |

**Tags ✅:** `Tags` registered on CRDT mirror; `getEntitiesByTag()` works in scene worker.

---

## Phase 3 — Backlog (remaining)

| Phase | Focus | Status |
| ----- | ----- | ------ |
| **3** | UI (`UiTransform`…), Raycast, TriggerArea, video/audio | ⬜ next |
| **3a** | Skybox + SkyboxTime + environment | ✅ closed |
| **3b** | `PointerEvents` + camera raycast | ✅ closed |
| **3c** | `EngineApi` sendBatch + comms observables | ✅ closed |
| **4d** | Profile emotes + ECS bridges | ✅ emotes + VFX · **`AvatarEmoteCommand` ✅** · **`Tween` ✅** (transform + textureMove + TweenSequence) |
| **4e** | Remote players — sync transforms + avatars | 🟡 display layer ready |
| **5** | Social comms (multiplayer + voice/presence) | 🟡 active |
| **6** | Parcel streaming, LOD, instancing, env cycles | ⬜ |

---

## What's next (recommended order)

**Pre-live blockers — cleared ✅ (2026-06-13).** Optional polish before / after push:

| Priority | Task | Why |
| -------- | ---- | --- |
| 1 | **3** | **`Raycast` + `TriggerArea`** | Scene ray APIs + volume enter/exit — unlocks many interactives |
| 2 | **3b** | **`PET_PROXIMITY_*`** pointer events | Walk-up interactives (no cursor) |
| 3 | **3** | ~~**`VideoPlayer` + `videoEvent`**~~ ✅ | RickRoll screen parity — remaining: **`getActiveVideoStreams`** comms stub |
| 3b | **3** | ~~**`AudioSource` + `AudioStream`**~~ ⬜ | Code shipped — **user test pending**; wire voice/UI/emote volume prefs |
| 4 | **5** | Voice / presence (LiveKit audio) | Social layer — hook **Voice Chat & Streams** slider + mic picker |
| 5 | **3** | `UiTransform` MVP | In-world UI |
| 6 | infra | Parcel routing `/80,-1` → Catalyst | Genesis City parcel scenes |

---

## ~system stubs — intentional no-ops (revisit)

Tracked in `src/shim/system/createSystemStubs.ts`. These are **deliberately stubbed** so scenes can boot; replace when the matching client feature exists.

| Stub | Module | Current behavior | Why it matters / when to implement |
| ---- | ------ | ---------------- | ----------------------------------- |
| **`sendBatch`** | `~system/EngineApi` | ✅ **drains queued events** | Worker `EngineApiEventState.drainEvents()`; main enqueues via `engine-api-enqueue`. SDK `pollEvents(sendBatch)` each frame. |
| **`subscribe` / `unsubscribe`** | `~system/EngineApi` | ✅ **tracks event ids** | Worker subscription set synced to main (`EngineApiEventBridge`). Inbound **`comms`** topic wired. |
| **`send`** | `~system/CommunicationsController` | ✅ **publish topic `comms`** | Worker RPC → main `CommsService.publishTopicData`. Pairs with inbound → `sendBatch` for `onCommsMessage`. |
| **`triggerEmote`** | `~system/RestrictedActions` | ✅ worker RPC → local playback + RFC4 broadcast | Scene-triggered emotes (`predefinedEmote` id or URN). |
| **`openExternalUrl`** | `~system/RestrictedActions` | ✅ worker RPC → `window.open` (http/https) | Popup blockers return `{ success: false }`. No confirmation dialog yet. |
| **`openNftDialog`** | `~system/RestrictedActions` | ⬜ **no-op** | NFT detail modal — deferred. |
| **`getActiveVideoStreams`** | `~system/CommsApi` | ⬜ **no-op** — `{ streams: [] }` | **Pending** — pairs with **`VideoPlayer` + `videoEvent`** observable |

**Recently unblocked (not no-ops):**

| API | Status | Notes |
| --- | ------ | ----- |
| `getPlayer()` (SDK `@dcl/sdk/players`) | ✅ | Reads ECS on `PlayerEntity`; mirror now syncs identity components before worker `crdtGetState`. Fixes Genesis Plaza `UserData not set` crash. |
| `UserIdentity.getUserData` | ✅ RPC | Worker ↔ main via session profile; guest synthetic id. Scenes should prefer `getPlayer()`. |
| `CommunicationsController.sendBinary` | ✅ | Comms room + scene binary delivery wired. |
| `CommunicationsController.send` | ✅ | Legacy string message bus — topic `comms` publish + inbound → `sendBatch`. |
| `EngineApi.sendBatch` + `subscribe` | ✅ | SDK7 **`comms`** only — see Phase 3c |
| `RestrictedActions.movePlayerTo` | ✅ | Worker RPC + parcel clamp. |
| `RestrictedActions.openExternalUrl` | ✅ | Worker RPC → main thread `window.open` (http/https). |
| `SignedFetch` | ✅ | Worker RPC → main thread `decentraland-crypto-fetch`; signed when wallet connected, unsigned fallback for public URLs; `getHeaders` returns ADR-44 auth headers (quests WebSocket). |

**Suggested implementation order for no-ops:** (1) ~~`sendBatch` + `subscribe`~~ ✅, (2) ~~`triggerEmote`~~ ✅, (3) ~~`openExternalUrl`~~ ✅, (4) video streams.

---

## Known gaps / follow-ups

- **Genesis Plaza boot:** `getPlayer()` identity on mirror CRDT — **✅ fixed** (2026-06-12). **`EngineApi.subscribe` + `sendBatch`** — **✅ fixed** (2026-06-14). **`Tags`** — **✅ fixed** (2026-06-14). Remaining: **PET_PROXIMITY** pointers, some UI flows.
- **Scene chat — Explorer timestamps:** Outbound messages deliver (dcl-companion LiveKit encode). Unity Explorer shows **wrong dates** on our messages; Three.js chat UI is correct. Fix deferred: Unity RFC4 header + unix timestamp on wire (currently drops delivery).
- **Interaction:** **`PointerEvents` ✅** — camera raycast, hover icons + tooltips, green/red highlight, full desktop input actions, click/key CRDT to scene worker. Remaining: proximity, UI pointers.
- **GLTF colliders:** **✅ fixed (2026-06-13)** — shared cook cache bug, PhysX release crash, degenerate mesh skip. Genesis plaza blocking confirmed.
- **GltfContainer / Visibility:** **✅** — `ThreeBridge` + `AssetCache`; used on Genesis Plaza, RickRoll, parcel scenes.
- **Scene GLTF alpha blend:** **✅ fixed (2026-06-22)** — creator transparency (La Cantina elevator tube `-150,95`); foliage cutout scoped to landscape GLBs only.
- **Profile emotes:** Bundled defaults + wheel + remote RFC4 + AvatarShape loop + **GLB props ✅** + **`AvatarEmoteCommand` ECS bridge ✅** + **locomotion VFX (foot/air puffs) ✅**.
- **Tween:** **`TweenBridge` ✅** — transform + textureMove + **`TweenSequence`** (Genesis blimp orbit) + `pumpMotionBridges` sync-frame fix — see **Tween status** section.
- **Session assets:** GLB/texture cache survives teleports (`getSessionAssetCache`); sign-out evicts via `disposeSessionAssetCache`. **UnityGLTF null-padded JSON chunks** sanitized in `glbSanitizer.ts`. **Hydration gate** — failed GLB loads no longer cached as empty placeholders; loading screen waits for real mesh geometry + unresolved src count; **elapsed timer** (count-up from 0:00; timeout at 3:00 / 1:30 teleport) shows early ready vs fallback.
- **Skinned GLTF instances:** `SkeletonUtils.clone` for scene entities + emote props — `skinnedMeshInstance.ts`.
- **LightSource / sun:** Culling + quality tiers + hybrid sun + ACES + spot shadows + cloud blend ✅ — [INTEGRATION.md](./INTEGRATION.md). Remaining: raw candelas, `shadowMaskTexture`, point shadows.
- **PhysX grounding:** Local player feet on ground ✅; **GLTF invisible `_collider` trimesh blocking ✅** (plaza-scale props).
- **GLTF trimesh cooking:** Per-instance uncached cook; failed/degenerate colliders skipped once (no retry spam).
- **Map / Events UI:** Genesis map + Jump In + peer sidebar ✅; Events Weekly/Calendar ✅; chat unread badge ✅.
- **Parcel routes:** `/80,-1` parsing exists; catalyst parcel fetch not wired.
- **Emissive bloom:** Wearable emissives tuned without post-process — deferred for Explorer parity.
- **Explorer tree parity:** Unity uses baked `WorldsTrees.bin`; we use procedural RNG.
- **GPU grass:** Explorer uses `GrassIndirectRenderer`; we scatter grass glTF patches.
- **Environment cycles:** Procedural sky + SkyboxTime done; Explorer 24-texture atlas + bloom deferred.
- **More shared textures:** Add to `DclTextureResolver.ts` as new 404s appear.
- **Visual QA:** Side-by-side layout vs Explorer — **✅ closed** (2026-06-12); position sync aligned with DCL client (2026-06-13).
- **GLTF trimesh cooking:** ~~Stream-based cook reverted; AABB fallback interim — full trimesh cook TBD.~~ **Resolved** — see PhysX grounding above.

---

## Related docs

- `[IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md)` — full phased architecture
- `[DEPLOYMENT.md](./DEPLOYMENT.md)` — pre-push checklist & browser deployment outline
- `[INTEGRATION.md](./INTEGRATION.md)` — LightSource / sun / shadow tracker
- ``src/environment/`` — asset hashes, coords, empty-land catalog


---

## 2026-06-15 — Re-architecture Phase 3 Complete (Projection + Encoder Default)

**Milestone:** The renderer-side CRDT pipeline is now unconditionally driven by `CrdtProjection` (inbound decode + typed state + diff) + `CrdtEncoder` (renderer-owned outbound) + `ProjectionView` (read facade for bridges).

- All `?projparity` / `?diffconsumer` / `?encparity` / `?encoderout` / `?storeread` flags removed. These paths are the default with zero overhead when the old mirror is only used for bootstrap/getState.
- `crdt-response` payload is produced by the encoder (reserved LWW, tween path, source-captured grow-only PointerEventsResult + VideoEvent).
- Diff consumer is the default in `syncRenderer` (full walk remains only for hydration and periodic safety resync).
- Pointer bind now uses the projection view + facade for reads/iteration (writes already source-captured).
- Build + typecheck clean.

**Mirror Engine status:** Still present for:
- `crdt-get-state` bootstrap snapshot.
- A few legacy consumers (environment, PlayerSystem, ReservedEntitiesSync writes).

**Next (e9–e10):** projection-only reads + drop mirror `Engine()`; perf pass. See [PROGRESS.md](./PROGRESS.md) re-arch milestones.

This is the point where the second full `@dcl/ecs` engine on the main thread is no longer required for turning scene CRDT into a Three.js scene graph.

---

## 2026-06-16 — Re-arch e6 (boot-snapshot parity oracle) + PhysX grounding/collision overhaul

### Re-arch e6 — getState snapshot parity ✅

Non-breaking oracle that proves the new projection/encoder pipeline can reproduce the legacy mirror's boot snapshot before we cut over `crdt-get-state`.

- `CrdtProjection.serializeSnapshot()` + `sceneEntityCount()` — typed projection state → CRDT puts.
- `CrdtEncoder.serializeReservedSnapshot()` + `compareCrdtSnapshots()` / `decodeSnapshotPuts()` + `SnapshotParityReport` — reserved-entity LWW snapshot + parity diff.
- `SceneScriptSystem` `crdt-get-state` handler runs `auditBootSnapshot` → logs **`getState snapshot parity OK`** (engine N keys == new N keys). `NetworkEntity` / `NetworkParent` excluded to avoid false negatives.
- `CrdtMirror.getState()` remains the authoritative bootstrap source until the e9 cutover.

**Next:** e7 pointer same-tick gate (deliver `PointerEventsResult` via plain `crdt-response`) → e8 delete `crdt-renderer-push*` / stash-nudge → e9 encoder-only out + projection-only reads, drop the second `Engine()` → e10 perf pass.

### PhysX player grounding + collision readiness ✅ (user-confirmed)

Several compounding bugs made the local player float and/or fall through; all fixed:

| Fix | File | Notes |
| --- | ---- | ----- |
| Infinite ground = static **box** (top at y=0), not `PxPlane` | `PhysXWorld.ensureInfiniteGroundPlane` | `PxPlane` is unsupported by the CCT and by sweep/overlap scene queries → player never grounded and was invisible to the ground probe. A real thin box behaves like any static collider. |
| Player capsule is **simulation-only** | `PhysXWorld.spawnPlayer` | Removed `eSCENE_QUERY_SHAPE`; the ground/camera probes were self-hitting the player's own capsule (ray exits at capsule base = foot → every probe reported surface==foot). |
| Grounding uses **contact-point Y** | `PhysXWorld.feetYFromGroundHit` | Old distance formula returned the sphere-sweep *centre*, floating the player exactly one `groundSweepRadius` (0.29 m) above every surface — the universal float. |
| Ground-stick clamp retained | `PhysXWorld.movePlayer` | Settles CCT step-up overshoot onto raised floors; now operates on accurate surface data. |
| **Collision-readiness gate** | `World.prewarmPhysicsColliders` + `AppController.loadRoute` | Cooks all scene colliders (e.g. ~971 trimeshes) during the loading screen, **before** `world.start()`. Previously colliders cooked incrementally in the loop after the screen hid → player spawned into an uncollidable scene (fall-through) + main-thread cook jank ("slow then smooth"). Loops `syncCollision()` + `applyPhysicsColliders()` until the static-actor count stabilises, then snaps to ground. |

**Result:** player grounds flush on flat + raised colliders, collides with walls/props from the first frame, and the early-load jank is gone.

---

## 2026-06-16 — RickRoll drone GLTF render + physics lift fix; e7 partial validation

### Re-arch e7 — pointer validation (partial) 🟡

RickRoll `/rickroll.dcl.eth` drone (asset-pack Trigger + `PointerEvents`):

| Check | Status |
| ----- | ------ |
| Drone visible (mis-export GLB) | ✅ textured `drone_collider` art renders |
| Click / tween trigger | ✅ pointer raycast + scene tween fires |
| Push path (`crdt-renderer-push` / stash-nudge) | ✅ confirmed working pre-cutover |
| Same-tick `crdt-response` gate (e7 acceptance) | ⬜ still in progress — full Trigger QA on asset-pack scenes pending |

### RickRoll drone — GLTF mis-export render fix ✅

RickRoll `drone.glb` ships art on `drone_collider` (invisible class) and an untextured `Cube` pointer proxy (visible class).

- `src/collision/gltfRenderMeshes.ts` — `syncGltfInstanceRenderState()` detects mis-export (textured `_collider`, bare visible proxy) and shows the art mesh while keeping the proxy raycastable but camera-invisible.
- `ThreeBridge` calls render sync on attach and each sync frame.

### RickRoll drone — physics lift fix ✅

**Root cause:** GLTF physics extraction treated any mesh under a `_collider` ancestor as an invisible physics surface. RickRoll’s large untextured `Cube` pointer proxy ( `visibleMeshesCollisionMask: CL_POINTER` only) was incorrectly cooked into PhysX. When the drone tweened upward, that oversized proxy swept through the CCT and lifted the player even at a distance. Compounding issues: collision masks were not honored for invisible meshes, geometry fingerprints used per-extract clone UUIDs (forcing recook thrash), and GLTF trimesh transforms were baked into vertices with no pose update path for moving entities.

**Fix:**

| Area | Change |
| ---- | ------ |
| `gltfColliderNaming.ts` | `isGltfVisibleClassMesh()` — named non-`_collider` meshes stay visible-class even when nested under a `_collider` group |
| `GltfColliderExtractor.ts` | Honor `CL_PHYSICS` on both visible/invisible masks; stable source-geometry fingerprint; physics only on `_collider` meshes + visible meshes with `CL_PHYSICS` |
| `gltfPointerMeshes.ts` | Pointer targets use visible-class naming (Cube stays clickable, no physics) |
| `PhysXWorld.ts` | GLTF trimesh colliders cook in mesh-local space; `setGlobalPose` updates pose when entity moves (no recook per frame) |

**Result:** pointer proxies no longer block movement; `_collider` meshes provide physics only; mis-export render workaround does not break layer separation.

### Community docs + repo migration readiness

- `docs/TASKS.yaml` — e7 notes updated with RickRoll partial validation.
- `docs/PROGRESS.md` — this entry; branch `redo/threejs-projection-arch` ready to snapshot before blank-repo migration.
- `npx tsc --noEmit` — ✅ clean.

---

## 2026-06-16 — Re-arch e7/e8 — pointer via crdt-response; push channel deleted

### Re-arch e7 — pointer same-tick via crdt-response ✅ (code complete; browser QA pending)

Pointer results now ride the normal **`crdt-response`** path by default (no `?pushlesspointer` flag):

1. `PointerEventsSystem` writes + `recordAppend` source-captures each `PointerEventsResult`.
2. `flushPendingPointerCrdt()` encodes synchronously → `pointerResponseStash` → `crdt-round-trip-nudge`.
3. Empty-body nudge `crdt-send` merges stash bytes into `crdt-response`; worker stub applies inbound same frame.

| Check | Status |
| ----- | ------ |
| RickRoll drone click/tween (legacy push path) | ✅ user-confirmed pre-cutover |
| Default crdt-response + nudge path (e7/e8) | ⬜ **re-validate in browser** — RickRoll F-key, Genesis watering plants, asset-pack Triggers |
| Debug | `?pointerverbose` — flush + crdt-response byte counts |

### Re-arch e8 — delete crdt-renderer-push / stash / ack ✅

Removed the dedicated push channel and compensation machinery:

| Deleted | Notes |
| ------- | ----- |
| `crdt-renderer-push` / `crdt-renderer-push-ack` | worker protocol + main handler |
| `rendererPushQueue`, `deliverRendererInbound`, `takeRendererPushQueue` | worker |
| `rendererPushStash`, ack timers, `schedulePointerStashNudge` | `SceneScriptSystem` |

**Retained:** `crdt-round-trip-nudge` — still required for same-tick pointer delivery.

### e7/e8 pointer delivery fix — Genesis clicks (2026-06-16)

**Root cause:** After e8, two gaps broke click → scene script delivery:

1. **Stash race** — any in-flight scene-tick `crdt-send` could `takePointerResponseStash()` before the nudge round-trip, leaving the nudge with 0-byte `crdt-response` while PET_DOWN/UP were already logged on main.
2. **Missing `engine.update(0)` after nudge** — stub apply queues inbound CRDT on the renderer transport, but `@dcl/ecs` only processes it in `receiveMessages()` at the start of `engine.update()`. Nudge only called `sceneOnUpdate(0)`, so `inputSystem.getClick()` never saw `timestampIsCurrentFrame(up)`.

**Fix:**

| File | Change |
| ---- | ------ |
| `SceneScriptSystem.ts` | Consume `pointerResponseStash` only on empty-body (nudge) `crdt-send`; mirror `flushOutgoing()` fallback when encoder encode is empty; warn to console when stash is 0 bytes |
| `sceneWorker.ts` | After nudge stub apply, run `sceneEngine.update(0)` then `sceneOnUpdate(0)` |

| Check | Status |
| ----- | ------ |
| Default crdt-response + nudge path (e7/e8) | ⬜ **re-validate in browser** — Genesis watering plants, RickRoll F-key, asset-pack Triggers |
| Debug | `?pointerverbose` — flush + crdt-response byte counts; 0-byte stash warns without flag |

**Next:** e9 projection-only reads + drop mirror `Engine()`; e10 perf pass.

---

## 🎉 Milestone — Genesis Plaza perf + locomotion parity (2026-06-17)

**User-confirmed:** Genesis Plaza (~2423 entities, ~926 GLTFs) **70–110 fps** after pointer fix (was ~12–23 fps with brutal memory pressure). Colliders blocking on buildings/planters. DCL auto-jog speed + animation aligned with Explorer.

### PointerEvents perf — root cause ✅

| Issue | Fix | File |
| ----- | --- | ---- |
| Every frame: rebuild 512-entity pointer set + scan **all 2423 Transform entities** per pointer (recursive) ≈ **1.2M checks/frame** | Cached pointer targets (`childrenByParent` BFS); invalidate on layout change only | `PointerEventsSystem.ts` |
| Hover raycast every frame | Throttle to every 3 frames unless mouse moved / clicking | `PointerEventsSystem.ts` |
| `syncInput` full rebuild | Uses cache rebuild path | `PointerEventsSystem.ts` |
| Player idle still stepping physics | Skip `movePlayer` + `physics.step` when grounded idle | `PlayerSystem.ts`, `PhysXWorld.ts` |
| Projection fold dirty on every pose tick | Exclude player/camera/root from structural dirty; throttle async bridges | `SceneScriptSystem.ts` |

### GLTF colliders + prewarm ✅

| Fix | Notes |
| --- | ----- |
| Hyperfy-style grouped actors + pose-only sync | `GltfColliderExtractor.ts` — shared geometry refs, no clone-at-extract |
| Prewarm gate exits early at partial count | `World.prewarmPhysicsColliders()` — stability wait until GLTF registration plateaus |
| Collisions ready before `world.start()` | No fall-through / slow-then-smooth cook period on entry |

### Social / locomotion polish ✅

| Area | Fix |
| ---- | --- |
| Remote bundled emotes | `DLEraiseHand …` chat text → `playPeerEmote` via `tryParseChatEmoteCommand` (`dclRfc4Chat.ts`, `Rfc4Router.ts`) |
| DCL auto-jog | Default **8 m/s** + **run.glb slowed** (~0.88×) — not walk sped up (`AvatarAnimations.ts`) |
| Shift sprint | **12 m/s** + full run animation (`locomotion.ts`) |

### Re-arch status snapshot (2026-06-17)

| Step | Status | Notes |
| ---- | ------ | ----- |
| Phase 0–2 (projection + diff consumer) | ✅ | Default on branch |
| Phase 3 (encoder default) | ✅ | 2026-06-15 |
| e6 boot-snapshot parity oracle | ✅ | |
| e7 pointer same-tick via crdt-response | ✅ code | Browser QA: Genesis clicks, RickRoll F-key — re-validate as needed |
| e8 delete crdt-renderer-push / stash | ✅ | |
| **e9 drop `CrdtMirror` Engine()** | ✅ | `CrdtMirror.ts` deleted; `RendererComponentHost` schema-only; projection bootstrap `getState` |
| **e10 perf pass** | ⬜ **deferred** | Pointer cache win landed (70–110 fps); shadows/instancing/resync tuning later |
| **Phase 4 unified EntityStore** | ✅ **closed** | Store owns scene nodes + remote avatars; diff + full-resync via `applySceneDiff` |

**Uncommitted working tree:** large batch on `redo/threejs-projection-arch` — commit + push when ready.

---

## 2026-06-17 — Phase 4 kickoff: EntityStore

First slice of the unified Three.js-backed entity store (EntityStore phase — see INTEGRATION.md):

| File | Change |
| ---- | ------ |
| `src/bridge/EntityStore.ts` | **New** — entity → `THREE.Group` map, `owner` tag, create/destroy, change subscriptions |
| `src/bridge/ThreeBridge.ts` | Scene graph nodes live in `EntityStore` (not private `nodes` map) |
| `src/core/systems/SceneScriptSystem.ts` | Owns `EntityStore` lifecycle; passes to `ThreeBridge` |

### Phase 4 slice 1 — Transform apply (2026-06-17)

| File | Change |
| ---- | ------ |
| `src/bridge/entityStoreApply.ts` | **New** — `applySceneDiff`: Transform + Visibility + LightSource mutate groups in place |
| `src/bridge/ThreeBridge.ts` | `consumeDiff` delegates scene-graph patch to EntityStore apply path |
| `SceneScriptSystem.ts` | Store create/destroy → pointer cache invalidate |

### Phase 4 slice 2 — Mesh notify + collision/pointer subscriptions (2026-06-17)

| File | Change |
| ---- | ------ |
| `src/bridge/entityStoreApply.ts` | Mesh/collider/pointer CRDT diffs emit `notifyComponentChange`; tween refresh skips Transform notify |
| `src/bridge/ThreeBridge.ts` | `notifyMeshComponent` after GLB/primitive/text/material attach lands |
| `src/core/systems/SceneScriptSystem.ts` | `onEntityStoreChange` drives `collisionDirty` / `pointerStructureDirty`; removed duplicate flags from `foldProjectionChanges` |

### Phase 4 slice 3 — Full-walk dedup + bridgeDirty consolidation (2026-06-17)

| File | Change |
| ---- | ------ |
| `src/bridge/entityStoreApply.ts` | `notifySecondary` option; Animator/AvatarShape bridge notifications |
| `src/bridge/ThreeBridge.ts` | `sync()` full walk delegates transform/visibility/light to `applySceneDiff` (no duplicate loop) |
| `src/core/systems/SceneScriptSystem.ts` | `bridgeDirty` from EntityStore (GltfContainer/Animator/AvatarShape); `foldProjectionChanges` diff-only |

### Phase 4 slice 4 — Store-backed hydration + owner guards (2026-06-17)

| File | Change |
| ---- | ------ |
| `src/bridge/EntityStore.ts` | `forEachSceneEntity`, `isSceneOwned` — scene-only iteration |
| `src/bridge/ThreeBridge.ts` | `getHydrationStats` walks store (not Transform projection map); full-resync teardown skips avatar-owned nodes; video material invalidation store-scoped |
| `src/bridge/entityStoreApply.ts` | Removals limited to `owner:'scene'` records |

### Phase 4 slice 5 — Remote avatars in store (2026-06-17)

| File | Change |
| ---- | ------ |
| `src/bridge/EntityStore.ts` | `upsertAvatar` / `removeAvatar`, `avatarEntityFromAddress` synthetic ids |
| `src/network/RemoteAvatarManager.ts` | Peer roots registered in EntityStore (`owner:'avatar'`) |
| `src/core/World.ts` | Wires `RemoteAvatarManager.setEntityStore` after scene prepare |
| `src/core/systems/SceneScriptSystem.ts` | Avatar store changes skip collision/pointer dirty flags |

**Phase 4 closed.** Deferred to e10: `FULL_RESYNC_INTERVAL` tuning. Local player capsule remains outside store until a later pass (later pass).

