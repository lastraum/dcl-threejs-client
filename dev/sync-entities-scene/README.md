# SyncEntities conformance scene

Minimal SDK7 scene for **platform** multiplayer ECS parity — not Flagtag-specific.

Platform multiplayer ECS (`syncEntity`) — status in docs/INTEGRATION.md.

## Build

Entry is **`src/index.ts` only** (Creator Hub / `sdk-commands` does not take JSX in `.ts`). UI uses `ReactEcs.createElement`, not JSX.

```bash
cd dev/sync-entities-scene
npm i
npm run build
```

## Run (two clients)

1. Deploy or preview this scene as a world (two browser sessions, same realm).
2. Open the client with `?syncdebug` on both.
3. Click the cyan box — it should bounce Y on **both** clients.
4. Console should show `[sync] sendBinary out` / `inbound` with `CRDT` (and `REQ_CRDT_STATE` / `RES_CRDT_STATE` on join).

## Expected host logs (`?syncdebug`)

```
[sync] sendBinary out — broadcast=N (CRDT=…) …
[sync] inbound — type=CRDT from=0x… payload=…B
[sync] drain → worker — msgs=…
```

If you only ever see `type=CRDT` for join traffic that should be REQ/RES, file a host wire bug (P0 unwrap should already map first byte).

Directed RES still room-broadcasts until P1 (`destinationIdentities`).
