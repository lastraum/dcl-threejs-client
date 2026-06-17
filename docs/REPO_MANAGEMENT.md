# Repo Management & Public Transition Runbook

> Maintainer runbook for ThreejsClient — branch strategy, release cut, and DCL community handoff.  
> **Snapshot:** 2026-06-16 · active branch `redo/threejs-projection-arch` @ `a0fd4fc`

---

## Current state

| Branch | Tip | Role |
|--------|-----|------|
| `main` | `b9d5bb3` | Pre-re-arch stable (auth, asset cache, hydration timeout) |
| `redo/threejs-projection-arch` | `a0fd4fc` | Active re-arch + e6/e7 pushless WIP + community docs |

**`main` is 7 commits behind `redo/threejs-projection-arch`:**

```
a0fd4fc Fix pushless pointer log spam and duplicate CRDT merge
6975c2d docs: community task registry + AGENTS/CONTRIBUTING; fetch TASKS.yaml in dev panel
f654859 fix(arch): e7 pushless — stash pointer CRDT synchronously + fix empty nudge RPC
f54a1f1 fix(arch): e7 pushless — merge mirror pointer CRDT when encoder omits appends
a185b6c feat(arch): e7 pushless pointer mode (acceptance-gate flag)
769a92d feat(arch+physics): e6 boot-snapshot parity oracle + PhysX fixes
eb77819 feat(arch): complete Phase 3 — CrdtProjection + CrdtEncoder + ProjectionView defaults
```

Diff vs `main`: ~78 files, +7174 / −910 lines. `package.json` is `0.1.99`, `"private": true`. Community scaffolding (`TASKS.yaml`, CONTRIBUTING, AGENTS, PR templates) lives on `redo`, not yet on `main`.

**Re-arch gate (TASKS.yaml):** e7 `in_progress` → e8/e9 `blocked` → e10 `open`. See [REARCHITECTURE_PLAN.md](./REARCHITECTURE_PLAN.md) and [TASKS.yaml](./TASKS.yaml).

---

## Branch strategy

### Target model: `main`-only (no permanent `develop`)

```
main                              ← stable / release / community default
  └── feat/<task-id>-short-desc   ← short-lived PR branches
  └── fix/<issue>-short-desc
```

Git Flow `develop` adds overhead for a solo/small team. One integration branch is enough.

### During re-arch (now → e10 merge)

Keep **`redo/threejs-projection-arch`** as the long-running integration branch. Do **not** merge half-finished pushless machinery to `main`.

1. Finish **e7** acceptance (Genesis Plaza + `pizzaparty.dcl.eth` Trigger scenes).
2. Land **e8 → e9 → e10** as sequential PRs into `redo` (maintainer-only gates).
3. One final PR: `redo/threejs-projection-arch` → `main`.
4. Delete `redo/threejs-projection-arch` locally and on origin after merge.
5. Tag `main`.

### After public cut

- All community work branches from `main`.
- Protect `main` with required PR + CI (`npm run build` minimum).
- Re-arch tasks with `maintainer_only: true` stay maintainer-gated until e10 completes; then open suitable tasks to community.

### Do not

- Leave `redo/threejs-projection-arch` as the default branch on the public repo.
- Maintain parallel `develop` and `main` with duplicate `TASKS.yaml` edits.

---

## Release tagging

| Tag | When | `package.json` | Notes |
|-----|------|----------------|-------|
| `v0.1.0` | Optional now | `0.1.x` | Tag current `main` as pre-re-arch baseline |
| **`v0.2.0`** | **Public cut** | `0.2.0` | Re-arch Phase 3 gate complete (e10 merged) |
| `v0.3.0+` | Feature milestones | bump minor | TriggerArea, voice, parcel routing, etc. |
| `v1.0.0` | Production-ready | `1.0.0` | DEPLOYMENT checklist fully green |

**Mechanics:**

1. Stop auto patch-bump on every `npm run build` before public releases — bump only via intentional `npm version` + git tag.
2. Reset `0.1.99` dev churn to **`0.2.0`** at public cut (not `0.1.100`).
3. GitHub Releases from tags: link [DEPLOYMENT.md](./DEPLOYMENT.md) smoke tests, scene URLs (`/rickroll.dcl.eth`, Genesis Plaza).
4. Dev panel version (`appVersion.ts`) should match git tags.

---

## Pre-public checklist

### A. Secrets & config hygiene

- [ ] Add `.env.example` (all `VITE_*` from DEPLOYMENT.md)
- [ ] Expand `.gitignore`: `.env`, `.env.local`, `.env.*.local`, `*.pem`, `credentials.json`
- [ ] Grep for `lastraum`, `LastSlice`, absolute local paths in docs
- [ ] Confirm no wallet mnemonics / test private keys (scan clean as of 2026-06-16)
- [ ] Review `scripts/bundle-base-wearables.mjs` — public Catalyst only ✓

