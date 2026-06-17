# Contributing to ThreejsClient

Thanks for helping build a browser-native Decentraland Explorer. There is **no maintainer-curated task backlog** — you pick work from the **parity gap matrix** and announce it yourself.

## Quick start

1. Read [docs/AGENTS.md](docs/AGENTS.md) — architecture boundaries and reading order
2. Open the client dev panel (`</>`) → **Community** tab — see parity gaps and who is already working on what
3. Open a **[Task claim](https://github.com/lastraum/dcl-threejs-client/issues/new?template=task.yml)** issue with the integration ref (e.g. `ecs:Raycast`)
4. Get the **`in-progress`** label on your issue (ask in the issue or add it if you have triage access) — syncs to `docs/CLAIMS.yaml` and the dev panel
5. Branch from `dev-latest`, implement, open PR **into `dev-latest`** — link the issue; follow [docs/PR_CHECKLIST.md](docs/PR_CHECKLIST.md)

### Branches (contributor vs maintainer)

| Branch | Role |
| ------ | ---- |
| **`dev-latest`** | Integration + QA — **open your PR here** |
| **`main`** | Stable / release — maintainer promotes from `dev-latest` after QA |
| **`feat/…`** | Your short-lived task branch |

```text
dev-latest          ← community PRs land here (QA soak)
  └── feat/<task>
main                ← maintainer PR: dev-latest → main when ready to ship
```

Do not open contributor PRs directly into `main` unless a maintainer asks you to.

## What each source means

| Source | Purpose |
| ------ | ------- |
| **Integration registry** (`integrationRegistry.ts`, dev panel) | Master parity matrix — what's done vs gaps |
| **PROGRESS.md** | Shipped milestones and narrative history |
| **CLAIMS.yaml** | Who is working on what (auto-synced from `in-progress` GitHub issues) |
| **TASKS.yaml** | Legacy re-arch history only — not a pick-up queue |

## Development

```bash
npm install
npm run dev        # Vite dev server
npm run build      # tsc + vite production build (prebuild refreshes offline doc fallbacks)
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

Include your world URL in PR descriptions when it exercises your claim.

## Finishing work

1. Update status in `src/dcl/ecs/registry.ts` and/or `integrationRegistry.ts`
2. Add a short note to [docs/PROGRESS.md](docs/PROGRESS.md) when shipping a milestone
3. Close your claim issue (removes entry from `CLAIMS.yaml` on next sync)

## AI agents

Use [docs/AGENTS.md](docs/AGENTS.md) as the onboarding pack. Read `integrationRegistry.ts` for gaps; check [CLAIMS.yaml](docs/CLAIMS.yaml) and [in-progress issues](https://github.com/lastraum/dcl-threejs-client/issues?q=is%3Aopen+label%3Ain-progress) before claiming.

## Code of conduct

Be constructive in review. Match existing code style — minimal diffs, no drive-by refactors.

## Questions

Open a GitHub issue using the **Task claim** template with intent **Question / blocked**.