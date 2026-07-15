# SyncEntities platform parity

**Branch:** `lastraum`  
**Status:** P0 — architecture + host instrumentation (not scene-specific)  
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

Types:

| Type | Name | Role |
|------|------|------|
| 1 | `CRDT` | Incremental component sync for `syncEntity` entities |
| 2 | `REQ_CRDT_STATE` | Joiner asks for full network state |
| 3 | `RES_CRDT_STATE` | Full/chunked state (often directed to joiner) |

Client must re-wrap inbound chunks for the worker as:

```text
[senderLen:u8][sender utf8][messageType:u8][payload…]
```

(`encodeCommsBinaryMessage` in `commsBinaryWire.ts`.)

**P0 fix:** inbound used to force `messageType = CRDT` and pass the whole crafted blob as payload, so REQ/RES never hit the right handlers. Unwrap first byte as type.

**Known gap (P1):** `CommsService.sendBinary` currently ignores `addresses` (`void addresses`). Directed RES to a single joiner is not participant-targeted on LiveKit yet.

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
- [x] Minimal scene scaffold (`~/Desktop/dcl scenes/sync-entities-scene`) — TweenSequence + restart  
- [ ] Two-client manual run (deploy to a world + `?syncdebug`)

### P1 — Transport completeness

- [ ] Honor `peerData[].address` (LiveKit `destinationIdentities` or equivalent)  
- [ ] Broadcast vs directed metrics  
- [ ] LiveKit size / chunking parity with SDK `LIVEKIT_MAX_SIZE`  
- [ ] Clear inbound queue on leave / scene dispose  

### P2 — State catch-up

- [ ] REQ on join path verified end-to-end  
- [ ] Single successful RES bulk apply; no REQ storm  
- [ ] Late joiner sees existing network entities  

### P3 — NetworkEntity graph on main

- [ ] NetworkEntity / NetworkParent projection beyond stub  
- [ ] Parent resolution for renderer  
- [ ] Registry: NetworkEntity **render**, SyncComponents path **supported**  

### P4 — Authority adapter (optional)

- [ ] If peer identity matches auth-host convention, prefer for RES / ownership  
- [ ] No scene-specific imports in client core  

### P5 — Conformance

- [ ] Minimal 2-peer automated or scripted test  
- [ ] Optional soak: Flagtag / Colyseus worlds  

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

**Outside the client repo** (deploy to a World — no in-client local multipath):

`~/Desktop/dcl scenes/sync-entities-scene/`

```bash
cd ~/Desktop/dcl\ scenes/sync-entities-scene
npm i && npm run build
npx sdk-commands deploy --target-content yourname.dcl.eth
# client: http://localhost:5173/yourname.dcl.eth?syncdebug  (two tabs/peers)
```

Scene behavior:

1. `main()` → bouncing box via `Tween` + `TweenSequence` (`loop: TL_RESTART`)  
2. `syncEntity(box, [Transform, Tween, TweenSequence], 1)` (shared enum id)  
3. Click restarts the tween sequence (peers should restart after CRDT)  
4. UI label shows `isStateSyncronized()`  

Success for P0 host: with two clients in the same world, `?syncdebug` shows CRDT traffic and types are not all forced to `1`; box bounce / restart is visible on both.

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
