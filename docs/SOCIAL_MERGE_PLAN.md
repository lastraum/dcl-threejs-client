# Social / Companion UX Merge — Implementation Plan

> Integrates [dcl-companion `threejs-client-ux-spec.md`](../../dcl-companion/docs/threejs-client-ux-spec.md) into this repo.

**Status:** **Merged into `dev-latest`** — Phases 1–2.5 ✅ · Phase 3 Watch Lite + multi-room chat ✅ · Phase 4 `/goto` open · deploy at **decentraland.social** / **dev.decentraland.social**  
**Source branch:** `decentraland-social-merge` (+ later `lastraum` multi-room / cast polish)  
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

**Mode state** (`src/client/appMode.ts`):

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
| Auth / identity | `src/auth/`, explorer auth sheet | Wallet + guest |
| In-world social | `src/social/`, chat, LiveKit | Phase 5 work |
| Events / map / backpack | `SettingsOverlay` tabs | In-world only today |

---

## Phases

### Phase 1 — Explorer at `/` ✅ (shipped `dev-latest`)

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

**Exit criteria:**
- [x] `http://localhost:5173/` shows places/worlds grid after login
- [x] No WebGL scene on `/`
- [x] Browser back from a scene returns to explorer when URL is `/`
- [x] Favorites tab works when wallet-signed-in

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
| Crowd badge → player roster modal | `SceneUsersModal.ts`, `sceneParticipants.ts` |
| `/events` page + in-app events calendar | `EventsPageView.ts` |

**Reference:** companion `sceneWatchRoute.ts`, scene watch page layout.

---

### Phase 2.5 — 2D shell nav (Explore · Communities · Events) ✅

**Goal:** Companion-style top tabs on every non-3D surface; browse communities without entering a scene.

| Task | Files |
|------|-------|
| Shared `SocialShellTopNav` | `src/client/ui/explore/SocialShellTopNav.ts` |
| `/communities` route + browse grid | `route.ts`, `CommunitiesPageView.ts` |
| Nav on explorer, landing, events, communities | all 2D views + `AppController.ts` |
| Public communities API | `src/social/socialApi.ts` |

**Exit criteria:**
- [x] Explore / Communities / Events tabs visible on `/`, `/events`, `/communities`, and `/<segment>` landing
- [x] Tab highlights match current page (landing: none active)
- [x] `/communities` loads browse list (guest or signed-in)

**Also shipped:** `CommunityModal`, full-screen `ProfilePageView`, `MapPageView`, community thumbnails (`communityDisplayImageUrl`, `communityThumbnailProxy`, 404 detail enrichment).

**Deferred to later:** join/voice on communities, full `CommunitiesView` in-world parity.

---

### Phase 3 — Watch Lite on landing ✅

**Goal:** Voice + text chat on landing without WebGL (mobile-first).

**Shipped:**

| Task | Status | Files / notes |
|------|--------|----------------|
| Gatekeeper scene adapter | ✅ | `GatekeeperClient` + `resolveSceneChatAdapter` |
| LiveKit chat on landing | ✅ | `SocialChatController` + primary `CommsService` |
| Multi-room keep-alive | ✅ | `SceneChatRoomPool` — companion multi-text-chats; tabs stay live across navigate |
| RFC4 chat on landing | ✅ | `dclRfc4Chat.ts` + OLE timestamps for Explorer interop |
| Stream keys + Join Live cast | ✅ | OBS RTMP; guest or wallet watch; mute; stream-end → details |
| Channel notifications | ✅ | Mobile banners + unread per channel |
| 2D sign-out / guest session | ✅ | Stable browser guest wallet + Catalyst profile |
| HLS / “I'm live” listings | ⬜ | Deferred product CTA |
| Spatial voice UI | ⬜ | LiveKit connected; no mic HUD yet |

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
│  Session resume + explorer auth sheet (no splash)         │
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
[x] Watch Lite chat/cast on landing → multi-room pool + Join Live (guest OK)
[ ] Global AuthProvider above router
[x] Jump in button                 → mode=play, mount Three.js
[x] Leave button                   → mode=landing, unmount Three.js
[ ] 3D chat /goto handler          → teleport in play mode only
[x] Explorer links                 → /<segment> landing
[ ] history.replaceState on /goto
[x] SPA fallback for /<segment>    → vite/nginx deploy
```

---

## Related docs

| Doc | Topic |
|-----|-------|
| `dcl-companion/docs/threejs-client-ux-spec.md` | Agreed UX |
| `dcl-companion/docs/browser-only-endpoint-portability.md` | API serverless matrix |
| `docs/IMPLEMENTATION_PLAN.md` | Core 3D client phases |
| `docs/PROGRESS.md` | Current milestone log |