# Performance optimizations

> Branch context: `dev-latest` / `feat/optimizations` · post-**v1.5.0 RC** (collider PART thrash fixed; avatar crowd path on train)  
> Scope: **runtime performance only** — crowds, CRDT, systems, network stalls, hang UX.  
> Out of scope: product features, shell UI, parity cosmetics unless they cut frame cost.  
> **Shipped with 1.5 RC:** PART cook only on coarse hull fp + running clips (no plaza soft thrash); avatar crowd stagger / compose path.

---

## Goals

1. Keep Genesis Plaza / large worlds playable with many remotes and heavy GLTF.
2. Cut main-thread and worker work that runs every frame with no state change.
3. Fail fast on hung fetches and stuck scene loops (user-visible recover paths).
4. Prefer measured wins (profile first) over speculative rewrites.

**Success signals (target environments):**

| Scenario | Signal |
| -------- | ------ |
| Plaza, 20–40 remotes | Stable interactive FPS; compose queue not permanently backlogged |
| Large world boot (multi-MB) | Hydration finishes without soft-lock; asset stalls time out |
| Idle standing (no input) | Lower CPU than walking (systems park when clean) |
| Background tab | No false “stuck” banners; work reduced while hidden |

---

## Workstreams

### 1. Crowds & remote avatars

**Problem:** Per-remote work each frame (compose, anim, materials, name tags) dominates plaza cost.

| Item | Idea | Priority |
| ---- | ---- | -------- |
| **1.1 Profile & budget** | Instrument per-remote ms/frame + queue depth; set a hard compose budget | P0 |
| **1.2 Distance LOD** | Full skinned → reduced update rate → simplified representation with distance | P0 |
| **1.3 Distant substitute** | Billboard / low-poly / baked snapshot for far peers (swap back when near) | P0 |
| **1.4 Distance fade** | Soft fade / cull remotes beyond policy radius (respect scene toggles if any) | P1 |
| **1.5 Name tags batch** | Single layer / fewer DOM or draw calls for many overhead labels | P1 |
| **1.6 Packet → avatar** | Cheap path from comms packet to pose; skip work when pose unchanged | P0 |
| **1.7 Emote load isolation** | Keep existing “pause remote compose while local emote loads”; extend if still hitchy | P2 |

**Likely touchpoints:** `RemoteAvatarManager`, `RemoteAvatarLoadQueue`, `NameTagRenderer`, peer pose apply.

---

### 2. CRDT & transform traffic

**Problem:** Worker ↔ main CRDT and transform fan-out do redundant work for idle entities.

| Item | Idea | Priority |
| ---- | ---- | -------- |
| **2.1 Skip idle components** | Do not re-encode / re-apply components with no change since last send/apply | P0 |
| **2.2 Transform send cache** | Cache last sent transform; skip identical (or under epsilon) updates | P0 |
| **2.3 Buffer reuse** | Reuse CRDT encode/decode buffers; avoid per-tick allocations | P1 |
| **2.4 Dirty-only pose slides** | ✅ v1.5 — ROOT Transform dirty + PART hull fp gate; avoid global scans | done |
| **2.5 UI vs gameplay CRDT** | Keep pointer/UI CRDT prioritization; avoid cold full flushes when possible | P2 |

**Likely touchpoints:** `sceneWorker`, entity store apply, transport outbound, pose dirty sets.

---

### 3. Change-gated systems (main + worker)

**Problem:** Many systems run every frame even when their inputs are clean.

| Item | Idea | Priority |
| ---- | ---- | -------- |
| **3.1 Inventory hot systems** | List frame systems with always-on cost; mark candidates for early-out | P0 |
| **3.2 Gate on dirty flags** | Animator / material / UI / pointer secondary only when sources dirty | P0 |
| **3.3 Graphics P3 distance culls** | Scene / landscape / shadows distance stubs → real cull radii | P1 |
| **3.4 Hidden document** | Throttle or pause non-essential work when `document.hidden` | P1 |
| **3.5 Instancing hygiene** | Prefer shared materials/meshes; promote only when motion requires | P2 |

**Likely touchpoints:** `World` frame loop, `SceneScriptSystem`, graphics settings, landscape.

---

### 3b. Dense MeshRenderer boards (any scene)

**Problem:** Scenes may stamp **≥12k MeshRenderer** planes (land flippers, grids). 1:1 mesh+geo+mat+unfrozen matrices + mass cast kills FPS while GPU draws stay low.

**Policy:** Scene-agnostic tiers (T0 culled → T1 instance → T2 pooled freeze → T3 live). ECS always authoritative; far animators snap on near. See **[MESH_RENDERER_SCALE.md](./MESH_RENDERER_SCALE.md)**.

