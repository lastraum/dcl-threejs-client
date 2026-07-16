# SyncEntities platform parity

**Branch:** `lastraum`  
**Status:** P0–P3 host path landed · soak optional · P4 auth adapter optional  
**Parity target:** Foundation Explorer behavior for SDK7 `@dcl/sdk/network` (`syncEntity`)

Flagtag / auth-server worlds are **conformance soaks**, not design drivers.

---

## 1. Goal

Any scene that does:

```ts
import { syncEntity, isStateSyncronized } from '@dcl/sdk/network'
// inside main():
syncEntity(entity, [Transform.componentId, …], entityEnumId?)
```

…must exchange networked CRDT with peers (and optional auth host) so late joiners catch up and runtime entities converge — without the client inventing game rules.

**Local UI is out of band.** SDK deliberately does **not** sync `UiTransform` / `UiText` / `UiBackground` / pointer results. Lobby HUD is local react-ecs; multiplayer only affects *when the scene chooses* to show it.

---

## 2. Stack (who owns what)

```text
Scene worker (@dcl/sdk/network — shipped in scene bundle)
  syncEntity → NetworkEntity + SyncComponents
  engine.addTransport(network filter)
  BinaryMessageBus: CRDT | REQ_CRDT_STATE | RES_CRDT_STATE
        │
        │  sendBinary({ data, peerData: [{ data, address }] })
        ▼
Client host (this repo)
  CommunicationsController.sendBinary
  LiveKit scene room (primary) / world room fallback
  CommsInboundQueue → response.data on next sendBinary
        │
        ▼
Worker transport.onmessage → engine CRDT apply
  → normal crdt-outbound / player-frame to main
```

| Layer | Owner | Client work |
|-------|--------|-------------|
| `syncEntity` / filter / `engineToCrdt` | SDK in scene | None (do not reimplement) |
| Identity (`userId` / `networkId`) | `UserIdentity` + profile | Ready before `main()` |
| Wire transport | Client | Correct room, directed peers, MTU |
| Catch-up REQ/RES | SDK + host | Who answers; one bulk apply |
| NetworkEntity remap | SDK worker + main projection | Worker apply + main decode |
| Auth host | Optional peer | Capability plug-in, not scene forks |

---

## 3. Wire contract (SDK BinaryMessageBus)

Crafted payload over LiveKit (inside RFC4 scene binary):

```text
[messageType: u8][payload…]
```

Types — **default / serverless** `@dcl/sdk`:

| Type | Name | Role |
|------|------|------|
| 1 | `CRDT` | Incremental component sync for `syncEntity` entities |
| 2 | `REQ_CRDT_STATE` | Joiner asks for full network state |
| 3 | `RES_CRDT_STATE` | Full/chunked state (often directed to joiner) |

Types — **authoritative server** `@dcl/sdk@auth-server` (Flagtag, etc.):

| Type | Name | Role |
|------|------|------|
| 4 | `CRDT_SERVER` | Server-originated CRDT |
| 5 | `CRDT_AUTHORITATIVE` | Authoritative CRDT channel |
| 6 | `CUSTOM_EVENT` | `registerMessages()` / room events |
| 7 | `CRDT` | Incremental (auth renumbered) |
| 8 | `REQ_CRDT_STATE` | Catch-up request |
| 9 | `RES_CRDT_STATE` | Catch-up response (~12KB chunks) |

Host **must not remap** type bytes. The scene bundle's SDK registers handlers for the enum it was built with. `?syncdebug` labels both maps.

Client must re-wrap inbound chunks for the worker as:

```text
[senderLen:u8][sender utf8][messageType:u8][payload…]
```

(`encodeCommsBinaryMessage` in `commsBinaryWire.ts`.)

**P0 fix:** inbound used to force `messageType = CRDT` and pass the whole crafted blob as payload, so REQ/RES never hit the right handlers. Unwrap first byte as type.

**P1:** `sendBinary(…, addresses)` maps to LiveKit `destinationIdentities` (wallet = participant identity). Empty addresses = room broadcast.

---