### B. Doc consolidation

| Concern | Source of truth | Action |
|---------|-----------------|--------|
| Active backlog | `docs/TASKS.yaml` | Keep; trim to 15–30 active items |
| Shipped history | `docs/PROGRESS.md` | Add e7–e10 milestones as they land |
| Re-arch architecture | `docs/REARCHITECTURE_PLAN.md` | Update §0 → Phase 3 shipped; e7–e10 in progress |
| Phase 3 milestone | `docs/PHASE3_COMPLETION.md` | Keep as historical reference |
| Old phase roadmap | `docs/IMPLEMENTATION_PLAN.md` | Archive banner: superseded by TASKS.yaml + REARCHITECTURE_PLAN |
| Agent onboarding | `docs/AGENTS.md` | Update GitHub URL + default branch to `main` |
| Deploy | `docs/DEPLOYMENT.md` | Keep |

**Do not port:** `feat/phase3-complete` scratch doc (`REARCH_SDK7_MAINENTRY_GLBS_STATUS.md`) unless still valuable.

### C. Code/config for public community

- [ ] `tasksRegistry.ts`: public org/repo + `DEFAULT_BRANCH = 'main'` (see below)
- [ ] `package.json`: `"private": false`
- [ ] Add `LICENSE` (MIT or Apache-2.0)
- [ ] GitHub: Issues on, PR template, branch protection on `main`
- [ ] `.cursor/rules/comms-architecture.mdc` — safe to ship (no secrets)

### D. Finish in-flight work first

Public cut starts from a clean, pushed `main` after e7–e10 merge and doc pass.

---

## Option B — fresh public repo (recommended)

**Why Option B over rename-in-place (A):** clean first impression; sheds experiment branches and internal doc refs. **Why not monorepo (C):** self-contained Vite SPA; live test scenes on Catalyst.

Keep the private repo archived as read-only history.

### Phase 1 — Finish in private repo

1. Complete e7 → e10 on `redo/threejs-projection-arch`.
2. Merge `redo` → `main`; run full DEPLOYMENT smoke checklist.
3. Doc pass (§ above) on `main`.
4. Optional: tag private `main` as `v0.2.0-rc1`.

### Phase 2 — Create public repo

5. Create e.g. `decentraland/threejs-explorer` (org TBD).
6. Export clean tree:

```bash
git checkout main
git archive main | tar -x -C /tmp/threejs-public-export
cd /tmp/threejs-public-export
git init && git add -A && git commit -m "Initial public release: Three.js DCL SDK7 Explorer v0.2.0"
git remote add origin git@github.com:<org>/<repo>.git
git push -u origin main
git tag v0.2.0 && git push origin v0.2.0
```

7. GitHub Release for `v0.2.0` with test plan from DEPLOYMENT.md.

### Phase 3 — Rewire & archive

8. Update `tasksRegistry.ts` + `AGENTS.md` in **public repo** before announcing.
9. Archive private `LastSlice/.../ThreejsClient` with README pointer to public URL.
10. Point local `origin` at public repo; optional `private` remote for archive.

### Phase 4 — Announce

11. DCL Discord / forum: README, CONTRIBUTING, TASKS.yaml claim flow, good first issues from open non-`maintainer_only` tasks.

---

## `tasksRegistry.ts` URL rewire

Dev panel fetches live backlog from GitHub raw YAML. **Must change at public cut** — in the public repo, not before e10 merge on private `redo`.

```typescript
// src/client/dev/tasksRegistry.ts — today:
const GITHUB_RAW = 'https://raw.githubusercontent.com/lastraum/ThreejsClient'
const DEFAULT_BRANCH = 'redo/threejs-projection-arch'

// → after public cut:
const GITHUB_RAW = 'https://raw.githubusercontent.com/<org>/<public-repo>'
const DEFAULT_BRANCH = 'main'
```

Also update the example URL in [AGENTS.md](./AGENTS.md). Offline fallback: `tasksFallback.ts` (regenerated by `npm run prebuild`). Testing overrides: `?tasksBranch=feat/my-branch` or `localStorage.tasksBranch`.

---

## Delete stale branches

Verify nothing unique, then delete in this order:

| Branch | Notes |
|--------|-------|
| `feat/phase3-complete` | Stale — 1 unique commit (`ecbbaeb` scratch doc); redo superseded |
| `backup/grok-phase4` | Local only — safe after confirming no unique commits |
| `rearch/phase3-clean` | Local only — safe after confirming no unique commits |
| `origin/cursor/wearable-asset-cache-ac1f` | Merged PR — delete after confirm |
| `origin/cursor/world-dispose-glb-cache-ac1f` | Merged PR — delete after confirm |
| `origin/feat/phase3-complete` | Remote stale — delete |
| `origin/redo/threejs-projection-arch` | Delete **after** merge to `main` |

