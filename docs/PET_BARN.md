# Pet Barn

Open marketplace for community pet GLBs, hosted on Decentraland Worlds (`petbarn.dcl.eth`) with a public catalog on GitHub.

## Repos

| Path | Role |
|---|---|
| `sdk7/petbarn` ([lastraum/petbarn](https://github.com/lastraum/petbarn)) | `catalog.json`, queue, multi-scene deploy Action |
| `sdk7/ThreejsClient` | Shop UI, publish Worker source, local Add/cache |

## Product rules

- **1 pet = 1 multi-scene parcel** on `petbarn.dcl.eth`
- GLB ≤ **2 MB**, thumbnail ≤ **500 KB** (client compresses before upload)
- **Anyone can publish** (auto-deploy via GitHub Action)
- Shop loads **catalog + thumbnails only**; GLB downloads on **Add**
- Local map of added barn ids: `localStorage` key `dcl-client-petbarn-added`

## Client flow

1. **Pets** sidebar → **Barn**
2. **Shop** tab polls  
   `https://raw.githubusercontent.com/lastraum/petbarn/main/catalog.json`
3. Cards use `contentBaseUrl + thumbnailCid` (`loading="lazy"`)
4. **Add** → fetch `glbCid` → `PetLibrary` + inventory + added map
5. **Publish** → compress thumb → POST CF Worker → queue on petbarn repo → Action deploys → catalog update

## Cloudflare Worker

Source: `workers/petbarn-dispatch.js`

1. Create Worker (e.g. `dcl-petbarn-dispatch`)
2. Paste script, Deploy
3. Secret: `PETBARN_GITHUB_TOKEN` — fine-grained PAT:
   - Resource: `lastraum/petbarn` only
   - Permissions: **Contents** Read/Write, **Issues** Read/Write (audit issues)
4. Optional vars: `PETBARN_REPO`, `PETBARN_BRANCH`
5. Default client URL: `https://dcl-petbarn-dispatch.lastraum.workers.dev`  
   Override: `VITE_PETBARN_DISPATCH_URL`

## GitHub Actions (`petbarn` repo)

Secret: `DCL_PRIVATE_KEY` — operator wallet that can deploy to `petbarn.dcl.eth`.

Workflow: `.github/workflows/deploy-pet.yml` on `pets/queue/**`.

## Kill switches

1. Disable Worker (stops new publishes)
2. Disable `Deploy Pet Barn queue` workflow
3. Revoke `DCL_PRIVATE_KEY` / PAT

## Env (client)

| Variable | Purpose |
|---|---|
| `VITE_PETBARN_CATALOG_URL` | Catalog JSON URL |
| `VITE_PETBARN_DISPATCH_URL` | Worker URL (`0` / `false` to disable publish) |

## Manual smoke

```bash
# petbarn repo
cp your.glb pets/queue/test-001/pet.glb
cp your.webp pets/queue/test-001/thumb.webp
# write meta.json — see petbarn README
git add pets/queue/test-001 && git commit -m "test queue" && git push
# wait for Action; check catalog.json
```
