# Social / Companion UX Merge — Implementation Plan

> Integrates [dcl-companion `threejs-client-ux-spec.md`](../../dcl-companion/docs/threejs-client-ux-spec.md) into this repo on branch `decentraland-social-merge`.

**Status:** Phase 2.5 in progress
**Reference:** `dcl-companion/web-app-social/` (browser-only mode)

---

## Principles (from UX spec)

| Rule | Implementation |
|------|----------------|
| `/` = Explorer | No 3D load on cold visit |
| `/<segment>` = scene landing | Info hub first; never auto-3D |
| Jump in | Only path into 3D from landing |
| `/goto` in 3D chat | Teleport in-place; no URL route |
| Login | Global across Explorer, landing, 3D |

**Mode state** (not yet wired):

```ts
type AppMode = 'landing' | 'play'
type SceneContext = { segment: string; mode: AppMode }
```

---

## What we already have

| Asset | Location | Notes |
|-------|----------|-------|
| Places grid + API | `src/client/ui/settings/PlacesView.ts`, `src/social/dclPlaces.ts` | HotScenesCrowd parity |
| Route parsing | `src/dcl/content/route.ts` | Coords, worlds, `/goto` |
| Auth / identity | `src/auth/`, splash screen | Wallet + guest |
| In-world social | `src/social/`, chat, LiveKit | Phase 5 work |
| Events / map / backpack | `SettingsOverlay` tabs | In-world only today |

---

## Phases

### Phase 1 — Explorer at `/` ✅ (this PR)

**Goal:** Cold visit to `/` shows the explore page; no scene load.

| Task | Files |
|------|-------|
| `/` resolves to explorer, not `0,0` | `src/dcl/content/route.ts` |
| Full-page `ExplorerView` wrapping `PlacesView` | `src/client/ui/explore/ExplorerView.ts` |
| App shell routing: explorer vs scene | `src/client/AppController.ts` |
| Explorer card → `/<segment>` navigation | `PlacesView` `onOpenScene` |
| Reserved path denylist (companion sync) | `route.ts` |
| Explorer layout CSS | `index.html` |

**Auth:** No blocking splash on `/` — session auto-resumes from storage; inline sign-in sheet in explorer header (companion `ExploreProfileMenu` parity, wallet + guest).

**Temporary deviation:** Card "Visit" still loads 3D until Phase 2 landing exists.

**Exit criteria:**
- [ ] `http://localhost:5173/` shows places/worlds grid after login
- [ ] No WebGL scene on `/`
- [ ] Browser back from a scene returns to explorer when URL is `/`
- [ ] Favorites tab works when wallet-signed-in

---

### Phase 2 — Scene landing at `/<segment>` ✅

**Goal:** Cold `/<segment>` shows info hub; Jump in enters 3D on same URL.

| Task | Files |
|------|-------|
| `SceneLandingView` — hero, crowd, owner, description | `src/client/ui/landing/` |
| `AppMode` state machine in `AppController` | `src/client/AppController.ts` |
| Cold visit → `mode=landing`; Jump in → `mode=play` | same |
| Leave 3D → landing (same segment) | shell control |
| Explorer / landing links never skip to play | route + mode guards |
| Scene metadata fetch | Catalyst + Places APIs |
| Events banner + `EventModal` on landing | `sceneLanding.ts`, `EventModal.ts` |
| `/events` page + in-app events calendar | `EventsPageView.ts` |

**Reference:** companion `sceneWatchRoute.ts`, scene watch page layout.

---

### Phase 2.5 — 2D shell nav (Explore · Communities · Events)

**Goal:** Companion-style top tabs on every non-3D surface; browse communities without entering a scene.

| Task | Files |
|------|-------|
| Shared `SocialShellTopNav` | `src/client/ui/explore/SocialShellTopNav.ts` |
| `/communities` route + browse grid | `route.ts`, `CommunitiesPageView.ts` |
| Nav on explorer, landing, events, communities | all 2D views + `AppController.ts` |
| Public communities API | `src/social/socialApi.ts` |

