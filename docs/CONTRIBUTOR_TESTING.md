# Contributor testing — deploy your own scene to a World

> **Recommended for all contributors:** build a **small SDK7 scene**, deploy it to **your own `.dcl.eth` world**, and use that URL to test client changes. Deployments go **live immediately** on the worlds content server — no long catalyst propagation wait.

---

## Why your own world?

| Approach | Pros | Cons |
| -------- | ---- | ---- |
| **Genesis Plaza / RickRoll only** | Realistic stress test | Hard to isolate your feature; noisy; slow to navigate |
| **Your own world + minimal scene** | Fast iteration; you control PointerEvents, GLTFs, triggers | Requires one-time world + deploy setup |
| **Local `npm run dev` only** | Fastest edit loop | Misses deploy manifest, comms, and content-server paths |

For PRs, mention **both**: smoke on a shared reference scene (Genesis or RickRoll) **and** your test world if the task is scene-specific.

---

## One-time setup

1. **SDK7 CLI** — [Decentraland Creator Hub / SDK7 docs](https://docs.decentraland.org/creator/) — install `@dcl/sdk` tooling (`npm i -g @dcl/sdk` or use project-local CLI).
2. **A World** — a `.dcl.eth` name you control (Decentraland Worlds). You need deploy rights on that world.
3. **Blank or minimal scene** — start from `dcl init` or the [`blank-scene`](https://github.com/decentraland/sdk7-goerli-plaza/tree/main/Blank) template; keep **1×1** or small footprint for fast loads.

Example minimal scene goals:

- One cube with `PointerEvents` (click/hover test)
- One `GltfContainer` prop (collider / attach test)
- Optional `triggerSceneEmote` or `movePlayerTo` for API tests

---

## Deploy to your world (live immediately)

From your scene project directory:

```bash
# Build + publish scene bundle to your world’s content target
npm run build
dcl deploy --target-content yourname.dcl.eth
```

Use the exact deploy flags your SDK7 project documents (`package.json` scripts often wrap `dcl deploy`). After a **successful** deploy:

- The new entity is served by **worlds-content-server** for `yourname.dcl.eth`
- **No extended wait** — refresh the client at `/yourname.dcl.eth` to load the latest deployment
- If you still see old content: hard refresh, or confirm deploy stdout shows success and the correct world name

### Load in ThreejsClient

```text
http://localhost:5173/yourname.dcl.eth
```

Production / preview:

```text
https://your-host.example/yourname.dcl.eth
```

Guest dev login (no wallet): append `?guest` or `?skipLogin`.

To test **without** deploying: start Explorer Play (Bevy), then swap the host to this client — **[README → Local preview](../README.md#local-preview)**.

---

## Parcel deploys (Genesis grid)

Deploying to **land parcels** (`dcl deploy` to catalyst) can work but often involves **realm indexing delay** compared to worlds. For **fastest “did my scene ship?” feedback**, prefer **world deploy** during client development.

Parcel URLs: `/80,-1` style routes — see [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md) routing section.

---

## Suggested test matrix for PRs

| Layer | Minimum | Better |
| ----- | ------- | ------ |
| **Build** | `npm run build` | — |
| **Reference scene** | Genesis Plaza **or** `/rickroll.dcl.eth` | Task `test_scenes` in TASKS.yaml |
| **Your scene** | — | `/yourname.dcl.eth` exercising the task feature |
| **Multiplayer** | Two tabs, same world, wallet or guest rules | + scene chat / emote if comms task |
| **Platform movers** | Stand on parent-driven MeshCollider bob; walk off elevated → freefall | `?platformdebug` · no multi-meter loft ([RIDING_TRANSFER_LAW.md](./RIDING_TRANSFER_LAW.md)) |
| **Lighting** | Genesis midday Reset lighting — not chalk white; neon not bloom-blown | Side-by-side Explorer |
| **Scene HTTP** | Any SignedFetch third-party URL via `/api/scene-http/...` | Prod nginx smoke curl (see [DEPLOYMENT.md](./DEPLOYMENT.md)) |
| **TextShape** | Long HUD label without mid-string clip when width omitted | — |
| **2D social chat** | Explore shell logged in | FAB open/close restores thread; leave landing → × on scene tab; empty idle text centered |
| **Elevated spawn** | Tower scene (e.g. Flagtag) | On deck after load; no drown UI during boot; no long hover |
| **Nearby voice** | Two tabs: Speak / hold **T**, hear peer | Browser + Explorer on **world** and **Genesis parcel**; Jump In keeps LiveKit (`handoff OK`) |

Document in the PR which URLs you used.

---

## Related

- [INTEGRATION.md](./INTEGRATION.md) — what is implemented vs not
- [TASKS.yaml](./TASKS.yaml) — `test_scenes` per task
- [DEPLOYMENT.md](./DEPLOYMENT.md) — hosting the **client** SPA (not scene deploy)
- [PR_CHECKLIST.md](./PR_CHECKLIST.md) — pre-review checks
