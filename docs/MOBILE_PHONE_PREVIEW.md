# Landscape phone preview in 3D play — review

> **Status:** review only — not implemented. Captured 2026-08-23 from the local-preview / horizontal-phone discussion. Do not treat as a build spec until this is claimed.

A **new 3D play view** that is a horizontal (landscape) phone: same `/localpreview` session, same worker, same feet — the world is staged in a landscape-phone rectangle with mobile chrome inside it.

Explorer-on-phone is landscape. That is the case this view is for.

## Verdict

**Possible.** The renderer already sizes to a panel (`SceneHost.bindViewport`, editor workspace). A phone stage is that primitive plus making HUD / scene UI / mobile chrome follow the **stage**, not `window`.

Do **not** iframe a second World (double WebGL, two identities, pointer-lock pain). Do **not** draw a CSS bezel around a full-window canvas — `@media` and `matchMedia` ignore the bezel.

## What “mobile specs” are today

There is no `/localpreview` mobile mode and no `?mobile` flag.

Layout is `(max-width: 767px)` copied in JS (`ClientShell`, `MobileGameHud`, `SocialChatDock`, `MapView`, `SettingsOverlay`) and CSS (`@media (max-width: 767px)` plus `.client-mobile`, which is only added when that query matches).

That turns on: profile/chat FABs, location pill, E/F/jump HUD, drawer shell, hidden minimap. Touch / UA / `pointer: coarse` are **not** part of the layout decision (UA is only used for MetaMask).

Scene ECS UI maps `setUiRenderer` space onto the window (`innerWidth` × `innerHeight` in `UiCanvasInformation`). Phone aspect already changes Yoga layout; chrome does not follow unless width ≤ 767.

## Why a horizontal phone misses it

| Device | Landscape CSS | Hits 767 gate? |
| --- | --- | --- |
| iPhone SE | 667 × 375 | yes |
| iPhone 14 | 844 × 390 | **no** |
| iPhone 14 Pro | 852 × 393 | **no** |

DevTools “iPhone 14 → landscape” is ~844px wide → desktop sidebar, no mobile HUD. A decorative frame around a full-window WebGL surface does nothing: media queries key off the **browsing-context viewport**, not the canvas CSS box.

## Phone-stage view (proposed)

Desktop window stays large. Center is a ~19.5:9 (e.g. 844×390) stage. 3D, scene HUD, FABs, E/F/jump live **inside** the bezel. Outside is empty/bezel only.

`#app` **is** the phone (centered, fixed aspect). `#app canvas` is `inset: 0 !important; width/height 100%` — do not shrink the canvas inside a full-window `#app`.

Three things must follow the stage, not the window:

1. **WebGL / camera aspect** — `bindViewport(phoneStage)` already does this.
2. **Scene ECS UI** — `readInteractableArea` takes the **largest** of canvas / `#app` / window so the HUD never letterboxes. Phone-preview must use the stage rect only. `UiCanvasInformation` also uses `window.innerWidth/Height` for scale; that must become the stage size or plaza widgets stay desktop-scaled on a tiny canvas.
3. **Client mobile chrome** — still `(max-width: 767px)`. A phone sitting in a 1920px window will not match. Force `.client-mobile` (query flag or preview toggle). CSS that is only `@media (max-width: 767px)` without `.client-mobile` stays desktop unless those rules move onto the class (or a container query on the stage).

## Mobile UI + restrictions (same chrome, not a second UI)

Replicable inside the stage if **one** mobile flag drives JS **and** CSS:

- Profile FAB, chat FAB, landscape location pill
- E / F / jump / emotes (`MobileGameHud`)
- Sidebar as a drawer (minimap / location card off)
- Mobile sheets for backpack, settings, friends

Layout restrictions (no minimap, no desktop rail, PiP resize off, sheets instead of side columns) are chrome, not a separate engine “mobile mode.” There is no extra RestrictedActions path for mobile.

**Not** replicated by the stage:

| Thing | Why |
| --- | --- |
| Pointer lock / WASD | Still this machine. No virtual joystick in this review (separate branch). |
| Desktop GPU / thermal / Safari | Stage is a layout. Use a real device or `?perf=low`. |
| Auto graphics cap | Quality is prefs / `?perf=`, not “I’m a phone.” |
| Real notch `safe-area-inset-*` | Can fake padding on the stage; DevTools only fakes it with a device frame. |

## Dev log / Help → Debug

`DebugPanel` + `ClientDebugLog` are **not** mobile-gated. Record / mirror / capture, FPS, position, PhysX toggles all still work.

The panel is window-fixed ~440×88vh (`z-index: --z-client-debug`). Inside an 844×390 phone it covers the HUD you are testing.

**Recommended split:**

- **Inside the phone:** play chrome + scene UI + mobile layout restrictions
- **Outside, on the desk around the bezel:** Debug / client log / perf (Labs → Dev)

Same in-memory log stream. Labs can stay in the drawer; the panel should dock next to the device.

## Other ways to test (without a stage)

| Goal | Use |
| --- | --- |
| Layout at phone landscape | Force-mobile + 844×390 viewport (DevTools landscape or `window.open(..., 'width=844,height=390')`) |
| Touch + real GPU | Phone on LAN (Vite is localhost-only today — needs `server.host`) **after** detection is not width-only |
| Pretty bezel in the tab | Iframe around a forced-mobile URL — cosmetic only; not preferred |

`?perf=low` already exists for a mobile-ish GPU path. Pointer-lock is flaky in Chrome device mode.

## Implementation notes (when claimed)

- One matcher used by JS and CSS (today 767 is duplicated ~15 times).
- `SceneHost.bindViewport` + stop `readInteractableArea` maximizing to the window while the stage is on.
- Do not merge this into `dev-latest` until asked.

## Related

- Local preview: [README.md](../README.md#local-preview) (`/localpreview`, `/preview`)
- Play chrome: `ClientShell`, `MobileGameHud`, `index.html` `@media (max-width: 767px)`
- Scene UI box: `src/ui/scene/virtualCanvas.ts` (`readInteractableArea`, `alignSceneUiRoot`)
- Viewport bind: `src/rendering/SceneHost.ts` `bindViewport`