| Item | Idea | Priority |
| ---- | ---- | -------- |
| **3b.1 Shared primitive geo** | Pool by `primitiveMeshKey` (not animated UV sprites) | P0 |
| **3b.2 Freeze static MeshRenderer** | `matrixAutoUpdate=false` until Tween/Billboard/Animator/AvatarAttach | P0 |
| **3b.3 Scalar Material same frame** | Color recolor not stuck behind 8/frame deferred queue | P0 |
| **3b.4 Cast density** | high=explicit cast only; ultra=SDK default; never mass-enable on graphs | P0 |
| **3b.5 InstancedMesh buckets** | Eligible static scalar boards | P1 |
| **3b.6 Fair anim + snap-on-near** | Budgeted sample; re-apply ECS pose when becoming live | P1 |

---

### 4. Network & asset stalls

**Problem:** Hung HTTP/content streams stall load and leave the client “busy forever.”

| Item | Idea | Priority |
| ---- | ---- | -------- |
| **4.1 Per-request timeouts** | `AbortSignal` / timeout on catalyst, profiles, places, worlds, content GETs | P0 |
| **4.2 Inactivity timeouts** | Reset timeout on progress bytes; kill true stalls without cutting long healthy downloads | P0 |
| **4.3 Prefetch budgets** | Cap concurrent GLB/texture fetches; prioritize near-player / primary scene | P1 |
| **4.4 Video / stream thrash** | Keep throttled video path; avoid re-bind storms on CRDT races | P2 |

**Likely touchpoints:** Catalyst client, asset cache, worlds content, `WebVideoPlayer`.

---

### 5. Hang detection & recovery UX

**Problem:** Silent freezes (main or worker) look like a dead tab; no clear recovery.

| Item | Idea | Priority |
| ---- | ---- | -------- |
| **5.1 Engine heartbeat** | Main loop + optional worker ping; detect sustained silence | P1 |
| **5.2 Background immunity** | No false “stuck” while tab backgrounded / throttled | P1 |
| **5.3 Scene not responding** | Timeout for scene `onUpdate` / engine tick; user-visible status + soft recover | P1 |
| **5.4 Existing tick aborts** | Harden pointer/hydration CRDT stall aborts already in worker | P2 |

**Likely touchpoints:** App frame loop, scene worker engine update, loading/status UI.

---

### 6. Scene UI GPU cost (optional)

**Problem:** Many UI planes / canvases can multiply draw and texture cost.

| Item | Idea | Priority |
| ---- | ---- | -------- |
| **6.1 Measure first** | Profile Dead Surge / PE-heavy scenes for UI canvas count | P2 |
| **6.2 Reduce redraws** | Dirty-only UI texture updates; skip invisible roots | P2 |
| **6.3 Atlas / batch** | Only if measurement shows multi-canvas cost; prefer minimal change | P3 |

**Likely touchpoints:** `SceneUiBridge`, UI image load, PE UI roots.

---

## Suggested ship order

```
Phase A — Measure + easy wins          ✅ landed on feat/optimizations
  1.1  Profile plaza remotes + CRDT tick cost
  4.1  Universal request timeouts
  3.4  document.hidden throttle
  2.1 / 2.2  Idle skip + transform cache (if profiles show CRDT hot)

Phase B — Crowds
  1.6  Unchanged-pose skip          ✅ (receive + settled frame lerp skip)
  1.5  Name tag perf                ✅ (64m cull, far throttle, head-bone cache)
  1.2  Distance LOD / update rate   ✅ (load ≤20m hard; mid/far throttle; keep loaded)
  1.3  Distant substitute           ❌ skipped (user: no impostors / no atlas tags for now)

Phase C — Systems + graphics       ✅ partial (dirty early-outs)
  3.1 / 3.2  Change-gated systems  ✅ first slice
  3.3  P3 distance culls
  2.3  Buffer reuse

Phase D — Resilience
  4.2  Inactivity timeouts
  5.1–5.3  Heartbeat + not-responding UX
```

---

## Phase C status (partial)

| Item | What landed | Where |
| ---- | ----------- | ----- |
| **3.2 Lights** | Skip full `scene.traverse` light cull when focus moved &lt;0.85 m and last cull &lt;150 ms | [`LightManager.ts`](../src/rendering/LightManager.ts) |
| **3.2 Pointer prepare** | Skip matrix/collider flush when pointer idle (no move / lock / click); hover still throttled | [`PointerEventsSystem.ts`](../src/input/PointerEventsSystem.ts), [`SceneScriptSystem.ts`](../src/core/systems/SceneScriptSystem.ts) |
| **3.2 Animator** | Skip `mixer.update` when no running/scheduled/weighted actions | [`AnimatorBridge.ts`](../src/bridge/AnimatorBridge.ts) |
| **3.2 Billboard** | Early-out when no billboard entities | [`BillboardBridge.ts`](../src/bridge/BillboardBridge.ts) |
| **3.2 Tween dirty** | Update only live runtimes (skip parked completed/paused); iterate runtime not full ECS | [`TweenBridge.ts`](../src/bridge/TweenBridge.ts), pumpMotion |
| **3.2 UI dirty epoch** | `contentEpoch` skips paint/record walk when nothing changed since last paint | [`SceneUiBridge.ts`](../src/ui/scene/SceneUiBridge.ts), flushUiFrame |

