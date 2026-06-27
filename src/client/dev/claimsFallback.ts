/** Auto-generated from docs/CLAIMS.yaml by scripts/sync-dev-progress.mjs — do not edit manually. */

import type { ClaimsRegistry } from './claimsRegistry'

export const CLAIMS_FALLBACK: ClaimsRegistry = {
  "schema_version": 2,
  "updated": "2026-06-22",
  "source": "github",
  "base_branch": "dev-latest",
  "workflow": [
    {
      "stage": "merged",
      "integration_ref": "perf:low-end-scene-worker",
      "title": "Low-end scene worker timing + Genesis sky dome fix",
      "owner": "lastraum",
      "updated": "2026-06-22",
      "notes": "43aad5c — tier detection, adaptive abort, camera-centered skydome"
    },
    {
      "stage": "merged",
      "integration_ref": "net:dcm-chat-media",
      "title": "DCM v1 inline chat images (drag-drop, GIF, < 1 MiB)",
      "owner": "lastraum",
      "updated": "2026-06-22",
      "notes": "e19a32e"
    },
    {
      "stage": "merged",
      "integration_ref": "env:fft-ocean",
      "title": "Landscapes, FFT ocean, and Perlin scatter environments",
      "owner": "lastraum",
      "updated": "2026-06-22",
      "notes": "50c6021"
    },
    {
      "stage": "merged",
      "integration_ref": "perf:boot-hydration",
      "title": "Boot + hydration pipeline (main.crdt, composite preload, unified GLB)",
      "owner": "lastraum",
      "updated": "2026-06-22"
    },
    {
      "stage": "merged",
      "integration_ref": "ui:profile-pill",
      "title": "Profile pills, badges, settings shell (Events/Places/Gallery)",
      "owner": "lastraum",
      "updated": "2026-06-22"
    },
    {
      "stage": "merged",
      "integration_ref": "ecs:ParticleSystem",
      "title": "Render bridges — Billboard, Animator, ParticleSystem, VideoPlayer, Audio",
      "owner": "lastraum",
      "updated": "2026-06-22",
      "notes": "Media + sprite paths on dev-latest; see PROGRESS.md rollup"
    },
    {
      "stage": "merged",
      "integration_ref": "pr:5",
      "title": "perf(tween): stop Genesis hot-loop + silence worker deliver logs",
      "owner": "lastraum",
      "pr": 5,
      "pr_url": "https://github.com/lastraum/dcl-threejs-client/pull/5",
      "updated": "2026-06-17"
    },
    {
      "stage": "merged",
      "integration_ref": "pr:4",
      "title": "proactive TweenState delivery for tweenCompleted parity",
      "owner": "lastraum",
      "pr": 4,
      "pr_url": "https://github.com/lastraum/dcl-threejs-client/pull/4",
      "updated": "2026-06-17"
    },
    {
      "stage": "merged",
      "integration_ref": "ecs:TriggerArea",
      "title": "TriggerArea Tier A — volume enter/exit and scene callbacks",
      "owner": "lastraum",
      "pr": 2,
      "pr_url": "https://github.com/lastraum/dcl-threejs-client/pull/2",
      "updated": "2026-06-17"
    }
  ]
} as ClaimsRegistry