Optional archaeology tag: `v0.1.0-pre-rearch` on `main` @ `b9d5bb3` before re-arch merge.

---

## Community workflow (post-public)

```
docs/TASKS.yaml (main) → claim (owner + in_progress) → feat/<task-id> → PR + PR_CHECKLIST → merge → status: done
                                    ↓
                         dev panel fetches raw YAML at runtime
```

1. Pick `open` task in [TASKS.yaml](./TASKS.yaml) (skip `maintainer_only: true` unless coordinated).
2. PR sets `owner` + `status: in_progress` (claim in same PR as work, or tiny claim PR first).
3. Implement within listed `files`; follow [PR_CHECKLIST.md](./PR_CHECKLIST.md).
4. Maintainer sets `status: done` on merge.

**Maintainer gates:** e7–e9 stay `maintainer_only: true` until re-arch closes. After e10, open tasks like `trigger-area-volume`, `raycast-scene-api`, `pet-proximity-pointer`.

**PR hygiene:** task `id` in title/body; update TASKS.yaml on merge; keep backlog at 15–30 active items.

See [CONTRIBUTING.md](../CONTRIBUTING.md) for dev setup and claim rules.

---

## Secrets scan results (2026-06-16)

**Clean:** no `.env` files committed, no API keys or private keys in tree. Auth is client-side MetaMask; LiveKit tokens arrive at runtime via realm `connection_string`.

**Public-safe defaults:**

- Catalyst: `https://peer-ec2.decentraland.org`
- Optional `VITE_*` overrides in `mapConfig.ts`, `socialApi.ts` (documented in DEPLOYMENT.md)

**Must fix before public:** GitHub raw URL + default branch in `tasksRegistry.ts` and AGENTS.md; `"private": true` in package.json; `.env.example`; expanded `.gitignore`; remove LastSlice sibling paths from IMPLEMENTATION_PLAN.md; decouple auto semver bump from every `prebuild`.

| Stays private / archived | Goes public |
|--------------------------|-------------|
| Full git history with experiment branches | Squashed `main` from v0.2.0 forward |
| LastSlice monorepo layout | Client source, public DCL endpoints |
| Personal fork naming (`lastraum/ThreejsClient`) | Chosen org repo name |
| Future Catalyst write keys (none today) | Wallet connect (client-side only) |

---

## Timeline P0–P4

| Phase | Estimate | Branch | Deliverable |
|-------|----------|--------|-------------|
| **P0 — Finish re-arch gate** | 1–3 weeks | `redo/threejs-projection-arch` | e7 acceptance → e8 delete push channel → e9 drop mirror Engine → e10 perf |
| **P1 — Integrate to main** | 2–3 days | PR `redo` → `main` | Green build, DEPLOYMENT smoke, TASKS.yaml e6–e10 marked done |
| **P2 — Doc & cleanup pass** | 3–5 days | `main` | Doc consolidation, `.env.example`, branch deletion, semver reset to `0.2.0` |
| **P3 — Public cut** | 1 day | new public repo | Squash export, tag `v0.2.0`, GitHub Release, archive private |
| **P4 — Community bootstrap** | ongoing | `main` + `feat/*` | Triage first external PRs; 5–10 well-scoped `open` tasks |

### Immediate next actions

1. **e7:** Validate pushless pointer on Trigger-heavy scenes; mark `rearch-e7-pointer-same-tick` done when acceptance criteria pass.
2. **Do not** merge to `main` until e7 gate passes (e8 depends on it).
3. Delete `feat/phase3-complete` after confirming `ecbbaeb` doc isn't needed.

### Post-e10 before public

1. Update REARCHITECTURE_PLAN.md status header.
2. Archive banner on IMPLEMENTATION_PLAN.md.
3. Rewire `tasksRegistry.ts` + AGENTS.md in public repo.
4. Tag `v0.2.0`, execute Option B export.

---

## Related docs

- [TASKS.yaml](./TASKS.yaml) — active backlog
- [AGENTS.md](./AGENTS.md) — AI/human onboarding
- [CONTRIBUTING.md](../CONTRIBUTING.md) — claim flow
- [PR_CHECKLIST.md](./PR_CHECKLIST.md) — merge gates
- [DEPLOYMENT.md](./DEPLOYMENT.md) — smoke test checklist
- [REARCHITECTURE_PLAN.md](./REARCHITECTURE_PLAN.md) — re-arch scope