**Still open:** distance culls (3.3), CRDT buffer reuse, worker onUpdate gating.

---

## Phase A status (shipped on branch)

| Item | What landed | Where |
| ---- | ----------- | ----- |
| **1.1 Measure** | `perfCounters` + RenderStats lines: remotes vis/loaded, compose queue/active, movement send + idle-skip rates | [`src/util/perfCounters.ts`](../src/util/perfCounters.ts), [`RenderStats.ts`](../src/client/ui/RenderStats.ts), [`World.ts`](../src/core/World.ts) |
| **4.1 Timeouts** | `fetchWithTimeout` + budgets on catalyst entities, profiles, realm `/about` + `/status` | [`fetchWithTimeout.ts`](../src/util/fetchWithTimeout.ts), [`CatalystClient.ts`](../src/network/catalyst/CatalystClient.ts), [`catalystProfiles.ts`](../src/map/catalystProfiles.ts), [`realmAbout.ts`](../src/network/catalyst/realmAbout.ts) |
| **3.4 Hidden tab** | Cap full frames to ~8 FPS while `document.hidden` (stacks with user FPS limit) | [`SceneHost.ts`](../src/rendering/SceneHost.ts) |
| **2.2 Idle movement** | Skip LiveKit RFC4 movement when pose unchanged (ε); 3s keepalive; still send emote/jump; counters | [`LiveKitCommsSession.ts`](../src/network/comms/LiveKitCommsSession.ts) |

**Not in Phase A (later):** byte-inactivity timeouts (4.2), CRDT worker idle skip (2.1 full), remote LOD (Phase B).

**How to read stats:** Help → debug RenderStats extra lines — while standing still, `idle skip` should rise and `move out` drop toward ~0.3/s (keepalive).

---

## Phase B status

| Item | What landed | Where |
| ---- | ----------- | ----- |
| **1.6 Pose skip** | Identical movement packets skip velocity/target rewrite; settled peers skip lerp/yaw | [`RemoteAvatarManager.ts`](../src/network/RemoteAvatarManager.ts) |
| **1.5 Name tags** | Cull CSS2D beyond 64 m; settled near ~12 Hz / far 200 ms; head bone cache; voice only speakers | same + [`headAnchor.ts`](../src/avatar/headAnchor.ts), [`NameTag.ts`](../src/client/ui/NameTag.ts) |
| **1.2 LOD** | **Load ≤20 m hard** (pill beyond); **never unload**; update bands **near ≤14 m full**, mid ≤22 m ~25 Hz, far ~15 Hz pose (emote keeps anim) | [`RemoteAvatarLoadQueue.ts`](../src/network/RemoteAvatarLoadQueue.ts), manager update |
| **1.3** | Skipped (no impostors / no Hyperfy atlas nametags for now) | — |
| **Settled loco-idle anim** | Mixer ~12 Hz when settled **and not emoting** (looping emotes full rate); `animSkip` counter | manager + `perfCounters` |
| **Walk→idle** | Wire silence 0.28 s clears stale speed; faster speed/blend decay; keepalive does not refresh `receivedAt` | manager + `AvatarAnimations` / VRM / ODK |
| **GPU hygiene** | Fixed skinned bounds + frustum cull; FrontSide default; nearest 6 remotes cast shadows | `skinnedMeshInstance`, materials, manager |
| **Parallel wearables** | Cache pairs at bind; no traverse/frame | `loadWearable` + `AvatarAnimations` |
| **Queue fixes** | No direct `loadPeerAvatar` outside queue; provisional joins don't force-compose; no per-frame re-enqueue GC | manager + load queue |

RenderStats: `poseSkip`, `animSkip`, `remote ms`, `lod n/m/f`, `compose last=ms`, tags.

**Compose policy (locked):** `MAX_CONCURRENT=1`, `MIN_COMPOSE_INTERVAL_MS=10_000` — do not speed up for plaza triangle load.

**Parked:** atlas/single-draw nametags, impostors, hide-avatars distance slider (product setting later).

---

## Non-goals

- Rewriting the renderer or moving the shell into the engine.
- Matching another client’s engine or material cache design.
- Feature work (map, social, backpack) unless it removes a proven hotspot.
- Premature impostor art pipeline before distance LOD / skip-idle land.

---

## How we’ll validate

1. **Before:** capture timeline on Genesis Plaza (idle + walk) and one heavy world.
2. **After each phase:** same scenes, same peer counts where possible.
3. **Regressions:** PE UI, pointer, primary promote, emote load, video screens.
4. **Docs:** update PROGRESS when a phase ships; keep this file as the plan.

---

## Open questions

- Impostor quality vs cost: simple billboard vs multi-view bake?
- Shared policy with AOI: cull remotes outside interest before avatar LOD?
- Metrics: expose a debug panel line (remotes, compose queue, CRDT bytes/frame)?

---

*Start with Phase A on this branch; promote slices to `dev-latest` as they land.*