## 4. Design principles

1. **Transport only** — scene owns authority / freeze / lobby; client does not invent host policy.  
2. **Scene LiveKit room first** — sync CRDT is not island small-talk.  
3. **UI independent of sync** — local react-ecs must work with zero peers.  
4. **Worker applies network CRDT; main mirrors** — same as local CRDT.  
5. **Reserved entities never network** — SDK filters `entityId < RESERVED_STATIC_ENTITIES`.  
6. **Protocol tests, not production worlds** — minimal 2-peer scene before soak worlds.

---

## 5. Delivery phases

### P0 — Spec + host instrumentation (this PR track)

- [x] This document  
- [x] Correct inbound message-type unwrap  
- [x] `?syncdebug` logs: sendBinary direction, type histogram, bytes, peer targets  
- [x] Minimal local scene (`dev/sync-entities-scene`) — `syncEntity` + TweenSequence box (see §7)  
- [x] Two-client manual run (2026-07-15, `manaburner.dcl.eth`): **1 shared box**, click restart converges both windows  

### P1 — Transport completeness

- [x] Honor `peerData[].address` → LiveKit `destinationIdentities` (reliable when directed)  
- [x] Broadcast vs directed metrics (`?syncdebug` directed publish / fallback logs)  
- [x] LiveKit size / chunking parity with SDK `LIVEKIT_MAX_SIZE` (12KB crafted; skip+log oversized)  
- [x] Clear inbound queue on leave / scene dispose

### P2 — State catch-up

- [x] Host injects worker `RealmInfo.isConnectedSceneRoom` from LiveKit (RootEntity LWW)  
- [x] REQ on join path verified end-to-end (`?syncdebug` REQ/RES) — manaburner late-join  
- [x] Single successful RES bulk apply; no REQ storm (directed RES + CRDT stream)  
- [x] Late joiner sees existing network entities  
- [ ] Conformance HUD `isStateSyncronized() === true` after peers present (soft / scene flag)

### P3 — NetworkEntity graph on main

- [x] NetworkEntity / NetworkParent typed decode on projection  
- [x] Parent resolution for renderer (inject local parent into Transform)  
- [x] Registry: NetworkEntity **render**, SyncComponents path **supported**  

### P4 — Authority adapter (optional)

- [x] Wire-type labels for auth-server enum (4–9); transparent forward (no remap)  
- [ ] Prefer auth peer identity for RES / ownership heuristics (if ever needed)  
- [x] No scene-specific imports in client core  

### P5 — Conformance

- [ ] Minimal 2-peer automated or scripted test  
- [x] Soak note: Flagtag (auth-server) — see §11  

---

## 11. Flagtag / auth-server soak notes (2026-07-15)

Observed on Flagtag with `?syncdebug`:

| Log | Meaning |
|-----|---------|
| `inbound type=AUTH_RES_CRDT_STATE` (was `UNKNOWN_9`) from `authoritativ…` | Auth host full-state dump; ~12KB chunks = LIVEKIT budget |
| `outbound CUSTOM_EVENT` (was `UNKNOWN_6`) | Scene `registerMessages` / room events |
| `syncEntity failed because the id provided is already in use` | **Scene-side race**: auth RES already materialised `NetworkEntity{0, enumId}`; client later calls `syncEntity(..., enumId)` again. Docs say only **server** should `syncEntity` under auth-server. Host correctly applied RES first. Not a transport bug. |

**Client host responsibility:** deliver type 4–9 unchanged to the worker; size-cap oversized packets; directed LiveKit when addresses present; isolate scene system throws so lobby systems still run.

**Not host responsibility:** Flagtag calling `syncEntity` on the client after RES (scene should use `isServer()` guard or find-or-reuse).

### Flagtag UX checklist (player on ground / no UI / can’t move)

From soak logs (2026-07-15):

