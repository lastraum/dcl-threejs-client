/** Dev progress panel — version/changelog only. Task backlog lives in docs/TASKS.yaml (fetched at runtime). */

import { APP_VERSION } from '../appVersion'
import { DCL_ECS_COMPONENTS, type ComponentStatus, type EcsComponentEntry } from '../../dcl/ecs/registry'

export type ChangelogEntry = {
  version: string
  date: string
  title?: string
  items: string[]
}

/** Shipped updates — newest first. First entry version synced from package.json on prebuild. */
export const DEV_CHANGELOG: ChangelogEntry[] = [
  {
    version: APP_VERSION,
    date: '2026-06-17',
    title: 'Genesis perf + re-arch e9/e10 progress',
    items: [
      'PointerEvents cache — Genesis Plaza 70–110 fps (was ~12–23)',
      'GLTF collider prewarm + Hyperfy grouped actors',
      'Remote DLE chat emotes → avatar playback (not scene chat)',
      'DCL auto-jog — run.glb slowed; sprint 12 m/s',
      'Re-arch e9 — CrdtMirror removed, RendererComponentHost schema-only'
    ]
  },
  {
    version: '0.1.115',
    date: '2026-06-17',
    title: 'Community task registry + dev panel fetch',
    items: [
      'docs/TASKS.yaml — community task backlog (single source of truth)',
      'docs/AGENTS.md, CONTRIBUTING.md, PR_CHECKLIST.md — onboarding + PR flow',
      'Dev progress panel — roadmap from GitHub raw TASKS.yaml (offline fallback snapshot)',
      'EngineApi sendBatch + subscribe — SDK7 comms observable (`onCommsMessage`)',
      'Tags — mirror CRDT sync for getEntitiesByTag()',
      'PointerEvents — DCL hover hints with button icons (E/F/mouse/1–4/Spc/Ctrl)',
      'Scene hydration — count-up elapsed timer; 3:00 timeout + attach-stall fallback',
      'Remote avatar textures — merged wearable mappings + .png/.png.png aliasing',
      'Chat nav links → teleport (parcel coords, .dcl.eth, play URLs)',
      'Tween bridge — transform + textureMove + TweenSequence (Genesis blimp orbit)',
      'SignedFetch — scene worker RPC → ADR-44 signed HTTP + getHeaders',
      'PhysX grounding + GLTF colliders, LightSource culling, sun/moon/skybox',
      'Multiplayer position sync — two clients same scene confirmed',
      'World location card, Genesis map + Events tab, scene chat (LiveKit RFC4)'
    ]
  }
]

export const DEV_PROGRESS_META = {
  lastUpdated: DEV_CHANGELOG[0]?.date ?? '2026-06-14',
  version: APP_VERSION,
  phase: 'Phase 4 EntityStore ✅ · e10 deferred',
  tagline: 'Task backlog in docs/TASKS.yaml — claim via CONTRIBUTING.md'
} as const

export const ECS_STATUS_LABEL: Record<ComponentStatus, string> = {
  none: '⬜ Not started',
  stub: '🟡 Stub',
  partial: '🟡 Partial',
  render: '🟢 Render/sync',
  'client-only': '🔵 Client-only'
}

export function countChangelogEntries(entries: ChangelogEntry[]): {
  releases: number
  items: number
  latestDate: string
} {
  let items = 0
  for (const entry of entries) items += entry.items.length
  return {
    releases: entries.length,
    items,
    latestDate: entries[0]?.date ?? DEV_PROGRESS_META.lastUpdated
  }
}

export function countEcsByStatus(components: EcsComponentEntry[]): Record<ComponentStatus, number> {
  const counts: Record<ComponentStatus, number> = {
    none: 0,
    stub: 0,
    partial: 0,
    render: 0,
    'client-only': 0
  }
  for (const c of components) counts[c.status]++
  return counts
}

export { DCL_ECS_COMPONENTS }
