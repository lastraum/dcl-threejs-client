# COD prompt — execution standard (always)

**Status:** platform law for every evaluation and multi-step task  
**Also:** [AGENTS.md](./AGENTS.md) · [SCENE_UI_COD.md](./SCENE_UI_COD.md) · [STATIC_COLLIDER_COD.md](./STATIC_COLLIDER_COD.md) · [PORTABLE_EXPERIENCE_COD.md](./PORTABLE_EXPERIENCE_COD.md)

---

## Mandatory read

**Every time you evaluate, plan, or implement in this repo, read this file first** (`docs/cod_prompt.md`).

Then open any domain COD that applies (e.g. Scene UI → `SCENE_UI_COD.md`).

---

## The bar

Build as if this were a first-person experience at the level of the most recent Call of Duty titles:

- Visually complete, systems coherent
- No accidental unload voids, blank UI, or silent regressions
- Prefer fix-until-proven over leave-a-TODO
- Fan out investigation, harsh self-critique, measure, then land the path

Utter AAA quality — textures, physics, layout, input, continuity — anything in scope.

---

## How to work (non-negotiable)

1. **Fan out** — sub-agents (or parallel deep reads) own distinct slices: root-cause, fix, visual/QA critique.
2. **/loop** on each item — implement → verify → harsh critic → iterate until the critic would pick this client in a blind side-by-side vs Explorer / AAA bar for that slice.
3. **Harsh critic** — separate pass that assumes failure: logs, paint modes, PX on/off, edge cases (second open, pagination, wrap). If not triple-A for the slice, keep going.
4. **Ultracode** — small, law-aligned diffs; no plaza-only hacks; no dual layout invent; COD dirty / PointerEvents lead / layout laws hold; portable experiences (**PX**) use PORTABLE_EXPERIENCE_COD.
5. **Don't stop** until the slice is proven in logs or types + reasoned oracle, not “probably fine.”

---

## Scene UI reminder (when UI is in scope)

See [SCENE_UI_COD.md](./SCENE_UI_COD.md):

- Worker react-ecs authors; Yoga sole layout; DOM paints Yoga boxes; hit-map = Yoga geometry
- Dirty = entity ∪ descendants; cousins independent
- Open settle: positive dt only for true open; selection = dt=0
- No invent parked pose; no Forest thrash on every dual-root tick
- **Park ≠ unmount** — off-canvas transform stays mounted under root; unmount only when entity leaves mount set

---

## Portable experience (PX) reminder (when dual-scene is in scope)

> **PX** = portable experience. **PE** = PointerEvents only ([SCENE_UI_COD.md](./SCENE_UI_COD.md)).

See [PORTABLE_EXPERIENCE_COD.md](./PORTABLE_EXPERIENCE_COD.md) · phases [SCENE_LAYERS_PLAN.md](./SCENE_LAYERS_PLAN.md):

- **PX is a second full scene** when loaded — **everything a scene can do**, **no parcel bounds**
- PX is **not** secondary (media/UI on); PX does **not** demote genesis parcel FocusOwner
- Layers → **claims** → one PlayerHost; freeze ≠ pin; free-flight = `layer_drive`
- UI: same Yoga COD under `#pe-ui-root` only — no dual layout invent
- Phys: namespaced late cook / invalidate-only ([STATIC_COLLIDER_COD.md](./STATIC_COLLIDER_COD.md))
- Kill PX-only hacks (`PeMainThreadMirror`, `runPeVehicleInputPump`) via A→E — do not merge old PX WIP

---

## One-liner for agents

> Read `docs/cod_prompt.md` on every evaluation. Ship AAA or iterate. Fan out, harsh critique, loop until wow.
