# Client UI layout (responsive HUD)

> **Scope:** Browser DOM chrome only (sidebar, chat, minimap, settings, loading, explorer shell).  
> **Not in scope:** In-scene ECS UI (`UiTransform`, React scene UI) — separate system later.

## Design reference

Layout is **fluid**, not fixed to one resolution. Reference desktop: **1920×1080**. All panels use `min()` / `clamp()` and shared CSS variables so ultrawide, laptop, tablet, and phone stay usable.

## CSS tokens (`index.html` `:root`)

| Variable | Purpose |
| -------- | ------- |
| `--client-sidebar-w` | Measured width of `#client-shell` (set by JS) |
| `--client-ui-gap` | Gap between sidebar and HUD panels (8px desktop, 6px tablet) |
| `--client-safe-left` | `sidebar + gap` — use for `left:` on anchored panels |
| `--client-safe-right` | `max(16px, safe-area-inset-right)` |
| `--client-safe-top` / `--client-safe-bottom` | Safe areas + minimum padding |
| `--client-panel-max-w` | Generic popup max width |
| `--client-hud-max-w` | Minimap / world card / chat width cap |
| `--client-chat-max-h` | Chat column height cap |
| `--z-scene-ui` | Scene ECS UI (`#scene-ui-root`) — **below** client HUD |
| `--z-client-hud` | Sidebar, minimap, world card, skybox, mobile chrome |
| `--z-client-hud-raised` | Chat wrap, mobile game HUD fabs |
| `--z-client-overlay` | Settings / emote wheel full-screen overlays |
| `--z-client-system` | Full-screen loading overlay (above HUD) |
| `--z-client-debug` | Debug panel |

**Rule:** Never use raw `2vw` for panel offsets. Always `var(--client-safe-left)`.

**Stacking rule:** Client HUD (`--z-client-hud` = 100) always paints over scene UI (`--z-scene-ui` = 40). Do not assign HUD chrome below 40.

**Auth:** No full-screen splash. Session resumes via `resolveInitialLogin`; wallet/guest sign-in is the explorer auth sheet.

## Measured sidebar (`ClientUiLayout.ts`)

`ClientShell` attaches `ClientUiLayout` to `#client-shell`. A `ResizeObserver` writes the real pixel width to `--client-sidebar-w` so panels align with `clamp(36px, 2vw, 48px)` sidebar — not a guessed `2vw`.

## Breakpoints

| Tier | Query | Notes |
| ---- | ----- | ----- |
| Desktop | ≥1024px | Default tokens |
| Tablet | `max-width: 1023px` | Smaller minimap, tighter chat height |
| Mobile | `max-width: 767px` | 48px sidebar, 44px touch targets, full-width chat |
| Short viewport | `max-height: 700px` | Reduced chat max height |

Loading, map, events, and graphics settings use the same **767 / 1023** tiers.

## QA matrix

Manually verify controls are visible and not clipped:

- 1920×1080, 2560×1440, 1366×768, 1280×720  
- 1024×768 (tablet landscape)  
- 390×844 (phone portrait), 844×390 (phone landscape)

Check: sidebar, chat input, emote wheel, settings close, loading bar, explorer auth sheet.

## Adding a new panel

1. Position with `left: var(--client-safe-left)` (or `right: var(--client-safe-right)`).  
2. Width: `min(<design-px>, var(--client-panel-max-w))`.  
3. Height caps: use `vh` with `min()` and `--client-safe-*`.  
4. Add mobile overrides in `@media (max-width: 767px)` if the panel is large.  
5. Do not read sidebar width in TS — rely on CSS variables.
