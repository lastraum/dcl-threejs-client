# Contributing to ThreejsClient

Thanks for helping build a browser-native Decentraland Explorer. This repo uses a **task registry** so humans and AI agents can pick up work without duplicating effort.

## Quick start

1. Read [docs/AGENTS.md](docs/AGENTS.md) — architecture boundaries and reading order
2. Browse [docs/TASKS.yaml](docs/TASKS.yaml) — find an `open` task (skip `maintainer_only: true` unless coordinated)
3. Claim it (see below), branch, implement, open PR

## Claim a task

1. **Reserve** — edit `docs/TASKS.yaml`:
   - Set `owner` to your GitHub handle
   - Set `status: in_progress`
2. **Branch** — `git checkout -b feat/<task-id>-short-description`
3. **Implement** — stay within `files` listed on the task; follow [docs/PR_CHECKLIST.md](docs/PR_CHECKLIST.md)
4. **PR** — template auto-links checklist; include task `id` in title or body
5. **Merge** — maintainer sets `status: done` (or `partial`) when acceptance criteria pass

Prefer opening a draft PR early if scope is uncertain.

## Development

```bash
npm install
npm run dev        # Vite dev server
npm run build      # tsc + vite production build (runs prebuild sync)
npm run preview    # serve dist/
```

See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for production hosting and smoke tests.

## Test with your own world (recommended)

Contributors should maintain a **small SDK7 scene** deployed to a **personal `.dcl.eth` world** — not only Genesis Plaza or RickRoll. World deploys are **available immediately** on worlds-content-server; reload `/yourname.dcl.eth` in the client to pick up the latest bundle.

**Guide:** [docs/CONTRIBUTOR_TESTING.md](docs/CONTRIBUTOR_TESTING.md) — setup, `dcl deploy --target-content`, URLs, PR test matrix.

Quick loop:

```bash
# Scene repo
dcl deploy --target-content yourname.dcl.eth

# This client
npm run dev   # → http://localhost:5173/yourname.dcl.eth?guest
```

Include your world URL in PR descriptions when it exercises the task.

## Task registry rules

| Field | Purpose |
| ----- | ------- |
| `id` | Stable slug — reference in branches/PRs |
| `status` | `open` · `in_progress` · `partial` · `done` · `blocked` |
| `maintainer_only` | Needs maintainer review / re-arch gate |
| `do_not_touch` | Paths that must not change for this task |
| `acceptance_criteria` | Definition of done |

Add new tasks via PR with maintainer review — keep total backlog focused (15–30 active items).

## AI agents

Use [docs/AGENTS.md](docs/AGENTS.md) as the onboarding pack. Fetch live backlog from GitHub raw `docs/TASKS.yaml` or read the file in-repo.

## Code of conduct

Be constructive in review. Match existing code style — minimal diffs, no drive-by refactors.

## Questions

Open a GitHub issue using the **Task claim** template, or comment on an existing task PR.