**Exit criteria:**
- [ ] Explore / Communities / Events tabs visible on `/`, `/events`, `/communities`, and `/<segment>` landing
- [ ] Tab highlights match current page (landing: none active)
- [ ] `/communities` loads browse list (guest or signed-in)

**Deferred to later:** community detail modal, join/voice, full `CommunitiesView` parity.

**TODO:** Community browse cover images — list API omits `thumbnails`; CDN `raw-thumbnail.png` fallback is incomplete (many 404). Port companion `communityThumbnailProxy` + per-id detail enrichment (`resolveCommunityDisplayImageUrl`).

---

### Phase 3 — Watch Lite on landing

**Goal:** Voice + text chat on landing without WebGL (mobile-first).

| Task | Files |
|------|-------|
| Gatekeeper client (port from companion) | `src/social/gatekeeper.ts` or shared pkg |
| LiveKit room per scene on landing | extend `LiveKitCommsSession` |
| RFC4 chat on landing | `dclRfc4Chat.ts` reuse |
| HLS stream embed (if scene has deploy video) | `sceneDeployHls` parity |

**Server:** Direct Signed Fetch to comms-gatekeeper (CORS `*` in prod).

---

### Phase 4 — `/goto` in 3D chat (play-mode teleport)

**Goal:** Chat `/goto x,y` loads new scene in-place; stays in 3D.

| Task | Files |
|------|-------|
| Diverge from companion SPA navigation | `ChatPanel.ts`, `AppController.ts` |
| `threeSceneLoader.load(segment)` without remount | `loadRoute` + `mode=play` guard |
| `history.replaceState` URL sync | `applyRouteToHistory` |
| Usage / bad-target hints | chat UX |

**Reference:** `sceneChatGotoPathFromLine()` in companion `sceneWatchRoute.ts`.

---

### Phase 5 — Polish & power features

| Task | Notes |
|------|-------|
| `?in=1` refresh-in-3D | Default off |
| Events / Communities routes | Separate paths per spec |
| `decentraland://` deep links on landing | `dclClientJumpIn.ts` |
| Extract `@dcl-companion/explore-core` | Shared data layer (optional) |

---

## Architecture (target)

```
┌─────────────────────────────────────────────────────────┐
│ AppController                                           │
│  resolveRouteTarget() → explorer | landing | play       │
├─────────────────────────────────────────────────────────┤
│  /              → ExplorerView (PlacesView)               │
│  /<segment>     → SceneLandingView (mode=landing)       │
│  /<segment>     → World + ClientShell (mode=play)        │
├─────────────────────────────────────────────────────────┤
│  Global login (SplashScreen / stored identity)          │
│  AuthProvider scope — same session all modes              │
└─────────────────────────────────────────────────────────┘
```

---

## Router checklist (from spec)

```
[x] GET /                          → ExplorerView
[x] GET /<segment>                 → SceneLandingView (cold → mode=landing)
[x] GET /events                    → EventsPageView
[x] GET /communities               → CommunitiesPageView
[x] Deny reserved first segments   → route.ts denylist
[x] 2D shell nav                   → SocialShellTopNav on all non-play views
[ ] Global AuthProvider above router
[x] Jump in button                 → mode=play, mount Three.js
[x] Leave button                   → mode=landing, unmount Three.js
[ ] 3D chat /goto handler          → teleport in play mode only
[x] Explorer links                 → /<segment> landing
[ ] history.replaceState on /goto
[ ] SPA fallback for /<segment>
```

---

## Related docs

| Doc | Topic |
|-----|-------|
| `dcl-companion/docs/threejs-client-ux-spec.md` | Agreed UX |
| `dcl-companion/docs/browser-only-endpoint-portability.md` | API serverless matrix |
| `docs/IMPLEMENTATION_PLAN.md` | Core 3D client phases |
| `docs/PROGRESS.md` | Current milestone log |