| Symptom | What logs show | Likely cause |
|---------|----------------|--------------|
| “On ground not tower” | `spawn … dcl=(383.9, **95.5**, 392.3)` then `feet=(383.9, 95.5, 392.3)` after colliders sealed | Client **does** spawn at tower height from `scene.json` Spawn Point 1. If you end up low, you fell after spawn (missing floor collider under feet) or expected a *different* tower after lobby join teleport. |
| No UI | `pointer ui snapshot — mount=0` (zero UiTransform) | Lobby react-ecs never painted. Often tied to scene boot systems aborting after `syncEntity … already in use` (post AUTH_RES), or UI gated until game state/messages that never complete. |
| Can’t move | VRM “locomotion active” ≠ walk allowed | Flagtag freezes avatar with **InputModifier** until lobby UI join. No UI ⇒ permanent freeze. Console: `locomotion blocked — disableAll=…` (throttled). |

Auth path itself is fine: `AUTH_REQ` → multi-chunk `AUTH_RES` → steady `AUTH_CRDT` + `CUSTOM_EVENT`.

---

## 6. Instrumentation (`?syncdebug`)

Enable: `?syncdebug` (or `localStorage.DEBUG_SYNC=1`).

Logs (console + debug panel category `sync`):

- Outbound: `sendBinary` broadcast vs directed, type counts, total KB, target addresses  
- Inbound: queue push type, sender, payload KB  
- Drain: messages returned to worker per call  

Silent by default (category not spammy when flag off).

---

## 7. Minimal conformance scene

Scaffold: [`dev/sync-entities-scene/`](../dev/sync-entities-scene/)

```bash
cd dev/sync-entities-scene
npm i
npm run build
# serve bin/ + scene.json as a local world, or deploy to a test world
```

Scene behavior:

1. Find-or-create shared box for `NetworkEntity{networkId:0, entityId:1}` (reuse peer/RES entity; never leave an orphan local mesh if `syncEntity` races)  
2. `syncEntity(box, [Transform, Tween, TweenSequence], 1)` when the enum is not already claimed  
3. Click restarts `TweenSequence` + `TL_RESTART`; peers should re-run the path  
4. UI label shows `isStateSyncronized()` + bound entity id  

**Dual-box on restart:** classic race is `engine.addEntity()` + mesh, then inbound CRDT also materialises enum `1` (or `syncEntity` throws before `NetworkEntity` attaches). Conformance scene dedupes to a single shared identity.

**Host (P2):** `RealmInfo` is now written on RootEntity from `CommsService.getRealmInfo()` (encoder + worker inject). Retest that `isStateSyncronized` flips true and REQ/RES appear under `?syncdebug`.

Success for P0 host: with two clients in the same world, `?syncdebug` shows CRDT traffic and types are not all forced to `1`. **Met** on manaburner two-window run.

---

## 8. Non-goals

- Reimplement `@dcl/sdk/network` on main  
- Sync Ui\* or PointerEventsResult  
- Client matchmaking / game rules  
- Flagtag lobby polish as platform acceptance  

---

## 9. Related code

| Path | Role |
|------|------|
| `src/network/CommsService.ts` | `sendBinary`, scene binary publish/receive |
| `src/network/comms/CommsInboundQueue.ts` | Queue until next `sendBinary` response |
| `src/network/comms/commsBinaryWire.ts` | Worker-facing envelope |
| `src/network/comms/syncDebug.ts` | `?syncdebug` helpers |
| `src/network/comms/livekitLimits.ts` | `LIVEKIT_MAX_SIZE` parity (12KB) |
| `src/bridge/CrdtProjection.ts` | NetworkEntity/Parent decode + parent rebind |
| `src/core/World.ts` | `handleSendBinary` |
| `node_modules/@dcl/sdk/network/*` | Scene-side protocol (reference only) |
| `docs/INTEGRATION.md` | Checklist row for NetworkEntity / SyncComponents |

---

## 10. Success criteria (platform)

1. Two clients, minimal `syncEntity` scene: transform converges both ways  
2. Late joiner: REQ → RES → `isStateSyncronized() === true` without spam  
3. Leave/rejoin: no duplicate network entities / reserved-id corruption  
4. INTEGRATION registry updated when P3 lands  
5. Local UI still works with zero peers  
