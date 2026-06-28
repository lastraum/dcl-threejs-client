# In-Scene ECS UI (React ECS / UiEntity) — Design

> **Branch:** `lastraum`  
> **Status:** MVP scaffold — Yoga layout + DOM renderer + `UiCanvasInformation` inject  
> **Not in scope:** Browser HUD (`CLIENT_UI_LAYOUT.md`)

## Problem

SDK7 scenes author UI via `@dcl/sdk/react-ecs`:

- Creators use `UiEntity`, `Label`, `Button` (not raw JSX fragments — everything reconciles to ECS entities).
- `ReactEcsRenderer.setUiRenderer(tree)` runs a reconciler each frame → `UiTransform`, `UiText`, `UiBackground`, … on scene entities.
- Layout uses **Yoga** flexbox semantics (`YGAlign`, `YGFlexDirection`, percent/auto sizes, etc.) in `PBUiTransform`.
- The **renderer** must:
  1. Lay out the tree with Yoga against a **virtual canvas** size.
  2. Draw UI (screen-space overlay for MVP).
  3. Write **`UiCanvasInformation`** on `RootEntity` (entity `0`) so scenes can read `width` / `height` / `devicePixelRatio` / `interactableArea`.
  4. Eventually write `UiInputResult`, `UiDropdownResult`, handle pointer events on UI entities.

Today ThreejsClient **ignores** all `Ui*` components.

## Reference (DCL / Explorer)

| Piece | Location |
|-------|----------|
| ECS schemas | `@dcl/ecs` — `PBUiTransform` (Yoga enums), `PBUiText`, `PBUiBackground`, `PBUiCanvasInformation` |
| React reconciler | `@dcl/react-ecs` — `createReconciler`, `CANVAS_ROOT_ENTITY = 0` |
| Scene usage | `ReactEcsRenderer.setUiRenderer(ui, { virtualWidth?, virtualHeight? })` |
| Canvas readback | `UiCanvasInformation.get(engine.RootEntity)` in scene systems |

Tree wiring:

- `UiTransform.parent` → parent entity (`0` = canvas root).
- `UiTransform.rightOf` → previous sibling entity id (`0` = first child).

## Architecture (ThreejsClient)

```
Scene worker (@dcl/react-ecs reconciler)
  → CRDT outbound: UiTransform / UiText / UiBackground on scene entities
  → Main thread projection (mirror engine)

SceneUiBridge (main thread, each syncRenderer)
  1. Collect entities with UiTransform from ProjectionView
  2. Build sibling-ordered tree (parent + rightOf)
  3. Yoga layout @ virtual canvas size
  4. SceneUiDomRenderer — absolutely positioned DOM nodes in #scene-ui-root
  5. UiCanvasInformation.createOrReplace(RootEntity) → CrdtEncoder → worker inject
```

### Virtual canvas

| Source | Purpose |
|--------|---------|
| Default `1920×1080` | Explorer-style baseline when scene does not override |
| `SceneUiBridge.setVirtualSize(w, h)` | Future: read from scene boot or query param |
| `interactableArea` | Screen rect minus HUD chrome (MVP: full viewport) |
| `devicePixelRatio` | `window.devicePixelRatio` |

DOM nodes are scaled: `screenPx = layoutPx * (interactableWidth / virtualWidth)`.

### Render path (MVP)

**DOM overlay** in `#scene-ui-root` (fixed, above WebGL canvas, below client HUD).

Later options:

- Render-to-texture for in-world UI planes.
- Pointer routing integration with `PrimaryPointerInfo` + UI entity hits.

## Component matrix

| Component | ID | Mirror | Renderer | Worker inject |
|-----------|-----|--------|----------|---------------|
| UiTransform | 1050 | ✅ read | Yoga + layout | — |
| UiText | 1052 | ✅ read | DOM text | — |
| UiBackground | 1053 | ✅ read | DOM background | — |
| UiCanvasInformation | 1054 | ✅ write | Bridge | ✅ LWW PUT root |
| UiInput | 1093 | ⬜ | — | — |
| UiInputResult | 1095 | ⬜ | — | ⬜ |
| UiDropdown | 1094 | ⬜ | — | — |
| UiDropdownResult | 1096 | ⬜ | — | ⬜ |

## Files

| File | Role |
|------|------|
| `src/ui/scene/SceneUiBridge.ts` | Orchestrator |
| `src/ui/scene/yogaLayout.ts` | `PBUiTransform` → Yoga |
| `src/ui/scene/SceneUiDomRenderer.ts` | DOM pool + draw |
| `src/ui/scene/uiTree.ts` | parent/rightOf tree |
| `src/ui/scene/virtualCanvas.ts` | Virtual + interactable rects |
| `src/bridge/mirrorComponents.ts` | Ui* registration |
| `src/bridge/CrdtEncoder.ts` | UiCanvasInformation outbound |
| `src/shim/worker/injectRendererLwwPuts.ts` | Worker-side canvas apply |

## Phased delivery

### Phase A (this branch) — MVP visible UI

- [x] Design doc
- [x] Mirror UiTransform, UiText, UiBackground
- [x] Yoga layout + DOM renderer
- [x] UiCanvasInformation inject
- [ ] Manual test on `hide-player` or UI-heavy scene

### Phase B — Input parity

- [ ] Ui pointer hit-testing (block scene ray when over UI)
- [ ] `UiInput` / `UiInputResult`
- [ ] `UiDropdown` / `UiDropdownResult`
- [ ] react-ecs `onMouseDown` / `onMouseUp` → pointer events on UI entities

### Phase C — Polish

- [ ] Background textures (nine-slice, stretch)
- [ ] Font parity (Inter, monospace, …)
- [ ] `interactableArea` excludes sidebar/chat when HUD open
- [ ] `setUiRenderer({ virtualWidth, virtualHeight })` detection if exposed in CRDT

## Testing

```bash
npm run dev
# Load a scene with react-ecs UI (e.g. hide-player world, or local test scene)
# Verify: UI visible, UiCanvasInformation logged in scene (uiSizer pattern)
```

## Related

- `docs/INTEGRATION.md` — ECS UI row
- `docs/CLIENT_UI_LAYOUT.md` — explicitly excludes this system