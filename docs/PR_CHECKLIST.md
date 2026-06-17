# Pull Request Checklist

Use this before requesting review. Copy relevant items into your PR description.

## Task linkage

- [ ] PR references a task `id` from [TASKS.yaml](./TASKS.yaml)
- [ ] [TASKS.yaml](./TASKS.yaml) updated (`owner`, `status`, notes if scope changed)
- [ ] If closing a task: `status: done` and acceptance criteria met

## Scope & architecture

- [ ] Diff stays within task `files` list (or TASKS.yaml updated with new paths + rationale)
- [ ] Did **not** refactor frozen shim/worker unless task explicitly allows it
- [ ] Did **not** introduce pub/sub bus — CRDT or RPC only
- [ ] DCL↔Three transform conversion stays at render boundary (`dclTransform.ts`)
- [ ] Re-arch tasks: no new dependencies on `CrdtMirror.Engine()` if task goal is projection-only reads

## Comms & social (if touched)

- [ ] LiveKit text chat uses `encodeRfc4ChatPacket` (`src/social/dclRfc4Chat.ts`)
- [ ] Chat UI timestamps use `Date.now() / 1000` locally (not wire timestamp for display)
- [ ] Movement/profile outbound matches RFC4 protocol version in existing comms modules

## Build & test

- [ ] `npm run build` exits 0 (`tsc && vite build`)
- [ ] Manual smoke: `npm run dev` — load Genesis Plaza, task `test_scenes`, and/or **your deployed world** ([CONTRIBUTOR_TESTING.md](./CONTRIBUTOR_TESTING.md))
- [ ] No new console errors in category relevant to change (check debug log panel)
- [ ] If input/pointer: click + hover + key actions on at least one interactive entity

## UI & docs

- [ ] User-facing strings match Explorer tone (concise, no debug jargon in HUD)
- [ ] [PROGRESS.md](./PROGRESS.md) updated if shipping a milestone (maintainer or with maintainer ack)
- [ ] New env vars or deploy steps documented in [DEPLOYMENT.md](./DEPLOYMENT.md)

## Security & hygiene

- [ ] No secrets, private keys, or `.env` values committed
- [ ] `SignedFetch` / wallet flows unchanged unless task requires it
- [ ] Dependencies added only when necessary; note why in PR body

## Reviewer notes

- [ ] Screenshots or short screen recording for visual changes
- [ ] Known gaps called out explicitly (partial tasks → `status: partial` in TASKS.yaml)
